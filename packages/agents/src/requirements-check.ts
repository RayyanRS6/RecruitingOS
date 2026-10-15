import { REQUIREMENT_CHECK_TITLE, type Competency, type DraftRolePacket, type RequirementCheckKind, type RequirementFix, type RequirementSuggestion, type RequirementsCheck } from "@ros/contracts";
import { PROXY_RULES, normalizeCriterion } from "@ros/core";

/**
 * The requirements check before approval (plan C16). Rules, not a model: they read the must-haves, the nice-to-haves,
 * the eligibility questions, the screening questions and the warning signs, and suggest. Nothing is scored and nothing
 * changes on its own: each suggestion carries one-tap fixes, and a fix is applied only when a person taps it (through
 * the packet guard, as a new version or into the draft). What it looks for:
 * - must-haves nobody can check before the person starts ("will stay five years", "passionate about dentistry");
 * - personality traits presented as skills ("team player with a positive attitude");
 * - the same thing said twice, which counts it twice;
 * - wording that stands in for a protected trait (the packet guard's own phrase list);
 * - a maximum number of years of experience, which shuts out experienced, often older, people.
 */

type ListName = "mustHaves" | "niceToHaves" | "eligibility" | "screening" | "redFlags";

type Item = { list: ListName; key: string; text: string; index: number };

type FixPlan = RequirementFix & { item: Item; text: string | null };

/** Raised when the tapped fixes cannot be applied as asked; the message is for the person. */
export class RequirementFixError extends Error {
  constructor(public readonly code: "unknown_fix" | "would_break_limits", message: string) {
    super(message);
  }
}

const LIST_PATH: Record<ListName, string> = {
  mustHaves: "requirements.mustHaves",
  niceToHaves: "requirements.niceToHaves",
  eligibility: "requirements.eligibility",
  screening: "screening.questions",
  redFlags: "evaluation.redFlags",
};

/** Where the packet guard records a flag on the same words (its paths count items by position). */
const GUARD_PATH: Record<ListName, (i: number) => string> = {
  mustHaves: (i) => `requirements.mustHaves[${i}].text`,
  niceToHaves: (i) => `requirements.niceToHaves[${i}].text`,
  eligibility: (i) => `requirements.eligibility[${i}].question`,
  screening: (i) => `screening.questions[${i}].question`,
  redFlags: (i) => `evaluation.redFlags[${i}]`,
};

function itemsOf(p: DraftRolePacket): Item[] {
  return [
    ...p.requirements.mustHaves.map((m, index) => ({ list: "mustHaves" as const, key: m.key, text: m.text, index })),
    ...p.requirements.niceToHaves.map((m, index) => ({ list: "niceToHaves" as const, key: m.key, text: m.text, index })),
    ...p.requirements.eligibility.map((e, index) => ({ list: "eligibility" as const, key: e.key, text: e.question, index })),
    ...p.screening.questions.map((q, index) => ({ list: "screening" as const, key: q.key, text: q.question, index })),
    ...p.evaluation.redFlags.map((text, index) => ({ list: "redFlags" as const, key: `rf${index}`, text, index })),
  ];
}

const isQuestion = (list: ListName) => list === "eligibility" || list === "screening";

/* ------------------------------------------------------------------------------------------------------------------ */
/* The rules                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Inner states and promises about the future: nothing a candidate sends or says can show them before they start. */
const UNPROVABLE = /\b(?:will|willing to|commit(?:s|ted)? to|plans? to|promises? to)\s+stay\b|\bstays?\s+(?:with us\s+)?(?:for\s+)?(?:at least\s+)?\d+\s*\+?\s*(?:years?|months?)\b|\blong[\s-]term commitment\b|\bloyal(?:ty)?\b|\bloves?\b|\bpassion(?:ate)?\b|\bgenuine(?:ly)?\b|\bcares? (?:deeply )?about\b|\bshares? our values\b|\b(?:good|kind)[\s-]hearted\b|\bgood person\b|\bcommon sense\b|\bintegrity\b|\bhonest(?:y)?\b|\btrustworth(?:y|iness)\b|\bwants? to grow with us\b/i;

/** Personality words; a requirement made of nothing else is a trait, not a skill. */
const TRAIT = /\bteam players?\b|\bself[\s-]?(?:starter|starting|motivated|driven)\b|\b(?:positive|good|great|can[\s-]do|friendly) attitude\b|\bhard[\s-]?(?:working|worker)\b|\b(?:strong|good|great) work ethic\b|\bgo[\s-]getters?\b|\brock ?stars?\b|\bninjas?\b|\benergetic\b|\boutgoing\b|\bfriendly\b|\bbubbly\b|\bpersonable\b|\bcheerful\b|\bupbeat\b|\benthusiastic\b|\bmotivated\b|\bdriven\b|\bdetail[\s-]oriented\b|\bpunctual\b|\breliable\b|\bdependable\b|\bresponsible\b|\borganized\b|\bflexible\b|\badaptable\b|\b(?:fast|quick) learner\b|\bpeople person\b|\bworks? well under pressure\b|\bcultur(?:e|al) fit\b|\bpresentable\b|\bpolished\b|\bprofessional (?:demeanou?r|appearance|attitude)\b|\bgood personality\b/gi;

/** Words that carry no requirement of their own once the trait words are gone ("a ... with a ... and ..."). */
const FILLER = new Set(["a", "an", "the", "and", "or", "with", "who", "is", "are", "be", "being", "very", "highly", "extremely", "someone", "person", "candidate", "candidates", "individual", "team", "member", "must", "should", "have", "has", "able", "to", "of", "in", "at", "for", "strong", "great", "good", "excellent", "attitude", "skills", "skill", "always", "really", "truly", "plus", "also", "personality", "nature", "naturally"]);

function isTrait(text: string): boolean {
  const matched = text.match(TRAIT);
  if (!matched) return false;
  const left = normalizeCriterion(text.replace(TRAIT, " ")).split(" ").filter((w) => w && !FILLER.has(w));
  return left.length === 0;
}

const CULTURE_FIT = /\bcultur(?:e|al) fit\b/i;
const APPEARANCE = /\bpresentable\b|\bpolished\b|\bprofessional appearance\b/i;

/** A range of years of experience ("2-5 years of experience", "between 2 and 5 years"): its top end is a cap. */
const YEAR_RANGE = /\b(?:between\s+)?(\d{1,2})\s*(?:-|–|to|and)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/i;
const ABOUT_EXPERIENCE = /\bexperience\b|\bexp\b/i;

/** Lawful wording for the real need behind some proxies, as a statement and as a question. */
const LAWFUL: Record<string, { statement: string; question: string }> = {
  citizenship: { statement: "Authorized to work in the United States", question: "Are you authorized to work in the United States?" },
  location_proxy: { statement: "Can reliably get to the job for the scheduled shifts", question: "Can you reliably get to the job for the scheduled shifts?" },
  family_status: { statement: "Available for the posted schedule", question: "Are you available for the posted schedule?" },
  language_origin: { statement: "Communicates clearly in English, as the job requires", question: "How comfortable are you explaining things to customers in English?" },
  pay_history: { statement: "", question: "What pay are you looking for?" },
};

const STOP = new Set(["the", "and", "for", "with", "our", "your", "their", "must", "have", "has", "able", "can", "who", "will", "are", "experience", "years", "year", "you", "any", "all", "from", "into", "that", "this", "work", "working", "job", "role", "plus"]);

function tokens(text: string): Set<string> {
  return new Set(normalizeCriterion(text).split(" ").filter((w) => w.length >= 3 && !STOP.has(w)));
}

/** The same requirement said twice: the same words, or one's key words all inside the other's. */
function sameThing(a: string, b: string): boolean {
  if (normalizeCriterion(a) === normalizeCriterion(b)) return true;
  const x = tokens(a);
  const y = tokens(b);
  if (x.size < 2 || y.size < 2) return false;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.8;
}

/** The words with the matched phrase cut out and the joins tidied, or null when too little would be left to mean anything. */
function without(text: string, phrase: string): string | null {
  const left = text.replace(phrase, " ").replace(/\s*[,;:]\s*([,;:]|$)/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;:.–-]+|[\s,;:–-]+$/g, "").trim();
  return left.split(" ").filter(Boolean).length >= 3 ? left.charAt(0).toUpperCase() + left.slice(1) : null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Suggestions and their fixes                                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

type Found = { suggestion: Omit<RequirementSuggestion, "fixes" | "flagId" | "title">; item: Item; fixes: Array<{ op: RequirementFix["op"]; label: string; text: string | null }> };

function find(p: DraftRolePacket): Found[] {
  const items = itemsOf(p);
  const out: Found[] = [];
  // A fix that would leave no must-have, or fewer than three screening questions, is not offered at all.
  const offers = (item: Item, fixes: Found["fixes"]) => fixes.filter((x) => x.op === "replace_text" || !((item.list === "mustHaves" && p.requirements.mustHaves.length <= 1) || (item.list === "screening" && p.screening.questions.length <= 3)));
  const add = (kind: RequirementCheckKind, item: Item, why: string, fixes: Found["fixes"]) => {
    const id = `${kind}:${item.list}:${item.key}`;
    if (out.some((f) => f.suggestion.id === id)) return;
    out.push({ suggestion: { id, kind, path: `${LIST_PATH[item.list]}[${item.key}]`, text: item.text, why }, item, fixes: offers(item, fixes) });
  };
  const judged = (item: Item) => item.list === "mustHaves" || item.list === "niceToHaves";
  const intoInterview = { op: "to_interview" as const, label: "Ask about it in the interview instead", text: null };
  const takeOut = { op: "remove" as const, label: "Take it out", text: null };

  for (const item of items) {
    // Proxies and caps on experience, from the packet guard's own phrase list.
    let proxied = false;
    for (const r of PROXY_RULES) {
      const hit = r.find(item.text);
      if (!hit) continue;
      proxied = true;
      if (r.rule === "experience_cap") {
        const rest = without(item.text, hit);
        add("max_years", item, "A cap on years of experience shuts out experienced people, who are often older. Say the level of skill the job needs instead.", [...(rest ? [{ op: "replace_text" as const, label: `Change it to "${rest}"`, text: rest }] : []), takeOut]);
        continue;
      }
      const lawful = LAWFUL[r.rule];
      const better = lawful ? (isQuestion(item.list) ? lawful.question : lawful.statement) : "";
      add("proxy", item, `${r.reason} ${r.alternative}`, [...(better && item.list !== "redFlags" ? [{ op: "replace_text" as const, label: `Change it to "${better}"`, text: better }] : []), takeOut]);
    }
    // A range of years of experience ("2-5 years of experience"): keep the floor, drop the cap.
    const range = !proxied && item.list !== "redFlags" && ABOUT_EXPERIENCE.test(item.text) ? item.text.match(YEAR_RANGE) : null;
    if (range && Number(range[2]) > Number(range[1])) {
      const floor = item.text.replace(range[0], `${range[1]} or more years`);
      add("max_years", item, "The top of this range works as a cap: someone with more experience would be turned away. Keep the minimum only.", [{ op: "replace_text", label: `Change it to "${floor}"`, text: floor }]);
    }
    if (!judged(item)) continue;
    if (UNPROVABLE.test(item.text)) {
      add("unprovable", item, "Nothing a candidate sends or says can show this before they start, so it would come down to a hunch. Ask for an example from their past work in the interview instead.", [intoInterview, takeOut]);
    } else if (isTrait(item.text)) {
      const why = CULTURE_FIT.test(item.text)
        ? "\"Culture fit\" is vague and tends to favour people like the current team. Name the behaviour you need, and ask about it in the interview."
        : APPEARANCE.test(item.text)
          ? "Appearance can stand in for race, sex, age or disability. If there is a dress code, say what it is in the job description."
          : "This is a personality trait. A résumé or a screening answer cannot show it, so as a requirement it would be judged on impressions. Look for it in the interview instead.";
      add("trait_as_skill", item, why, APPEARANCE.test(item.text) || CULTURE_FIT.test(item.text) ? [takeOut] : [intoInterview, takeOut]);
    }
  }

  // The same thing twice: the later one is suggested away; a nice-to-have that repeats a must-have goes.
  const pairs: Array<[ListName, ListName]> = [["mustHaves", "mustHaves"], ["niceToHaves", "niceToHaves"], ["mustHaves", "niceToHaves"], ["screening", "screening"]];
  for (const [la, lb] of pairs) {
    const xs = items.filter((i) => i.list === la);
    const ys = items.filter((i) => i.list === lb);
    for (const b of ys) {
      const a = xs.find((x) => (la !== lb || x.index < b.index) && sameThing(x.text, b.text));
      if (!a) continue;
      const why = la !== lb ? `This is already a must-have: "${a.text}". As a nice-to-have too, it counts twice.` : `This says the same as "${a.text}". Counting it twice gives it double weight.`;
      add("duplicate", b, why, [{ op: "remove", label: la !== lb ? "Take out the nice-to-have" : "Keep only the first one", text: null }]);
    }
  }
  return out;
}

function fixId(f: Found, op: RequirementFix["op"]): string {
  return `${f.suggestion.id}:${op}`;
}

/** The suggestions for a packet, with their one-tap fixes, and the guard's flag on the same words when there is one. */
export function checkRequirements(packet: DraftRolePacket, base: string, version: number | null = null): RequirementsCheck {
  const flags = (packet.provenance.flags ?? []).filter((f) => !f.kept);
  const suggestions: RequirementSuggestion[] = find(packet).map((f) => ({
    ...f.suggestion,
    title: REQUIREMENT_CHECK_TITLE[f.suggestion.kind],
    fixes: f.fixes.map((x) => ({ id: fixId(f, x.op), label: x.label, op: x.op, after: x.text })),
    flagId: flags.find((fl) => fl.path === GUARD_PATH[f.item.list](f.item.index))?.id ?? null,
  }));
  const n = suggestions.length;
  const summary = n === 0 ? "Nothing to suggest: the requirements and questions read as fair and checkable." : `${n} ${n === 1 ? "suggestion" : "suggestions"} below. Nothing changes unless you apply a fix.`;
  return { base, version, suggestions, summary };
}

function plansOf(packet: DraftRolePacket): Map<string, FixPlan> {
  const plans = new Map<string, FixPlan>();
  for (const f of find(packet)) for (const x of f.fixes) plans.set(fixId(f, x.op), { id: fixId(f, x.op), label: x.label, op: x.op, after: x.text, item: f.item, text: x.text });
  return plans;
}

const competencyKey = (text: string, taken: Set<string>) => {
  const stem = `ci_${normalizeCriterion(text).replace(/ /g, "_").slice(0, 30) || "trait"}`;
  let key = stem;
  for (let n = 2; taken.has(key); n += 1) key = `${stem}_${n}`;
  return key;
};

/** A short name for an interview skill made from a requirement's words. */
function competencyName(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return t.length <= 60 ? t : `${t.slice(0, 57).trimEnd()}…`;
}

/**
 * Applies the fixes a person tapped to the packet the check ran on and returns the new packet (not yet guarded or saved)
 * with what was done, one plain line each. One fix per item: a second tap on the same item is skipped. Refused, with
 * the reason, when the result would break the packet's limits (a must-have left, three screening questions, eight
 * interview skills at most).
 */
export function applyRequirementFixes<T extends DraftRolePacket>(packet: T, fixIds: string[]): { packet: T; applied: string[]; skipped: string[] } {
  const plans = plansOf(packet);
  const chosen: FixPlan[] = [];
  const skipped: string[] = [];
  for (const id of fixIds) {
    const plan = plans.get(id);
    if (!plan) {
      skipped.push(id);
      continue;
    }
    if (chosen.some((c) => c.item.list === plan.item.list && c.item.key === plan.item.key)) {
      skipped.push(id);
      continue;
    }
    chosen.push(plan);
  }
  if (!chosen.length) throw new RequirementFixError("unknown_fix", "Those fixes no longer match this role. Run the check again.");
  const next = structuredClone(packet);
  const applied: string[] = [];
  const goneRedFlags = new Set<number>();
  for (const plan of chosen) {
    const { item } = plan;
    if (plan.op === "replace_text" && plan.text) {
      if (item.list === "mustHaves") next.requirements.mustHaves = next.requirements.mustHaves.map((m) => (m.key === item.key ? { ...m, text: plan.text! } : m));
      if (item.list === "niceToHaves") next.requirements.niceToHaves = next.requirements.niceToHaves.map((m) => (m.key === item.key ? { ...m, text: plan.text! } : m));
      if (item.list === "eligibility") next.requirements.eligibility = next.requirements.eligibility.map((e) => (e.key === item.key ? { ...e, question: plan.text! } : e));
      if (item.list === "screening") next.screening.questions = next.screening.questions.map((q) => (q.key === item.key ? { key: q.key, question: plan.text!, kind: q.kind, ...(q.competencyKey ? { competencyKey: q.competencyKey } : {}) } : q));
      applied.push(`Changed "${item.text}" to "${plan.text}".`);
      continue;
    }
    if (plan.op === "to_interview") {
      // judged in the interview only: no résumé reading or screening chat is asked about it, and the match score leaves
      // it out (`scoredSkill` in @ros/core), as the owner was told (known bug 18)
      const taken = new Set(next.competencies.map((c) => c.key));
      const competency: Competency = { key: competencyKey(item.text, taken), name: competencyName(item.text), definition: item.text, weight: 3, evaluatedIn: "interview", indicators: ["A concrete example from past work"] };
      next.competencies = [...next.competencies, competency];
      const [first, ...rest] = next.interviews.plan;
      if (first) next.interviews.plan = [{ ...first, competencyKeys: [...first.competencyKeys, competency.key] }, ...rest];
      applied.push(`Moved "${item.text}" to the interview.`);
    } else {
      applied.push(`Took out "${item.text}".`);
    }
    if (item.list === "mustHaves") next.requirements.mustHaves = next.requirements.mustHaves.filter((m) => m.key !== item.key);
    if (item.list === "niceToHaves") next.requirements.niceToHaves = next.requirements.niceToHaves.filter((m) => m.key !== item.key);
    if (item.list === "eligibility") next.requirements.eligibility = next.requirements.eligibility.filter((e) => e.key !== item.key);
    if (item.list === "screening") next.screening.questions = next.screening.questions.filter((q) => q.key !== item.key);
    if (item.list === "redFlags") goneRedFlags.add(item.index);
  }
  if (goneRedFlags.size) next.evaluation.redFlags = next.evaluation.redFlags.filter((_, i) => !goneRedFlags.has(i));
  if (!next.requirements.mustHaves.length) throw new RequirementFixError("would_break_limits", "A role needs at least one must-have. Keep one of these, or add another must-have first.");
  if (next.screening.questions.length < 3) throw new RequirementFixError("would_break_limits", "A role needs at least three screening questions. Reword this one instead, or add another question first.");
  if (next.competencies.length > 8) throw new RequirementFixError("would_break_limits", "The interview can look for eight things at most. Take one of these out instead, or remove an interview skill first.");
  return { packet: next, applied, skipped };
}

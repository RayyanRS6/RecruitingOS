import {
  EMPLOYMENT_TYPE_LABEL, EmploymentType, INTAKE_ESSENTIALS, INTAKE_ESSENTIAL_LABEL, INTAKE_FIELD_LABEL, IntakeFacts as IntakeFactsSchema, MUST_HAVES_MAX, REMOTE_POLICY_LABEL, RemotePolicy, formatPayRange, mustHaveOf,
  type DeclinedCriterion, type DraftRolePacket, type IntakeAnswer, type IntakeEssentialKey, type IntakeFacts, type IntakeMessage, type IntakePayCard, type IntakeQuestion, type IntakeReadiness, type IntakeRefusal,
  type IntakeServerState, type PayOrigin, type PublishBlocker,
} from "@ros/contracts";
import { normalizeCriterion, openFlagsMessage, screenCriterion, screenDealBreaker, unresolvedFlags } from "./packet-guard";

/**
 * The job builder's rules that need no model and no database: what is still missing, whether a person set the pay, the
 * pay card, how a tapped answer changes the facts, and whether the job may be written and published. Kept here, pure,
 * so the routes, the agent and the tests all read the same rules.
 */

/** A first message long enough, or with enough lines, to be a job ad someone pasted. */
export function looksLikePastedAd(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return text.length >= 1200 || (lines >= 8 && text.length >= 400);
}

const FIGURE = "\\d+(?:\\.\\d+)?";
/** A thousand, written after a figure: "60k", "60K", "60 thousand". */
const THOUSAND = "(?:k|thousand)\\b";
/**
 * A range whose first figure leaves its thousand to the second: "45-55k", "$45 to $55k", "between 45 and 55 thousand".
 * The first figure, then what joins it to the second with its thousand.
 */
const SHARED_THOUSAND = new RegExp(`(${FIGURE})(\\s*(?:[-\\u2010-\\u2015]|\\bto\\b|\\band\\b)\\s*\\$?\\s*${FIGURE}\\s*${THOUSAND})`, "gi");
const AMOUNT = new RegExp(`(${FIGURE})\\s*(${THOUSAND})?`, "gi");

/**
 * The amounts in a person's words, read as people mean them: "$60,000", "60k", "60 thousand", "$45.50", and a range
 * that says its thousand once ("45-55k" is 45,000 and 55,000; only a first figure under a thousand takes it, so
 * "$60,000 to 75k" stays as it is written).
 */
export function amountsIn(text: string): number[] {
  let t = text;
  while (/\d,\d{3}/.test(t)) t = t.replace(/(\d),(\d{3})/g, "$1$2");
  t = t.replace(SHARED_THOUSAND, (all: string, first: string, rest: string) => (Number(first) < 1000 ? `${first}k${rest}` : all));
  const out: number[] = [];
  for (const m of t.matchAll(AMOUNT)) out.push(Number(m[1]) * (m[2] ? 1000 : 1));
  return out;
}

/**
 * Whether pay is hourly or a salary, from the owner's own words: "an hour", "a year", "salary", or the size of the
 * dollar amounts ($60,000 is a salary, $45 an hourly rate). Null when it cannot tell.
 */
export function basisFromText(text: string): "hourly" | "salary" | null {
  if (/(?:\ban|\bper|\/)\s*(?:hour|hr)\b|\bhourly\b/i.test(text)) return "hourly";
  if (/(?:\ba|\bper|\/)\s*(?:year|yr)\b|\bannual(?:ly)?\b|\bsalar(?:y|ied)\b|\bper annum\b/i.test(text)) return "salary";
  const dollars = [...text.replace(/(\d),(\d{3})/g, "$1$2").matchAll(/\$\s?(\d+(?:\.\d+)?)\s*(k\b)?/gi)].map((m) => Number(m[1]) * (m[2] ? 1000 : 1));
  if (!dollars.length) return null;
  const top = Math.max(...dollars);
  if (top >= 1000) return "salary";
  if (top <= 300) return "hourly";
  return null;
}

/** The person's own typed words in a conversation: not a pasted ad, not the summary of tapped answers. */
export function typedByOwner(messages: IntakeMessage[]): string[] {
  return messages.filter((m) => m.role === "owner" && (!m.kind || m.kind === "text")).map((m) => m.content);
}

const isBasis = (b: string | undefined): b is "hourly" | "salary" => b === "hourly" || b === "salary";

/**
 * Pay a person set by typing it: the range on the facts appears, figure for figure, in words the person typed, read as
 * people type a range (`amountsIn`: "45-55k", "$45k-$55k", "45k to 55k", "$45,000 to $55,000", "$22–$26 an hour"). One
 * figure typed ("20 dollars an hour") is the pay when the facts carry it as both the lowest and the highest, as the
 * read of a pasted ad keeps a single figure (`factsFromExtraction` in @ros/agents); a lowest figure alone is not a
 * range, and the pay card asks for the rest. The model only read the numbers; this check is code, so the confirmation
 * is never the model's word. A range read from a pasted ad is not typed and waits for the pay card.
 */
export function payTyped(messages: IntakeMessage[], facts: IntakeFacts): boolean {
  if (facts.compensationMin === undefined || facts.compensationMax === undefined || !isBasis(facts.compensationBasis)) return false;
  const said = new Set(typedByOwner(messages).flatMap(amountsIn));
  return said.has(facts.compensationMin) && said.has(facts.compensationMax);
}

/** The confirmation stands only while the facts still carry the figures that were confirmed. */
export function payConfirmed(facts: IntakeFacts, state: Pick<IntakeServerState, "pay">): boolean {
  const p = state.pay;
  return !!p && p.basis === facts.compensationBasis && p.min === facts.compensationMin && p.max === facts.compensationMax;
}

/** A key for the confirmed pay a job was written with. */
export function payKey(state: Pick<IntakeServerState, "pay">): string | null {
  const p = state.pay;
  return p ? `${p.basis}:${p.min}:${p.max}` : null;
}

function essentialValue(key: IntakeEssentialKey, f: IntakeFacts): { done: boolean; value: string | null } {
  const text = (v: string | undefined) => ({ done: !!v?.trim(), value: v?.trim() || null });
  switch (key) {
    case "title":
      return text(f.title);
    case "location":
      return text(f.locationText);
    case "remote_policy": {
      const policy = RemotePolicy.safeParse(f.remotePolicy);
      return { done: policy.success, value: policy.success ? REMOTE_POLICY_LABEL[policy.data] : null };
    }
    case "compensation_range": {
      const done = f.compensationMin !== undefined && f.compensationMax !== undefined && isBasis(f.compensationBasis);
      return { done, value: done ? formatPayRange({ basis: f.compensationBasis!, min: f.compensationMin!, max: f.compensationMax! }) : null };
    }
    case "employment_type": {
      const type = EmploymentType.safeParse(f.employmentType);
      return { done: type.success, value: type.success ? EMPLOYMENT_TYPE_LABEL[type.data] : null };
    }
    case "schedule":
      return text(f.schedule);
    case "must_haves":
      return { done: f.mustHaves.length > 0, value: f.mustHaves.length ? f.mustHaves.join("; ") : null };
  }
}

/** The facts the server sets on a written job by rule, so changing them never needs the job written again. */
const SET_BY_RULE: ReadonlySet<string> = new Set(["compensationBasis", "compensationMin", "compensationMax", "benefits", "dealBreakers", "declinedCriteria"]);

/** A short, stable key of a text (cyrb53): enough to tell whether the answers changed, never to recover them. */
function shortKey(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * A key of the answers a job's words are written from: everything except what is set on it by rule (the pay, the
 * benefits line, the deal-breakers, what was declined). A job written from other answers than the current ones is out
 * of date: only writing it again carries the change into its words.
 */
export function draftFactsKey(facts: IntakeFacts): string {
  const f = normalizeFacts(facts) as Record<string, unknown>;
  const parts = Object.keys(f).filter((k) => !SET_BY_RULE.has(k)).sort().flatMap((k) => {
    const v = f[k];
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) {
      const items = v.map((x) => (typeof x === "string" ? x.trim() : JSON.stringify(x))).filter(Boolean);
      return items.length ? [`${k}=${JSON.stringify(items)}`] : [];
    }
    const s = typeof v === "string" ? v.trim() : JSON.stringify(v);
    return s ? [`${k}=${s}`] : [];
  });
  return shortKey(parts.join("\n"));
}

/**
 * Readiness, computed on the server. "Write the job" needs every essential and pay a person set or confirmed. "Publish
 * job" needs the same, the job written and up to date with the answers, no open wording flag, the legal check and room
 * on the plan: every blocker is listed, in the order a person would clear them. The plan's and the law's blockers are
 * worked out by the caller, which reads the company and the plan (`planBlockers`, `legalBlockers`).
 */
export function intakeReadiness(input: { facts: IntakeFacts; state: IntakeServerState; draft: DraftRolePacket | null; planBlockers?: PublishBlocker[]; legalBlockers?: PublishBlocker[] }): IntakeReadiness {
  const { facts, state, draft } = input;
  const essentials = INTAKE_ESSENTIALS.map((key) => ({ key, label: INTAKE_ESSENTIAL_LABEL[key], ...essentialValue(key, facts) }));
  const missing = essentials.filter((e) => !e.done).map((e) => e.key);
  const confirmed = payConfirmed(facts, state);
  const payStated = !missing.includes("compensation_range");
  const draftBlocker = missing.length
    ? `Still needed before the job can be written: ${essentials.filter((e) => !e.done).map((e) => e.label.toLowerCase()).join(", ")}.`
    : confirmed ? null : "Confirm the pay on the pay card before the job is written.";
  const openFlags = draft ? unresolvedFlags(draft).length : 0;
  const key = state.draft?.factsKey;
  const draftOutOfDate = !!draft && !!key && key !== draftFactsKey(facts);
  const blockers: PublishBlocker[] = [...(input.planBlockers ?? [])];
  for (const e of essentials) if (!e.done) blockers.push({ code: "essential_missing", message: `Not set yet: ${e.label.toLowerCase()}.` });
  if (payStated && !confirmed) blockers.push({ code: "pay_not_confirmed", message: "Confirm the pay on the pay card." });
  if (!draft) blockers.push({ code: "no_draft", message: "Write the job first, so you can check it." });
  else if (draftOutOfDate) blockers.push({ code: "draft_out_of_date", message: "Your answers changed after the job was written. Write the job again first." });
  if (openFlags) blockers.push({ code: "open_flags", message: openFlagsMessage(openFlags) });
  blockers.push(...(input.legalBlockers ?? []));
  return {
    essentials,
    missing,
    payConfirmed: confirmed,
    mayDraft: draftBlocker === null,
    draftBlocker,
    hasDraft: !!draft,
    draftOutOfDate,
    draftEdits: draft ? state.draft?.edits ?? 0 : 0,
    openFlags,
    publish: { allowed: blockers.length === 0, blockers },
  };
}

/** The pay card: what the owner stated, and who set or confirmed it. The company types its pay; nothing suggests one. */
export function payCard(facts: IntakeFacts, state: Pick<IntakeServerState, "pay">): IntakePayCard {
  const basis = isBasis(facts.compensationBasis) ? facts.compensationBasis : null;
  const stated = { min: facts.compensationMin ?? null, max: facts.compensationMax ?? null };
  const confirmed = payConfirmed(facts, state) && state.pay ? { byName: state.pay.by.name ?? null, at: state.pay.at, via: state.pay.via } : null;
  const range = basis && stated.min !== null && stated.max !== null ? formatPayRange({ basis, min: stated.min, max: stated.max }) : null;
  const summary = !range ? "Pay is not set yet." : confirmed ? `Pay: ${range}.` : `Pay: ${range}. Nobody has confirmed it yet: confirm it or change it.`;
  return { basis, stated, confirmed, summary };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Answers to the question cards: the fairness check on everything a person types.                                     */
/* ------------------------------------------------------------------------------------------------------------------ */

export class IntakeEditError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export type FactsEdit = {
  facts: IntakeFacts;
  refused: IntakeRefusal[];
  /** Pay a person set or confirmed in this edit. */
  pay: { basis: "hourly" | "salary"; min: number; max: number; via: PayOrigin } | null;
  /** One short line per answer for the conversation ("Must-haves: active RDH license; perio experience"). */
  summary: string[];
};

/**
 * How each answer is named in the summary line written into the conversation: the contracts' one table
 * (`INTAKE_FIELD_LABEL`), which the page's own echo of the answers reads too. One name here is still this file's own:
 * the kind of job is "Full or part time", as every summary written so far says it, where the contracts say "Full time
 * or part time". It takes the contracts' name when the two tests that pin these words are changed with it
 * (apps/api/src/job-builder.test.ts, and intake-builder.test.ts beside this file).
 */
const FIELD_LABEL: Record<IntakeQuestion["field"], string> = { ...INTAKE_FIELD_LABEL, employment_type: "Full or part time" };

const LIST_OF: Partial<Record<IntakeQuestion["field"], "mustHaves" | "dealBreakers">> = { must_haves: "mustHaves", deal_breakers: "dealBreakers" };

const same = (a: string, b: string) => normalizeCriterion(a) === normalizeCriterion(b);
const dedupe = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => same(x, y)) === i);

const EMPLOYMENT_WORDS: Array<[RegExp, string]> = [[/full/i, "full_time"], [/part/i, "part_time"], [/contract/i, "contract"], [/temp/i, "temporary"], [/per[\s_-]?diem/i, "per_diem"], [/intern/i, "internship"]];
/** What may stand between two words of an arrangement: a space, an underscore, or a hyphen of any kind ("on site", "on_site", "on-site"). */
const GAP = "[\\s_\\-\\u2010-\\u2015]";
/**
 * The ordinary ways people say each work arrangement: "hybrid"; "remote", "remotely", "work from home", "working from
 * home", "WFH", "home-based"; "on site", "on-site", "onsite", "in office", "in the office", "in person", "office-based".
 * Whole words only: a "construction site" is no "on site". A place alone ("at our Irvine office") names none.
 */
const REMOTE_WORDS: Array<[RegExp, string]> = [
  [/\bhybrid\b/i, "hybrid"],
  [new RegExp(`\\bremote|\\bwork(?:s|ing|ed)?${GAP}+(?:from|at)${GAP}+home\\b|\\bwfh\\b|\\bhome${GAP}?based\\b|\\btelecommut|\\btelework`, "i"), "remote"],
  [new RegExp(`\\bon${GAP}?site\\b|\\bin${GAP}?(?:the${GAP}+)?office\\b|\\bin${GAP}?person\\b|\\boffice${GAP}?based\\b`, "i"), "onsite"],
];
const BASIS_WORDS: Array<[RegExp, string]> = [[/hour/i, "hourly"], [/salar|year|annual/i, "salary"]];

/**
 * Whether words name a work arrangement in one of the ordinary ways people say it ("we all work from home", "it is in
 * the office", "hybrid"). The job builder takes the arrangement the assistant read only when the owner's own typed words
 * name one: asked, never assumed.
 */
export function namesWorkArrangement(text: string): boolean {
  return REMOTE_WORDS.some(([re]) => re.test(text));
}

/**
 * A card's answer as the job keeps it. The model is asked to make an option's value the words to store, but it sometimes
 * writes a code instead ("rda_license", "mon_fri_days"), which would then show on the job as the code. A value that
 * looks like a code is replaced by the label the person actually ticked.
 */
export function storedAnswer(option: { label: string; value: string }): string {
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(option.value.trim()) && option.label.trim() ? option.label.trim() : option.value;
}

/** The fairness check on words a person typed or ticked: a refusal is recorded with the reason, as the assistant would have declined it. */
function screened(edit: FactsEdit, field: IntakeQuestion["field"], values: string[]): string[] {
  const ok: string[] = [];
  for (const v of values) {
    const hit = field === "deal_breakers" ? screenDealBreaker(v) : screenCriterion(v);
    if (!hit) {
      ok.push(v);
      continue;
    }
    edit.refused.push({ field, text: v, reason: hit.reason, alternative: hit.alternative });
    if (!edit.facts.declinedCriteria.some((d) => same(d.requested, v))) edit.facts.declinedCriteria.push({ requested: v, reason: hit.reason, alternative: hit.alternative });
  }
  return ok;
}

function setPay(edit: FactsEdit, pay: { basis: "hourly" | "salary"; min: number; max: number }): void {
  if (pay.min > pay.max) throw new IntakeEditError("pay_range", "The lowest pay must not be above the highest.");
  const f = edit.facts;
  const unchanged = f.compensationBasis === pay.basis && f.compensationMin === pay.min && f.compensationMax === pay.max;
  f.compensationBasis = pay.basis;
  f.compensationMin = pay.min;
  f.compensationMax = pay.max;
  // The same figures that were already there (read from a pasted ad) are confirmed; new ones are set.
  edit.pay = { ...pay, via: unchanged ? "confirmed" : "pay_card" };
  edit.summary.push(`${FIELD_LABEL.compensation}: ${formatPayRange(pay)}`);
}

/** A fact kept as one of a few values, from the option's value or the words the person read; refused when it names none. */
function oneOf(value: string, words: string | undefined, allowed: readonly string[], list: Array<[RegExp, string]>, what: string): string {
  if (allowed.includes(value)) return value;
  const hit = list.find(([re]) => re.test(value)) ?? (words ? list.find(([re]) => re.test(words)) : undefined);
  if (hit) return hit[1];
  throw new IntakeEditError("invalid_value", `That is not a ${what} we know. Choose one of the options.`);
}

/**
 * Applies the answers to the open cards. Ticked offered answers and the owner's own words set the fact; an offered
 * answer left unticked is taken out of a list if it was there; everything the owner typed or ticked passes the fairness
 * check; the pay card sets or confirms the pay. A skipped card changes nothing.
 */
export function applyAnswers(facts: IntakeFacts, questions: IntakeQuestion[], answers: IntakeAnswer[]): FactsEdit {
  const edit: FactsEdit = { facts: normalizeFacts(structuredClone(facts)), refused: [], pay: null, summary: [] };
  const f = edit.facts;
  for (const a of answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) throw new IntakeEditError("unknown_question", "That question has been replaced by newer ones. Answer the questions showing now.");
    if (a.skipped) continue;
    if (q.mode === "pay") {
      if (!a.pay) throw new IntakeEditError("pay_missing", "Set the pay range first.");
      setPay(edit, a.pay);
      continue;
    }
    const offered = new Map(q.options.map((o) => [o.value, o]));
    for (const v of a.selected) if (!offered.has(v)) throw new IntakeEditError("unknown_option", "That answer was not one of the choices on the card.");
    if (a.own.length && !q.allowOwn) throw new IntakeEditError("own_not_allowed", "Pick one of the choices on this card.");
    const picked = a.selected.map((v) => offered.get(v)!);
    const list = LIST_OF[q.field];
    if (list) {
      // An offered answer the fairness check would refuse is never stored, even if a stale card still showed it.
      const values = screened(edit, q.field, [...picked.map(storedAnswer), ...a.own]);
      const unticked = q.options.filter((o) => !a.selected.includes(o.value)).map(storedAnswer);
      const next = dedupe([...f[list].filter((x) => !unticked.some((u) => same(u, x))), ...values]);
      if (list === "mustHaves" && next.length > MUST_HAVES_MAX) throw new IntakeEditError("too_many_must_haves", "Keep it to six must-haves; anything else can be a nice-to-have.");
      f[list] = next;
      if (values.length) edit.summary.push(`${FIELD_LABEL[q.field]}: ${values.join("; ")}`);
      continue;
    }
    // The fairness check reads the words the person ticked or typed, which is also what a text fact keeps.
    const first = picked.find((o) => screened(edit, q.field, [storedAnswer(o)]).length > 0);
    const value = first?.value ?? screened(edit, q.field, a.own)[0];
    if (value === undefined) continue;
    const words = first ? storedAnswer(first) : undefined;
    const text = words ?? value;
    switch (q.field) {
      case "title": f.title = text; break;
      case "location": f.locationText = text; break;
      case "schedule": f.schedule = text; break;
      case "benefits": f.benefits = text; break;
      case "employment_type": f.employmentType = oneOf(value, words, EmploymentType.options, EMPLOYMENT_WORDS, "kind of job"); break;
      case "remote_policy": f.remotePolicy = oneOf(value, words, RemotePolicy.options, REMOTE_WORDS, "work arrangement"); break;
      case "compensation_basis": f.compensationBasis = oneOf(value, words, ["hourly", "salary"], BASIS_WORDS, "pay basis"); break;
      default: break;
    }
    edit.summary.push(`${FIELD_LABEL[q.field]}: ${first?.label ?? value}`);
  }
  return edit;
}

/**
 * Deal-breakers offered back as visible must-haves: each one that passes the fairness check is asked about on the
 * deal-breaker card, as an option worded as the requirement it rules people out on (`mustHaveOf`); one that fails, in the
 * owner's words (read as a deal-breaker, so a record named on its own fails: "Felony convictions") or as that
 * requirement, is declined with the reason, never offered and never used. One already a must-have, either way it is
 * worded, is not offered again.
 */
export function dealBreakerOffer(facts: IntakeFacts, alreadyOffered: string[]): { offer: string[]; declined: DeclinedCriterion[] } {
  const offer: string[] = [];
  const declined: DeclinedCriterion[] = [];
  for (const d of facts.dealBreakers) {
    const need = mustHaveOf(d);
    if (alreadyOffered.some((o) => same(o, d)) || facts.mustHaves.some((m) => same(m, d) || same(m, need))) continue;
    const hit = screenDealBreaker(d) ?? screenCriterion(need);
    if (hit) declined.push({ requested: d, reason: hit.reason, alternative: hit.alternative, rule: hit.rule });
    else offer.push(d);
  }
  return { offer, declined };
}

/**
 * Facts as stored, with every list present and nothing the builder no longer keeps (a draft started earlier may hold
 * more). Must-haves are kept to the first six: what the assistant reads from a conversation or a pasted ad is merged in
 * without a limit, and a seventh would fail every job, since the record holds six.
 */
export function normalizeFacts(facts: unknown): IntakeFacts {
  const raw = facts && typeof facts === "object" && !Array.isArray(facts) ? (facts as Record<string, unknown>) : {};
  let parsed = IntakeFactsSchema.safeParse(raw);
  if (!parsed.success) {
    // Every part that still reads is kept; one that does not is dropped on its own.
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (IntakeFactsSchema.safeParse({ [k]: v }).success) kept[k] = v;
    parsed = IntakeFactsSchema.safeParse(kept);
  }
  const f = parsed.success ? parsed.data : IntakeFactsSchema.parse({});
  const out: IntakeFacts = { ...f, mustHaves: f.mustHaves.slice(0, MUST_HAVES_MAX) };
  // The kind of job, the pay basis and the work arrangement are kept as codes, and the assistant writes facts in plain
  // words ("Full time", "per hour", "On site"). Words that name one code are read as it; words that name none, or more
  // than one, are dropped, so the card for that essential is asked. Left as they came, they counted as answered for the
  // cards and as missing for the job: nothing asked for them, and the job could never be written.
  const kind = codeFromWords(f.employmentType, EmploymentType.options, EMPLOYMENT_WORDS);
  if (kind) out.employmentType = kind;
  else delete out.employmentType;
  const basis = codeFromWords(f.compensationBasis, ["hourly", "salary"], BASIS_WORDS);
  if (basis) out.compensationBasis = basis;
  else delete out.compensationBasis;
  // "On site", "On-site", "In office", "Hybrid", "Remote", "Work from home". Whether the assistant may set it at all is
  // the agent's rule (only when the owner's own typed words name an arrangement); this only reads what it wrote.
  const arrangement = codeFromWords(f.remotePolicy, RemotePolicy.options, REMOTE_WORDS);
  if (arrangement) out.remotePolicy = arrangement;
  else delete out.remotePolicy;
  return out;
}

/** One of a few codes from the words a fact came in; undefined when the words name none of them, or more than one. */
function codeFromWords(value: string | undefined, allowed: readonly string[], list: Array<[RegExp, string]>): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (allowed.includes(v)) return v;
  const named = [...new Set(list.filter(([re]) => re.test(v)).map(([, code]) => code))];
  return named.length === 1 ? named[0] : undefined;
}

const REQUIREMENT_STOP_WORDS = new Set(["the", "and", "for", "with", "our", "your", "their", "must", "have", "has", "able", "can", "who", "will", "are", "experience", "years", "year", "you", "any", "all", "from", "into", "that", "this", "work", "working", "job", "role", "plus"]);

function requirementWords(text: string): Set<string> {
  return new Set(normalizeCriterion(text).split(" ").filter((w) => w.length >= 3 && !REQUIREMENT_STOP_WORDS.has(w)));
}

/** A credential's short form, as a question names it: three to six capital letters, whole ("RDA", "CPR/BLS", "(RDH)"). Words all in capitals are read for their words only. */
const shortForms = (text: string): Set<string> => new Set(/[a-z]/.test(text) ? text.match(/\b[A-Z]{3,6}\b/g) ?? [] : []);

/**
 * Whether two lines ask for the same requirement: the same words, one's key words nearly all inside the other's, or both
 * naming the same credential by its short form however the rest is worded ("Active California RDA license" and "Do you
 * hold a Registered Dental Assistant (RDA) license?").
 */
export function sameRequirement(a: string, b: string): boolean {
  if (normalizeCriterion(a) === normalizeCriterion(b)) return true;
  const x = requirementWords(a);
  const y = requirementWords(b);
  if (x.size >= 2 && y.size >= 2) {
    let shared = 0;
    for (const t of x) if (y.has(t)) shared += 1;
    if (shared / Math.min(x.size, y.size) >= 0.8) return true;
  }
  const short = shortForms(a);
  for (const s of shortForms(b)) if (short.has(s)) return true;
  return false;
}

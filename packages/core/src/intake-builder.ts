import {
  EmploymentType, HireReason, INTAKE_ESSENTIALS, RemotePolicy, formatPayRange,
  type DeclinedCriterion, type DraftRolePacket, type IntakeAnswer, type IntakeEssentialKey, type IntakeFacts, type IntakeFactsPatch, type IntakeListFact,
  type IntakeMessage, type IntakePayCard, type IntakeQuestion, type IntakeReadiness, type IntakeRefusal, type IntakeServerState, type PayOrigin, type RolePacket,
} from "@ros/contracts";
import { openFlagsMessage, questionCheck, screenCriterion, normalizeCriterion, unresolvedFlags } from "./packet-guard";

/**
 * The job builder's rules that need no model and no database (Wave C: C2, C6, C7, C8, C14, C17): what is still missing,
 * whether pay was set by a person, the pay card, and how a tapped answer or a panel edit changes the facts. Kept here,
 * pure, so the routes, the agent and the tests all read the same rules.
 */

export const ESSENTIAL_LABEL: Readonly<Record<IntakeEssentialKey, string>> = {
  title: "Job title",
  location: "Where the job is",
  compensation_range: "Pay",
  reason_for_hire: "Why you are hiring",
  interviewers: "Who interviews",
  decision_maker: "Who makes the final decision",
};

/** "Just draft it" and the like: the owner asks for the first draft before every question is answered (founder decision Q8). */
export const DRAFT_IT_WORDS = /\b(?:just\s+)?draft\s+it\b|\bwrite\s+(?:it|the\s+draft)\b|\bgo ahead\b|\bthat'?s enough\b/i;

/** A first message long enough, or with enough lines, to be a job ad someone pasted (C5). */
export function looksLikePastedAd(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  return text.length >= 1200 || (lines >= 8 && text.length >= 400);
}

/** The amounts in a person's words: "$60,000", "60k", "$45.50" (commas and the k read as people mean them). */
export function amountsIn(text: string): number[] {
  let t = text;
  while (/\d,\d{3}/.test(t)) t = t.replace(/(\d),(\d{3})/g, "$1$2");
  const out: number[] = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(k\b)?/gi)) out.push(Number(m[1]) * (m[2] ? 1000 : 1));
  return out;
}

/**
 * Whether pay is hourly or a salary, from the owner's own words (C2), before the first market check: "an hour", "a
 * year", "salary", or the size of the dollar amounts ($60,000 is a salary, $45 an hourly rate). Null when it cannot tell.
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

/**
 * Pay a person set by typing it (C7): the range on the facts appears, figure for figure, in words the person typed. The
 * model only read the numbers; this check is code, so the confirmation is never the model's word. A range read from a
 * pasted ad or an earlier role is not typed and waits for the pay card.
 */
export function payTyped(messages: IntakeMessage[], facts: IntakeFacts): boolean {
  if (facts.compensationMin === undefined || facts.compensationMax === undefined || !isBasis(facts.compensationBasis)) return false;
  const said = new Set(typedByOwner(messages).flatMap(amountsIn));
  return said.has(facts.compensationMin) && said.has(facts.compensationMax);
}

/**
 * The ceiling the facts carry, only when the person typed that figure themselves and it is not below the top of the
 * range; a ceiling the model read anywhere else (an ad, an earlier role) is not theirs.
 */
export function typedCeiling(messages: IntakeMessage[], facts: IntakeFacts): number | undefined {
  const c = facts.compensationCeiling;
  if (c === undefined || (facts.compensationMax !== undefined && c < facts.compensationMax)) return undefined;
  return typedByOwner(messages).flatMap(amountsIn).includes(c) ? c : undefined;
}

const isBasis = (b: string | undefined): b is "hourly" | "salary" => b === "hourly" || b === "salary";

/** The confirmation stands only while the facts still carry the figures that were confirmed. */
export function payConfirmed(facts: IntakeFacts, state: Pick<IntakeServerState, "pay">): boolean {
  const p = state.pay;
  return !!p && p.basis === facts.compensationBasis && p.min === facts.compensationMin && p.max === facts.compensationMax;
}

/** A key for the confirmed pay a draft was written with: a draft written before pay changed is written again. */
export function payKey(state: Pick<IntakeServerState, "pay">): string | null {
  const p = state.pay;
  return p ? `${p.basis}:${p.min}:${p.max}:${p.ceiling ?? ""}` : null;
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/** The note on "Who interviews" when nobody was named and the person who decides is assumed to interview. */
export const INTERVIEWERS_DEFAULT_NOTE = "The person who decides interviews; add others if you like.";

function essentialValue(key: IntakeEssentialKey, f: IntakeFacts): { done: boolean; value: string | null; note: string | null } {
  switch (key) {
    case "title":
      return { done: !!f.title?.trim(), value: f.title?.trim() || null, note: null };
    case "location":
      return { done: !!f.locationText?.trim(), value: f.locationText?.trim() || null, note: null };
    case "compensation_range": {
      const done = f.compensationMin !== undefined && f.compensationMax !== undefined && isBasis(f.compensationBasis);
      return { done, value: done ? formatPayRange({ basis: f.compensationBasis!, min: f.compensationMin!, max: f.compensationMax! }) : null, note: null };
    }
    case "reason_for_hire":
      return { done: !!f.reason?.trim(), value: f.reason?.trim() || null, note: null };
    case "interviewers": {
      if (f.interviewers.length) return { done: true, value: f.interviewers.join(", "), note: null };
      // Who interviews defaults to whoever decides, the usual case in a small business; it shows as an assumption.
      const dm = f.decisionMaker?.trim();
      return dm ? { done: true, value: dm, note: INTERVIEWERS_DEFAULT_NOTE } : { done: false, value: null, note: null };
    }
    case "decision_maker":
      return { done: !!f.decisionMaker?.trim(), value: f.decisionMaker?.trim() || null, note: null };
  }
}

/** The facts `finalizeDraft` (packages/agents/src/intake.ts) sets on the draft by rule after the model, so changing them never needs the draft written again. */
const SET_BY_RULE: ReadonlySet<string> = new Set(["compensationBasis", "compensationMin", "compensationMax", "compensationCeiling", "decisionMaker", "decisionMakerUserId", "interviewers", "interviewerUserIds", "dealBreakers", "declinedCriteria", "suggestions"]);

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
 * A key of the answers the draft's words are written from (C7): everything except what is set on the draft by rule
 * (pay, who decides and who interviews, the deal-breakers, what was declined, unticked suggestions). A draft written
 * from other answers than the current ones is out of date: only writing it again carries the change into its words.
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
 * Readiness, computed on the server (C7, founder decision Q8). The first draft can be written once the essentials are
 * in, or once the owner answered a round of questions, or said "draft it", as long as there is a title (or they asked).
 * "Ask for approval" needs a written draft that is up to date with the answers (`draftRequired`: the one-step /compile
 * writes it first), all six essentials, pay a person set or confirmed, and no open wording check on the draft.
 */
export function intakeReadiness(input: { facts: IntakeFacts; state: IntakeServerState; messages: IntakeMessage[]; draft: DraftRolePacket | null; draftRequired?: boolean }): IntakeReadiness {
  const { facts, state, messages, draft } = input;
  const essentials = INTAKE_ESSENTIALS.map((key) => ({ key, label: ESSENTIAL_LABEL[key], ...essentialValue(key, facts) }));
  const missing = essentials.filter((e) => !e.done).map((e) => e.key);
  const confirmed = payConfirmed(facts, state);
  const ownerTurns = messages.filter((m) => m.role === "owner").length;
  const askedForDraft = !!state.draftRequestedAt;
  const roundAnswered = ownerTurns >= 2 || state.answeredRounds > 0;
  const hasTitle = !!facts.title?.trim();
  let draftBlocker: string | null = null;
  if (!ownerTurns) draftBlocker = "Describe the job first.";
  else if (!hasTitle && !askedForDraft) draftBlocker = "Tell me the job title first, or say \"draft it\".";
  else if (missing.length && !askedForDraft && !roundAnswered) draftBlocker = "Answer the question cards first, or say \"draft it\".";
  const openFlags = draft ? unresolvedFlags(draft).length : 0;
  // A draft written before the key existed is never called out of date: there is nothing to compare it with.
  const draftOutOfDate = !!draft && !!state.draft?.factsKey && state.draft.factsKey !== draftFactsKey(facts);
  const approvalBlockers: string[] = [];
  for (const e of essentials) if (!e.done) approvalBlockers.push(`Not set yet: ${e.label.toLowerCase()}.`);
  if (!confirmed) approvalBlockers.push(facts.compensationMin !== undefined ? "Confirm the pay on the pay card." : "Set the pay on the pay card.");
  if (!draft && input.draftRequired !== false) approvalBlockers.push("Write the draft first, so you can check it.");
  if (draftOutOfDate) approvalBlockers.push("You changed answers after the draft was written. Write it again with them first.");
  if (openFlags) approvalBlockers.push(openFlagsMessage(openFlags));
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
    mayAskForApproval: approvalBlockers.length === 0,
    approvalBlockers,
  };
}

const PAY_UNIT: Record<"hourly" | "salary", string> = { hourly: "an hour", salary: "a year" };

/** A market figure's place as a sentence says it: "the Austin area", "the US as a whole", "Los Angeles-Long Beach-Anaheim, CA". */
export function marketPlace(metro: string): string {
  // A figure stored before places were written with capitals ("austin area") reads as "Austin area".
  const named = metro === metro.toLowerCase() ? metro.replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/ Area$/, " area") : metro;
  if (/^us national$/i.test(named)) return "the US as a whole";
  return /\barea$/i.test(named) ? `the ${named}` : named;
}

/**
 * The pay card (C8): the market figure with its source and year, the ITS estimate labelled as one, or plainly none. A
 * figure for a broader group of jobs than this one (`approximate`) says so, and a range below its middle is mentioned
 * gently rather than as something that will slow the search (polish list).
 */
export function payCard(facts: IntakeFacts, state: IntakeServerState): IntakePayCard {
  const basis = isBasis(facts.compensationBasis) ? facts.compensationBasis : state.benchmark?.basis ?? null;
  const b = state.benchmark ?? null;
  const confirmed = payConfirmed(facts, state) && state.pay ? { byName: state.pay.by.name ?? null, at: state.pay.at, via: state.pay.via } : null;
  const stated = { min: facts.compensationMin ?? null, max: facts.compensationMax ?? null, ceiling: facts.compensationCeiling ?? null };
  if (b) {
    const range = `${money(b.p25)}–${money(b.p75)} ${PAY_UNIT[b.basis]} (middle ${money(b.p50)})`;
    const label = b.origin === "its_estimate" ? "ITS estimate" : `Market pay${b.asOf ? `, ${b.asOf}` : ""}`;
    const where = marketPlace(b.metro);
    const rough = b.approximate ? ` There is no government figure for this exact job, so this one is for a broader group${b.occupation ? ` (${b.occupation.toLowerCase()})` : ""}: take it as a rough guide.` : "";
    const summary = b.origin === "its_estimate"
      ? `ITS estimate for ${where}: ${range}. This is ITS's own pay table, not government wage data.${rough}`
      : `Market pay for ${where}: ${range}. Source: ${b.source}.${rough}`;
    const belowMarket = stated.max !== null && b.basis === basis && stated.max < b.p50;
    const below = b.approximate ? " Your range tops out below its middle, which is worth knowing but not a worry on its own." : " Your range tops out below the middle of the market, which can slow the search.";
    return { basis, benchmark: { ...b, label }, gap: null, stated, confirmed, belowMarket, summary: belowMarket ? `${summary}${below}` : summary };
  }
  const where = facts.locationText?.trim() || "this place";
  const gap = state.benchmarkGap === "basis_unknown" || !basis
    ? { reason: "basis_unknown" as const, message: "Is this job paid by the hour or a yearly salary? Pay is checked against the market once we know." }
    : { reason: "no_market_figure" as const, message: `We have no market pay figure for this job in ${where}, so pay was not checked against the market.` };
  return { basis, benchmark: null, gap, stated, confirmed, belowMarket: false, summary: gap.message };
}

/** The facts a new draft starts from when a role is hired for again (C14). Pay is carried over to be confirmed, never as confirmed. */
export function packetToFacts(packet: RolePacket): IntakeFacts {
  const loc = packet.identity.locations[0];
  const rounds = packet.interviews.plan.flatMap((r) => r.interviewerRoles);
  return {
    title: packet.identity.title,
    locationText: loc ? [loc.city, loc.region].filter(Boolean).join(", ") || undefined : undefined,
    employmentType: packet.identity.employmentType,
    schedule: packet.identity.schedule,
    remotePolicy: packet.identity.remotePolicy,
    compensationBasis: packet.compensation.basis,
    compensationMin: packet.compensation.min,
    compensationMax: packet.compensation.max,
    compensationCeiling: packet.compensation.ceiling,
    benefits: packet.compensation.benefitsSummary,
    mustHaves: packet.requirements.mustHaves.map((m) => m.text),
    niceToHaves: packet.requirements.niceToHaves.map((m) => m.text),
    eligibilityNotes: [],
    interviewers: [...new Set(rounds)].filter((r) => r !== "owner"),
    decisionMaker: packet.preferences.decisionMakerName,
    decisionMakerUserId: packet.preferences.decisionMakerUserId,
    whatFailureLooksLike: packet.preferences.whatFailureLooksLike,
    dealBreakers: packet.preferences.dealBreakersInTheirWords,
    declinedCriteria: (packet.provenance.declinedCriteria ?? []).map((d) => ({ requested: d.requested, reason: d.reason, ...(d.alternative ? { alternative: d.alternative } : {}) })),
    screeningQuestions: packet.screening.questions.map((q) => q.question),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Answers and edits (C6, C15): set / add / remove semantics, the fairness check on everything a person types.          */
/* ------------------------------------------------------------------------------------------------------------------ */

export type TeamMember = { userId: string; name: string; role: string };

/** Roles that may approve a role packet: the decision maker is chosen from these. */
export const DECIDER_ROLES = ["owner", "admin", "hiring_manager"];
/** The value of "Someone not on the team yet" on a team card; their name comes in `own`. */
export const SOMEONE_NEW = "__someone_new";

export class IntakeEditError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export type FactsEdit = {
  facts: IntakeFacts;
  /** Values a person took out of a list: the assistant may not put them back. */
  removed: Array<{ field: string; value: string }>;
  /** Values a person put back on purpose: no longer held out. */
  restored: Array<{ field: string; value: string }>;
  refused: IntakeRefusal[];
  /** Pay a person set or confirmed in this edit. */
  pay: { basis: "hourly" | "salary"; min: number; max: number; ceiling?: number; via: PayOrigin } | null;
  /** One short line per answer for the conversation ("Must-haves: active RDH license, perio experience"). */
  summary: string[];
};

/** The most must-haves a role keeps: the packet holds six, and a card or the panel refuses a seventh. */
export const MAX_MUST_HAVES = 6;

const LIST_OF: Partial<Record<IntakeQuestion["field"], IntakeListFact>> = {
  responsibilities: "responsibilities",
  must_haves: "mustHaves",
  nice_to_haves: "niceToHaves",
  eligibility: "eligibilityNotes",
  deal_breakers: "dealBreakers",
  screening_questions: "screeningQuestions",
};

const FIELD_LABEL: Record<IntakeQuestion["field"], string> = {
  title: "Job title",
  location: "Where",
  employment_type: "Full or part time",
  schedule: "Schedule",
  remote_policy: "Work model",
  reason_for_hire: "Why you are hiring",
  compensation_basis: "Paid",
  compensation: "Pay",
  responsibilities: "First thing they would own",
  must_haves: "Must-haves",
  nice_to_haves: "Nice to have",
  eligibility: "Eligibility",
  interviewers: "Who interviews",
  decision_maker: "Final decision",
  timeline: "Start",
  what_failure_looks_like: "What would not work out",
  deal_breakers: "Deal-breakers",
  screening_questions: "Screening questions",
  benefits: "Benefits",
};

const same = (a: string, b: string) => normalizeCriterion(a) === normalizeCriterion(b);
const dedupe = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => same(x, y)) === i);

const EMPLOYMENT_WORDS: Array<[RegExp, string]> = [[/full/i, "full_time"], [/part/i, "part_time"], [/contract/i, "contract"], [/temp/i, "temporary"], [/per[\s_-]?diem/i, "per_diem"], [/intern/i, "internship"]];
const REMOTE_WORDS: Array<[RegExp, string]> = [[/hybrid/i, "hybrid"], [/remote/i, "remote"], [/on[\s_-]?site|in[\s_-]?(?:office|person)/i, "onsite"]];
const REASON_WORDS: Array<[RegExp, string]> = [[/replac|left|quit|backfill|resign|retir/i, "replacement"], [/new|first|dedicated|creat/i, "new_position"], [/grow|busier|capacity|expand|adding/i, "growth"], [/season/i, "seasonal"], [/other/i, "other"]];

/**
 * A card's answer as the role keeps it. The model is asked to make an option's value the words to store, but it sometimes
 * writes a code instead ("rda_license", "mon_fri_days", "backfill" on staging, 13 Oct 2026), which then showed on the
 * draft as the code. A value that looks like a code is replaced by the label the person actually ticked.
 */
export function storedAnswer(option: { label: string; value: string }): string {
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(option.value.trim()) && option.label.trim() ? option.label.trim() : option.value;
}

/** A plain word for a field the packet keeps as one of a few values ("Full time" is full_time); refused when it names none. */
function oneOf(value: string, allowed: readonly string[], words: Array<[RegExp, string]>, what: string): string {
  if (allowed.includes(value)) return value;
  const hit = words.find(([re]) => re.test(value));
  if (hit) return hit[1];
  throw new IntakeEditError("invalid_value", `That is not a ${what} we know. Choose one of the options.`);
}

const COUNT_WORDS: Readonly<Record<string, number>> = { a: 1, an: 1, next: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const COUNT_WORD = Object.keys(COUNT_WORDS).sort((a, b) => b.length - a.length).join("|");
const COUNT = `(\\d+|${COUNT_WORD})\\+?`;
const UNIT = "(days?|weeks?|wks?|months?|mos?|years?|yrs?)";
/**
 * "2–4 weeks", "2 4 weeks" (a code's underscores read as spaces), "1 to 2 months", "a month", "30 days", "6+ wks", and "a
 * week or two", where the second count takes the first one's unit. A range with a unit at each end ("3 days to 2 weeks")
 * is two matches, so the pattern is global and every match is read.
 */
const LENGTH_OF_TIME = new RegExp(`\\b${COUNT}(?:\\s*(?:-|to|or)?\\s*\\b${COUNT})?\\s*${UNIT}\\b(?:\\s*(?:-|to|or)\\s*(\\d{1,2}|${COUNT_WORD})\\b(?!\\s*${UNIT}))?`, "g");
const UNIT_DAYS: Readonly<Record<string, number>> = { d: 1, w: 7, m: 30, y: 365 };

/**
 * The days a length of time in words allows, reading the upper end of a range, since that is how long the person said
 * they can wait: "Within 2–4 weeks" is 28, "1–2 months" 60 (a month is read as 30 days), "3 days to 2 weeks" 14, "a week
 * or two" 14, "within_2_4_weeks" 28, "within_30_days" or a bare "30" 30. Null when the words name no length of time.
 */
export function daysWithin(text: string): number | null {
  const t = text.toLowerCase().replace(/_/g, " ").replace(/[–—]/g, "-").trim();
  const count = (w: string | undefined) => (w ? COUNT_WORDS[w] ?? Number(w) : 0);
  const lengths = [...t.matchAll(LENGTH_OF_TIME)].map((m) => Math.max(count(m[1]), count(m[2]), count(m[4])) * UNIT_DAYS[m[3][0]]);
  if (lengths.length) return Math.max(...lengths);
  // A bare number is days, as the cards' codes have always meant it ("within_30"); a year such as 2027 is not.
  const bare = t.match(/^(?:within|in|under)?\s*(\d+)$/);
  return bare && Number(bare[1]) <= 365 ? Number(bare[1]) : null;
}

const ASAP_WORDS = /\b(?:asap|as soon as possible|immediately|right away)\b/i;

/**
 * A start given in words becomes a date, so the packet's timeline has one: "asap" (or "As soon as possible") is two weeks
 * out and urgent; "Within 2–4 weeks" is four weeks out, not the first number read as days (staging, 13 Oct 2026: a start
 * of tomorrow); a date (YYYY-MM-DD) stays as it is. Nothing is set when the words name no time.
 */
export function startDateFor(value: string, now: Date): { targetStartDate?: string; urgency?: string } {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { targetStartDate: v };
  const asap = ASAP_WORDS.test(v);
  const days = asap ? 14 : daysWithin(v);
  if (days === null) return {};
  const d = new Date(now.getTime() + days * 86_400_000);
  return { targetStartDate: d.toISOString().slice(0, 10), ...(asap ? { urgency: "high" } : {}) };
}

function emptyEdit(facts: IntakeFacts): FactsEdit {
  return { facts: normalizeFacts(structuredClone(facts)), removed: [], restored: [], refused: [], pay: null, summary: [] };
}

/**
 * The answers that are questions put to candidates (the form's yes/no questions, the screening chat's questions, both on
 * a card and in the quick start's one edit): read for protected-characteristic questions too (Wave S7, `questionCheck`).
 */
const QUESTION_FIELDS: ReadonlySet<string> = new Set(["eligibility", "eligibilityNotes", "screening_questions", "screeningQuestions"]);

/** The fairness check on words a person typed: a refusal is recorded with the reason, as the assistant would have declined it. */
function screened(edit: FactsEdit, field: string, values: string[]): string[] {
  const ok: string[] = [];
  for (const v of values) {
    const hit = QUESTION_FIELDS.has(field) ? questionCheck(v) : screenCriterion(v);
    if (!hit) {
      ok.push(v);
      continue;
    }
    edit.refused.push({ field, text: v, reason: hit.reason, alternative: hit.alternative });
    if (!edit.facts.declinedCriteria.some((d) => same(d.requested, v))) edit.facts.declinedCriteria.push({ requested: v, reason: hit.reason, alternative: hit.alternative });
  }
  return ok;
}

function setPay(edit: FactsEdit, pay: { basis: "hourly" | "salary"; min: number; max: number; ceiling?: number }, via: PayOrigin): void {
  if (pay.min > pay.max) throw new IntakeEditError("pay_range", "The lowest pay must not be above the highest.");
  if (pay.ceiling !== undefined && pay.ceiling < pay.max) throw new IntakeEditError("ceiling_below_range", "The most you would pay must not be below the top of the range.");
  const f = edit.facts;
  const unchanged = f.compensationBasis === pay.basis && f.compensationMin === pay.min && f.compensationMax === pay.max;
  f.compensationBasis = pay.basis;
  f.compensationMin = pay.min;
  f.compensationMax = pay.max;
  // The ceiling is the one the person sent with the pay (the card shows any earlier one, to keep or clear), or none: the top of the range.
  if (pay.ceiling !== undefined) f.compensationCeiling = pay.ceiling;
  else delete f.compensationCeiling;
  // The same figures that were already on the draft (from an ad or an earlier role) are confirmed; new ones are set.
  edit.pay = { ...pay, via: unchanged && via === "pay_card" ? "confirmed" : via };
  edit.summary.push(`Pay: ${formatPayRange({ basis: pay.basis, min: pay.min, max: pay.max })}${pay.ceiling !== undefined ? `, at most ${money(pay.ceiling)}` : ""}`);
}

function listSet(edit: FactsEdit, field: IntakeListFact, keep: string[], drop: string[]): void {
  const f = edit.facts as Record<IntakeListFact, string[] | undefined>;
  const current = f[field] ?? [];
  const next = dedupe([...current.filter((x) => !drop.some((d) => same(d, x))), ...keep]);
  if (field === "mustHaves" && next.length > MAX_MUST_HAVES) throw new IntakeEditError("too_many_must_haves", "Keep it to six must-haves; anything else can be a nice-to-have.");
  f[field] = next;
  for (const d of drop) if (current.some((x) => same(x, d))) edit.removed.push({ field, value: d });
  for (const k of keep) edit.restored.push({ field, value: k });
}

/**
 * Applies the answers to the open cards. Ticked offered answers and the owner's own words set the fact; an offered answer
 * left unticked is kept as a suggestion (never a nice-to-have) and taken out of the fact if it was there; everything the
 * owner typed passes the fairness check; a team card takes real team members; the pay card sets or confirms pay.
 */
export function applyAnswers(facts: IntakeFacts, questions: IntakeQuestion[], answers: IntakeAnswer[], team: TeamMember[], now = new Date()): FactsEdit {
  const edit = emptyEdit(facts);
  for (const a of answers) {
    const q = questions.find((x) => x.id === a.questionId);
    if (!q) throw new IntakeEditError("unknown_question", "That question has been replaced by newer ones. Answer the questions showing now.");
    if (a.skipped) continue;
    if (q.mode === "pay") {
      if (!a.pay) throw new IntakeEditError("pay_missing", "Set the pay range first.");
      setPay(edit, a.pay, "pay_card");
      continue;
    }
    // A team card is checked against the team as it is now, not the list it was drawn with.
    if (q.mode === "team") {
      applyTeam(edit, q, a, team);
      continue;
    }
    const offered = new Map(q.options.map((o) => [o.value, o]));
    for (const v of a.selected) if (!offered.has(v)) throw new IntakeEditError("unknown_option", "That answer was not one of the choices on the card.");
    if (a.own.length && !q.allowOwn) throw new IntakeEditError("own_not_allowed", "Pick one of the choices on this card.");
    const own = screened(edit, q.field, a.own);
    const picked = a.selected.filter((v) => v !== SOMEONE_NEW);
    const list = LIST_OF[q.field];
    if (list) {
      // An offered answer the fairness check would refuse is never stored, even if a stale card still showed it.
      const chosen = screened(edit, q.field, picked.map((v) => storedAnswer(offered.get(v)!)));
      const values = [...chosen, ...own];
      const unticked = q.options.filter((o) => !a.selected.includes(o.value));
      listSet(edit, list, values, unticked.map(storedAnswer));
      const suggestions = edit.facts.suggestions ?? [];
      for (const o of unticked) if (!suggestions.some((s) => s.field === q.field && same(s.text, storedAnswer(o)))) suggestions.push({ field: q.field, text: storedAnswer(o), origin: o.origin });
      edit.facts.suggestions = suggestions.filter((s) => !(s.field === q.field && values.some((v) => same(v, s.text))));
      if (values.length) edit.summary.push(`${FIELD_LABEL[q.field]}: ${values.join("; ")}`);
      continue;
    }
    // The fairness check reads the words the person ticked, which is also what a text fact keeps.
    const first = picked.map((v) => offered.get(v)!).find((o) => screened(edit, q.field, [storedAnswer(o)]).length > 0);
    const value = first?.value ?? own[0];
    if (value === undefined) continue;
    setText(edit, q.field, value, now, first ? storedAnswer(first) : undefined);
    edit.summary.push(`${FIELD_LABEL[q.field]}: ${first?.label ?? value}`);
  }
  return edit;
}

/**
 * Sets one fact from an answer. `value` is what was sent (an option's value, or words typed); `words`, for an offered
 * option, is what the person read and ticked (`storedAnswer`). A fact kept as one of a few codes tries the value, then the
 * words; a fact kept as text stores the words; a start becomes a date by `startDateFor` from the words ("Within 1 month"),
 * or from the value ("asap", "within_30_days") when the words name no time.
 */
function setText(edit: FactsEdit, field: IntakeQuestion["field"], value: string, now: Date, words?: string): void {
  const f = edit.facts;
  const text = words ?? value;
  const pick = (allowed: readonly string[], list: Array<[RegExp, string]>, what: string): string => {
    if (allowed.includes(value)) return value;
    const hit = list.find(([re]) => re.test(value)) ?? (words ? list.find(([re]) => re.test(words)) : undefined);
    if (hit) return hit[1];
    return oneOf(text, allowed, list, what);
  };
  switch (field) {
    case "title": f.title = text; break;
    case "location": f.locationText = text; break;
    case "employment_type": f.employmentType = pick(EmploymentType.options, EMPLOYMENT_WORDS, "kind of job"); break;
    case "schedule": f.schedule = text; break;
    case "remote_policy": f.remotePolicy = pick(RemotePolicy.options, REMOTE_WORDS, "work model"); break;
    case "reason_for_hire":
      if (HireReason.options.includes(value as never)) f.reason = value;
      else { f.reason = REASON_WORDS.find(([re]) => re.test(value))?.[1] ?? (words ? REASON_WORDS.find(([re]) => re.test(words))?.[1] : undefined) ?? "other"; f.reasonDetail = text; }
      break;
    case "compensation_basis": f.compensationBasis = pick(["hourly", "salary"], [[/hour/i, "hourly"], [/salar|year|annual/i, "salary"]], "pay basis"); break;
    case "timeline": {
      // The words the person ticked come first: a code can be a bare number ("1" on "Within 1 month"), which reads as one
      // day. The code is used when the words name no time ("Soon" on "within_30_days").
      const fromWords = words ? startDateFor(words, now) : {};
      Object.assign(f, fromWords.targetStartDate ? fromWords : startDateFor(value, now));
      break;
    }
    case "what_failure_looks_like": f.whatFailureLooksLike = text; break;
    case "benefits": f.benefits = text; break;
    case "decision_maker": f.decisionMaker = text; f.decisionMakerUserId = undefined; break;
    default: break;
  }
}

function applyTeam(edit: FactsEdit, q: IntakeQuestion, a: IntakeAnswer, team: TeamMember[]): void {
  const ids = a.selected.filter((v) => v !== SOMEONE_NEW);
  const members = ids.map((id) => team.find((m) => m.userId === id));
  if (members.some((m) => !m)) throw new IntakeEditError("unknown_member", "That person is not on the team any more.");
  const own = screened(edit, q.field, a.own);
  const f = edit.facts;
  if (q.field === "decision_maker") {
    const m = members[0];
    if (m) {
      if (!DECIDER_ROLES.includes(m.role)) throw new IntakeEditError("not_a_decider", `${m.name} cannot approve roles; choose an owner, an admin or a hiring manager.`);
      f.decisionMakerUserId = m.userId;
      f.decisionMaker = m.name;
    } else if (own[0]) {
      f.decisionMakerUserId = undefined;
      f.decisionMaker = own[0];
    } else return;
    edit.summary.push(`${FIELD_LABEL.decision_maker}: ${f.decisionMaker}`);
    return;
  }
  const names = [...members.map((m) => m!.name), ...own];
  if (!names.length) return;
  f.interviewerUserIds = members.map((m) => m!.userId);
  f.interviewers = dedupe(names);
  edit.summary.push(`${FIELD_LABEL.interviewers}: ${f.interviewers.join(", ")}`);
}

/** A change from the draft panel (C7): set a field, add or remove one list item, clear a field. Typed words pass the fairness check. */
export function applyFactsPatch(facts: IntakeFacts, patch: IntakeFactsPatch, team: TeamMember[], now = new Date()): FactsEdit {
  const edit = emptyEdit(facts);
  const f = edit.facts;
  const set = patch.set ?? {};
  for (const [k, raw] of Object.entries(set)) {
    if (raw === undefined) continue;
    if (k === "pay") { setPay(edit, raw as NonNullable<typeof set.pay>, "edited"); continue; }
    if (k === "decisionMakerUserId") {
      const m = team.find((x) => x.userId === raw);
      if (!m) throw new IntakeEditError("unknown_member", "That person is not on the team any more.");
      if (!DECIDER_ROLES.includes(m.role)) throw new IntakeEditError("not_a_decider", `${m.name} cannot approve roles; choose an owner, an admin or a hiring manager.`);
      f.decisionMakerUserId = m.userId;
      f.decisionMaker = m.name;
      edit.summary.push(`${FIELD_LABEL.decision_maker}: ${m.name}`);
      continue;
    }
    if (k === "interviewerUserIds") {
      const ids = raw as string[];
      const members = ids.map((id) => team.find((m) => m.userId === id));
      if (members.some((m) => !m)) throw new IntakeEditError("unknown_member", "That person is not on the team any more.");
      f.interviewerUserIds = ids;
      f.interviewers = dedupe([...members.map((m) => m!.name), ...f.interviewers.filter((n) => !team.some((m) => same(m.name, n)))]);
      edit.summary.push(`${FIELD_LABEL.interviewers}: ${f.interviewers.join(", ")}`);
      continue;
    }
    const value = String(raw);
    const [ok] = screened(edit, k, [value]);
    if (ok === undefined) continue;
    if (k === "employmentType") f.employmentType = oneOf(ok, EmploymentType.options, EMPLOYMENT_WORDS, "kind of job");
    else if (k === "remotePolicy") f.remotePolicy = oneOf(ok, RemotePolicy.options, REMOTE_WORDS, "work model");
    else if (k === "reason") f.reason = oneOf(ok, HireReason.options, REASON_WORDS, "reason for the hire");
    else if (k === "targetStartDate") Object.assign(f, startDateFor(ok, now));
    else if (k === "decisionMaker") { f.decisionMaker = ok; f.decisionMakerUserId = undefined; }
    else (f as Record<string, unknown>)[k] = ok;
    const stored = (f as Record<string, unknown>)[k];
    edit.summary.push(`${FACT_LABEL[k] ?? "An answer"}: ${plainFact(k, typeof stored === "string" ? stored : ok)}`);
  }
  const byField = new Map<IntakeListFact, { add: string[]; remove: string[] }>();
  for (const a of patch.add ?? []) { const e = byField.get(a.field) ?? { add: [], remove: [] }; e.add.push(a.value); byField.set(a.field, e); }
  for (const r of patch.remove ?? []) { const e = byField.get(r.field) ?? { add: [], remove: [] }; e.remove.push(r.value); byField.set(r.field, e); }
  for (const [field, e] of byField) {
    const add = screened(edit, field, e.add);
    listSet(edit, field, add, e.remove);
    if (field === "interviewers" && e.remove.length) f.interviewerUserIds = (f.interviewerUserIds ?? []).filter((id) => !e.remove.some((n) => same(team.find((m) => m.userId === id)?.name ?? "", n)));
    if (add.length) edit.summary.push(`${FACT_LABEL[field]}, added: ${add.join("; ")}`);
    if (e.remove.length) edit.summary.push(`${FACT_LABEL[field]}, taken out: ${e.remove.join("; ")}`);
  }
  for (const k of patch.clear ?? []) {
    (f as Record<string, unknown>)[k] = undefined;
    if (k === "decisionMaker") f.decisionMakerUserId = undefined;
    edit.summary.push(`${FACT_LABEL[k] ?? "An answer"}: taken out`);
  }
  return edit;
}

/** The panel's fields as the conversation names them: the person reads these lines as their own message, and so does a recruiter they bring in. */
const FACT_LABEL: Readonly<Record<string, string>> = {
  title: "Job title",
  locationText: "Where the job is",
  employmentType: "Full or part time",
  remotePolicy: "Work model",
  schedule: "Schedule",
  reason: "Why you are hiring",
  reasonDetail: "More on why you are hiring",
  targetStartDate: "Start",
  urgency: "How soon",
  whatFailureLooksLike: "What would not work out",
  benefits: "Benefits",
  decisionMaker: "Final decision",
  responsibilities: "What they would own",
  mustHaves: "Must-haves",
  niceToHaves: "Nice to have",
  eligibilityNotes: "Eligibility",
  dealBreakers: "Deal-breakers",
  screeningQuestions: "Screening questions",
  interviewers: "Who interviews",
};

const EMPLOYMENT_PLAIN: Readonly<Record<string, string>> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };
const WORK_MODEL_PLAIN: Readonly<Record<string, string>> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
const REASON_PLAIN: Readonly<Record<string, string>> = { new_position: "A new position", replacement: "Replacing someone who left", growth: "The team is growing", seasonal: "Seasonal help", other: "Another reason" };
const URGENCY_PLAIN: Readonly<Record<string, string>> = { high: "As soon as possible", normal: "No rush", low: "No rush" };

/** A stored value in words: "Full time", not full_time; "November 3, 2026", not 2026-11-03. */
function plainFact(k: string, v: string): string {
  if (k === "employmentType") return EMPLOYMENT_PLAIN[v] ?? v;
  if (k === "remotePolicy") return WORK_MODEL_PLAIN[v] ?? v;
  if (k === "reason") return REASON_PLAIN[v] ?? v;
  if (k === "urgency") return URGENCY_PLAIN[v] ?? v;
  if (k === "targetStartDate" && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? v : `by ${d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  }
  return v;
}

/**
 * Deal-breakers offered back as visible must-haves (C17, founder decision Q19): each one that passes the fairness check
 * becomes an option on a card; one that fails is declined with the reason, never offered and never used.
 */
export function dealBreakerOffer(facts: IntakeFacts, alreadyOffered: string[]): { offer: string[]; declined: DeclinedCriterion[] } {
  const offer: string[] = [];
  const declined: DeclinedCriterion[] = [];
  for (const d of facts.dealBreakers) {
    if (alreadyOffered.some((o) => same(o, d)) || facts.mustHaves.some((m) => same(m, d))) continue;
    const hit = screenCriterion(d);
    if (hit) declined.push({ requested: d, reason: hit.reason, alternative: hit.alternative, rule: hit.rule });
    else offer.push(d);
  }
  return { offer, declined };
}

/** Values a person removed stay out of what the assistant sends back, until the person adds them again. */
export function withoutRemoved(facts: IntakeFacts, removed: Array<{ field: string; value: string }>): IntakeFacts {
  if (!removed.length) return facts;
  const out = { ...facts } as Record<string, unknown>;
  for (const [field, values] of Object.entries(out)) {
    if (!Array.isArray(values)) continue;
    const gone = removed.filter((r) => r.field === field);
    if (gone.length) out[field] = values.filter((v) => typeof v !== "string" || !gone.some((g) => same(g.value, v)));
  }
  return out as IntakeFacts;
}

/** The facts only the server sets: dropped from whatever the model returns before it is merged. */
export function withoutServerOwned(facts: IntakeFacts): IntakeFacts {
  const out = { ...facts };
  delete out.decisionMakerUserId;
  delete out.interviewerUserIds;
  delete out.suggestions;
  return out;
}

/**
 * Facts as stored, with every list present (rows written before a field existed lack it). Must-haves are kept to the
 * first six: what the assistant reads from a conversation or a pasted ad is merged in without a limit, and a seventh
 * would fail every draft, since the packet holds six. Reading them here caps what the panel shows and the draft is
 * written from alike.
 */
export function normalizeFacts(facts: Partial<IntakeFacts> | null | undefined): IntakeFacts {
  const f = facts ?? {};
  return { ...f, mustHaves: (f.mustHaves ?? []).slice(0, MAX_MUST_HAVES), niceToHaves: f.niceToHaves ?? [], eligibilityNotes: f.eligibilityNotes ?? [], interviewers: f.interviewers ?? [], dealBreakers: f.dealBreakers ?? [], declinedCriteria: f.declinedCriteria ?? [] };
}

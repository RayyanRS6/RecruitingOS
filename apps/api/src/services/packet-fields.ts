import {
  CHOICE_OPTIONS_MAX, CHOICE_OPTIONS_MIN, QUICK_QUESTIONS_MAX, SCREENING_QUESTIONS_MAX, SCREENING_QUESTIONS_MIN, WRITTEN_QUESTIONS_MAX,
  type Actor, type CompanyQuestionRefusal, type CompanyQuestions, type CompanyQuestionsEdit, type EligibilityRule, type PacketFieldEdit, type QuickQuestion, type RolePacket, type ScreeningQuestion, type WrittenQuestion,
} from "@ros/contracts";
import { DECIDER_ROLES, companyQuestionProblemWords, companyQuestionProblems, normalizeCriterion, type TeamMember } from "@ros/core";
import { HttpError } from "../middleware/errors";

/**
 * The plain-field editor (plan C11): the fields an owner changes without opening the whole packet. Each edit starts from
 * the newest version and changes only what was sent; the result goes through `createPacketVersion` like every other
 * edit (the packet guard, the approval rules). Anything that would break the packet's own limits is refused here with
 * plain words, before anything is saved.
 */

const dollars = (n: number) => `$${n.toLocaleString("en-US")}`;

function keyFrom(prefix: string, words: string, taken: Set<string>): string {
  const stem = `${prefix}_${normalizeCriterion(words).replace(/ /g, "_").slice(0, 30) || "item"}`;
  let key = stem;
  for (let n = 2; taken.has(key); n += 1) key = `${stem}_${n}`;
  taken.add(key);
  return key;
}

function screeningQuestions(base: ScreeningQuestion[], sent: NonNullable<PacketFieldEdit["screeningQuestions"]>): ScreeningQuestion[] {
  if (sent.length < SCREENING_QUESTIONS_MIN || sent.length > SCREENING_QUESTIONS_MAX) throw new HttpError(400, "screening_questions_count", `Keep between ${SCREENING_QUESTIONS_MIN} and ${SCREENING_QUESTIONS_MAX} screening questions. This list has ${sent.length}.`);
  const taken = new Set(base.map((q) => q.key));
  const seen = new Set<string>();
  return sent.map((q) => {
    if (q.key) {
      const before = base.find((b) => b.key === q.key);
      if (!before) throw new HttpError(409, "unknown_question", "One of these questions is no longer on this role. Reload the page and try again.");
      if (seen.has(q.key)) throw new HttpError(400, "duplicate_question", "The same question is in the list twice.");
      seen.add(q.key);
      // A reworded question no longer has the model answer or the follow-up written for the old wording.
      if (before.question !== q.question) return { key: before.key, question: q.question, kind: q.kind ?? before.kind, ...(before.competencyKey ? { competencyKey: before.competencyKey } : {}) };
      return { ...before, kind: q.kind ?? before.kind };
    }
    return { key: keyFrom("q", q.question, taken), question: q.question, kind: q.kind ?? "skills" };
  });
}

function eligibilityRules(base: EligibilityRule[], sent: NonNullable<PacketFieldEdit["eligibility"]>): EligibilityRule[] {
  const taken = new Set(base.map((e) => e.key));
  const seen = new Set<string>();
  return sent.map((e) => {
    if (e.key) {
      const before = base.find((b) => b.key === e.key);
      if (!before) throw new HttpError(409, "unknown_question", "One of these questions is no longer on this role. Reload the page and try again.");
      if (seen.has(e.key)) throw new HttpError(400, "duplicate_question", "The same question is in the list twice.");
      seen.add(e.key);
      return { key: before.key, type: e.type, question: e.question, rationale: e.rationale, knockout: e.knockout ?? before.knockout, expectation: e.expectation ?? (e.type === before.type ? before.expectation : {}) };
    }
    return { key: keyFrom(e.type, e.question, taken), type: e.type, question: e.question, rationale: e.rationale, knockout: e.knockout ?? true, expectation: e.expectation ?? {} };
  });
}

const FIELD_LABEL: Record<string, string> = {
  title: "job title",
  locations: "place",
  employmentType: "job type",
  schedule: "schedule",
  remotePolicy: "work model",
  compensation: "pay",
  screeningQuestions: "screening questions",
  eligibility: "eligibility questions",
  dealBreakers: "deal-breakers",
  decisionMakerUserId: "decision maker",
  tone: "message tone",
};

/** The next packet with the sent fields applied, and the plain summary of what was edited ("Edited: job title, pay"). */
export function applyFieldEdit(base: RolePacket, edit: PacketFieldEdit, ctx: { team: TeamMember[]; actor: Actor; now: string }): { packet: RolePacket; summary: string; fields: string[]; notes: string[] } {
  const p = structuredClone(base);
  const fields: string[] = [];
  const notes: string[] = [];
  if (edit.title !== undefined) p.identity.title = edit.title;
  if (edit.locations !== undefined) p.identity.locations = edit.locations;
  if (edit.employmentType !== undefined) p.identity.employmentType = edit.employmentType;
  if (edit.remotePolicy !== undefined) p.identity.remotePolicy = edit.remotePolicy;
  if (edit.schedule !== undefined) {
    if (edit.schedule) p.identity.schedule = edit.schedule;
    else delete p.identity.schedule;
  }
  if (edit.compensation) {
    const c = edit.compensation;
    const basis = c.basis ?? p.compensation.basis;
    if (basis !== p.compensation.basis && (c.min === undefined || c.max === undefined)) throw new HttpError(400, "pay_basis_needs_range", "When you switch between hourly and a yearly salary, enter the new range too.");
    const min = c.min ?? p.compensation.min;
    const max = c.max ?? p.compensation.max;
    if (min > max) throw new HttpError(400, "pay_range_reversed", "The lowest pay is above the highest. Check the two figures.");
    const ceiling = c.ceiling ?? Math.max(p.compensation.ceiling, max);
    if (ceiling < max) throw new HttpError(400, "ceiling_below_range", `The private ceiling cannot be below the top of the range (${dollars(max)}).`);
    if (c.ceiling === undefined && ceiling !== p.compensation.ceiling) notes.push(`The private ceiling was raised to the top of the new range (${dollars(ceiling)}).`);
    const changed = basis !== p.compensation.basis || min !== p.compensation.min || max !== p.compensation.max || ceiling !== p.compensation.ceiling;
    p.compensation = { ...p.compensation, basis, min, max, ceiling, ...(p.compensation.mid !== undefined ? { mid: Math.round((min + max) / 2) } : {}) };
    if (changed) {
      // Pay a person typed in the editor counts as set by them, like the pay card (C7).
      p.compensation.sources = p.compensation.sources.map((s) => (s.name === "owner-stated" ? { ...s, detail: `${min}–${max} ${basis}` } : s));
      p.provenance.payConfirmedBy = { by: ctx.actor, at: ctx.now, via: "edited" };
      p.provenance.payOrigin = "edited";
    }
  }
  if (edit.screeningQuestions !== undefined) p.screening.questions = screeningQuestions(base.screening.questions, edit.screeningQuestions);
  if (edit.eligibility !== undefined) p.requirements.eligibility = eligibilityRules(base.requirements.eligibility, edit.eligibility);
  if (edit.dealBreakers !== undefined) {
    const kept: string[] = [];
    for (const d of edit.dealBreakers) if (!kept.some((k) => normalizeCriterion(k) === normalizeCriterion(d))) kept.push(d);
    p.preferences.dealBreakersInTheirWords = kept;
  }
  if (edit.decisionMakerUserId !== undefined) {
    if (edit.decisionMakerUserId === null) {
      delete p.preferences.decisionMakerUserId;
      delete p.preferences.decisionMakerName;
    } else {
      const who = ctx.team.find((m) => m.userId === edit.decisionMakerUserId);
      if (!who || !DECIDER_ROLES.includes(who.role)) throw new HttpError(400, "not_a_decider", "Choose someone on your team who can approve roles: an owner, an admin or a hiring manager.");
      p.preferences.decisionMakerUserId = who.userId;
      p.preferences.decisionMakerName = who.name;
    }
  }
  if (edit.tone !== undefined) p.communication.tone = edit.tone;
  for (const key of Object.keys(FIELD_LABEL)) {
    if ((edit as Record<string, unknown>)[key] === undefined) continue;
    if (JSON.stringify(sectionOf(key, base)) !== JSON.stringify(sectionOf(key, p))) fields.push(key);
  }
  return { packet: p, fields, notes, summary: fields.length ? `Edited: ${fields.map((f) => FIELD_LABEL[f]).join(", ")}` : "" };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* "Questions every applicant answers" (Wave S7)                                                                         */
/* ------------------------------------------------------------------------------------------------------------------ */

const sameWords = (a: string, b: string) => normalizeCriterion(a) === normalizeCriterion(b);

/** JSON with every object's keys in order: a stored packet's keys come back from the database in their own order. */
function stableJson(v: unknown): string {
  const sorted = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sorted);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, sorted(y)]));
    return x;
  };
  return JSON.stringify(sorted(v));
}

/**
 * The 422 every save path gives for a question that asks about a protected characteristic: the first one in plain words,
 * and every refused part in `details.problems` so the page can mark each row.
 */
export function refuseCompanyQuestions(cq: Parameters<typeof companyQuestionProblems>[0]): void {
  const problems = companyQuestionProblems(cq);
  if (!problems.length) return;
  const listed: CompanyQuestionRefusal[] = problems.map((p) => ({ ...p, words: companyQuestionProblemWords(p) }));
  const others = new Set(listed.filter((p) => p.list !== listed[0].list || p.index !== listed[0].index).map((p) => `${p.list}:${p.index}`)).size;
  throw new HttpError(422, "question_not_allowed", `${listed[0].words}${others ? ` ${others} more ${others === 1 ? "question needs" : "questions need"} the same change.` : ""} Nothing was saved.`, { problems: listed });
}

function quickQuestions(base: QuickQuestion[], sent: NonNullable<CompanyQuestionsEdit["quick"]>): QuickQuestion[] {
  if (sent.length > QUICK_QUESTIONS_MAX) throw new HttpError(400, "too_many_questions", `Keep at most ${QUICK_QUESTIONS_MAX} quick questions. This list has ${sent.length}.`);
  const taken = new Set(base.map((q) => q.key));
  const seen = new Set<string>();
  return sent.map((q, i) => {
    const n = i + 1;
    if (sent.some((o, j) => j < i && sameWords(o.question, q.question))) throw new HttpError(400, "duplicate_question", `Quick question ${n} is the same as an earlier one.`);
    let key: string;
    if (q.key) {
      if (!base.some((b) => b.key === q.key)) throw new HttpError(409, "unknown_question", "One of these questions is no longer on this job. Reload the page and try again.");
      if (seen.has(q.key)) throw new HttpError(400, "duplicate_question", "The same question is in the list twice.");
      key = q.key;
    } else key = keyFrom("cq", q.question, taken);
    seen.add(key);
    const help = q.help?.trim() ? { help: q.help.trim() } : {};
    if (q.kind === "choice") {
      const options: string[] = [];
      for (const o of q.options.map((x) => x.trim()).filter(Boolean)) if (!options.some((x) => sameWords(x, o))) options.push(o);
      if (options.length < CHOICE_OPTIONS_MIN || options.length > CHOICE_OPTIONS_MAX) throw new HttpError(400, "choice_options", `Quick question ${n} needs between ${CHOICE_OPTIONS_MIN} and ${CHOICE_OPTIONS_MAX} different answers to choose from. It has ${options.length}.`);
      return { kind: "choice", key, question: q.question, ...help, required: q.required ?? true, options };
    }
    if (q.min !== undefined && q.max !== undefined && q.min > q.max) throw new HttpError(400, "number_range", `Quick question ${n}: the smallest number allowed is above the largest.`);
    return { kind: "number", key, question: q.question, ...help, required: q.required ?? true, ...(q.unit?.trim() ? { unit: q.unit.trim() } : {}), ...(q.min !== undefined ? { min: q.min } : {}), ...(q.max !== undefined ? { max: q.max } : {}) };
  });
}

function writtenQuestions(base: WrittenQuestion[], sent: NonNullable<CompanyQuestionsEdit["written"]>): WrittenQuestion[] {
  if (sent.length > WRITTEN_QUESTIONS_MAX) throw new HttpError(400, "too_many_questions", `Keep at most ${WRITTEN_QUESTIONS_MAX} written questions. This list has ${sent.length}.`);
  const taken = new Set(base.map((q) => q.key));
  const seen = new Set<string>();
  return sent.map((q, i) => {
    if (sent.some((o, j) => j < i && sameWords(o.question, q.question))) throw new HttpError(400, "duplicate_question", `Written question ${i + 1} is the same as an earlier one.`);
    let key: string;
    if (q.key) {
      if (!base.some((b) => b.key === q.key)) throw new HttpError(409, "unknown_question", "One of these questions is no longer on this job. Reload the page and try again.");
      if (seen.has(q.key)) throw new HttpError(400, "duplicate_question", "The same question is in the list twice.");
      key = q.key;
    } else key = keyFrom("wq", q.question, taken);
    seen.add(key);
    return { key, question: q.question, required: q.required ?? true, ...(q.lookFor?.trim() ? { lookFor: q.lookFor.trim() } : {}) };
  });
}

/**
 * The next packet with the company's questions as sent (only the lists sent change), the lists that changed and the
 * plain summary ("Edited: quick questions, written questions"). Refused with plain words, before anything is saved, when
 * a list breaks the packet's limits, and with `question_not_allowed` when a question asks about a protected
 * characteristic. Wording the phrase list flags is saved with the flag, as everywhere: approval waits for a person.
 */
export function applyCompanyQuestionsEdit(base: RolePacket, edit: CompanyQuestionsEdit): { packet: RolePacket; summary: string; fields: Array<"quick" | "written"> } {
  refuseCompanyQuestions({ quick: edit.quick, written: edit.written });
  const p = structuredClone(base);
  const before: CompanyQuestions = { quick: base.companyQuestions?.quick ?? [], written: base.companyQuestions?.written ?? [] };
  const next: CompanyQuestions = {
    quick: edit.quick !== undefined ? quickQuestions(before.quick, edit.quick) : before.quick,
    written: edit.written !== undefined ? writtenQuestions(before.written, edit.written) : before.written,
  };
  if (next.quick.length || next.written.length) p.companyQuestions = next;
  else delete p.companyQuestions;
  const fields: Array<"quick" | "written"> = [];
  if (stableJson(before.quick) !== stableJson(next.quick)) fields.push("quick");
  if (stableJson(before.written) !== stableJson(next.written)) fields.push("written");
  const label = { quick: "quick questions", written: "written questions" } as const;
  return { packet: p, fields, summary: fields.length ? `Edited: ${fields.map((f) => label[f]).join(", ")}` : "" };
}

/** The part of the packet a field lives in, to tell whether an edit changed anything. */
function sectionOf(field: string, p: RolePacket): unknown {
  switch (field) {
    case "title": return p.identity.title;
    case "locations": return p.identity.locations;
    case "employmentType": return p.identity.employmentType;
    case "schedule": return p.identity.schedule ?? null;
    case "remotePolicy": return p.identity.remotePolicy;
    case "compensation": return [p.compensation.basis, p.compensation.min, p.compensation.max, p.compensation.ceiling];
    case "screeningQuestions": return p.screening.questions;
    case "eligibility": return p.requirements.eligibility;
    case "dealBreakers": return p.preferences.dealBreakersInTheirWords;
    case "decisionMakerUserId": return p.preferences.decisionMakerUserId ?? null;
    case "tone": return p.communication.tone;
    default: return null;
  }
}

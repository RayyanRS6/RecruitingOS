import {
  CHOICE_OPTIONS_MAX, CHOICE_OPTIONS_MIN, COMPETENCIES_MAX, FORM_QUESTIONS_MAX, MUST_HAVES_MAX, MUST_HAVES_MIN, SCREENING_QUESTIONS_MAX, SCREENING_QUESTIONS_MIN,
  type DraftFieldEdit, type DraftRolePacket, type FormQuestion, type PacketFieldEdit,
} from "@ros/contracts";
import { formQuestionProblems, normalizeCriterion } from "@ros/core";
import { HttpError } from "../middleware/errors";

/**
 * The one editor of a job: on a written draft in the job builder and on a job's page. The edit mirrors the job record's
 * sections; only what was sent changes. A list is sent whole, in order, and an item that keeps its key keeps what the
 * editor does not carry (a must-have's rationale, a skill's indicators, a question's kind). Anything that would break
 * the record's own limits is refused here in plain words, before anything is saved; the caller then saves the result
 * through the fairness guard.
 */

type Edit = DraftFieldEdit & Pick<PacketFieldEdit, "keepFlags">;

const sameWords = (a: string, b: string) => normalizeCriterion(a) === normalizeCriterion(b);

/** A key for a new item, from its words, unlike every key the list has or had. */
function keyFrom(prefix: string, words: string, taken: Set<string>): string {
  const stem = `${prefix}_${normalizeCriterion(words).replace(/ /g, "_").slice(0, 30).replace(/_+$/, "") || "item"}`;
  let key = stem;
  for (let n = 2; taken.has(key); n += 1) key = `${stem}_${n}`;
  taken.add(key);
  return key;
}

/**
 * A list as sent, each item matched to the one it was by its key. An item with no key is new; a key the list does not
 * have, or has twice, is refused; so is the same words twice.
 */
function matched<S extends { key?: string }, B extends { key: string }>(what: string, base: readonly B[], sent: readonly S[], words: (item: S) => string, prefix: string): Array<{ sent: S; before: B | null; key: string }> {
  const taken = new Set(base.map((b) => b.key));
  const seen = new Set<string>();
  return sent.map((item, i) => {
    if (sent.some((other, j) => j < i && sameWords(words(other), words(item)))) throw new HttpError(400, "duplicate_item", `${what} ${i + 1} is the same as an earlier one.`);
    if (!item.key) return { sent: item, before: null, key: keyFrom(prefix, words(item), taken) };
    const before = base.find((b) => b.key === item.key);
    if (!before) throw new HttpError(409, "unknown_item", "One of these items is no longer on this job. Reload the page and try again.");
    if (seen.has(item.key)) throw new HttpError(400, "duplicate_item", `${what} ${i + 1} is in the list twice.`);
    seen.add(item.key);
    return { sent: item, before, key: before.key };
  });
}

/** An optional text as the record keeps it: what was sent, nothing when it was emptied, what it was when it was not sent. */
function optionalText(sent: string | undefined, before: string | undefined): string | undefined {
  return sent === undefined ? before : sent.trim() || undefined;
}

/**
 * The 422 for a form question that asks about a protected characteristic: the first one in plain words, and every
 * refused part in `details.problems` so the page can mark each row. Such a question is never saved with a flag to keep.
 */
export function refuseFormQuestions(questions: Parameters<typeof formQuestionProblems>[0]): void {
  const problems = formQuestionProblems(questions);
  if (!problems.length) return;
  const others = new Set(problems.filter((p) => p.index !== problems[0].index).map((p) => p.index)).size;
  throw new HttpError(422, "question_not_allowed", `${problems[0].words}${others ? ` ${others} more ${others === 1 ? "question needs" : "questions need"} the same change.` : ""} Nothing was saved.`, { problems });
}

function formQuestions(base: readonly FormQuestion[], sent: NonNullable<Edit["formQuestions"]>): FormQuestion[] {
  if (sent.length > FORM_QUESTIONS_MAX) throw new HttpError(400, "too_many_questions", `Keep at most ${FORM_QUESTIONS_MAX} screening questions. This list has ${sent.length}.`);
  refuseFormQuestions(sent);
  return matched("Screening question", base, sent, (q) => q.question, "fq").map(({ sent: q, before, key }, i): FormQuestion => {
    const help = optionalText(q.help, before?.help);
    const common = { key, question: q.question, ...(help ? { help } : {}), required: q.required ?? before?.required ?? true };
    if (q.kind === "yes_no") return { kind: "yes_no", ...common };
    if (q.kind === "choice") {
      const options: string[] = [];
      for (const o of q.options) if (!options.some((x) => sameWords(x, o))) options.push(o);
      if (options.length < CHOICE_OPTIONS_MIN || options.length > CHOICE_OPTIONS_MAX) throw new HttpError(400, "choice_options", `Screening question ${i + 1} needs between ${CHOICE_OPTIONS_MIN} and ${CHOICE_OPTIONS_MAX} different answers to choose from. It has ${options.length}.`);
      return { kind: "choice", ...common, options };
    }
    if (q.min !== undefined && q.max !== undefined && q.min > q.max) throw new HttpError(400, "number_range", `Screening question ${i + 1}: the smallest number allowed is above the largest.`);
    const unit = optionalText(q.unit, before?.kind === "number" ? before.unit : undefined);
    return { kind: "number", ...common, ...(unit ? { unit } : {}), ...(q.min !== undefined ? { min: q.min } : {}), ...(q.max !== undefined ? { max: q.max } : {}) };
  });
}

const SECTION_LABEL = {
  identity: "the job's facts",
  compensation: "pay",
  description: "the job description",
  requirements: "requirements",
  competencies: "skills",
  screening: "the AI interview's questions",
  formQuestions: "screening questions",
} as const;
type Section = keyof typeof SECTION_LABEL;

/** JSON with every object's keys in order: a stored record's keys come back from the database in their own order. */
function stableJson(v: unknown): string {
  const sorted = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sorted);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, sorted(y)]));
    return x;
  };
  return JSON.stringify(sorted(v));
}

const sectionOf = (p: DraftRolePacket, s: Section): unknown => (s === "description" ? p.description.publicJobDescription : p[s]);

/**
 * The job with the sent fields applied: the sections that changed, a plain summary of them ("Edited: pay, skills"), and
 * the flagged phrases the person asked to keep, marked for the fairness guard, which stamps who kept them.
 */
export function applyFieldEdit<T extends DraftRolePacket>(base: T, edit: Edit): { packet: T; fields: Section[]; summary: string } {
  const p = structuredClone(base);
  if (edit.identity) {
    const id = edit.identity;
    if (id.title !== undefined) p.identity.title = id.title;
    if (id.locations !== undefined) p.identity.locations = id.locations;
    if (id.employmentType !== undefined) p.identity.employmentType = id.employmentType;
    if (id.remotePolicy !== undefined) p.identity.remotePolicy = id.remotePolicy;
    if (id.department !== undefined) {
      if (id.department) p.identity.department = id.department;
      else delete p.identity.department;
    }
    if (id.schedule !== undefined) {
      if (id.schedule) p.identity.schedule = id.schedule;
      else delete p.identity.schedule;
    }
  }
  if (edit.compensation) {
    const c = edit.compensation;
    const before = p.compensation;
    const basis = c.basis ?? before?.basis;
    const min = c.min ?? before?.min;
    const max = c.max ?? before?.max;
    if (basis === undefined || min === undefined || max === undefined) throw new HttpError(400, "pay_incomplete", "Set hourly or salary and both ends of the range.");
    if (before && basis !== before.basis && (c.min === undefined || c.max === undefined)) throw new HttpError(400, "pay_basis_needs_range", "When you switch between hourly and a yearly salary, enter the new range too.");
    if (min > max) throw new HttpError(400, "pay_range_reversed", "The lowest pay is above the highest. Check the two figures.");
    const benefits = c.benefitsSummary === undefined ? before?.benefitsSummary : c.benefitsSummary?.trim() || undefined;
    p.compensation = { basis, currency: before?.currency ?? "USD", min, max, ...(benefits ? { benefitsSummary: benefits } : {}), discloseRange: c.discloseRange ?? before?.discloseRange ?? true };
  }
  if (edit.description !== undefined) p.description.publicJobDescription = edit.description;
  if (edit.requirements?.mustHaves !== undefined) {
    const sent = edit.requirements.mustHaves;
    if (sent.length < MUST_HAVES_MIN || sent.length > MUST_HAVES_MAX) throw new HttpError(400, "must_haves_count", `A job needs between ${MUST_HAVES_MIN} and ${MUST_HAVES_MAX} must-haves. This list has ${sent.length}.`);
    p.requirements.mustHaves = matched("Must-have", base.requirements.mustHaves, sent, (m) => m.text, "mh").map(({ sent: m, before, key }) => ({ ...before, key, text: m.text }));
  }
  if (edit.requirements?.niceToHaves !== undefined) {
    const sent = edit.requirements.niceToHaves;
    if (sent.length > 10) throw new HttpError(400, "nice_to_haves_count", `Keep at most 10 nice-to-haves. This list has ${sent.length}.`);
    p.requirements.niceToHaves = matched("Nice-to-have", base.requirements.niceToHaves, sent, (m) => m.text, "nh").map(({ sent: m, before, key }) => ({ ...before, key, text: m.text }));
  }
  if (edit.competencies !== undefined) {
    if (edit.competencies.length > COMPETENCIES_MAX) throw new HttpError(400, "skills_count", `Keep at most ${COMPETENCIES_MAX} skills. This list has ${edit.competencies.length}.`);
    p.competencies = matched("Skill", base.competencies, edit.competencies, (c) => c.name, "skill").map(({ sent: c, before, key }) => ({ key, name: c.name, definition: optionalText(c.definition, before?.definition) ?? "", importance: c.importance, indicators: before?.indicators ?? [] }));
  }
  if (edit.screening?.questions !== undefined) {
    const sent = edit.screening.questions;
    if (sent.length < SCREENING_QUESTIONS_MIN || sent.length > SCREENING_QUESTIONS_MAX) throw new HttpError(400, "interview_questions_count", `The AI interview needs between ${SCREENING_QUESTIONS_MIN} and ${SCREENING_QUESTIONS_MAX} questions. This list has ${sent.length}.`);
    p.screening.questions = matched("AI interview question", base.screening.questions, sent, (q) => q.question, "q").map(({ sent: q, before, key }) => {
      const modelAnswer = optionalText(q.modelAnswer, before?.modelAnswer);
      return { key, question: q.question, kind: before?.kind ?? "skills", ...(modelAnswer ? { modelAnswer } : {}) };
    });
  }
  if (edit.screening?.maxMinutes !== undefined) p.screening.maxMinutes = edit.screening.maxMinutes;
  if (edit.formQuestions !== undefined) p.formQuestions = formQuestions(base.formQuestions, edit.formQuestions);
  if (edit.keepFlags?.length) {
    // The guard matches a request to keep by the flag's id, on the flags it finds in the job as edited.
    const flags = p.provenance.flags ?? [];
    for (const keep of edit.keepFlags) {
      const flag = flags.find((f) => f.id === keep.flagId);
      if (flag) flag.keepReason = keep.reason;
      else flags.push({ id: keep.flagId, path: "", rule: "", text: "", reason: "", keepReason: keep.reason });
    }
    p.provenance.flags = flags;
  }
  const fields = (Object.keys(SECTION_LABEL) as Section[]).filter((s) => stableJson(sectionOf(base, s)) !== stableJson(sectionOf(p, s)));
  return { packet: p, fields, summary: fields.length ? `Edited: ${fields.map((f) => SECTION_LABEL[f]).join(", ")}` : "" };
}

import {
  CHOICE_OPTIONS_MAX, CHOICE_OPTIONS_MIN, COMPETENCIES_MAX, FORM_QUESTIONS_MAX, MUST_HAVES_MAX, MUST_HAVES_MIN, SCREENING_QUESTIONS_MAX, SCREENING_QUESTIONS_MIN,
  type DraftFieldEdit, type DraftRolePacket, type FormQuestion, type PacketFieldEdit, type Requirement,
} from "@ros/contracts";
import { formQuestionProblems, normalizeCriterion, screeningKindFor } from "@ros/core";
import { HttpError } from "../middleware/errors";

/**
 * The one editor of a job: on a written draft in the job builder and on a job's page. The edit mirrors the job record's
 * sections; only what was sent changes. A list is sent whole, in order, and an item matched by its key is the same item.
 *
 * Three parts of an item are neither shown nor carried by the editor, and each was written for the item's words by the
 * model that wrote the job: why a must-have or a nice-to-have matters (`rationale`), what shows a skill (`indicators`),
 * and an AI interview question's `kind`. An item sent back with the words it had keeps its part. One whose words
 * changed does not keep what was written for the old words: the rationale and the indicators go (a skill's words are
 * its name and its meaning), and the kind is worked out again from the new words (`screeningKindFor`), as it is for a
 * question that is new.
 *
 * Anything that would break the record's own limits is refused here in plain words, before anything is saved; the
 * caller then saves the result through the fairness guard.
 */

type Edit = DraftFieldEdit & Pick<PacketFieldEdit, "keepFlags">;

const sameWords = (a: string, b: string) => normalizeCriterion(a) === normalizeCriterion(b);

/** The words as they were, spacing aside (the editor trims what it sends): the item was sent back untouched. */
const untouched = (now: string, before: string | null | undefined): boolean => typeof before === "string" && now.replace(/\s+/g, " ").trim() === before.replace(/\s+/g, " ").trim();

/**
 * A must-have or a nice-to-have as edited. Why it matters (`rationale`, which the resume reading is given beside a
 * must-have) was written for the words it had, so it stays only while the words do.
 */
function requirement(text: string, before: Requirement | null, key: string): Requirement {
  return before && untouched(text, before.text) ? { ...before, key, text } : { key, text };
}

/** `stem`, or `stem` with a short number after it ("_2", "_3"…), unlike every key the list has or had. */
function freeKey(stem: string, taken: Set<string>): string {
  let key = stem;
  for (let n = 2; taken.has(key); n += 1) key = `${stem}_${n}`;
  taken.add(key);
  return key;
}

/** A key for a new item, from its words, unlike every key the list has or had. */
function keyFrom(prefix: string, words: string, taken: Set<string>): string {
  return freeKey(`${prefix}_${normalizeCriterion(words).replace(/ /g, "_").slice(0, 30).replace(/_+$/, "") || "item"}`, taken);
}

/**
 * A list as sent, each item matched to the one it was by its key, and every item left with a key no other item of the
 * list has: a stored reading's findings, and a form's answers, are matched to these items by key. An item with no key is
 * new and gets one from its words. A key the list does not have is refused; so is a key sent more often than the list
 * holds it, and the same words twice.
 *
 * A record saved before keys were held unique may hold one key twice. It is not refused for that (nobody could fix it:
 * the editor shows no keys): the first item sent under the key is the first the record has under it and keeps the key,
 * which stored readings point at; each later one is the record's next and gets a key of its own. Saved once, the list
 * is like any other. The fairness guard does the same for the lists an edit did not send (`uniqueKeys` in packages/core).
 */
function matched<S extends { key?: string }, B extends { key: string }>(what: string, base: readonly B[], sent: readonly S[], words: (item: S) => string, prefix: string): Array<{ sent: S; before: B | null; key: string }> {
  const taken = new Set(base.map((b) => b.key));
  /** How many items sent so far carried each key. */
  const sentUnder = new Map<string, number>();
  return sent.map((item, i) => {
    if (sent.some((other, j) => j < i && sameWords(words(other), words(item)))) throw new HttpError(400, "duplicate_item", `${what} ${i + 1} is the same as an earlier one.`);
    if (!item.key) return { sent: item, before: null, key: keyFrom(prefix, words(item), taken) };
    const held = base.filter((b) => b.key === item.key);
    if (!held.length) throw new HttpError(409, "unknown_item", "One of these items is no longer on this job. Reload the page and try again.");
    const nth = sentUnder.get(item.key) ?? 0;
    sentUnder.set(item.key, nth + 1);
    const before = held[nth];
    if (!before) throw new HttpError(400, "duplicate_item", `${what} ${i + 1} is in the list twice.`);
    return { sent: item, before, key: nth === 0 ? before.key : freeKey(before.key, taken) };
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
    p.requirements.mustHaves = matched("Must-have", base.requirements.mustHaves, sent, (m) => m.text, "mh").map(({ sent: m, before, key }) => requirement(m.text, before, key));
  }
  if (edit.requirements?.niceToHaves !== undefined) {
    const sent = edit.requirements.niceToHaves;
    if (sent.length > 10) throw new HttpError(400, "nice_to_haves_count", `Keep at most 10 nice-to-haves. This list has ${sent.length}.`);
    p.requirements.niceToHaves = matched("Nice-to-have", base.requirements.niceToHaves, sent, (m) => m.text, "nh").map(({ sent: m, before, key }) => requirement(m.text, before, key));
  }
  if (edit.competencies !== undefined) {
    if (edit.competencies.length > COMPETENCIES_MAX) throw new HttpError(400, "skills_count", `Keep at most ${COMPETENCIES_MAX} skills. This list has ${edit.competencies.length}.`);
    p.competencies = matched("Skill", base.competencies, edit.competencies, (c) => c.name, "skill").map(({ sent: c, before, key }) => {
      const definition = optionalText(c.definition, before?.definition) ?? "";
      // What shows the skill (`indicators`, which the resume reading is given) was written for the name and the meaning
      // it had: it stays only while both do. A change of importance alone changes neither.
      const same = !!before && untouched(c.name, before.name) && untouched(definition, before.definition ?? "");
      return { key, name: c.name, definition, importance: c.importance, indicators: same ? before.indicators ?? [] : [] };
    });
  }
  if (edit.screening?.questions !== undefined) {
    const sent = edit.screening.questions;
    if (sent.length < SCREENING_QUESTIONS_MIN || sent.length > SCREENING_QUESTIONS_MAX) throw new HttpError(400, "interview_questions_count", `The AI interview needs between ${SCREENING_QUESTIONS_MIN} and ${SCREENING_QUESTIONS_MAX} questions. This list has ${sent.length}.`);
    p.screening.questions = matched("AI interview question", base.screening.questions, sent, (q) => q.question, "q").map(({ sent: q, before, key }) => {
      const modelAnswer = optionalText(q.modelAnswer, before?.modelAnswer);
      // An untouched question keeps its kind. One that is new, or whose words changed, gets the kind its words ask for:
      // a question that can only be answered yes or no offers Yes and No and takes "No" as its answer.
      const kind = before && untouched(q.question, before.question) ? before.kind ?? "skills" : screeningKindFor(q.question, before?.kind);
      return { key, question: q.question, kind, ...(modelAnswer ? { modelAnswer } : {}) };
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

import {
  CHOICE_OPTIONS_MAX, CHOICE_OPTIONS_MIN, COMPETENCIES_MAX, FORM_QUESTIONS_MAX, MUST_HAVES_MAX, MUST_HAVES_MIN, SCREENING_QUESTIONS_MAX, SCREENING_QUESTIONS_MIN,
  type CompensationBasis, type DraftFieldEdit, type DraftRolePacket, type EmploymentType, type FormQuestionKind, type FormQuestionRefusal, type Importance,
  type KeepPacketFlag, type Location, type PacketFlag, type RemotePolicy, type RolePacket,
} from "@ros/contracts";
import { parseAmount, payProblem } from "./builder";

/**
 * The one editor of a job (pages/job/JobEditor.tsx), on a published job and on a written draft alike: the record as the
 * form holds it, the first thing wrong with it in plain words, and the edit a save sends, which carries only the parts
 * that changed (a list is sent whole, in order; an item that was there keeps its key). Pure, so tests/web/job-editor.test.ts
 * can check it. The server has the last word on every rule (counts, wording, the form's questions) and says so in plain
 * words; the checks here only say the obvious before anything is sent.
 */

/** One place: the city and state the form shows, and the rest of the stored place, which a save keeps as it was. */
export type PlaceRow = { city: string; region: string; rest: Omit<Location, "city" | "region"> };
/** A must-have or a nice-to-have. A row that was there keeps its `key`; a new one has none. */
export type TextRow = { key: string | null; text: string };
export type SkillRow = { key: string | null; name: string; importance: Importance; definition: string };
export type InterviewRow = { key: string | null; question: string; modelAnswer: string };
/** A screening question on the application form. `options`: one choice per line; `unit`, `min`, `max`: for a number. */
export type FormRow = { key: string | null; kind: FormQuestionKind; question: string; help: string; required: boolean; options: string; unit: string; min: string; max: string };

export type JobForm = {
  title: string;
  department: string;
  places: PlaceRow[];
  employmentType: EmploymentType;
  schedule: string;
  remotePolicy: RemotePolicy;
  basis: CompensationBasis | "";
  payMin: string;
  payMax: string;
  showPay: boolean;
  benefits: string;
  description: string;
  mustHaves: TextRow[];
  niceToHaves: TextRow[];
  skills: SkillRow[];
  interview: InterviewRow[];
  minutes: string;
  formQuestions: FormRow[];
};

type Packet = RolePacket | DraftRolePacket;

const num = (n: number | undefined) => (n === undefined ? "" : String(n));

/** The form as it opens on a record. A draft with no pay yet opens with the pay boxes empty. */
export function jobFormFrom(p: Packet): JobForm {
  const c = p.compensation;
  return {
    title: p.identity.title,
    department: p.identity.department ?? "",
    places: p.identity.locations.length ? p.identity.locations.map(({ city, region, ...rest }) => ({ city: city ?? "", region: region ?? "", rest })) : [newPlace()],
    employmentType: p.identity.employmentType,
    schedule: p.identity.schedule ?? "",
    remotePolicy: p.identity.remotePolicy,
    basis: c?.basis ?? "",
    payMin: num(c?.min),
    payMax: num(c?.max),
    showPay: c?.discloseRange ?? true,
    benefits: c?.benefitsSummary ?? "",
    description: p.description.publicJobDescription,
    mustHaves: p.requirements.mustHaves.map((m) => ({ key: m.key, text: m.text })),
    niceToHaves: p.requirements.niceToHaves.map((m) => ({ key: m.key, text: m.text })),
    skills: p.competencies.map((s) => ({ key: s.key, name: s.name, importance: s.importance, definition: s.definition })),
    interview: p.screening.questions.map((q) => ({ key: q.key, question: q.question, modelAnswer: q.modelAnswer ?? "" })),
    minutes: String(p.screening.maxMinutes),
    formQuestions: p.formQuestions.map((q) => ({
      key: q.key,
      kind: q.kind,
      question: q.question,
      help: q.help ?? "",
      required: q.required,
      options: q.kind === "choice" ? q.options.join("\n") : "",
      unit: q.kind === "number" ? q.unit ?? "" : "",
      min: q.kind === "number" ? num(q.min) : "",
      max: q.kind === "number" ? num(q.max) : "",
    })),
  };
}

export const newPlace = (): PlaceRow => ({ city: "", region: "", rest: { country: "US" } });
export const newTextRow = (): TextRow => ({ key: null, text: "" });
export const newSkill = (): SkillRow => ({ key: null, name: "", importance: "important", definition: "" });
export const newInterviewRow = (): InterviewRow => ({ key: null, question: "", modelAnswer: "" });
export const newFormRow = (): FormRow => ({ key: null, kind: "yes_no", question: "", help: "", required: true, options: "", unit: "", min: "", max: "" });

/** Moves a row up (-1) or down (+1), staying inside the list. */
export function moveRow<T>(rows: readonly T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= rows.length) return [...rows];
  const out = [...rows];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The choices of a choice question, one per line as typed, without the empty lines. */
export function choicesOf(row: Pick<FormRow, "options">): string[] {
  return row.options.split("\n").map((o) => o.trim()).filter(Boolean);
}

const filled = <T,>(rows: readonly T[], words: (row: T) => string): T[] => rows.filter((r) => words(r).trim());
const payTyped = (f: JobForm) => !!(f.basis || f.payMin.trim() || f.payMax.trim());

/** The first thing in the form that cannot be saved, in plain words, or null. Empty rows are simply left out of a save. */
export function jobFormProblem(f: JobForm): string | null {
  if (f.title.trim().length < 2) return "Give the job a title.";
  if (!f.places.some((p) => p.city.trim() || p.region.trim())) return "Say where the job is: a city or a state.";
  if (payTyped(f)) {
    const pay = payProblem({ basis: f.basis, min: f.payMin, max: f.payMax });
    if (pay) return pay;
  }
  if (f.description.trim().length < 50) return "The job description needs at least 50 characters.";
  const mustHaves = filled(f.mustHaves, (r) => r.text).length;
  if (mustHaves < MUST_HAVES_MIN) return "Keep at least one must-have.";
  if (mustHaves > MUST_HAVES_MAX) return `At most ${MUST_HAVES_MAX} must-haves.`;
  if (filled(f.skills, (r) => r.name).length > COMPETENCIES_MAX) return `At most ${COMPETENCIES_MAX} skills.`;
  const asked = filled(f.interview, (r) => r.question).length;
  if (asked < SCREENING_QUESTIONS_MIN || asked > SCREENING_QUESTIONS_MAX) return `The AI interview needs ${SCREENING_QUESTIONS_MIN} to ${SCREENING_QUESTIONS_MAX} questions.`;
  const minutes = Number(f.minutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 30) return "The AI interview's length is a whole number of minutes, 5 to 30.";
  const form = filled(f.formQuestions, (r) => r.question);
  if (form.length > FORM_QUESTIONS_MAX) return `At most ${FORM_QUESTIONS_MAX} screening questions.`;
  for (const q of form) {
    if (q.question.trim().length < 3) return "Write each screening question in full.";
    if (q.kind === "choice") {
      const n = choicesOf(q).length;
      if (n < CHOICE_OPTIONS_MIN || n > CHOICE_OPTIONS_MAX) return `A choice question needs ${CHOICE_OPTIONS_MIN} to ${CHOICE_OPTIONS_MAX} choices: "${q.question.trim()}".`;
    }
    if (q.kind === "number" && [q.min, q.max].some((v) => v.trim() && !Number.isFinite(Number(v)))) return `The lowest and highest answer must be numbers: "${q.question.trim()}".`;
  }
  return null;
}

const keyOf = (key: string | null) => (key ? { key } : {});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Every part of the record as an edit would carry it, built from the form. */
function parts(f: JobForm) {
  const optionalNumber = (v: string) => (v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return {
    identity: {
      title: f.title.trim(),
      department: f.department.trim() || null,
      locations: f.places.filter((p) => p.city.trim() || p.region.trim()).map((p): Location => ({ ...p.rest, ...(p.city.trim() ? { city: p.city.trim() } : {}), ...(p.region.trim() ? { region: p.region.trim().toUpperCase() } : {}) })),
      employmentType: f.employmentType,
      schedule: f.schedule.trim() || null,
      remotePolicy: f.remotePolicy,
    },
    compensation: {
      basis: f.basis || undefined,
      min: payTyped(f) ? parseAmount(f.payMin) : undefined,
      max: payTyped(f) ? parseAmount(f.payMax) : undefined,
      discloseRange: f.showPay,
      benefitsSummary: f.benefits.trim() || null,
    },
    description: f.description.trim(),
    mustHaves: filled(f.mustHaves, (r) => r.text).map((r) => ({ ...keyOf(r.key), text: r.text.trim() })),
    niceToHaves: filled(f.niceToHaves, (r) => r.text).map((r) => ({ ...keyOf(r.key), text: r.text.trim() })),
    competencies: filled(f.skills, (r) => r.name).map((r) => ({ ...keyOf(r.key), name: r.name.trim(), importance: r.importance, definition: r.definition.trim() })),
    questions: filled(f.interview, (r) => r.question).map((r) => ({ ...keyOf(r.key), question: r.question.trim(), modelAnswer: r.modelAnswer.trim() })),
    maxMinutes: Number(f.minutes),
    formQuestions: filled(f.formQuestions, (r) => r.question).map((r) => {
      const words = { ...keyOf(r.key), question: r.question.trim(), help: r.help.trim(), required: r.required };
      if (r.kind === "choice") return { kind: r.kind, ...words, options: choicesOf(r) };
      if (r.kind === "number") return { kind: r.kind, ...words, unit: r.unit.trim(), min: optionalNumber(r.min), max: optionalNumber(r.max) };
      return { kind: r.kind, ...words };
    }),
  };
}

/** The fields of `now` that differ from `before`, or undefined when none does. */
function changed<T extends Record<string, unknown>>(before: T, now: T): Partial<T> | undefined {
  const out: Partial<T> = {};
  for (const k of Object.keys(now) as Array<keyof T>) if (now[k] !== undefined && !same(before[k], now[k])) out[k] = now[k];
  return Object.keys(out).length ? out : undefined;
}

/**
 * The edit a save sends: only the parts of the form that differ from the form as it opened (`base`). Nothing changed
 * gives an empty edit, which is not sent. Pay typed here is sent whole (how it is paid, the lowest and the highest), so
 * the three always travel together.
 */
export function jobEdit(base: JobForm, form: JobForm): DraftFieldEdit {
  const [b, n] = [parts(base), parts(form)];
  const edit: DraftFieldEdit = {};
  const identity = changed(b.identity, n.identity);
  if (identity) edit.identity = identity;
  const compensation = changed(b.compensation, n.compensation);
  if (compensation) {
    const payChanged = "basis" in compensation || "min" in compensation || "max" in compensation;
    edit.compensation = payChanged && n.compensation.basis ? { ...compensation, basis: n.compensation.basis, min: n.compensation.min, max: n.compensation.max } : compensation;
  }
  if (b.description !== n.description) edit.description = n.description;
  const requirements = changed({ mustHaves: b.mustHaves, niceToHaves: b.niceToHaves }, { mustHaves: n.mustHaves, niceToHaves: n.niceToHaves });
  if (requirements) edit.requirements = requirements;
  if (!same(b.competencies, n.competencies)) edit.competencies = n.competencies;
  const screening = changed({ questions: b.questions, maxMinutes: b.maxMinutes }, { questions: n.questions, maxMinutes: n.maxMinutes });
  if (screening) edit.screening = screening;
  if (!same(b.formQuestions, n.formQuestions)) edit.formQuestions = n.formQuestions;
  return edit;
}

/** Whether an edit carries anything to save. */
export function hasChanges(edit: DraftFieldEdit): boolean {
  return Object.keys(edit).length > 0;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* What the server may answer to a save                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** The wording flags that hold something until each is reworded or kept with a reason: the ones nobody has kept. */
export function openFlags(flags: readonly PacketFlag[] | null | undefined): PacketFlag[] {
  return (flags ?? []).filter((f) => !f.kept);
}

/** The flags a refused save lists (422 `packet_flags`); none for any other failure. */
export function flagsOf(err: unknown): PacketFlag[] {
  const e = err as { code?: unknown; details?: { flags?: unknown } } | null | undefined;
  return e?.code === "packet_flags" && Array.isArray(e.details?.flags) ? (e.details.flags as PacketFlag[]) : [];
}

/** The parts of the form's questions a refused save names (422 `question_not_allowed`); none for any other failure. */
export function questionRefusalsOf(err: unknown): FormQuestionRefusal[] {
  const e = err as { code?: unknown; details?: { problems?: unknown } } | null | undefined;
  return e?.code === "question_not_allowed" && Array.isArray(e.details?.problems) ? (e.details.problems as FormQuestionRefusal[]) : [];
}

/** A reason to keep a flagged phrase needs five characters or more (the API's rule). */
export const KEEP_REASON_MIN = 5;

/** The flags to keep, with the reasons typed for them; a reason too short to send is left out. */
export function keepFlagsOf(reasons: Readonly<Record<string, string>>): KeepPacketFlag[] {
  return Object.entries(reasons).filter(([, reason]) => reason.trim().length >= KEEP_REASON_MIN).map(([flagId, reason]) => ({ flagId, reason: reason.trim() }));
}

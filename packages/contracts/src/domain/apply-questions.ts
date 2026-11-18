import { z } from "zod";

/* ------------------------------------------------------------------------------------------------------------ */
/* (a) The application form's questions, on the job record (`RolePacket.formQuestions`)                          */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The questions the application form asks, called "Screening questions" on the company's screens: basic questions about
 * the job, like LinkedIn Easy Apply, answered with one tap or a number. One list, three kinds. They are never the AI
 * interview's questions (`RolePacket.screening.questions`), and nothing about them is asked or written by AI while a
 * person applies.
 *
 * No answer ever holds or declines anyone. A "No" to a yes/no question is a flag on the person's row and panel
 * ("Answered No: <question>"), and every answer is given to the CV reading as evidence. Every question passes the
 * fairness check before it is saved: one that asks about a protected characteristic is refused.
 */
export const FormQuestionKey = z.string().trim().min(1).max(100);

const FormQuestionBase = {
  key: FormQuestionKey,
  question: z.string().trim().min(1).max(500),
  /** One plain line under the question; shown to candidates. */
  help: z.string().trim().max(300).optional(),
  required: z.boolean().default(true),
};

export const YesNoQuestion = z.object({ kind: z.literal("yes_no"), ...FormQuestionBase });
export const ChoiceQuestion = z.object({ kind: z.literal("choice"), ...FormQuestionBase, options: z.array(z.string().trim().min(1).max(80)).min(2).max(8) });
export const NumberQuestion = z.object({
  kind: z.literal("number"),
  ...FormQuestionBase,
  /** The unit said beside the box ("an hour", "years"). */
  unit: z.string().trim().max(30).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export const FormQuestion = z.discriminatedUnion("kind", [YesNoQuestion, ChoiceQuestion, NumberQuestion]);
export type FormQuestion = z.infer<typeof FormQuestion>;
export type FormQuestionKind = FormQuestion["kind"];
export const FORM_QUESTION_KIND_LABEL: Record<FormQuestionKind, string> = { yes_no: "Yes or no", choice: "Choice", number: "Number" };

/** The most questions a person may put on a job's form, and the choices one may offer. An older job version may hold more. */
export const FORM_QUESTIONS_MAX = 10;
export const CHOICE_OPTIONS_MIN = 2;
export const CHOICE_OPTIONS_MAX = 8;

/**
 * The answers a candidate sent with the form, by question key: "yes" or "no", the chosen option's words, or the number
 * as typed.
 */
export const FormAnswers = z.record(z.string().max(100), z.string().max(200));
export type FormAnswers = z.infer<typeof FormAnswers>;

/** One screening answer as the team reads it. `flag`: "Answered No: <question>", set only for a "No" to a yes/no question. */
export type FormAnswerView = { key: string; question: string; kind: FormQuestionKind; answer: string | null; flagged: boolean; flag: string | null };

const yesNoOf = (raw: unknown): boolean | null => {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (["yes", "y", "true", "1"].includes(s)) return true;
  if (["no", "n", "false", "0"].includes(s)) return false;
  return null;
};

const wordsOf = (raw: unknown): string | null => {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean).join(", ") || null;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
};

/**
 * One question with the answer the candidate gave, in words. A "No" to a yes/no question is flagged and nothing else is:
 * the flag is for a person to read, and it never moves, holds or declines anyone. An answer stored by an older form (a
 * list of days) is shown as its words.
 */
export function formAnswerView(question: FormQuestion, raw: unknown): FormAnswerView {
  const base = { key: question.key, question: question.question, kind: question.kind };
  if (question.kind === "yes_no") {
    const said = yesNoOf(raw);
    if (said === null) return { ...base, answer: wordsOf(raw), flagged: false, flag: null };
    return { ...base, answer: said ? "Yes" : "No", flagged: !said, flag: said ? null : `Answered No: ${question.question}` };
  }
  const words = wordsOf(raw);
  const answer = words !== null && question.kind === "number" && question.unit ? `${words} ${question.unit}` : words;
  return { ...base, answer, flagged: false, flag: null };
}

/** Every question of the form with its answer, in the form's order. */
export function formAnswerViews(questions: readonly FormQuestion[], answers: Readonly<Record<string, unknown>> | null | undefined): FormAnswerView[] {
  return questions.map((q) => formAnswerView(q, answers?.[q.key]));
}

/**
 * The form's questions of a job version stored before there was one list: its yes/no questions
 * (`requirements.eligibility`: key, question, and the reason shown as the help line) followed by the choice and number
 * questions the company added (`companyQuestions.quick`). A question that asked for days of the week becomes a yes/no
 * question that need not be answered. The parser of the job record calls this, so an older version keeps its form.
 */
export function formQuestionsOfStored(packet: Record<string, unknown>): unknown[] {
  const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
  const rules = list((packet.requirements as { eligibility?: unknown } | null | undefined)?.eligibility);
  const quick = list((packet.companyQuestions as { quick?: unknown } | null | undefined)?.quick);
  const yesNo = rules.flatMap((rule) => {
    if (typeof rule.key !== "string" || !rule.key.trim() || typeof rule.question !== "string" || !rule.question.trim()) return [];
    const days = (rule.expectation as { days?: unknown } | null | undefined)?.days;
    const asksDays = rule.type === "schedule_availability" && Array.isArray(days) && days.length > 0;
    const help = typeof rule.rationale === "string" && rule.rationale.trim() ? rule.rationale.trim().slice(0, 300) : undefined;
    return [{ kind: "yes_no", key: rule.key, question: rule.question, ...(help ? { help } : {}), required: !asksDays }];
  });
  return [...yesNo, ...quick];
}

/* ------------------------------------------------------------------------------------------------------------ */
/* (b) The AI interview's plan and its counter (`ScreenProgress.chat`)                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The AI interview's sections: the job's own interview questions ("required"), the must-haves the CV reading did not
 * find shown ("experience"), the close. The order they are asked in is the plan's, built in code when the chat starts.
 */
export const ChatSection = z.enum(["experience", "required", "wrapping_up"]);
export type ChatSection = z.infer<typeof ChatSection>;
export const CHAT_SECTION_LABEL: Readonly<Record<ChatSection, string>> = { experience: "About your experience", required: "Required questions", wrapping_up: "Wrapping up" };

/**
 * Where one item of the plan stands. `open`: not asked yet; `asking`: being asked now; `covered`: a concrete answer or
 * example arrived; `unknown`: settled as not known ("No", "I haven't": never a "no" for a skill); `skipped`: the
 * candidate pressed Skip.
 */
export const ChatItemState = z.enum(["open", "asking", "covered", "unknown", "skipped"]);
export type ChatItemState = z.infer<typeof ChatItemState>;

/**
 * One thing the chat must close. `question`: one of the job's interview questions (key = the question's key); only
 * these count toward "N of M required", and only when `required`. `gap`: a must-have the CV reading did not find shown
 * (key = the must-have's key), asked along the ladder `direct` → `analog` ("something similar from your own work") →
 * `smaller` ("even a small moment?"), with at most one push for specifics.
 */
export const ChatItem = z.object({
  key: z.string().min(1).max(100),
  kind: z.enum(["question", "gap"]),
  required: z.boolean().default(false),
  state: ChatItemState.default("open"),
  step: z.enum(["direct", "analog", "smaller"]).default("direct"),
  pushes: z.number().int().min(0).max(1).default(0),
});
export type ChatItem = z.infer<typeof ChatItem>;

/** The chat's plan, fixed in code when the chat starts and moved on in code after each turn; the model never writes it. */
export const ChatPlan = z.object({
  v: z.literal(1),
  section: ChatSection,
  items: z.array(ChatItem).max(20),
  /** The item being asked now; null between items and while wrapping up. */
  current: z.string().nullable().default(null),
  builtAt: z.string(),
});
export type ChatPlan = z.infer<typeof ChatPlan>;

/** What the chat's header shows: "2 of 4 required · Required questions"; never the questions in advance. */
export type ChatCounter = { done: number; required: number; section: ChatSection; label: string };

/**
 * The chat's closing question ("Wrapping up"): asked after every item, in code's words, and never an item of the plan
 * (it is not counted, and it is never scored). Its answer is the candidate's own words like any other, kept under this key.
 */
export const CHAT_WRAP_KEY = "wrap_up";
/** The closing question, in code's words (the model may say it its own way, with the first name). */
export const CHAT_WRAP_QUESTION = "Is there anything else you would like the hiring team to know before we finish?";

/** A key's machine prefix: a must-have's (`mh_1_`), an older question's (`wq_`, `q_`, `sq_`). */
const KEY_PREFIX = /^(?:mh_\d+_|wq_|q_|sq_)/;

/**
 * What an AI interview answer is named by where the reader's own questions do not name its key: the closing answer by
 * the closing question; a must-have's gap answer, kept under the must-have's key, by the must-have's own words; any other
 * key in plain words without its machine prefix ("sq_shift_swaps": "Shift swaps"). Never a key, never an underscore.
 */
export function answerKeyWords(key: string, mustHaves: ReadonlyArray<{ key: string; text: string }> = []): string {
  if (key === CHAT_WRAP_KEY) return CHAT_WRAP_QUESTION;
  const must = mustHaves.find((m) => m.key === key)?.text.trim();
  if (must) return must;
  const words = (key.replace(KEY_PREFIX, "") || key).replace(/_+/g, " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "";
}

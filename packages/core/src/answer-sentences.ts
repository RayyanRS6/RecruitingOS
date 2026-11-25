import { formAnswerViews, type FormQuestion } from "@ros/contracts";

/**
 * The answers a candidate gave on the application form, as stored and as plain sentences. The CV reading is given the
 * sentences as evidence, the evidence rules accept a quote of one as the candidate's own words, and the AI interview
 * lists them on "Check your answers" and builds its plan from the yes-or-no ones (a "No" leaves that must-have out). One
 * wording for all three, so a quote is always found again.
 */

/** What an application stores of its form: the answers by question key, and for an application from an older form the two places it kept them. */
export type StoredFormAnswers = { form?: Record<string, string> | null; eligibility?: Record<string, unknown> | null; quick?: Record<string, string> | null };

/** Every answer of one application's form, by question key. */
export function formAnswersOf(answers: StoredFormAnswers | null | undefined): Record<string, unknown> {
  return { ...(answers?.eligibility ?? {}), ...(answers?.quick ?? {}), ...(answers?.form ?? {}) };
}

/** The sentence for one question and its answer: the question as asked, then the answer, ending in a full stop. */
export function answerSentence(question: string, answer: string): string {
  const q = question.trim();
  const a = answer.trim();
  return `${q}${/[.?!:]$/.test(q) ? "" : ":"} ${a}${/[.?!]$/.test(a) ? "" : "."}`;
}

/**
 * Every answered question of the form as one sentence ("Do you hold an active CA RDH license? Yes."), in the form's
 * order. A question left unanswered has no sentence.
 */
export function formAnswerSentences(questions: readonly FormQuestion[], answers: Readonly<Record<string, unknown>> | null | undefined): Array<{ key: string; sentence: string }> {
  return formAnswerViews(questions, answers).flatMap((v) => (v.answer ? [{ key: v.key, sentence: answerSentence(v.question, v.answer) }] : []));
}

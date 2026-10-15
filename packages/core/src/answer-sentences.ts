import type { CompanyQuestions, EligibilityRule } from "@ros/contracts";
import { quickQuestionsOf } from "./apply-questions";

/**
 * The candidate's answers on the form as plain sentences, the question and the answer they gave, one per question
 * ("Do you hold an active CA RDH license? Yes."). Wave S7: the AI readings are given these instead of the raw answers
 * (fairness findings of 15 Oct 2026: a reading quoted '"rdh_license":"yes"'), the evidence rules accept them as the
 * candidate's own words, and the chat is given them so it never asks again what the form already asked. One wording
 * for all three, so a quote of one is always found again.
 */
export type AnswerSentence = { key: string; source: "eligibility" | "company"; sentence: string };

function words(value: unknown, unit: string | null): string | null {
  if (Array.isArray(value)) {
    const list = value.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
    return list.length ? list.join(", ") : null;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value)) return unit ? `${value} ${unit}` : String(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim();
  if (/^(yes|y|true)$/i.test(v)) return "Yes";
  if (/^(no|n|false)$/i.test(v)) return "No";
  return unit ? `${v} ${unit}` : v;
}

/** The sentence for one question and its answer: the question as asked, then the answer, ending in a full stop. */
export function answerSentence(question: string, answer: string): string {
  const q = question.trim();
  const a = answer.trim();
  return `${q}${/[.?!:]$/.test(q) ? "" : ":"} ${a}${/[.?!]$/.test(a) ? "" : "."}`;
}

/**
 * Every answered question of "Questions from <Company>", in the form's order (`quickQuestionsOf`): the eligibility
 * answers from `answers.eligibility`, the quick ones from `answers.quick`. A question left unanswered has no sentence.
 */
export function applicationAnswerSentences(packet: { requirements: { eligibility: EligibilityRule[] }; companyQuestions?: CompanyQuestions | null }, answers: { eligibility?: Record<string, unknown> | null; quick?: Record<string, string> | null } | null | undefined): AnswerSentence[] {
  const out: AnswerSentence[] = [];
  for (const q of quickQuestionsOf(packet)) {
    const raw = q.source === "eligibility" ? answers?.eligibility?.[q.key] : answers?.quick?.[q.key];
    const said = words(raw, q.kind === "number" ? q.unit : null);
    if (said) out.push({ key: q.key, source: q.source, sentence: answerSentence(q.question, said) });
  }
  return out;
}

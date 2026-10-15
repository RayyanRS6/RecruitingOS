import { CHAT_SECTION_LABEL, type ChatCounter, type ChatPlan, type CompanyQuestions, type EligibilityRule, type QuickQuestionView, type ScreeningQuestion, type WrittenQuestionView } from "@ros/contracts";

/**
 * Wave S7 readers of the company's questions (the contracts in packages/contracts/src/domain/apply-questions.ts). Pure:
 * the form, the chat, Review & send, the application record and the owner's preview all read the questions through
 * these, so they agree on what is asked, in what order, under which keys.
 */

const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** The days a schedule rule lists, when it lists them as the form shows them (the same test the apply form uses). */
function ruleDays(rule: EligibilityRule): string[] | null {
  const days = (rule.expectation as { days?: unknown } | null | undefined)?.days;
  return rule.type === "schedule_availability" && Array.isArray(days) && days.length > 0 ? [...WEEK] : null;
}

/**
 * "Questions from <Company>", in the order the form asks them: the packet's eligibility questions first (yes or no, or
 * the days of a schedule question, as the form asks them today), then the company's quick questions. An eligibility
 * question with yes and no is required, as the form's select is today; ticking days is not.
 */
export function quickQuestionsOf(packet: { requirements: { eligibility: EligibilityRule[] }; companyQuestions?: CompanyQuestions | null }): QuickQuestionView[] {
  const eligibility: QuickQuestionView[] = (packet.requirements.eligibility ?? []).map((rule) => {
    const days = ruleDays(rule);
    return { source: "eligibility", key: rule.key, field: `elig_${rule.key}`, kind: days ? "days" : "yes_no", question: rule.question, help: rule.rationale || null, required: !days, options: days ?? ["Yes", "No"], unit: null, min: null, max: null };
  });
  const quick: QuickQuestionView[] = (packet.companyQuestions?.quick ?? []).map((q) =>
    q.kind === "choice"
      ? { source: "company", key: q.key, field: `q_${q.key}`, kind: "choice", question: q.question, help: q.help ?? null, required: q.required, options: [...q.options], unit: null, min: null, max: null }
      : { source: "company", key: q.key, field: `q_${q.key}`, kind: "number", question: q.question, help: q.help ?? null, required: q.required, options: [], unit: q.unit ?? null, min: q.min ?? null, max: q.max ?? null },
  );
  return [...eligibility, ...quick];
}

/**
 * The written questions the chat asks in "Required questions" and Review & send writes up, in order: the company's own
 * when it set any; otherwise the packet's screening questions under their own keys, each required, so a job saved
 * before Wave S7 runs the new chat with the questions it already has. The private `lookFor` never leaves the packet here.
 */
export function writtenQuestionsOf(packet: { screening: { questions: ScreeningQuestion[] }; companyQuestions?: CompanyQuestions | null }): WrittenQuestionView[] {
  const own = packet.companyQuestions?.written ?? [];
  if (own.length) return own.map((q) => ({ key: q.key, question: q.question, required: q.required, source: "company" }));
  return (packet.screening.questions ?? []).map((q) => ({ key: q.key, question: q.question, required: true, source: "screening" }));
}

/**
 * The chat header's counter (founder decision S7-3): how many of the required written questions are closed (answered
 * with something concrete, settled as not known, or skipped), out of how many, and the section's name. Gaps in "About
 * your experience" never count. Null for a chat without a plan (every chat from before Wave S7).
 */
export function chatCounter(plan: ChatPlan | null | undefined): ChatCounter | null {
  if (!plan) return null;
  const required = plan.items.filter((i) => i.kind === "written" && i.required);
  const done = required.filter((i) => i.state === "covered" || i.state === "unknown" || i.state === "skipped").length;
  const section = CHAT_SECTION_LABEL[plan.section];
  return { done, required: required.length, section: plan.section, label: required.length ? `${done} of ${required.length} required · ${section}` : section };
}

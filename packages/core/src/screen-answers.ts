import type { ScreenProgress } from "@ros/contracts";

/**
 * Where a screen's answers live. The packet's own answers are in `screens.answers`; an answer to one of the open
 * questions a screen started with ("Ask about this in a screen", docs/spec/21 section 7) is kept beside that question
 * in `screens.progress.focusQuestions`; the candidate page's "x of N answered" counts both places through here.
 * Every reader of what a candidate said in a screen (the scorecard, the interviewer's brief, the recruiter's context,
 * the owner's card) and every path that exports or removes it (an access request, an anonymization) goes through here,
 * so the second place is never forgotten.
 */
export type ScreenAnswerSource = { answers: Record<string, string>; progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined };

/** Every recorded answer by question key: the open questions' answers first, then the packet's own. */
export function screenAnswersOf(screen: ScreenAnswerSource): Record<string, string> {
  const focus: Record<string, string> = {};
  for (const f of screen.progress?.focusQuestions ?? []) if (f.answer) focus[f.key] = f.answer;
  return { ...focus, ...screen.answers };
}

/** The open questions a screen started with, in the words the candidate was asked, keyed like their answers. */
export function openingQuestionsOf(progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined): Array<{ key: string; question: string }> {
  return (progress?.focusQuestions ?? []).map((f) => ({ key: f.key, question: f.question }));
}

/** The progress with every answer to an open question removed. The questions stay: they are the assistant's words, not the candidate's. */
export function withoutFocusAnswers(progress: ScreenProgress): ScreenProgress {
  if (!progress.focusQuestions) return progress;
  return { ...progress, focusQuestions: progress.focusQuestions.map((f) => ({ key: f.key, question: f.question, ...(f.whyItMatters ? { whyItMatters: f.whyItMatters } : {}) })) };
}

import type { ScreenProgress } from "@ros/contracts";

/**
 * What a candidate said in an AI interview, and who may read it. The hiring team reads an interview only once the
 * candidate pressed "Send my answers": until then, and for good when it closed without that press, nothing they said in
 * it and nothing worked out from it reaches the team. The candidate's own access to their data is not limited by this.
 */

/** Whether the candidate sent this AI interview: the team may read it, and its scorecard is written. */
export function screenAnswersSent(screen: { status: string }): boolean {
  return screen.status === "completed";
}

/**
 * Everything of the candidate's own that one AI interview's row holds beside its transcript, for a copy of their data:
 * the recorded answers by question key, and what a row stored by an earlier version of the chat keeps in its progress
 * (answers beside its opening questions, and answers written up for them to check).
 */
export function storedScreenWords(screen: { answers: Record<string, string>; progress: unknown }): { answers: Record<string, string>; openingQuestions: Array<{ key: string; question: string }>; writtenUp: unknown[] } {
  const progress = (screen.progress ?? {}) as { focusQuestions?: unknown; writeup?: { answers?: unknown } | null };
  const opening = (Array.isArray(progress.focusQuestions) ? progress.focusQuestions : []).filter((f): f is { key: string; question: string; answer?: unknown } => !!f && typeof f === "object" && typeof (f as { key?: unknown }).key === "string" && typeof (f as { question?: unknown }).question === "string");
  const beside = Object.fromEntries(opening.flatMap((f) => (typeof f.answer === "string" && f.answer ? [[f.key, f.answer] as const] : [])));
  return {
    answers: { ...beside, ...screen.answers },
    openingQuestions: opening.map((f) => ({ key: f.key, question: f.question })),
    writtenUp: Array.isArray(progress.writeup?.answers) ? progress.writeup.answers : [],
  };
}

/**
 * The progress with everything the candidate said taken out, for an anonymization: only what the code keeps about where
 * the chat stood (keys, states and times) stays. Anything else a stored row carries in its progress goes with their words.
 */
export function withoutCandidateWords(progress: ScreenProgress): ScreenProgress {
  const kept: ScreenProgress = { askedKeys: progress.askedKeys ?? [], currentQuestionKey: progress.currentQuestionKey ?? null, followUps: progress.followUps ?? {}, confusedTurns: progress.confusedTurns ?? 0, failures: progress.failures ?? 0 };
  if (progress.phase) kept.phase = progress.phase;
  if (progress.declined) kept.declined = progress.declined;
  if (progress.edits) kept.edits = progress.edits;
  if (progress.submittedAt) kept.submittedAt = progress.submittedAt;
  if (progress.countedAt) kept.countedAt = progress.countedAt;
  if (progress.scoreWaitsForCredit) kept.scoreWaitsForCredit = progress.scoreWaitsForCredit;
  if (progress.keptOpenUntil) kept.keptOpenUntil = progress.keptOpenUntil;
  if (progress.chat) kept.chat = progress.chat;
  return kept;
}

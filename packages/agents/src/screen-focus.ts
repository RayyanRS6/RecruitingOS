import type { EvidenceAssessment, RolePacket, ScreenProgress } from "@ros/contracts";
import { screenAnswersOf } from "@ros/core";

/**
 * "Ask about this in a screen" (docs/spec/21 section 7, P1): the owner turns the résumé assessment's open questions
 * into the first questions of a screen. The questions are fixed on the screen when it is created
 * (`screens.progress.focusQuestions`, keys `unknown_1`, `unknown_2`, ...) and put in front of the packet's own
 * screening questions wherever the conversation reads the packet, so the prompt, the fake handler, the turn rules and
 * the scorecard treat them as ordinary questions. Their answers are recorded beside the question they answer, not in
 * `screens.answers`; the candidate page's "x of N answered" counts them through `answersOf` and `focusedPacket`, and
 * every reader, the access export and the anonymization go through `screenAnswersOf` / `withoutFocusAnswers` in @ros/core.
 */

export type FocusQuestion = NonNullable<ScreenProgress["focusQuestions"]>[number];

export const FOCUS_KEY_PREFIX = "unknown_";
const MAX_FOCUS_QUESTIONS = 4;

/** The sentence the invitation email and the opening message carry when a screen starts with the open questions. */
export const FOCUS_INTRO = "We will start with a few quick questions about your background, then the usual screening questions.";

export function isFocusKey(key: string | null | undefined): boolean {
  return !!key && key.startsWith(FOCUS_KEY_PREFIX);
}

export function focusQuestionsFrom(unknowns: EvidenceAssessment["unknowns"]): FocusQuestion[] {
  return unknowns.slice(0, MAX_FOCUS_QUESTIONS).map((u, i) => ({ key: `${FOCUS_KEY_PREFIX}${i + 1}`, question: u.question, whyItMatters: u.whyItMatters }));
}

/** The packet as the conversation sees it: the focus questions first, then the packet's own. The packet itself when there are none. */
export function focusedPacket(packet: RolePacket, progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined): RolePacket {
  const focus = progress?.focusQuestions ?? [];
  if (!focus.length) return packet;
  const own = packet.screening.questions.filter((q) => !focus.some((f) => f.key === q.key));
  return { ...packet, screening: { ...packet.screening, questions: [...focus.map((f) => ({ key: f.key, question: f.question, kind: "skills" as const })), ...own] } };
}

/**
 * The packet handed to the screen invitation: the focus questions counted in "N questions", and the intro sentence at
 * the head of the human-alternative line, which the invitation prints right after the link. The message templates live
 * in coordinator.ts and are shared by every screen; this keeps one template.
 */
export function packetForFocusedInvite(packet: RolePacket, progress: Pick<ScreenProgress, "focusQuestions"> | null | undefined): RolePacket {
  const p = focusedPacket(packet, progress);
  if (p === packet) return packet;
  return { ...p, communication: { ...p.communication, humanAlternativeText: `${FOCUS_INTRO}\n\n${p.communication.humanAlternativeText}` } };
}

/** Every recorded answer, the focus questions' included, by question key (the one definition lives in @ros/core). */
export function answersOf(screen: { answers: Record<string, string>; progress: Pick<ScreenProgress, "focusQuestions"> }): Record<string, string> {
  return screenAnswersOf(screen);
}

/** Records an answer to a focus question beside the question; returns the progress unchanged for any other key. */
export function withFocusAnswer(progress: ScreenProgress, key: string, answer: string): ScreenProgress {
  const focus = progress.focusQuestions;
  if (!focus?.some((f) => f.key === key)) return progress;
  return { ...progress, focusQuestions: focus.map((f) => (f.key === key ? { ...f, answer } : f)) };
}

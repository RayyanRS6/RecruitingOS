import { AI_INTERVIEW_STATUS_LABEL, SCREEN_REMIND_EVERY_HOURS, aiInterviewStatusOf, type AiInterviewView, type ScreenStatus } from "@ros/contracts";

/**
 * Where a person's AI interview stands, as the team reads it, from their newest AI interview's row alone. Pure: no
 * database, and no clock but the one passed. Never how far anyone got: nothing of an interview reaches the team before
 * the candidate sends it.
 */

/** The parts of an AI interview's row the team's view reads. */
export type AiInterviewScreen = { status: string; invitedAt?: string | null; expiresAt?: string | null; remindedAt?: string | null; startedAt?: string | null; completedAt?: string | null; createdAt?: string | null };

const iso = (at: string | null | undefined): string | null => (at ? new Date(at).toISOString() : null);

/** The latest email about the interview: its link, or a reminder (the one that goes by itself, or a person's). */
export function aiInterviewLastEmailAt(screen: AiInterviewScreen): string | null {
  const times = [screen.invitedAt ?? screen.createdAt ?? null, screen.remindedAt ?? null].filter((t): t is string => !!t).map((t) => Date.parse(t));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Whether the link or a reminder went in the last `SCREEN_REMIND_EVERY_HOURS` hours: a reminder waits until it has not. */
export function remindedRecently(screen: AiInterviewScreen, now: Date): boolean {
  const last = aiInterviewLastEmailAt(screen);
  return !!last && now.getTime() - Date.parse(last) < SCREEN_REMIND_EVERY_HOURS * 3_600_000;
}

/** The team's view of an AI interview. Null without one, and for a cancelled one: the person is back in New, as if none had been sent. */
export function aiInterviewViewOf(screen: AiInterviewScreen | null | undefined): AiInterviewView | null {
  const status = screen ? aiInterviewStatusOf(screen.status as ScreenStatus) : null;
  if (!screen || !status) return null;
  return {
    status,
    label: AI_INTERVIEW_STATUS_LABEL[status],
    sentAt: iso(screen.invitedAt ?? screen.createdAt),
    linkOpenUntil: status === "sent" || status === "started" ? iso(screen.expiresAt) : null,
    lastEmailAt: aiInterviewLastEmailAt(screen),
    startedAt: iso(screen.startedAt),
    completedAt: status === "done" ? iso(screen.completedAt) : null,
  };
}

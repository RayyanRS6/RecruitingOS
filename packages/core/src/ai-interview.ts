import { AI_INTERVIEW_GROUP_OF, AI_INTERVIEW_STATE_LABEL, type AiInterviewState, type AiInterviewView, type ApplicationStage, type InterviewInScore } from "@ros/contracts";
import { AI_INTERVIEW_PHASE } from "./stages";

/**
 * "No AI interview yet" (20 October 2026, R20-7): where someone in that column stands with their AI interview, worked out
 * from the stage and their latest screen alone (pure; no database and no clock but the one passed). The words are neutral
 * and never say how far they got: no count, no answer, no question where they stopped (the 9 October "hide until Send"
 * rule). Null outside the column. `isStillApplying` (the one-visit flow's "still applying", E6) is a part of it: the open
 * states of an interview that came with the application.
 */

/**
 * The parts of a screen the view reads; any order of screens is fine as long as the caller passes the latest.
 * `linkEmailHeld`: the email carrying its link has not left yet (held for the ITS company check, or still queued; B7),
 * as the caller read it (`linkEmailsWaiting` in @ros/agents); left out, it counts as gone. Once it leaves, the interview's
 * run moves `invitedAt` to that moment, so the day between reminders counts from when the link reached them.
 */
export type AiInterviewScreen = {
  status: string;
  invitedAt?: string | null;
  expiresAt?: string | null;
  remindedAt?: string | null;
  idleRemindedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  humanRequestedAt?: string | null;
  createdAt?: string | null;
  linkEmailHeld?: boolean;
};

/** "Send a reminder" at most once a day (R20-7): a day after the link or the last reminder went. */
export const AI_INTERVIEW_REMIND_GAP_HOURS = 24;
/** A reminder keeps the link open at least this long from then. */
export const AI_INTERVIEW_REMIND_EXTENDS_HOURS = 72;

/** Stages before any screen exists for the interview: the résumé is being read, or more interviews are awaited (Q17). */
const BEFORE_SCREEN: readonly ApplicationStage[] = ["applied", "received", "eligible"];
const HOUR = 3_600_000;

/** The state a screen's status reads as. A screen sent and being scored while the stage catches up reads as started. */
export function aiInterviewStateOf(status: string): AiInterviewState {
  switch (status) {
    case "invited":
    case "reminded":
      return "invited";
    case "in_progress":
    case "paused":
    case "completed":
      return "started";
    case "human_requested":
      return "asked_person";
    case "expired":
    case "cancelled":
      return "link_expired";
    default:
      // unfinished, declined_by_candidate, abandoned: closed part-way, unsent
      return "didnt_finish";
  }
}

/** The latest email about the interview: its link, or a reminder (automatic or a person's). */
export function aiInterviewLastEmailAt(screen: AiInterviewScreen): string | null {
  const times = [screen.invitedAt ?? screen.createdAt ?? null, screen.remindedAt ?? null, screen.idleRemindedAt ?? null].filter((t): t is string => !!t);
  return times.length ? new Date(Math.max(...times.map((t) => Date.parse(t)))).toISOString() : null;
}

/** Statuses whose link a person can remind about: not started, or started and not sent (not one paused while the assistant is down). */
const REMINDABLE: readonly string[] = ["invited", "reminded", "in_progress"];

/**
 * Why a person may not send a reminder now about a link that is open, or null when they may (or the link is not open):
 * `paused` (the assistant is down; the interview carries on by itself), `email_held` (the email carrying the link has not
 * left yet, B7: a reminder would only wait behind it), `recently` (the link or a reminder went in the last day).
 */
export function aiInterviewRemindBlocked(screen: AiInterviewScreen, now: Date): "recently" | "email_held" | "paused" | null {
  if (screen.status === "paused") return "paused";
  if (!REMINDABLE.includes(screen.status)) return null;
  if (screen.linkEmailHeld) return "email_held";
  const last = aiInterviewLastEmailAt(screen);
  return last && now.getTime() - Date.parse(last) < AI_INTERVIEW_REMIND_GAP_HOURS * HOUR ? "recently" : null;
}

/**
 * Whether a person may send a reminder now: the link is open (not started, or started and not sent, and not paused while
 * the assistant is down), the email carrying it has left, and nothing went about it in the last day. `remind_screen`
 * checks the same.
 */
export function aiInterviewCanRemind(screen: AiInterviewScreen, now: Date): boolean {
  return REMINDABLE.includes(screen.status) && aiInterviewRemindBlocked(screen, now) === null;
}

/** A screen whose link is still open: not started, started, paused while the assistant is down, or handed to a person. */
const OPEN_FOR_SCORE: readonly string[] = ["invited", "reminded", "in_progress", "paused", "human_requested"];

/**
 * Where the AI interview stands for the match score's label (R20-9; `InterviewInScore`), from every screen of one
 * application in any order (the list loads them unordered) and its stage. Any sent one: `being_scored` (`matchScore`
 * makes it `done` once its scorecard is in the readings). Else any open one, or none yet while the stage says it is
 * being prepared: `not_done_yet`. Else any other (lapsed, left part-way, said no, stopped): `not_done`, one wording
 * whatever closed it; so too an interview that never came because the month's AI interviews stayed used up for the
 * whole wait (`allowanceLapsed`: the run's `screen.allowance_lapsed`, Q17, as the caller read it), since it was offered.
 * No screen at all otherwise: `none` (never offered one, as before 20 October 2026). It reads the status only, never
 * answers, counts or times.
 */
export function interviewInScore(screens: ReadonlyArray<{ status: string }>, stage?: ApplicationStage | string | null, opts: { allowanceLapsed?: boolean } = {}): Exclude<InterviewInScore, "done"> {
  if (screens.some((s) => s.status === "completed")) return "being_scored";
  if (screens.some((s) => OPEN_FOR_SCORE.includes(s.status))) return "not_done_yet";
  if (screens.length) return "not_done";
  if (stage && AI_INTERVIEW_PHASE.includes(stage as ApplicationStage)) return "not_done_yet";
  return opts.allowanceLapsed ? "not_done" : "none";
}

/**
 * Where someone in "No AI interview yet" stands (see the module note), or null outside it. `waitingForMore`: its run waits
 * for more AI interviews this month (Q17), as the caller read it.
 */
export function aiInterviewOf(stage: ApplicationStage | string, latest: AiInterviewScreen | null | undefined, now: Date = new Date(), opts: { waitingForMore?: boolean } = {}): AiInterviewView | null {
  if (!AI_INTERVIEW_PHASE.includes(stage as ApplicationStage)) return null;
  // Before the interview exists (or a person's new link still waits for its run): it is being prepared.
  const screen = BEFORE_SCREEN.includes(stage as ApplicationStage) ? null : latest ?? null;
  const state: AiInterviewState = screen ? aiInterviewStateOf(screen.status) : "being_read";
  const since = !screen ? null
    : state === "invited" ? screen.invitedAt ?? screen.createdAt ?? null
    : state === "started" ? screen.startedAt ?? null
    : state === "asked_person" ? screen.humanRequestedAt ?? null
    : state === "link_expired" ? screen.expiresAt ?? null
    : screen.completedAt ?? null;
  return {
    state,
    group: AI_INTERVIEW_GROUP_OF[state],
    label: AI_INTERVIEW_STATE_LABEL[state],
    since,
    linkOpenUntil: screen && state === "invited" ? screen.expiresAt ?? null : null,
    lastEmailAt: screen ? aiInterviewLastEmailAt(screen) : null,
    canRemind: !!screen && aiInterviewCanRemind(screen, now),
    canResend: state === "link_expired" || state === "didnt_finish",
    waitingForMore: !screen && !!opts.waitingForMore,
    remindBlocked: screen ? aiInterviewRemindBlocked(screen, now) : null,
  };
}

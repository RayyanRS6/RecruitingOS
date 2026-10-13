/**
 * Who is ticked when "Approve an interview" opens on a candidate. The round itself comes from the packet version the
 * application runs on (the API checks the round against it), but the people come from the role's current interview plan
 * when that round is still in it, so interviewers assigned on the Interview plan tab reach candidates who applied
 * before the assignment. Only active team members are ever ticked: a removed member's id would be invisible on the
 * page, impossible to untick, and refused by the API on every attempt (interviewer_unknown).
 */
import { canManageInterviews, canRequestInterviews, canSeeTalent } from "./roles";

export type PlanRound = { key: string; interviewerUserIds: string[] };

type SheetInterview = { id: string; applicationId: string; status: string; createdAt: string };
const IN_MOTION = ["proposed", "scheduling", "scheduled"];
/** Still at the interview step, so another interview can be approved for them (the API's own rule). */
const AT_INTERVIEW_STEP = ["interview_recommended", "interview_complete"];

/**
 * What an interview that never took place offers on its sheet, so the team is never left without a way on: times that
 * expired can go out again for the same round and interviewers ("offer_again"), and after a cancellation a new
 * interview can be approved from the candidate's page ("approve_new"). Someone under Cancelled (founder decisions 1A to
 * 4A) with nothing in motion gets "Send new times" instead ("send_new_times"): the same interview reopened, or after a
 * no-show a new one for the same round. Only for the candidate's newest interview, while they are still at the interview
 * step and nothing else is in motion for them, and only for a role that may do it.
 */
export function againChoice(i: SheetInterview & { candidate: { stage: string }; followUp?: { times: string } | null }, all: readonly SheetInterview[], role: string | null | undefined): "send_new_times" | "offer_again" | "approve_new" | null {
  if (!AT_INTERVIEW_STEP.includes(i.candidate.stage)) return null;
  if (all.some((x) => x.applicationId === i.applicationId && x.id !== i.id && (IN_MOTION.includes(x.status) || x.createdAt > i.createdAt))) return null;
  if (i.followUp && (i.followUp.times === "none" || i.followUp.times === "expired") && !IN_MOTION.includes(i.status) && canManageInterviews(role)) return "send_new_times";
  if (i.status === "offer_expired" && canManageInterviews(role)) return "offer_again";
  if (i.status === "cancelled" && canRequestInterviews(role) && canSeeTalent(role)) return "approve_new";
  return null;
}

/**
 * "Did it take place?" is asked once the start time has passed, never before: either answer ends the interview and
 * moves the candidate to "decision needed", so a click on a booked interview tomorrow must not be possible.
 */
export function asksWhetherItTookPlace(i: { status: string; outcome?: string | null; startsAt: string | null }, now: number = Date.now()): boolean {
  if (i.outcome || !["scheduled", "completed"].includes(i.status)) return false;
  return i.status === "completed" || (!!i.startsAt && Date.parse(i.startsAt) <= now);
}

export function defaultInterviewers(input: {
  roundKey: string | undefined;
  /** The rounds of the packet version the application runs on. */
  applicationPlan: PlanRound[];
  /** The rounds of the role's current packet (GET /roles/:id/interview-plan), when loaded. */
  currentPlan?: PlanRound[] | null;
  /** The people the person ticked by hand, when they changed the defaults. */
  picked?: string[] | null;
  /** Active members of the team; null while the list is loading, which ticks nobody yet. */
  activeMemberIds: ReadonlySet<string> | null;
}): string[] {
  if (!input.activeMemberIds) return [];
  const active = input.activeMemberIds;
  const fromCurrent = input.currentPlan?.find((r) => r.key === input.roundKey)?.interviewerUserIds;
  const fromApplication = input.applicationPlan.find((r) => r.key === input.roundKey)?.interviewerUserIds;
  const ids = input.picked ?? fromCurrent ?? fromApplication ?? [];
  return [...new Set(ids)].filter((id) => active.has(id));
}

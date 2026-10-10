import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Actor, MembershipRole } from "@ros/contracts";
import { CANCEL_STAGES, STAGE_LABEL, defaultSchedulingWindow, emit, endMarkOnMove, followUpParked, notify, openFollowUpOf, setAutoState, setCurrentInterview, transition } from "@ros/core";
import type { InvitationNote } from "@ros/agents";
import { applications, approvalRequests, candidates, companies, interviewParticipants, interviews, memberships, rolePackets, roles, type Tx } from "@ros/db";
import { cancelNewTimesRuns, type NewTimesOfferKind, type NewTimesVia } from "@ros/workflows";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { suggestionRunOf } from "./messages";

/** The steps from which a person may approve an interview round. */
export const INTERVIEW_FROM: readonly string[] = ["triaged", "screen_complete", "interview_recommended", "interview_complete", "eligible", "screen_invited", "screening"];
/** Interviews with times being worked out, offered or booked: an application has one at a time. */
export const OPEN_INTERVIEW: string[] = ["proposed", "scheduling", "scheduled"];

export type ApproveInterviewInput = {
  companyId: string;
  applicationId: string;
  roundKey: string;
  interviewerUserIds: string[];
  linkSource: "calendar" | "pasted";
  meetingUrl?: string | null;
  window?: { fromDate?: string; toDate?: string; businessDaysOnly?: boolean } | null;
  note?: string | null;
  /** A personal line for the invitation (Q28), already checked; `suggestionRunId` says whether the assistant suggested it. */
  invitationNote?: InvitationNote | null;
  suggestionRunId?: string | null;
  actor: Actor;
  /** The approver's role on the team and their user id (the approval is theirs). */
  by: MembershipRole;
  approvedBy: string;
  now: Date;
  /** The caller already holds the application's lock, then the follow-up's (`sendNewTimes`). */
  locked?: boolean;
  /** For someone under Cancelled: a person's approval or send ("person"), or the team's send to several people ("batch"). */
  via?: Exclude<NewTimesVia, "auto">;
};

/**
 * A person approves an interview round (policy `interview.request`, approval level, AC10.1: the click is the approval).
 * The interview is written with its interviewers, who are told at once; a pending recommendation is resolved by it; the
 * candidate moves to "Interview approved" (or, already at the interview step, their private mark ends, founder decision
 * B3); and `schedule_interview` starts. The same for the usual "Approve an interview" and for the team's "Send new times"
 * to someone who did not come (the Cancelled column, founder decision 4A).
 *
 * The application is locked first, then its open follow-up, the order the automatic set of new times and a person's
 * "Send new times" take them, so an automatic send and an approval at the same moment never both open an interview. For
 * someone under Cancelled the new interview carries their new times: the no-show it replaces is marked decided ("new
 * times"), the times email opens with the new-times wording instead of "Good news", the follow-up points at it, and an
 * automatic set still waiting for its day does not go (`team_acted`). They stay under Cancelled until they book.
 */
export async function createApprovedInterview(tx: Tx, container: Container, input: ApproveInterviewInput): Promise<{ interviewId: string; followUpId: string | null }> {
  const { companyId, actor, now } = input;
  const read = tx.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.companyId, companyId))).limit(1);
  const [app] = input.locked ? await read : await read.for("update");
  if (!app) throw new HttpError(404, "not_found", "Application not found.");
  if (!INTERVIEW_FROM.includes(app.stage)) throw new HttpError(409, "interview_not_schedulable", `A candidate at "${STAGE_LABEL[app.stage]}" cannot be moved to an interview from here.`);
  // A line that came from the assistant's suggestion says so even if it was changed or the page left the flag out (Q28).
  let invitationNote = input.invitationNote ?? null;
  if (invitationNote && !invitationNote.aiHelped && (await suggestionRunOf(tx, input.suggestionRunId))) invitationNote = { ...invitationNote, aiHelped: true };
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  const round = pv?.packet.interviews.plan.find((r) => r.key === input.roundKey);
  if (!round) throw new HttpError(400, "round_unknown", "That round is not in the approved interview plan.");
  const members = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active"), inArray(memberships.userId, input.interviewerUserIds)));
  if (members.length !== input.interviewerUserIds.length) throw new HttpError(400, "interviewer_unknown", "Every interviewer must be an active member of the company.");
  const followUp = await openFollowUpOf(tx, app.id, { lock: true });
  const open = await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, OPEN_INTERVIEW)));
  if (open.length) throw new HttpError(409, "interview_open", "An interview is already being scheduled for this candidate. Reschedule or cancel it first.");
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const window = { ...defaultSchedulingWindow(now, company.timezone), ...(input.window ?? {}) };
  if (input.linkSource === "pasted" && !input.meetingUrl) throw new HttpError(400, "meeting_url_required", "Paste the meeting link, or let the calendar create one.");
  const [iv] = await tx.insert(interviews).values({ companyId, applicationId: app.id, roundKey: round.key, title: round.title, format: round.format, durationMinutes: round.durationMinutes, status: "proposed", linkSource: input.linkSource, meetingUrl: input.linkSource === "pasted" ? input.meetingUrl ?? null : null, schedulingWindow: window, createdBy: actor, timezone: company.timezone }).returning();
  for (const uid of input.interviewerUserIds) await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: uid, role: "interviewer", status: "invited" });
  // Each interviewer is told the moment they are put on the interview ("invited"); the booking confirms them later.
  const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  await notify(tx, { companyId, kind: "interview.assigned", title: `You are interviewing ${cand?.firstName ?? ""} ${cand?.lastName ?? ""}`.trim(), body: `${round.title} for ${role?.title ?? "a role"}, ${round.durationMinutes} minutes. Times are offered to the candidate from your calendar or declared hours; you will be told as soon as one is booked.`, action: { label: "Open the interview", href: `/interviews/${iv.id}` }, userIds: input.interviewerUserIds });
  // The human's click is the approval (policy interview.request, approval level, AC10.1). Any pending recommendation is resolved by it.
  const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.recommend_interview"), eq(approvalRequests.status, "pending")));
  for (const p of pending) await tx.update(approvalRequests).set({ status: "approved", decidedBy: input.approvedBy, decidedAt: now.toISOString(), decisionNote: input.note ?? "interview requested" }).where(eq(approvalRequests.id, p.id));
  if (app.stage !== "interview_recommended" && app.stage !== "interview_complete") await transition(tx, { applicationId: app.id, companyId, to: "interview_recommended", by: input.by, actor, reason: input.note ?? "interview approved" });
  // Already at the interview step there is no move, but a person approving an interview still moves them on: a hold
  // (or any other private mark) ends here, as it would with the move (founder decision B3).
  else await endMarkOnMove(tx, { applicationId: app.id, companyId, actor, to: app.stage });
  // The fact says whether the invitation carries a personal line and whether the assistant helped; the words are in the invitation itself.
  await emit(tx, { type: "interview.requested", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { applicationId: app.id, roundKey: round.key, interviewers: input.interviewerUserIds, linkSource: input.linkSource, window, approvedBy: input.approvedBy, invitationLine: invitationNote ? { aiHelped: invitationNote.aiHelped, suggestionRunId: input.suggestionRunId ?? null } : null } });
  await emit(tx, { type: "human.override", companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "interview.request", roundKey: round.key, note: input.note ?? null } });

  // Someone under Cancelled (founder decisions 1A to 4A): this interview carries their new times.
  const carries = followUp && CANCEL_STAGES.includes(app.stage) ? followUp : null;
  let newTimes: { offerKind: NewTimesOfferKind; followUpId: string; via: NewTimesVia } | null = null;
  if (carries) {
    // The interview they did not come to is decided: new times went. The decision card and the report stop asking about
    // it; it stays a no-show on record.
    const [missed] = await tx.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), eq(interviews.status, "no_show"), eq(interviews.outcome, "no_show_candidate"), isNull(interviews.decision))).orderBy(desc(interviews.createdAt)).limit(1);
    if (missed) await tx.update(interviews).set({ decision: "new_times", decisionNote: "New times sent after the candidate did not attend" }).where(eq(interviews.id, missed.id));
    newTimes = { offerKind: carries.choice === "new_times" ? "new_times_asked" : "new_times_team", followUpId: carries.id, via: input.via ?? "person" };
    await setCurrentInterview(tx, { followUpId: carries.id, interviewId: iv.id });
    // A person took it from here: the automatic set waiting for its day does not go.
    if (followUpParked(carries)) {
      await setAutoState(tx, { followUpId: carries.id, to: "not_sent", reason: "team_acted", actor, now });
      await cancelNewTimesRuns(tx, container.engine, { companyId, applicationId: app.id, actor, reason: "a person approved an interview" });
    }
  }
  await container.engine.start(tx, { workflowKey: "schedule_interview", companyId, subject: { type: "interview", id: iv.id }, state: { interviewId: iv.id, applicationId: app.id, roleId: app.roleId, roundKey: round.key, attempt: 1, ...(invitationNote ? { invitationNote } : {}), ...(newTimes ?? {}) }, idempotencyKey: `schedule:${iv.id}:1`, actor });
  return { interviewId: iv.id, followUpId: carries?.id ?? null };
}

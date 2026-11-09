import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit, notify, openFollowUpOf, resolveOpenFollowUp, transition } from "@ros/core";
import { HELD_REASON, interviewReachedThem, onItsWay, sendInterviewCancelled } from "@ros/agents";
import { applications, candidates, companies, interviewParticipants, interviews, jobs, rolePackets, roles, type Tx } from "@ros/db";
import type { Container } from "../container";

type InterviewRow = typeof interviews.$inferSelect;
type Mover = Parameters<typeof transition>[1]["by"];

/**
 * Who hears from us that the interview is off, beside the interviewers (plan A9).
 * - "known": the candidate, whenever they knew about it: a booked time, or times they were offered to pick from. The
 *   Cancel button, a team member's removal, the candidate's own news (they withdrew), and a private decision (founder
 *   decision B6): the note carries no reason, and the decision message a person sends later leaves this interview out.
 *   For a private decision this departs from plan-adjustments §4 (one message, when told), pending the founder's answer
 *   and counsel register item 23(c); see exit-cleanup.ts.
 * - "none": nothing here; the link shows a friendly page. Used when the caller sends the decision message in the same
 *   transaction and that message names the cancelled interview, so the candidate gets one message, not two.
 */
export type CancelNotice = "known" | "none";

/** Whether the candidate holds a booked time, and whether they were offered times to pick from. */
function candidateKnows(iv: InterviewRow): { booked: boolean; offered: boolean } {
  return { booked: iv.status === "scheduled" && !!iv.startsAt, offered: iv.status === "scheduling" && !!iv.scheduleToken && iv.offeredSlots.length > 0 };
}

/**
 * Cancels one interview inside the caller's tenant transaction, the same way whoever asks for it (the Cancel button, a
 * team member's removal that left the interview with nobody to run it, an application leaving the process). The status
 * and the attempt change, so a scheduling run still going ends on its own at its next step; a candidate at "Interviewing"
 * goes back to "Interview to set up" so the team can set a new date and time; the interviewers still on it are told;
 * the candidate is told through the outbox as `notice` says; calendar events are queued for removal by the worker. The
 * candidate's link keeps working and says the interview was cancelled, instead of a bare "not found".
 * `leftProcess`: the application left the process, so the candidate's note carries no reason and promises nothing.
 * `interviewerNote`: what the interviewers read, when the recorded reason is not written for them.
 *
 * The interview that carried new times for someone under Cancelled (the Cancelled column, founder decisions 1A to 4A)
 * takes them out of the column when the team cancels it (`team_cancelled`): a team cancellation never keeps anyone there.
 * The application is locked first, as the automatic set of new times and a person's send lock it, so a cancel and a
 * reopen at the same moment take turns.
 *
 * Nobody hears of a cancellation of something they never heard of. A time they picked, they know of. Times on offer, or a time
 * a person set, they know of only once an email about it has left: called off before that (the worker had not got to it, it
 * waited for the ITS check, or it could not be delivered), no note is written, the waiting email is withdrawn by the outbox,
 * and the decision message leaves it out (`neverHeard` on the event). `candidateTold` answers the screen: a note is really on
 * its way, so it may say so. `held`: a note waits for the ITS check.
 */
export async function cancelInterviewInTx(
  tx: Tx,
  container: Container,
  input: { companyId: string; interview: InterviewRow; actor: Actor; by: Mover; reason: string | null; byCandidate?: boolean; cause?: string; now: Date; notice?: CancelNotice; leftProcess?: boolean; interviewerNote?: string },
): Promise<{ hadEvents: boolean; candidateTold: boolean; held: boolean }> {
  const { companyId, actor } = input;
  const iv = input.interview;
  const hadEvents = Object.keys((iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  const knows = candidateKnows(iv);
  const theirOwnPick = knows.booked && iv.selectedSlot?.source !== "person";
  const heard = theirOwnPick || ((knows.booked || knows.offered) && (await interviewReachedThem(tx, { applicationId: iv.applicationId, interviewId: iv.id })));
  const neverHeard = (knows.booked || knows.offered) && !heard;
  const tell = (input.notice ?? "known") === "known" && heard;
  const [app] = await tx.select().from(applications).where(eq(applications.id, iv.applicationId)).limit(1).for("update");
  await tx.update(interviews).set({ status: "cancelled", cancelReason: input.reason, attempt: iv.attempt + 1 }).where(eq(interviews.id, iv.id));
  const followUp = app ? await openFollowUpOf(tx, app.id, { lock: true }) : null;
  const carried = followUp ? followUp.currentInterviewId === iv.id || (followUp.interviewId === iv.id && ["proposed", "scheduling"].includes(iv.status)) : false;
  if (app && carried) await resolveOpenFollowUp(tx, { companyId, applicationId: app.id, actor, how: input.leftProcess ? "left_process" : "team_cancelled", now: input.now });
  if (app?.stage === "interview_scheduled") await transition(tx, { applicationId: app.id, companyId, to: "interview_recommended", by: input.by, actor, reason: "interview cancelled" });
  const parts = await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
  // With nobody left on the interview there is no interviewer to tell; the caller tells the owners itself.
  if (parts.length) await notify(tx, { companyId, kind: "interview.cancelled", title: `Interview cancelled: ${iv.title}`, body: input.interviewerNote ?? input.reason ?? "Cancelled.", action: { label: "Open interviews", href: "/interviews" }, userIds: parts.map((p) => p.userId) });
  // Written is not the same as on its way: the event says a note was written, so the decision message does not repeat it.
  let noteWritten = false;
  let candidateTold = false;
  let held = false;
  if (tell && app) {
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
    const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    if (cand && role && company && pv) {
      // The team's own words reach the candidate only from the Cancel button; never the internal reason for a removal or an exit.
      const reason = input.leftProcess || input.cause === "interviewer_removed" ? null : input.reason;
      const sent = await sendInterviewCancelled(tx, container.integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor, appBaseUrl: container.env.APP_BASE_URL, interview: { ...iv, status: "cancelled" }, interviewerFirstNames: [], candidateTimezone: iv.schedulingWindow.candidateTimezone ?? cand.location?.timezone ?? company.timezone, companyTimezone: company.timezone, byCandidate: !!input.byCandidate, reason, leftProcess: !!input.leftProcess });
      noteWritten = true;
      candidateTold = onItsWay(sent);
      held = sent.status === "pending" && sent.reason === HELD_REASON;
    }
  }
  await emit(tx, { type: "interview.cancelled", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { reason: input.reason, byCandidate: !!input.byCandidate, hadEvents, candidateTold: noteWritten, ...(neverHeard ? { neverHeard: true } : {}), ...(input.cause ? { cause: input.cause } : {}) } });
  if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: iv.id, companyId, actor }, runAt: input.now.toISOString(), maxAttempts: 5 });
  return { hadEvents, candidateTold, held };
}

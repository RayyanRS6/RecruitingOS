import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit, notify, transition } from "@ros/core";
import { sendInterviewCancelled } from "@ros/agents";
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
 * and the attempt change, so a scheduling run still going ends on its own at its next step; a candidate at "Interview
 * booked" goes back to "Interview approved" so the team can approve a new one; the interviewers still on it are told;
 * the candidate is told through the outbox as `notice` says; calendar events are queued for removal by the worker. The
 * candidate's link keeps working and says the interview was cancelled, instead of a bare "not found".
 * `leftProcess`: the application left the process, so the candidate's note carries no reason and promises nothing.
 * `interviewerNote`: what the interviewers read, when the recorded reason is not written for them.
 */
export async function cancelInterviewInTx(
  tx: Tx,
  container: Container,
  input: { companyId: string; interview: InterviewRow; actor: Actor; by: Mover; reason: string | null; byCandidate?: boolean; cause?: string; now: Date; notice?: CancelNotice; leftProcess?: boolean; interviewerNote?: string },
): Promise<{ hadEvents: boolean; candidateTold: boolean }> {
  const { companyId, actor } = input;
  const iv = input.interview;
  const hadEvents = Object.keys((iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  const knows = candidateKnows(iv);
  const tell = (input.notice ?? "known") === "known" && (knows.booked || knows.offered);
  const [app] = await tx.select().from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
  await tx.update(interviews).set({ status: "cancelled", cancelReason: input.reason, attempt: iv.attempt + 1 }).where(eq(interviews.id, iv.id));
  if (app?.stage === "interview_scheduled") await transition(tx, { applicationId: app.id, companyId, to: "interview_recommended", by: input.by, actor, reason: "interview cancelled" });
  const parts = await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
  // With nobody left on the interview there is no interviewer to tell; the caller tells the owners itself.
  if (parts.length) await notify(tx, { companyId, kind: "interview.cancelled", title: `Interview cancelled: ${iv.title}`, body: input.interviewerNote ?? input.reason ?? "Cancelled.", action: { label: "Open interviews", href: "/interviews" }, userIds: parts.map((p) => p.userId) });
  let candidateTold = false;
  if (tell && app) {
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
    const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    if (cand && role && company && pv) {
      // The team's own words reach the candidate only from the Cancel button; never the internal reason for a removal or an exit.
      const reason = input.leftProcess || input.cause === "interviewer_removed" ? null : input.reason;
      await sendInterviewCancelled(tx, container.integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor, appBaseUrl: container.env.APP_BASE_URL, interview: { ...iv, status: "cancelled" }, interviewerFirstNames: [], candidateTimezone: iv.schedulingWindow.candidateTimezone ?? cand.location?.timezone ?? company.timezone, companyTimezone: company.timezone, byCandidate: !!input.byCandidate, reason, leftProcess: !!input.leftProcess });
      candidateTold = true;
    }
  }
  await emit(tx, { type: "interview.cancelled", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { reason: input.reason, byCandidate: !!input.byCandidate, hadEvents, candidateTold, ...(input.cause ? { cause: input.cause } : {}) } });
  if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: iv.id, companyId, actor }, runAt: input.now.toISOString(), maxAttempts: 5 });
  return { hadEvents, candidateTold };
}

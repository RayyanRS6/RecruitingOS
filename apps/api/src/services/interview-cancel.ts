import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit, notify, transition } from "@ros/core";
import { sendInterviewCancelled } from "@ros/agents";
import { applications, candidates, companies, interviewParticipants, interviews, jobs, rolePackets, roles, type Tx } from "@ros/db";
import type { Container } from "../container";

type InterviewRow = typeof interviews.$inferSelect;
type Mover = Parameters<typeof transition>[1]["by"];

/**
 * Cancels one interview inside the caller's tenant transaction, the same way whoever asks for it (the Cancel button, a
 * team member's removal that left the interview with nobody to run it). The status and the attempt change, so a
 * scheduling run still going ends on its own at its next step; a candidate at "Interview booked" goes back to
 * "Interview approved" so the team can approve a new one; the interviewers still on it are told; a candidate who had a
 * booked time gets the cancellation through the outbox; calendar events are queued for removal by the worker.
 */
export async function cancelInterviewInTx(
  tx: Tx,
  container: Container,
  input: { companyId: string; interview: InterviewRow; actor: Actor; by: Mover; reason: string | null; byCandidate?: boolean; cause?: string; now: Date },
): Promise<{ hadEvents: boolean; candidateTold: boolean }> {
  const { companyId, actor } = input;
  const iv = input.interview;
  const hadEvents = Object.keys((iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
  const [app] = await tx.select().from(applications).where(eq(applications.id, iv.applicationId)).limit(1);
  await tx.update(interviews).set({ status: "cancelled", cancelReason: input.reason, attempt: iv.attempt + 1, scheduleToken: null, scheduleTokenExpiresAt: null }).where(eq(interviews.id, iv.id));
  await emit(tx, { type: "interview.cancelled", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { reason: input.reason, byCandidate: !!input.byCandidate, hadEvents, ...(input.cause ? { cause: input.cause } : {}) } });
  if (app?.stage === "interview_scheduled") await transition(tx, { applicationId: app.id, companyId, to: "interview_recommended", by: input.by, actor, reason: "interview cancelled" });
  const parts = await tx.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
  // With nobody left on the interview there is no interviewer to tell; the caller tells the owners itself.
  if (parts.length) await notify(tx, { companyId, kind: "interview.cancelled", title: `Interview cancelled: ${iv.title}`, body: input.reason ?? "Cancelled.", action: { label: "Open interviews", href: "/interviews" }, userIds: parts.map((p) => p.userId) });
  let candidateTold = false;
  if (iv.startsAt && app) {
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
    const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    if (cand && role && company && pv) {
      await sendInterviewCancelled(tx, container.integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor, appBaseUrl: container.env.APP_BASE_URL, interview: { ...iv, status: "cancelled" }, interviewerFirstNames: [], candidateTimezone: iv.schedulingWindow.candidateTimezone ?? cand.location?.timezone ?? company.timezone, companyTimezone: company.timezone, byCandidate: !!input.byCandidate, reason: input.reason });
      candidateTold = true;
    }
  }
  if (hadEvents) await tx.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: iv.id, companyId, actor }, runAt: input.now.toISOString(), maxAttempts: 5 });
  return { hadEvents, candidateTold };
}

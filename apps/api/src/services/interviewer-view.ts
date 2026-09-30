import { and, desc, eq } from "drizzle-orm";
import type { Actor, MembershipRole } from "@ros/contracts";
import { STAGE_LABEL, audit, can, ownerGroup } from "@ros/core";
import { composeInterviewerBrief, redactBriefPay, type InterviewerBrief } from "@ros/agents";
import { applications, candidates, interviewParticipants, interviews, rolePackets, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";

/**
 * What an interviewer may see (docs/spec/21 F7 and F8). An interviewer holds no application.read; they may still open
 * the candidates they are interviewing, and what they get is the brief: the round, what it covers, what the evidence
 * says so far. Pay is left out unless their role may see it; the assessment's internal rationale, the candidate's
 * contact details, the messages and the actions never appear.
 */
type App = typeof applications.$inferSelect;
type InterviewRow = typeof interviews.$inferSelect;

/** The interviews of one application the person is on, newest first. */
export async function participantInterviews(tx: Tx, input: { applicationId: string; userId: string }): Promise<InterviewRow[]> {
  const rows = await tx.select({ iv: interviews }).from(interviews).innerJoin(interviewParticipants, eq(interviewParticipants.interviewId, interviews.id)).where(and(eq(interviews.applicationId, input.applicationId), eq(interviewParticipants.userId, input.userId))).orderBy(desc(interviews.createdAt));
  return rows.map((r) => r.iv);
}

/** The brief for one interview, with pay only for roles that hold compensation.read. Null when the packet no longer has the round. */
export async function interviewBriefFor(tx: Tx, input: { interview: Pick<InterviewRow, "applicationId" | "roundKey">; viewerRole: MembershipRole | null }): Promise<InterviewerBrief | null> {
  const [app] = await tx.select().from(applications).where(eq(applications.id, input.interview.applicationId)).limit(1);
  if (!app) return null;
  const [cand] = await tx.select({ firstName: candidates.firstName }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!pv) return null;
  const brief = await composeInterviewerBrief(tx, { applicationId: app.id, candidateFirstName: cand?.firstName ?? "the candidate", packet: pv.packet, roundKey: input.interview.roundKey });
  if (!brief) return null;
  return can(input.viewerRole, "compensation.read") ? brief : redactBriefPay(brief);
}

/** GET /applications/:id for an interviewer: 403 unless they are on one of its interviews; otherwise the brief and little else. */
export async function interviewerApplicationView(tx: Tx, input: { app: App; tenant: Tenant; actor: Actor }) {
  const mine = await participantInterviews(tx, { applicationId: input.app.id, userId: input.tenant.userId });
  if (!mine.length) throw new HttpError(403, "forbidden", "You can open the candidates you are interviewing only.");
  const [cand] = await tx.select({ firstName: candidates.firstName, lastName: candidates.lastName }).from(candidates).where(eq(candidates.id, input.app.candidateId)).limit(1);
  await audit(tx, { companyId: input.tenant.companyId, actor: input.actor, action: "candidate.viewed", target: { type: "application", id: input.app.id }, reason: "interviewer brief" });
  const current = mine.find((i) => ["proposed", "scheduling", "scheduled"].includes(i.status)) ?? mine[0];
  const brief = await interviewBriefFor(tx, { interview: current, viewerRole: input.tenant.role });
  return {
    id: input.app.id,
    roleId: input.app.roleId,
    stage: input.app.stage,
    stageLabel: STAGE_LABEL[input.app.stage],
    group: ownerGroup(input.app.stage),
    createdAt: input.app.createdAt,
    viewer: "interviewer" as const,
    allowedActions: [] as string[],
    candidate: { firstName: cand?.firstName ?? "", lastName: cand?.lastName ?? "" },
    interviews: mine.map((i) => ({ id: i.id, roundKey: i.roundKey, title: i.title, status: i.status, startsAt: i.startsAt, endsAt: i.endsAt, timezone: i.timezone, meetingUrl: i.meetingUrl, attempt: i.attempt, outcome: i.outcome, decision: i.decision, createdAt: i.createdAt })),
    brief,
  };
}

import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { detectStuckRoles, runInterventionLadder, runUntoldSafetyNet, sendStillReviewingNotes } from "@ros/agents";
import { emit, notify } from "@ros/core";
import { applications, approvalRequests, companies, events, roles } from "@ros/db";
import type { StepContext, WorkflowDefinition } from "../types";
import { DEFAULT_VOLUME_ALERT_PER_DAY, localDays } from "../volume-days";
import { startInterviewAgain } from "../with-application";
import { startNotificationDigest } from "./notification-digest";

type VolumeAlert = { roleId: string; day: string; count: number; threshold: number };
type State = { companyId: string; lastRunAt?: string; lastResults?: unknown; lastVolumeAlerts?: VolumeAlert[]; lastSafetyNet?: unknown; lastStillReviewing?: number };

const EVERY_HOURS = 24;

/**
 * docs/06 `stuck_role_detector`: one run per company, forever. Retires old invite suggestions (`retireInviteSuggestions`),
 * detects, applies the intervention ladder, runs the untold
 * safety net (Q27: a decision nobody told for five working days) and the "still reviewing" notes (plan G10), checks
 * yesterday's application volume, sleeps a day. Started when the company is created; idempotent by company.
 */
export const stuckRoleDetector: WorkflowDefinition<State> = {
  key: "stuck_role_detector",
  version: 1,
  initialStep: "detect",
  maxAttempts: 5,
  escalationKind: "stuck_role",
  steps: {
    async detect(ctx) {
      // The company's morning email summaries (plan B3) run beside this check: a company that existed before them gets
      // its run on its next daily check, a new one on its first.
      await startNotificationDigest(ctx.services.engine, ctx.q, ctx.companyId, ctx.actor);
      await retireInviteSuggestions(ctx);
      const detections = await detectStuckRoles(ctx.q, ctx.companyId, ctx.now);
      const results = await runInterventionLadder(ctx.q, { integrations: ctx.services.integrations, appBaseUrl: ctx.services.env.appBaseUrl, itsQueueEmail: ctx.services.env.itsQueueEmail, now: ctx.now, actor: ctx.actor }, ctx.companyId, detections);
      // The candidate's status link lives on the job-page host, like the acknowledgment's.
      const courtesy = { integrations: ctx.services.integrations, statusBaseUrl: ctx.services.env.jobsBaseUrl, now: ctx.now, actor: { kind: "system" as const, id: "untold_safety_net" } };
      const safetyNet = await runUntoldSafetyNet(ctx.q, courtesy, ctx.companyId);
      const stillReviewing = await sendStillReviewingNotes(ctx.q, { ...courtesy, actor: { kind: "system", id: "still_reviewing" } }, ctx.companyId);
      const volumeAlerts = await checkApplicationVolume(ctx);
      const until = new Date(ctx.now.getTime() + EVERY_HOURS * 3600_000).toISOString();
      return { kind: "wait", wait: { kind: "timer", until, reason: "daily stuck-role check" }, state: { lastRunAt: ctx.now.toISOString(), lastResults: results, lastVolumeAlerts: volumeAlerts, lastSafetyNet: safetyNet, lastStillReviewing: stillReviewing.length }, resumeStep: "detect" };
    },
  },
};

/**
 * 20 October 2026 (R20-4): an "Invite to a screening chat?" suggestion from before then, still waiting, is no decision
 * any more (Home no longer shows it). On the company's next daily check it is cancelled, the intake waiting on it is
 * woken (it ends with nothing sent), and the applicant gets every applicant's AI interview by itself, as if they had
 * applied now. Nothing new is ever suggested, so this finds nothing after that.
 */
async function retireInviteSuggestions(ctx: StepContext<State>): Promise<void> {
  const waiting = await ctx.q.select({ id: approvalRequests.id, applicationId: approvalRequests.applicationId, workflowRunId: approvalRequests.workflowRunId }).from(approvalRequests).where(and(eq(approvalRequests.companyId, ctx.companyId), eq(approvalRequests.actionType, "application.invite_screen"), eq(approvalRequests.status, "pending")));
  for (const p of waiting) {
    await ctx.q.update(approvalRequests).set({ status: "cancelled", decidedAt: ctx.now.toISOString(), decisionNote: "Every applicant now gets the AI interview by itself, so this no longer waits for you." }).where(eq(approvalRequests.id, p.id));
    await emit(ctx.q, { type: "approval.cancelled", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: "application.invite_screen", applicationId: p.applicationId, by: "every_applicant_interviewed" }, correlationId: p.workflowRunId });
    await ctx.services.engine.signal(ctx.q, { companyId: ctx.companyId, key: `approval:${p.id}`, payload: { decision: "cancelled" } });
    if (p.applicationId) await startInterviewAgain(ctx.q, ctx.services.engine, { companyId: ctx.companyId, applicationId: p.applicationId, actor: ctx.actor, now: ctx.now });
  }
}

/**
 * The volume alert (docs/spec/20 items 16 and 17): for each open role, yesterday's applications are counted; above the
 * role's limit the owner is told once for that day (`volume.high`, with the way to the Posting tab and its switch) and
 * `role.volume_high` is recorded. "Yesterday" is a calendar day in the company's own time zone, the same cut the
 * volume report uses. Counting only: no application is touched and nobody is turned away.
 */
async function checkApplicationVolume(ctx: StepContext<State>): Promise<VolumeAlert[]> {
  const [company] = await ctx.q.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
  const days = localDays(ctx.now, company?.timezone);
  const todayStart = days.start(0);
  const yesterdayStart = days.start(-1);
  const day = days.key(yesterdayStart);
  const open = await ctx.q.select().from(roles).where(and(eq(roles.companyId, ctx.companyId), eq(roles.status, "open")));
  const alerts: VolumeAlert[] = [];
  for (const role of open) {
    const threshold = role.volumeAlertPerDay ?? DEFAULT_VOLUME_ALERT_PER_DAY;
    const [row] = await ctx.q.select({ n: count() }).from(applications).where(and(eq(applications.roleId, role.id), gte(applications.createdAt, yesterdayStart.toISOString()), lt(applications.createdAt, todayStart.toISOString())));
    const received = Number(row?.n ?? 0);
    if (received <= threshold) continue;
    // once per day: an alert already recorded for this role and this day is not repeated by a retried step or a second worker
    const already = await ctx.q.select({ id: events.id }).from(events).where(and(eq(events.companyId, ctx.companyId), eq(events.type, "role.volume_high"), eq(events.subjectType, "role"), eq(events.subjectId, role.id), sql`${events.payload}->>'day' = ${day}`)).limit(1);
    if (already.length) continue;
    await notify(ctx.q, {
      companyId: ctx.companyId,
      kind: "volume.high",
      title: `${received} people applied to ${role.title} yesterday`,
      body: `That is above your limit of ${threshold} a day. Nobody is turned away automatically. If you have enough applicants, stop accepting applications from the Share tab; everyone who already applied stays in the process.`,
      action: { label: "Open the Share tab", href: `/roles/${role.id}?tab=posting` },
      roles: ["owner", "admin"],
    });
    await emit(ctx.q, { type: "role.volume_high", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "role", id: role.id }, payload: { day, count: received, threshold } });
    alerts.push({ roleId: role.id, day, count: received, threshold });
  }
  return alerts;
}

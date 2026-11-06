import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { CLOSE_OUT_TEMPLATE } from "@ros/agents";
import type { Actor } from "@ros/contracts";
import { audit, emit, entitlements, evaluateEligibility, lockApplicants, lockedAndWaiting, transition } from "@ros/core";
import { applications, communications, rolePackets, roles, workflowRuns, type Tx } from "@ros/db";
import type { WorkflowEngine } from "./engine";
import { intakeOn } from "./with-application";

/** The interview's link goes by itself only to someone who applied less than this long ago: older, a person decides. */
export const UNLOCK_INTERVIEW_DAYS = 60;
/** A close-out note that left us: they were told it was not reviewed, so software does not write to them now. */
const CLOSE_OUT_LEFT = ["sending", "sent", "delivered", "opened", "clicked", "unknown"];

/**
 * A change of plan (the plans of 5 November 2026, Rule 2) opens the people locked on each job, oldest first, up to the new
 * limit (the limit less everyone the team can already read; no limit means everyone), each with one event and one audit line
 * saying why, and never a name. A move down opens nobody and locks nobody: `locked_at` is only ever set when an application
 * is created. Someone who withdrew or was deleted while locked is not opened, uses no room and stays as they are (`lockedAndWaiting`).
 *
 * Someone opened while the job is open, who applied under `UNLOCK_INTERVIEW_DAYS` ago and was not told it was not reviewed,
 * goes on as if they had just applied: an intake starts, comes through its scan and its AI notice again, reads the résumé on
 * the new plan's credit, and the interview's link goes by itself in an email of its own ("Thanks again for applying"; their
 * one email went already). The worker takes runs one at a time, so a large upgrade reaches the AI and the mail one by one.
 * Anyone else is simply visible, with no email: the answers on their form are read in code, so a must-have "No" is held for a
 * person as it always is, and the rest wait for the team's review. Someone who left, or whom a closed job moved, stays where
 * they are.
 *
 * Runs in the transaction that changed the plan, behind each job's lock, so an application being decided at this moment takes
 * its place before this or under the new limit after it. Returns how many were opened, and how many of them go on to the
 * interview by themselves.
 */
export async function unlockApplicants(q: Tx, engine: Pick<WorkflowEngine, "start">, input: { companyId: string; planKey: string; actor: Actor; reason: string; now: Date }): Promise<{ unlocked: number; interviews: number }> {
  const { companyId, planKey, actor, now } = input;
  const limit = await entitlements.limitOf(q, companyId, entitlements.CANDIDATES_PER_JOB);
  const jobs = await q.selectDistinct({ roleId: applications.roleId }).from(applications).where(and(eq(applications.companyId, companyId), isNotNull(applications.lockedAt))).orderBy(asc(applications.roleId));
  let unlocked = 0;
  let interviews = 0;
  for (const { roleId } of jobs) {
    await lockApplicants(q, roleId);
    const [visible] = await q.select({ n: count() }).from(applications).where(and(eq(applications.roleId, roleId), isNull(applications.lockedAt)));
    const room = limit === null ? null : limit - Number(visible?.n ?? 0);
    if (room !== null && room <= 0) continue;
    const waiting = q.select({ id: applications.id, stage: applications.stage, createdAt: applications.createdAt, packetVersion: applications.packetVersion, answers: applications.answers }).from(applications).where(and(eq(applications.roleId, roleId), lockedAndWaiting())).orderBy(asc(applications.lockedAt), asc(applications.createdAt), asc(applications.id));
    const opening = room === null ? await waiting : await waiting.limit(room);
    if (!opening.length) continue;
    const [role] = await q.select({ status: roles.status }).from(roles).where(eq(roles.id, roleId)).limit(1);
    const noted = new Set((await q.select({ id: communications.applicationId }).from(communications).where(and(inArray(communications.applicationId, opening.map((a) => a.id)), eq(communications.templateKey, CLOSE_OUT_TEMPLATE), inArray(communications.status, CLOSE_OUT_LEFT)))).map((r) => r.id));
    for (const app of opening) {
      await q.update(applications).set({ lockedAt: null }).where(eq(applications.id, app.id));
      unlocked += 1;
      const inProcess = app.stage === "applied" || app.stage === "received";
      const interview = inProcess && role?.status === "open" && !noted.has(app.id) && now.getTime() - Date.parse(app.createdAt) < UNLOCK_INTERVIEW_DAYS * 86_400_000;
      if (interview) interviews += 1;
      const why = { cause: "plan_changed", plan: planKey, limit, interview, at: now.toISOString() };
      await emit(q, { type: "application.unlocked", companyId, actor, subject: { type: "application", id: app.id }, payload: why });
      await audit(q, { companyId, actor, action: "application.unlocked", target: { type: "application", id: app.id }, reason: input.reason, details: why });
      if (!inProcess) continue;
      // Its first intake is still on (a scan that waits): it reads the row again where it would have stopped, and goes on.
      if (await intakeOn(q, app.id)) continue;
      if (interview) {
        const [first] = await q.select({ state: workflowRuns.state }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `application_intake:${app.id}`)).limit(1);
        const formUploadId = (first?.state as { formUploadId?: string } | undefined)?.formUploadId;
        await engine.start(q, { workflowKey: "application_intake", companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId, ...(formUploadId ? { formUploadId } : {}) }, idempotencyKey: `application_intake:${app.id}:unlocked`, actor });
      } else {
        await settleWithoutReading(q, { ...app, companyId, roleId }, { actor, now });
      }
    }
  }
  return { unlocked, interviews };
}

/**
 * Someone opened with no interview to follow: nothing is read by AI and nothing is sent. In code, as the intake would: the
 * answers on their form are checked, and they leave "AI interview being prepared", which would never come, for a must-have
 * hold or the team's review. It starts no reminder: the team reads them on the board, from today.
 */
async function settleWithoutReading(q: Tx, app: { id: string; companyId: string; roleId: string; stage: string; packetVersion: number; answers: { eligibility?: unknown } }, at: { actor: Actor; now: Date }): Promise<void> {
  const [pv] = await q.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!pv) return;
  const moved = { applicationId: app.id, companyId: app.companyId, by: "system" as const, actor: at.actor, now: at.now };
  if (app.stage === "applied") await transition(q, { ...moved, to: "received" });
  const result = evaluateEligibility(pv.packet.requirements.eligibility, (app.answers.eligibility ?? {}) as Record<string, unknown>, at.now);
  await q.update(applications).set({ eligibility: result }).where(eq(applications.id, app.id));
  await emit(q, { type: "eligibility.evaluated", companyId: app.companyId, actor: at.actor, subject: { type: "application", id: app.id }, payload: { passed: result.passed, failed: result.failedRules.map((f) => f.key), unverifiable: result.unverifiable.map((u) => u.key) } });
  if (result.passed) {
    await transition(q, { ...moved, to: "triaged", reason: "opened by a change of plan, with no AI reading: manual review" });
    await emit(q, { type: "application.triaged", companyId: app.companyId, actor: at.actor, subject: { type: "application", id: app.id }, payload: { assessmentId: null, recommendation: "review_manually", reason: "opened by a change of plan" } });
    return;
  }
  await transition(q, { ...moved, to: "ineligible", reason: result.failedRules.map((f) => f.reason).join("; ") });
  await emit(q, { type: "application.ineligible", companyId: app.companyId, actor: at.actor, subject: { type: "application", id: app.id }, payload: { failedRules: result.failedRules } });
}

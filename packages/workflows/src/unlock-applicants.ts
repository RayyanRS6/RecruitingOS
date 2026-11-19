import { and, asc, count, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { audit, emit, lockApplicants, lockedAndWaiting } from "@ros/core";
import { applications, roles, workflowRuns, type Tx } from "@ros/db";
import type { WorkflowEngine } from "./engine";

const ENDED_RUN = ["completed", "failed", "cancelled"];

/**
 * A change of plan opens the people past the old plan's candidates per job, on each job oldest first, up to the new
 * limit (the limit less everyone the team can already read; no limit means everyone), each with one event and one audit
 * line saying why, and never a name. A move down opens nobody and locks nobody: `locked_at` is only ever set when an
 * application is created. Someone who withdrew or was deleted while locked is not opened, uses no room and stays as they
 * are (`lockedAndWaiting`).
 *
 * Someone opened goes on as if they had just applied: an intake starts and reads their CV on the new plan's AI help. No
 * email goes: their one email went when they applied. The worker takes runs one at a time, so a large upgrade reaches
 * the AI one by one.
 *
 * Runs in the transaction that changed the plan, behind each job's lock, so an application being decided at this moment
 * takes its place before this or under the new limit after it. Every job of the company, also one with nobody locked
 * yet: the first person past the limit may be being decided right now, on the old limit, in a transaction nothing here
 * can see. First the jobs that had someone locked when they were listed, in id order, because opening people takes a
 * while and those jobs' applicants wait for it anyway; then the others, so a job with nobody to open is held only for
 * the short rest of the transaction. `limit` is the new plan's own: the caller writes the plan's rows after this.
 * Returns how many were opened, and for how many of them a CV reading started.
 */
export async function unlockApplicants(q: Tx, engine: Pick<WorkflowEngine, "start">, input: { companyId: string; planKey: string; limit: number | null; actor: Actor; reason: string; now: Date }): Promise<{ unlocked: number; reading: number }> {
  const { companyId, planKey, limit, actor, now } = input;
  const jobs = await q.select({ roleId: roles.id }).from(roles).where(eq(roles.companyId, companyId)).orderBy(asc(roles.id));
  const lockedOn = new Set((await q.selectDistinct({ roleId: applications.roleId }).from(applications).where(and(eq(applications.companyId, companyId), lockedAndWaiting()))).map((r) => r.roleId));
  let unlocked = 0;
  let reading = 0;
  for (const { roleId } of [...jobs.filter((j) => lockedOn.has(j.roleId)), ...jobs.filter((j) => !lockedOn.has(j.roleId))]) {
    await lockApplicants(q, roleId);
    const [visible] = await q.select({ n: count() }).from(applications).where(and(eq(applications.roleId, roleId), isNull(applications.lockedAt)));
    const room = limit === null ? null : limit - Number(visible?.n ?? 0);
    if (room !== null && room <= 0) continue;
    const waiting = q.select({ id: applications.id, stage: applications.stage }).from(applications).where(and(eq(applications.roleId, roleId), lockedAndWaiting())).orderBy(asc(applications.lockedAt), asc(applications.createdAt), asc(applications.id));
    const opening = room === null ? await waiting : await waiting.limit(room);
    for (const app of opening) {
      await q.update(applications).set({ lockedAt: null }).where(eq(applications.id, app.id));
      unlocked += 1;
      const reads = app.stage === "applied" || app.stage === "received";
      const why = { cause: "plan_changed", plan: planKey, limit, reading: reads, at: now.toISOString() };
      await emit(q, { type: "application.unlocked", companyId, actor, subject: { type: "application", id: app.id }, payload: why });
      await audit(q, { companyId, actor, action: "application.unlocked", target: { type: "application", id: app.id }, reason: input.reason, details: why });
      if (!reads) continue;
      reading += 1;
      // Its first intake is still on (a scan that waits): it reads the row again where it would have stopped, and goes on.
      const [on] = await q.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "application_intake"), notInArray(workflowRuns.status, ENDED_RUN), sql`${workflowRuns.subject}->>'id' = ${app.id}`)).limit(1);
      if (!on) await engine.start(q, { workflowKey: "application_intake", companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId }, idempotencyKey: `application_intake:${app.id}:unlocked`, actor });
    }
  }
  return { unlocked, reading };
}

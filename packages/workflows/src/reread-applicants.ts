import { and, eq, notInArray } from "drizzle-orm";
import { inProcess, type Actor } from "@ros/contracts";
import { notLocked } from "@ros/core";
import { applications, workflowRuns, type Tx } from "@ros/db";
import type { WorkflowEngine } from "./engine";

const ENDED_RUN = ["completed", "failed", "cancelled"];

/**
 * A job's must-haves or skills changed: everyone still in the process on that job is read again, against the version
 * live now (`version`), so one list is never ranked against two sets of requirements. Each gets a run of the intake that
 * starts at the reading: their file is already checked, and the facts of their CV are kept. It spends the company's AI
 * help like a first reading; with none left the run waits and reads them when it returns. Until their new reading is
 * stored, their CV score says it was scored against an earlier version of the job.
 *
 * Someone whose intake is still on gets no second run: it reads against the version live when it reads. Nobody past the
 * plan's candidates per job is read, and nobody who was hired, marked Not selected or withdrew. Call it in the
 * transaction that made the version live. Returns how many readings were started.
 */
export async function rereadApplicants(q: Tx, engine: Pick<WorkflowEngine, "start">, input: { companyId: string; roleId: string; version: number; actor: Actor }): Promise<number> {
  const people = await q.select({ id: applications.id, stage: applications.stage }).from(applications).where(and(eq(applications.roleId, input.roleId), notLocked()));
  const stillOn = await q.select({ subject: workflowRuns.subject }).from(workflowRuns).where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.workflowKey, "application_intake"), notInArray(workflowRuns.status, ENDED_RUN)));
  const beingRead = new Set(stillOn.map((run) => run.subject.id));
  let started = 0;
  for (const person of people) {
    if (!inProcess(person.stage) || beingRead.has(person.id)) continue;
    const run = await engine.start(q, { workflowKey: "application_intake", companyId: input.companyId, subject: { type: "application", id: person.id }, state: { applicationId: person.id, roleId: input.roleId }, idempotencyKey: `application_intake:${person.id}:v${input.version}`, startStep: "extract", actor: input.actor });
    if (run.created) started += 1;
  }
  return started;
}

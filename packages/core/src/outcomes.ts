import { and, eq, isNull } from "drizzle-orm";
import type { Actor, ApplicationStage } from "@ros/contracts";
import { applications, hiringOutcomes, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { emit } from "./events";
import { transition, undoDecision } from "./stages";

/**
 * Hiring someone, and taking it back. A person on the team marks a candidate Hired; the hire is one row in
 * `hiring_outcomes` with who recorded it and when. Nothing is emailed, and the software never hires anyone. Undo keeps
 * the row, marked as taken back, so the record shows both.
 */

/** The outcome a hire is recorded under. */
export const HIRE_OUTCOME = "hired_externally";
/** Beside a hire that was taken back with Undo. */
export const HIRE_TAKEN_BACK = "Taken back by the team";

/** Marks the application Hired and records the hire. The caller holds the application's row. */
export async function recordHire(q: Queryable, input: { companyId: string; applicationId: string; actor: Actor; now: Date }): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  const moved = await transition(q, { applicationId: input.applicationId, companyId: input.companyId, to: "hired", by: "team", actor: input.actor, now: input.now });
  if (moved.from === "hired") return moved;
  const [app] = await q.select({ roleId: applications.roleId }).from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  const [row] = await q.insert(hiringOutcomes).values({ companyId: input.companyId, applicationId: input.applicationId, roleId: app?.roleId ?? null, milestone: "final", outcome: HIRE_OUTCOME, details: { stageFrom: moved.from, stageTo: moved.to }, recordedBy: input.actor, recordedAt: input.now.toISOString() }).returning({ id: hiringOutcomes.id });
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "outcome.recorded", target: { type: "application", id: input.applicationId }, reason: HIRE_OUTCOME, details: { outcomeId: row.id, outcome: HIRE_OUTCOME, stageFrom: moved.from, stageTo: moved.to } });
  await emit(q, { type: "outcome.recorded", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { outcome: HIRE_OUTCOME, level: "application", outcomeId: row.id, roleId: app?.roleId ?? null, stageFrom: moved.from, stageTo: moved.to } });
  return moved;
}

/**
 * Takes a decision back (`undoDecision`). For a hire, its record is kept and marked as taken back by this person, so a
 * later hire of the same candidate is recorded as a new one.
 */
export async function takeBackDecision(q: Queryable, input: { companyId: string; applicationId: string; actor: Actor; now: Date }): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  const moved = await undoDecision(q, { applicationId: input.applicationId, companyId: input.companyId, actor: input.actor, now: input.now });
  if (moved.from === "hired") {
    await q.update(hiringOutcomes).set({ correctedAt: input.now.toISOString(), correctedBy: input.actor, correctionReason: HIRE_TAKEN_BACK }).where(and(eq(hiringOutcomes.applicationId, input.applicationId), eq(hiringOutcomes.outcome, HIRE_OUTCOME), isNull(hiringOutcomes.correctedAt)));
  }
  return moved;
}

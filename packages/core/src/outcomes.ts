import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor, ApplicationStage } from "@ros/contracts";
import { applications, hiringOutcomes, recruiterEscalations, roles, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { emit } from "./events";
import { transition } from "./stages";

const ACTIVE_STAGES = new Set<ApplicationStage>(["applied", "received", "ineligible", "eligible", "triaged", "screen_invited", "screening", "screen_complete", "interview_recommended", "interview_scheduled", "interview_complete", "debrief", "finalist", "reference_check", "offer_draft", "offer_approval", "offer_sent", "negotiation", "accepted", "onboarding"]);

/**
 * Human-recorded hiring outcomes (founder instruction of 21 September 2026, item 4). A decision-maker records what
 * happened, usually outside the platform: a hire, a withdrawal, a decline, a role cancelled or filled elsewhere. The
 * platform never generates, approves or transmits an offer, and this module holds no payroll, tax, identity, banking or
 * onboarding data. Every record names the person who recorded it and can only be corrected by an audited administrator
 * action that leaves the original row in place.
 */
export type ApplicationOutcome = "hired_externally" | "candidate_withdrew" | "employer_declined" | "offer_declined_externally" | "no_hire";
export type RoleOutcome = "filled" | "filled_outside_platform" | "role_cancelled" | "no_hire";
export type OutcomeRow = typeof hiringOutcomes.$inferSelect;
type Mover = Parameters<typeof transition>[1]["by"];

export const OUTCOME_STAGE: Record<ApplicationOutcome, ApplicationStage> = {
  hired_externally: "hired",
  candidate_withdrew: "withdrawn",
  employer_declined: "rejected",
  offer_declined_externally: "declined",
  no_hire: "talent_pool",
};

/** The sentence shown next to every outcome so nobody reads it as something the platform did. */
export const OUTCOME_STATEMENT = "Recorded by a person. Any offer, acceptance or decline happened outside Recruiting OS; the platform did not generate, approve or send it.";

export class OutcomeError extends Error {
  constructor(public readonly code: "hire_date_required" | "reason_required" | "not_found" | "already_closed" | "already_corrected" | "already_recorded" | "not_active" | "bad_outcome", message: string) {
    super(message);
  }
}

export async function recordApplicationOutcome(
  q: Queryable,
  input: { companyId: string; applicationId: string; outcome: ApplicationOutcome; by: Mover; actor: Actor; hireDate?: string; offerAcceptedAt?: string; reason?: string; note?: string; now?: Date },
): Promise<{ row: OutcomeRow; from: ApplicationStage; to: ApplicationStage; roleId: string; roleStillOpen: boolean; app: typeof applications.$inferSelect }> {
  const now = input.now ?? new Date();
  const [app] = await q.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.companyId, input.companyId))).limit(1);
  if (!app) throw new OutcomeError("not_found", "Application not found.");
  // one outcome per candidate: a closed candidate takes no second outcome (an administrator corrects), except a later hire from the talent pool
  const later = input.outcome === "hired_externally" && app.stage === "talent_pool";
  if (!ACTIVE_STAGES.has(app.stage) && !later) throw new OutcomeError("not_active", "This candidate already has an outcome. An administrator can correct it.");
  const duplicate = await q.select({ id: hiringOutcomes.id }).from(hiringOutcomes).where(and(eq(hiringOutcomes.applicationId, app.id), eq(hiringOutcomes.outcome, input.outcome), isNull(hiringOutcomes.correctedAt))).limit(1);
  if (duplicate.length) throw new OutcomeError("already_recorded", "This outcome is already recorded for this candidate.");
  if (input.outcome === "hired_externally" && !input.hireDate) throw new OutcomeError("hire_date_required", "Enter the hire date (the start date agreed outside the platform).");
  if (input.outcome === "employer_declined" && !input.reason) throw new OutcomeError("reason_required", "Say why the employer declined; it is recorded with your name.");
  const to = OUTCOME_STAGE[input.outcome];
  const moved = await transition(q, { applicationId: app.id, companyId: input.companyId, to, by: input.by, actor: input.actor, reason: input.outcome, payload: { outcome: input.outcome, recordedOutsidePlatform: true } });
  const [row] = await q.insert(hiringOutcomes).values({
    companyId: input.companyId, applicationId: app.id, roleId: app.roleId, milestone: "final", outcome: input.outcome, notes: input.note ?? null,
    hireDate: input.outcome === "hired_externally" ? input.hireDate ?? null : null, offerAcceptedAt: input.outcome === "hired_externally" ? input.offerAcceptedAt ?? null : null,
    details: { reason: input.reason ?? null, stageFrom: moved.from, stageTo: moved.to, recordedOutsidePlatform: true },
    recordedBy: input.actor, recordedAt: now.toISOString(),
  }).returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "outcome.recorded", target: { type: "application", id: app.id }, reason: input.reason ?? input.outcome, details: { outcomeId: row.id, outcome: input.outcome, hireDate: row.hireDate, offerAcceptedAt: row.offerAcceptedAt, stageFrom: moved.from, stageTo: moved.to } });
  await emit(q, { type: "outcome.recorded", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { outcome: input.outcome, level: "application", outcomeId: row.id, roleId: app.roleId, stageFrom: moved.from, stageTo: moved.to } });
  await emit(q, { type: "human.override", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: app.id }, payload: { action: "outcome", outcome: input.outcome } });
  const [role] = await q.select({ status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
  return { row, from: moved.from, to: moved.to, roleId: app.roleId, roleStillOpen: !!role && role.status !== "closed", app };
}

/** Closes the role with its outcome. Separate from the candidate outcome on purpose: the founder asked for a second, explicit confirmation. */
export async function recordRoleOutcome(
  q: Queryable,
  input: { companyId: string; roleId: string; outcome: RoleOutcome; by: Mover; actor: Actor; reason?: string; now?: Date },
): Promise<{ row: OutcomeRow; role: typeof roles.$inferSelect; movedToTalentPool: number }> {
  const now = input.now ?? new Date();
  const [role] = await q.select().from(roles).where(and(eq(roles.id, input.roleId), eq(roles.companyId, input.companyId))).limit(1);
  if (!role) throw new OutcomeError("not_found", "Role not found.");
  if (role.status === "closed") throw new OutcomeError("already_closed", "This role is already closed. An administrator can correct its outcome.");
  const closed = await q.update(roles).set({ status: "closed", closedAt: now.toISOString(), closeReason: input.outcome }).where(and(eq(roles.id, role.id), sql`${roles.status} <> 'closed'`)).returning();
  if (!closed.length) throw new OutcomeError("already_closed", "This role was closed a moment ago by someone else.");
  const updated = closed[0];
  // active candidates are kept in the talent pool, as the page promises; hired and closed candidates are untouched
  const open = await q.select({ id: applications.id, stage: applications.stage }).from(applications).where(eq(applications.roleId, role.id));
  let movedToTalentPool = 0;
  for (const a of open) {
    if (!ACTIVE_STAGES.has(a.stage)) continue;
    await transition(q, { applicationId: a.id, companyId: input.companyId, to: "talent_pool", by: input.by, actor: input.actor, reason: `role closed: ${input.outcome}` });
    movedToTalentPool += 1;
  }
  const [row] = await q.insert(hiringOutcomes).values({ companyId: input.companyId, applicationId: null, roleId: role.id, milestone: "role", outcome: input.outcome, notes: input.reason ?? null, details: { reason: input.reason ?? null, previousStatus: role.status, recordedOutsidePlatform: true }, recordedBy: input.actor, recordedAt: now.toISOString() }).returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "role.outcome_recorded", target: { type: "role", id: role.id }, reason: input.reason ?? input.outcome, details: { outcomeId: row.id, outcome: input.outcome, previousStatus: role.status } });
  await emit(q, { type: "role.closed", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { reason: input.outcome } });
  await emit(q, { type: "outcome.recorded", companyId: input.companyId, actor: input.actor, subject: { type: "role", id: role.id }, payload: { outcome: input.outcome, level: "role", outcomeId: row.id, roleId: role.id, movedToTalentPool } });
  return { row, role: updated, movedToTalentPool };
}

/**
 * An administrator corrects a recorded outcome. The original row stays, marked corrected; a new row points back to it;
 * the application returns to the stage the corrected outcome implies (or the stage it had before, when the outcome is voided).
 */
export async function correctOutcome(
  q: Queryable,
  input: { outcomeId: string; actor: Actor; reason: string; outcome?: string; hireDate?: string; offerAcceptedAt?: string; now?: Date },
): Promise<{ original: OutcomeRow; correction: OutcomeRow }> {
  const now = input.now ?? new Date();
  const [original] = await q.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, input.outcomeId)).limit(1);
  if (!original) throw new OutcomeError("not_found", "Outcome not found.");
  if (original.correctedAt) throw new OutcomeError("already_corrected", "This outcome was already corrected; correct the newest record instead.");
  const newOutcome = input.outcome ?? "voided";
  const applicationLevel = !!original.applicationId;
  const allowed = applicationLevel ? [...Object.keys(OUTCOME_STAGE), "voided"] : ["filled", "filled_outside_platform", "role_cancelled", "no_hire", "voided"];
  if (!allowed.includes(newOutcome)) throw new OutcomeError("bad_outcome", `"${newOutcome}" is not a ${applicationLevel ? "candidate" : "role"} outcome.`);
  if (newOutcome === "hired_externally" && !input.hireDate && !original.hireDate) throw new OutcomeError("hire_date_required", "A corrected hire needs the hire date.");
  await q.update(hiringOutcomes).set({ correctedAt: now.toISOString(), correctedBy: input.actor, correctionReason: input.reason }).where(eq(hiringOutcomes.id, original.id));
  const [correction] = await q.insert(hiringOutcomes).values({
    companyId: original.companyId, applicationId: original.applicationId, roleId: original.roleId, milestone: original.milestone, outcome: newOutcome,
    hireDate: input.hireDate ?? (newOutcome === "hired_externally" ? original.hireDate : null), offerAcceptedAt: input.offerAcceptedAt ?? (newOutcome === "hired_externally" ? original.offerAcceptedAt : null),
    details: { ...original.details, correctionReason: input.reason }, correctionOf: original.id, recordedBy: input.actor, recordedAt: now.toISOString(),
  }).returning();
  let stageTo: ApplicationStage | null = null;
  if (original.applicationId) {
    const from = (original.details as { stageFrom?: ApplicationStage }).stageFrom;
    stageTo = Object.hasOwn(OUTCOME_STAGE, newOutcome) ? OUTCOME_STAGE[newOutcome as ApplicationOutcome] : from ?? "talent_pool";
    const stamp = now.toISOString();
    await q.update(applications).set({
      stage: stageTo, stageChangedAt: stamp,
      rejectedAt: stageTo === "rejected" ? stamp : null, rejectReason: stageTo === "rejected" ? "employer_declined" : null,
      withdrawnAt: stageTo === "withdrawn" ? stamp : null, withdrawReason: stageTo === "withdrawn" ? "candidate_withdrew" : null,
    }).where(eq(applications.id, original.applicationId));
    await emit(q, { type: "human.override", companyId: original.companyId, actor: input.actor, subject: { type: "application", id: original.applicationId }, payload: { action: "outcome_corrected", outcome: newOutcome, stageTo } });
  } else if (original.roleId) {
    if (newOutcome === "voided") {
      const previous = (original.details as { previousStatus?: string }).previousStatus ?? "open";
      await q.update(roles).set({ status: previous, closedAt: null, closeReason: null }).where(eq(roles.id, original.roleId));
    } else {
      await q.update(roles).set({ closeReason: newOutcome }).where(eq(roles.id, original.roleId));
    }
  }
  await emit(q, { type: "outcome.corrected", companyId: original.companyId, actor: input.actor, subject: original.applicationId ? { type: "application", id: original.applicationId } : { type: "role", id: original.roleId ?? original.id }, payload: { outcome: newOutcome, previous: original.outcome, level: original.applicationId ? "application" : "role", outcomeId: correction.id, originalId: original.id } });
  await audit(q, { companyId: original.companyId, actor: input.actor, action: "outcome.corrected", target: original.applicationId ? { type: "application", id: original.applicationId } : { type: "role", id: original.roleId ?? original.id }, reason: input.reason, details: { originalId: original.id, correctionId: correction.id, from: original.outcome, to: newOutcome, stageTo } });
  return { original, correction };
}

export async function listOutcomes(q: Queryable, where: { companyId: string; applicationId?: string; roleId?: string }, limit = 50): Promise<OutcomeRow[]> {
  const conds = [eq(hiringOutcomes.companyId, where.companyId)];
  if (where.applicationId) conds.push(eq(hiringOutcomes.applicationId, where.applicationId));
  if (where.roleId) conds.push(eq(hiringOutcomes.roleId, where.roleId));
  return q.select().from(hiringOutcomes).where(and(...conds)).orderBy(desc(hiringOutcomes.recordedAt)).limit(limit);
}

/** Open or claimed recruiter requests about this role or candidate, so the ITS recruiter hears about the outcome. */
export async function openEscalationsFor(q: Queryable, companyId: string, roleId: string, applicationId?: string | null) {
  const rows = await q.select({ id: recruiterEscalations.id, assignedToUserId: recruiterEscalations.assignedToUserId, roleId: recruiterEscalations.roleId, applicationId: recruiterEscalations.applicationId }).from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, companyId), inArray(recruiterEscalations.status, ["open", "claimed"])));
  const onRole = new Set((await q.select({ id: applications.id }).from(applications).where(eq(applications.roleId, roleId))).map((a) => a.id));
  return rows.filter((e) => e.roleId === roleId || (applicationId && e.applicationId === applicationId) || (!applicationId && e.applicationId && onRole.has(e.applicationId)));
}

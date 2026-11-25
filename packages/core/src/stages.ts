import { and, desc, eq, like } from "drizzle-orm";
import { IN_PROCESS_STAGES, inProcess, stageAfterUndo, type Actor, type ApplicationStage, type CandidateStep, type ToldState } from "@ros/contracts";
import { applications, communications, events, type Queryable } from "@ros/db";
import { emit } from "./events";

/**
 * The application's stage: the nine stages of @ros/contracts, one table of moves, and `transition`, the only code that
 * writes `applications.stage`. Tabs, labels and what a person may do next are worked out from the stage by the contracts
 * (`tabOf`, `stageLabel`, `candidateActions`).
 */

/** Who moves an application: a workflow step, a person on the company's team, or the candidate. */
export type Mover = "system" | "team" | "candidate";

/**
 * Every move there is. The system reads the CV (applied, received, triaged) and follows the AI interview (sent, started,
 * answers sent). A person on the team shortlists, cancels the AI interview, hires and marks Not selected. The candidate
 * withdraws; the system withdraws for them only when their deletion request is fulfilled. Nothing here lets the system
 * hire or decline anyone. The two ways out of a decision are `undoDecision` and a candidate who withdraws before they
 * were told (`canTransition`).
 */
const MOVES: ReadonlyArray<{ from: readonly ApplicationStage[]; to: ApplicationStage; by: readonly Mover[] }> = [
  { from: ["applied"], to: "received", by: ["system"] },
  { from: ["applied", "received"], to: "triaged", by: ["system"] },
  { from: ["triaged"], to: "screen_invited", by: ["team"] },
  { from: ["screen_invited"], to: "screening", by: ["system"] },
  { from: ["screen_invited", "screening"], to: "screen_complete", by: ["system"] },
  { from: ["screen_invited", "screening"], to: "triaged", by: ["team"] },
  { from: IN_PROCESS_STAGES, to: "hired", by: ["team"] },
  { from: IN_PROCESS_STAGES, to: "rejected", by: ["team"] },
  { from: IN_PROCESS_STAGES, to: "withdrawn", by: ["candidate", "system"] },
];

/** Whether the candidate was told the decision: the email left. One still waiting in the outbox has told nobody yet. */
export function decisionTold(toldState: ToldState | null | undefined): boolean {
  return toldState === "sent";
}

/**
 * Whether a move is allowed. `undo`: a person takes a decision back, which is allowed from Hired, and from Not selected
 * while nothing was sent and nothing waits to be sent; `to` must then be where `stageAfterUndo` puts them. Someone marked
 * Not selected who was not told may still withdraw: for them nothing has been decided.
 */
export function canTransition(from: ApplicationStage, to: ApplicationStage, by: Mover, ctx: { toldState?: ToldState | null; undo?: boolean } = {}): boolean {
  if (ctx.undo) return by === "team" && (from === "hired" || (from === "rejected" && (ctx.toldState ?? "not_told") === "not_told")) && (to === "triaged" || to === "screen_complete");
  if (from === "rejected" && to === "withdrawn") return by === "candidate" && !decisionTold(ctx.toldState);
  return MOVES.some((m) => m.from.includes(from) && m.to === to && m.by.includes(by));
}

/** Whether the candidate may still withdraw: anyone in the process, and anyone whose decision they have not been told. */
export function mayWithdraw(stage: ApplicationStage, toldState: ToldState | null | undefined): boolean {
  return inProcess(stage) || (stage === "rejected" && !decisionTold(toldState));
}

export class TransitionError extends Error {
  constructor(public from: ApplicationStage, public to: ApplicationStage, public by: Mover) {
    super(`transition ${from} to ${to} is not allowed for ${by}`);
  }
}

type Move = { applicationId: string; companyId: string; to: ApplicationStage; by: Mover; actor: Actor; reason?: string; payload?: Record<string, unknown>; correlationId?: string | null; now?: Date };

/**
 * Moves an application and records the fact (`application.stage_changed`, with the stage it came from). Marking someone
 * Not selected starts them as not told. Leaving Not selected takes back a decision email still waiting in the outbox, so
 * it never reaches someone the decision no longer applies to. `now`: the caller's clock, when it has one.
 */
export async function transition(q: Queryable, input: Move): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  return move(q, input, false);
}

/**
 * Takes back Hired, or Not selected before the candidate was told: the person goes where `stageAfterUndo` puts them, from
 * the stage the decision was made at. Nothing of the decision stays on the application.
 */
export async function undoDecision(q: Queryable, input: Omit<Move, "to" | "by">): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  const before = await stageBeforeDecision(q, input.applicationId);
  return move(q, { ...input, to: stageAfterUndo(before), by: "team", payload: { ...(input.payload ?? {}), undo: true } }, true);
}

async function move(q: Queryable, input: Move, undo: boolean): Promise<{ from: ApplicationStage; to: ApplicationStage }> {
  const [app] = await q.select({ stage: applications.stage, toldState: applications.toldState }).from(applications).where(eq(applications.id, input.applicationId)).limit(1);
  if (!app) throw new Error(`application ${input.applicationId} not found`);
  const from = app.stage;
  if (from === input.to) return { from, to: input.to };
  if (!canTransition(from, input.to, input.by, { toldState: app.toldState, undo })) throw new TransitionError(from, input.to, input.by);
  const now = (input.now ?? new Date()).toISOString();
  const patch: Partial<typeof applications.$inferInsert> = { stage: input.to, stageChangedAt: now };
  if (input.to === "rejected" || undo) {
    patch.rejectedAt = input.to === "rejected" ? now : null;
    patch.toldState = "not_told";
    patch.candidateToldAt = null;
  }
  await q.update(applications).set(patch).where(eq(applications.id, input.applicationId));
  await emit(q, { type: "application.stage_changed", companyId: input.companyId, actor: input.actor, subject: { type: "application", id: input.applicationId }, payload: { from, to: input.to, reason: input.reason ?? null, ...(input.payload ?? {}) }, correlationId: input.correlationId ?? null });
  if (from === "rejected") await takeBackDecisionEmail(q, { applicationId: input.applicationId, companyId: input.companyId, actor: input.actor, reason: "the decision no longer applies" });
  return { from, to: input.to };
}

/** The stage a decision (Hired, Not selected) was made at: where the application's latest move came from. Null when nothing is recorded. */
export async function stageBeforeDecision(q: Queryable, applicationId: string): Promise<ApplicationStage | null> {
  const [last] = await q.select({ payload: events.payload }).from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, applicationId), eq(events.type, "application.stage_changed"))).orderBy(desc(events.id)).limit(1);
  return (last?.payload.from as ApplicationStage | undefined) ?? null;
}

/**
 * The key the decision message is recorded under (`communications.template_key`). The one copy: the taking back below
 * reads it, and so do the agents that write, send and stop the message (packages/agents).
 */
export const DECISION_TEMPLATE = "disposition";

/**
 * Takes back the decision email of an application while it still waits in the outbox, and puts the told state back to not
 * told. Recorded as `message.cancelled`. An email already being sent cannot be called back. Returns how many were taken back.
 */
export async function takeBackDecisionEmail(q: Queryable, input: { applicationId: string; companyId: string; actor: Actor; reason: string }): Promise<number> {
  const rows = await q.update(communications).set({ status: "cancelled", error: input.reason }).where(and(eq(communications.applicationId, input.applicationId), like(communications.templateKey, `${DECISION_TEMPLATE}%`), eq(communications.status, "queued"))).returning({ id: communications.id, templateKey: communications.templateKey });
  for (const r of rows) await emit(q, { type: "message.cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: r.id }, payload: { template: r.templateKey, applicationId: input.applicationId, reason: input.reason } });
  if (rows.length) await q.update(applications).set({ toldState: "not_told" }).where(and(eq(applications.id, input.applicationId), eq(applications.toldState, "queued")));
  return rows.length;
}

/**
 * The step a candidate sees on their status page. Hired and Withdrew read as Decision at once; Not selected only once
 * they were told, and until then as the step they were at before it (`before`: the stage the decision was made at).
 */
export function candidateStep(stage: ApplicationStage, toldState: ToldState | null | undefined, before?: ApplicationStage | null): CandidateStep {
  if (stage === "rejected") {
    if (decisionTold(toldState)) return "decision";
    return before && before !== "rejected" ? candidateStep(before, null) : "under_review";
  }
  if (stage === "hired" || stage === "withdrawn") return "decision";
  if (stage === "applied" || stage === "received") return "received";
  if (stage === "screen_invited" || stage === "screening" || stage === "screen_complete") return "interview";
  return "under_review";
}

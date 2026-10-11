import { eq } from "drizzle-orm";
import { emit } from "@ros/core";
import { approvalRequests } from "@ros/db";
import type { StepContext, StepResult } from "./types";

/**
 * The assistant's suggestions that wait for a person ("Invite to a screen?", "Interview?") expire after a week (plan
 * A6), the way a packet approval does after two: nothing is sent, the suggestion leaves Today, and the candidate stays
 * with the team, who can still act on them directly.
 */
export const SUGGESTION_WINDOW_HOURS = 24 * 7;
export type SuggestionState = { approvalRequestId?: string; suggestionExpiresAt?: string };

/** Waits for a person's answer to the suggestion, until it expires. The expiry runs on the engine's clock, the same one that wakes this run, so the request and the timer agree. */
export async function waitForSuggestion<S extends Record<string, unknown> & SuggestionState>(ctx: StepContext<S>, approvalRequestId: string, resumeStep: string): Promise<StepResult<S>> {
  const until = new Date(ctx.now.getTime() + SUGGESTION_WINDOW_HOURS * 3600_000).toISOString();
  await ctx.q.update(approvalRequests).set({ expiresAt: until }).where(eq(approvalRequests.id, approvalRequestId));
  return { kind: "wait", wait: { kind: "human", approvalRequestId, until }, state: { approvalRequestId, suggestionExpiresAt: until } as Partial<S>, resumeStep };
}

/**
 * On waking: a suggestion a person decided (approved, declined, cancelled because they acted directly) needs nothing
 * more here, since the approvals route and the action route carried it out; one still pending before its date keeps
 * waiting (a retry is a timer wake too, and must not expire it early); one past its date expires and is recorded.
 * Returns the wait to keep, or null when the run is done with the suggestion.
 */
export async function settleSuggestion<S extends Record<string, unknown> & SuggestionState>(ctx: StepContext<S>, resumeStep: string): Promise<StepResult<S> | null> {
  const id = ctx.state.approvalRequestId;
  if (!id) return null;
  const [req] = await ctx.q.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
  if (req?.status !== "pending") return null;
  const dueAt = ctx.state.suggestionExpiresAt ?? req.expiresAt ?? null;
  if (!dueAt || Date.parse(dueAt) > ctx.now.getTime()) return { kind: "wait", wait: { kind: "human", approvalRequestId: id, ...(dueAt ? { until: dueAt } : {}) }, resumeStep };
  await ctx.q.update(approvalRequests).set({ status: "expired", decidedAt: ctx.now.toISOString(), decisionNote: "Nobody answered the suggestion within a week, so it lapsed. Nothing was sent." }).where(eq(approvalRequests.id, id));
  await emit(ctx.q, { type: "approval.expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "approval_request", id }, payload: { actionType: req.actionType, applicationId: req.applicationId, roleId: req.roleId, windowDays: SUGGESTION_WINDOW_HOURS / 24 }, correlationId: ctx.run.id });
  return null;
}

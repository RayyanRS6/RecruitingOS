import { AI_CREDIT_AVAILABLE } from "@ros/contracts";
import { aiCreditResetsAt } from "@ros/core";
import type { StepContext, StepResult } from "./types";

/** How long a wait for credit lasts when only a change of plan can help, before it looks again anyway. */
export const CREDIT_WAIT_DAYS = 30;

/**
 * A step whose AI work has no credit (the reading of a résumé, the scorecard of a sent chat) waits on the company's signal,
 * which a change of plan sends, or until a monthly credit's next period, which has no event; never failing and never
 * looking every few hours, because each look writes a step and an event per waiting run. Each run woken passes the same
 * check at the credit's own gate, and the worker runs them one at a time, so a wake-up cannot flood the provider.
 */
export async function waitForCredit<S extends Record<string, unknown>>(ctx: StepContext<S>, resumeStep: string, state?: Partial<S>): Promise<StepResult<S>> {
  const until = (await aiCreditResetsAt(ctx.q, ctx.companyId, { now: ctx.now })) ?? new Date(ctx.now.getTime() + CREDIT_WAIT_DAYS * 86_400_000).toISOString();
  return { kind: "wait", wait: { kind: "event", eventTypes: [AI_CREDIT_AVAILABLE], until, reason: "the company's AI credit is used up: this goes on after a change of plan, or when a monthly credit starts again" }, ...(state ? { state } : {}), resumeStep };
}

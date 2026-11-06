import { AI_CREDIT_AVAILABLE } from "@ros/contracts";
import { aiCreditResetsAt, aiCreditRoomSoon, holdAiCreditRows } from "@ros/core";
import type { StepContext, StepResult } from "./types";

/** How long a wait for credit lasts when only a change of plan can help, before it looks again anyway. */
export const CREDIT_WAIT_DAYS = 30;
/** How long a wait lasts when only money held for calls still running stands in the way: they settle within minutes. */
export const CREDIT_IN_FLIGHT_WAIT_MINUTES = 15;

/**
 * A step whose AI work has no credit (the reading of a résumé, the scorecard of a sent chat) waits on the company's signal,
 * which a change of plan sends, or until a monthly credit's next period, which has no event; never failing and never
 * looking every few hours, because each look writes a step and an event per waiting run. Each run woken passes the same
 * check at the credit's own gate, and the worker runs them one at a time, so a wake-up cannot flood the provider.
 *
 * Read again here, in the step's own transaction and behind the credit's rows (`holdAiCreditRows`), because the refusal came
 * before it opened. `roomSoon`: what `refusedHoldUsd` asked for fits on the money actually spent. Nothing is used up then, so
 * nothing may say so: the wait is a short one, on the same signal, for the holds of calls still running to settle (or for a
 * new plan the refusal came just before). Those end by themselves, at the latest with the daily sweep of a call whose process
 * went away, so this cannot go on looking for long.
 */
export async function waitForCredit<S extends Record<string, unknown>>(ctx: StepContext<S>, resumeStep: string, refusedHoldUsd: number, state?: Partial<S>): Promise<{ roomSoon: boolean; wait: StepResult<S> }> {
  await holdAiCreditRows(ctx.q, ctx.companyId);
  const roomSoon = await aiCreditRoomSoon(ctx.q, { companyId: ctx.companyId, holdUsd: refusedHoldUsd, now: ctx.now });
  const until = roomSoon
    ? new Date(ctx.now.getTime() + CREDIT_IN_FLIGHT_WAIT_MINUTES * 60_000).toISOString()
    : (await aiCreditResetsAt(ctx.q, ctx.companyId, { now: ctx.now })) ?? new Date(ctx.now.getTime() + CREDIT_WAIT_DAYS * 86_400_000).toISOString();
  const reason = roomSoon ? "only money held for AI work still running stands in the way: this looks again in a few minutes" : "the company's AI credit is used up: this goes on after a change of plan, or when a monthly credit starts again";
  return { roomSoon, wait: { kind: "wait", wait: { kind: "event", eventTypes: [AI_CREDIT_AVAILABLE], until, reason }, ...(state ? { state } : {}), resumeStep } };
}

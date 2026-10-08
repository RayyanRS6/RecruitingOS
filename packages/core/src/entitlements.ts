import { and, eq } from "drizzle-orm";
import { companies, entitlements, plans, usageEvents, type Queryable } from "@ros/db";
import { raiseAlertOnce } from "./alerts";

/** Entitlement checks by key. Product code never compares plan names. */
export async function check(q: Queryable, companyId: string, key: string, delta = 1): Promise<{ ok: boolean; limit: number | null; used: number }> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (!row) return { ok: true, limit: null, used: 0 }; // unmetered
  if (row.limit === null) return { ok: true, limit: null, used: row.used };
  return { ok: row.used + delta <= row.limit, limit: row.limit, used: row.used };
}

export async function record(q: Queryable, companyId: string, key: string, quantity: number, unit: string, ref: Record<string, unknown> = {}): Promise<void> {
  await q.insert(usageEvents).values({ companyId, key, quantity, unit, ref });
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (row) await q.update(entitlements).set({ used: row.used + quantity }).where(eq(entitlements.id, row.id));
}

/** Materializes a plan's limits into entitlement rows for a company (signup, upgrade, downgrade, renewal). */
export async function applyPlan(q: Queryable, companyId: string, planKey: string, source: "plan" | "trial" = "plan"): Promise<void> {
  const [plan] = await q.select().from(plans).where(eq(plans.key, planKey)).limit(1);
  if (!plan) throw new Error(`unknown plan ${planKey}`);
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 30 * 86_400_000);
  for (const [key, limit] of Object.entries(plan.limits)) {
    const [existing] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
    if (existing) {
      await q.update(entitlements).set({ limit, source, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() }).where(eq(entitlements.id, existing.id));
    } else {
      await q.insert(entitlements).values({ companyId, key, limit, used: 0, source, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() });
    }
  }
  await q.update(companies).set({ planKey }).where(eq(companies.id, companyId));
}

/** The plan's allowance of screening conversations. */
export const TEXT_SCREENS = "text_screens";
/** Requests for a person instead of the screening conversation (Q16): counted, never limited; ITS covers them. */
export const PERSON_REQUESTS = "screen_person_requests";
/** The share of the monthly allowance at which the owner and ITS are warned (Q17). */
export const ALLOWANCE_WARN_RATIO = 0.8;

/**
 * What one more conversation did to the allowance: `warning` when it crossed 80%, `used_up` when it reached the limit,
 * null otherwise (or when the plan has no limit). Each is crossed once in a period, so each is told once.
 */
export type AllowanceCrossing = { crossed: "warning" | "used_up" | null; used: number; limit: number | null };

/**
 * Counts a screening conversation at the candidate's first answer (plan E9), never at the invitation, and says whether
 * this one crossed the 80% line or used the allowance up. Nothing is refused here: someone who has started is never cut
 * off (founder decision F8; Q17).
 */
export async function recordScreenStart(q: Queryable, companyId: string, ref: Record<string, unknown>): Promise<AllowanceCrossing> {
  const [before] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, TEXT_SCREENS))).limit(1);
  await record(q, companyId, TEXT_SCREENS, 1, "screen", ref);
  if (!before || before.limit === null || before.limit <= 0) return { crossed: null, used: (before?.used ?? 0) + 1, limit: before?.limit ?? null };
  const used = before.used + 1;
  const line = Math.ceil(before.limit * ALLOWANCE_WARN_RATIO);
  const crossed = before.used < before.limit && used >= before.limit ? "used_up" : before.used < line && used >= line ? "warning" : null;
  return { crossed, used, limit: before.limit };
}

/**
 * Tells ITS that a company's screening allowance is at 80% or used up (Q17): one alert while it stands. Platform side
 * only (the tenant role cannot write alerts); the owner's own notice goes in the tenant transaction that counted it.
 */
export async function flagScreenAllowance(q: Queryable, input: { companyId: string; companyName: string; crossing: AllowanceCrossing; now?: Date }): Promise<{ id: string; created: boolean } | null> {
  const { crossed, used, limit } = input.crossing;
  if (!crossed) return null;
  const usedUp = crossed === "used_up";
  return raiseAlertOnce(q, {
    kind: usedUp ? "billing.screens_used_up" : "billing.screens_warning",
    severity: usedUp ? "high" : "info",
    companyId: input.companyId,
    target: { type: "company", id: input.companyId },
    title: usedUp ? `${input.companyName} has used all its screening conversations this month` : `${input.companyName} has used 80% of its screening conversations this month`,
    body: usedUp
      ? `${used} of ${limit} used. Applications are still accepted; new applicants get the conversation link by email once the allowance is topped up, so everyone for a role has the same process. Talk with the customer about topping up.`
      : `${used} of ${limit} used. Nothing has stopped. Talk with the customer about topping up before it runs out.`,
    details: { used, limit },
  }, { now: input.now });
}

/** The plan's allowance of recruiter requests. */
export const RECRUITER_ASKS = "recruiter_asks";

/** Where a company stands against its recruiter-request allowance: `over` once it has used more than the plan includes. */
export type RecruiterAskStanding = { used: number; limit: number | null; over: boolean };

export async function recruiterAskStanding(q: Queryable, companyId: string): Promise<RecruiterAskStanding> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, RECRUITER_ASKS))).limit(1);
  if (!row) return { used: 0, limit: null, over: false };
  return { used: row.used, limit: row.limit, over: row.limit !== null && row.used > row.limit };
}

/**
 * Counts one recruiter request against the plan (founder decision Q33, option A). Only requests the company's own team
 * makes are counted (the caller decides: never a candidate's, the system's or an ITS recruiter's), and nothing is ever
 * refused: a person can always reach a person. Runs inside the request's own tenant transaction.
 */
export async function recordRecruiterAsk(q: Queryable, companyId: string, ref: Record<string, unknown>): Promise<RecruiterAskStanding> {
  await record(q, companyId, RECRUITER_ASKS, 1, "request", ref);
  return recruiterAskStanding(q, companyId);
}

/**
 * Flags a company that has gone past its recruiter requests to ITS for billing: one alert in the admin console while
 * it stands (a second request over the line does not raise another). Platform side only: the tenant role cannot write
 * alerts.
 */
export async function flagRecruiterAsksOver(q: Queryable, input: { companyId: string; companyName: string; standing: RecruiterAskStanding; escalationId: string; now?: Date }): Promise<{ id: string; created: boolean }> {
  const { used, limit } = input.standing;
  return raiseAlertOnce(q, {
    kind: "billing.recruiter_asks_over",
    severity: "info",
    companyId: input.companyId,
    target: { type: "company", id: input.companyId },
    title: `${input.companyName} has asked for more recruiter help than its plan includes`,
    body: `${used} recruiter requests used${limit === null ? "" : ` of the ${limit} the plan includes`}. Nothing was held up: every request went to the queue as usual. Talk with the customer about billing for the extra.`,
    details: { used, limit, escalationId: input.escalationId },
  }, { now: input.now });
}

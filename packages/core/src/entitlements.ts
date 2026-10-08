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

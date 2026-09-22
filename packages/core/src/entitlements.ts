import { and, eq } from "drizzle-orm";
import { companies, entitlements, plans, usageEvents, type Queryable } from "@ros/db";

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

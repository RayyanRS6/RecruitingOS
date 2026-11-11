import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { PUBLIC_PLAN_KEYS, publicPlanView, type PublicPlans } from "@ros/contracts";
import { assertCan, openPlanRequests } from "@ros/core";
import { companies, plans, withTenant } from "@ros/db";
import { requireTenant, type Vars } from "../middleware/session";

/**
 * The plans a customer may see and ask for (the plans of 5 November 2026, Rule 5), for the upgrade sheet: the public plans
 * only, in their order, with their numbers and the AI help in words, and whether ITS already has this company's request.
 * Never the private pilot, a retired plan, or the AI credit in money. Any member reads it, as they read the company's own plan.
 */
export const planRoutes = new Hono<Vars>();

planRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const answer = await withTenant(c.get("container").db, t.companyId, async (tx): Promise<PublicPlans> => {
    const [co] = await tx.select({ planKey: companies.planKey }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const rows = await tx.select({ key: plans.key, name: plans.name, prices: plans.prices, limits: plans.limits, active: plans.active }).from(plans).where(inArray(plans.key, [...PUBLIC_PLAN_KEYS]));
    const shown = PUBLIC_PLAN_KEYS.flatMap((key) => {
      const row = rows.find((r) => r.key === key && r.active);
      const view = row ? publicPlanView(row, co?.planKey) : null;
      return view ? [view] : [];
    });
    return { plans: shown, requested: (await openPlanRequests(tx, t.companyId)).length > 0 };
  });
  return c.json(answer);
});

import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { PUBLIC_PLAN_KEYS, PlanRequest, publicPlanView, type PublicPlans } from "@ros/contracts";
import { assertCan } from "@ros/core";
import { companies, plans, withPlatform, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { openPlanRequest, requestPlan } from "../services/plan-request";

/**
 * The plans a customer may see and ask for (the plans of 5 November 2026, Rule 5), for the upgrade sheet: the public plans
 * only, in their order, with their numbers and the AI help in words, and when this company's open request was sent.
 * Never the private pilot, a retired plan, or the AI credit in money. Any member reads it, as they read the company's own plan.
 */
export const planRoutes = new Hono<Vars>();

planRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const db = c.get("container").db;
  const shown = await withTenant(db, t.companyId, async (tx) => {
    const [co] = await tx.select({ planKey: companies.planKey }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const rows = await tx.select({ key: plans.key, name: plans.name, prices: plans.prices, limits: plans.limits, active: plans.active }).from(plans).where(inArray(plans.key, [...PUBLIC_PLAN_KEYS]));
    return PUBLIC_PLAN_KEYS.flatMap((key) => {
      const row = rows.find((r) => r.key === key && r.active);
      const view = row ? publicPlanView(row, co?.planKey) : null;
      return view ? [view] : [];
    });
  });
  // The request is an alert ITS reads, and the company's own role cannot read alerts: looked up on the platform side.
  const open = await withPlatform(db, (tx) => openPlanRequest(tx, t.companyId));
  const answer: PublicPlans = { plans: shown, requestedAt: open?.requestedAt ?? null };
  return c.json(answer);
});

/**
 * "Upgrade": asks ITS for a bigger plan. There is no payment system, so nothing changes until an administrator changes
 * the plan. One open request per company: a second press, by anyone, answers with the one already sent.
 */
planRoutes.post("/request", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "plan.request");
  const body = PlanRequest.parse(await c.req.json().catch(() => ({})));
  const sent = await requestPlan(c.get("container").db, { companyId: t.companyId, planKey: body.planKey ?? null, reason: body.reason || null, note: body.note || null, actor: actorOf(c) });
  return c.json(sent, sent.alreadyAsked ? 200 : 201);
});

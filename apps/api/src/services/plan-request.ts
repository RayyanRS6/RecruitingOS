import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { PLAN_REQUEST_ALERT_KIND, planRequestWords, type Actor, type PlanRequestSent, type PublicPlanKey } from "@ros/contracts";
import { STANDING_STATUSES, raiseAlert } from "@ros/core";
import { adminAlerts, companies, plans, withPlatform, type Db, type Queryable } from "@ros/db";

/**
 * A company's request about its plan (the Upgrade button). It is one open alert in the admin console
 * (`PLAN_REQUEST_ALERT_KIND`), with the plan asked for, why, the person's note and who asked; changing the company's
 * plan resolves it (services/plan-change.ts). Alerts are platform records, so everything here runs on the platform side.
 */

/** The company's open request: when it was sent and who sent it; null with none open. */
export async function openPlanRequest(q: Queryable, companyId: string): Promise<{ requestedAt: string; requestedById: string | null } | null> {
  const [row] = await q
    .select({ createdAt: adminAlerts.createdAt, details: adminAlerts.details })
    .from(adminAlerts)
    .where(and(eq(adminAlerts.kind, PLAN_REQUEST_ALERT_KIND), eq(adminAlerts.companyId, companyId), inArray(adminAlerts.status, [...STANDING_STATUSES])))
    .orderBy(desc(adminAlerts.createdAt))
    .limit(1);
  if (!row) return null;
  const by = (row.details.requestedBy as { id?: unknown } | undefined)?.id;
  return { requestedAt: new Date(row.createdAt).toISOString(), requestedById: typeof by === "string" ? by : null };
}

/**
 * Sends the request, unless one is already open: two people pressing at once take turns on the company's lock, and the
 * second reads the first's request.
 */
export async function requestPlan(db: Db, input: { companyId: string; planKey: PublicPlanKey | null; reason: string | null; note: string | null; actor: Actor }): Promise<PlanRequestSent> {
  return withPlatform(db, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan_request:${input.companyId}`}))`);
    const open = await openPlanRequest(tx, input.companyId);
    if (open) return { requestedAt: open.requestedAt, alreadyAsked: true };
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
    const [plan] = input.planKey ? await tx.select({ name: plans.name }).from(plans).where(eq(plans.key, input.planKey)).limit(1) : [];
    const name = company?.name ?? "A customer";
    await raiseAlert(tx, {
      kind: PLAN_REQUEST_ALERT_KIND,
      severity: "info",
      companyId: input.companyId,
      target: { type: "company", id: input.companyId },
      title: plan ? `${name} asked to move to the ${plan.name} plan` : `${name} asked about its plan`,
      body: `${input.actor.name ?? "Someone on the team"} wrote: ${planRequestWords(plan?.name ?? null, { reason: input.reason, note: input.note })}`,
      details: { planKey: input.planKey, planName: plan?.name ?? null, reason: input.reason, note: input.note, requestedBy: { id: input.actor.id, name: input.actor.name ?? null } },
    });
    return { requestedAt: (await openPlanRequest(tx, input.companyId))!.requestedAt, alreadyAsked: false };
  });
}

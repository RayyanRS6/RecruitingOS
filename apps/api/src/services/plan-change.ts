import { and, eq, notInArray } from "drizzle-orm";
import { PLAN_REQUEST_ALERT_KIND, planChangedWords } from "@ros/contracts";
import { notify, resolveAlertsFor } from "@ros/core";
import { memberships, type Queryable } from "@ros/db";
import { openPlanRequest } from "./plan-request";

/** The roles that hear about a change of plan as it happens: they are the ones who talk with ITS about it. */
const PLAN_READERS = ["owner", "admin"];

/**
 * What a change of plan does around the plan itself (the plans of 5 November 2026, Rule 5), inside Change plan's
 * transaction. The company's open request about its plan is done, so its alert is resolved, and the owners and admins
 * are told. Whoever asked and is neither is told too.
 */
export async function afterPlanChange(q: Queryable, input: { companyId: string; planName: string; opened: number; now: Date }): Promise<void> {
  const { companyId, now } = input;
  const asked = await openPlanRequest(q, companyId);
  await resolveAlertsFor(q, PLAN_REQUEST_ALERT_KIND, companyId, now);
  const words = planChangedWords(input.planName, input.opened);
  const notice = { companyId, kind: "company.plan_changed" as const, title: words.title, body: words.body, action: { label: "See plan", href: "/setup#setup-company" } };
  await notify(q, { ...notice, roles: PLAN_READERS });
  if (!asked?.requestedById) return;
  const [other] = await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.userId, asked.requestedById), notInArray(memberships.role, PLAN_READERS), eq(memberships.status, "active"))).limit(1);
  if (other) await notify(q, { ...notice, userIds: [other.userId] });
}

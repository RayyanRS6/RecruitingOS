import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { companies, entitlements, plans, roles, usageEvents, type Queryable } from "@ros/db";
import { raiseAlertOnce } from "./alerts";

/** The plan's allowance of roles at a time. */
export const ACTIVE_ROLES = "active_roles";

/**
 * A role uses one of the plan's places from the moment it is created until it closes: while it waits for approval, is
 * sent back for changes, is open or is paused. Closing it (filled, cancelled, no hire) gives the place back, and a role
 * reopened by correcting its outcome takes one again. Counted from the roles themselves, never from a running total.
 */
export const ROLE_STATUSES_USING_A_PLACE = ["pending_approval", "draft", "open", "paused"] as const;

/** The roles using the plan's places now, oldest first; `except` leaves out a role being created in this transaction. */
export async function rolesUsingAPlace(q: Queryable, companyId: string, opts: { except?: string } = {}): Promise<Array<{ roleId: string; title: string; status: string }>> {
  const where = [eq(roles.companyId, companyId), inArray(roles.status, [...ROLE_STATUSES_USING_A_PLACE])];
  if (opts.except) where.push(ne(roles.id, opts.except));
  return q.select({ roleId: roles.id, title: roles.title, status: roles.status }).from(roles).where(and(...where)).orderBy(asc(roles.createdAt));
}

/** Where a company stands on roles: the places in use (and which roles use them) and room for one more. */
export async function roleRoom(q: Queryable, companyId: string, opts: { except?: string } = {}): Promise<{ ok: boolean; limit: number | null; used: number; holding: Array<{ roleId: string; title: string; status: string }> }> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, ACTIVE_ROLES))).limit(1);
  const holding = await rolesUsingAPlace(q, companyId, opts);
  const limit = row?.limit ?? null;
  return { ok: limit === null || holding.length + 1 <= limit, limit, used: holding.length, holding };
}

/** Entitlement checks by key. Product code never compares plan names. Roles are counted from the roles themselves. */
export async function check(q: Queryable, companyId: string, key: string, delta = 1): Promise<{ ok: boolean; limit: number | null; used: number }> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (!row) return { ok: true, limit: null, used: 0 }; // unmetered
  const used = key === ACTIVE_ROLES ? (await rolesUsingAPlace(q, companyId)).length : row.used;
  if (row.limit === null) return { ok: true, limit: null, used };
  return { ok: used + delta <= row.limit, limit: row.limit, used };
}

/**
 * Records a use. Each one is kept as a usage event; the running total counts up, except for roles, whose total is the
 * number of roles using a place now (the role being recorded is already created), so it never only goes up. The count
 * is added in the database (`used = used + n`), never read and written back: two uses at the same moment (two
 * applicants' first answers) each count, the second waiting on the first's row lock and adding to its total. Returns
 * the total after this use, as the database has it, or null for an unmetered key.
 */
export async function record(q: Queryable, companyId: string, key: string, quantity: number, unit: string, ref: Record<string, unknown> = {}): Promise<{ used: number; limit: number | null } | null> {
  await q.insert(usageEvents).values({ companyId, key, quantity, unit, ref });
  const [row] = await q.select({ id: entitlements.id, limit: entitlements.limit }).from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (!row) return null;
  if (key === ACTIVE_ROLES) {
    const used = (await rolesUsingAPlace(q, companyId)).length;
    await q.update(entitlements).set({ used }).where(eq(entitlements.id, row.id));
    return { used, limit: row.limit };
  }
  const [after] = await q.update(entitlements).set({ used: sql`${entitlements.used} + ${quantity}` }).where(eq(entitlements.id, row.id)).returning({ used: entitlements.used, limit: entitlements.limit });
  return after ?? null;
}

/** The plan's usage as the company's settings show it: roles counted from the roles using a place now. */
export async function usageOf(q: Queryable, companyId: string): Promise<Record<string, { used: number; limit: number | null }>> {
  const rows = await q.select().from(entitlements).where(eq(entitlements.companyId, companyId));
  const out: Record<string, { used: number; limit: number | null }> = {};
  for (const e of rows) out[e.key] = { used: e.key === ACTIVE_ROLES ? (await rolesUsingAPlace(q, companyId)).length : e.used, limit: e.limit };
  return out;
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
 * off (founder decision F8; Q17). The crossing is worked out from the total the database returned for this count, so of
 * two conversations counted at the same moment exactly one crosses each line.
 */
export async function recordScreenStart(q: Queryable, companyId: string, ref: Record<string, unknown>): Promise<AllowanceCrossing> {
  const after = await record(q, companyId, TEXT_SCREENS, 1, "screen", ref);
  if (!after || after.limit === null || after.limit <= 0) return { crossed: null, used: after?.used ?? 1, limit: after?.limit ?? null };
  const used = after.used;
  const prev = used - 1;
  const line = Math.ceil(after.limit * ALLOWANCE_WARN_RATIO);
  const crossed = prev < after.limit && used >= after.limit ? "used_up" : prev < line && used >= line ? "warning" : null;
  return { crossed, used, limit: after.limit };
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

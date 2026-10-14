import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { adminAlerts, companies, entitlements, plans, roles, usageEvents, type Queryable } from "@ros/db";
import { raiseAlertOnce } from "./alerts";
import { audit } from "./audit";

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

/** How long one allowance period lasts: `applyPlan` writes the first, and each one that ends is followed by the next. */
export const PERIOD_DAYS = 30;
const PERIOD_MS = PERIOD_DAYS * 86_400_000;

/**
 * The allowances that start again each period. Every other key (roles, seats, anything metered later) keeps its count:
 * a plan's seats never reset by themselves, and Settings shows no reset date for them.
 */
export const MONTHLY_KEYS: readonly string[] = ["text_screens", "recruiter_asks", "screen_person_requests", "voice_minutes", "sourcing_contacts"];
export const isMonthly = (key: string): boolean => MONTHLY_KEYS.includes(key);

/** A row as the period rules read it. */
type PeriodRow = { key: string; used: number; periodStart: string | null; periodEnd: string | null };
export type Period = { used: number; periodStart: string | null; periodEnd: string | null; rolled: boolean };

/**
 * The period a monthly allowance is in at `now` (founder-visible fix, Wave S2 F1): once the stored period has ended,
 * the next one starts where it ended, PERIOD_DAYS long (as many as have passed), and nothing is used in it yet. Roles
 * are never reset: they are counted from the roles themselves. A row without period dates keeps its count. Pure;
 * `rolled` says the stored row is behind and the next write brings it up to date.
 */
export function currentPeriod(row: PeriodRow, now: Date = new Date()): Period {
  const kept: Period = { used: row.used, periodStart: row.periodStart, periodEnd: row.periodEnd, rolled: false };
  if (!isMonthly(row.key) || !row.periodEnd) return kept;
  const end = Date.parse(row.periodEnd);
  if (!Number.isFinite(end) || now.getTime() < end) return kept;
  const start = end + Math.floor((now.getTime() - end) / PERIOD_MS) * PERIOD_MS;
  return { used: 0, periodStart: new Date(start).toISOString(), periodEnd: new Date(start + PERIOD_MS).toISOString(), rolled: true };
}

type EntitlementRow = typeof entitlements.$inferSelect;

/**
 * Brings a row whose period has ended up to date: used goes back to zero and the dates move to the current period. Only
 * the first of two writers at the same moment does it (the update matches the old end date only); the other reads the
 * row as the first left it, so a use is never lost to a second reset.
 */
async function rollIfEnded(q: Queryable, row: EntitlementRow, now: Date): Promise<EntitlementRow> {
  const p = currentPeriod(row, now);
  if (!p.rolled || !row.periodEnd) return row;
  const [after] = await q.update(entitlements).set({ used: 0, periodStart: p.periodStart, periodEnd: p.periodEnd }).where(and(eq(entitlements.id, row.id), eq(entitlements.periodEnd, row.periodEnd))).returning();
  if (after) return after;
  const [fresh] = await q.select().from(entitlements).where(eq(entitlements.id, row.id)).limit(1);
  return fresh ?? row;
}

/**
 * Entitlement checks by key. Product code never compares plan names. Roles are counted from the roles themselves; a
 * monthly allowance counts only what was used in its current period, so a new period has room again without anyone at
 * ITS doing anything (a run waiting for the allowance gets through at its next look).
 */
export async function check(q: Queryable, companyId: string, key: string, delta = 1, opts: { now?: Date } = {}): Promise<{ ok: boolean; limit: number | null; used: number }> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (!row) return { ok: true, limit: null, used: 0 }; // unmetered
  const used = key === ACTIVE_ROLES ? (await rolesUsingAPlace(q, companyId)).length : currentPeriod(row, opts.now).used;
  if (row.limit === null) return { ok: true, limit: null, used };
  return { ok: used + delta <= row.limit, limit: row.limit, used };
}

/**
 * Records a use. Each one is kept as a usage event; the running total counts up within the allowance's period (a use
 * after the period ended starts the next one from zero), except for roles, whose total is the number of roles using a
 * place now (the role being recorded is already created), so it never only goes up. The count is added in the database
 * (`used = used + n`), never read and written back: two uses at the same moment (two applicants' first answers) each
 * count, the second waiting on the first's row lock and adding to its total. Returns the total after this use, as the
 * database has it, or null for an unmetered key.
 */
export async function record(q: Queryable, companyId: string, key: string, quantity: number, unit: string, ref: Record<string, unknown> = {}, opts: { now?: Date } = {}): Promise<{ used: number; limit: number | null } | null> {
  await q.insert(usageEvents).values({ companyId, key, quantity, unit, ref });
  const [found] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (!found) return null;
  if (key === ACTIVE_ROLES) {
    const used = (await rolesUsingAPlace(q, companyId)).length;
    await q.update(entitlements).set({ used }).where(eq(entitlements.id, found.id));
    return { used, limit: found.limit };
  }
  const row = await rollIfEnded(q, found, opts.now ?? new Date());
  const [after] = await q.update(entitlements).set({ used: sql`${entitlements.used} + ${quantity}` }).where(eq(entitlements.id, row.id)).returning({ used: entitlements.used, limit: entitlements.limit });
  return after ?? null;
}

/** One allowance as the company's settings show it; `resetsAt` is when a monthly one starts again from zero (left out for roles, which never reset). */
export type UsageLine = { used: number; limit: number | null; resetsAt?: string | null };

/** The plan's usage as the company's settings show it: roles counted from the roles using a place now, the rest within their period. */
export async function usageOf(q: Queryable, companyId: string, opts: { now?: Date } = {}): Promise<Record<string, UsageLine>> {
  const rows = await q.select().from(entitlements).where(eq(entitlements.companyId, companyId));
  const out: Record<string, UsageLine> = {};
  for (const e of rows) {
    if (e.key === ACTIVE_ROLES) {
      out[e.key] = { used: (await rolesUsingAPlace(q, companyId)).length, limit: e.limit };
      continue;
    }
    const p = currentPeriod(e, opts.now);
    out[e.key] = isMonthly(e.key) ? { used: p.used, limit: e.limit, resetsAt: p.periodEnd } : { used: p.used, limit: e.limit };
  }
  return out;
}

/**
 * Materializes a plan's limits into entitlement rows for a company (signup, upgrade, downgrade, renewal). A change of
 * plan takes effect at once and keeps the current period: what was used this month stays used, against the new limit,
 * and the reset date does not move. A period that has already ended starts again from zero; a row without dates (or a
 * new one) starts its first period now.
 */
export async function applyPlan(q: Queryable, companyId: string, planKey: string, source: "plan" | "trial" = "plan", opts: { now?: Date } = {}): Promise<void> {
  const [plan] = await q.select().from(plans).where(eq(plans.key, planKey)).limit(1);
  if (!plan) throw new Error(`unknown plan ${planKey}`);
  const now = opts.now ?? new Date();
  const periodStart = now.toISOString();
  const periodEnd = new Date(now.getTime() + PERIOD_MS).toISOString();
  for (const [key, limit] of Object.entries(plan.limits)) {
    const [existing] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
    if (existing) {
      const p = currentPeriod(existing, now);
      const period = existing.periodEnd ? { used: p.used, periodStart: p.periodStart, periodEnd: p.periodEnd } : { periodStart, periodEnd };
      await q.update(entitlements).set({ limit, source, ...period }).where(eq(entitlements.id, existing.id));
    } else {
      await q.insert(entitlements).values({ companyId, key, limit, used: 0, source, periodStart, periodEnd });
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
export async function recordScreenStart(q: Queryable, companyId: string, ref: Record<string, unknown>, opts: { now?: Date } = {}): Promise<AllowanceCrossing> {
  const after = await record(q, companyId, TEXT_SCREENS, 1, "screen", ref, opts);
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
  // Last month's alert, still on the list, must not stand in for this month's.
  await settleAllowanceAlerts(q, { companyId: input.companyId });
  return raiseAlertOnce(q, {
    kind: usedUp ? "billing.screens_used_up" : "billing.screens_warning",
    severity: usedUp ? "high" : "info",
    companyId: input.companyId,
    target: { type: "company", id: input.companyId },
    title: usedUp ? `${input.companyName} has used all its screening chats this month` : `${input.companyName} has used 80% of its screening chats this month`,
    body: usedUp
      ? `${used} of ${limit} used. Applications are still accepted; new applicants get the chat link by email once the allowance is topped up or starts again next month, so everyone for a role has the same process. Talk with the customer about topping up.`
      : `${used} of ${limit} used. Nothing has stopped. Talk with the customer about topping up before it runs out.`,
    details: { used, limit },
  }, { now: input.now });
}

/** The plan's allowance of recruiter requests. */
export const RECRUITER_ASKS = "recruiter_asks";

/** Where a company stands against its recruiter-request allowance: `over` once it has used more than the plan includes. */
export type RecruiterAskStanding = { used: number; limit: number | null; over: boolean };

export async function recruiterAskStanding(q: Queryable, companyId: string, opts: { now?: Date } = {}): Promise<RecruiterAskStanding> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, RECRUITER_ASKS))).limit(1);
  if (!row) return { used: 0, limit: null, over: false };
  const used = currentPeriod(row, opts.now).used;
  return { used, limit: row.limit, over: row.limit !== null && used > row.limit };
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
  await settleAllowanceAlerts(q, { companyId: input.companyId });
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

/** The ITS alerts about an allowance, the allowance each is about, and whether it still stands for a count and a limit. */
const ALLOWANCE_ALERTS: Record<string, { key: string; stands: (used: number, limit: number) => boolean }> = {
  "billing.screens_warning": { key: TEXT_SCREENS, stands: (used, limit) => used >= Math.ceil(limit * ALLOWANCE_WARN_RATIO) },
  "billing.screens_used_up": { key: TEXT_SCREENS, stands: (used, limit) => used >= limit },
  "billing.recruiter_asks_over": { key: RECRUITER_ASKS, stands: (used, limit) => used > limit },
};

/**
 * Resolves the allowance alerts that no longer stand: a new period started (the count is back to zero) or a new plan
 * raised the limit. Platform side only (the tenant role cannot write alerts); the console runs it before it lists
 * alerts, and so does raising a new one, so last month's alert never stands in for this month's. Returns how many it
 * resolved.
 */
export async function settleAllowanceAlerts(q: Queryable, opts: { companyId?: string; now?: Date } = {}): Promise<number> {
  const where = [inArray(adminAlerts.kind, Object.keys(ALLOWANCE_ALERTS)), inArray(adminAlerts.status, ["open", "acknowledged"])];
  if (opts.companyId) where.push(eq(adminAlerts.companyId, opts.companyId));
  const alerts = await q.select({ id: adminAlerts.id, kind: adminAlerts.kind, companyId: adminAlerts.companyId }).from(adminAlerts).where(and(...where));
  const companyIds = [...new Set(alerts.map((a) => a.companyId).filter((c): c is string => !!c))];
  if (!companyIds.length) return 0;
  const rows = await q.select().from(entitlements).where(and(inArray(entitlements.companyId, companyIds), inArray(entitlements.key, [TEXT_SCREENS, RECRUITER_ASKS])));
  const now = opts.now ?? new Date();
  const gone = alerts.filter((a) => {
    const rule = ALLOWANCE_ALERTS[a.kind];
    if (!a.companyId || !rule) return false;
    const row = rows.find((r) => r.companyId === a.companyId && r.key === rule.key);
    if (!row || row.limit === null) return true;
    return !rule.stands(currentPeriod(row, now).used, row.limit);
  });
  if (!gone.length) return 0;
  const done = await q.update(adminAlerts).set({ status: "resolved", resolvedAt: now.toISOString() }).where(and(inArray(adminAlerts.id, gone.map((a) => a.id)), inArray(adminAlerts.status, ["open", "acknowledged"]))).returning({ id: adminAlerts.id, companyId: adminAlerts.companyId });
  // each one on the record, as resolved by the system and why (a person's resolve is audited the same way)
  for (const a of done) await audit(q, { companyId: a.companyId, actor: { kind: "system", id: "allowance" }, action: "alert.resolved", target: { type: "integration", id: a.id }, reason: "allowance period reset or limit raised", details: { resolved: true, automatic: true } });
  return done.length;
}

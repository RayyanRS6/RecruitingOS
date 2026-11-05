import { and, asc, eq, gt, gte, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import { ACTIVE_ROLES, AI_CREDIT_MONTHLY_CENTS, AI_CREDIT_TOTAL_CENTS, CANDIDATES_PER_JOB, ITS_WORK, JOBS_TOTAL, RECRUITER_ASKS, SEATS, TEXT_SCREENS, isAiCreditKey } from "@ros/contracts";
import { adminAlerts, aiRuns, companies, entitlements, invitations, memberships, plans, roles, usageEvents, users, type Queryable } from "@ros/db";
import { raiseAlertOnce } from "./alerts";
import { audit } from "./audit";

/** The limit keys (packages/contracts/src/domain/plans.ts, which says what each one is), read by key: product code never compares plan names. */
export { ACTIVE_ROLES, AI_CREDIT_MONTHLY_CENTS, AI_CREDIT_TOTAL_CENTS, CANDIDATES_PER_JOB, ITS_WORK, JOBS_TOTAL, RECRUITER_ASKS, SEATS, TEXT_SCREENS };

/** The company's plan: its key, and its name when the plans table knows it. */
export async function planOf(q: Queryable, companyId: string): Promise<{ key: string; name: string | null } | null> {
  const [row] = await q.select({ key: companies.planKey, name: plans.name }).from(companies).leftJoin(plans, eq(plans.key, companies.planKey)).where(eq(companies.id, companyId)).limit(1);
  return row ?? null;
}

/** A company's limit for a key, from its own row: null when the row says none, or when it has no row (unmetered, as `check` reads it). */
export async function limitOf(q: Queryable, companyId: string, key: string): Promise<number | null> {
  const [row] = await q.select({ limit: entitlements.limit }).from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  return row?.limit ?? null;
}

/**
 * The people using the plan's places now, counted live (never from a running total): active members of any team role,
 * plus invitations sent and not yet answered (an unexpired pending one holds its place, so a 4th invitation is refused
 * before anyone accepts). ITS never counts: a person with a platform role, and a membership with the role "recruiter"
 * (always an ITS recruiter's grant; the team page never offers that role). `exceptEmail` leaves out the invitations to
 * one address, for a new invitation that replaces an open one to the same address and for the one being accepted.
 */
export async function seatsInUse(q: Queryable, companyId: string, opts: { now: Date; exceptEmail?: string }): Promise<number> {
  const [members] = await q
    .select({ n: sql<number>`count(*)` })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active"), ne(memberships.role, "recruiter"), eq(users.platformRole, "none")));
  const open = [eq(invitations.companyId, companyId), eq(invitations.status, "pending"), gt(invitations.expiresAt, opts.now.toISOString())];
  if (opts.exceptEmail) open.push(ne(invitations.email, opts.exceptEmail.trim().toLowerCase()));
  const [invited] = await q.select({ n: sql<number>`count(*)` }).from(invitations).where(and(...open));
  return Number(members?.n ?? 0) + Number(invited?.n ?? 0);
}

/** The company's limit of people: its seats row, else its plan's own limit; null when there is none. */
async function seatLimit(q: Queryable, companyId: string): Promise<number | null> {
  const [row] = await q.select({ limit: entitlements.limit }).from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, SEATS))).limit(1);
  if (row) return row.limit ?? null;
  const [plan] = await q.select({ limits: plans.limits }).from(companies).innerJoin(plans, eq(plans.key, companies.planKey)).where(eq(companies.id, companyId)).limit(1);
  const limit = plan?.limits?.[SEATS];
  return typeof limit === "number" ? limit : null;
}

/** Two invitations (or an invitation and an acceptance) at the same moment take turns, so together they never pass the limit. */
async function lockSeats(q: Queryable, companyId: string): Promise<void> {
  try { await (q as unknown as { execute: (s: unknown) => Promise<unknown> }).execute(sql`select pg_advisory_xact_lock(hashtext(${`seats:${companyId}`}))`); } catch { /* not in a transaction, or not supported: the count below still applies */ }
}

/**
 * Room for one more person: takes the company's seat lock first (held to the end of the caller's transaction), then
 * counts. `ok` false means the plan's people are all in use, counting invitations not yet answered; `planKey` is there to
 * say so in the plan's words (`seatsFullLine`).
 */
export async function seatRoom(q: Queryable, companyId: string, opts: { now: Date; exceptEmail?: string }): Promise<{ ok: boolean; limit: number | null; used: number; planKey: string | null }> {
  await lockSeats(q, companyId);
  const limit = await seatLimit(q, companyId);
  const used = await seatsInUse(q, companyId, opts);
  const ok = limit === null || used + 1 <= limit;
  return { ok, limit, used, planKey: ok ? null : (await planOf(q, companyId))?.key ?? null };
}

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

/**
 * The jobs a company has had, for a plan's limit of jobs ever (`jobs_total`), counted live from the roles: every role
 * using a place now, and every role that ever went live, closed or not. `opened_at` is set once and never cleared, so a
 * job that went live counts for good; one closed before it ever opened gives its place back, because no applicant could
 * have seen it. `except` leaves out a role being created in this transaction.
 */
export async function jobsCounted(q: Queryable, companyId: string, opts: { except?: string } = {}): Promise<number> {
  const where: Array<SQL | undefined> = [eq(roles.companyId, companyId), or(inArray(roles.status, [...ROLE_STATUSES_USING_A_PLACE]), isNotNull(roles.openedAt))];
  if (opts.except) where.push(ne(roles.id, opts.except));
  const [row] = await q.select({ n: sql<number>`count(*)` }).from(roles).where(and(...where));
  return Number(row?.n ?? 0);
}

export type RoleRoom = {
  ok: boolean;
  /** The plan's roles at a time. */
  limit: number | null;
  used: number;
  holding: Array<{ roleId: string; title: string; status: string }>;
  /** The plan's jobs ever, when it has such a limit; `full` means no more, whatever is closed. */
  lifetime: { limit: number; used: number; full: boolean } | null;
};

/** Where a company stands on roles: the places in use (and which roles use them), its jobs ever, and room for one more under both. */
export async function roleRoom(q: Queryable, companyId: string, opts: { except?: string } = {}): Promise<RoleRoom> {
  const rows = await q.select({ key: entitlements.key, limit: entitlements.limit }).from(entitlements).where(and(eq(entitlements.companyId, companyId), inArray(entitlements.key, [ACTIVE_ROLES, JOBS_TOTAL])));
  const limitFor = (key: string) => rows.find((r) => r.key === key)?.limit ?? null;
  const holding = await rolesUsingAPlace(q, companyId, opts);
  const limit = limitFor(ACTIVE_ROLES);
  const jobsLimit = limitFor(JOBS_TOTAL);
  const jobsUsed = jobsLimit === null ? 0 : await jobsCounted(q, companyId, opts);
  const lifetime = jobsLimit === null ? null : { limit: jobsLimit, used: jobsUsed, full: jobsUsed + 1 > jobsLimit };
  return { ok: !lifetime?.full && (limit === null || holding.length + 1 <= limit), limit, used: holding.length, holding, lifetime };
}

/** How long one allowance period lasts: `applyPlan` writes the first, and each one that ends is followed by the next. */
export const PERIOD_DAYS = 30;
const PERIOD_MS = PERIOD_DAYS * 86_400_000;

/**
 * The allowances that start again each period. Every other key keeps its count and Settings shows no reset date for
 * it: roles and seats are counted live (from the roles using a place, and from the members and open invitations), so
 * they go down by themselves when a role closes or someone leaves; anything metered later keeps its running total. The
 * monthly AI credit is here for its period, and is summed live like the jobs ever: nothing records either one, so their
 * `used` column stays 0 and never holds money. The total AI credit is not here: it never resets, so a company moved down
 * to Free gets no second credit.
 */
export const MONTHLY_KEYS: readonly string[] = ["text_screens", "recruiter_asks", "screen_person_requests", "voice_minutes", "sourcing_contacts", AI_CREDIT_MONTHLY_CENTS];
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
 * What a company's AI has cost, in millionths of a dollar (the column's own precision), summed live from the runs
 * themselves (nothing deletes a run, and a privacy scrub keeps its cost): since a date for the monthly credit, or over the
 * company's whole life. A call still running counts at its hold, so money in flight is in the sum; `settled` leaves those
 * out, for what the owner is told. For the server's own checks and for ITS; a customer reads a percentage (`usageOf`), never this.
 */
export async function aiCreditSpentMicros(q: Queryable, companyId: string, opts: { since?: string | null; settled?: boolean } = {}): Promise<number> {
  const where = [eq(aiRuns.companyId, companyId)];
  if (opts.since) where.push(gte(aiRuns.createdAt, opts.since));
  if (opts.settled) where.push(ne(aiRuns.status, "running"));
  const [row] = await q.select({ micros: sql<string>`coalesce(sum(${aiRuns.costUsd}), 0) * 1000000` }).from(aiRuns).where(and(...where));
  return Math.round(Number(row?.micros ?? 0));
}

/** The same in whole cents, rounded up, as the plan's limit is written: a fraction of a cent is never undercounted. */
export async function aiCreditSpentCents(q: Queryable, companyId: string, opts: { since?: string | null } = {}): Promise<number> {
  return Math.ceil((await aiCreditSpentMicros(q, companyId, opts)) / 10_000);
}

/** What an allowance has used at `now`: roles, jobs ever, people and the AI credit counted live, the rest from the row's period. */
async function usedNow(q: Queryable, companyId: string, row: EntitlementRow, now: Date): Promise<number> {
  if (row.key === ACTIVE_ROLES) return (await rolesUsingAPlace(q, companyId)).length;
  if (row.key === JOBS_TOTAL) return jobsCounted(q, companyId);
  if (row.key === SEATS) return seatsInUse(q, companyId, { now });
  if (isAiCreditKey(row.key)) return aiCreditSpentCents(q, companyId, isMonthly(row.key) ? { since: currentPeriod(row, now).periodStart } : {});
  return currentPeriod(row, now).used;
}

/**
 * Entitlement checks by key. Product code never compares plan names. Roles are counted from the roles themselves; a
 * monthly allowance counts only what was used in its current period, so a new period has room again without anyone at
 * ITS doing anything (a run waiting for the allowance gets through at its next look). For the AI credit `limit` and
 * `used` are cents, for the server only: what a customer reads comes from `usageOf`.
 */
export async function check(q: Queryable, companyId: string, key: string, delta = 1, opts: { now?: Date } = {}): Promise<{ ok: boolean; limit: number | null; used: number }> {
  const [row] = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, key))).limit(1);
  if (!row) return { ok: true, limit: null, used: 0 }; // unmetered
  const used = await usedNow(q, companyId, row, opts.now ?? new Date());
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

/**
 * One allowance as the company's settings show it; `resetsAt` is when a monthly one starts again from zero (left out for
 * roles, which never reset). `unit: "percent"` is the AI credit: `used` of 100, because customers read words or a
 * percentage, never dollars.
 */
export type UsageLine = { used: number; limit: number | null; resetsAt?: string | null; unit?: "percent" };

/** Limits that are not a count of anything used, so they have no "used of limit" line: read them with `limitOf`. */
const NOT_A_COUNT: readonly string[] = [CANDIDATES_PER_JOB, ITS_WORK];

/** A share of the credit in whole percent, never past 100; short of all never reads as all. */
export const creditPercent = (spentCents: number, limitCents: number): number => (limitCents <= 0 ? 100 : Math.min(100, Math.floor((spentCents * 100) / limitCents)));

/**
 * The plan's usage as the company's settings show it: roles counted from the roles using a place now, people from the
 * members and open invitations now (known bug 128: the stored count never moved), jobs ever from the roles (only with a
 * limit: without one there is nothing to say), the AI credit as a percentage (only with a limit), the rest within their
 * period.
 */
export async function usageOf(q: Queryable, companyId: string, opts: { now?: Date } = {}): Promise<Record<string, UsageLine>> {
  const rows = await q.select().from(entitlements).where(eq(entitlements.companyId, companyId));
  const now = opts.now ?? new Date();
  const out: Record<string, UsageLine> = {};
  for (const e of rows) {
    if (NOT_A_COUNT.includes(e.key)) continue;
    const credit = isAiCreditKey(e.key);
    if ((credit || e.key === JOBS_TOTAL) && e.limit === null) continue;
    const used = await usedNow(q, companyId, e, now);
    const resets = isMonthly(e.key) ? { resetsAt: currentPeriod(e, now).periodEnd } : {};
    out[e.key] = credit ? { used: creditPercent(used, e.limit ?? 0), limit: 100, unit: "percent", ...resets } : { used, limit: e.limit, ...resets };
  }
  return out;
}

/**
 * Materializes a plan's limits into entitlement rows for a company (signup, upgrade, downgrade, renewal). A change of
 * plan takes effect at once and keeps the current period: what was used this month stays used, against the new limit,
 * and the reset date does not move. A period that has already ended starts again from zero; a row without dates (or a
 * new one) starts its first period now. So does a monthly AI credit that had no limit until now: an upgrade's first month
 * starts with the upgrade, and what was spent on the free credit is not charged to it.
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
      const creditStarts = key === AI_CREDIT_MONTHLY_CENTS && existing.limit === null && limit !== null;
      const period = existing.periodEnd && !creditStarts ? { used: p.used, periodStart: p.periodStart, periodEnd: p.periodEnd } : { periodStart, periodEnd };
      await q.update(entitlements).set({ limit, source, ...period }).where(eq(entitlements.id, existing.id));
    } else {
      await q.insert(entitlements).values({ companyId, key, limit, used: 0, source, periodStart, periodEnd });
    }
  }
  await q.update(companies).set({ planKey }).where(eq(companies.id, companyId));
}

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
    title: usedUp ? `${input.companyName} has used all its AI interviews this month` : `${input.companyName} has used 80% of its AI interviews this month`,
    body: usedUp
      ? `${used} of ${limit} used. Applications are still accepted; new applicants get the chat link by email once the allowance is topped up or starts again next month, so everyone for a role has the same process. Talk with the customer about topping up.`
      : `${used} of ${limit} used. Nothing has stopped. Talk with the customer about topping up before it runs out.`,
    details: { used, limit },
  }, { now: input.now });
}

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

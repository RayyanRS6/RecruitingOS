import { and, asc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { AI_CREDIT_MONTHLY_CENTS, AI_CREDIT_TOTAL_CENTS, aiCreditNoticeWords, type AiCreditLevel, type AiCreditView } from "@ros/contracts";
import { adminAlerts, aiRuns, companies, entitlements, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import { raiseAlertOnce } from "./alerts";
import { audit } from "./audit";
import { closingDayWords, companyToday } from "./closing-date";
import { ALLOWANCE_WARN_RATIO, aiCreditSpentMicros, creditPercent, currentPeriod, isMonthly } from "./entitlements";
import { errorForLog } from "./secrets";
import { emit } from "./events";
import { notify } from "./notifications";

/**
 * The AI credit (the owner's request of 5 November 2026: "they are not allowed to use more than $10 for each company"), by
 * key and in one place: `ai_credit_total_cents` never starts again (Free), `ai_credit_monthly_cents` starts again each
 * period by date alone (the paid plans). A company with no row for a key, or a row with no limit, is unmetered, and its AI
 * calls take the path they took before this existed.
 *
 * The hold, so overshoot is zero: in one short transaction the company's credit rows are locked, what has been spent is
 * summed live from `ai_runs`, and a call is refused when `spent + hold > limit - slack`; otherwise its row goes in now, as
 * `running`, with the hold as its cost, so the next call's sum already has it, whatever the model is still doing. The row
 * takes the real numbers afterwards (packages/ai/src/runner.ts). The sum and the rows are one source of truth with nothing
 * to drift; `entitlements.used` stays 0.
 *
 * Customers read words or a percentage, never dollars (docs/FOUNDER-CONTEXT.md, "AI credit math"); nothing here writes an
 * amount to an event, a notification or the company's settings. Only ITS's alerts and console line carry dollars.
 */

const MICROS = 1_000_000;
const MICROS_PER_CENT = 10_000;
const toMicros = (usd: number) => Math.round(usd * MICROS);

/** Kept back from the limit, for what estimates and a price table can miss. */
export const AI_CREDIT_SLACK_USD = 0.1;
/** What a call on Haiku 5.5 holds at most, in practice (`creditHoldUsd`): the credit is used up once one of these has no room. */
export const AI_CREDIT_ORDINARY_HOLD_USD = 0.02;
/** What a job's draft holds, about: with less than this left, a new job could not be written. */
export const AI_CREDIT_DRAFT_HOLD_USD = 0.8;
/** A refusal of a hold no bigger than this means the credit really is gone; a bigger one (a draft) only that it was too big. */
const SMALL_HOLD_USD = 0.1;

const SLACK = toMicros(AI_CREDIT_SLACK_USD);
const WARN_PERCENT = Math.round(ALLOWANCE_WARN_RATIO * 100);
const CREDIT_KEYS = [AI_CREDIT_TOTAL_CENTS, AI_CREDIT_MONTHLY_CENTS];

type CreditRow = typeof entitlements.$inferSelect;

const limitedRows = () => and(inArray(entitlements.key, CREDIT_KEYS), isNotNull(entitlements.limit));
/** From when a row's credit is summed: the current period for a monthly one, the company's whole life otherwise. */
const sinceOf = (row: CreditRow, now: Date): string | null => (isMonthly(row.key) ? currentPeriod(row, now).periodStart : null);
/** The period told about: "total" never changes, so its lines are told once; a month's change with the month. */
const periodKeyOf = (row: CreditRow, now: Date): string => (isMonthly(row.key) ? `month:${sinceOf(row, now) ?? ""}` : "total");
const roomMicros = (row: CreditRow): number => (row.limit ?? 0) * MICROS_PER_CENT - SLACK;

/**
 * Whether a hold fits, with the company's credit rows locked until the caller's transaction ends (usable by both database
 * roles: the same rows are updated from the web and the worker). Two calls at the same moment take turns here, and the
 * second reads what the first wrote. "unmetered" takes no lock: no row has a limit. In key order, so two callers never
 * lock the same rows in opposite orders.
 */
export async function reserveAiCredit(q: Queryable, input: { companyId: string; holdUsd: number; now: Date }): Promise<"unmetered" | "held" | "refused"> {
  const rows = await q.select().from(entitlements).where(and(eq(entitlements.companyId, input.companyId), limitedRows())).orderBy(asc(entitlements.key)).for("update");
  if (!rows.length) return "unmetered";
  const hold = toMicros(input.holdUsd);
  for (const row of rows) {
    const spent = await aiCreditSpentMicros(q, input.companyId, { since: sinceOf(row, input.now) });
    if (spent + hold > roomMicros(row)) return "refused";
  }
  return "held";
}

/** Where a company stands on its AI credit: for the server and ITS only, because it carries amounts. Null when nothing limits it. */
export type AiCreditStanding = {
  key: string;
  monthly: boolean;
  periodKey: string;
  spentMicros: number;
  limitMicros: number;
  percent: number;
  /** A call on Haiku 5.5 would be refused now, or one like it was refused in this period and the owner was told. */
  usedUp: boolean;
  level: AiCreditLevel | null;
  resetsAt: string | null;
  told: { warnedFor?: string; usedUpFor?: string };
};

/** `settled`: leaves out calls still running, whose holds are not yet money spent. The fullest row, if a company ever has two. */
export async function aiCreditStanding(q: Queryable, companyId: string, opts: { now?: Date; settled?: boolean } = {}): Promise<AiCreditStanding | null> {
  const rows = await q.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), limitedRows())).orderBy(asc(entitlements.key));
  if (!rows.length) return null;
  const now = opts.now ?? new Date();
  const [company] = await q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const told = company?.settings?.aiCreditTold ?? {};
  let fullest: AiCreditStanding | null = null;
  for (const row of rows) {
    const spentMicros = await aiCreditSpentMicros(q, companyId, { since: sinceOf(row, now), settled: opts.settled });
    const standing = standingOf(row, spentMicros, told, now);
    if (!fullest || standing.spentMicros * fullest.limitMicros >= fullest.spentMicros * standing.limitMicros) fullest = standing;
  }
  return fullest;
}

function standingOf(row: CreditRow, spentMicros: number, told: AiCreditStanding["told"], now: Date): AiCreditStanding {
  const limitMicros = (row.limit ?? 0) * MICROS_PER_CENT;
  const percent = creditPercent(spentMicros, limitMicros);
  const periodKey = periodKeyOf(row, now);
  const usedUp = told.usedUpFor === periodKey || spentMicros + toMicros(AI_CREDIT_ORDINARY_HOLD_USD) > roomMicros(row);
  const monthly = isMonthly(row.key);
  return { key: row.key, monthly, periodKey, spentMicros, limitMicros, percent, usedUp, level: usedUp ? "used_up" : percent >= WARN_PERCENT ? "warning" : null, resetsAt: monthly ? currentPeriod(row, now).periodEnd : null, told };
}

/** When a wait for credit should look again by itself: a monthly credit's new period; null when only a change of plan can help. */
export async function aiCreditResetsAt(q: Queryable, companyId: string, opts: { now?: Date } = {}): Promise<string | null> {
  return (await aiCreditStanding(q, companyId, opts))?.resetsAt ?? null;
}

/**
 * A call the credit refused, read again from money actually spent: true when it fits without the holds of calls still running,
 * so it will fit once they settle (a draft holds about $0.80 for two minutes and comes back at about $0.10), or it fits now, on
 * a new plan or in a new month. False is a credit really gone for this call: what is spent refuses it by itself, and money
 * spent never comes back within a period. The rule `tellOwner` reads for a refusal, row by row as the gate reads them.
 */
export async function aiCreditRoomSoon(q: Queryable, input: { companyId: string; holdUsd: number; now: Date }): Promise<boolean> {
  const rows = await q.select().from(entitlements).where(and(eq(entitlements.companyId, input.companyId), limitedRows())).orderBy(asc(entitlements.key));
  const hold = toMicros(input.holdUsd);
  for (const row of rows) {
    const spent = await aiCreditSpentMicros(q, input.companyId, { since: sinceOf(row, input.now), settled: true });
    if (spent + hold > roomMicros(row)) return false;
  }
  return true;
}

/**
 * Holds the company's credit rows until the caller's transaction ends, for a step about to wait for credit. A refusal and the
 * wait that follows are two moments, and a change of plan's signal between them finds nobody waiting. Behind this the two
 * take turns: a change of plan in progress has finished by the next statement, so that statement reads the new plan; or it
 * waits for this commit before it writes, and its signal then finds the run waiting. Shared, because such steps need not wait
 * for each other, and one row is locked (a plan limits one credit), so no order of locks can meet another's.
 */
export async function holdAiCreditRows(q: Queryable, companyId: string): Promise<void> {
  await q.select({ id: entitlements.id }).from(entitlements).where(and(eq(entitlements.companyId, companyId), limitedRows())).orderBy(asc(entitlements.key)).for("share");
}

/**
 * Whether a new job could be written with what is left (the draft is the dearest call, so it is the first to stop): `ok`,
 * `too_low` for a draft, or `used_up`. Asked before anyone types (`planRoom`), so nobody fills in a job the AI cannot write.
 * From money actually spent, as Home's row is: the hold of a draft still running comes back long before anyone has typed.
 */
export async function aiCreditRoomForJob(q: Queryable, companyId: string, opts: { now?: Date } = {}): Promise<"ok" | "too_low" | "used_up"> {
  const s = await aiCreditStanding(q, companyId, { now: opts.now, settled: true });
  if (!s) return "ok";
  if (s.usedUp) return "used_up";
  return s.spentMicros + toMicros(AI_CREDIT_DRAFT_HOLD_USD) > s.limitMicros - SLACK ? "too_low" : "ok";
}

/** The day a monthly credit starts again, in words, on the company's own calendar. */
const dayWords = (iso: string | null, timeZone: string | null | undefined): string | null => (iso ? closingDayWords(companyToday(new Date(iso), timeZone)) : null);

/**
 * The AI credit as a customer's browser receives it (GET /companies/current): no amounts. From money actually spent, as the
 * notices are, so Home's row does not come and go with a draft's hold. Null when the plan puts no limit on it.
 */
export async function aiCreditView(q: Queryable, companyId: string, opts: { now?: Date; timeZone?: string | null } = {}): Promise<AiCreditView | null> {
  const s = await aiCreditStanding(q, companyId, { now: opts.now, settled: true });
  if (!s) return null;
  return { level: s.level, percent: s.percent, resetsAt: s.resetsAt, notice: s.level ? aiCreditNoticeWords(s.level, { resetsOn: dayWords(s.resetsAt, opts.timeZone) }) : null };
}

/** What ITS's alert says, in dollars. */
type CreditNote = { level: AiCreditLevel; companyId: string; companyName: string; standing: AiCreditStanding };

/** The line the owner has not been told yet, if the company has reached one. */
async function lineDue(q: Queryable, input: { companyId: string; now: Date; refusedHoldUsd?: number }): Promise<{ standing: AiCreditStanding; level: AiCreditLevel } | null> {
  const standing = await aiCreditStanding(q, input.companyId, { now: input.now, settled: true });
  if (!standing) return null;
  const goneForThisCall = input.refusedHoldUsd !== undefined && standing.spentMicros + toMicros(input.refusedHoldUsd) > standing.limitMicros - SLACK;
  const level: AiCreditLevel | null = goneForThisCall ? "used_up" : standing.level;
  if (!level) return null;
  const { periodKey, told } = standing;
  if (level === "used_up" ? told.usedUpFor === periodKey : told.warnedFor === periodKey || told.usedUpFor === periodKey) return null;
  return { standing, level };
}

/**
 * Tells the owner once that the credit reached a line, and hands back what ITS's alert needs. Each line is stamped on the
 * company's settings by one statement that matches only a period not told yet, as the trial's notices are, so two calls
 * ending together tell it once; `raiseAlertOnce`'s `created` could not say that, because it raises again once an
 * acknowledgement is a day old. Used up covers 80%: a credit that jumps past both is told once. Read from money actually
 * spent, so a big hold that comes back does not cry wolf: `refusedHoldUsd`, a small call was just refused, says the credit
 * is gone only when what is spent would refuse it by itself (money spent never comes back, so that stays true for the period).
 *
 * A line that looks due is read again behind the company's row, because this read and the stamp must see one plan: a Change
 * plan holds that row, and writes the settings without the stamps; a stamp waiting for it would go on the settings it just
 * cleaned, from a limit it just replaced, and an upgraded company would read used up for the month. Only then, so a call with
 * nothing to tell takes no lock.
 */
async function tellOwner(db: Db, input: { companyId: string; now: Date; refusedHoldUsd?: number }): Promise<CreditNote | null> {
  return withTenant(db, input.companyId, async (q) => {
    if (!(await lineDue(q, input))) return null;
    await q.execute(sql`select 1 from ${companies} where ${companies.id} = ${input.companyId} for no key update`);
    const due = await lineDue(q, input);
    if (!due) return null;
    const { standing, level } = due;
    const { periodKey } = standing;
    const stamp = JSON.stringify(level === "used_up" ? { warnedFor: periodKey, usedUpFor: periodKey } : { warnedFor: periodKey });
    const field = sql.raw(level === "used_up" ? "'usedUpFor'" : "'warnedFor'");
    const [company] = await q
      .update(companies)
      .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || jsonb_build_object('aiCreditTold', coalesce(${companies.settings}->'aiCreditTold', '{}'::jsonb) || ${stamp}::jsonb)` })
      .where(and(eq(companies.id, input.companyId), sql`(${companies.settings}->'aiCreditTold'->>${field}) is distinct from ${periodKey}`))
      .returning({ name: companies.name, timezone: companies.timezone });
    if (!company) return null;
    const usedUp = level === "used_up";
    await emit(q, { type: usedUp ? "entitlement.exceeded" : "entitlement.warning", companyId: input.companyId, actor: { kind: "system", id: "allowance" }, subject: { type: "company", id: input.companyId }, payload: { key: standing.key, percent: standing.percent } });
    const { title, body } = aiCreditNoticeWords(level, { resetsOn: dayWords(standing.resetsAt, company.timezone) });
    await notify(q, { companyId: input.companyId, kind: "entitlement.ai_credit", title, body, action: { label: "See usage", href: "/setup" }, roles: ["owner", "admin"] });
    return { level, companyId: input.companyId, companyName: company.name, standing };
  });
}

const usd = (micros: number) => `$${(micros / MICROS).toFixed(2)}`;

/**
 * Tells ITS (one alert while it stands; never critical, because one company's credit is no outage). Platform side only: the
 * tenant role cannot write alerts. Last month's alert, still on the list, must not stand in for this month's.
 */
async function flagIts(q: Queryable, note: CreditNote, now: Date): Promise<void> {
  const { standing, companyName, companyId } = note;
  await settleAiCreditAlerts(q, { companyId, now });
  const usedUp = note.level === "used_up";
  const spent = `${usd(standing.spentMicros)} of ${usd(standing.limitMicros)} used${standing.monthly ? " this month" : ""}.`;
  await raiseAlertOnce(q, {
    kind: usedUp ? "billing.ai_credit_used_up" : "billing.ai_credit_warning",
    severity: usedUp ? "high" : "info",
    companyId,
    target: { type: "company", id: companyId },
    title: usedUp ? `${companyName} has used up its AI credit` : `${companyName} has used 80% of its AI credit`,
    body: usedUp
      ? `${spent} Applications still come in and candidates finish their chats in the job's own words; new applicants are not read by AI and AI reviews wait until the plan changes${standing.monthly ? " or the month starts again" : ""}. Talk with the customer about upgrading.`
      : `${spent} Nothing has stopped. Talk with the customer about upgrading before it runs out.`,
    details: { key: standing.key, spentUsd: standing.spentMicros / MICROS, limitUsd: standing.limitMicros / MICROS },
  }, { now });
}

/** The two alerts about the credit, and whether each still stands for where the company is now. */
const CREDIT_ALERTS: Record<string, (s: AiCreditStanding | null) => boolean> = {
  "billing.ai_credit_warning": (s) => !!s && s.percent >= WARN_PERCENT,
  "billing.ai_credit_used_up": (s) => !!s?.usedUp,
};

/**
 * Resolves the credit's alerts that no longer stand: a new month, or a new plan. Kept apart from `settleAllowanceAlerts`,
 * which reads counts from their rows and takes a missing row as over: a credit is summed live, and a plan with no limit on
 * it is over nothing. Platform side only; the console runs it before it lists alerts. Returns how many it resolved.
 */
export async function settleAiCreditAlerts(q: Queryable, opts: { companyId?: string; now?: Date } = {}): Promise<number> {
  const where = [inArray(adminAlerts.kind, Object.keys(CREDIT_ALERTS)), inArray(adminAlerts.status, ["open", "acknowledged"])];
  if (opts.companyId) where.push(eq(adminAlerts.companyId, opts.companyId));
  const alerts = await q.select({ id: adminAlerts.id, kind: adminAlerts.kind, companyId: adminAlerts.companyId }).from(adminAlerts).where(and(...where));
  if (!alerts.length) return 0;
  const now = opts.now ?? new Date();
  const standings = new Map<string, AiCreditStanding | null>();
  for (const companyId of new Set(alerts.flatMap((a) => (a.companyId ? [a.companyId] : [])))) standings.set(companyId, await aiCreditStanding(q, companyId, { now }));
  const gone = alerts.filter((a) => !!a.companyId && !CREDIT_ALERTS[a.kind]?.(standings.get(a.companyId) ?? null));
  if (!gone.length) return 0;
  const done = await q.update(adminAlerts).set({ status: "resolved", resolvedAt: now.toISOString() }).where(and(inArray(adminAlerts.id, gone.map((a) => a.id)), inArray(adminAlerts.status, ["open", "acknowledged"]))).returning({ id: adminAlerts.id, companyId: adminAlerts.companyId });
  for (const a of done) await audit(q, { companyId: a.companyId, actor: { kind: "system", id: "allowance" }, action: "alert.resolved", target: { type: "integration", id: a.id }, reason: "the AI credit has room again: a new month or a new plan", details: { resolved: true, automatic: true } });
  return done.length;
}

/** After a call: the owner and ITS hear about a line it crossed. Never fails the call it follows, whose row is already written. */
async function tellAfter(db: Db, input: { companyId: string; now: Date; refusedHoldUsd?: number }): Promise<void> {
  try {
    const note = await tellOwner(db, input);
    if (note) await withPlatform(db, (q) => flagIts(q, note, input.now));
  } catch (err) {
    console.warn(`[ai-credit] could not tell about the credit: ${errorForLog(err)}`);
  }
}

/** What the runner asks of the credit (`AiCreditGate` in packages/ai/src/runner.ts). `now`: the engine's clock, so a moved clock moves the period too. */
export function createAiCreditGate(deps: { now?: () => Date } = {}) {
  const clock = deps.now ?? (() => new Date());
  return {
    async hold(db: Db, input: { companyId: string; holdUsd: number; runs: Array<typeof aiRuns.$inferInsert> }): Promise<"unmetered" | "held" | "refused"> {
      const now = clock();
      const verdict = await withTenant(db, input.companyId, async (q) => {
        const answer = await reserveAiCredit(q, { companyId: input.companyId, holdUsd: input.holdUsd, now });
        if (answer === "held") await q.insert(aiRuns).values(input.runs);
        return answer;
      });
      if (verdict === "refused" && input.holdUsd <= SMALL_HOLD_USD) await tellAfter(db, { companyId: input.companyId, now, refusedHoldUsd: input.holdUsd });
      return verdict;
    },
    async settle(db: Db, input: { companyId: string; runId: string; values: Partial<typeof aiRuns.$inferInsert> }): Promise<void> {
      await withTenant(db, input.companyId, (q) => q.update(aiRuns).set(input.values).where(eq(aiRuns.id, input.runId)));
      await tellAfter(db, { companyId: input.companyId, now: clock() });
    },
  };
}

/** A company's AI credit on ITS's customer row, in dollars. Never sent to a customer. */
export type AiCreditLine = { monthly: boolean; spentUsd: number; limitUsd: number; percent: number; level: AiCreditLevel | null; resetsAt: string | null };

/** Every limited company's line, in a fixed handful of queries (the console's customer list). Platform side only. */
export async function aiCreditLines(q: Queryable, opts: { now?: Date } = {}): Promise<Map<string, AiCreditLine>> {
  const now = opts.now ?? new Date();
  const rows = await q.select().from(entitlements).where(limitedRows()).orderBy(asc(entitlements.key));
  if (!rows.length) return new Map();
  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const told = new Map((await q.select({ id: companies.id, settings: companies.settings }).from(companies).where(inArray(companies.id, companyIds))).map((c) => [c.id, c.settings?.aiCreditTold ?? {}]));
  const micros = sql<string>`coalesce(sum(${aiRuns.costUsd}), 0) * 1000000`;
  const lifetime = new Map((await q.select({ companyId: aiRuns.companyId, micros }).from(aiRuns).where(inArray(aiRuns.companyId, companyIds)).groupBy(aiRuns.companyId)).map((r) => [r.companyId, Math.round(Number(r.micros))]));
  const months = rows.flatMap((r) => { const since = sinceOf(r, now); return since ? [{ companyId: r.companyId, since }] : []; });
  const thisMonth = new Map(months.length ? (await q.select({ companyId: aiRuns.companyId, micros }).from(aiRuns).where(or(...months.map((m) => and(eq(aiRuns.companyId, m.companyId), gte(aiRuns.createdAt, m.since))))).groupBy(aiRuns.companyId)).map((r) => [r.companyId, Math.round(Number(r.micros))]) : []);
  const out = new Map<string, AiCreditLine>();
  for (const row of rows) {
    const spent = (isMonthly(row.key) && sinceOf(row, now) ? thisMonth : lifetime).get(row.companyId) ?? 0;
    const s = standingOf(row, spent, told.get(row.companyId) ?? {}, now);
    const before = out.get(row.companyId);
    if (before && before.percent > s.percent) continue;
    out.set(row.companyId, { monthly: s.monthly, spentUsd: s.spentMicros / MICROS, limitUsd: s.limitMicros / MICROS, percent: s.percent, level: s.level, resetsAt: s.resetsAt });
  }
  return out;
}

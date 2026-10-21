import { and, eq, sql, type SQL } from "drizzle-orm";
import { TRIAL_ENDED_LINE, TRIAL_NOTICE_DAYS, TRIAL_PLAN_KEY, newTrialTerm, onTrialPlan, trialStanding, trialTermOf, type Actor, type TrialExtension, type TrialStanding, type TrialTerm } from "@ros/contracts";
import { audit, closingDayWords, companyToday, emit, notify, raiseAlert, resolveAlertsFor } from "@ros/core";
import { companies, roles, withTenant, type Queryable } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { replayHeldEmails } from "../webhooks/postmark";

/**
 * The Trial plan's 30 days (founder decision L-02 B, 16 October 2026), on the API side: the dates written on
 * `companies.settings.trial`, the refusal of new work once a trial has ended, ITS's extension from the console, and the
 * hourly check that starts the 30 days for a company already on Trial and tells ITS and the owners once a trial ends.
 * The rules themselves (when a trial ends, whether a company is paused) are pure, in @ros/contracts domain/trial.ts.
 *
 * Every write of the dates is one JSON-merge statement on companies.settings (or runs under the company's row lock),
 * so a customer's own settings change (company-settings.ts writes the whole object under the row lock) and a trial
 * write made at the same moment never overwrite each other.
 */

const DAY_MS = 86_400_000;
/** Who started or ended a trial when no person did: the hourly check. */
const TRIAL_SYSTEM: Actor = { kind: "system", id: "trial", name: "Trial check" };
/** The kind of the ITS alert raised once when a trial ends; resolved by an extension or a change of plan. */
export const TRIAL_ENDED_ALERT = "billing.trial_ended";

/** The question the team sends ITS from a refusal: the existing "ask ITS" request about the plan. */
export const TRIAL_PLAN_QUESTION = "Our trial has ended. We would like to choose a plan.";
const askForPlan = { label: "Ask ITS to choose a plan", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: TRIAL_PLAN_QUESTION } };

/** A trial date in words, on the company's own calendar: "Friday, October 30". */
export function trialDateWords(iso: string, timeZone: string | null | undefined): string {
  return closingDayWords(companyToday(new Date(iso), timeZone));
}

/**
 * The `trial` key as one JSON-merge fragment for an update's SET (`settings || <this>`). `keep`: a company that already
 * has dates keeps them (confirming again, or after a confirmation was taken back, never restarts a trial).
 */
export function trialPatch(term: TrialTerm, opts: { keep?: boolean } = {}): SQL {
  const value = sql`${JSON.stringify(term)}::jsonb`;
  return sql`jsonb_build_object('trial', ${opts.keep ? sql`coalesce(${companies.settings}->'trial', ${value})` : value})`;
}

/** Writes the trial dates in one statement (see `trialPatch`). */
export async function writeTrialTerm(q: Queryable, companyId: string, term: TrialTerm, opts: { keep?: boolean } = {}): Promise<void> {
  await q.update(companies).set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || ${trialPatch(term, opts)}` }).where(eq(companies.id, companyId));
}

/** Where a company stands on its trial now; null when it is not on the Trial plan (or does not exist). */
export async function companyTrialStanding(q: Queryable, companyId: string, now: Date): Promise<TrialStanding | null> {
  const [co] = await q.select({ planKey: companies.planKey, settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return co ? trialStanding(co, now) : null;
}

/**
 * Refuses new work once the trial has ended and no other plan was chosen: approving a job for its first time live,
 * resuming one, turning its applications back on, or a closing date that would reopen them (402 `trial_ended`, with the
 * owner's line and the "ask ITS" action). Everything already started is never refused here.
 */
export async function assertNoNewWork(q: Queryable, companyId: string, now: Date): Promise<void> {
  if ((await companyTrialStanding(q, companyId, now))?.ended) throw new HttpError(402, "trial_ended", TRIAL_ENDED_LINE, { actions: [askForPlan] });
}

/**
 * ITS extends a customer's trial from the console (the Plan tab), by `days`, with a reason. The new end counts from the
 * later of the old end and now, so a trial that already ended gets the full number of days from today. The extension
 * is kept on the dates, the "trial ended" stamp is cleared (the next end is told again), the change is audited with the
 * reason and emitted, the ITS alert about the end is resolved and the owners are told. Runs under the company's row lock.
 */
export async function extendTrial(q: Queryable, input: { companyId: string; days: number; reason: string; actor: Actor; now: Date }): Promise<{ wasPaused: boolean; standing: TrialStanding | null }> {
  const { companyId, days, reason, actor, now } = input;
  const [co] = await q.select({ id: companies.id, planKey: companies.planKey, settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1).for("update");
  if (!co) throw new HttpError(404, "not_found", "Company not found.");
  if (!onTrialPlan(co.planKey)) throw new HttpError(409, "not_on_trial", "This customer is not on the Trial plan.");
  const term = trialTermOf(co.settings);
  if (!term) throw new HttpError(409, "trial_not_started", "The trial starts when ITS confirms the company, so there is nothing to extend yet.");
  const wasPaused = trialStanding(co, now)?.ended === true;
  const to = new Date(Math.max(Date.parse(term.endsAt), now.getTime()) + days * DAY_MS).toISOString();
  const extension: TrialExtension = { days, reason, by: actor, at: now.toISOString(), from: term.endsAt, to };
  const { endNoticeAt: _told, ...rest } = term;
  // The owners' notice below names the new end, so an extension that lands inside the last days does not also send
  // the "your trial ends" email for the same date an hour later.
  const left = Date.parse(to) - now.getTime();
  const next: TrialTerm = { ...rest, endsAt: to, extensions: [...(term.extensions ?? []), extension], ...(left <= TRIAL_NOTICE_DAYS * DAY_MS ? { soonNoticeFor: to } : {}), ...(left <= DAY_MS ? { lastDayNoticeFor: to } : {}) };
  await writeTrialTerm(q, co.id, next);
  await audit(q, { companyId, actor, action: "trial.extended", target: { type: "company", id: companyId }, reason, details: { days, from: term.endsAt, to } });
  await emit(q, { type: "trial.extended", companyId, actor, subject: { type: "company", id: companyId }, payload: { days, from: term.endsAt, to, wasPaused } });
  await resolveAlertsFor(q, TRIAL_ENDED_ALERT, companyId, now);
  const date = trialDateWords(to, co.timezone);
  await notify(q, { companyId, kind: "company.trial_extended", title: "ITS extended your trial", body: `ITS extended your trial to ${date}.${wasPaused ? " New applications are open again." : ""}`, action: { label: "See your plan", href: "/setup" }, roles: ["owner", "admin"] });
  return { wasPaused, standing: trialStanding({ planKey: co.planKey, settings: { ...co.settings, trial: next } }, now) };
}

/**
 * Once a paused company can take applications again (an extension, a change of plan), the emails that arrived for its
 * jobs while it was paused are added, job by job, as when a job reopens (C19). Run after the change has committed; a
 * no-op for a job that is still not taking applications, and while the company is still paused.
 */
export async function replayHeldEmailsForCompany(container: Container, companyId: string): Promise<{ replayed: number; failed: number }> {
  const open = await withTenant(container.db, companyId, (tx) => tx.select({ id: roles.id }).from(roles).where(and(eq(roles.companyId, companyId), eq(roles.status, "open"), eq(roles.acceptingApplications, true))));
  const total = { replayed: 0, failed: 0 };
  for (const r of open) {
    const done = await replayHeldEmails(container, { companyId, roleId: r.id });
    total.replayed += done.replayed;
    total.failed += done.failed;
  }
  return total;
}

/**
 * The hourly check (apps/api maintenance.ts runHourlyChecks), in one platform transaction:
 *   1. A confirmed company on Trial with no dates (on Trial when this shipped, confirmed before it) gets its 30 days
 *      from now ("switched_on"), written only where none exist, so a company is never paused the moment this ships.
 *   2. A trial that has ended and was not told yet: the end is stamped by an update that matches only an unstamped term
 *      with the same end date and returns the row, so exactly one run tells it. ITS gets one alert, the owners and
 *      admins one notice, and the end is emitted and audited.
 *   3. A trial still running that ends within TRIAL_NOTICE_DAYS, then within a day: the owners and admins are told
 *      once each ("Your trial ends on …", "Your trial ends tomorrow"), stamped the same way per end date. These are
 *      account updates, so they are emailed as they happen unless a person turned that off; Home and Settings show the
 *      date too.
 * Returns how many trials started, ended and were warned in this run.
 */
export async function settleTrials(q: Queryable, now: Date): Promise<{ started: number; ended: number; warned: number }> {
  let started = 0;
  let ended = 0;
  let warned = 0;
  const waiting = await q
    .select({ id: companies.id, timezone: companies.timezone })
    .from(companies)
    .where(and(eq(companies.planKey, TRIAL_PLAN_KEY), sql`coalesce(${companies.settings}->>'verifiedAt', '') <> ''`, sql`${companies.settings}->'trial' is null`));
  for (const co of waiting) {
    const term = newTrialTerm(now, "switched_on");
    const [wrote] = await q
      .update(companies)
      .set({ settings: sql`coalesce(${companies.settings}, '{}'::jsonb) || ${trialPatch(term, { keep: true })}` })
      .where(and(eq(companies.id, co.id), eq(companies.planKey, TRIAL_PLAN_KEY), sql`${companies.settings}->'trial' is null`))
      .returning({ id: companies.id });
    if (!wrote) continue;
    started += 1;
    await audit(q, { companyId: co.id, actor: TRIAL_SYSTEM, action: "trial.started", target: { type: "company", id: co.id }, reason: "the 30-day trial started when trial dates were switched on", details: { startedAt: term.startedAt, endsAt: term.endsAt, startedBy: term.startedBy } });
    await emit(q, { type: "trial.started", companyId: co.id, actor: TRIAL_SYSTEM, subject: { type: "company", id: co.id }, payload: { startedAt: term.startedAt, endsAt: term.endsAt, startedBy: term.startedBy } });
    await notify(q, { companyId: co.id, kind: "company.trial_started", title: "Your 30-day trial has started", body: `Your 30-day trial runs until ${trialDateWords(term.endsAt, co.timezone)}.`, action: { label: "See your plan", href: "/setup" }, roles: ["owner", "admin"] });
  }
  const running = await q
    .select({ id: companies.id, name: companies.name, settings: companies.settings, timezone: companies.timezone })
    .from(companies)
    .where(and(eq(companies.planKey, TRIAL_PLAN_KEY), sql`${companies.settings}->'trial' is not null`, sql`${companies.settings}->'trial'->>'endNoticeAt' is null`));
  const at = now.toISOString();
  for (const co of running) {
    const term = trialTermOf(co.settings);
    if (!term) continue;
    if (Date.parse(term.endsAt) > now.getTime()) {
      if (await warnTrialEnding(q, co, term, now)) warned += 1;
      continue;
    }
    const [stamped] = await q
      .update(companies)
      .set({ settings: sql`${companies.settings} || jsonb_build_object('trial', (${companies.settings}->'trial') || jsonb_build_object('endNoticeAt', ${at}::text))` })
      .where(and(eq(companies.id, co.id), eq(companies.planKey, TRIAL_PLAN_KEY), sql`${companies.settings}->'trial'->>'endNoticeAt' is null`, sql`${companies.settings}->'trial'->>'endsAt' = ${term.endsAt}`))
      .returning({ id: companies.id });
    if (!stamped) continue;
    ended += 1;
    const extensions = term.extensions ?? [];
    await raiseAlert(q, {
      kind: TRIAL_ENDED_ALERT,
      severity: "high",
      companyId: co.id,
      target: { type: "company", id: co.id },
      title: `${co.name}'s trial has ended`,
      body: "New applications, new jobs and new AI interviews are paused until a plan is chosen. Everything already started carries on. Change the plan, or extend the trial, in the console under Customers, Plan.",
      details: { startedAt: term.startedAt, endsAt: term.endsAt, extensions },
    });
    await notify(q, { companyId: co.id, kind: "company.trial_ended", title: "Your trial has ended", body: TRIAL_ENDED_LINE, action: { label: "See your plan", href: "/setup" }, roles: ["owner", "admin"] });
    await emit(q, { type: "trial.ended", companyId: co.id, actor: TRIAL_SYSTEM, subject: { type: "company", id: co.id }, payload: { startedAt: term.startedAt, endsAt: term.endsAt, extensions: extensions.length } });
    await audit(q, { companyId: co.id, actor: TRIAL_SYSTEM, action: "trial.ended", target: { type: "company", id: co.id }, reason: "the trial's days are over and no other plan was chosen", details: { startedAt: term.startedAt, endsAt: term.endsAt, extensions: extensions.length } });
  }
  return { started, ended, warned };
}

/** Which "your trial ends" notice is due for a running trial: the last day's, else the last week's; each once per end date. */
export function trialEndingNoticeDue(term: TrialTerm, now: Date): "last_day" | "soon" | null {
  const left = Date.parse(term.endsAt) - now.getTime();
  if (left <= 0) return null;
  if (left <= DAY_MS) return term.lastDayNoticeFor === term.endsAt ? null : "last_day";
  if (left <= TRIAL_NOTICE_DAYS * DAY_MS) return term.soonNoticeFor === term.endsAt ? null : "soon";
  return null;
}

/**
 * Tells the owners and admins once that the trial ends soon (step 3 of `settleTrials`). The stamp is written by an update
 * that matches only the same end date not yet told, so two runs never both tell it; the last day's notice also stamps
 * the week's, so a trial that reaches its last day untold gets one notice, not two. True when a notice went.
 */
async function warnTrialEnding(q: Queryable, co: { id: string; timezone: string | null }, term: TrialTerm, now: Date): Promise<boolean> {
  const due = trialEndingNoticeDue(term, now);
  if (!due) return false;
  const field = due === "last_day" ? "lastDayNoticeFor" : "soonNoticeFor";
  const stamp = due === "last_day"
    ? sql`jsonb_build_object('lastDayNoticeFor', ${term.endsAt}::text, 'soonNoticeFor', ${term.endsAt}::text)`
    : sql`jsonb_build_object('soonNoticeFor', ${term.endsAt}::text)`;
  const [stamped] = await q
    .update(companies)
    .set({ settings: sql`${companies.settings} || jsonb_build_object('trial', (${companies.settings}->'trial') || ${stamp})` })
    .where(and(eq(companies.id, co.id), eq(companies.planKey, TRIAL_PLAN_KEY), sql`${companies.settings}->'trial'->>'endsAt' = ${term.endsAt}`, sql`(${companies.settings}->'trial'->>${sql.raw(`'${field}'`)}) is distinct from ${term.endsAt}`))
    .returning({ id: companies.id });
  if (!stamped) return false;
  const date = trialDateWords(term.endsAt, co.timezone);
  const when = due === "last_day" ? (date === trialDateWords(now.toISOString(), co.timezone) ? "today" : "tomorrow") : `on ${date}`;
  const body = `Your trial ends ${due === "last_day" ? `${when}, ${date}` : when}. After that, new applications, new jobs and new AI interviews pause until a plan is chosen; everything already started carries on. To keep going, ask ITS to choose a plan from Settings.`;
  await notify(q, { companyId: co.id, kind: "company.trial_ending", title: `Your trial ends ${when}`, body, action: { label: "See your plan", href: "/setup" }, roles: ["owner", "admin"] });
  return true;
}

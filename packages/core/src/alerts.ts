import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Actor, Subject } from "@ros/contracts";
import { adminAlerts, jobs, users, type Queryable } from "@ros/db";
import { audit } from "./audit";

/** The queued job that emails a critical alert to the platform administrators (`emailCriticalAlert`). */
export const ALERT_EMAIL_JOB_KIND = "alert.email";
/**
 * The tries a critical alert's email gets: as many as a queued message (`SEND_MAX_ATTEMPTS` in @ros/agents), which with
 * the queue's growing waits (2 s doubling to 15 minutes) cover about an hour, so a short email outage never loses the
 * alert about an AI outage or an overdue request.
 */
export const ALERT_EMAIL_MAX_ATTEMPTS = 13;

/**
 * Whether critical alerts are emailed, and on which clock their job is due. The process that registers the
 * `ALERT_EMAIL_JOB_KIND` handler switches it on (apps/api/src/container.ts), so a process or a test without the handler
 * never queues a job nobody can run.
 */
let alertEmailClock: (() => Date) | null = null;
export function setAlertEmails(clock: (() => Date) | null): void {
  alertEmailClock = clock;
}

/**
 * Something a person at ITS must see (a failed credential deletion, for example). Shown in the admin console until it is
 * resolved. A critical one is also emailed to the platform administrators: the job is written in the same transaction
 * as the alert, so an alert that rolls back sends nothing, and the email provider decides whether it really leaves.
 */
export async function raiseAlert(q: Queryable, input: { kind: string; severity?: "info" | "high" | "critical"; title: string; body: string; companyId?: string | null; target?: Subject | null; details?: Record<string, unknown> }): Promise<{ id: string }> {
  const [row] = await q.insert(adminAlerts).values({ kind: input.kind, severity: input.severity ?? "high", title: input.title, body: input.body, companyId: input.companyId ?? null, target: input.target ?? null, details: input.details ?? {} }).returning({ id: adminAlerts.id });
  if (input.severity === "critical" && alertEmailClock) await q.insert(jobs).values({ kind: ALERT_EMAIL_JOB_KIND, payload: { alertId: row.id }, runAt: alertEmailClock().toISOString(), maxAttempts: ALERT_EMAIL_MAX_ATTEMPTS });
  return row;
}

/**
 * Raises an alert unless one of this kind (and target) still stands (open, or acknowledged within the last day), or one
 * was raised less than `withinMs` ago. This is how a condition that is checked often (a stale worker, a stale queue, a
 * fake scanner in production) becomes one alert, not one per check, for as long as it lasts. The condition's end
 * resolves its alert (`resolveAlertsOfKind`, `resolveAlertsFor`, `settleAllowanceAlerts`), so the next time it shows up
 * it is a new alert (Wave S2 F1). An acknowledgement older than a day no longer stands, as a safety net for a condition
 * nothing resolves. Returns the alert that stands, with `created` saying whether this call made it.
 */
export async function raiseAlertOnce(q: Queryable, input: Parameters<typeof raiseAlert>[1], opts: { withinMs?: number; now?: Date } = {}): Promise<{ id: string; created: boolean }> {
  const now = opts.now ?? new Date();
  const sameTarget = (t: Subject | null) => !input.target || t?.id === input.target.id;
  const stillStands = (a: { status: string; acknowledgedAt: string | null }) => a.status === "open" || !a.acknowledgedAt || now.getTime() - Date.parse(a.acknowledgedAt) < ACKNOWLEDGEMENT_STANDS_MS;
  const standing = (await q.select({ id: adminAlerts.id, target: adminAlerts.target, status: adminAlerts.status, acknowledgedAt: adminAlerts.acknowledgedAt }).from(adminAlerts).where(and(eq(adminAlerts.kind, input.kind), inArray(adminAlerts.status, [...STANDING_STATUSES]))).orderBy(desc(adminAlerts.createdAt)).limit(50)).find((a) => sameTarget(a.target) && stillStands(a));
  if (standing) return { id: standing.id, created: false };
  if (opts.withinMs) {
    const since = new Date(now.getTime() - opts.withinMs).toISOString();
    const recent = (await q.select({ id: adminAlerts.id, target: adminAlerts.target }).from(adminAlerts).where(and(eq(adminAlerts.kind, input.kind), gte(adminAlerts.createdAt, since))).orderBy(desc(adminAlerts.createdAt)).limit(50)).find((a) => sameTarget(a.target));
    if (recent) return { id: recent.id, created: false };
  }
  const row = await raiseAlert(q, input);
  return { id: row.id, created: true };
}

/**
 * The alerts that stop a new one of the same kind and target while the condition lasts: open, and acknowledged (seen,
 * still going on). Acknowledging means "seen", not "over": a condition that goes on raises nothing new, and its end
 * resolves the alert.
 */
export const STANDING_STATUSES = ["open", "acknowledged"] as const;

/** An acknowledgement stands this long; after it, a condition still going on raises a fresh alert (the safety net). */
export const ACKNOWLEDGEMENT_STANDS_MS = 24 * 3600_000;

/** The alerts the console shows: open and acknowledged, until someone (or the fix itself) resolves them. */
export async function openAlerts(q: Queryable, limit = 200) {
  return q.select().from(adminAlerts).where(inArray(adminAlerts.status, ["open", "acknowledged"])).orderBy(desc(adminAlerts.createdAt)).limit(limit);
}

export async function acknowledgeAlert(q: Queryable, input: { id: string; actor: Actor; now?: Date }): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const rows = await q.update(adminAlerts).set({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy: input.actor.id }).where(and(eq(adminAlerts.id, input.id), eq(adminAlerts.status, "open"))).returning({ id: adminAlerts.id, companyId: adminAlerts.companyId });
  if (rows[0]) await audit(q, { companyId: rows[0].companyId, actor: input.actor, action: "alert.acknowledged", target: { type: "integration", id: input.id }, reason: "acknowledged in the admin console" });
  return rows.length > 0;
}

/**
 * A person marks an alert dealt with (open or acknowledged). It leaves the console's list and stays in the table for
 * the record; the next time the problem shows up, a new alert is raised. Audited with the person's note.
 */
export async function resolveAlert(q: Queryable, input: { id: string; actor: Actor; note?: string | null; now?: Date }): Promise<"resolved" | "already_resolved" | "not_found"> {
  const now = (input.now ?? new Date()).toISOString();
  const [row] = await q.select({ id: adminAlerts.id, status: adminAlerts.status, companyId: adminAlerts.companyId }).from(adminAlerts).where(eq(adminAlerts.id, input.id)).limit(1);
  if (!row) return "not_found";
  if (row.status === "resolved") return "already_resolved";
  const done = await q
    .update(adminAlerts)
    .set({ status: "resolved", resolvedAt: now, ...(row.status === "open" ? { acknowledgedAt: now, acknowledgedBy: input.actor.id } : {}) })
    .where(and(eq(adminAlerts.id, input.id), inArray(adminAlerts.status, ["open", "acknowledged"])))
    .returning({ id: adminAlerts.id });
  if (!done[0]) return "already_resolved";
  const note = input.note?.trim();
  await audit(q, { companyId: row.companyId, actor: input.actor, action: "alert.resolved", target: { type: "integration", id: input.id }, reason: note ? `resolved in the admin console: ${note}` : "resolved in the admin console", details: { resolved: true } });
  return "resolved";
}

/** Resolves every open alert about a target (for example once a failed deletion finally succeeds). */
export async function resolveAlertsFor(q: Queryable, kind: string, targetId: string, now: Date = new Date()): Promise<number> {
  const open = await q.select({ id: adminAlerts.id, target: adminAlerts.target }).from(adminAlerts).where(and(eq(adminAlerts.kind, kind), inArray(adminAlerts.status, ["open", "acknowledged"])));
  const ids = open.filter((a) => a.target?.id === targetId).map((a) => a.id);
  if (!ids.length) return 0;
  await q.update(adminAlerts).set({ status: "resolved", resolvedAt: now.toISOString() }).where(inArray(adminAlerts.id, ids));
  return ids.length;
}

/**
 * Resolves every open or acknowledged alert of a kind that has no target, once its condition is over (the worker is
 * polling again, the queue is drained, the real email provider is in use), so the next occurrence is a new alert.
 * Each one is audited as resolved by the system, with why.
 */
export async function resolveAlertsOfKind(q: Queryable, kind: string, opts: { now?: Date; reason: string }): Promise<number> {
  const now = (opts.now ?? new Date()).toISOString();
  const done = await q.update(adminAlerts).set({ status: "resolved", resolvedAt: now }).where(and(eq(adminAlerts.kind, kind), inArray(adminAlerts.status, ["open", "acknowledged"]))).returning({ id: adminAlerts.id, companyId: adminAlerts.companyId });
  for (const a of done) await audit(q, { companyId: a.companyId, actor: { kind: "system", id: "alerts" }, action: "alert.resolved", target: { type: "integration", id: a.id }, reason: opts.reason, details: { resolved: true, automatic: true } });
  return done.length;
}

/** What an email to an administrator needs from the email adapter (packages/integrations); kept narrow so core does not depend on it. */
export type AlertEmailSender = (message: { to: string; from: string; subject: string; text: string; idempotencyKey: string; tags?: Record<string, string> }) => Promise<{ status: "sent" | "pending" | "failed"; error?: string; retryable?: boolean }>;

/** An alert's words as they go out by email: email addresses in them (a complaining recipient, say) are left out. */
export function alertEmailText(alert: { kind: string; severity: string; title: string; body: string; createdAt: string }, consoleUrl?: string | null): { subject: string; text: string } {
  const plain = (s: string) => s.replace(/[^\s<>()"']+@[^\s<>()"']+\.[A-Za-z]{2,}/g, "[an email address]");
  const subject = `Critical alert: ${plain(alert.title)}`;
  const text = [
    plain(alert.title),
    "",
    plain(alert.body),
    "",
    `Kind: ${alert.kind}. Raised ${new Date(alert.createdAt).toUTCString()}.`,
    consoleUrl ? `Open the admin console (Failures) to acknowledge or resolve it: ${consoleUrl}` : "Open the admin console (Failures) to acknowledge or resolve it.",
  ].join("\n");
  return { subject, text };
}

/**
 * Emails one critical alert to every platform administrator, once: from the job (ALERT_EMAIL_JOB_KIND), or straight
 * after the commit by the process that raised it (the app's health watch, when the worker that runs jobs is the thing
 * that is down). Each address that got it is recorded on the alert (`details.emailedAddresses`) as it goes, so a retry,
 * or the job after an inline send, never sends a second copy to anyone; when every address has been tried the alert
 * records `details.emailedAt`. An alert already resolved is not emailed. A failure the provider may get past is returned
 * as `retry` (never thrown here, so the addresses already reached stay recorded when the caller's transaction commits);
 * the job's handler throws it after the commit, so the queue tries again with backoff, for the addresses still missing.
 */
export async function emailCriticalAlert(q: Queryable, deps: { send: AlertEmailSender; from: string; consoleUrl?: string | null; extraRecipients?: readonly string[]; now?: Date }, input: { alertId: string }): Promise<{ sent: number; failed: number; skipped: boolean; retry?: string }> {
  const [alert] = await q.select().from(adminAlerts).where(eq(adminAlerts.id, input.alertId)).limit(1);
  if (!alert || alert.severity !== "critical" || alert.details?.emailedAt || alert.status === "resolved") return { sent: 0, failed: 0, skipped: true };
  const admins = await q.select({ email: users.email }).from(users).where(eq(users.platformRole, "platform_admin"));
  const to = [...new Set([...admins.map((a) => a.email.trim().toLowerCase()), ...(deps.extraRecipients ?? []).map((e) => e.trim().toLowerCase())].filter(Boolean))];
  const already = new Set(Array.isArray(alert.details?.emailedAddresses) ? (alert.details.emailedAddresses as unknown[]).filter((x): x is string => typeof x === "string") : []);
  const { subject, text } = alertEmailText(alert, deps.consoleUrl);
  let sent = already.size;
  let failed = 0;
  let retry: string | null = null;
  for (const address of to) {
    if (already.has(address)) continue;
    const result = await deps.send({ to: address, from: deps.from, subject, text, idempotencyKey: `alert:${alert.id}:${address}`, tags: { template: "ops_alert" } });
    if (result.status === "failed") {
      failed += 1;
      if (result.retryable) retry = result.error ?? "the email provider failed";
    } else {
      sent += 1;
      already.add(address);
      // recorded at once: a retry after a later address fails skips this one
      await q.update(adminAlerts).set({ details: sql`coalesce(${adminAlerts.details}, '{}'::jsonb) || ${JSON.stringify({ emailedAddresses: [...already] })}::jsonb` }).where(eq(adminAlerts.id, alert.id));
    }
  }
  if (retry) return { sent, failed, skipped: false, retry: `critical alert ${alert.id} email failed: ${retry}` };
  const emailedAt = (deps.now ?? new Date()).toISOString();
  await q.update(adminAlerts).set({ details: sql`coalesce(${adminAlerts.details}, '{}'::jsonb) || ${JSON.stringify({ emailedAt, emailedTo: sent, emailFailed: failed })}::jsonb` }).where(eq(adminAlerts.id, alert.id));
  return { sent, failed, skipped: false };
}

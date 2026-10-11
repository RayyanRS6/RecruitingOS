import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { queueCommunication } from "@ros/agents";
import { DIGEST_CATCH_UP_DAYS, alertLink, belongsInDigest, digestCadencesDue, digestWindow, lastDigestAt, nextDigestAt, notifyGroupOf, renderAlertEmail, renderDigestEmail, resolveNotifyCadence, rolesForLinks, storedPreferences, type DigestCadence } from "@ros/core";
import { companies, memberships, notifications, users, withTenant, workflowRuns, type Db, type Queryable } from "@ros/db";
import type { WorkflowEngine } from "../engine";
import type { Services, StepContext, WorkflowDefinition } from "../types";

/**
 * Email alerts (plan B3). Two halves, both writing team mail through the outbox (sent after the transaction commits,
 * never twice):
 *
 * - `emailNotifications`, the job `notify` queues for the people who want a group as it happens: one short email per
 *   update with what happened, the company, the role's name and a link.
 * - `notification_digest`, one run per company, forever: at 8:00 every morning in the company's time zone it sends each
 *   person one summary of the updates in their daily groups (and on Monday their weekly groups) that they have not seen
 *   or been emailed yet, counted by group and role, then sleeps until the next morning.
 *
 * Neither ever names a candidate or carries their details, a recruiter's answer or a ranking (packages/core
 * notify-email.ts writes the words). Started beside the stuck-role check; idempotent by company.
 */
export const NOTIFICATION_DIGEST_KEY = "notification_digest";
export const ALERT_TEMPLATE = "notification_alert";
export const DIGEST_TEMPLATE = "notification_digest";
const ALERT_ACTOR: Actor = { kind: "system", id: "notification_email", name: "Email alerts" };

type State = { companyId: string; lastDigestAt?: string; lastSent?: number };

/** Run states nothing wakes again. */
const ENDED_FOR_GOOD = new Set(["failed", "cancelled"]);

/**
 * Starts the company's summary run unless it has a live one; safe to call from any tenant transaction. A run that
 * ended for good (its send step ran out of attempts in an outage, or it was cancelled) gives up the company's key, so
 * the next call (the daily stuck-role check, or anyone saving their email settings) starts a new one instead of
 * finding the dead run forever. The old run keeps its record under a key of its own.
 */
export async function startNotificationDigest(engine: WorkflowEngine, q: Queryable, companyId: string, actor?: Actor): Promise<{ runId: string; created: boolean }> {
  const key = `${NOTIFICATION_DIGEST_KEY}:${companyId}`;
  const [old] = await q.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, key)).limit(1);
  if (old && ENDED_FOR_GOOD.has(old.status)) await q.update(workflowRuns).set({ idempotencyKey: `${key}:ended:${old.id}` }).where(and(eq(workflowRuns.id, old.id), eq(workflowRuns.idempotencyKey, key)));
  return engine.start(q, { workflowKey: NOTIFICATION_DIGEST_KEY, companyId, subject: { type: "company", id: companyId }, state: { companyId }, idempotencyKey: key, ...(actor ? { actor } : {}) });
}

function teamFrom(services: Services): string {
  return `${services.integrations.env.productName} <${services.integrations.env.fromAddress}>`;
}

export const notificationDigest: WorkflowDefinition<State> = {
  key: NOTIFICATION_DIGEST_KEY,
  version: 1,
  initialStep: "send",
  maxAttempts: 5,
  steps: {
    async send(ctx) {
      const [company] = await ctx.q.select({ name: companies.name, timezone: companies.timezone }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
      if (!company) return { kind: "complete" };
      const at = lastDigestAt(ctx.now, company.timezone);
      const until = nextDigestAt(ctx.now, company.timezone).toISOString();
      const sleep = (state: Partial<State>) => ({ kind: "wait" as const, wait: { kind: "timer" as const, until, reason: "next email summary" }, state, resumeStep: "send" });
      // A new run only sets its clock: the first summary is the next morning's. A wake for a time already summarized
      // (a retried step, a second worker) sends nothing.
      if (!ctx.state.lastDigestAt) return sleep({ lastDigestAt: at.toISOString() });
      if (ctx.state.lastDigestAt === at.toISOString()) return sleep({});
      const sent = await sendSummaries(ctx, { name: company.name, timezone: company.timezone }, at);
      return sleep({ lastDigestAt: at.toISOString(), lastSent: sent });
    },
  },
};

/**
 * One summary per person whose daily (or, on Monday, weekly) groups have updates they have neither read nor been
 * emailed: from the previous summary of that cadence up to this one's time (8:00, never later), reaching back a week
 * further for anything a missed summary never sent. Each update it counts is marked emailed. Returns how many went.
 */
async function sendSummaries(ctx: StepContext<State>, company: { name: string; timezone: string }, at: Date): Promise<number> {
  const due = digestCadencesDue(at, company.timezone);
  const since = (c: DigestCadence) => new Date(digestWindow(at, company.timezone, c).from.getTime() - DIGEST_CATCH_UP_DAYS * 86_400_000);
  const earliest = since(due.includes("weekly") ? "weekly" : "daily");
  const people = await ctx.q.select({ userId: users.id, email: users.email, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.status, "active")));
  const prefs = await storedPreferences(ctx.q, ctx.companyId, people.map((p) => p.userId));
  let sent = 0;
  for (const person of people) {
    const mine = prefs.get(person.userId) ?? {};
    const rows = await ctx.q
      .select({ id: notifications.id, kind: notifications.kind, action: notifications.action, createdAt: notifications.createdAt })
      .from(notifications)
      .where(and(eq(notifications.companyId, ctx.companyId), eq(notifications.userId, person.userId), isNull(notifications.emailedAt), isNull(notifications.readAt), lt(notifications.createdAt, at.toISOString()), gte(notifications.createdAt, earliest.toISOString())));
    // a daily group reaches back to yesterday's summary, a weekly one to last Monday's (each with the catch-up week)
    const cadenceOf = (kind: string) => resolveNotifyCadence(kind, mine).cadence;
    const items = rows.filter((r) => belongsInDigest(r.kind, mine, due) && Date.parse(r.createdAt) >= since(cadenceOf(r.kind) === "weekly" ? "weekly" : "daily").getTime());
    if (!items.length) continue;
    const roleOf = await rolesForLinks(ctx.q, items.map((i) => i.action?.href));
    const email = renderDigestEmail({
      recipientName: person.name,
      companyName: company.name,
      appBaseUrl: ctx.services.env.appBaseUrl,
      weekly: items.some((i) => cadenceOf(i.kind) === "weekly"),
      items: items.map((i) => { const role = i.action?.href ? roleOf.get(i.action.href) : undefined; return { kind: i.kind, roleId: role?.roleId ?? null, roleTitle: role?.title ?? null }; }),
    });
    await queueCommunication(ctx.q, ctx.services.integrations, { channel: "email", companyId: ctx.companyId, to: person.email, from: teamFrom(ctx.services), subject: email.subject, text: email.text, templateKey: DIGEST_TEMPLATE, idempotencyKey: `${DIGEST_TEMPLATE}:${ctx.companyId}:${person.userId}:${at.toISOString()}`, tags: { template: DIGEST_TEMPLATE }, actor: ctx.actor, correlationId: ctx.run.id }, ctx.now);
    await ctx.q.update(notifications).set({ emailedAt: ctx.now.toISOString() }).where(inArray(notifications.id, items.map((i) => i.id)));
    sent += 1;
  }
  return sent;
}

/**
 * The job `notify` queues: the emails for updates someone wants as they happen. Each person's setting is read again
 * here, so someone who turned the group off a moment ago, or left the team, gets nothing; an update already emailed is
 * skipped. Returns how many emails were queued.
 */
export async function emailNotifications(db: Db, services: Services, payload: Record<string, unknown>, now: Date): Promise<number> {
  const companyId = typeof payload.companyId === "string" ? payload.companyId : "";
  const ids = Array.isArray(payload.notificationIds) ? payload.notificationIds.filter((x): x is string => typeof x === "string") : [];
  if (!companyId || !ids.length) return 0;
  return withTenant(db, companyId, async (tx) => {
    const rows = await tx.select().from(notifications).where(and(eq(notifications.companyId, companyId), inArray(notifications.id, ids), isNull(notifications.emailedAt)));
    if (!rows.length) return 0;
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
    const people = await tx.select({ userId: users.id, email: users.email, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, companyId), inArray(memberships.userId, [...new Set(rows.map((r) => r.userId))]), eq(memberships.status, "active")));
    const prefs = await storedPreferences(tx, companyId, people.map((p) => p.userId));
    const roleOf = await rolesForLinks(tx, rows.map((r) => r.action?.href));
    let sent = 0;
    for (const r of rows) {
      const person = people.find((p) => p.userId === r.userId);
      if (!person || !resolveNotifyCadence(r.kind, prefs.get(r.userId) ?? {}).emailNow) continue;
      const role = r.action?.href ? roleOf.get(r.action.href) : undefined;
      const email = renderAlertEmail({ kind: r.kind, recipientName: person.name, companyName: company?.name ?? "your company", roleTitle: role?.title ?? null, link: alertLink(services.env.appBaseUrl, r.action?.href), appBaseUrl: services.env.appBaseUrl });
      await queueCommunication(tx, services.integrations, { channel: "email", companyId, to: person.email, from: teamFrom(services), subject: email.subject, text: email.text, templateKey: ALERT_TEMPLATE, idempotencyKey: `${ALERT_TEMPLATE}:${r.id}`, tags: { template: ALERT_TEMPLATE, group: notifyGroupOf(r.kind) }, actor: ALERT_ACTOR }, now);
      await tx.update(notifications).set({ emailedAt: now.toISOString() }).where(eq(notifications.id, r.id));
      sent += 1;
    }
    return sent;
  });
}

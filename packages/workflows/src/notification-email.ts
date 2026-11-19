import { and, eq, inArray, isNull } from "drizzle-orm";
import { emailsUpdate, type Actor } from "@ros/contracts";
import { QUIET_ON_FAILURE_TAG, queueCommunication } from "@ros/agents";
import { alertLink, emailUpdatesOf, renderAlertEmail, rolesForLinks } from "@ros/core";
import { companies, memberships, notifications, users, withTenant, type Db } from "@ros/db";
import { mailbox } from "@ros/integrations";
import type { Services } from "./types";

/** The template key of an email about an update. */
export const ALERT_TEMPLATE = "notification_alert";
const ALERT_ACTOR: Actor = { kind: "system", id: "notification_email", name: "Email updates" };

/**
 * Updates whose email raises no operator alert when it cannot be delivered (the outbox reads the tag). A person's
 * request for access being accepted: their screen moves on by itself, and an alert that outlives the decision would
 * only be noise.
 */
const QUIET_ON_FAILURE: ReadonlySet<string> = new Set(["company.access_accepted", "company.access_restored"]);

/**
 * The job `notify` queues: the emails for an update, one short email per person with what happened, the company, the
 * job's name and a link, through the outbox (sent after the transaction commits, never twice). Each person's "Email me
 * updates" switch is read again here, so someone who turned it off a moment ago, or left the team, gets nothing; an
 * update already emailed is skipped. No email ever names a candidate or carries their details (packages/core
 * notify-email.ts writes the words). Returns how many emails were queued.
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
    const switches = await emailUpdatesOf(tx, companyId, people.map((p) => p.userId));
    const roleOf = await rolesForLinks(tx, rows.map((r) => r.action?.href));
    const from = mailbox(services.integrations.env.productName, services.integrations.env.fromAddress);
    let sent = 0;
    for (const r of rows) {
      const person = people.find((p) => p.userId === r.userId);
      if (!person || !emailsUpdate(r.kind, switches.get(r.userId) ?? true)) continue;
      const role = r.action?.href ? roleOf.get(r.action.href) : undefined;
      const email = renderAlertEmail({ kind: r.kind, recipientName: person.name, companyName: company?.name ?? "your company", roleTitle: role?.title ?? null, link: alertLink(services.env.appBaseUrl, r.action?.href), appBaseUrl: services.env.appBaseUrl });
      await queueCommunication(tx, services.integrations, { channel: "email", companyId, to: person.email, from, subject: email.subject, text: email.text, templateKey: ALERT_TEMPLATE, idempotencyKey: `${ALERT_TEMPLATE}:${r.id}`, tags: { template: ALERT_TEMPLATE, ...(QUIET_ON_FAILURE.has(r.kind) ? { [QUIET_ON_FAILURE_TAG]: "true" } : {}) }, actor: ALERT_ACTOR }, now);
      await tx.update(notifications).set({ emailedAt: now.toISOString() }).where(eq(notifications.id, r.id));
      sent += 1;
    }
    return sent;
  });
}
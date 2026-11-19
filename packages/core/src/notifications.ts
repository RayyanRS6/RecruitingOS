import { and, eq, inArray, sql } from "drizzle-orm";
import { emailsUpdate, type Actor, type NotificationKind } from "@ros/contracts";
import { applications, jobs, memberships, notificationPreferences, notifications, roles, users, type Queryable } from "@ros/db";
import { roleIdFromHref } from "./notify-email";

export * from "./notify-email";

/** The queued job that writes the emails for an update (`emailNotifications` in @ros/workflows). */
export const NOTIFICATION_EMAIL_JOB_KIND = "notification.email";

let clock: () => Date = () => new Date();
/**
 * The process hands the engine's clock in (apps/api/src/container.ts), so an update's email job is due on the same
 * clock that runs the queue, as the outbox's send jobs are.
 */
export function setNotifyClock(next: () => Date): void {
  clock = next;
}

/**
 * An update for the team: one row per person it is for, on the app's Updates page. Each person is also emailed about it
 * when their "Email me updates" switch is on, and always for an account notice (`emailsUpdate` in @ros/contracts): a job
 * writes those emails after this transaction commits, through the outbox.
 * `about`: the application an update is about. Every update that names a candidate says so (tests/policy/candidate-readers
 * pins it), because the text is written by the time it gets here: past the plan's candidates per job nothing is written
 * at all, so no email follows either.
 */
export async function notify(
  q: Queryable,
  input: { companyId: string; kind: NotificationKind; title: string; body: string; action?: { label: string; href: string } | null; roles?: string[]; userIds?: string[]; about?: string | null },
): Promise<number> {
  if (input.about) {
    const [person] = await q.select({ lockedAt: applications.lockedAt }).from(applications).where(eq(applications.id, input.about)).limit(1);
    if (person?.lockedAt) return 0;
  }
  const roles = input.roles ?? ["owner", "admin", "hiring_manager"];
  const members = input.userIds?.length
    ? await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, input.companyId), inArray(memberships.userId, input.userIds), eq(memberships.status, "active")))
    : await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, input.companyId), inArray(memberships.role, roles), eq(memberships.status, "active")));
  if (!members.length) return 0;
  const rows = await q.insert(notifications).values(members.map((m) => ({ companyId: input.companyId, userId: m.userId, kind: input.kind, title: input.title, body: input.body, action: input.action ?? null }))).returning({ id: notifications.id, userId: notifications.userId });
  const switches = await emailUpdatesOf(q, input.companyId, rows.map((r) => r.userId));
  const emailed = rows.filter((r) => emailsUpdate(input.kind, switches.get(r.userId) ?? true));
  if (emailed.length) await q.insert(jobs).values({ kind: NOTIFICATION_EMAIL_JOB_KIND, payload: { companyId: input.companyId, notificationIds: emailed.map((r) => r.id) }, runAt: clock().toISOString(), maxAttempts: 5 });
  return members.length;
}

/**
 * "Email me updates" is one row per person and company in `notification_preferences`: this group key, with the cadence
 * "on" or "off". No row means on.
 */
const EMAIL_UPDATES_KEY = "email_updates";

/** Each person's "Email me updates" switch in one company; someone who never changed it is on. */
export async function emailUpdatesOf(q: Queryable, companyId: string, userIds: string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!userIds.length) return out;
  const ids = [...new Set(userIds)];
  for (const id of ids) out.set(id, true);
  const rows = await q.select({ userId: notificationPreferences.userId, cadence: notificationPreferences.cadence }).from(notificationPreferences).where(and(eq(notificationPreferences.companyId, companyId), eq(notificationPreferences.groupKey, EMAIL_UPDATES_KEY), inArray(notificationPreferences.userId, ids)));
  for (const r of rows) out.set(r.userId, r.cadence !== "off");
  return out;
}

/** Sets one person's "Email me updates" switch in one company. Returns what it was and what it is now, for the audit record. */
export async function setEmailUpdates(q: Queryable, input: { companyId: string; userId: string; emailUpdates: boolean; actor: Actor }): Promise<{ from: boolean; to: boolean }> {
  const from = (await emailUpdatesOf(q, input.companyId, [input.userId])).get(input.userId) ?? true;
  const cadence = input.emailUpdates ? "on" : "off";
  await q
    .insert(notificationPreferences)
    .values({ companyId: input.companyId, userId: input.userId, groupKey: EMAIL_UPDATES_KEY, cadence, setBy: input.actor })
    .onConflictDoUpdate({ target: [notificationPreferences.companyId, notificationPreferences.userId, notificationPreferences.groupKey], set: { cadence, setBy: input.actor, updatedAt: sql`now()` } });
  return { from, to: input.emailUpdates };
}

/**
 * Postmark says a team member unsubscribed (they used the unsubscribe link of an email): their "Email me updates" switch
 * is turned off in every company they belong to, so Settings shows what they asked for. Account notices are still
 * emailed; the address is on the do-not-send list anyway until an administrator releases it. Returns how many
 * memberships were changed. Runs on the platform side (the webhook knows no company).
 */
export async function stopEmailUpdatesFor(q: Queryable, input: { address: string; actor: Actor }): Promise<number> {
  const address = input.address.trim().toLowerCase();
  if (!address) return 0;
  const people = await q.select({ userId: memberships.userId, companyId: memberships.companyId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(users.email, address), eq(memberships.status, "active")));
  for (const p of people) await setEmailUpdates(q, { companyId: p.companyId, userId: p.userId, emailUpdates: false, actor: input.actor });
  return people.length;
}

/** The job each update's link points at (`/roles/<id>...`), with its title, for the emails. Keyed by href; any other link has no entry. */
export async function rolesForLinks(q: Queryable, hrefs: Array<string | null | undefined>): Promise<Map<string, { roleId: string; title: string }>> {
  const out = new Map<string, { roleId: string; title: string }>();
  const byRole = new Map<string, string[]>();
  for (const href of hrefs) {
    const roleId = href ? roleIdFromHref(href) : null;
    if (href && roleId) byRole.set(roleId, [...(byRole.get(roleId) ?? []), href]);
  }
  if (!byRole.size) return out;
  const found = await q.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, [...byRole.keys()]));
  for (const r of found) for (const href of byRole.get(r.id) ?? []) out.set(href, { roleId: r.id, title: r.title });
  return out;
}

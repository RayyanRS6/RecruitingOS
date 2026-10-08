import { and, eq, inArray, sql } from "drizzle-orm";
import { NOTIFY_GROUPS, NotifyCadence, NotifyGroup, type Actor } from "@ros/contracts";
import { applications, interviews, jobs, memberships, notificationPreferences, notifications, roles, users, type Queryable } from "@ros/db";
import { interviewIdFromHref, roleIdFromHref } from "./notify-email";
import { resolveNotifyCadence, type StoredPreferences } from "./notify-groups";

export * from "./notify-groups";
export * from "./notify-digest";
export * from "./notify-email";

/** The queued job that writes the alert emails for updates someone wants as they happen (plan B3). */
export const NOTIFICATION_EMAIL_JOB_KIND = "notification.email";

let clock: () => Date = () => new Date();
/**
 * The process hands the engine's clock in (apps/api/src/container.ts), so an alert email's job is due on the same
 * clock that runs the queue, as the outbox's send jobs are.
 */
export function setNotifyClock(next: () => Date): void {
  clock = next;
}

/**
 * "Do it and tell me." Every auto_notify action and every recommendation lands here, per person, so the
 * owner sees what the system did without reading the event log. The brief summarizes; this is the record.
 *
 * Email alerts (plan B3): each person's own settings decide whether they also hear about it by email. Those who want this
 * group as it happens (and everyone, for the few kinds that are always emailed) get a job that writes the email after
 * this transaction commits, through the outbox; the rest wait for their summary or stay in the app only.
 * `emailedSeparatelyTo`: the people the caller emails about this itself (the stuck-role ladder, which emails only those
 * who want the group as it happens); their copy counts as emailed, and everyone else's follows their own setting.
 */
export async function notify(
  q: Queryable,
  input: { companyId: string; kind: string; title: string; body: string; action?: { label: string; href: string } | null; roles?: string[]; userIds?: string[]; emailedSeparatelyTo?: readonly string[] },
): Promise<number> {
  const roles = input.roles ?? ["owner", "admin", "hiring_manager"];
  const members = input.userIds?.length
    ? await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, input.companyId), inArray(memberships.userId, input.userIds), eq(memberships.status, "active")))
    : await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, input.companyId), inArray(memberships.role, roles), eq(memberships.status, "active")));
  if (!members.length) return 0;
  const separately = new Set(input.emailedSeparatelyTo ?? []);
  const at = clock().toISOString();
  const rows = await q.insert(notifications).values(members.map((m) => ({ companyId: input.companyId, userId: m.userId, kind: input.kind, title: input.title, body: input.body, action: input.action ?? null, emailedAt: separately.has(m.userId) ? at : null }))).returning({ id: notifications.id, userId: notifications.userId });
  const rest = rows.filter((r) => !separately.has(r.userId));
  if (!rest.length) return members.length;
  const prefs = await storedPreferences(q, input.companyId, rest.map((r) => r.userId));
  const now = rest.filter((r) => resolveNotifyCadence(input.kind, prefs.get(r.userId) ?? {}).emailNow);
  if (now.length) await q.insert(jobs).values({ kind: NOTIFICATION_EMAIL_JOB_KIND, payload: { companyId: input.companyId, notificationIds: now.map((r) => r.id) }, runAt: clock().toISOString(), maxAttempts: 5 });
  return members.length;
}

/** Each person's saved email settings in one company, by group (a group with no row is left out: its default applies). */
export async function storedPreferences(q: Queryable, companyId: string, userIds: string[]): Promise<Map<string, StoredPreferences>> {
  const out = new Map<string, StoredPreferences>();
  if (!userIds.length) return out;
  const rows = await q.select().from(notificationPreferences).where(and(eq(notificationPreferences.companyId, companyId), inArray(notificationPreferences.userId, [...new Set(userIds)])));
  for (const r of rows) {
    const group = NotifyGroup.safeParse(r.groupKey);
    const cadence = NotifyCadence.safeParse(r.cadence);
    if (!group.success || !cadence.success) continue; // a group or cadence this code no longer knows: the default applies
    out.set(r.userId, { ...(out.get(r.userId) ?? {}), [group.data]: cadence.data });
  }
  return out;
}

/**
 * Saves one person's settings for the groups given (the rest keep theirs). Returns what actually changed, before and
 * after, with defaults filled in, for the audit record.
 */
export async function saveNotificationPreferences(
  q: Queryable,
  input: { companyId: string; userId: string; changes: Array<{ group: NotifyGroup; cadence: NotifyCadence }>; actor: Actor; defaults: Record<NotifyGroup, NotifyCadence> },
): Promise<Array<{ group: NotifyGroup; from: NotifyCadence; to: NotifyCadence }>> {
  const before = (await storedPreferences(q, input.companyId, [input.userId])).get(input.userId) ?? {};
  const changed: Array<{ group: NotifyGroup; from: NotifyCadence; to: NotifyCadence }> = [];
  for (const c of input.changes) {
    const from = before[c.group] ?? input.defaults[c.group];
    if (from === c.cadence && before[c.group] !== undefined) continue;
    await q
      .insert(notificationPreferences)
      .values({ companyId: input.companyId, userId: input.userId, groupKey: c.group, cadence: c.cadence, setBy: input.actor })
      .onConflictDoUpdate({ target: [notificationPreferences.companyId, notificationPreferences.userId, notificationPreferences.groupKey], set: { cadence: c.cadence, setBy: input.actor, updatedAt: sql`now()` } });
    if (from !== c.cadence) changed.push({ group: c.group, from, to: c.cadence });
  }
  return changed;
}

/**
 * Postmark says a team member unsubscribed (they used the unsubscribe link of an email): every group they can turn off
 * is set to off, in every company they belong to, so Setup shows what they asked for. The always-sent kinds cannot be
 * turned off; the address is on the do-not-send list anyway until an administrator releases it. Returns how many
 * memberships were changed. Runs on the platform side (the webhook knows no company).
 */
export async function stopAlertEmailsFor(q: Queryable, input: { address: string; actor: Actor }): Promise<number> {
  const address = input.address.trim().toLowerCase();
  if (!address) return 0;
  const people = await q.select({ userId: memberships.userId, companyId: memberships.companyId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(users.email, address), eq(memberships.status, "active")));
  for (const p of people) {
    for (const group of NOTIFY_GROUPS) {
      await q
        .insert(notificationPreferences)
        .values({ companyId: p.companyId, userId: p.userId, groupKey: group, cadence: "off", setBy: input.actor })
        .onConflictDoUpdate({ target: [notificationPreferences.companyId, notificationPreferences.userId, notificationPreferences.groupKey], set: { cadence: "off", setBy: input.actor, updatedAt: sql`now()` } });
    }
  }
  return people.length;
}

/**
 * The role each update's link points at, with its title, for the emails: `/roles/<id>` directly, `/interviews/<id>`
 * through the interview's application. Keyed by href; a link to neither has no entry.
 */
export async function rolesForLinks(q: Queryable, hrefs: Array<string | null | undefined>): Promise<Map<string, { roleId: string; title: string }>> {
  const out = new Map<string, { roleId: string; title: string }>();
  const byRole = new Map<string, string[]>();
  const byInterview = new Map<string, string[]>();
  for (const href of hrefs) {
    if (!href) continue;
    const roleId = roleIdFromHref(href);
    const interviewId = roleId ? null : interviewIdFromHref(href);
    if (roleId) byRole.set(roleId, [...(byRole.get(roleId) ?? []), href]);
    else if (interviewId) byInterview.set(interviewId, [...(byInterview.get(interviewId) ?? []), href]);
  }
  if (byInterview.size) {
    const ivs = await q.select({ id: interviews.id, roleId: applications.roleId }).from(interviews).innerJoin(applications, eq(applications.id, interviews.applicationId)).where(inArray(interviews.id, [...byInterview.keys()]));
    for (const iv of ivs) byRole.set(iv.roleId, [...(byRole.get(iv.roleId) ?? []), ...(byInterview.get(iv.id) ?? [])]);
  }
  if (!byRole.size) return out;
  const found = await q.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, [...byRole.keys()]));
  for (const r of found) for (const href of byRole.get(r.id) ?? []) out.set(href, { roleId: r.id, title: r.title });
  return out;
}

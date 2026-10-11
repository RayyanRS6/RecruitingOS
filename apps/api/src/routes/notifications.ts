import { Hono, type Context } from "hono";
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { MarkAllNotificationsRead, MarkNotificationsRead, MarkNotificationsUnread, NOTIFY_GROUPS, NotificationHistoryQuery, UpdateNotificationPreferences, type NotificationPreferencesView, type NotificationView } from "@ros/contracts";
import { DIGEST_HOUR, NOTIFY_ALWAYS, NOTIFY_GROUP_INFO, WEEKLY_DIGEST_DAY_NAME, audit, cadencesFor, digestTimeZone, notifyGroupOf, saveNotificationPreferences, storedPreferences } from "@ros/core";
import { companies, notifications, withTenant, type Queryable } from "@ros/db";
import { startNotificationDigest } from "@ros/workflows";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, type Tenant, type Vars } from "../middleware/session";

/** "Do it and tell me": what the system did on the owner's behalf, per person. */
export const notificationRoutes = new Hono<Vars>();

notificationRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const unreadOnly = c.req.query("unread") === "1";
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(unreadOnly ? and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId), isNull(notifications.readAt)) : and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(50),
  );
  return c.json(rows);
});

/**
 * Every update this person ever had here, newest first, page by page (plan B3): all, or only the unread ones. Page with
 * `before=<id of the last update shown>`; the cursor is a row, not a time, because one transaction writes several
 * updates with the same time. `asOf` is when the page was read, for "Mark all read".
 */
notificationRoutes.get("/history", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const q = NotificationHistoryQuery.parse({ filter: c.req.query("filter") || undefined, before: c.req.query("before") || undefined, limit: c.req.query("limit") || undefined });
  const asOf = new Date().toISOString();
  const page = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const mine = and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId));
    const where = [mine, ...(q.filter === "unread" ? [isNull(notifications.readAt)] : [])];
    if (q.before) {
      const [cursor] = await tx.select({ id: notifications.id, createdAt: notifications.createdAt }).from(notifications).where(and(mine, eq(notifications.id, q.before))).limit(1);
      if (!cursor) throw new HttpError(400, "invalid_request", "\"before\" must be the id of an update from this list.");
      where.push(or(lt(notifications.createdAt, cursor.createdAt), and(eq(notifications.createdAt, cursor.createdAt), lt(notifications.id, cursor.id))));
    }
    const rows = await tx.select().from(notifications).where(and(...where)).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(q.limit + 1);
    const [unread] = await tx.select({ n: count() }).from(notifications).where(and(mine, isNull(notifications.readAt)));
    return { rows, unread: Number(unread?.n ?? 0) };
  });
  const items: NotificationView[] = page.rows.slice(0, q.limit).map((n) => {
    const group = notifyGroupOf(n.kind);
    return { id: n.id, kind: n.kind, group, groupLabel: NOTIFY_GROUP_INFO[group].label, title: n.title, body: n.body, action: n.action ?? null, readAt: n.readAt, emailedAt: emailedAtOf(n), createdAt: n.createdAt };
  });
  return c.json({ items, nextBefore: page.rows.length > q.limit ? items[items.length - 1].id : null, unreadCount: page.unread, asOf });
});

/**
 * When an update really went out by email, or null. Migration 0028 marked every update written before email alerts
 * existed as handled by copying its own creation time, without emailing it, so the first summary was not a backlog;
 * those read as never emailed.
 */
function emailedAtOf(n: { emailedAt: string | null; createdAt: string }): string | null {
  return n.emailedAt && n.emailedAt !== n.createdAt ? n.emailedAt : null;
}

notificationRoutes.post("/read", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkNotificationsRead.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.userId, t.userId), inArray(notifications.id, body.ids), isNull(notifications.readAt))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n });
});

/** Puts updates back to unread, so they show on Today again. */
notificationRoutes.post("/unread", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkNotificationsUnread.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: null }).where(and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId), inArray(notifications.id, body.ids), isNotNull(notifications.readAt))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n });
});

/** Marks read every unread update that existed when the list was loaded (`upTo`), never one that arrived after. */
notificationRoutes.post("/read-all", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkAllNotificationsRead.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId), isNull(notifications.readAt), lte(notifications.createdAt, new Date(body.upTo).toISOString()))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n });
});

/**
 * Email alerts belong to the people on the company's team. An ITS recruiter inside a customer under a grant gets none
 * of the company's updates, so there is nothing of theirs to set here.
 */
function assertTeamMember(t: Tenant): void {
  if (t.staff) throw new HttpError(403, "not_a_member", "Email alerts are for the people on this company's team.");
}

async function preferencesView(tx: Queryable, t: Tenant, email: string): Promise<NotificationPreferencesView> {
  const stored = (await storedPreferences(tx, t.companyId, [t.userId])).get(t.userId) ?? {};
  const [co] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
  const cadences = cadencesFor(stored);
  const always = new Map([...NOTIFY_ALWAYS.values()].map((a) => [a.label, a]));
  return {
    groups: NOTIFY_GROUPS.map((g) => ({ group: g, label: NOTIFY_GROUP_INFO[g].label, description: NOTIFY_GROUP_INFO[g].description, cadence: cadences[g], defaultCadence: NOTIFY_GROUP_INFO[g].defaultCadence })),
    alwaysSent: [...always.values()],
    digest: { timezone: digestTimeZone(co?.timezone), hour: DIGEST_HOUR, weekday: WEEKLY_DIGEST_DAY_NAME },
    email,
  };
}

function sessionEmail(c: Context<Vars>): string {
  return c.get("session")?.user.email ?? "";
}

/** This person's email alert settings, with the product's defaults filled in. */
notificationRoutes.get("/preferences", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertTeamMember(t);
  return c.json(await withTenant(c.get("container").db, t.companyId, (tx) => preferencesView(tx, t, sessionEmail(c))));
});

/**
 * Changes this person's settings for the groups given (only their own; nobody sets another's). Each real change is
 * audited, before and after. The company's summary run is made sure of here too, so the first daily summary does not
 * wait for anything else to start it.
 */
notificationRoutes.put("/preferences", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertTeamMember(t);
  const body = UpdateNotificationPreferences.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const view = await withTenant(container.db, t.companyId, async (tx) => {
    const defaults = cadencesFor({});
    const changed = await saveNotificationPreferences(tx, { companyId: t.companyId, userId: t.userId, changes: body.preferences, actor, defaults });
    if (changed.length) await audit(tx, { companyId: t.companyId, actor, action: "notification.preferences_changed", target: { type: "user", id: t.userId }, details: { changes: changed } });
    await startNotificationDigest(container.engine, tx, t.companyId, actor);
    return preferencesView(tx, t, sessionEmail(c));
  });
  await container.kick();
  return c.json(view);
});

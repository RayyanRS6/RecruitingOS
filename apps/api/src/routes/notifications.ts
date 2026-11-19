import { Hono, type Context } from "hono";
import { and, count, desc, eq, inArray, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { ALWAYS_EMAILED_LINE, MarkAllNotificationsRead, MarkNotificationsRead, MarkNotificationsUnread, NotificationHistoryQuery, UpdateNotificationPreferences, type NotificationHistoryPage, type NotificationPreferences, type NotificationView, type NotificationsMarked } from "@ros/contracts";
import { audit, emailUpdatesOf, setEmailUpdates } from "@ros/core";
import { notifications, withTenant, type Queryable } from "@ros/db";
import { HttpError } from "../middleware/errors";
import { actorOf, requireTenant, type Tenant, type Vars } from "../middleware/session";

/** Updates: what happened that a person on the team should know, each person's own list, and their one email switch. */
export const notificationRoutes = new Hono<Vars>();

/**
 * The addresses of the app an update's link may open (`appPaths` in @ros/contracts), by path. An update stored earlier
 * keeps its words; its link is sent only when its page still exists.
 */
const APP_PAGE = /^\/(?:$|login$|setup$|setup\/company$|roles$|roles\/new$|roles\/[^/]+$|roles\/[^/]+\/talent$|talent$|updates$|admin$|admin\/privacy$|admin\/system$)/;

function actionOf(action: { label: string; href: string } | null | undefined): NotificationView["action"] {
  if (!action?.href) return null;
  const path = action.href.split(/[?#]/)[0];
  return APP_PAGE.test(path) ? { label: action.label, href: action.href } : null;
}

/**
 * Every update this person ever had here, newest first, page by page: all, or only the unread ones. Page with
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
  const items: NotificationView[] = page.rows.slice(0, q.limit).map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, action: actionOf(n.action), readAt: isoOrNull(n.readAt), emailedAt: emailedAtOf(n), createdAt: new Date(n.createdAt).toISOString() }));
  const answer: NotificationHistoryPage = { items, nextBefore: page.rows.length > q.limit ? items[items.length - 1].id : null, unreadCount: page.unread, asOf };
  return c.json(answer);
});

function isoOrNull(at: string | null): string | null {
  return at ? new Date(at).toISOString() : null;
}

/**
 * When an update really went out by email, or null. An update written before updates were emailed carries its own
 * creation time there, without having been emailed; those read as never emailed.
 */
function emailedAtOf(n: { emailedAt: string | null; createdAt: string }): string | null {
  return n.emailedAt && n.emailedAt !== n.createdAt ? new Date(n.emailedAt).toISOString() : null;
}

notificationRoutes.post("/read", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkNotificationsRead.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.userId, t.userId), inArray(notifications.id, body.ids), isNull(notifications.readAt))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n } satisfies NotificationsMarked);
});

/** Puts updates back to unread. */
notificationRoutes.post("/unread", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkNotificationsUnread.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: null }).where(and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId), inArray(notifications.id, body.ids), isNotNull(notifications.readAt))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n } satisfies NotificationsMarked);
});

/** Marks read every unread update that existed when the list was loaded (`upTo`), never one that arrived after. */
notificationRoutes.post("/read-all", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkAllNotificationsRead.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.companyId, t.companyId), eq(notifications.userId, t.userId), isNull(notifications.readAt), lte(notifications.createdAt, new Date(body.upTo).toISOString()))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n } satisfies NotificationsMarked);
});

async function preferencesOf(tx: Queryable, t: Tenant, email: string): Promise<NotificationPreferences> {
  const emailUpdates = (await emailUpdatesOf(tx, t.companyId, [t.userId])).get(t.userId) ?? true;
  return { emailUpdates, email, alwaysEmailedLine: ALWAYS_EMAILED_LINE };
}

function sessionEmail(c: Context<Vars>): string {
  return c.get("session")?.user.email ?? "";
}

/** This person's "Email me updates" switch, and the address the emails go to. */
notificationRoutes.get("/preferences", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  return c.json(await withTenant(c.get("container").db, t.companyId, (tx) => preferencesOf(tx, t, sessionEmail(c))));
});

/** Turns this person's own switch on or off (nobody sets another's). A real change is audited, before and after. */
notificationRoutes.put("/preferences", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = UpdateNotificationPreferences.parse(await c.req.json());
  const actor = actorOf(c);
  const answer = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const changed = await setEmailUpdates(tx, { companyId: t.companyId, userId: t.userId, emailUpdates: body.emailUpdates, actor });
    if (changed.from !== changed.to) await audit(tx, { companyId: t.companyId, actor, action: "notification.preferences_changed", target: { type: "user", id: t.userId }, details: { emailUpdates: changed } });
    return preferencesOf(tx, t, sessionEmail(c));
  });
  return c.json(answer);
});

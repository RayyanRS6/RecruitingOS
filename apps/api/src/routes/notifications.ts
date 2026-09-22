import { Hono } from "hono";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { MarkNotificationsRead } from "@ros/contracts";
import { notifications, withTenant } from "@ros/db";
import { requireTenant, type Vars } from "../middleware/session";

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

notificationRoutes.post("/read", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = MarkNotificationsRead.parse(await c.req.json());
  const n = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: new Date().toISOString() }).where(and(eq(notifications.userId, t.userId), inArray(notifications.id, body.ids), isNull(notifications.readAt))).returning({ id: notifications.id });
    return rows.length;
  });
  return c.json({ ok: true, marked: n });
});

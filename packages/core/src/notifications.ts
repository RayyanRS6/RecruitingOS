import { and, eq, inArray } from "drizzle-orm";
import { memberships, notifications, type Queryable } from "@ros/db";

/**
 * "Do it and tell me." Every auto_notify action and every recommendation lands here, per person, so the
 * owner sees what the system did without reading the event log. The brief summarizes; this is the record.
 */
export async function notify(
  q: Queryable,
  input: { companyId: string; kind: string; title: string; body: string; action?: { label: string; href: string } | null; roles?: string[]; userIds?: string[] },
): Promise<number> {
  const roles = input.roles ?? ["owner", "admin", "hiring_manager"];
  const members = input.userIds?.length
    ? await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, input.companyId), inArray(memberships.userId, input.userIds), eq(memberships.status, "active")))
    : await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, input.companyId), inArray(memberships.role, roles), eq(memberships.status, "active")));
  if (!members.length) return 0;
  await q.insert(notifications).values(members.map((m) => ({ companyId: input.companyId, userId: m.userId, kind: input.kind, title: input.title, body: input.body, action: input.action ?? null })));
  return members.length;
}

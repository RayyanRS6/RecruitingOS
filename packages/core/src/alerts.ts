import { and, desc, eq, inArray } from "drizzle-orm";
import type { Actor, Subject } from "@ros/contracts";
import { adminAlerts, type Queryable } from "@ros/db";
import { audit } from "./audit";

/** Something a person at ITS must see (a failed credential deletion, for example). Shown in the admin console until acknowledged and resolved. */
export async function raiseAlert(q: Queryable, input: { kind: string; severity?: "info" | "high" | "critical"; title: string; body: string; companyId?: string | null; target?: Subject | null; details?: Record<string, unknown> }): Promise<{ id: string }> {
  const [row] = await q.insert(adminAlerts).values({ kind: input.kind, severity: input.severity ?? "high", title: input.title, body: input.body, companyId: input.companyId ?? null, target: input.target ?? null, details: input.details ?? {} }).returning({ id: adminAlerts.id });
  return row;
}

export async function openAlerts(q: Queryable, limit = 200) {
  return q.select().from(adminAlerts).where(inArray(adminAlerts.status, ["open", "acknowledged"])).orderBy(desc(adminAlerts.createdAt)).limit(limit);
}

export async function acknowledgeAlert(q: Queryable, input: { id: string; actor: Actor; now?: Date }): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const rows = await q.update(adminAlerts).set({ status: "acknowledged", acknowledgedAt: now, acknowledgedBy: input.actor.id }).where(and(eq(adminAlerts.id, input.id), eq(adminAlerts.status, "open"))).returning({ id: adminAlerts.id, companyId: adminAlerts.companyId });
  if (rows[0]) await audit(q, { companyId: rows[0].companyId, actor: input.actor, action: "alert.acknowledged", target: { type: "integration", id: input.id }, reason: "acknowledged in the admin console" });
  return rows.length > 0;
}

/** Resolves every open alert about a target (for example once a failed deletion finally succeeds). */
export async function resolveAlertsFor(q: Queryable, kind: string, targetId: string, now: Date = new Date()): Promise<number> {
  const open = await q.select({ id: adminAlerts.id, target: adminAlerts.target }).from(adminAlerts).where(and(eq(adminAlerts.kind, kind), inArray(adminAlerts.status, ["open", "acknowledged"])));
  const ids = open.filter((a) => a.target?.id === targetId).map((a) => a.id);
  if (!ids.length) return 0;
  await q.update(adminAlerts).set({ status: "resolved", resolvedAt: now.toISOString() }).where(inArray(adminAlerts.id, ids));
  return ids.length;
}

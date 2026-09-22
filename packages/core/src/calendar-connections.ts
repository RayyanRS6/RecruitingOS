import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { integrations, interviewerAvailability, memberships, users, type Queryable } from "@ros/db";
import { emit } from "./events";
import { audit } from "./audit";
import { connectIntegration, disconnectIntegration, publicConnection, type ConnectionRow } from "./connections";
import type { SecretStoreLike } from "./secrets";

/**
 * Per-person calendar connections (D2, D4; correction 10 for credentials) and declared availability (docs/05 §3).
 * A connection is an `integrations` row of kind `calendar` with the interviewer's user id; the credential lives in the
 * managed store; the row keeps only the reference, the account email, the calendar id and the zone.
 */
export type CalendarConfig = { calendarId: string; timeZone: string | null; scopes: string[]; needsAttentionSince?: string | null; consecutiveFailures?: number };

export async function calendarConnectionFor(q: Queryable, companyId: string, userId: string): Promise<ConnectionRow | null> {
  const rows = await q.select().from(integrations).where(and(eq(integrations.companyId, companyId), eq(integrations.userId, userId), eq(integrations.kind, "calendar")));
  return rows.find((r) => r.status === "live" || r.status === "manual_action_required") ?? rows[0] ?? null;
}

export async function connectCalendar(
  q: Queryable,
  store: SecretStoreLike,
  input: { companyId: string; userId: string; provider: string; refreshToken: string; account: { email: string | null; calendarId: string; timeZone: string | null }; scopes: string[]; actor: Actor; now?: Date },
): Promise<ConnectionRow> {
  const row = await connectIntegration(q, store, {
    companyId: input.companyId, userId: input.userId, provider: input.provider, kind: "calendar", secretValue: input.refreshToken, secretName: `${input.provider}-calendar-refresh`,
    externalAccountId: input.account.email, config: { calendarId: input.account.calendarId, timeZone: input.account.timeZone, scopes: input.scopes, consecutiveFailures: 0 } satisfies CalendarConfig,
    status: "live", actor: input.actor, now: input.now,
  });
  return row;
}

export async function disconnectCalendar(q: Queryable, input: { companyId: string; userId: string; reason: string; actor: Actor; now?: Date }): Promise<{ row: ConnectionRow; queued: boolean } | null> {
  const row = await calendarConnectionFor(q, input.companyId, input.userId);
  if (!row || row.disconnectedAt) return null;
  return disconnectIntegration(q, { integrationId: row.id, companyId: input.companyId, reason: input.reason, actor: input.actor, now: input.now });
}

/** After a failed probe or a revoked credential: the connection needs a person; scheduling falls back to declared windows. */
export async function markCalendarNeedsAttention(q: Queryable, row: ConnectionRow, error: string, actor: Actor, now: Date = new Date()): Promise<void> {
  const cfg = (row.config ?? {}) as CalendarConfig;
  const failures = (cfg.consecutiveFailures ?? 0) + 1;
  await q.update(integrations).set({ status: "manual_action_required", lastError: error, lastHealthAt: now.toISOString(), config: { ...cfg, consecutiveFailures: failures, needsAttentionSince: cfg.needsAttentionSince ?? now.toISOString() } }).where(eq(integrations.id, row.id));
  await emit(q, { type: "calendar.needs_attention", companyId: row.companyId!, actor, subject: { type: "integration", id: row.id }, payload: { provider: row.provider, userId: row.userId, error, failures } });
}

export async function markCalendarHealthy(q: Queryable, row: ConnectionRow, timeZone: string | null, now: Date = new Date()): Promise<void> {
  const cfg = (row.config ?? {}) as CalendarConfig;
  await q.update(integrations).set({ status: "live", lastError: null, lastHealthAt: now.toISOString(), config: { ...cfg, timeZone: timeZone ?? cfg.timeZone, consecutiveFailures: 0, needsAttentionSince: null } }).where(eq(integrations.id, row.id));
}

export type AvailabilityRow = typeof interviewerAvailability.$inferSelect;

export async function availabilityFor(q: Queryable, companyId: string, userId: string): Promise<AvailabilityRow | null> {
  const [row] = await q.select().from(interviewerAvailability).where(and(eq(interviewerAvailability.companyId, companyId), eq(interviewerAvailability.userId, userId))).limit(1);
  return row ?? null;
}

export async function upsertAvailability(
  q: Queryable,
  input: { companyId: string; userId: string; timezone: string; windows: Array<{ day: number; start: string; end: string }>; bufferMinutes: number; maxPerDay: number; actor: Actor },
): Promise<AvailabilityRow> {
  const existing = await availabilityFor(q, input.companyId, input.userId);
  const values = { timezone: input.timezone, windows: input.windows, bufferMinutes: input.bufferMinutes, maxPerDay: input.maxPerDay };
  const [row] = existing
    ? await q.update(interviewerAvailability).set(values).where(eq(interviewerAvailability.id, existing.id)).returning()
    : await q.insert(interviewerAvailability).values({ companyId: input.companyId, userId: input.userId, ...values }).returning();
  await emit(q, { type: "availability.updated", companyId: input.companyId, actor: input.actor, subject: { type: "user", id: input.userId }, payload: { timezone: input.timezone, windows: input.windows.length, bufferMinutes: input.bufferMinutes, maxPerDay: input.maxPerDay } });
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "membership.changed", target: { type: "user", id: input.userId }, reason: "availability updated", details: { timezone: input.timezone, windows: input.windows.length } });
  return row;
}

/** What scheduling can rely on for one interviewer. */
export async function availabilitySourceFor(q: Queryable, companyId: string, userId: string): Promise<{ source: "calendar" | "declared" | "none"; connection: ConnectionRow | null; availability: AvailabilityRow | null }> {
  const connection = await calendarConnectionFor(q, companyId, userId);
  const availability = await availabilityFor(q, companyId, userId);
  if (connection && connection.status === "live" && connection.secretRef) return { source: "calendar", connection, availability };
  if (availability && availability.windows.length) return { source: "declared", connection, availability };
  return { source: "none", connection, availability };
}

/** The member list with each person's scheduling readiness (no secrets, no references). */
export async function membersWithCalendarStatus(q: Queryable, companyId: string) {
  const rows = await q.select({ userId: memberships.userId, role: memberships.role, status: memberships.status, email: users.email, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.companyId, companyId));
  const ids = rows.map((r) => r.userId);
  const conns = ids.length ? await q.select().from(integrations).where(and(eq(integrations.companyId, companyId), eq(integrations.kind, "calendar"), inArray(integrations.userId, ids))) : [];
  const avail = ids.length ? await q.select().from(interviewerAvailability).where(and(eq(interviewerAvailability.companyId, companyId), inArray(interviewerAvailability.userId, ids))) : [];
  return rows.map((r) => {
    const conn = conns.filter((c) => c.userId === r.userId).find((c) => c.status === "live" || c.status === "manual_action_required") ?? conns.find((c) => c.userId === r.userId) ?? null;
    const a = avail.find((x) => x.userId === r.userId) ?? null;
    return { ...r, calendar: conn ? { provider: conn.provider, status: conn.status, email: conn.externalAccountId, connectedAt: conn.connectedAt, lastError: conn.lastError, credentialsDeleted: publicConnection(conn).credentialsDeleted } : null, availability: a ? { timezone: a.timezone, windows: a.windows.length, bufferMinutes: a.bufferMinutes, maxPerDay: a.maxPerDay } : null, schedulable: !!(conn && conn.status === "live") || !!(a && a.windows.length) };
  });
}

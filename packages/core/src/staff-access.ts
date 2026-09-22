import { and, desc, eq, gt, isNull, lte } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { staffAccessGrants, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { emit } from "./events";

/**
 * Explicit, role-scoped, time-limited access for ITS staff (founder decision F10). No grant, no access.
 * A grant is created when a recruiter accepts an escalation (scope: that customer, and the role or candidate it
 * concerns) or when a platform administrator uses break-glass with MFA and a recorded reason. Every grant, every
 * request made under it, and its end are recorded where the customer can see them.
 */

export type StaffScope = { escalationId: string | null; roleId: string | null; applicationId: string | null };
export type StaffGrant = typeof staffAccessGrants.$inferSelect;

export const ESCALATION_ACCESS_DAYS = 14;
export const ACCESS_AFTER_RESOLUTION_HOURS = 24;
export const BREAK_GLASS_MAX_MINUTES = 60;

export async function grantStaffAccess(
  q: Queryable,
  input: { userId: string; userName: string; companyId: string; kind: "escalation" | "break_glass"; scope: Partial<StaffScope>; purpose: string; grantedBy: Actor; expiresAt: Date; mfaVerified?: boolean; now?: Date },
): Promise<StaffGrant> {
  const now = input.now ?? new Date();
  const [grant] = await q
    .insert(staffAccessGrants)
    .values({
      userId: input.userId,
      companyId: input.companyId,
      kind: input.kind,
      escalationId: input.scope.escalationId ?? null,
      roleId: input.scope.roleId ?? null,
      applicationId: input.scope.applicationId ?? null,
      purpose: input.purpose,
      grantedBy: input.grantedBy,
      mfaVerified: input.mfaVerified ?? false,
      startsAt: now.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
    })
    .returning();
  const actor: Actor = { kind: "recruiter", id: input.userId, name: input.userName };
  await emit(q, {
    type: "recruiter.access_granted",
    companyId: input.companyId,
    actor,
    subject: grant.escalationId ? { type: "escalation", id: grant.escalationId } : { type: "company", id: input.companyId },
    payload: { grantId: grant.id, kind: grant.kind, purpose: grant.purpose, roleId: grant.roleId, applicationId: grant.applicationId, expiresAt: grant.expiresAt, recruiter: input.userName },
  });
  await audit(q, { companyId: input.companyId, actor, action: "staff.access_granted", target: { type: "escalation", id: grant.escalationId ?? grant.id }, reason: grant.purpose, details: { grantId: grant.id, kind: grant.kind, roleId: grant.roleId, applicationId: grant.applicationId, expiresAt: grant.expiresAt, mfaVerified: grant.mfaVerified } });
  return grant;
}

/** The newest grant that is in force for this user and company right now; lapsed grants are closed on the way. */
export async function activeStaffGrant(q: Queryable, userId: string, companyId: string, now: Date = new Date()): Promise<StaffGrant | null> {
  const nowIso = now.toISOString();
  const lapsed = await q
    .select()
    .from(staffAccessGrants)
    .where(and(eq(staffAccessGrants.userId, userId), eq(staffAccessGrants.companyId, companyId), isNull(staffAccessGrants.endedAt), lte(staffAccessGrants.expiresAt, nowIso)));
  for (const g of lapsed) await endStaffGrant(q, g, "expired", now);
  const rows = await q
    .select()
    .from(staffAccessGrants)
    .where(and(eq(staffAccessGrants.userId, userId), eq(staffAccessGrants.companyId, companyId), isNull(staffAccessGrants.revokedAt), isNull(staffAccessGrants.endedAt), lte(staffAccessGrants.startsAt, nowIso), gt(staffAccessGrants.expiresAt, nowIso)))
    .orderBy(desc(staffAccessGrants.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function endStaffGrant(q: Queryable, grant: StaffGrant, reason: "expired" | "released" | "revoked" | "resolved", now: Date = new Date()): Promise<void> {
  const patch = reason === "revoked" || reason === "released" ? { revokedAt: now.toISOString(), revokeReason: reason, endedAt: now.toISOString() } : { endedAt: now.toISOString() };
  await q.update(staffAccessGrants).set(patch).where(eq(staffAccessGrants.id, grant.id));
  const actor: Actor = { kind: "recruiter", id: grant.userId };
  await emit(q, { type: "recruiter.access_ended", companyId: grant.companyId, actor, subject: grant.escalationId ? { type: "escalation", id: grant.escalationId } : { type: "company", id: grant.companyId }, payload: { grantId: grant.id, reason } });
  await audit(q, { companyId: grant.companyId, actor, action: "staff.access_ended", target: { type: "escalation", id: grant.escalationId ?? grant.id }, reason, details: { grantId: grant.id } });
}

/** Shortens a grant so it ends a fixed time after the escalation was resolved. */
export async function limitGrantAfterResolution(q: Queryable, escalationId: string, resolvedAt: Date): Promise<string | null> {
  const until = new Date(resolvedAt.getTime() + ACCESS_AFTER_RESOLUTION_HOURS * 3600_000).toISOString();
  const rows = await q.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, escalationId), isNull(staffAccessGrants.endedAt)));
  for (const g of rows) if (g.expiresAt > until) await q.update(staffAccessGrants).set({ expiresAt: until }).where(eq(staffAccessGrants.id, g.id));
  return rows.length ? until : null;
}

/** Whether a grant's scope covers a target. A grant with no role and no application covers the whole company. */
export function scopeAllows(grant: Pick<StaffGrant, "roleId" | "applicationId">, target: { roleId?: string | null; applicationId?: string | null }): boolean {
  if (grant.applicationId) return !!target.applicationId && target.applicationId === grant.applicationId || (!target.applicationId && !!target.roleId && target.roleId === grant.roleId);
  if (grant.roleId) return !target.roleId || target.roleId === grant.roleId;
  return true;
}

/** Every request a staff member makes inside a tenant is recorded with what was touched and when the access ends. */
export async function recordStaffAccess(q: Queryable, input: { grant: StaffGrant; userName?: string; method: string; path: string; ip?: string }): Promise<void> {
  await audit(q, {
    companyId: input.grant.companyId,
    actor: { kind: "recruiter", id: input.grant.userId, name: input.userName },
    action: "staff.tenant_accessed",
    target: input.grant.escalationId ? { type: "escalation", id: input.grant.escalationId } : null,
    reason: input.grant.purpose,
    ip: input.ip,
    details: { grantId: input.grant.id, method: input.method, path: input.path, expiresAt: input.grant.expiresAt, action: input.method === "GET" ? "read" : "write" },
  });
}

/**
 * The customer ends a recruiter's access before it expires (founder instruction of 21 Sep, item 1). Immediate: the next
 * request the recruiter makes under this company is refused (every request re-checks the grant). Prior audit records
 * are untouched; the revocation is a new record with the customer as the actor.
 */
export async function revokeStaffGrant(
  q: Queryable,
  input: { grantId: string; companyId: string; actor: Actor; reason: string; now?: Date },
): Promise<{ grant: StaffGrant; recruiterUserId: string; escalationId: string | null } | null> {
  const now = input.now ?? new Date();
  const [grant] = await q.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.id, input.grantId), eq(staffAccessGrants.companyId, input.companyId), isNull(staffAccessGrants.endedAt))).limit(1);
  if (!grant) return null;
  const updated = await q.update(staffAccessGrants).set({ revokedAt: now.toISOString(), revokeReason: `revoked by the customer: ${input.reason}`, endedAt: now.toISOString() }).where(and(eq(staffAccessGrants.id, grant.id), isNull(staffAccessGrants.endedAt))).returning({ id: staffAccessGrants.id });
  if (!updated.length) return null; // ended concurrently: nothing more to record
  const scope = { escalationId: grant.escalationId, roleId: grant.roleId, applicationId: grant.applicationId };
  const subject = grant.escalationId ? { type: "escalation" as const, id: grant.escalationId } : { type: "company" as const, id: grant.companyId };
  await audit(q, { companyId: grant.companyId, actor: input.actor, action: "staff.access_revoked", target: { type: "user", id: grant.userId }, reason: input.reason, details: { grantId: grant.id, recruiterUserId: grant.userId, kind: grant.kind, scope, revokedAt: now.toISOString() } });
  await emit(q, { type: "recruiter.access_revoked", companyId: grant.companyId, actor: input.actor, subject, payload: { grantId: grant.id, recruiterUserId: grant.userId, reason: input.reason, scope } });
  await emit(q, { type: "recruiter.access_ended", companyId: grant.companyId, actor: input.actor, subject, payload: { grantId: grant.id, reason: "revoked", recruiterUserId: grant.userId } });
  return { grant, recruiterUserId: grant.userId, escalationId: grant.escalationId };
}

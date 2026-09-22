import { and, desc, eq, isNull, sql } from "drizzle-orm";

/** Serializes ledger changes inside a transaction (no-op outside one or on a driver without advisory locks). */
async function lockLedger(q: Queryable): Promise<void> {
  try { await (q as unknown as { execute: (s: unknown) => Promise<unknown> }).execute(sql`select pg_advisory_xact_lock(hashtext('platform_role_grants'))`); } catch { /* not in a transaction, or not supported: the checks below still apply */ }
}
import type { Actor } from "@ros/contracts";
import { platformRoleGrants, users, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { raiseAlert } from "./alerts";

/**
 * Platform authority lives in the `platform_role_grants` ledger (founder instruction of 21 September 2026, item 2).
 * No email address, domain or configuration value grants a platform role on its own. The one-time bootstrap list is
 * honoured only while no administrator exists; after that it is ignored and audited. Every grant and revocation names
 * the administrator who made it, the reason, and raises an alert that a different administrator must acknowledge.
 */
export type PlatformRole = "its_recruiter" | "platform_admin";
export const PLATFORM_ROLES: readonly PlatformRole[] = ["its_recruiter", "platform_admin"];
export type PlatformRoleGrant = typeof platformRoleGrants.$inferSelect;

/** Administrators according to the ledger, which is the only authority (migration 0014 backfilled every earlier role). */
export async function countActiveAdmins(q: Queryable): Promise<number> {
  const [ledger] = await q.select({ n: sql<number>`count(*)` }).from(platformRoleGrants).where(and(eq(platformRoleGrants.role, "platform_admin"), isNull(platformRoleGrants.revokedAt)));
  return Number(ledger?.n ?? 0);
}

export async function activeGrantFor(q: Queryable, userId: string): Promise<PlatformRoleGrant | null> {
  const [row] = await q.select().from(platformRoleGrants).where(and(eq(platformRoleGrants.userId, userId), isNull(platformRoleGrants.revokedAt))).orderBy(desc(platformRoleGrants.grantedAt)).limit(1);
  return row ?? null;
}

export async function listPlatformRoleGrants(q: Queryable, limit = 200) {
  return q
    .select({ id: platformRoleGrants.id, userId: platformRoleGrants.userId, email: users.email, name: users.name, authProvider: users.authProvider, role: platformRoleGrants.role, source: platformRoleGrants.source, grantedBy: platformRoleGrants.grantedBy, grantReason: platformRoleGrants.grantReason, grantedAt: platformRoleGrants.grantedAt, revokedAt: platformRoleGrants.revokedAt, revokedBy: platformRoleGrants.revokedBy, revokeReason: platformRoleGrants.revokeReason })
    .from(platformRoleGrants)
    .innerJoin(users, eq(users.id, platformRoleGrants.userId))
    .orderBy(desc(platformRoleGrants.grantedAt))
    .limit(limit);
}

export class PlatformRoleError extends Error {
  constructor(public readonly code: "self_grant" | "unknown_user" | "already_held" | "last_admin" | "not_found" | "not_staff_provider", message: string) {
    super(message);
  }
}

/**
 * Grants a platform role. Refuses self-grant (nobody raises their own authority), refuses a second active grant for the
 * same person, and records the change where every administrator sees it.
 */
export async function grantPlatformRole(
  q: Queryable,
  input: { userId: string; role: PlatformRole; actor: Actor; reason: string; source: "bootstrap" | "console" | "test_seed"; now?: Date; requireStaffProvider?: string },
): Promise<PlatformRoleGrant> {
  const now = input.now ?? new Date();
  await lockLedger(q);
  if (input.actor.kind === "user" && input.actor.id === input.userId) throw new PlatformRoleError("self_grant", "You cannot grant a platform role to yourself. Another administrator must do it.");
  const [user] = await q.select().from(users).where(eq(users.id, input.userId)).limit(1);
  if (!user) throw new PlatformRoleError("unknown_user", "No account with that id.");
  if (input.requireStaffProvider && user.authProvider !== input.requireStaffProvider) throw new PlatformRoleError("not_staff_provider", "The person must first sign in with Microsoft 365 and a second factor so the account is a verified, named ITS account.");
  const existing = await activeGrantFor(q, input.userId);
  if (existing && existing.role === input.role) throw new PlatformRoleError("already_held", "That person already holds this role.");
  if (existing) await q.update(platformRoleGrants).set({ revokedAt: now.toISOString(), revokedBy: input.actor, revokeReason: `replaced by ${input.role}: ${input.reason}` }).where(eq(platformRoleGrants.id, existing.id));
  const [grant] = await q.insert(platformRoleGrants).values({ userId: input.userId, role: input.role, source: input.source, grantedBy: input.actor, grantReason: input.reason, grantedAt: now.toISOString() }).returning();
  await q.update(users).set({ platformRole: input.role }).where(eq(users.id, input.userId));
  await audit(q, { companyId: null, actor: input.actor, action: "platform_role.changed", target: { type: "user", id: input.userId }, reason: input.reason, details: { grantId: grant.id, role: input.role, source: input.source, previousRole: existing?.role ?? user.platformRole, granteeEmail: user.email } });
  if (input.source !== "test_seed") {
    await raiseAlert(q, { kind: "platform_role.changed", severity: "high", title: `${user.name ?? user.email} is now ${input.role.replace("_", " ")}`, body: `Granted by ${input.actor.name ?? input.actor.id} (${input.source}). Reason: ${input.reason}. Another administrator must acknowledge this change.`, target: { type: "user", id: input.userId }, details: { grantId: grant.id, role: input.role, actorId: input.actor.id, source: input.source } });
  }
  return grant;
}

/** Revokes a platform role now. The last administrator cannot be removed (someone must be able to act). */
export async function revokePlatformRole(q: Queryable, input: { grantId: string; actor: Actor; reason: string; now?: Date }): Promise<PlatformRoleGrant> {
  const now = input.now ?? new Date();
  await lockLedger(q);
  const [grant] = await q.select().from(platformRoleGrants).where(and(eq(platformRoleGrants.id, input.grantId), isNull(platformRoleGrants.revokedAt))).limit(1);
  if (!grant) throw new PlatformRoleError("not_found", "No active grant with that id.");
  if (grant.role === "platform_admin" && (await countActiveAdmins(q)) <= 1) throw new PlatformRoleError("last_admin", "This is the last platform administrator. Grant another administrator first.");
  await q.update(platformRoleGrants).set({ revokedAt: now.toISOString(), revokedBy: input.actor, revokeReason: input.reason }).where(eq(platformRoleGrants.id, grant.id));
  await q.update(users).set({ platformRole: "none" }).where(eq(users.id, grant.userId));
  const [user] = await q.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, grant.userId)).limit(1);
  await audit(q, { companyId: null, actor: input.actor, action: "platform_role.revoked", target: { type: "user", id: grant.userId }, reason: input.reason, details: { grantId: grant.id, role: grant.role, granteeEmail: user?.email } });
  await raiseAlert(q, { kind: "platform_role.revoked", severity: "high", title: `${user?.name ?? user?.email ?? grant.userId} is no longer ${grant.role.replace("_", " ")}`, body: `Revoked by ${input.actor.name ?? input.actor.id}. Reason: ${input.reason}. Another administrator must acknowledge this change.`, target: { type: "user", id: grant.userId }, details: { grantId: grant.id, role: grant.role, actorId: input.actor.id } });
  return { ...grant, revokedAt: now.toISOString(), revokedBy: input.actor, revokeReason: input.reason };
}

/**
 * The controlled one-time bootstrap: a listed email becomes the first administrator on its first Microsoft sign-in with a
 * second factor, only while no administrator exists at all. Returns what happened so the caller can audit an ignored list.
 */
export async function applyBootstrapAdmin(q: Queryable, input: { userId: string; email: string; listed: boolean; now?: Date }): Promise<"granted" | "ignored" | "not_listed" | "already_admin"> {
  if (!input.listed) return "not_listed";
  await lockLedger(q);
  const [user] = await q.select({ platformRole: users.platformRole }).from(users).where(eq(users.id, input.userId)).limit(1);
  if (user?.platformRole === "platform_admin") return "already_admin";
  if ((await countActiveAdmins(q)) > 0) {
    await audit(q, { companyId: null, actor: { kind: "system", id: "bootstrap" }, action: "bootstrap.ignored", target: { type: "user", id: input.userId }, reason: "BOOTSTRAP_ADMIN_EMAILS is still set but administrators already exist; the list grants nothing. Remove the variable.", details: { email: input.email } });
    return "ignored";
  }
  await grantPlatformRole(q, { userId: input.userId, role: "platform_admin", actor: { kind: "system", id: "bootstrap", name: "one-time bootstrap" }, reason: "first administrator (one-time bootstrap from BOOTSTRAP_ADMIN_EMAILS)", source: "bootstrap", now: input.now });
  return "granted";
}

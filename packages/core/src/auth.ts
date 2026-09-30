import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { magicLinks, memberships, randomToken, sessions, users, type Queryable } from "@ros/db";
import { acceptPendingInvitations } from "./invitations";
import { activeGrantFor } from "./platform-roles";

/** A sign-in link is short-lived. Team invitations are no longer links that sign a person in: see ./invitations. */
export const MAGIC_LINK_TTL_MS = 15 * 60_000;
const SESSION_IDLE_MS = 30 * 24 * 3600_000;
/** Staff sessions are shorter (I8): eight hours, sliding, and never extended to the customer window. */
export const STAFF_SESSION_MS = 8 * 3600_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Creates a single-use link. The caller sends it through the email adapter. */
export async function createMagicLink(q: Queryable, input: { email: string; ip?: string; ttlMs?: number }): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? MAGIC_LINK_TTL_MS)).toISOString();
  await q.insert(magicLinks).values({ email: normalizeEmail(input.email), tokenHash: hashToken(token), expiresAt, ip: input.ip ?? null });
  return { token, expiresAt };
}

export class AuthError extends Error {
  status = 401;
  code = "unauthorized";
}

/**
 * Consumes a magic link: creates the user if needed, accepts any open team invitation for the address (and the one the
 * browser carried, when its hash is given), and opens a session. The link is claimed in one conditional UPDATE, so two
 * requests carrying the same token (a double click, a mail scanner and the person) can never both open a session:
 * exactly one wins the row.
 */
export async function consumeMagicLink(
  q: Queryable,
  input: { token: string; ip?: string; userAgent?: string; invitationTokenHash?: string | null; openedAt?: Date },
): Promise<{ sessionToken: string; userId: string; activeCompanyId: string | null; invitationsAccepted: number }> {
  const now = new Date().toISOString();
  // When the session opened, on the caller's clock (the engine's): the freshness rule for policy and notice changes
  // (audit finding A12) reads `createdAt` against that same clock, so the two are never measured on different ones.
  const openedAt = (input.openedAt ?? new Date()).toISOString();
  const [link] = await q
    .update(magicLinks)
    .set({ usedAt: now })
    .where(and(eq(magicLinks.tokenHash, hashToken(input.token)), isNull(magicLinks.usedAt), gt(magicLinks.expiresAt, now)))
    .returning();
  if (!link) throw new AuthError("This sign-in link is invalid or has expired. Request a new one.");

  let [user] = await q.select().from(users).where(eq(users.email, link.email)).limit(1);
  if (!user) [user] = await q.insert(users).values({ email: link.email }).returning();
  // ITS staff never sign in with an email link (D19, correction 4), whatever domain the address is on: a platform role
  // holder needs Microsoft and a second factor. The invite path arrives here too.
  if (user.platformRole !== "none" || (await activeGrantFor(q, user.id))) throw new StaffProviderRequired();

  // Team invitations (docs/spec/21, area A): the one this browser carried and any other open one for the address.
  // Invitation expiry is judged on the caller's clock too, the same one the session's `openedAt` comes from.
  const invited = await acceptPendingInvitations(q, { user: { id: user.id, email: user.email, name: user.name }, tokenHash: input.invitationTokenHash ?? null, staff: false, now: input.openedAt, ip: input.ip });
  const ms = await q.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.status, "active"))).limit(1);
  const activeCompanyId = invited.activeCompanyId ?? ms[0]?.companyId ?? null;

  const sessionToken = randomToken(32);
  await q.insert(sessions).values({
    userId: user.id,
    tokenHash: hashToken(sessionToken),
    activeCompanyId,
    expiresAt: new Date(Date.now() + SESSION_IDLE_MS).toISOString(),
    lastSeenAt: now,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    identityProvider: "magic_link",
    aal: "aal1",
    createdAt: openedAt,
  });
  return { sessionToken, userId: user.id, activeCompanyId, invitationsAccepted: invited.accepted.length };
}

export type SessionContext = {
  sessionId: string;
  user: { id: string; email: string; name: string | null; platformRole: string };
  memberships: Array<{ companyId: string; role: string; status: string }>;
  activeCompanyId: string | null;
  /** When a second factor was last verified in this session (from the identity service's amr claim); unlocks break-glass (D25). */
  mfaVerifiedAt: string | null;
  /** How the session was opened: magic_link, azure, google, email. */
  identityProvider: string;
  aal: "aal1" | "aal2";
  /** When the session was opened and when its holder last confirmed with the sign-in provider inside it (audit finding A12). */
  createdAt: string;
  reauthenticatedAt: string | null;
};

/** A sensitive change is accepted from a session this young, or one confirmed again this recently (audit finding A12). */
export const FRESH_SESSION_MS = 30 * 60_000;
export const REAUTH_WINDOW_MS = 10 * 60_000;

/** True when the session may make a policy or notice change without confirming again. */
export function isRecentlyAuthenticated(s: Pick<SessionContext, "createdAt" | "reauthenticatedAt">, now: Date): boolean {
  const t = now.getTime();
  const opened = Date.parse(s.createdAt);
  if (Number.isFinite(opened) && t - opened < FRESH_SESSION_MS && t - opened >= -60_000) return true;
  const again = s.reauthenticatedAt ? Date.parse(s.reauthenticatedAt) : Number.NaN;
  return Number.isFinite(again) && t - again < REAUTH_WINDOW_MS && t - again >= -60_000;
}

export async function loadSession(q: Queryable, sessionToken: string): Promise<SessionContext | null> {
  const now = new Date().toISOString();
  const [s] = await q
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(sessionToken)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!s) return null;
  const [user] = await q.select().from(users).where(eq(users.id, s.userId)).limit(1);
  if (!user) return null;
  // Platform authority comes from the ledger on every request (21 Sep, item 2); users.platform_role is only a cache.
  const grant = await activeGrantFor(q, user.id);
  const platformRole = grant?.role ?? "none";
  const ms = await q.select().from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.status, "active")));
  // sliding expiry, touched at most once a minute; staff slide by the short window, never the customer one
  if (!s.lastSeenAt || Date.now() - Date.parse(s.lastSeenAt) > 60_000) {
    const idle = platformRole !== "none" ? STAFF_SESSION_MS : SESSION_IDLE_MS;
    await q.update(sessions).set({ lastSeenAt: now, expiresAt: new Date(Date.now() + idle).toISOString() }).where(eq(sessions.id, s.id));
  }
  return {
    sessionId: s.id,
    user: { id: user.id, email: user.email, name: user.name, platformRole },
    memberships: ms.map((m) => ({ companyId: m.companyId, role: m.role, status: m.status })),
    activeCompanyId: s.activeCompanyId ?? ms[0]?.companyId ?? null,
    mfaVerifiedAt: s.mfaVerifiedAt ?? null,
    identityProvider: s.identityProvider ?? "magic_link",
    aal: s.aal === "aal2" ? "aal2" : "aal1",
    createdAt: s.createdAt,
    reauthenticatedAt: s.reauthenticatedAt ?? null,
  };
}

/** Records that the holder confirmed with the sign-in provider again inside this session. */
export async function markReauthenticated(q: Queryable, sessionId: string, now: Date = new Date()): Promise<void> {
  await q.update(sessions).set({ reauthenticatedAt: now.toISOString() }).where(eq(sessions.id, sessionId));
}

/** A person's own open sessions as the account page shows them: never the token, and the address only as a short hash. */
export type SessionSummary = { id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; addressHash: string | null; userAgent: string | null; provider: string; reauthenticatedAt: string | null; current: boolean };

export function addressHash(ip: string | null | undefined): string | null {
  return ip ? createHash("sha256").update(ip).digest("hex").slice(0, 12) : null;
}

export async function listSessions(q: Queryable, userId: string, currentSessionId: string, now: Date = new Date()): Promise<SessionSummary[]> {
  const rows = await q.select().from(sessions).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now.toISOString())));
  return rows
    .map((s) => ({ id: s.id, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt ?? null, expiresAt: s.expiresAt, addressHash: addressHash(s.ip), userAgent: s.userAgent ? s.userAgent.slice(0, 160) : null, provider: s.identityProvider ?? "magic_link", reauthenticatedAt: s.reauthenticatedAt ?? null, current: s.id === currentSessionId }))
    .sort((a, b) => (a.current === b.current ? Date.parse(b.lastSeenAt ?? b.createdAt) - Date.parse(a.lastSeenAt ?? a.createdAt) : a.current ? -1 : 1));
}

/** Ends one of a person's own sessions by id. False when the id is not one of theirs or is already closed. */
export async function revokeSessionById(q: Queryable, userId: string, sessionId: string, now: Date = new Date()): Promise<boolean> {
  const rows = await q.update(sessions).set({ revokedAt: now.toISOString() }).where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt))).returning({ id: sessions.id });
  return rows.length > 0;
}

export async function setActiveCompany(q: Queryable, sessionId: string, companyId: string): Promise<void> {
  await q.update(sessions).set({ activeCompanyId: companyId }).where(eq(sessions.id, sessionId));
}

export async function revokeSession(q: Queryable, sessionToken: string): Promise<void> {
  await q.update(sessions).set({ revokedAt: new Date().toISOString() }).where(eq(sessions.tokenHash, hashToken(sessionToken)));
}

/** Ends every open session of a person (a lost device, a reset second factor, an administrator's "sign out everywhere"). Returns how many were ended. */
export async function revokeAllSessions(q: Queryable, userId: string, opts: { exceptSessionId?: string; now?: Date } = {}): Promise<number> {
  const now = (opts.now ?? new Date()).toISOString();
  const rows = await q
    .update(sessions)
    .set({ revokedAt: now })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), ...(opts.exceptSessionId ? [ne(sessions.id, opts.exceptSessionId)] : [])))
    .returning({ id: sessions.id });
  return rows.length;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Raised when a platform-role holder tries the email link: the answer is Microsoft 365 with a second factor. */
export class StaffProviderRequired extends Error {
  status = 403;
  code = "staff_provider_required";
  constructor() {
    super("ITS staff sign in with their Microsoft 365 account.");
  }
}

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { INVITE_COOKIE_TTL_MS, InvitationRefused, audit, isStaffAccount, normalizeEmail, openPayload, openSessionFromIdentity, sealPayload, SignInRefused, type SignInPolicy } from "@ros/core";
import { users, withPlatform } from "@ros/db";
import type { VerifiedIdentity } from "@ros/integrations";
import type { Container } from "../container";
import { clientIp, type Vars } from "../middleware/session";

/** Shared by the sign-in routes and the staff second-factor step (22 September 2026). */

export function sessionCookieOptions(container: Container) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: container.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 3600,
    ...(container.env.raw.COOKIE_DOMAIN ? { domain: container.env.raw.COOKIE_DOMAIN } : {}),
  };
}

export function signInPolicy(container: Container): SignInPolicy {
  return { staffDomains: container.env.ITS_STAFF_EMAIL_DOMAINS, staffProvider: "azure", requireStaffMfa: true, bootstrapAdmins: container.env.BOOTSTRAP_ADMIN_EMAILS };
}

/**
 * Opens the session in one platform transaction (the bootstrap grant, any invitation accepted, and the session row
 * commit together). A refusal rolls that transaction back, so its audit record is written again outside it: refusals
 * are never silent. The team invitation the browser carries (the sealed `ros_invite` cookie) is honoured here for every
 * sign-in path (the OAuth callback, the JSON session route, the staff second-factor step): accepted, the cookie is
 * dropped; refused because the address differs, the cookie stays so the person can sign in again with the right
 * account; refused because the invitation is gone, the cookie is dropped.
 */
export async function openSession(container: Container, c: Context<Vars>, identity: Parameters<typeof openSessionFromIdentity>[1]["identity"]) {
  const invitationTokenHash = readInviteCookie(c, container);
  try {
    const result = await withPlatform(container.db, (tx) => openSessionFromIdentity(tx, { identity, policy: signInPolicy(container), ip: clientIp(c), userAgent: c.req.header("user-agent"), invitationTokenHash, openedAt: container.engine.clock() }));
    if (invitationTokenHash) clearInviteCookie(c, container);
    return result;
  } catch (err) {
    if (err instanceof SignInRefused && err.auditRecord) await audit(container.db, err.auditRecord);
    if (err instanceof InvitationRefused) {
      if (err.code === "invite_expired") clearInviteCookie(c, container);
      await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: err.code, ip: clientIp(c), details: { email: normalizeEmail(identity.email), provider: identity.provider } });
      throw new SignInRefused(err.code, err.message);
    }
    throw err;
  }
}

/** The sealed second-factor transaction rides in this cookie, scoped to the sign-in routes, for ten minutes. */
export const MFA_COOKIE = "ros_mfa";
export const MFA_COOKIE_PATH = "/api/v1/auth";

/**
 * The team invitation a browser is in the middle of accepting: the token hash, sealed so the browser can neither read
 * nor forge it, scoped to the sign-in routes, for thirty minutes. Set by the invitation page, read by every sign-in
 * path through openSession (and the email-link consume routes), cleared once the sign-in has dealt with it.
 */
export const INVITE_COOKIE = "ros_invite";
type InviteCookie = { v: 1; tokenHash: string; exp: number };

function inviteCookieOptions(container: Container) {
  return { ...sessionCookieOptions(container), path: MFA_COOKIE_PATH, maxAge: INVITE_COOKIE_TTL_MS / 1000 };
}
export function setInviteCookie(c: Context<Vars>, container: Container, tokenHash: string): void {
  setCookie(c, INVITE_COOKIE, sealPayload<InviteCookie>("invitation", { v: 1, tokenHash, exp: container.engine.clock().getTime() + INVITE_COOKIE_TTL_MS }, container.env.SESSION_SECRET), inviteCookieOptions(container));
}
export function readInviteCookie(c: Context<Vars>, container: Container): string | null {
  const payload = openPayload<InviteCookie>("invitation", getCookie(c, INVITE_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  return payload?.v === 1 && typeof payload.tokenHash === "string" ? payload.tokenHash : null;
}
export function clearInviteCookie(c: Context<Vars>, container: Container): void {
  deleteCookie(c, INVITE_COOKIE, { path: MFA_COOKIE_PATH, ...(container.env.raw.COOKIE_DOMAIN ? { domain: container.env.raw.COOKIE_DOMAIN } : {}) });
}

export function mfaCookieOptions(container: Container) {
  return { ...sessionCookieOptions(container), path: MFA_COOKIE_PATH, maxAge: 600 };
}

/**
 * ITS staff sign in with Microsoft and a second factor. When Microsoft has vouched for the person but no second factor
 * was used yet, the sign-in continues on the authenticator step instead of being refused. Everything the session opener
 * would refuse anyway (unverified email, wrong provider, a subject that does not match the account) goes straight to it
 * so the refusal is audited as before.
 */
export async function needsSecondFactor(container: Container, identity: VerifiedIdentity): Promise<boolean> {
  const policy = signInPolicy(container);
  if (!policy.requireStaffMfa || identity.aal === "aal2" || !identity.emailVerified || identity.provider !== policy.staffProvider) return false;
  const email = normalizeEmail(identity.email);
  const [existing] = await container.db.select({ platformRole: users.platformRole, authProvider: users.authProvider, authSubject: users.authSubject }).from(users).where(eq(users.email, email)).limit(1);
  if (existing && existing.authProvider === identity.provider && existing.authSubject && existing.authSubject !== identity.subject) return false;
  const bootstrap = (policy.bootstrapAdmins ?? []).includes(email);
  return isStaffAccount(email, bootstrap ? "platform_admin" : existing?.platformRole, policy);
}

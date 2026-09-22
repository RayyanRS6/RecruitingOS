import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { audit, isStaffAccount, normalizeEmail, openSessionFromIdentity, SignInRefused, type SignInPolicy } from "@ros/core";
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
 * Opens the session in one platform transaction (the bootstrap grant and the session row commit together). A refusal
 * rolls that transaction back, so its audit record is written again outside it: refusals are never silent.
 */
export async function openSession(container: Container, c: Context<Vars>, identity: Parameters<typeof openSessionFromIdentity>[1]["identity"]) {
  try {
    return await withPlatform(container.db, (tx) => openSessionFromIdentity(tx, { identity, policy: signInPolicy(container), ip: clientIp(c), userAgent: c.req.header("user-agent") }));
  } catch (err) {
    if (err instanceof SignInRefused && err.auditRecord) await audit(container.db, err.auditRecord);
    throw err;
  }
}

/** The sealed second-factor transaction rides in this cookie, scoped to the sign-in routes, for ten minutes. */
export const MFA_COOKIE = "ros_mfa";
export const MFA_COOKIE_PATH = "/api/v1/auth";

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

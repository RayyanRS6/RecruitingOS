import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { INVITE_COOKIE_TTL_MS, InvitationRefused, audit, holdsOtherThanStaffProvider, identityForSignIn, isStaffAccount, linkedToAnotherSubject, normalizeEmail, openPayload, openSessionFromIdentity, sealPayload, SignInRefused, type SignInPolicy } from "@ros/core";
import { users, withPlatform } from "@ros/db";
import type { VerifiedIdentity } from "@ros/integrations";
import type { Container } from "../container";
import { PKCE_COOKIE } from "../cookie-names";
import { clearAppCookie, readAppCookie, setAppCookie, type CookiePlace } from "../cookies";
import { SESSION_COOKIE, SESSION_PLACE, clientIp, type Vars } from "../middleware/session";

/** Shared by the sign-in routes and the staff second-factor step (22 September 2026). */

/** The session cookie, for thirty days; cookies.ts names, flags and scopes it. */
export function setSessionCookie(c: Context<Vars>, sessionToken: string): void {
  setAppCookie(c, SESSION_COOKIE, sessionToken, { ...SESSION_PLACE, maxAge: 30 * 24 * 3600 });
}
export function clearSessionCookie(c: Context<Vars>): void {
  clearAppCookie(c, SESSION_COOKIE, SESSION_PLACE);
}

/**
 * The PKCE verifier, the state and the provider the browser started with ride in this cookie for ten minutes, from
 * /start (or /reauth/start) to the callback. Path=/ and shared like the session cookie. Named in cookie-names.ts, which the
 * shell's middleware reads too (a refusal at the address's root).
 */
const PKCE_PLACE: CookiePlace = { path: "/", shared: true };
export type PkceStart = { verifier: string; state: string; provider: string };
export function setPkceCookie(c: Context<Vars>, start: PkceStart): void {
  setAppCookie(c, PKCE_COOKIE, `${start.verifier}.${start.state}.${start.provider}`, { ...PKCE_PLACE, maxAge: 600 });
}
/** All three parts or nothing: the callback needs the provider the browser started with (known bug row 41). */
export function readPkceCookie(c: Context<Vars>): PkceStart | null {
  const [verifier, state, provider] = (readAppCookie(c, PKCE_COOKIE, PKCE_PLACE) ?? "").split(".");
  return verifier && state && provider ? { verifier, state, provider } : null;
}
export function clearPkceCookie(c: Context<Vars>): void {
  clearAppCookie(c, PKCE_COOKIE, PKCE_PLACE);
}

/** The allowed providers are the ones the sign-in page offers (AUTH_SIGNIN_PROVIDERS for the managed service, azure and google by default). */
export function signInPolicy(container: Container): SignInPolicy {
  return { staffDomains: container.env.ITS_STAFF_EMAIL_DOMAINS, staffProvider: "azure", requireStaffMfa: true, bootstrapAdmins: container.env.BOOTSTRAP_ADMIN_EMAILS, allowedProviders: container.integrations.identity.providers().map((p) => p.key) };
}

/**
 * Opens the session in one platform transaction (the bootstrap grant, any invitation accepted, and the session row
 * commit together). A refusal rolls that transaction back, so its audit record is written again outside it: refusals
 * are never silent. The team invitation the browser carries (the sealed `ros_invite` cookie) is honoured here for every
 * sign-in path (the OAuth callback, the JSON session route, the staff second-factor step): accepted, the cookie is
 * dropped; refused because the address differs, the cookie stays so the person can sign in again with the right
 * account; refused because the invitation is gone, or because the company's trial has all its people (founder decision
 * L-02 B; the person opens the link again once a plan is chosen), the cookie is dropped. `startedProvider` is the
 * provider the browser flow started with (none on the JSON route): see identityForSignIn in packages/core.
 */
export async function openSession(container: Container, c: Context<Vars>, identity: Parameters<typeof openSessionFromIdentity>[1]["identity"], startedProvider: string | null = null) {
  const invitationTokenHash = readInviteCookie(c, container);
  try {
    const result = await withPlatform(container.db, (tx) => openSessionFromIdentity(tx, { identity, startedProvider, policy: signInPolicy(container), ip: clientIp(c), userAgent: c.req.header("user-agent"), invitationTokenHash, openedAt: container.engine.clock() }));
    if (invitationTokenHash) clearInviteCookie(c);
    return result;
  } catch (err) {
    if (err instanceof SignInRefused && err.auditRecord) await audit(container.db, err.auditRecord);
    if (err instanceof InvitationRefused) {
      if (err.code === "invite_expired" || err.code === "invite_seats_full") clearInviteCookie(c);
      await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: err.code, ip: clientIp(c), details: { email: normalizeEmail(identity.email), provider: startedProvider ?? identity.provider } });
      throw new SignInRefused(err.code, err.message);
    }
    throw err;
  }
}

/** The sealed second-factor transaction rides in this cookie, scoped to the sign-in routes, for ten minutes. */
export const MFA_COOKIE = "ros_mfa";
export const MFA_COOKIE_PATH = "/api/v1/auth";
/** The cookies of a sign-in step (the second factor, the invitation, the re-authentication marker): the sign-in routes only, shared like the session cookie. */
export const SIGN_IN_STEP_PLACE: CookiePlace = { path: MFA_COOKIE_PATH, shared: true };

export function setMfaCookie(c: Context<Vars>, sealed: string): void {
  setAppCookie(c, MFA_COOKIE, sealed, { ...SIGN_IN_STEP_PLACE, maxAge: 600 });
}
export function readMfaCookie(c: Context<Vars>): string | undefined {
  return readAppCookie(c, MFA_COOKIE, SIGN_IN_STEP_PLACE);
}
export function clearMfaCookie(c: Context<Vars>): void {
  clearAppCookie(c, MFA_COOKIE, SIGN_IN_STEP_PLACE);
}

/**
 * The team invitation a browser is in the middle of accepting: the token hash, sealed so the browser can neither read
 * nor forge it, scoped to the sign-in routes, for thirty minutes. Set by the invitation page, read by every sign-in
 * path through openSession (and the email-link consume routes), cleared once the sign-in has dealt with it.
 */
export const INVITE_COOKIE = "ros_invite";
type InviteCookie = { v: 1; tokenHash: string; exp: number };

export function setInviteCookie(c: Context<Vars>, container: Container, tokenHash: string): void {
  setAppCookie(c, INVITE_COOKIE, sealPayload<InviteCookie>("invitation", { v: 1, tokenHash, exp: container.engine.clock().getTime() + INVITE_COOKIE_TTL_MS }, container.env.SESSION_SECRET), { ...SIGN_IN_STEP_PLACE, maxAge: INVITE_COOKIE_TTL_MS / 1000 });
}
export function readInviteCookie(c: Context<Vars>, container: Container): string | null {
  const payload = openPayload<InviteCookie>("invitation", readAppCookie(c, INVITE_COOKIE, SIGN_IN_STEP_PLACE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  return payload?.v === 1 && typeof payload.tokenHash === "string" ? payload.tokenHash : null;
}
export function clearInviteCookie(c: Context<Vars>): void {
  clearAppCookie(c, INVITE_COOKIE, SIGN_IN_STEP_PLACE);
}

/**
 * ITS staff sign in with Microsoft and a second factor. When Microsoft has vouched for the person but no second factor
 * was used yet, the sign-in continues on the authenticator step instead of being refused. Everything the session opener
 * would refuse anyway (a provider the deployment does not offer or the browser did not start, no usable address,
 * unverified email, wrong provider, an account that also holds another provider, a subject that does not match the
 * account) goes straight to it so the refusal is audited as before. The provider is the one this sign-in used
 * (identityForSignIn), never the account's first. An account holding any provider but Microsoft never reaches the
 * authenticator step, so no factor is ever enrolled through a sign-in that only claimed to be Microsoft.
 */
export async function needsSecondFactor(container: Container, identity: VerifiedIdentity, startedProvider: string): Promise<boolean> {
  const policy = signInPolicy(container);
  const checked = identityForSignIn(identity, startedProvider, policy);
  if (!checked.ok) return false;
  const used = checked.identity;
  if (!policy.requireStaffMfa || used.aal === "aal2" || !used.emailVerified || used.provider !== policy.staffProvider || holdsOtherThanStaffProvider(used, policy)) return false;
  const email = normalizeEmail(used.email);
  const [existing] = await container.db.select({ platformRole: users.platformRole, authProvider: users.authProvider, authSubject: users.authSubject }).from(users).where(eq(users.email, email)).limit(1);
  if (existing && linkedToAnotherSubject(existing, used)) return false;
  const bootstrap = (policy.bootstrapAdmins ?? []).includes(email);
  return isStaffAccount(email, bootstrap ? "platform_admin" : existing?.platformRole, policy);
}

import { Hono, type Context } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { appPaths } from "@ros/contracts";
import { audit, identityForSignIn, linkedToAnotherSubject, markReauthenticated, normalizeEmail, openPayload, sealPayload } from "@ros/core";
import { users, withPlatform } from "@ros/db";
import { base64url, type VerifiedIdentity } from "@ros/integrations";
import type { Container } from "../container";
import { clearAppCookie, readAppCookie, setAppCookie } from "../cookies";
import { HttpError } from "../middleware/errors";
import { clientIp, requireUser, type Vars } from "../middleware/session";
import { SIGN_IN_STEP_PLACE, clearPkceCookie, setPkceCookie, signInPolicy } from "./auth-shared";

/**
 * "Confirm it's you": the re-authentication step before someone is made an admin or an owner (services/team.ts refuses
 * that with 403 `reauth_required` from a session that is neither young nor confirmed again). It is the same provider
 * flow as sign-in, marked so the callback confirms the session already open instead of opening one. Mounted under
 * /api/v1/auth next to routes/auth.ts, whose OAuth callback hands a returning re-authentication to `completeReauth`.
 */
export const authSessionRoutes = new Hono<Vars>();

export const REAUTH_COOKIE = "ros_reauth";
/** Appended to the OAuth state of a re-authentication (spelled without characters the cookie or the URL could mangle). */
export const REAUTH_STATE_SUFFIX = "-reauth1";
const REAUTH_TTL_MS = 10 * 60_000;
type ReauthMarker = { v: 1; sessionId: string; userId: string; state: string; returnTo: string; exp: number };

export function readReauthMarker(c: Context<Vars>, container: Container): ReauthMarker | null {
  const p = openPayload<ReauthMarker>("reauth", readAppCookie(c, REAUTH_COOKIE, SIGN_IN_STEP_PLACE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  return p?.v === 1 && typeof p.sessionId === "string" && typeof p.state === "string" ? p : null;
}
function clearReauthCookies(c: Context<Vars>): void {
  clearAppCookie(c, REAUTH_COOKIE, SIGN_IN_STEP_PLACE);
  clearPkceCookie(c);
}

/** Where the browser returns to: only a path inside the app, never another site; Settings when none is given. */
function safeReturnTo(value: unknown): string {
  return typeof value === "string" && /^\/(?!\/)[^\s]*$/.test(value) && value.length < 400 ? value : appPaths.settings;
}
function withParam(path: string, key: string, value: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`;
}

/**
 * Starts "Confirm it's you": a sealed marker (this session, the expected state, where to return) rides in a cookie, and
 * the browser goes through the same PKCE flow as sign-in with a marked state. The session already open is neither
 * replaced nor extended; on return the callback stamps `reauthenticated_at` and sends the browser back to `returnTo`
 * with `reauth=ok`, `reauth=mismatch` (another person's sign-in) or `reauth=failed` added: Settings sends
 * `returnTo: "/setup"` and comes back to `/setup?reauth=ok`. Answers JSON `{ ok, url, provider }` to a fetch and a
 * redirect to a posted form.
 */
authSessionRoutes.post("/reauth/start", requireUser, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const contentType = c.req.header("content-type") ?? "";
  const body = contentType.includes("application/json") ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>) : ((await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>);
  const offered = container.integrations.identity.providers().map((p) => p.key);
  const requested = typeof body.provider === "string" ? body.provider : "";
  const provider = offered.includes(requested) ? requested : offered.includes(s.identityProvider) ? s.identityProvider : offered[0];
  if (!provider) throw new HttpError(409, "no_provider", "No sign-in provider is offered here, so identity cannot be confirmed again.");
  const returnTo = safeReturnTo(body.returnTo);
  const verifier = base64url.encode(randomBytes(32));
  // The state carries the reauth marker (no dot: the PKCE cookie is dot-separated). The callback only treats a marked state as a re-authentication.
  const state = `${base64url.encode(randomBytes(16))}${REAUTH_STATE_SUFFIX}`;
  const codeChallenge = base64url.encode(createHash("sha256").update(verifier).digest());
  const now = container.engine.clock().getTime();
  setPkceCookie(c, { verifier, state, provider });
  setAppCookie(c, REAUTH_COOKIE, sealPayload<ReauthMarker>("reauth", { v: 1, sessionId: s.sessionId, userId: s.user.id, state, returnTo, exp: now + REAUTH_TTL_MS }, container.env.SESSION_SECRET), { ...SIGN_IN_STEP_PLACE, maxAge: REAUTH_TTL_MS / 1000 });
  const url = container.integrations.identity.authorizeUrl({ provider, redirectTo: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, codeChallenge, state });
  if (contentType.includes("application/json") || (c.req.header("accept") ?? "").includes("application/json")) return c.json({ ok: true, url, provider });
  return c.redirect(url, 302);
});

/**
 * A re-authentication the identity service sent back refused (Cancel pressed at the provider, or the provider or the
 * service said no) ends as its other failures do: back where it started with `reauth=failed`, the marker and the PKCE
 * cookie cleared, nothing changed. The trailing `#` keeps the service's copy of the refusal (the fragment, which a
 * browser carries through a redirect that names none) out of the app's address.
 */
export function refusedReauth(c: Context<Vars>, container: Container, marker: ReauthMarker): Response {
  clearReauthCookies(c);
  const to = withParam(marker.returnTo, "reauth", "failed");
  return c.redirect(`${container.env.APP_BASE_URL}${to}${to.includes("#") ? "" : "#"}`, 302);
}

/**
 * The callback's re-authentication branch: the identity the provider vouched for must be the signed-in person (same
 * verified address, and the same subject when the account is linked to a provider it holds), through a provider the
 * deployment offers and the one this browser started with (identityForSignIn, as for a sign-in). Then the session is
 * stamped, audited, and the browser returns to where it was with `reauth=ok`; anything else returns with
 * `reauth=failed` or `reauth=mismatch` and changes nothing.
 */
export async function completeReauth(c: Context<Vars>, container: Container, input: { identity: VerifiedIdentity; startedProvider: string; marker: ReauthMarker; returnedState: string | null }): Promise<Response> {
  const back = (outcome: "ok" | "failed" | "mismatch") => { clearReauthCookies(c); return c.redirect(`${container.env.APP_BASE_URL}${withParam(input.marker.returnTo, "reauth", outcome)}`, 302); };
  const s = c.get("session");
  if (!s || s.sessionId !== input.marker.sessionId || s.user.id !== input.marker.userId) return back("failed");
  if (!input.returnedState || input.returnedState !== input.marker.state || !input.marker.state.endsWith(REAUTH_STATE_SUFFIX)) return back("failed");
  const checked = identityForSignIn(input.identity, input.startedProvider, signInPolicy(container));
  if (!checked.ok) return back("failed");
  const identity = checked.identity;
  if (!identity.emailVerified || normalizeEmail(identity.email) !== normalizeEmail(s.user.email)) return back("mismatch");
  const now = container.engine.clock();
  const outcome = await withPlatform(container.db, async (tx) => {
    const [u] = await tx.select({ authProvider: users.authProvider, authSubject: users.authSubject }).from(users).where(eq(users.id, s.user.id)).limit(1);
    if (u && linkedToAnotherSubject(u, identity)) return "mismatch" as const;
    await markReauthenticated(tx, s.sessionId, now);
    await audit(tx, { companyId: c.get("tenant")?.companyId ?? null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "session.reauthenticated", target: { type: "user", id: s.user.id }, reason: identity.provider, ip: clientIp(c), details: { sessionId: s.sessionId, provider: identity.provider, aal: identity.aal } });
    return "ok" as const;
  });
  return back(outcome);
}

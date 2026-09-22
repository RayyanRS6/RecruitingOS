import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { MagicLinkConsume, MagicLinkRequest } from "@ros/contracts";
import { createHash, randomBytes } from "node:crypto";
import { consumeMagicLink, createMagicLink, isStaffAccount, newMfaTransactionId, normalizeEmail, revokeSession, sealMfaTransaction, setActiveCompany, SignInRefused, MFA_TRANSACTION_TTL_MS } from "@ros/core";
import { companies, memberships, users } from "@ros/db";
import { mfaRoutes } from "./auth-mfa";
import { MFA_COOKIE, mfaCookieOptions, needsSecondFactor, openSession, sessionCookieOptions, signInPolicy } from "./auth-shared";
import { FakeEmailAdapter, FakeIdentityProvider, IdentityError, base64url } from "@ros/integrations";
import { SESSION_COOKIE, clientIp, isPlatformStaff, type Vars } from "../middleware/session";
import { activeStaffGrant } from "@ros/core";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { POLICIES, rateLimit } from "../middleware/rate-limit";

export const authRoutes = new Hono<Vars>();

/**
 * Sign-in links point at the API, which sets the session cookie on a top-level navigation and redirects into
 * the web app. That is the reliable way to set a cookie from a link (no XHR involved) and it works when the
 * API and the app share a site. Cookies ignore ports, so in development localhost:3001 sets a cookie that
 * localhost:5173 sends.
 */
export function consumeLink(container: Container, token: string): string {
  return `${container.env.APP_BASE_URL}/api/v1/auth/consume?token=${encodeURIComponent(token)}`;
}

/** What the sign-in page offers: delegated providers always; the email link only where it is enabled. */
authRoutes.get("/config", async (c) => {
  const container = c.get("container");
  return c.json({ mode: container.integrations.identity.id, providers: container.integrations.identity.providers(), magicLink: container.env.MAGIC_LINK_ENABLED, staffDomains: container.env.ITS_STAFF_EMAIL_DOMAINS });
});

authRoutes.route("/mfa", mfaRoutes);

const PKCE_COOKIE = "ros_pkce";

/** Starts the PKCE authorization-code flow with the identity service. The verifier lives in an httpOnly cookie, never in the URL. */
authRoutes.get("/start/:provider", async (c) => {
  const container = c.get("container");
  const provider = c.req.param("provider");
  if (!container.integrations.identity.providers().some((p) => p.key === provider)) throw new HttpError(404, "unknown_provider", "That sign-in method is not offered.");
  const verifier = base64url.encode(randomBytes(32));
  const state = base64url.encode(randomBytes(16));
  const codeChallenge = base64url.encode(createHash("sha256").update(verifier).digest());
  setCookie(c, PKCE_COOKIE, `${verifier}.${state}.${provider}`, { ...sessionCookieOptions(container), maxAge: 600 });
  const redirectTo = `${container.env.APP_BASE_URL}/api/v1/auth/callback`;
  return c.redirect(container.integrations.identity.authorizeUrl({ provider, redirectTo, codeChallenge, state }), 302);
});

/** The identity service returns here with a single-use code; the code is exchanged server-side and the token verified before a session opens. */
authRoutes.get("/callback", async (c) => {
  const container = c.get("container");
  const fail = (code: string) => { deleteCookie(c, PKCE_COOKIE, { path: "/" }); return c.redirect(`${container.env.WEB_BASE_URL}/login?error=${encodeURIComponent(code)}`, 302); };
  const pkce = getCookie(c, PKCE_COOKIE);
  const code = c.req.query("code");
  if (!pkce || !code) return fail("signin_incomplete");
  const [verifier, state] = pkce.split(".");
  const returnedState = c.req.query("state");
  if (returnedState && returnedState !== state) return fail("signin_incomplete");
  try {
    const { accessToken } = await container.integrations.identity.exchangeCode({ code, codeVerifier: verifier });
    const identity = await container.integrations.identity.verify(accessToken);
    if (await needsSecondFactor(container, identity)) {
      // Microsoft has vouched for an ITS staff member; the authenticator step opens the session, not this route.
      deleteCookie(c, PKCE_COOKIE, { path: "/" });
      const now = container.engine.clock().getTime();
      setCookie(c, MFA_COOKIE, sealMfaTransaction({ v: 1, id: newMfaTransactionId(), accessToken, email: normalizeEmail(identity.email), provider: identity.provider, subject: identity.subject, stage: "start", factorIds: [], secret: null, uri: null, notice: null, expiresAt: now + MFA_TRANSACTION_TTL_MS }, container.env.SESSION_SECRET), mfaCookieOptions(container));
      return c.redirect(`${container.env.APP_BASE_URL}/api/v1/auth/mfa`, 302);
    }
    const result = await openSession(container, c, identity);
    deleteCookie(c, PKCE_COOKIE, { path: "/" });
    setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
    return c.redirect(`${container.env.WEB_BASE_URL}${result.activeCompanyId || result.staff ? "/" : "/setup/company"}`, 302);
  } catch (err) {
    if (err instanceof SignInRefused || err instanceof IdentityError) return fail(err.code);
    throw err;
  }
});

/** JSON variant: a verified token from the identity service opens a session (native clients, tests). */
authRoutes.post("/session", rateLimit(POLICIES.authSession), async (c) => {
  const container = c.get("container");
  const { accessToken } = (await c.req.json()) as { accessToken?: string };
  if (!accessToken) throw new HttpError(400, "invalid_request", "accessToken is required.");
  try {
    const identity = await container.integrations.identity.verify(accessToken);
    const result = await openSession(container, c, identity);
    setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
    return c.json({ ok: true, userId: result.userId, activeCompanyId: result.activeCompanyId, staff: result.staff, expiresAt: result.expiresAt });
  } catch (err) {
    if (err instanceof SignInRefused) throw new HttpError(403, err.code, err.message);
    if (err instanceof IdentityError) throw new HttpError(401, err.code, err.message);
    throw err;
  }
});

/**
 * Development only: the fake issuer's consent page. Lets a developer act as any person, through any provider, with or
 * without a second factor, so every sign-in rule is exercised without an external account. Production never mounts it.
 */
authRoutes.get("/fake/authorize", async (c) => {
  const container = c.get("container");
  if (container.env.NODE_ENV === "production" || !(container.integrations.identity instanceof FakeIdentityProvider)) return c.notFound();
  const q = c.req.query();
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fake sign-in (development)</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8vh auto;padding:0 16px;color:#1b1b1b}label{display:block;margin:12px 0 4px}input[type=text],input[type=email]{width:100%;padding:8px;border:1px solid #bbb;border-radius:6px}button{margin-top:16px;padding:10px 16px;border-radius:6px;border:0;background:#1f4b99;color:#fff;font-size:15px}.note{background:#fff4d6;padding:10px;border-radius:6px;font-size:14px}</style></head>
<body><h1>Sign in with ${esc(q.provider === "azure" ? "Microsoft" : q.provider === "google" ? "Google" : q.provider ?? "provider")} (fake)</h1>
<p class="note">Development only. This page stands in for the identity service. Nothing here is real; production never shows it.</p>
<form method="post" action="/api/v1/auth/fake/authorize">
<input type="hidden" name="provider" value="${esc(q.provider ?? "google")}"><input type="hidden" name="redirect_to" value="${esc(q.redirect_to ?? "")}"><input type="hidden" name="code_challenge" value="${esc(q.code_challenge ?? "")}"><input type="hidden" name="state" value="${esc(q.state ?? "")}">
<label for="email">Email</label><input id="email" name="email" type="email" required autofocus>
<label for="name">Name</label><input id="name" name="name" type="text">
<label><input type="checkbox" name="aal2" value="1" checked> Second factor verified (TOTP)</label>
<label><input type="checkbox" name="email_verified" value="1" checked> Email verified by the provider</label>
<button type="submit">Continue</button></form></body></html>`);
});

authRoutes.post("/fake/authorize", async (c) => {
  const container = c.get("container");
  const identity = container.integrations.identity;
  if (container.env.NODE_ENV === "production" || !(identity instanceof FakeIdentityProvider)) return c.notFound();
  const form = await c.req.parseBody();
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const provider = (["azure", "google", "email"].includes(str("provider")) ? str("provider") : "google") as "azure" | "google" | "email";
  const code = identity.issueCode({ email: str("email"), name: str("name") || null, provider, aal: str("aal2") ? "aal2" : "aal1", emailVerified: !!str("email_verified"), codeChallenge: str("code_challenge") });
  const target = new URL(str("redirect_to") || `${container.env.APP_BASE_URL}/api/v1/auth/callback`);
  target.searchParams.set("code", code);
  if (str("state")) target.searchParams.set("state", str("state"));
  return c.redirect(target.toString(), 302);
});

authRoutes.post("/magic-link", rateLimit(POLICIES.authMagicLink), async (c) => {
  const body = MagicLinkRequest.parse(await c.req.json());
  const container = c.get("container");
  if (!container.env.MAGIC_LINK_ENABLED) throw new HttpError(410, "magic_link_disabled", "Email links are not offered here. Sign in with Google or Microsoft.");
  // ITS staff accounts never sign in with an email link (D19, correction 4): Microsoft plus a second factor, always.
  const [existing] = await container.db.select({ platformRole: users.platformRole }).from(users).where(eq(users.email, normalizeEmail(body.email))).limit(1);
  if (isStaffAccount(body.email, existing?.platformRole ?? null, signInPolicy(container))) throw new HttpError(403, "staff_provider_required", "ITS staff sign in with their Microsoft 365 account.");
  const { token } = await createMagicLink(container.db, { email: body.email, ip: clientIp(c) });
  const link = consumeLink(container, token);
  await container.integrations.email.send({
    to: body.email,
    from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
    subject: "Your sign-in link",
    text: `Click to sign in (valid for 15 minutes):\n${link}\n\nIf you did not request this, ignore this email.`,
    idempotencyKey: `magic:${token.slice(0, 12)}`,
    tags: { template: "magic_link" },
  });
  // Development convenience: the fake adapter never sends, so expose the link when not in production.
  const dev = container.env.NODE_ENV !== "production" && container.integrations.email instanceof FakeEmailAdapter ? { devLink: link } : {};
  return c.json({ ok: true, ...dev });
});

/** The link in the email: consume, set the cookie, and redirect into the app. */
authRoutes.get("/consume", async (c) => {
  const container = c.get("container");
  const token = c.req.query("token") ?? "";
  try {
    const result = await consumeMagicLink(container.db, { token, ip: clientIp(c), userAgent: c.req.header("user-agent") });
    setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
    return c.redirect(`${container.env.WEB_BASE_URL}${result.activeCompanyId ? "/" : "/setup/company"}`, 302);
  } catch {
    return c.redirect(`${container.env.WEB_BASE_URL}/login?error=expired`, 302);
  }
});

/** JSON variant for API clients and tests. */
authRoutes.post("/magic-link/consume", async (c) => {
  const body = MagicLinkConsume.parse(await c.req.json());
  const container = c.get("container");
  const result = await consumeMagicLink(container.db, { token: body.token, ip: clientIp(c), userAgent: c.req.header("user-agent") });
  setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
  return c.json({ ok: true, userId: result.userId, activeCompanyId: result.activeCompanyId });
});

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await revokeSession(c.get("container").db, token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", async (c) => {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Not signed in.");
  const container = c.get("container");
  const ms = await container.db
    .select({ companyId: memberships.companyId, role: memberships.role, name: companies.name, slug: companies.slug })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(eq(memberships.userId, s.user.id));
  return c.json({
    user: { id: s.user.id, email: s.user.email, name: s.user.name, platformRole: s.user.platformRole },
    auth: { provider: s.identityProvider, aal: s.aal, mfaVerifiedAt: s.mfaVerifiedAt },
    memberships: ms.map((m) => ({ companyId: m.companyId, companyName: m.name, companySlug: m.slug, role: m.role })),
    activeCompanyId: c.get("tenant")?.companyId ?? null,
    staffAccess: c.get("tenant")?.staff ? { ...c.get("tenant")!.staff!, companyName: (await container.db.select({ name: companies.name }).from(companies).where(eq(companies.id, c.get("tenant")!.companyId)).limit(1))[0]?.name ?? null } : null,
    ai: { provider: container.ai.provider.id },
  });
});

authRoutes.post("/switch", async (c) => {
  const s = c.get("session");
  if (!s) throw new HttpError(401, "unauthorized", "Not signed in.");
  const { companyId } = (await c.req.json()) as { companyId: string };
  // Founder decision F1: only a verified membership selects a tenant. Staff access is granted per escalation (slice 2), never here.
  let ok = s.memberships.some((m) => m.companyId === companyId && m.status === "active");
  // ITS staff may enter a company only under an active, scoped grant (founder decision F10).
  if (!ok && isPlatformStaff(s)) ok = !!(await activeStaffGrant(c.get("container").db, s.user.id, companyId));
  if (!ok) throw new HttpError(403, "forbidden", "You are not a member of that company, and no recruiter assignment gives you access to it.");
  await setActiveCompany(c.get("container").db, s.sessionId, companyId);
  return c.json({ ok: true });
});

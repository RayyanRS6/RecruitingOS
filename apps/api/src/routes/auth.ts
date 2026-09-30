import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, eq } from "drizzle-orm";
import { MagicLinkConsume, MagicLinkRequest, type MeResponse, type MembershipRole } from "@ros/contracts";
import { createHash, randomBytes } from "node:crypto";
import { InvitationRefused, audit, consumeMagicLink, createMagicLink, escapeHtml, findInvitationByToken, hashInvitationToken, invitationState, isStaffAccount, newMfaTransactionId, normalizeEmail, revokeSession, roleInWords, sealMfaTransaction, setActiveCompany, SignInRefused, MFA_TRANSACTION_TTL_MS } from "@ros/core";
import { companies, memberships, users, withPlatform } from "@ros/db";
import { mfaRoutes } from "./auth-mfa";
import { REAUTH_STATE_SUFFIX, completeReauth, readReauthMarker } from "./auth-sessions";
import { renderSignInLinkPage } from "../pages/signin-link";
import { renderInvitePage, type InvitePageProps } from "../pages/invite";
import { MFA_COOKIE, clearInviteCookie, mfaCookieOptions, needsSecondFactor, openSession, readInviteCookie, sessionCookieOptions, setInviteCookie, signInPolicy } from "./auth-shared";
import { FakeEmailAdapter, FakeIdentityProvider, IdentityError, base64url } from "@ros/integrations";
import { SESSION_COOKIE, clientIp, isPlatformStaff, type Vars } from "../middleware/session";
import { activeStaffGrant } from "@ros/core";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import { POLICIES, rateLimit } from "../middleware/rate-limit";

export const authRoutes = new Hono<Vars>();

/**
 * Sign-in and invitation links point at the API, which shows a one-button page; pressing it sets the session cookie on
 * a top-level navigation and redirects into the app. That is the reliable way to set a cookie from a link, and opening
 * the link alone (a mail scanner, a preview) never consumes it.
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
  const fail = (code: string) => { deleteCookie(c, PKCE_COOKIE, { path: "/" }); return c.redirect(`${container.env.APP_BASE_URL}/login?error=${encodeURIComponent(code)}`, 302); };
  const pkce = getCookie(c, PKCE_COOKIE);
  const code = c.req.query("code");
  if (!pkce || !code) return fail("signin_incomplete");
  const [verifier, state] = pkce.split(".");
  // The state is mandatory and must be the one this browser was given; PKCE binds the code, the state binds the flow.
  const returnedState = c.req.query("state");
  if (!returnedState || returnedState !== state) return fail("signin_incomplete");
  try {
    const { accessToken } = await container.integrations.identity.exchangeCode({ code, codeVerifier: verifier });
    const identity = await container.integrations.identity.verify(accessToken);
    // "Confirm it's you" (audit finding A12): a flow marked reauth=1 stamps the session already open instead of opening one.
    const reauth = readReauthMarker(c, container);
    if (reauth && returnedState.endsWith(REAUTH_STATE_SUFFIX)) return await completeReauth(c, container, { identity, marker: reauth, returnedState });
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
    return c.redirect(`${container.env.APP_BASE_URL}${result.activeCompanyId || result.staff ? "/" : "/setup/company"}`, 302);
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
  const esc = escapeHtml;
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

/**
 * The link in the email opens a page with one button; nothing is consumed by opening it, so a mail scanner or a link
 * preview cannot burn the single-use link. The button posts the token, which opens the session and redirects into the app.
 */
authRoutes.get("/consume", async (c) => {
  const container = c.get("container");
  const token = c.req.query("token") ?? "";
  if (!token) return c.redirect(`${container.env.APP_BASE_URL}/login?error=expired`, 302);
  // A team invitation is no longer carried by the link (migration 0022): the page is the plain sign-in one; the sealed
  // invite cookie, if the person came from an invitation page, is honoured when the button is pressed.
  return c.html(renderSignInLinkPage({ token, productName: container.env.PRODUCT_NAME, action: `${container.env.APP_BASE_URL}/api/v1/auth/consume`, invite: !!readInviteCookie(c, container) }));
});

/** The email-link path honours a carried invitation like the delegated sign-in does: accepted, the cookie goes; the wrong address keeps it; a dead invitation drops it. */
async function consumeWithInvitation(c: Context<Vars>, container: Container, token: string) {
  const invitationTokenHash = readInviteCookie(c, container);
  try {
    const result = await withPlatform(container.db, (tx) => consumeMagicLink(tx, { token, ip: clientIp(c), userAgent: c.req.header("user-agent"), invitationTokenHash, openedAt: container.engine.clock() }));
    if (invitationTokenHash) clearInviteCookie(c, container);
    return result;
  } catch (err) {
    if (err instanceof InvitationRefused) {
      if (err.code === "invite_expired") clearInviteCookie(c, container);
      // The transaction rolled back, so the refusal is recorded outside it, as openSession does: refusals are never silent.
      await audit(container.db, { companyId: null, actor: { kind: "system", id: "sign_in" }, action: "signin.refused", reason: err.code, ip: clientIp(c), details: { provider: "magic_link", ...(err.email ? { email: err.email } : {}) } });
    }
    throw err;
  }
}

authRoutes.post("/consume", async (c) => {
  const container = c.get("container");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = typeof form.token === "string" ? form.token : "";
  try {
    const result = await consumeWithInvitation(c, container, token);
    setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
    return c.redirect(`${container.env.APP_BASE_URL}${result.activeCompanyId ? "/" : "/setup/company"}`, 302);
  } catch (err) {
    return c.redirect(`${container.env.APP_BASE_URL}/login?error=${err instanceof InvitationRefused ? err.code : "expired"}`, 302);
  }
});

/** JSON variant for API clients and tests. */
authRoutes.post("/magic-link/consume", async (c) => {
  const body = MagicLinkConsume.parse(await c.req.json());
  const container = c.get("container");
  let result: Awaited<ReturnType<typeof consumeWithInvitation>>;
  try {
    result = await consumeWithInvitation(c, container, body.token);
  } catch (err) {
    if (err instanceof InvitationRefused) throw new HttpError(403, err.code, err.message);
    throw err;
  }
  setCookie(c, SESSION_COOKIE, result.sessionToken, sessionCookieOptions(container));
  return c.json({ ok: true, userId: result.userId, activeCompanyId: result.activeCompanyId, invitationsAccepted: result.invitationsAccepted });
});

/** What the invitation page needs to say about one link. Never the token hash; the token itself only goes back into the page's own form. */
async function invitePageFor(container: Container, token: string): Promise<InvitePageProps> {
  const base = { productName: container.env.PRODUCT_NAME, providers: container.integrations.identity.providers(), startBase: `${container.env.APP_BASE_URL}/api/v1/auth/start`, magicLink: container.env.MAGIC_LINK_ENABLED, emailAction: `${container.env.APP_BASE_URL}/api/v1/auth/invite/email`, token, loginHref: `${container.env.APP_BASE_URL}/login` };
  const found = await withPlatform(container.db, async (tx) => {
    const inv = await findInvitationByToken(tx, token);
    if (!inv) return null;
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, inv.companyId)).limit(1);
    return { inv, companyName: company?.name ?? null };
  });
  if (!found) return { ...base, state: "unknown", companyName: null, email: null, roleWords: null };
  return { ...base, state: invitationState(found.inv, container.engine.clock()), companyName: found.companyName, email: found.inv.email, roleWords: roleInWords(found.inv.role) };
}

/**
 * The team invitation link (docs/spec/21, area A). Opening it signs nobody in and consumes nothing: the page names the
 * company and the role and offers Google or Microsoft (and the email link where the deployment enables it). The
 * invitation rides in a sealed cookie that every sign-in path honours only for the invited address.
 */
authRoutes.get("/invite", async (c) => {
  const container = c.get("container");
  const token = c.req.query("token") ?? "";
  const page = await invitePageFor(container, token);
  if (page.state === "pending") setInviteCookie(c, container, hashInvitationToken(token));
  return c.html(renderInvitePage(page));
});

/** "Email me a sign-in link" from the invitation page: the link goes to the invited address only; the form carries no address of its own. */
authRoutes.post("/invite/email", rateLimit(POLICIES.authInviteEmail), async (c) => {
  const container = c.get("container");
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = typeof form.token === "string" ? form.token : "";
  if (!container.env.MAGIC_LINK_ENABLED) throw new HttpError(410, "magic_link_disabled", "Email links are not offered here. Sign in with Google or Microsoft.");
  const page = await invitePageFor(container, token);
  if (page.state !== "pending" || !page.email) return c.html(renderInvitePage(page));
  const email = page.email;
  const { token: linkToken } = await withPlatform(container.db, (tx) => createMagicLink(tx, { email, ip: clientIp(c) }));
  const link = consumeLink(container, linkToken);
  await container.integrations.email.send({
    to: email,
    from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
    subject: `Your sign-in link to join ${page.companyName ?? "your team"}`,
    text: `Click to sign in and join ${page.companyName ?? "your team"} (valid for 15 minutes):\n${link}\n\nIf you did not request this, ignore this email.`,
    idempotencyKey: `magic:${linkToken.slice(0, 12)}`,
    tags: { template: "magic_link" },
  });
  setInviteCookie(c, container, hashInvitationToken(token));
  return c.html(renderInvitePage({ ...page, state: "sent" }));
});

/** Drops a carried invitation (after "that invitation was sent to a different address") so the person can sign in as themselves. */
authRoutes.post("/invite/forget", async (c) => {
  clearInviteCookie(c, c.get("container"));
  return c.json({ ok: true });
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
  // Active memberships only: a removed person's former company is not theirs to see or switch to.
  const ms = await container.db
    .select({ companyId: memberships.companyId, role: memberships.role, name: companies.name, slug: companies.slug })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(and(eq(memberships.userId, s.user.id), eq(memberships.status, "active")));
  const body: MeResponse = {
    user: { id: s.user.id, email: s.user.email, name: s.user.name, platformRole: s.user.platformRole },
    auth: { provider: s.identityProvider, aal: s.aal, mfaVerifiedAt: s.mfaVerifiedAt },
    memberships: ms.map((m) => ({ companyId: m.companyId, companyName: m.name, companySlug: m.slug, role: m.role as MembershipRole })),
    activeCompanyId: c.get("tenant")?.companyId ?? null,
    staffAccess: c.get("tenant")?.staff ? { ...c.get("tenant")!.staff!, companyName: (await container.db.select({ name: companies.name }).from(companies).where(eq(companies.id, c.get("tenant")!.companyId)).limit(1))[0]?.name ?? null } : null,
    ai: { provider: container.ai.provider.id },
  };
  return c.json(body);
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

import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { assertCan, connectCalendar, disconnectCalendar, disconnectIntegration, escapeHtml, openPayload, publicConnection, sealPayload } from "@ros/core";
import { CalendarError, FakeGoogleCalendarProvider, base64url } from "@ros/integrations";
import { integrations, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";

/**
 * A company's external connections. Nothing here ever returns a credential or its reference. Disconnecting disables
 * the connection at once and queues revocation and deletion for the worker; the row shows `credentialsDeleted` so the
 * customer can see when the credential is gone.
 */
export const integrationRoutes = new Hono<Vars>();

integrationRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(integrations).where(eq(integrations.companyId, t.companyId)).orderBy(desc(integrations.createdAt)));
  return c.json(rows.map(publicConnection));
});

const Disconnect = z.object({ reason: z.string().min(1).max(500).default("disconnected by the customer") });

integrationRoutes.post("/:id/disconnect", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "integration.manage");
  const body = Disconnect.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    try {
      return await disconnectIntegration(tx, { integrationId: c.req.param("id"), companyId: t.companyId, reason: body.reason, actor: actorOf(c), now: container.engine.clock() });
    } catch (err) {
      if (err instanceof Error && err.message === "connection not found") throw new HttpError(404, "not_found", "Connection not found.");
      throw err;
    }
  });
  await container.kick();
  const [fresh] = await withTenant(container.db, t.companyId, (tx) => tx.select().from(integrations).where(eq(integrations.id, result.row.id)).limit(1));
  return c.json({ ...publicConnection(fresh ?? result.row), deletionQueued: result.queued });
});

/**
 * Calendar connections. The consent flow starts and ends on the API; the refresh token goes straight into the managed
 * secret store and only its reference is kept. The fake provider serves a development consent page so the whole flow
 * runs without a Google project.
 *
 * The verifier and the expected state ride in a sealed cookie the browser cannot read or alter. The company and the
 * person the connection belongs to are never taken from the cookie: they come from the signed-in session at callback
 * time, and the cookie's copy must agree with it, so nobody can write a connection into another company.
 */
const CAL_COOKIE = "ros_cal_pkce";
const CAL_COOKIE_TTL_MS = 10 * 60_000;
type CalendarConsent = { v: 1; verifier: string; state: string; provider: string; companyId: string; userId: string; exp: number };

function calendarCookieOptions(container: { env: { NODE_ENV: string; raw: Record<string, string | undefined> } }) {
  return { httpOnly: true, sameSite: "Lax" as const, secure: container.env.NODE_ENV === "production", path: "/", maxAge: CAL_COOKIE_TTL_MS / 1000, ...(container.env.raw.COOKIE_DOMAIN ? { domain: container.env.raw.COOKIE_DOMAIN } : {}) };
}

integrationRoutes.get("/calendar/:provider/connect", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const provider = container.integrations.calendars[c.req.param("provider")];
  if (!provider) throw new HttpError(404, "unknown_provider", "That calendar provider is not offered.");
  if (provider.status === "not_connected") throw new HttpError(503, "not_configured", "Calendar connections are not configured for this deployment yet.");
  const verifier = base64url.encode(randomBytes(32));
  const state = base64url.encode(randomBytes(16));
  const consent: CalendarConsent = { v: 1, verifier, state, provider: provider.provider, companyId: t.companyId, userId: t.userId, exp: container.engine.clock().getTime() + CAL_COOKIE_TTL_MS };
  setCookie(c, CAL_COOKIE, sealPayload("calendar-consent", consent, container.env.SESSION_SECRET), calendarCookieOptions(container));
  const redirectTo = `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/${provider.provider}/callback`;
  const codeChallenge = base64url.encode(createHash("sha256").update(verifier).digest());
  const s = c.get("session")!;
  return c.redirect(provider.authorizeUrl({ redirectTo, state, codeChallenge, loginHint: s.user.email }), 302);
});

integrationRoutes.get("/calendar/:provider/callback", async (c) => {
  const container = c.get("container");
  const back = (q: string) => { deleteCookie(c, CAL_COOKIE, { path: "/" }); return c.redirect(`${container.env.APP_BASE_URL}/setup?calendar=${encodeURIComponent(q)}`, 302); };
  const consent = openPayload<CalendarConsent>("calendar-consent", getCookie(c, CAL_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (consent?.v !== 1 || !code) return back("incomplete");
  // The state is mandatory and must be the one this browser was given.
  if (!state || state !== consent.state) return back("incomplete");
  // The connection belongs to the signed-in person's current company, never to whatever a cookie names.
  const s = c.get("session");
  const t = c.get("tenant");
  if (!s || !t || s.user.id !== consent.userId || t.userId !== consent.userId || t.companyId !== consent.companyId) return back("incomplete");
  if (c.req.param("provider") !== consent.provider) return back("incomplete");
  const provider = container.integrations.calendars[consent.provider];
  if (!provider) return back("incomplete");
  try {
    const redirectTo = `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/${provider.provider}/callback`;
    const { refreshToken, account, scopes } = await provider.exchangeCode({ code, redirectTo, codeVerifier: consent.verifier });
    await withTenant(container.db, t.companyId, (tx) => connectCalendar(tx, container.integrations.secrets, { companyId: t.companyId, userId: t.userId, provider: provider.provider, refreshToken, account, scopes, actor: { kind: "user", id: t.userId, name: s.user.name ?? s.user.email } }));
    return back("connected");
  } catch (err) {
    if (err instanceof CalendarError) return back(err.code);
    throw err;
  }
});

integrationRoutes.post("/calendar/:provider/disconnect", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const body = Disconnect.parse(await c.req.json().catch(() => ({})));
  const result = await withTenant(container.db, t.companyId, (tx) => disconnectCalendar(tx, { companyId: t.companyId, userId: t.userId, reason: body.reason, actor: actorOf(c), now: container.engine.clock() }));
  if (!result) throw new HttpError(404, "not_found", "No calendar is connected.");
  await container.kick();
  return c.json({ ok: true, status: result.row.status, deletionQueued: result.queued });
});

/** Development only: the fake provider's consent page. */
integrationRoutes.get("/calendar/fake/authorize", async (c) => {
  const container = c.get("container");
  const provider = container.integrations.calendars.google;
  if (container.env.NODE_ENV === "production" || !(provider instanceof FakeGoogleCalendarProvider)) return c.notFound();
  const q = c.req.query();
  const esc = escapeHtml;
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fake Google Calendar consent (development)</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:8vh auto;padding:0 16px;color:#1b1b1b}label{display:block;margin:12px 0 4px}input,select{width:100%;padding:8px;border:1px solid #bbb;border-radius:6px}button{margin-top:16px;padding:10px 16px;border-radius:6px;border:0;background:#1f4b99;color:#fff;font-size:15px}.note{background:#fff4d6;padding:10px;border-radius:6px;font-size:14px}</style></head>
<body><h1>Allow calendar access (fake)</h1><p class="note">Development only. Stands in for Google's consent screen; nothing is real.</p>
<p>Recruiting OS asks for: events on your calendar and free/busy times. Nothing wider.</p>
<form method="post" action="/api/v1/integrations/calendar/fake/authorize">
<input type="hidden" name="redirect_to" value="${esc(q.redirect_to ?? "")}"><input type="hidden" name="state" value="${esc(q.state ?? "")}"><input type="hidden" name="code_challenge" value="${esc(q.code_challenge ?? "")}">
<label for="email">Google account email</label><input id="email" name="email" type="email" required value="${esc(q.login_hint ?? "")}">
<label for="tz">Calendar time zone</label><select id="tz" name="timezone"><option>America/Los_Angeles</option><option>America/Denver</option><option>America/Chicago</option><option>America/New_York</option></select>
<button type="submit">Allow</button></form></body></html>`);
});

integrationRoutes.post("/calendar/fake/authorize", async (c) => {
  const container = c.get("container");
  const provider = container.integrations.calendars.google;
  if (container.env.NODE_ENV === "production" || !(provider instanceof FakeGoogleCalendarProvider)) return c.notFound();
  const form = await c.req.parseBody();
  const str = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : "");
  const code = provider.issueCode({ email: str("email"), timeZone: str("timezone") || "America/Los_Angeles", codeChallenge: str("code_challenge") || undefined });
  const target = new URL(str("redirect_to") || `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/google/callback`);
  target.searchParams.set("code", code);
  if (str("state")) target.searchParams.set("state", str("state"));
  return c.redirect(target.toString(), 302);
});

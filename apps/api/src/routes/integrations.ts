import { Hono } from "hono";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { assertCan, connectCalendar, disconnectCalendar, disconnectIntegration, publicConnection } from "@ros/core";
import { CalendarError, FakeGoogleCalendarProvider, base64url } from "@ros/integrations";
import { integrations, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";

/**
 * A company's external connections (correction 10). Nothing here ever returns a credential or its reference.
 * Disconnecting disables the connection at once and queues revocation and deletion for the worker; the row shows
 * `credentialsDeleted` so the customer can see when the credential is gone.
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
 * Calendar connections (D2; correction 3: Google first). The consent flow starts and ends on the API; the refresh token
 * goes straight into the managed secret store and only its reference is kept. The fake provider serves a development
 * consent page so the whole flow runs without a Google project.
 */
const CAL_COOKIE = "ros_cal_pkce";
function calendarCookieOptions(container: { env: { NODE_ENV: string; raw: Record<string, string | undefined> } }) {
  return { httpOnly: true, sameSite: "Lax" as const, secure: container.env.NODE_ENV === "production", path: "/", maxAge: 600, ...(container.env.raw.COOKIE_DOMAIN ? { domain: container.env.raw.COOKIE_DOMAIN } : {}) };
}

integrationRoutes.get("/calendar/:provider/connect", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const provider = container.integrations.calendars[c.req.param("provider")];
  if (!provider) throw new HttpError(404, "unknown_provider", "That calendar provider is not offered.");
  if (provider.status === "not_connected") throw new HttpError(503, "not_configured", "Calendar connections are not configured for this deployment yet.");
  const verifier = base64url.encode(randomBytes(32));
  const state = base64url.encode(randomBytes(16));
  setCookie(c, CAL_COOKIE, `${verifier}.${state}.${provider.provider}.${t.companyId}.${t.userId}`, calendarCookieOptions(container));
  const redirectTo = `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/${provider.provider}/callback`;
  const codeChallenge = base64url.encode(createHash("sha256").update(verifier).digest());
  const s = c.get("session")!;
  return c.redirect(provider.authorizeUrl({ redirectTo, state, codeChallenge, loginHint: s.user.email }), 302);
});

integrationRoutes.get("/calendar/:provider/callback", async (c) => {
  const container = c.get("container");
  const back = (q: string) => { deleteCookie(c, CAL_COOKIE, { path: "/" }); return c.redirect(`${container.env.WEB_BASE_URL}/setup?calendar=${encodeURIComponent(q)}`, 302); };
  const cookie = getCookie(c, CAL_COOKIE);
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!cookie || !code) return back("incomplete");
  const [verifier, expectedState, providerKey, companyId, userId] = cookie.split(".");
  if (state && state !== expectedState) return back("incomplete");
  const s = c.get("session");
  if (!s || s.user.id !== userId) return back("incomplete");
  const provider = container.integrations.calendars[providerKey];
  if (!provider) return back("incomplete");
  try {
    const redirectTo = `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/${provider.provider}/callback`;
    const { refreshToken, account, scopes } = await provider.exchangeCode({ code, redirectTo, codeVerifier: verifier });
    await withTenant(container.db, companyId, (tx) => connectCalendar(tx, container.integrations.secrets, { companyId, userId, provider: provider.provider, refreshToken, account, scopes, actor: { kind: "user", id: userId, name: s.user.name ?? s.user.email } }));
    return back("connected");
  } catch (err) {
    if (err instanceof CalendarError) return back(err.code);
    throw err;
  }
});

integrationRoutes.post("/calendar/:provider/disconnect", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const result = await withTenant(container.db, t.companyId, (tx) => disconnectCalendar(tx, { companyId: t.companyId, userId: t.userId, reason: body.reason ?? "disconnected by the person", actor: actorOf(c), now: container.engine.clock() }));
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
  const esc = (x: string) => x.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
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

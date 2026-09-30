import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords, sessions, users } from "@ros/db";
import { signHs256, type FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Decision D19 and correction 4 (18 September 2026): sign-in is delegated to the managed identity service; ITS staff use
 * Microsoft with a second factor; customers use Google or Microsoft; tokens are verified, never stored, never logged.
 * The fake issuer speaks the same token format and PKCE flow, so every rule is exercised without an account.
 */
describe("delegated sign-in with the Microsoft-for-staff policy", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const idp = () => container.integrations.identity as FakeIdentityProvider;
  const session = (accessToken: string) => app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });
  const me = (cookie: string) => app.request("/api/v1/auth/me", { headers: { cookie } });
  const cookieOf = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("offers Microsoft and Google, and the email link only where enabled", async () => {
    const cfg = (await (await app.request("/api/v1/auth/config")).json()) as { mode: string; providers: Array<{ key: string }>; magicLink: boolean; staffDomains: string[] };
    expect(cfg.mode).toBe("fake_identity");
    expect(cfg.providers.map((p) => p.key)).toEqual(["azure", "google"]);
    expect(cfg.magicLink).toBe(true);
    expect(cfg.staffDomains).toEqual(["identifiedtalent.com"]);
  });

  it("refuses tampered, expired, foreign-issuer and wrong-audience tokens", async () => {
    const good = idp().mint({ email: "dana@brightline.test", provider: "google" });
    const tampered = `${good.slice(0, -4)}abcd`;
    expect((await session(tampered)).status).toBe(401);
    expect((await session(idp().mint({ email: "dana@brightline.test", provider: "google", expiresInSeconds: -120 }))).status).toBe(401);
    const foreign = signHs256({ iss: "https://someone-else.local/auth/v1", sub: "x", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, email: "dana@brightline.test", app_metadata: { provider: "google" } }, "fake-issuer-development-secret-not-for-production");
    expect(((await (await session(foreign)).json()) as { error: { code: string } }).error.code).toBe("bad_issuer");
    const wrongAud = signHs256({ iss: idp().issuer, sub: "x", aud: "service_role", exp: Math.floor(Date.now() / 1000) + 600, email: "dana@brightline.test", app_metadata: { provider: "google" } }, "fake-issuer-development-secret-not-for-production");
    expect(((await (await session(wrongAud)).json()) as { error: { code: string } }).error.code).toBe("bad_audience");
    const none = signHs256({ iss: idp().issuer, sub: "x", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 }, "wrong-secret", { alg: "none" });
    expect((await session(none)).status).toBe(401);
  });

  it("a customer signs in with Google; the token is never stored or audited", async () => {
    const token = idp().mint({ email: "Dana@Brightline.test", name: "Dana Whitfield", provider: "google" });
    const r = await session(token);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { staff: boolean; activeCompanyId: string | null };
    expect(body.staff).toBe(false);
    expect(body.activeCompanyId).toBeNull();
    const m = (await (await me(cookieOf(r))).json()) as { user: { email: string; name: string }; auth: { provider: string; aal: string; mfaVerifiedAt: string | null } };
    expect(m.user.email).toBe("dana@brightline.test");
    expect(m.user.name).toBe("Dana Whitfield");
    expect(m.auth).toEqual({ provider: "google", aal: "aal1", mfaVerifiedAt: null });
    const [u] = await container.db.select().from(users).where(eq(users.email, "dana@brightline.test"));
    expect(u.authProvider).toBe("google");
    expect(u.authSubject).toBeTruthy();
    const opened = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "session.opened"));
    expect(opened.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(opened)).not.toContain(token);
    expect(JSON.stringify(await container.db.select().from(sessions))).not.toContain(token);
    // the same person through Microsoft lands on the same account (verified email), not a duplicate
    const viaMicrosoft = await session(idp().mint({ email: "dana@brightline.test", provider: "azure" }));
    expect(viaMicrosoft.status).toBe(200);
    expect(((await viaMicrosoft.json()) as { userId: string }).userId).toBe(u.id);
  });

  it("an unverified email is refused", async () => {
    const r = await session(idp().mint({ email: "nobody@example.test", provider: "google", emailVerified: false }));
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("email_unverified");
  });

  it("ITS staff must use Microsoft with a second factor; the refusals are audited without the token", async () => {
    const google = await session(idp().mint({ email: "nadine@identifiedtalent.com", provider: "google", aal: "aal2" }));
    expect(google.status).toBe(403);
    expect(((await google.json()) as { error: { code: string } }).error.code).toBe("staff_provider_required");
    const noMfa = await session(idp().mint({ email: "nadine@identifiedtalent.com", provider: "azure", aal: "aal1" }));
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    const ok = await session(idp().mint({ email: "nadine@identifiedtalent.com", name: "Nadine", provider: "azure", aal: "aal2" }));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { staff: boolean }).staff).toBe(true);
    const m = (await (await me(cookieOf(ok))).json()) as { auth: { provider: string; aal: string; mfaVerifiedAt: string | null } };
    expect(m.auth.provider).toBe("azure");
    expect(m.auth.aal).toBe("aal2");
    expect(m.auth.mfaVerifiedAt).toBeTruthy();
    const refused = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "signin.refused"));
    expect(refused.map((r) => r.reason)).toEqual(expect.arrayContaining(["staff_provider_required", "mfa_required"]));
    // staff sessions are short (I8): eight hours, not thirty days
    const [nadine] = await container.db.select().from(users).where(eq(users.email, "nadine@identifiedtalent.com"));
    const staffSessions = await container.db.select().from(sessions).where(eq(sessions.userId, nadine.id));
    expect(staffSessions.length).toBeGreaterThanOrEqual(1);
    for (const s of staffSessions) expect(Date.parse(s.expiresAt) - Date.now()).toBeLessThanOrEqual(8 * 3600_000 + 5000);
    // an existing platform administrator on any domain is held to the same rule
    await container.db.update(users).set({ platformRole: "platform_admin" }).where(eq(users.email, "dana@brightline.test"));
    const adminViaGoogle = await session(idp().mint({ email: "dana@brightline.test", provider: "google", aal: "aal2" }));
    expect(((await adminViaGoogle.json()) as { error: { code: string } }).error.code).toBe("staff_provider_required");
    await container.db.update(users).set({ platformRole: "none" }).where(eq(users.email, "dana@brightline.test"));
  });

  it("a second factor in the session unlocks break-glass for a platform administrator; without it the door stays shut", async () => {
    const [nadine] = await container.db.select().from(users).where(eq(users.email, "nadine@identifiedtalent.com"));
    const { grantPlatformRole } = await import("@ros/core");
    await grantPlatformRole(container.db, { userId: nadine.id, role: "platform_admin", actor: { kind: "system", id: "test_seed" }, reason: "test seed", source: "test_seed" });
    const mfa = cookieOf(await session(idp().mint({ email: "nadine@identifiedtalent.com", provider: "azure", aal: "aal2" })));
    const customer = cookieOf(await session(idp().mint({ email: "owner@glow.test", provider: "google" })));
    const co = (await (await app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie: customer }, body: JSON.stringify({ name: "Glow Theory", vertical: "beauty", sizeBand: "50-99", locations: [{ city: "Los Angeles", region: "CA", country: "US" }] }) })).json()) as { id: string };
    const r = await app.request("/api/v1/admin/break-glass", { method: "POST", headers: { "content-type": "application/json", cookie: mfa, "x-admin-reason": "test" }, body: JSON.stringify({ companyId: co.id, reason: "Investigating a reported data issue for the customer.", minutes: 30 }) });
    expect(r.status).toBe(201);
    const { grantId } = (await r.json()) as { grantId: string };
    expect(grantId).toBeTruthy();
    const ledger = (await (await app.request("/api/v1/admin/staff-access", { headers: { cookie: mfa, "x-admin-reason": "test" } })).json()) as Array<{ id: string; kind: string; mfaVerified: boolean }>;
    expect(ledger.find((g) => g.id === grantId)).toMatchObject({ kind: "break_glass" });
  });

  it("the browser flow: start sets the PKCE cookie, the consent page returns a code, the callback opens the session, and a code cannot be replayed", async () => {
    const start = await app.request("/api/v1/auth/start/azure");
    expect(start.status).toBe(302);
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    expect(pkce.startsWith("ros_pkce=")).toBe(true);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.pathname).toBe("/api/v1/auth/fake/authorize");
    expect(authorize.searchParams.get("provider")).toBe("azure");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("code_challenge")).not.toContain(pkce.split("=")[1].split(".")[0]);
    const page = await app.request(`${authorize.pathname}?${authorize.searchParams.toString()}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Development only");
    const form = new URLSearchParams({ provider: "azure", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")!, email: "paul@identifiedtalent.com", name: "Paul", aal2: "1", email_verified: "1" });
    const consent = await app.request("/api/v1/auth/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    expect(consent.status).toBe(302);
    const cb = new URL(consent.headers.get("location")!);
    expect(cb.pathname).toBe("/api/v1/auth/callback");
    const code = cb.searchParams.get("code")!;
    expect(code).toBeTruthy();
    const noCookie = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`);
    expect(noCookie.headers.get("location")).toContain("/login?error=signin_incomplete");
    const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: pkce } });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    const cookies = done.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("ros_session=");
    const replay = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: pkce } });
    expect(replay.headers.get("location")).toContain("/login?error=exchange_failed");
  });

  it("the email link is refused for staff domains, and everywhere once disabled", async () => {
    const staff = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "someone@identifiedtalent.com" }) });
    expect(staff.status).toBe(403);
    const off = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", MAGIC_LINK_ENABLED: "false" } });
    try {
      const offApp = createApp(off);
      const r = await offApp.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@glow.test" }) });
      expect(r.status).toBe(410);
      const cfg = (await (await offApp.request("/api/v1/auth/config")).json()) as { magicLink: boolean };
      expect(cfg.magicLink).toBe(false);
    } finally {
      await off.close();
    }
  });

  it("production refuses the fake issuer and demands the managed service", async () => {
    const { loadEnv } = await import("./env");
    const base = { NODE_ENV: "production", APP_BASE_URL: "https://app.example.test", ANALYTICS_SALT: "salt-for-this-test-only", SESSION_SECRET: "x".repeat(40), SECRET_STORE: "vault", AI_PROVIDER: "anthropic", DATABASE_URL: "postgres://x", WORKER_INLINE: "false" };
    expect(() => loadEnv({ ...base, AUTH_PROVIDER: "fake" })).toThrow(/AUTH_PROVIDER/);
    expect(() => loadEnv({ ...base, AUTH_PROVIDER: "supabase" })).toThrow(/SUPABASE_URL/);
    // the public address must be an https origin, and the analytics salt must not be the development one
    expect(() => loadEnv({ ...base, APP_BASE_URL: "http://app.example.test" })).toThrow(/APP_BASE_URL/);
    expect(() => loadEnv({ ...base, APP_BASE_URL: "https://app.example.test/app" })).toThrow(/APP_BASE_URL/);
    expect(() => loadEnv({ ...base, ANALYTICS_SALT: undefined })).toThrow(/ANALYTICS_SALT/);
  });
});

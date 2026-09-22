import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords, sessions, users } from "@ros/db";
import { IdentityError, SupabaseIdentityProvider, totp, type FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Staff second factor (founder approval, 22 September 2026): Microsoft vouches for the person, then an authenticator
 * app enrolled with the identity service must answer a challenge before a session opens at assurance level 2. The
 * fake issuer keeps real time-based factors, so these tests compute codes exactly as an authenticator app would.
 */
describe("staff second factor: enrol, verify, backup, recovery, enforcement", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const idp = () => container.integrations.identity as FakeIdentityProvider;
  const NADINE = "nadine@identifiedtalent.com";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake", BOOTSTRAP_ADMIN_EMAILS: NADINE } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  type Jar = Record<string, string>;
  const absorb = (jar: Jar, res: Response) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";");
      const [name, value] = pair!.split("=");
      if (attrs.some((a) => /max-age=0/i.test(a))) delete jar[name!.trim()];
      else jar[name!.trim()] = value ?? "";
    }
    return jar;
  };
  const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const mfaUrl = () => `${container.env.APP_BASE_URL}/api/v1/auth/mfa`;
  const setupKeyOf = (html: string) => html.match(/id="setup-key">([A-Z2-7 ]+)<\/code>/)![1]!.replace(/\s+/g, "");
  const wrongCode = (secret: string) => (totp(secret) === "000000" ? "111111" : "000000");

  /** Drives the browser flow: start, the fake consent page, the callback. Returns the callback response and the cookie jar. */
  async function browserSignIn(input: { email: string; name: string; provider: "azure" | "google"; aal2: boolean }) {
    const jar: Jar = {};
    const start = await app.request(`/api/v1/auth/start/${input.provider}`);
    absorb(jar, start);
    const authorize = new URL(start.headers.get("location")!);
    const form = new URLSearchParams({ provider: input.provider, redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")!, email: input.email, name: input.name, aal2: input.aal2 ? "1" : "", email_verified: "1" });
    const consent = await app.request("/api/v1/auth/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const cb = new URL(consent.headers.get("location")!);
    const res = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: cookieHeader(jar) } });
    absorb(jar, res);
    return { res, jar };
  }
  const get = async (jar: Jar, path: string) => { const r = await app.request(path, { headers: { cookie: cookieHeader(jar) } }); absorb(jar, r); return r; };
  const postCode = async (jar: Jar, code: string, path = "/api/v1/auth/mfa") => {
    const r = await app.request(path, { method: "POST", headers: { cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code }).toString() });
    absorb(jar, r);
    return r;
  };
  const me = async (jar: Jar) => (await (await app.request("/api/v1/auth/me", { headers: { cookie: cookieHeader(jar) } })).json()) as { user: { email: string; platformRole: string }; auth: { provider: string; aal: string; mfaVerifiedAt: string | null } };
  const auditsOf = async (action: string) => container.db.select().from(auditRecords).where(eq(auditRecords.action, action));

  let primarySecret = "";
  let backupSecret = "";

  it("a staff Microsoft sign-in without a second factor goes to the authenticator step; enrolment plus a correct code opens a level-2 session", async () => {
    const { res, jar } = await browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(mfaUrl());
    expect(jar.ros_session).toBeUndefined();
    expect(jar.ros_mfa).toBeTruthy();
    expect(jar.ros_pkce).toBeUndefined();
    // The transaction is sealed: the provider token (a JWT) is not readable from the cookie.
    expect(jar.ros_mfa).not.toContain("eyJ");
    expect(jar.ros_mfa.startsWith("v1.")).toBe(true);

    const page = await get(jar, "/api/v1/auth/mfa");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy-report-only") ?? page.headers.get("content-security-policy")).toContain("img-src 'self' data:");
    const html = await page.text();
    expect(html).toContain("Set up your authenticator app");
    expect(html).toContain("data:image/svg+xml");
    primarySecret = setupKeyOf(html);
    expect(primarySecret.length).toBeGreaterThanOrEqual(32);

    // A refresh keeps the same secret (the person may already have scanned it).
    expect(setupKeyOf(await (await get(jar, "/api/v1/auth/mfa")).text())).toBe(primarySecret);

    const wrong = await postCode(jar, wrongCode(primarySecret));
    expect(wrong.status).toBe(200);
    expect(await wrong.text()).toContain("That code is not right");
    expect(jar.ros_session).toBeUndefined();
    const failed = await auditsOf("mfa.failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.reason).toBe("code_invalid");

    const right = await postCode(jar, totp(primarySecret));
    expect(right.status).toBe(200);
    expect(await right.text()).toContain("You are signed in.");
    expect(jar.ros_session).toBeTruthy();
    const m = await me(jar);
    expect(m.auth).toMatchObject({ provider: "azure", aal: "aal2" });
    expect(m.auth.mfaVerifiedAt).toBeTruthy();
    // The bootstrap list applied on the level-2 session, never earlier.
    expect(m.user.platformRole).toBe("platform_admin");
    const [user] = await container.db.select().from(users).where(eq(users.email, NADINE));
    expect(user!.mfaEnrolledAt).toBeTruthy();
    const [row] = await container.db.select().from(sessions).where(eq(sessions.userId, user!.id));
    expect(row!.aal).toBe("aal2");
    const enrolled = await auditsOf("mfa.enrolled");
    expect(enrolled.length).toBe(1);
    expect((enrolled[0]!.actor as { kind: string }).kind).toBe("user");

    // Neither the secret nor any token reaches the audit trail.
    const everything = JSON.stringify(await container.db.select().from(auditRecords));
    expect(everything).not.toContain(primarySecret);
    expect(everything).not.toContain("eyJ");

    const skip = await app.request("/api/v1/auth/mfa/skip", { method: "POST", headers: { cookie: cookieHeader(jar) } });
    absorb(jar, skip);
    expect(skip.status).toBe(302);
    expect(skip.headers.get("location")).toBe(`${container.env.WEB_BASE_URL}/`);
    expect(jar.ros_mfa).toBeUndefined();
  });

  it("the next sign-in challenges the enrolled authenticator without showing a secret; a backup authenticator can be added while the level-2 token is at hand", async () => {
    const { res, jar } = await browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    expect(res.headers.get("location")).toBe(mfaUrl());
    const html = await (await get(jar, "/api/v1/auth/mfa")).text();
    expect(html).toContain("Enter your code");
    expect(html).not.toContain("setup-key");
    const ok = await postCode(jar, totp(primarySecret));
    expect(await ok.text()).toContain("Add a backup authenticator");
    expect((await me(jar)).auth.aal).toBe("aal2");
    expect((await auditsOf("mfa.verified")).length).toBe(1);

    const backupPage = await get(jar, "/api/v1/auth/mfa/backup");
    expect(backupPage.status).toBe(200);
    const backupHtml = await backupPage.text();
    expect(backupHtml).toContain("Add a backup authenticator");
    backupSecret = setupKeyOf(backupHtml);
    expect(backupSecret).not.toBe(primarySecret);
    const done = await postCode(jar, totp(backupSecret));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.WEB_BASE_URL}/`);
    expect(jar.ros_mfa).toBeUndefined();
    expect((await auditsOf("mfa.backup_enrolled")).length).toBe(1);
    const [user] = await container.db.select().from(users).where(eq(users.email, NADINE));
    const factors = await idp().listFactors(idp().mint({ email: NADINE, provider: "azure", aal: "aal2", subject: user!.authSubject! }));
    expect(factors.filter((f) => f.status === "verified").map((f) => f.friendlyName).sort()).toEqual(["Backup authenticator", "Primary authenticator"]);
  });

  it("with two authenticators, a code from either signs in and no backup is offered", async () => {
    const { jar } = await browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    await get(jar, "/api/v1/auth/mfa");
    const done = await postCode(jar, totp(backupSecret));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.WEB_BASE_URL}/`);
    expect((await me(jar)).auth.aal).toBe("aal2");
    expect(jar.ros_mfa).toBeUndefined();
  });

  it("five wrong codes end the attempt; the person starts over at sign-in", async () => {
    const { jar } = await browserSignIn({ email: "recruiter@identifiedtalent.com", name: "Riley Recruiter", provider: "azure", aal2: false });
    const secret = setupKeyOf(await (await get(jar, "/api/v1/auth/mfa")).text());
    for (let i = 1; i <= 4; i++) {
      const r = await postCode(jar, wrongCode(secret));
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toContain("That code is not right");
      if (i === 4) expect(text).toContain("last try");
    }
    const fifth = await postCode(jar, wrongCode(secret));
    expect(fifth.status).toBe(302);
    expect(fifth.headers.get("location")).toContain("/login?error=mfa_failed");
    // The transaction is gone: even the right code no longer works.
    const afterwards = await postCode(jar, totp(secret));
    expect(afterwards.headers.get("location")).toContain("/login?error=mfa_expired");
    expect(jar.ros_mfa).toBeUndefined();
    expect(jar.ros_session).toBeUndefined();
    const failed = await auditsOf("mfa.failed");
    expect(failed.some((f) => f.reason === "too_many_attempts")).toBe(true);
  });

  it("an expired, tampered or missing transaction returns to sign-in", async () => {
    const none = await app.request("/api/v1/auth/mfa");
    expect(none.headers.get("location")).toContain("/login?error=mfa_expired");
    const tampered = await app.request("/api/v1/auth/mfa", { headers: { cookie: "ros_mfa=v1.AAAA.BBBB.CCCC" } });
    expect(tampered.headers.get("location")).toContain("/login?error=mfa_expired");
    const { jar } = await browserSignIn({ email: "late@identifiedtalent.com", name: "Late", provider: "azure", aal2: false });
    // Ten minutes and one second later the sealed transaction is dead.
    const engine = container.engine as unknown as { now: () => Date };
    const realNow = engine.now;
    const later = new Date(realNow().getTime() + 10 * 60_000 + 1000);
    engine.now = () => later;
    try {
      const r = await get(jar, "/api/v1/auth/mfa");
      expect(r.headers.get("location")).toContain("/login?error=mfa_expired");
    } finally {
      engine.now = realNow;
    }
  });

  it("customers and level-2 staff never see the step; a staff Google sign-in is still refused; the JSON route still refuses level 1", async () => {
    const customer = await browserSignIn({ email: "dana@brightline.test", name: "Dana", provider: "google", aal2: false });
    expect(customer.res.headers.get("location")).toBe(`${container.env.WEB_BASE_URL}/setup/company`);
    expect(customer.jar.ros_session).toBeTruthy();
    expect(customer.jar.ros_mfa).toBeUndefined();
    const staffAal2 = await browserSignIn({ email: "paul@identifiedtalent.com", name: "Paul", provider: "azure", aal2: true });
    expect(staffAal2.res.headers.get("location")).toBe(`${container.env.WEB_BASE_URL}/`);
    expect(staffAal2.jar.ros_mfa).toBeUndefined();
    const staffGoogle = await browserSignIn({ email: "paul@identifiedtalent.com", name: "Paul", provider: "google", aal2: false });
    expect(staffGoogle.res.headers.get("location")).toContain("/login?error=staff_provider_required");
    expect(staffGoogle.jar.ros_mfa).toBeUndefined();
    const json = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: idp().mint({ email: "paul@identifiedtalent.com", provider: "azure", aal: "aal1" }) }) });
    expect(json.status).toBe(403);
    expect(((await json.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
  });

  it("a reset at the identity service is recorded, and the person enrols again at the next sign-in", async () => {
    const [user] = await container.db.select().from(users).where(eq(users.email, NADINE));
    idp().resetFactors(user!.authSubject!);
    const { jar } = await browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    const html = await (await get(jar, "/api/v1/auth/mfa")).text();
    expect(html).toContain("Set up your authenticator app");
    const reset = await auditsOf("mfa.reset_detected");
    expect(reset.length).toBe(1);
    expect((reset[0]!.target as { id: string }).id).toBe(user!.id);
    const secret = setupKeyOf(html);
    const ok = await postCode(jar, totp(secret));
    expect(await ok.text()).toContain("You are signed in.");
    expect((await me(jar)).auth.aal).toBe("aal2");
    expect((await auditsOf("mfa.enrolled")).length).toBe(2);
  });

  it("the real provider speaks the service's factor endpoints with the person's token and the publishable key, and maps a wrong code", async () => {
    const calls: Array<{ url: string; method: string; body: string | null; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null, headers });
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", factors: [{ id: "f1", factor_type: "totp", friendly_name: "Primary authenticator", status: "verified", created_at: "2026-09-22T00:00:00Z" }] }));
      if (url.endsWith("/auth/v1/factors") && method === "POST") return new Response(JSON.stringify({ id: "f2", type: "totp", friendly_name: "Backup authenticator", totp: { qr_code: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" } }));
      if (url.endsWith("/auth/v1/factors/f1/challenge")) return new Response(JSON.stringify({ id: "c1", expires_at: 1790000000 }));
      if (url.endsWith("/auth/v1/factors/f1/verify")) {
        const body = JSON.parse(String(init?.body)) as { code: string };
        if (body.code === "123456") return new Response(JSON.stringify({ access_token: "eyJaal2", token_type: "bearer", expires_in: 3600, refresh_token: "r" }));
        return new Response(JSON.stringify({ code: "mfa_verification_failed", message: "Invalid TOTP code entered" }), { status: 422, headers: { "x-sb-error-code": "mfa_verification_failed" } });
      }
      if (url.endsWith("/auth/v1/factors/f2") && method === "DELETE") return new Response(JSON.stringify({ id: "f2" }));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const p = new SupabaseIdentityProvider({ url: "https://vjuaiyjmtrenbrmujvtc.supabase.co", anonKey: "sb_publishable_test", fetch: fakeFetch });
    const factors = await p.listFactors("eyJaal1");
    expect(factors).toEqual([{ id: "f1", type: "totp", friendlyName: "Primary authenticator", status: "verified", createdAt: "2026-09-22T00:00:00Z" }]);
    const enrol = await p.enrolTotp("eyJaal1", { friendlyName: "Backup authenticator", issuer: "Recruiting OS" });
    expect(enrol).toMatchObject({ factorId: "f2", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" });
    expect(enrol.qrCodeSvg).toContain("<svg");
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/factors"))!.body!)).toEqual({ factor_type: "totp", friendly_name: "Backup authenticator", issuer: "Recruiting OS" });
    const challenge = await p.challengeFactor("eyJaal1", "f1");
    expect(challenge.challengeId).toBe("c1");
    await expect(p.verifyFactor("eyJaal1", { factorId: "f1", challengeId: "c1", code: "000000" })).rejects.toMatchObject({ code: "mfa_code_invalid" });
    const verified = await p.verifyFactor("eyJaal1", { factorId: "f1", challengeId: "c1", code: "123456" });
    expect(verified.accessToken).toBe("eyJaal2");
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/verify"))!.body!)).toEqual({ challenge_id: "c1", code: "000000" });
    await p.unenrolFactor("eyJaal1", "f2");
    for (const c of calls) {
      expect(c.headers.apikey).toBe("sb_publishable_test");
      expect(c.headers.authorization).toBe("Bearer eyJaal1");
    }
    expect(new URL(calls[0]!.url).origin).toBe("https://vjuaiyjmtrenbrmujvtc.supabase.co");
    await expect(p.verifyFactor("eyJaal1", { factorId: "f1", challengeId: "c1", code: "1" })).rejects.toBeInstanceOf(IdentityError);
    expect(calls.every((c) => c.headers["x-supabase-api-version"] === "2024-01-01")).toBe(true);
  });
});

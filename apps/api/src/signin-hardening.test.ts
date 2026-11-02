import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords, users } from "@ros/db";
import { signHs256, totp, type FakeIdentityProvider, type FakeMintInput } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { sessionCookieName } from "./cookie-names";

/**
 * Sign-in before the first production launch (audit SEC-8 and SEC-25, known bug row 41). A session opens only through
 * a provider the deployment offers and only for a usable address, every refusal audited. The identity service names an
 * account's FIRST provider and links accounts across providers by email, so the provider of a browser sign-in is the one
 * the browser started with when the account holds it, and a start it does not hold is refused. That start rides in an
 * unsealed cookie, so a staff account must hold Microsoft and nothing else: otherwise whoever controls a staff mailbox
 * could link a Google sign-in to it and present that as Microsoft. The JSON sign-in route,
 * which only tests use, is not there in a production build. Over https every cookie carries the browser's prefix and
 * nothing reads the old names. `prod` is the same database and fake issuer behind an app built as production builds it.
 */
type App = ReturnType<typeof createApp>;
type Jar = Record<string, string>;
type Flow = { res: Response; jar: Jar; challenge: string; state: string };

const FAKE_SECRET = "fake-issuer-development-secret-not-for-production";
/** Keeps what a browser keeps: each Set-Cookie by name, and a Max-Age=0 one removes it. */
const absorb = (jar: Jar, res: Response) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const at = pair!.indexOf("=");
    const name = pair!.slice(0, at).trim();
    if (attrs.some((a) => /max-age=0/i.test(a))) delete jar[name];
    else jar[name] = pair!.slice(at + 1);
  }
  return jar;
};
const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

describe("sign-in hardening (audit SEC-8, SEC-25; known bug row 41)", () => {
  let container: Container;
  let app: App;
  let prod: App;
  const idp = () => container.integrations.identity as FakeIdentityProvider;
  const session = (a: App, accessToken: string) => a.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken }) });
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
  const refusals = async (reason: string) => (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "signin.refused"))).filter((r) => r.reason === reason).map((r) => r.details as { email?: string; provider?: string; providers?: string[]; startedProvider?: string | null });
  const usersNamed = (email: string) => container.db.select().from(users).where(eq(users.email, email));
  const me = (a: App, jar: Jar) => a.request("/api/v1/auth/me", { headers: { cookie: cookieHeader(jar) } });
  /** A token in the issuer's own format with claims its minting never makes: a phone account, an address that is not one. */
  const tokenWith = (claims: Record<string, unknown>) => {
    const now = Math.floor(Date.now() / 1000);
    return signHs256({ iss: idp().issuer, aud: "authenticated", role: "authenticated", iat: now, exp: now + 600, user_metadata: { email_verified: true }, ...claims }, FAKE_SECRET);
  };
  /** The browser presses "Continue with <provider>": the PKCE cookie is set and the browser goes to the identity service. */
  const start = async (a: App, provider: string): Promise<Flow> => {
    const res = await a.request(`/api/v1/auth/start/${provider}`);
    const authorize = new URL(res.headers.get("location")!);
    return { res, jar: absorb({}, res), challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")! };
  };
  /** The service's return: a code for whoever signed in there (bound to the challenge), brought back with this browser's cookies. */
  const callback = async (a: App, flow: Flow, signIn: FakeMintInput) => {
    const code = idp().issueCode({ ...signIn, codeChallenge: flow.challenge });
    const res = await a.request(`/api/v1/auth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`, { headers: { cookie: cookieHeader(flow.jar) } });
    absorb(flow.jar, res);
    return res;
  };
  const login = (code: string) => `${container.env.APP_BASE_URL}/login?error=${code}`;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    prod = createApp({ ...container, env: { ...container.env, NODE_ENV: "production" } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("opens a session only through a provider the deployment offers, through the JSON route and the browser alike, and audits each refusal", async () => {
    const otp = await session(app, idp().mint({ email: "otp.person@brightline.test", provider: "email" }));
    expect(otp.status).toBe(403);
    expect(await errorOf(otp)).toEqual({ code: "provider_not_allowed", message: "Sign in with Microsoft or Google." });
    const phone = await session(app, tokenWith({ sub: "phone-subject", email: "", phone: "15551234567", app_metadata: { provider: "phone", providers: ["phone"] } }));
    expect(phone.status).toBe(403);
    expect((await errorOf(phone)).code).toBe("provider_not_allowed");
    // The PKCE cookie is not sealed, so a browser can rename the method it started with and sign in at the service with
    // that one: the callback still refuses it.
    const renamed = await start(app, "google");
    renamed.jar.ros_pkce = renamed.jar.ros_pkce!.replace(/\.google$/, ".email");
    expect((await callback(app, renamed, { email: "otp.person@brightline.test", provider: "email" })).headers.get("location")).toBe(login("provider_not_allowed"));
    expect(renamed.jar.ros_session).toBeUndefined();
    // The list is the one the sign-in page offers: a deployment offering Microsoft only (AUTH_SIGNIN_PROVIDERS=azure) refuses Google.
    const offered = vi.spyOn(idp(), "providers").mockReturnValue([{ key: "azure", label: "Microsoft" }]);
    try {
      expect((await errorOf(await session(app, idp().mint({ email: "gia@brightline.test", provider: "google" })))).code).toBe("provider_not_allowed");
      expect((await session(app, idp().mint({ email: "gia@brightline.test", provider: "azure" }))).status).toBe(200);
    } finally {
      offered.mockRestore();
    }
    expect(await refusals("provider_not_allowed")).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "otp.person@brightline.test", provider: "email", startedProvider: null }),
      expect.objectContaining({ email: "", provider: "phone", providers: ["phone"] }),
      expect.objectContaining({ email: "otp.person@brightline.test", provider: "email", startedProvider: "email" }),
      expect.objectContaining({ email: "gia@brightline.test", provider: "google" }),
    ]));
    expect(await usersNamed("otp.person@brightline.test")).toEqual([]);
  });

  it("refuses an identity without a usable email address: nothing is matched, nothing is created", async () => {
    const before = (await container.db.select().from(users)).length;
    for (const [sub, email] of [["blank", ""], ["spaces", "   "], ["garbled", "not-an-address"]]) {
      const r = await session(app, tokenWith({ sub, email, app_metadata: { provider: "google", providers: ["google"] } }));
      expect(r.status, email).toBe(403);
      expect(await errorOf(r)).toEqual({ code: "email_invalid", message: "Your sign-in account has no usable email address. Sign in with Microsoft or Google." });
    }
    const browser = await start(app, "google");
    expect((await callback(app, browser, { email: "", provider: "google" })).headers.get("location")).toBe(login("email_invalid"));
    expect((await container.db.select().from(users)).length).toBe(before);
    expect(await usersNamed("")).toEqual([]);
    expect((await refusals("email_invalid")).length).toBeGreaterThanOrEqual(4);
  });

  it("takes the provider the browser started with when the account holds it, for the staff Microsoft rule and the account alike", async () => {
    // One first created with Microsoft, now through Google: refused, although the token names Microsoft first.
    const viaGoogle = await start(app, "google");
    expect((await callback(app, viaGoogle, { email: "mo@identifiedtalent.com", name: "Mo", provider: "google", providers: ["azure"], aal: "aal2" })).headers.get("location")).toBe(login("staff_provider_required"));
    expect(viaGoogle.jar.ros_session).toBeUndefined();
    // A customer's new account is recorded under the provider used, not the account's first.
    const customer = await start(app, "google");
    expect((await callback(app, customer, { email: "noor@brightline.test", provider: "google", providers: ["azure"] })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    expect((await usersNamed("noor@brightline.test"))[0]?.authProvider).toBe("google");
    expect(((await (await me(app, customer.jar)).json()) as { auth: { provider: string } }).auth.provider).toBe("google");
  });

  it("refuses a staff account that also holds another provider, whichever one the browser claims, before the authenticator step", async () => {
    // An ITS account first created with Google and linked to Microsoft by email: the token names Google first, and the
    // browser started with Microsoft. The started provider rides in an unsealed cookie, so it proves nothing on its own:
    // a staff account must hold Microsoft only, and ITS removes a stray link at the identity service.
    expect((await idp().verify(idp().mint({ email: "lin@identifiedtalent.com", provider: "azure", providers: ["google"] }))).provider).toBe("google");
    const viaMicrosoft = await start(app, "azure");
    expect((await callback(app, viaMicrosoft, { email: "lin@identifiedtalent.com", name: "Lin", provider: "azure", providers: ["google"], aal: "aal2" })).headers.get("location")).toBe(login("staff_provider_linked"));
    expect(viaMicrosoft.jar.ros_session).toBeUndefined();
    // Someone who controls a staff mailbox opens a Google account for it, which the service links to the staff account
    // by its address, signs in there with Google, and leaves the browser's cookie saying Microsoft. Refused at the
    // callback: the authenticator step never starts, so no factor of theirs is enrolled on the account.
    const claimed = await start(app, "azure");
    expect((await callback(app, claimed, { email: "ivy@identifiedtalent.com", name: "Ivy", provider: "google", providers: ["azure"], aal: "aal1" })).headers.get("location")).toBe(login("staff_provider_linked"));
    expect(claimed.jar.ros_mfa).toBeUndefined();
    expect(claimed.jar.ros_session).toBeUndefined();
    expect((await app.request("/api/v1/auth/mfa", { headers: { cookie: cookieHeader(claimed.jar) } })).headers.get("location")).toBe(login("mfa_expired"));
    expect(await refusals("staff_provider_linked")).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: "lin@identifiedtalent.com", provider: "azure" }),
      expect.objectContaining({ email: "ivy@identifiedtalent.com", provider: "azure" }),
    ]));
    // an ITS account that holds Microsoft only goes on to the authenticator step as before
    const alone = await start(app, "azure");
    expect((await callback(app, alone, { email: "ivo@identifiedtalent.com", name: "Ivo", provider: "azure", aal: "aal1" })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/api/v1/auth/mfa`);
    // a customer may hold both, and signs in with either
    const customer = await start(app, "azure");
    expect((await callback(app, customer, { email: "lane@brightline.test", provider: "azure", providers: ["google"] })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
  });

  it("refuses a sign-in that comes back from a provider the browser did not start with, audited", async () => {
    // Started with Microsoft, but the authorize address was changed to Google on the way.
    const tampered = await start(app, "azure");
    expect((await callback(app, tampered, { email: "pat@brightline.test", provider: "google" })).headers.get("location")).toBe(login("provider_mismatch"));
    expect(tampered.jar.ros_session).toBeUndefined();
    expect(tampered.jar.ros_pkce).toBeUndefined();
    expect((await refusals("provider_mismatch")).find((d) => d.email === "pat@brightline.test")).toMatchObject({ provider: "google", providers: ["google"], startedProvider: "azure" });
    expect(await usersNamed("pat@brightline.test")).toEqual([]);
    // The same through the fake issuer's own consent page, whose provider field the browser can change.
    const page = await start(app, "azure");
    const form = new URLSearchParams({ provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: page.challenge, state: page.state, email: "pat@brightline.test", name: "Pat", email_verified: "1" });
    const consent = await app.request("/api/v1/auth/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() });
    const back = new URL(consent.headers.get("location")!);
    expect((await app.request(`${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(page.jar) } })).headers.get("location")).toBe(login("provider_mismatch"));
  });

  it("holds an account to its subject under every provider the sign-in holds, whichever one was used", async () => {
    // Recorded through Google first. A re-created account at the service (another subject), linked to Microsoft as well,
    // signs in with Microsoft: refused, as it was when the token's first provider stood for every sign-in.
    await container.db.insert(users).values({ email: "vic@brightline.test", name: "Vic", authProvider: "google", authSubject: "first-account-subject" });
    const recreated = await start(app, "azure");
    expect((await callback(app, recreated, { email: "vic@brightline.test", provider: "azure", providers: ["google"], subject: "re-created-subject" })).headers.get("location")).toBe(login("identity_mismatch"));
    expect((await refusals("identity_mismatch")).find((d) => d.email === "vic@brightline.test")).toMatchObject({ provider: "azure" });
    // the account's own subject signs in through either provider
    const same = await start(app, "azure");
    expect((await callback(app, same, { email: "vic@brightline.test", provider: "azure", providers: ["google"], subject: "first-account-subject" })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
  });

  it("keeps the provider the browser started with through the staff authenticator step", async () => {
    // The step opens the session with the provider the sealed step cookie carries, Microsoft. (A staff account that also
    // held Google, whose re-issued level-2 token would name Google first, is refused before this step: the test above.)
    const flow = await start(app, "azure");
    expect((await callback(app, flow, { email: "kai@identifiedtalent.com", name: "Kai", provider: "azure", aal: "aal1" })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/api/v1/auth/mfa`);
    expect(flow.jar.ros_mfa).toBeTruthy();
    const page = await app.request("/api/v1/auth/mfa", { headers: { cookie: cookieHeader(flow.jar) } });
    absorb(flow.jar, page);
    const secret = (await page.text()).match(/id="setup-key">([A-Z2-7 ]+)<\/code>/)![1]!.replace(/\s+/g, "");
    const done = await app.request("/api/v1/auth/mfa", { method: "POST", headers: { cookie: cookieHeader(flow.jar), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: totp(secret) }).toString() });
    absorb(flow.jar, done);
    expect(done.status).toBe(200);
    expect(flow.jar.ros_session).toBeTruthy();
    expect(((await (await me(app, flow.jar)).json()) as { auth: { provider: string; aal: string } }).auth).toMatchObject({ provider: "azure", aal: "aal2" });
  });

  it("confirms identity again by the same rule: a provider the browser did not start with changes nothing", async () => {
    const opened = await session(app, idp().mint({ email: "rae@brightline.test", name: "Rae", provider: "google" }));
    const jar = absorb({}, opened);
    const confirm = async (provider: "azure" | "google") => {
      const begin = await app.request("/api/v1/auth/reauth/start", { method: "POST", headers: { cookie: cookieHeader(jar), "content-type": "application/json" }, body: JSON.stringify({ returnTo: "/setup" }) });
      const { url, provider: started } = (await begin.json()) as { url: string; provider: string };
      expect(started).toBe("google");
      const authorize = new URL(url);
      return callback(app, { res: begin, jar: absorb({ ...jar }, begin), challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")! }, { email: "rae@brightline.test", name: "Rae", provider });
    };
    expect((await confirm("azure")).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=failed`);
    expect((await confirm("google")).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=ok`);
  });

  it("has no JSON sign-in route in a production build", async () => {
    const token = idp().mint({ email: "dana@brightline.test", provider: "google" });
    const r = await session(prod, token);
    expect(r.status).toBe(404);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(await usersNamed("dana@brightline.test")).toEqual([]);
    expect((await session(app, token)).status).toBe(200);
  });

  it("over https names the sign-in cookies __Host- (Path=/) and __Secure- (the sign-in routes), and reads no old name", async () => {
    const flow = await start(prod, "google");
    expect(flow.res.headers.getSetCookie()).toEqual([expect.stringMatching(/^__Host-ros_pkce=[^;]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/)]);
    // the PKCE cookie under its old name is not read: the sign-in does not complete
    const old: Flow = { ...flow, jar: { ros_pkce: flow.jar["__Host-ros_pkce"]! } };
    expect((await callback(prod, old, { email: "sam@brightline.test", provider: "google" })).headers.get("location")).toBe(login("signin_incomplete"));
    const done = await callback(prod, flow, { email: "sam@brightline.test", provider: "google" });
    expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    expect(done.headers.getSetCookie()).toContain("__Host-ros_pkce=; Max-Age=0; Path=/; Secure");
    expect(done.headers.getSetCookie().find((l) => l.startsWith("__Host-ros_session="))).toMatch(/^__Host-ros_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    // the name the shell's middleware looks for
    expect(sessionCookieName({ NODE_ENV: "production" })).toBe("__Host-ros_session");
    const token = flow.jar["__Host-ros_session"]!;
    expect((await prod.request("/api/v1/auth/me", { headers: { cookie: `__Host-ros_session=${token}` } })).status).toBe(200);
    expect((await prod.request("/api/v1/auth/me", { headers: { cookie: `ros_session=${token}` } })).status).toBe(401);
    // the staff step's cookie is scoped to the sign-in routes
    const staff = await start(prod, "azure");
    expect((await callback(prod, staff, { email: "ren@identifiedtalent.com", name: "Ren", provider: "azure", aal: "aal1" })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/api/v1/auth/mfa`);
    const step = staff.jar["__Secure-ros_mfa"]!;
    expect(step).toBeTruthy();
    expect((await prod.request("/api/v1/auth/mfa", { headers: { cookie: `ros_mfa=${step}` } })).headers.get("location")).toBe(login("mfa_expired"));
    expect((await prod.request("/api/v1/auth/mfa", { headers: { cookie: `__Secure-ros_mfa=${step}` } })).status).toBe(200);
    // signing out clears the cookie by the name it was given
    const out = await prod.request("/api/v1/auth/logout", { method: "POST", headers: { cookie: `__Host-ros_session=${token}` } });
    expect(out.headers.getSetCookie()).toEqual(["__Host-ros_session=; Max-Age=0; Path=/; Secure"]);
    expect((await prod.request("/api/v1/auth/me", { headers: { cookie: `__Host-ros_session=${token}` } })).status).toBe(401);
  });

  it("over https with COOKIE_DOMAIN, the shared Path=/ cookies keep their plain names; over http every name is plain", async () => {
    const shared = createApp({ ...container, env: { ...container.env, NODE_ENV: "production", raw: { ...container.env.raw, COOKIE_DOMAIN: "app.example.test" } } });
    const flow = await start(shared, "google");
    expect(flow.res.headers.getSetCookie()).toEqual([expect.stringMatching(/^ros_pkce=[^;]+; Max-Age=600; Domain=app\.example\.test; Path=\/; HttpOnly; Secure; SameSite=Lax$/)]);
    const done = await callback(shared, flow, { email: "sam@brightline.test", provider: "google" });
    expect(done.headers.getSetCookie().find((l) => l.startsWith("ros_session="))).toMatch(/^ros_session=[^;]+; Max-Age=2592000; Domain=app\.example\.test; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(sessionCookieName({ NODE_ENV: "production", COOKIE_DOMAIN: "app.example.test" })).toBe("ros_session");
    const staff = await start(shared, "azure");
    const toStep = await callback(shared, staff, { email: "ren@identifiedtalent.com", name: "Ren", provider: "azure", aal: "aal1" });
    expect(toStep.headers.getSetCookie().find((l) => l.startsWith("__Secure-ros_mfa="))).toMatch(/^__Secure-ros_mfa=[^;]+; Max-Age=600; Domain=app\.example\.test; Path=\/api\/v1\/auth; HttpOnly; Secure; SameSite=Lax$/);
    // development and tests run over http, where no prefix is allowed
    const plain = await start(app, "google");
    expect(plain.res.headers.getSetCookie()).toEqual([expect.stringMatching(/^ros_pkce=[^;]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/)]);
    const plainDone = await callback(app, plain, { email: "sam@brightline.test", provider: "google" });
    expect(plainDone.headers.getSetCookie().find((l) => l.startsWith("ros_session="))).toMatch(/^ros_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/);
  });
});

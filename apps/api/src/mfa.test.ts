import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords, sessions, users } from "@ros/db";
import { openMfaTransaction, sealMfaTransaction, type MfaTransaction } from "@ros/core";
import { IdentityError, SupabaseIdentityProvider, scalableSvg, totp, type FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Staff second factor (founder approval, 22 September 2026): Microsoft vouches for the person, then an authenticator
 * app enrolled with the identity service must answer a challenge before a session opens at assurance level 2. The
 * fake issuer keeps real time-based factors, so these tests compute codes exactly as an authenticator app would.
 */
const BASE_ENV = { NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" };

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
const setupKeyOf = (html: string) => html.match(/id="setup-key">([A-Z2-7 ]+)<\/code>/)![1]!.replace(/\s+/g, "");
const wrongCode = (secret: string) => (totp(secret) === "000000" ? "111111" : "000000");

function harness(container: Container, app: ReturnType<typeof createApp>) {
  const mfaUrl = () => `${container.env.APP_BASE_URL}/api/v1/auth/mfa`;
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
  const get = async (jar: Jar, path: string, headers: Record<string, string> = {}) => { const r = await app.request(path, { headers: { cookie: cookieHeader(jar), ...headers } }); absorb(jar, r); return r; };
  const post = async (jar: Jar, path: string, body: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const r = await app.request(path, { method: "POST", headers: { cookie: cookieHeader(jar), "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body).toString() });
    absorb(jar, r);
    return r;
  };
  const postCode = (jar: Jar, code: string) => post(jar, "/api/v1/auth/mfa", { code });
  /** A wrong code answers with a redirect (post, redirect, get); this follows it and returns the page. */
  const wrongThenPage = async (jar: Jar, code: string) => {
    const r = await postCode(jar, code);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(mfaUrl());
    return (await get(jar, "/api/v1/auth/mfa")).text();
  };
  const me = async (jar: Jar) => app.request("/api/v1/auth/me", { headers: { cookie: cookieHeader(jar) } });
  const meJson = async (jar: Jar) => (await (await me(jar)).json()) as { user: { email: string; platformRole: string }; auth: { provider: string; aal: string; mfaVerifiedAt: string | null } };
  const auditsOf = async (action: string) => container.db.select().from(auditRecords).where(eq(auditRecords.action, action));
  return { mfaUrl, browserSignIn, get, post, postCode, wrongThenPage, me, meJson, auditsOf };
}

describe("staff second factor: enrol, verify, backup, recovery, enforcement", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let h: ReturnType<typeof harness>;
  const idp = () => container.integrations.identity as FakeIdentityProvider;
  const NADINE = "nadine@identifiedtalent.com";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, ...BASE_ENV, BOOTSTRAP_ADMIN_EMAILS: NADINE } });
    app = createApp(container);
    h = harness(container, app);
  });
  afterAll(async () => {
    await container.close();
  });

  let primarySecret = "";
  let backupSecret = "";

  it("a staff Microsoft sign-in without a second factor goes to the authenticator step; enrolment plus a correct code opens a level-2 session", async () => {
    const { res, jar } = await h.browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(h.mfaUrl());
    expect(jar.ros_session).toBeUndefined();
    expect(jar.ros_mfa).toBeTruthy();
    expect(jar.ros_pkce).toBeUndefined();
    // The transaction is sealed: the provider token (a JWT) is not readable from the cookie. Checked by structure
    // (a version prefix and three base64url parts), not by the absence of a three-letter substring, which a random
    // ciphertext can contain by chance.
    expect(jar.ros_mfa).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(jar.ros_mfa).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.eyJ/);
    expect((await h.me(jar)).status).toBe(401);

    const page = await h.get(jar, "/api/v1/auth/mfa");
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy-report-only") ?? page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("img-src 'self' data:");
    const html = await page.text();
    expect(html).toContain("Set up your authenticator app");
    // drawn with the nonce the policy names (two mounts match this path; app.ts issues one nonce per response)
    expect(html).toContain(`<style nonce="${csp.match(/'nonce-([^']+)'/)?.[1]}">`);
    expect(html).toContain("data:image/svg+xml");
    primarySecret = setupKeyOf(html);
    expect(primarySecret.length).toBeGreaterThanOrEqual(32);

    // A refresh keeps the same setup key (the person may already have scanned it) and says the QR code was shown once.
    const refreshed = await (await h.get(jar, "/api/v1/auth/mfa")).text();
    expect(setupKeyOf(refreshed)).toBe(primarySecret);
    expect(refreshed).toContain("shown only once");

    const afterWrong = await h.wrongThenPage(jar, wrongCode(primarySecret));
    expect(afterWrong).toContain("That code is not right");
    expect(setupKeyOf(afterWrong)).toBe(primarySecret);
    // the message is shown once
    expect(await (await h.get(jar, "/api/v1/auth/mfa")).text()).not.toContain("That code is not right");
    expect(jar.ros_session).toBeUndefined();
    const failed = await h.auditsOf("mfa.failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.reason).toBe("code_invalid");

    const right = await h.postCode(jar, totp(primarySecret));
    expect(right.status).toBe(200);
    expect(await right.text()).toContain("You are signed in.");
    expect(jar.ros_session).toBeTruthy();
    const m = await h.meJson(jar);
    expect(m.auth).toMatchObject({ provider: "azure", aal: "aal2" });
    expect(m.auth.mfaVerifiedAt).toBeTruthy();
    // The bootstrap list applied on the level-2 session, never earlier.
    expect(m.user.platformRole).toBe("platform_admin");
    const [user] = await container.db.select().from(users).where(eq(users.email, NADINE));
    expect(user!.mfaEnrolledAt).toBeTruthy();
    const [row] = await container.db.select().from(sessions).where(eq(sessions.userId, user!.id));
    expect(row!.aal).toBe("aal2");
    const enrolled = await h.auditsOf("mfa.enrolled");
    expect(enrolled.length).toBe(1);
    expect((enrolled[0]!.actor as { kind: string }).kind).toBe("user");

    // Neither the secret nor any token reaches the audit trail.
    const everything = JSON.stringify(await container.db.select().from(auditRecords));
    expect(everything).not.toContain(primarySecret);
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\.eyJ/);

    const skip = await h.post(jar, "/api/v1/auth/mfa/skip");
    expect(skip.status).toBe(302);
    expect(skip.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    expect(jar.ros_mfa).toBeUndefined();
  });

  it("the next sign-in challenges the enrolled authenticator without showing a secret; a backup authenticator can be added while the level-2 token is at hand", async () => {
    const { res, jar } = await h.browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    expect(res.headers.get("location")).toBe(h.mfaUrl());
    const html = await (await h.get(jar, "/api/v1/auth/mfa")).text();
    expect(html).toContain("Enter your code");
    expect(html).not.toContain("setup-key");
    const ok = await h.postCode(jar, totp(primarySecret));
    expect(await ok.text()).toContain("Add a backup authenticator");
    expect((await h.meJson(jar)).auth.aal).toBe("aal2");
    expect((await h.auditsOf("mfa.verified")).length).toBe(1);

    const backupPage = await h.get(jar, "/api/v1/auth/mfa/backup");
    expect(backupPage.status).toBe(200);
    const backupHtml = await backupPage.text();
    expect(backupHtml).toContain("Add a backup authenticator");
    backupSecret = setupKeyOf(backupHtml);
    expect(backupSecret).not.toBe(primarySecret);
    // a refresh of the backup page keeps the key
    expect(setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa/backup")).text())).toBe(backupSecret);
    const done = await h.postCode(jar, totp(backupSecret));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    expect(jar.ros_mfa).toBeUndefined();
    expect((await h.auditsOf("mfa.backup_enrolled")).length).toBe(1);
    const [user] = await container.db.select().from(users).where(eq(users.email, NADINE));
    const factors = await idp().listFactors(idp().mint({ email: NADINE, provider: "azure", aal: "aal2", subject: user!.authSubject! }));
    expect(factors.filter((f) => f.status === "verified").map((f) => f.friendlyName).sort()).toEqual(["Authenticator 1", "Authenticator 2"]);
  });

  it("with two authenticators, a code from either signs in and no backup is offered", async () => {
    const { jar } = await h.browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    await h.get(jar, "/api/v1/auth/mfa");
    const done = await h.postCode(jar, totp(backupSecret));
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    expect((await h.meJson(jar)).auth.aal).toBe("aal2");
    expect(jar.ros_mfa).toBeUndefined();
  });

  it("the fifth wrong code ends the attempt, the warning comes on the fourth, and an older copy of the cookie does not restore any tries", async () => {
    const { jar } = await h.browserSignIn({ email: "recruiter@identifiedtalent.com", name: "Riley Recruiter", provider: "azure", aal2: false });
    const secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
    const original = { ...jar };
    for (let i = 1; i <= 4; i++) {
      const text = await h.wrongThenPage(jar, wrongCode(secret));
      expect(text).toContain("That code is not right");
      if (i === 4) expect(text).toContain("last try");
      else expect(text).not.toContain("last try");
    }
    // The fifth wrong code, presented with the cookie as it was before any attempt: the count lives on the server.
    const fifth = await h.postCode({ ...original }, wrongCode(secret));
    expect(fifth.status).toBe(302);
    expect(fifth.headers.get("location")).toContain("/login?error=mfa_failed");
    // The transaction is spent: even the right code with the old cookie is refused.
    const afterwards = await h.postCode({ ...original }, totp(secret));
    expect(afterwards.headers.get("location")).toContain("/login?error=mfa_failed");
    expect((await h.auditsOf("mfa.failed")).some((f) => f.reason === "too_many_attempts")).toBe(true);
  });

  it("a fresh Microsoft sign-in does not reset the count: twelve attempts in fifteen minutes end it for the person", async () => {
    const email = "guess@identifiedtalent.com";
    let jar = (await h.browserSignIn({ email, name: "G", provider: "azure", aal2: false })).jar;
    let secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
    for (let i = 0; i < 4; i++) await h.postCode(jar, wrongCode(secret));
    expect((await h.postCode(jar, wrongCode(secret))).headers.get("location")).toContain("mfa_failed"); // 5
    jar = (await h.browserSignIn({ email, name: "G", provider: "azure", aal2: false })).jar;
    secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
    for (let i = 0; i < 4; i++) await h.postCode(jar, wrongCode(secret));
    expect((await h.postCode(jar, wrongCode(secret))).headers.get("location")).toContain("mfa_failed"); // 10
    jar = (await h.browserSignIn({ email, name: "G", provider: "azure", aal2: false })).jar;
    secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
    await h.postCode(jar, wrongCode(secret)); // 11
    await h.postCode(jar, wrongCode(secret)); // 12
    const thirteenth = await h.postCode(jar, totp(secret));
    expect(thirteenth.headers.get("location")).toContain("/login?error=mfa_failed");
    expect(jar.ros_session).toBeUndefined();
    const person = (await h.auditsOf("mfa.failed")).filter((f) => f.reason === "too_many_attempts" && (f.details as { scope?: string }).scope === "person");
    expect(person.length).toBe(1);
  });

  it("an expired, tampered or missing transaction returns to sign-in", async () => {
    const none = await app.request("/api/v1/auth/mfa");
    expect(none.headers.get("location")).toContain("/login?error=mfa_expired");
    const { jar } = await h.browserSignIn({ email: "late@identifiedtalent.com", name: "Late", provider: "azure", aal2: false });
    const sealed = jar.ros_mfa!;
    const parts = sealed.split(".");
    const flip = (s: string, at: number) => { const b = Buffer.from(s, "base64url"); b[at] = (b[at]! ^ 0x01) & 0xff; return b.toString("base64url"); };
    for (const forged of [[parts[0], parts[1], flip(parts[2]!, 3), parts[3]].join("."), [parts[0], parts[1], parts[2], flip(parts[3]!, 0)].join(".")]) {
      const r = await app.request("/api/v1/auth/mfa", { headers: { cookie: `ros_mfa=${forged}` } });
      expect(r.headers.get("location")).toContain("/login?error=mfa_expired");
      expect(r.headers.getSetCookie().some((c) => c.startsWith("ros_mfa=") && /max-age=0/i.test(c))).toBe(true);
    }
    // sealed under another secret, or with the stage rewritten, it is no transaction at all
    expect(openMfaTransaction(sealed, "some-other-secret-value-for-the-test")).toBeNull();
    const opened = openMfaTransaction(sealed, container.env.SESSION_SECRET)!;
    expect(opened.email).toBe("late@identifiedtalent.com");
    const rewritten = sealMfaTransaction({ ...opened, stage: "backup_offer" } as MfaTransaction, "some-other-secret-value-for-the-test");
    expect((await app.request("/api/v1/auth/mfa/backup", { headers: { cookie: `ros_mfa=${rewritten}` } })).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    // Ten minutes and one second later the sealed transaction is dead.
    const engine = container.engine as unknown as { now: () => Date };
    const realNow = engine.now;
    const later = new Date(realNow().getTime() + 10 * 60_000 + 1000);
    engine.now = () => later;
    try {
      const r = await h.get(jar, "/api/v1/auth/mfa");
      expect(r.headers.get("location")).toContain("/login?error=mfa_expired");
    } finally {
      engine.now = realNow;
    }
  });

  it("customers and level-2 staff never see the step; a staff Google sign-in is still refused; the JSON route still refuses level 1", async () => {
    const customer = await h.browserSignIn({ email: "dana@brightline.test", name: "Dana", provider: "google", aal2: false });
    expect(customer.res.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    expect(customer.jar.ros_session).toBeTruthy();
    expect(customer.jar.ros_mfa).toBeUndefined();
    const staffAal2 = await h.browserSignIn({ email: "paul@identifiedtalent.com", name: "Paul", provider: "azure", aal2: true });
    expect(staffAal2.res.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    expect(staffAal2.jar.ros_mfa).toBeUndefined();
    const staffGoogle = await h.browserSignIn({ email: "paul@identifiedtalent.com", name: "Paul", provider: "google", aal2: false });
    expect(staffGoogle.res.headers.get("location")).toContain("/login?error=staff_provider_required");
    expect(staffGoogle.jar.ros_mfa).toBeUndefined();
    const json = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: idp().mint({ email: "paul@identifiedtalent.com", provider: "azure", aal: "aal1" }) }) });
    expect(json.status).toBe(403);
    expect(((await json.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
  });

  it("the backup step belongs to the signed-in person only, and a stage that expects no code answers with a redirect", async () => {
    const email = "solo@identifiedtalent.com";
    const { jar } = await h.browserSignIn({ email, name: "Solo", provider: "azure", aal2: false });
    const secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
    expect(await (await h.postCode(jar, totp(secret))).text()).toContain("Add a backup authenticator");
    // a code posted at the offer stage is not an attempt
    expect((await h.postCode(jar, totp(secret))).headers.get("location")).toBe(h.mfaUrl());
    // another person's session with this transaction cookie: cleared, sent home, nothing enrolled
    const customer = await h.browserSignIn({ email: "eve@brightline.test", name: "Eve", provider: "google", aal2: false });
    const stolen: Jar = { ros_mfa: jar.ros_mfa!, ros_session: customer.jar.ros_session! };
    const r = await h.get(stolen, "/api/v1/auth/mfa/backup");
    expect(r.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    expect(stolen.ros_mfa).toBeUndefined();
    // no session at all: home, nothing enrolled
    const noSession: Jar = { ros_mfa: jar.ros_mfa! };
    expect((await h.get(noSession, "/api/v1/auth/mfa/backup")).headers.get("location")).toBe(`${container.env.APP_BASE_URL}/`);
    const [user] = await container.db.select().from(users).where(eq(users.email, email));
    const factors = await idp().listFactors(idp().mint({ email, provider: "azure", aal: "aal2", subject: user!.authSubject! }));
    expect(factors.filter((f) => f.status === "verified").length).toBe(1);
    // the rightful person can still add the backup
    expect((await h.get(jar, "/api/v1/auth/mfa/backup")).status).toBe(200);
  });

  it("a request that names another site as its origin neither answers nor cancels the step", async () => {
    const { jar } = await h.browserSignIn({ email: "site@identifiedtalent.com", name: "S", provider: "azure", aal2: false });
    const page = await h.get(jar, "/api/v1/auth/mfa");
    // the page's own posts carry its real origin (middleware/same-site.ts, formPageReferrer)
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const secret = setupKeyOf(await page.text());
    // refused for every change under /api before the step is read (middleware/same-site.ts); the step is untouched
    for (const path of ["/api/v1/auth/mfa/cancel", "/api/v1/auth/mfa/skip"]) {
      const r = await h.post(jar, path, {}, { "sec-fetch-site": "cross-site" });
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("cross_site");
      expect(jar.ros_mfa).toBeTruthy();
    }
    const code = await h.post(jar, "/api/v1/auth/mfa", { code: totp(secret) }, { "sec-fetch-site": "cross-site" });
    expect(code.status).toBe(403);
    // a sibling host of the same site names itself in Origin
    const sibling = await h.post(jar, "/api/v1/auth/mfa", { code: totp(secret) }, { "sec-fetch-site": "same-site", origin: "https://www.example.com" });
    expect(sibling.status).toBe(403);
    // an opaque origin from a browser without fetch metadata names no site, so it answers nothing either
    const opaque = await h.post(jar, "/api/v1/auth/mfa", { code: totp(secret) }, { origin: "null" });
    expect(opaque.status).toBe(403);
    expect(jar.ros_session).toBeUndefined();
    // the person's own cancel, from the page at the app's address, works and audits nothing about the secret
    const cancel = await h.post(jar, "/api/v1/auth/mfa/cancel", {}, { "sec-fetch-site": "same-origin", origin: container.env.APP_BASE_URL });
    expect(cancel.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/login`);
    expect(jar.ros_mfa).toBeUndefined();
  });

  it("a token the service did not raise to level 2 never opens a session, and a service failure ends the step honestly", async () => {
    const email = "faulty@identifiedtalent.com";
    const { jar } = await h.browserSignIn({ email, name: "F", provider: "azure", aal2: false });
    const secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
    const spy = vi.spyOn(idp(), "verifyFactor").mockResolvedValueOnce({ accessToken: idp().mint({ email, provider: "azure", aal: "aal1" }) });
    const low = await h.postCode(jar, totp(secret));
    expect(low.headers.get("location")).toContain("/login?error=mfa_unavailable");
    expect(jar.ros_session).toBeUndefined();
    expect(jar.ros_mfa).toBeUndefined();
    expect((await h.auditsOf("session.opened")).some((r) => (r.actor as { name?: string }).name === "F")).toBe(false);
    expect((await h.auditsOf("mfa.failed")).some((f) => f.reason === "level_not_raised")).toBe(true);
    spy.mockRestore();

    const again = (await h.browserSignIn({ email, name: "F", provider: "azure", aal2: false })).jar;
    const listSpy = vi.spyOn(idp(), "listFactors").mockRejectedValueOnce(new IdentityError("mfa_unavailable", "down"));
    const down = await h.get(again, "/api/v1/auth/mfa");
    expect(down.headers.get("location")).toContain("/login?error=mfa_unavailable");
    expect(again.ros_mfa).toBeUndefined();
    listSpy.mockRestore();

    const third = (await h.browserSignIn({ email, name: "F", provider: "azure", aal2: false })).jar;
    const s3 = setupKeyOf(await (await h.get(third, "/api/v1/auth/mfa")).text());
    const gone = vi.spyOn(idp(), "verifyFactor").mockRejectedValueOnce(new IdentityError("mfa_session_invalid", "gone"));
    expect((await h.postCode(third, totp(s3))).headers.get("location")).toContain("/login?error=mfa_expired");
    gone.mockRestore();
    // an address mismatch or a disabled service is not the person's mistake: no attempt is charged as a wrong code
    const fourth = (await h.browserSignIn({ email, name: "F", provider: "azure", aal2: false })).jar;
    const s4 = setupKeyOf(await (await h.get(fourth, "/api/v1/auth/mfa")).text());
    const mismatch = vi.spyOn(idp(), "verifyFactor").mockRejectedValueOnce(new IdentityError("mfa_ip_mismatch", "addresses differ"));
    expect((await h.postCode(fourth, totp(s4))).headers.get("location")).toContain("/login?error=mfa_unavailable");
    mismatch.mockRestore();
    expect((await h.auditsOf("mfa.failed")).filter((f) => f.reason === "code_invalid" && (f.details as { email?: string }).email === email).length).toBe(0);
  });

  it("a reset at the identity service is recorded, the person enrols again at the next sign-in, and every other session of theirs ends", async () => {
    const [user] = await container.db.select().from(users).where(eq(users.email, NADINE));
    // the session from the earlier sign-in (the "lost device") is still open
    const lostDevice = (await h.browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false })).jar;
    await h.get(lostDevice, "/api/v1/auth/mfa");
    await h.postCode(lostDevice, totp(backupSecret));
    expect((await h.me(lostDevice)).status).toBe(200);
    idp().resetFactors(user!.authSubject!);
    const { jar } = await h.browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false });
    const html = await (await h.get(jar, "/api/v1/auth/mfa")).text();
    expect(html).toContain("Set up your authenticator app");
    const reset = await h.auditsOf("mfa.reset_detected");
    expect(reset.length).toBe(1);
    expect((reset[0]!.target as { id: string }).id).toBe(user!.id);
    const secret = setupKeyOf(html);
    primarySecret = secret;
    const ok = await h.postCode(jar, totp(secret));
    expect(await ok.text()).toContain("You are signed in.");
    expect((await h.meJson(jar)).auth.aal).toBe("aal2");
    expect((await h.auditsOf("mfa.enrolled")).filter((r) => (r.target as { id?: string }).id === user!.id).length).toBe(2);
    // the lost device's session is gone; the new one stands
    expect((await h.me(lostDevice)).status).toBe(401);
    expect((await h.me(jar)).status).toBe(200);
    expect((await h.auditsOf("session.revoked")).some((r) => r.reason === "authenticator_enrolled" && (r.target as { id?: string }).id === user!.id)).toBe(true);
  });

  it("an administrator can sign a person out everywhere, with a reason, and it is audited", async () => {
    const [nadine] = await container.db.select().from(users).where(eq(users.email, NADINE));
    const admin = (await h.browserSignIn({ email: NADINE, name: "Nadine Motaweh", provider: "azure", aal2: false })).jar;
    await h.get(admin, "/api/v1/auth/mfa");
    await h.postCode(admin, totp(primarySecret));
    expect((await h.meJson(admin)).user.platformRole).toBe("platform_admin");
    const paul = await h.browserSignIn({ email: "paul@identifiedtalent.com", name: "Paul", provider: "azure", aal2: true });
    expect((await h.me(paul.jar)).status).toBe(200);
    const [paulRow] = await container.db.select().from(users).where(eq(users.email, "paul@identifiedtalent.com"));
    const call = (body: unknown) => app.request(`/api/v1/admin/users/${paulRow!.id}/sessions/revoke`, { method: "POST", headers: { cookie: cookieHeader(admin), "content-type": "application/json", "x-admin-reason": "lost device" }, body: JSON.stringify(body) });
    expect((await call({ confirm: true })).status).toBe(400);
    expect((await call({ reason: "lost device, owner reset done", confirm: false })).status).toBe(400);
    const ok = await call({ reason: "lost device, owner reset done", confirm: true });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { sessionsEnded: number }).sessionsEnded).toBeGreaterThanOrEqual(1);
    expect((await h.me(paul.jar)).status).toBe(401);
    expect((await h.auditsOf("session.revoked")).some((r) => (r.target as { id?: string }).id === paulRow!.id && (r.details as { by?: string }).by === "administrator")).toBe(true);
    // the console asks for the address they sign in with, not an id: the same rules, and an unknown address says so
    const again = await h.browserSignIn({ email: "paul@identifiedtalent.com", name: "Paul", provider: "azure", aal2: true });
    expect((await h.me(again.jar)).status).toBe(200);
    const byEmail = (body: unknown) => app.request("/api/v1/admin/sessions/revoke", { method: "POST", headers: { cookie: cookieHeader(admin), "content-type": "application/json", "x-admin-reason": "lost device" }, body: JSON.stringify(body) });
    expect((await byEmail({ email: "paul@identifiedtalent.com", reason: "lost laptop", confirm: false })).status).toBe(400);
    expect((await byEmail({ email: "nobody@identifiedtalent.com", reason: "lost laptop", confirm: true })).status).toBe(404);
    const done = await byEmail({ email: " Paul@IdentifiedTalent.com ", reason: "lost laptop", confirm: true });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { sessionsEnded: number }).sessionsEnded).toBeGreaterThanOrEqual(1);
    expect((await h.me(again.jar)).status).toBe(401);
    void nadine;
  });

  it("the fake keeps the service's rules: a challenge answers only from the address that made it, and a second factor needs a level-2 token to enrol", async () => {
    const email = "rules@identifiedtalent.com";
    const aal1 = idp().mint({ email, provider: "azure", aal: "aal1" });
    const enrol = await idp().enrolTotp(aal1, { friendlyName: "Authenticator 1", issuer: "Recruiting OS" });
    const ch = await idp().challengeFactor(aal1, enrol.factorId, { ip: "10.0.0.1" });
    await expect(idp().verifyFactor(aal1, { factorId: enrol.factorId, challengeId: ch.challengeId, code: totp(enrol.secret) }, { ip: "10.0.0.2" })).rejects.toMatchObject({ code: "mfa_ip_mismatch" });
    const ch2 = await idp().challengeFactor(aal1, enrol.factorId, { ip: "10.0.0.1" });
    const { accessToken } = await idp().verifyFactor(aal1, { factorId: enrol.factorId, challengeId: ch2.challengeId, code: totp(enrol.secret) }, { ip: "10.0.0.1" });
    expect((await idp().verify(accessToken)).aal).toBe("aal2");
    await expect(idp().enrolTotp(aal1, { friendlyName: "Authenticator 2", issuer: "Recruiting OS" })).rejects.toMatchObject({ code: "mfa_aal2_required" });
    await expect(idp().enrolTotp(accessToken, { friendlyName: "Authenticator 1", issuer: "Recruiting OS" })).rejects.toMatchObject({ code: "mfa_factor_conflict" });
    expect((await idp().enrolTotp(accessToken, { friendlyName: "Authenticator 2", issuer: "Recruiting OS" })).factorId).toBeTruthy();
    // RFC 6238 test vector: secret 12345678901234567890, time 59 seconds, SHA-1, six digits
    expect(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", new Date(59_000))).toBe("287082");
  });

  it("the real provider speaks the service's factor endpoints with the person's token and the publishable key, and maps every documented error shape", async () => {
    const calls: Array<{ url: string; method: string; body: string | null; headers: Record<string, string> }> = [];
    let verifyAnswer: () => Response = () => new Response(JSON.stringify({ access_token: "eyJaal2", token_type: "bearer", expires_in: 3600, refresh_token: "r" }));
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: typeof init?.body === "string" ? init.body : null, headers });
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "u1", factors: [{ id: "f1", factor_type: "totp", friendly_name: "Authenticator 1", status: "verified", created_at: "2026-09-22T00:00:00Z" }] }));
      if (url.endsWith("/auth/v1/factors") && method === "POST") return new Response(JSON.stringify({ id: "f2", type: "totp", friendly_name: "Authenticator 2", totp: { qr_code: "<svg width=\"245\" height=\"245\" xmlns=\"http://www.w3.org/2000/svg\"><rect/></svg>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" } }));
      if (url.endsWith("/auth/v1/factors/f1/challenge")) return new Response(JSON.stringify({ id: "c1", type: "totp", expires_at: 1790000000 }));
      if (url.endsWith("/auth/v1/factors/f1/verify")) return verifyAnswer();
      if (url.endsWith("/auth/v1/factors/f2") && method === "DELETE") return new Response(JSON.stringify({ id: "f2" }));
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const p = new SupabaseIdentityProvider({ url: "https://vjuaiyjmtrenbrmujvtc.supabase.co", anonKey: "sb_publishable_test", fetch: fakeFetch });
    const factors = await p.listFactors("eyJaal1");
    expect(factors).toEqual([{ id: "f1", type: "totp", friendlyName: "Authenticator 1", status: "verified", createdAt: "2026-09-22T00:00:00Z" }]);
    const enrol = await p.enrolTotp("eyJaal1", { friendlyName: "Authenticator 2", issuer: "Recruiting OS" });
    expect(enrol).toMatchObject({ factorId: "f2", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/x" });
    // the service's SVG names a pixel size and no viewBox; the page's image box needs one to scale it
    expect(enrol.qrCodeSvg).toContain('viewBox="0 0 245 245"');
    expect(scalableSvg('<svg viewBox="0 0 10 10"></svg>')).toBe('<svg viewBox="0 0 10 10"></svg>');
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/factors"))!.body!)).toEqual({ factor_type: "totp", friendly_name: "Authenticator 2", issuer: "Recruiting OS" });
    const challenge = await p.challengeFactor("eyJaal1", "f1");
    expect(challenge).toEqual({ challengeId: "c1", expiresAt: new Date(1790000000 * 1000).toISOString() });
    const verified = await p.verifyFactor("eyJaal1", { factorId: "f1", challengeId: "c1", code: "123456" });
    expect(verified.accessToken).toBe("eyJaal2");
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/verify"))!.body!)).toEqual({ challenge_id: "c1", code: "123456" });
    await p.unenrolFactor("eyJaal1", "f2");
    for (const c of calls) {
      expect(c.headers.apikey).toBe("sb_publishable_test");
      expect(c.headers.authorization).toBe("Bearer eyJaal1");
      expect(c.headers["x-supabase-api-version"]).toBe("2024-01-01");
    }
    expect(new URL(calls[0]!.url).origin).toBe("https://vjuaiyjmtrenbrmujvtc.supabase.co");
    // error shapes: the versioned body, the header alone, the legacy body, a non-JSON answer, rate limit, a dead session
    const cases: Array<[Response, string]> = [
      [new Response(JSON.stringify({ code: "mfa_verification_failed", message: "Invalid TOTP code entered" }), { status: 422 }), "mfa_code_invalid"],
      [new Response("{}", { status: 422, headers: { "x-sb-error-code": "mfa_verification_failed" } }), "mfa_code_invalid"],
      [new Response(JSON.stringify({ code: 422, error_code: "mfa_challenge_expired", msg: "expired" }), { status: 422 }), "mfa_challenge_expired"],
      [new Response(JSON.stringify({ code: "mfa_ip_address_mismatch", message: "mismatch" }), { status: 422 }), "mfa_ip_mismatch"],
      [new Response(JSON.stringify({ code: "mfa_totp_verify_not_enabled", message: "off" }), { status: 422 }), "mfa_unavailable"],
      [new Response(JSON.stringify({ code: "mfa_factor_not_found", message: "no challenge" }), { status: 422 }), "mfa_challenge_invalid"],
      [new Response("<html>503</html>", { status: 503 }), "mfa_unavailable"],
      [new Response(JSON.stringify({ code: "over_request_rate_limit", message: "slow down" }), { status: 429 }), "mfa_rate_limited"],
      [new Response(JSON.stringify({ code: "session_not_found", message: "gone" }), { status: 403 }), "mfa_session_invalid"],
      [new Response(JSON.stringify({ message: "nope" }), { status: 401 }), "mfa_session_invalid"],
      [new Response(JSON.stringify({ code: "insufficient_aal", message: "aal2 required" }), { status: 403 }), "mfa_aal2_required"],
    ];
    for (const [answer, code] of cases) {
      verifyAnswer = () => answer;
      await expect(p.verifyFactor("eyJaal1", { factorId: "f1", challengeId: "c1", code: "000000" })).rejects.toMatchObject({ code });
    }
  });
});

describe("staff second factor: the address limit answers with a page", () => {
  it("too many code posts from one address get a readable page with Retry-After, not a JSON blob", async () => {
    const container = await createContainer({ memory: true, env: { ...process.env, ...BASE_ENV, RATE_LIMIT_OVERRIDES: JSON.stringify({ "auth.mfa": 2 }) } });
    const app = createApp(container);
    const h = harness(container, app);
    try {
      const { jar } = await h.browserSignIn({ email: "limit@identifiedtalent.com", name: "L", provider: "azure", aal2: false });
      const secret = setupKeyOf(await (await h.get(jar, "/api/v1/auth/mfa")).text());
      await h.postCode(jar, wrongCode(secret));
      await h.postCode(jar, wrongCode(secret));
      const third = await h.post(jar, "/api/v1/auth/mfa", { code: totp(secret) }, { accept: "text/html" });
      expect(third.status).toBe(429);
      expect(third.headers.get("retry-after")).toBeTruthy();
      expect(third.headers.get("content-type")).toContain("text/html");
      expect(await third.text()).toContain("Please try again");
      expect(jar.ros_session).toBeUndefined();
    } finally {
      await container.close();
    }
  });
});

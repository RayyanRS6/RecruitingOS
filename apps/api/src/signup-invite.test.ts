import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { companies, invitations } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { loadEnv, signupModeOf } from "./env";
import { maySignUp } from "./services/companies";
import { signInStaff, signInWithIdentity, testContainerOptions } from "./test-helpers";

/**
 * Invitation-only sign-up (GATE-V2, GAP3-2, GAP3-6). Open sign-up (founder decision B7) lets anyone signed in with
 * Google or Microsoft create a company and draft roles with paid AI. SIGNUP_MODE=invite closes that to everyone but
 * platform administrators and the addresses on SIGNUP_ALLOWED_EMAILS, while signing in and joining a company by
 * invitation work as before. Unset, sign-up stays open.
 */
const refusal = (source: Record<string, string | undefined>): string | null => {
  try {
    loadEnv(source);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe("SIGNUP_MODE and SIGNUP_ALLOWED_EMAILS (env.ts)", () => {
  it("is open unless set to invite, empty counting as unset; the welcome page reads it the same way", () => {
    expect(loadEnv({ NODE_ENV: "test" }).SIGNUP_MODE).toBe("open");
    expect(loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "" }).SIGNUP_MODE).toBe("open");
    expect(loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "open" }).SIGNUP_MODE).toBe("open");
    expect(loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "invite" }).SIGNUP_MODE).toBe("invite");
    expect(loadEnv({ NODE_ENV: "test" }).SIGNUP_ALLOWED_EMAILS).toEqual([]);
    expect(signupModeOf({})).toBe("open");
    expect(signupModeOf({ SIGNUP_MODE: "invite" })).toBe("invite");
  });

  it("refuses any other mode in every environment, so a misspelling never leaves sign-up open", () => {
    for (const value of ["Invite", "invite ", "closed", "invitation", "true"]) {
      expect(refusal({ NODE_ENV: "test", SIGNUP_MODE: value }), value).toMatch(/^SIGNUP_MODE must be "open" or "invite" \(it is ".+"\)/);
      expect(() => signupModeOf({ SIGNUP_MODE: value }), value).toThrow(/^SIGNUP_MODE must be "open" or "invite"/);
    }
    expect(refusal({ NODE_ENV: "development", SIGNUP_MODE: "closed" })).toMatch(/^SIGNUP_MODE must be "open" or "invite"/);
  });

  it("reads the list trimmed and lower-cased, and refuses an entry that is neither a full address nor @domain", () => {
    expect(loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: " Pat@Pilot-Partner.test , @Second-Partner.TEST ,, " }).SIGNUP_ALLOWED_EMAILS).toEqual(["pat@pilot-partner.test", "@second-partner.test"]);
    for (const entry of ["pilot-partner.test", "pat@", "@", "@localhost", "pat@pilot@partner.test", "pat @pilot-partner.test", "*.pilot-partner.test"]) {
      expect(refusal({ NODE_ENV: "test", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: `pat@pilot-partner.test,${entry}` }), entry).toMatch(/^SIGNUP_ALLOWED_EMAILS takes full addresses and "@domain" entries, comma-separated \(".+" is neither\)/);
    }
  });

  it("warns when a list is set while sign-up is still open, and is quiet by invitation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      loadEnv({ NODE_ENV: "test", SIGNUP_ALLOWED_EMAILS: "@pilot-partner.test" });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("SIGNUP_ALLOWED_EMAILS is set but SIGNUP_MODE is not \"invite\", so anyone signed in may still create a company"));
      warn.mockClear();
      loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: "@pilot-partner.test" });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("who may create a company (maySignUp)", () => {
  const byInvitation = loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: "Pat@Pilot-Partner.test, @Second-Partner.TEST" });
  const person = (email: string, platformRole = "none") => ({ email, platformRole });

  it("an address on the list, whatever its case on either side; only that address", () => {
    expect(maySignUp(byInvitation, person("pat@pilot-partner.test"))).toBe(true);
    expect(maySignUp(byInvitation, person("PAT@pilot-PARTNER.test"))).toBe(true);
    for (const email of ["pam@pilot-partner.test", "xpat@pilot-partner.test", "pat@pilot-partner.test.evil.test"]) expect(maySignUp(byInvitation, person(email)), email).toBe(false);
  });

  it("anyone at an @domain entry, whatever the case, but not a subdomain or a look-alike", () => {
    expect(maySignUp(byInvitation, person("quinn@second-partner.test"))).toBe(true);
    expect(maySignUp(byInvitation, person("Quinn@SECOND-PARTNER.TEST"))).toBe(true);
    for (const email of ["rae@mail.second-partner.test", "rae@evil-second-partner.test", "rae@second-partner.test.evil.test", "second-partner.test", "@second-partner.test"]) expect(maySignUp(byInvitation, person(email)), email).toBe(false);
  });

  it("a platform administrator, listed or not; an ITS recruiter or anyone else only when listed", () => {
    expect(maySignUp(byInvitation, person("ada@its.test", "platform_admin"))).toBe(true);
    expect(maySignUp(byInvitation, person("rita@its.test", "its_recruiter"))).toBe(false);
    expect(maySignUp(byInvitation, person("rita@second-partner.test", "its_recruiter"))).toBe(true);
    expect(maySignUp(byInvitation, person("sam@stranger.test"))).toBe(false);
    // no list: platform administrators only
    const nobody = loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "invite" });
    expect(maySignUp(nobody, person("sam@stranger.test"))).toBe(false);
    expect(maySignUp(nobody, person("ada@its.test", "platform_admin"))).toBe(true);
  });

  it("anyone at all while sign-up is open, whatever a list says", () => {
    expect(maySignUp(loadEnv({ NODE_ENV: "test" }), person("sam@stranger.test"))).toBe(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(maySignUp(loadEnv({ NODE_ENV: "test", SIGNUP_ALLOWED_EMAILS: "@pilot-partner.test" }), person("sam@stranger.test"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

type SignupConfig = { mode: string; allowed: boolean; contact: string };

describe("by invitation over HTTP (SIGNUP_MODE=invite)", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const create = (cookie: string, name: string) => json(cookie, "POST", "/api/v1/companies", { name, vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", locations: [{ city: "Austin", region: "TX", country: "US" }] });
  const google = (email: string, name?: string) => signInWithIdentity(app, container, { email, name, provider: "google", aal2: false });
  const signupFor = async (cookie = "") => ((await (await json(cookie, "GET", "/api/v1/auth/config")).json()) as { signup: SignupConfig }).signup;
  const companiesNamed = async (name: string) => (await container.db.select({ id: companies.id }).from(companies).where(eq(companies.name, name))).length;

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: "Pat@Pilot-Partner.test, @Second-Partner.TEST", EMAIL_REPLY_TO: "recruiting@its.example" }));
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("a stranger still signs in, and is refused a company with 403 and one plain line; nothing is made", async () => {
    const sam = await google("sam@stranger.test", "Sam Stranger");
    const me = (await (await json(sam, "GET", "/api/v1/auth/me")).json()) as { user: { email: string }; activeCompanyId: string | null };
    expect(me.user.email).toBe("sam@stranger.test");
    expect(me.activeCompanyId).toBeNull();
    const r = await create(sam, "Stranger Dental");
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: "signup_invite_only", message: "Recruiting OS is by invitation for now. Ask ITS for an invitation." } });
    expect(await companiesNamed("Stranger Dental")).toBe(0);
  });

  it("refuses before the body is read: a bad body from a stranger gets the same 403, not 400", async () => {
    const r = await json(await google("sam@stranger.test"), "POST", "/api/v1/companies", { name: "" });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("signup_invite_only");
  });

  it("an address on the list and anyone at a listed domain create their company as before, whatever the case", async () => {
    expect((await create(await google("PAT@pilot-partner.test", "Pat Partner"), "Pilot Partner Dental")).status).toBe(201);
    expect((await create(await google("Quinn@Second-Partner.test", "Quinn"), "Second Partner Dental")).status).toBe(201);
    for (const email of ["rae@mail.second-partner.test", "rae@evil-second-partner.test", "pam@pilot-partner.test"]) {
      const r = await create(await google(email), `Look-alike ${email}`);
      expect(r.status, email).toBe(403);
      expect(await companiesNamed(`Look-alike ${email}`), email).toBe(0);
    }
  });

  it("a platform administrator sets companies up as before, more than one", async () => {
    const ada = await signInStaff(app, container, "ada@its.test", "platform_admin", "Ada Admin");
    expect((await create(ada, "Set Up One")).status).toBe(201);
    expect((await create(ada, "Set Up Two")).status).toBe(201);
  });

  it("the sign-in configuration says so: by invitation, whether this person may, and whom to ask; never the list", async () => {
    const anonymous = await signupFor();
    expect(anonymous).toEqual({ mode: "invite", allowed: false, contact: "recruiting@its.example" });
    expect(await signupFor(await google("sam@stranger.test"))).toEqual({ mode: "invite", allowed: false, contact: "recruiting@its.example" });
    const listed = await signupFor(await google("quinn@second-partner.test"));
    expect(listed).toEqual({ mode: "invite", allowed: true, contact: "recruiting@its.example" });
    expect((await signupFor(await signInStaff(app, container, "ada@its.test", "platform_admin", "Ada Admin"))).allowed).toBe(true);
    expect(JSON.stringify([anonymous, listed])).not.toMatch(/pilot-partner|second-partner/i);
  });

  it("joining a company by invitation still works for someone the list does not name", async () => {
    const olga = await google("olga@second-partner.test", "Olga Owner");
    const made = await create(olga, "Olga Dental");
    expect(made.status).toBe(201);
    const companyId = ((await made.json()) as { id: string }).id;
    expect((await json(olga, "POST", "/api/v1/companies/current/members/invite", { email: "ivy@elsewhere.test", role: "interviewer" })).status).toBe(201);
    const ivy = await google("ivy@elsewhere.test", "Ivy");
    const me = (await (await json(ivy, "GET", "/api/v1/auth/me")).json()) as { activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> };
    expect(me.activeCompanyId).toBe(companyId);
    expect(me.memberships).toEqual([expect.objectContaining({ companyId, role: "interviewer" })]);
    const [row] = await container.db.select().from(invitations).where(eq(invitations.email, "ivy@elsewhere.test"));
    expect(row.status).toBe("accepted");
    // a member of that company now, and still not someone who may open one of their own
    expect((await create(ivy, "Ivy Dental")).status).toBe(403);
  });
});

describe("open sign-up, the default, is unchanged", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const signupFor = async (cookie = "") => ((await (await json(cookie, "GET", "/api/v1/auth/config")).json()) as { signup: SignupConfig }).signup;

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SIGNUP_MODE: undefined, SIGNUP_ALLOWED_EMAILS: undefined }));
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("anyone signed in creates a company, a bad body still answers 400, and the configuration says anyone may", async () => {
    expect(container.env.SIGNUP_MODE).toBe("open");
    expect(await signupFor()).toEqual({ mode: "open", allowed: true, contact: container.env.EMAIL_REPLY_TO });
    const sam = await signInWithIdentity(app, container, { email: "sam@stranger.test", name: "Sam Stranger", provider: "google", aal2: false });
    expect((await signupFor(sam)).allowed).toBe(true);
    const bad = await json(sam, "POST", "/api/v1/companies", { name: "" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    const made = await json(sam, "POST", "/api/v1/companies", { name: "Stranger Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(made.status).toBe(201);
  });
});

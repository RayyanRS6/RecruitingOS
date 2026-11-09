import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { SEND_MAX_ATTEMPTS, SPAM_ALERT_WINDOW_MS, sendQueuedCommunication, sweepStaleSending } from "@ros/agents";
import { CreateCompany, FREE_PLAN_KEY, oneLine, type CustomerAccessAnswer, type CustomerAccessRequest, type SignupConfig } from "@ros/contracts";
import { createApplicationLink, createInvitation, renderAlertEmail } from "@ros/core";
import { adminAlerts, aiRuns, applications, auditRecords, candidates, communications, companies, emailSuppressions, entitlements, events, interviews, invitations, jobs, memberships, notifications, rolePackets, roles, sessions, users, withPlatform, workflowRuns } from "@ros/db";
import { fakePostmarkEvent, type FakeEmailAdapter, type FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { loadEnv, signupModeOf } from "./env";
import { runHourlyChecks, runMaintenance } from "./maintenance";
import { POLICIES } from "./middleware/rate-limit";
import { resetPublicFeedCache } from "./pages/public-feeds";
import { OPEN_REQUESTS_EMAILED, companyRequestDetails, decideAccess, sendAccessRequest } from "./services/access-requests";
import { emailReallyLeft } from "./services/company-trust";
import { signupDoor } from "./services/companies";
import { backfillPublishing } from "./services/publishing-backfill";
import { signInAdmin, signInStaff, signInWithIdentity, testContainerOptions } from "./test-helpers";

/**
 * First sign-in asks for approval (the owner's request of 6 November 2026, SIGNUP_MODE=approval). Someone signed in fills
 * in the company form; their company starts as a request, with their membership `requested`; nothing else works for them,
 * so no AI runs and no money is spent; a platform administrator accepts, which counts as the one-time ITS check too, or
 * declines. The wall is the membership: the sweep below walks Hono's own route table, every route, as someone waiting and
 * as someone declined, with the real ids of their own company and of another one.
 */

/** No sweep or suite here trips a limit: a 429 is not a refusal the wall made, so limits are out of the way. */
const NO_LIMITS = JSON.stringify(Object.fromEntries(Object.values(POLICIES).map((p) => [p.name, 1_000_000])));

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";

type Env = Record<string, string | undefined>;
type World = ReturnType<typeof worldOf>;

/** What every part of this file does with a container. */
function worldOf(container: Container, app: ReturnType<typeof createApp>) {
  const json = async (cookie: string, method: string, path: string, body?: unknown): Promise<Response> => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test", accept: "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const code = async (r: Response) => ((await r.clone().json()) as { error?: { code?: string } }).error?.code;
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const form = (name: string, extra: Record<string, unknown> = {}) => ({ name, ownerName: "Sam Asker", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", website: "https://asker.example", locations: [{ city: "Austin", region: "TX", country: "US" }], ...extra });
  const google = (email: string, name?: string) => signInWithIdentity(app, container, { email, name, provider: "google", aal2: false });
  const signupOf = async (cookie = "") => (await read<{ signup: SignupConfig }>(await json(cookie, "GET", "/api/v1/auth/config"))).signup;
  const meOf = (cookie: string) => json(cookie, "GET", "/api/v1/auth/me").then((r) => read<{ user: { id: string; email: string }; activeCompanyId: string | null; memberships: Array<{ companyId: string; role: string }> }>(r));
  const admin = () => signInAdmin(app, container, "ada@identifiedtalent.com", "Ada Admin");
  /** A press from a console row that shows where the request stands now (`from`), unless `extra` says what the row showed. */
  const decide = async (cookie: string, companyId: string, decision: string, extra: Record<string, unknown> = { confirm: true }) => {
    const from = (await statusOf(companyId)) === "declined" ? "declined" : "requested";
    return json(cookie, "POST", `/api/v1/admin/customers/${companyId}/access`, { decision, from, ...extra });
  };
  /** Someone new sends the form; the company's id and slug, and their session. */
  const ask = async (email: string, name: string, extra: Record<string, unknown> = {}) => {
    const cookie = await google(email, "Sam Asker");
    const r = await json(cookie, "POST", "/api/v1/companies", form(name, extra));
    expect(r.status, await r.clone().text()).toBe(201);
    const company = await read<{ id: string; slug: string; accessRequest: { status: string; emailedAt: string | null } }>(r);
    return { cookie, email, ...company };
  };
  const statusOf = async (companyId: string) => (await container.db.select({ status: memberships.status }).from(memberships).where(eq(memberships.companyId, companyId)))[0]?.status;
  const rowOf = async (companyId: string) => (await container.db.select().from(companies).where(eq(companies.id, companyId)))[0];
  const runsOf = (companyId: string) => container.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId));
  const aiRunsOf = (companyId: string) => container.db.select().from(aiRuns).where(eq(aiRuns.companyId, companyId));
  const noticesOf = (companyId: string) => container.db.select().from(notifications).where(eq(notifications.companyId, companyId));
  const eventsOf = (companyId: string, ...types: string[]) => container.db.select().from(events).where(and(eq(events.companyId, companyId), inArray(events.type, types)));
  const alertsOf = (companyId: string) => container.db.select().from(adminAlerts).where(eq(adminAlerts.companyId, companyId));
  const customers = (cookie: string) => json(cookie, "GET", "/api/v1/admin/customers").then((r) => read<Array<{ id: string; name: string; accessRequest: CustomerAccessRequest | null; seats: { used: number; limit: number | null }; roles: number; verifiedAt: string | null; vertical: string; sizeBand: string; locations: Array<{ city?: string; region?: string }>; settings: { website?: string; accessRequestEmailedAt?: string }; createdAt: string }>>(r));
  const mailTo = (to: string) => mail().sent.filter((m) => m.to === to);
  /** A real role of `from`, copied into `companyId` under `title`, open and taking applications: as if the company had one. */
  const plantRole = async (from: string, companyId: string, title: string) => {
    const id = randomUUID();
    await withPlatform(container.db, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, from));
      const [pv] = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, from));
      await tx.insert(roles).values({ ...role, id, companyId, title, status: "open", acceptingApplications: true, openedAt: new Date().toISOString(), currentPacketVersion: pv.version });
      await tx.insert(rolePackets).values({ ...pv, id: randomUUID(), companyId, roleId: id, packet: { ...pv.packet, identity: { ...pv.packet.identity, title } } });
    });
    return id;
  };
  /** A person with an application and an interview on a role, straight into the tables, carrying a marker for a name. */
  const plantPerson = async (companyId: string, roleId: string, mark: string) => withPlatform(container.db, async (tx) => {
    const [person] = await tx.insert(candidates).values({ companyId, firstName: mark, lastName: mark, email: `${mark.toLowerCase()}@people.test`, firstSource: "direct" }).returning();
    const [application] = await tx.insert(applications).values({ companyId, roleId, candidateId: person.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomBytes(16).toString("hex") }).returning();
    const [interview] = await tx.insert(interviews).values({ companyId, applicationId: application.id, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "cancelled", timezone: "America/Los_Angeles" }).returning();
    return { application: application.id, interview: interview.id };
  });
  /** A company through the allow-list's door, with a real open role. */
  const openDirect = async (email: string, name: string) => {
    const cookie = await google(email, "Pat Partner");
    const r = await json(cookie, "POST", "/api/v1/companies", form(name));
    expect(r.status, await r.clone().text()).toBe(201);
    const company = await read<{ id: string; slug: string }>(r);
    const s = await read<{ session: { id: string } }>(await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE }));
    const compiled = await json(cookie, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(compiled.status, await compiled.clone().text()).toBe(201);
    const { roleId } = await read<{ roleId: string }>(compiled);
    expect((await json(cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    return { cookie, id: company.id, slug: company.slug, roleId, session: s.session.id };
  };
  return { container, app, json, read, code, mail, form, google, signupOf, meOf, admin, decide, ask, statusOf, rowOf, runsOf, aiRunsOf, noticesOf, eventsOf, alertsOf, customers, mailTo, plantRole, plantPerson, openDirect };
}

async function boot(check: "its" | "auto", extra: Env = {}): Promise<World> {
  const container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", COMPANY_CHECK: check, AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SIGNUP_MODE: "approval", SIGNUP_ALLOWED_EMAILS: "pat@listed.test, @listed-domain.test", EMAIL_REPLY_TO: "recruiting@its.example", ITS_QUEUE_EMAIL: "queue@its.example", RATE_LIMIT_OVERRIDES: NO_LIMITS, ...extra }));
  return worldOf(container, createApp(container));
}

describe("the third mode (env.ts)", () => {
  const refusal = (source: Env): string | null => {
    try {
      loadEnv(source);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it("reads approval, names it when refusing a misspelling, and the welcome page's reader agrees", () => {
    expect(loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "approval" }).SIGNUP_MODE).toBe("approval");
    expect(signupModeOf({ SIGNUP_MODE: "approval" })).toBe("approval");
    expect(refusal({ NODE_ENV: "test", SIGNUP_MODE: "Approval" })).toMatch(/"approval"/);
    expect(refusal({ NODE_ENV: "test", SIGNUP_MODE: "approved" })).toMatch(/^SIGNUP_MODE must be "open" or "invite" \(it is "approved"\), or "approval"/);
  });

  it("reads the allow-list under approval, with no warning, and the door follows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const env = loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "approval", SIGNUP_ALLOWED_EMAILS: "Pat@Listed.test, @Listed-Domain.TEST" });
      expect(warn).not.toHaveBeenCalled();
      const person = (email: string, platformRole = "none") => ({ email, platformRole });
      expect(signupDoor(env, person("pat@listed.test"))).toBe("direct");
      expect(signupDoor(env, person("Quinn@LISTED-DOMAIN.test"))).toBe("direct");
      expect(signupDoor(env, person("ada@its.test", "platform_admin"))).toBe("direct");
      expect(signupDoor(env, person("sam@stranger.test"))).toBe("request");
      expect(signupDoor(env, person("rita@its.test", "its_recruiter"))).toBe("request");
      const invite = loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "invite", SIGNUP_ALLOWED_EMAILS: "pat@listed.test" });
      expect(signupDoor(invite, person("sam@stranger.test"))).toBe("none");
      expect(signupDoor(invite, person("pat@listed.test"))).toBe("direct");
      expect(signupDoor(loadEnv({ NODE_ENV: "test" }), person("sam@stranger.test"))).toBe("direct");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a person's words are data", () => {
  it("one line, no control character, no longer than asked", () => {
    expect(oneLine("Acme\r\nBcc: evil@example.test")).toBe("Acme Bcc: evil@example.test");
    expect(oneLine(" Acme\n\n\tDental Group\u0000\u0085 ")).toBe("Acme Dental Group");
    expect(oneLine("x".repeat(500))).toHaveLength(200);
    expect(oneLine("x".repeat(500), 10)).toHaveLength(10);
    expect(oneLine(null)).toBe("");
    expect(oneLine(undefined)).toBe("");
  });

  it("a request's details are kept in one line each and within the limits; nothing the form sends changes", () => {
    const body = { name: "Harbor Dental", ownerName: "Sam Asker", vertical: "dental", sizeBand: "1-19" as const, timezone: "America/Chicago", website: "https://harbor.example/about?a=1", locations: [{ city: "Austin", region: "TX", country: "US" }] };
    expect(companyRequestDetails(body)).toEqual({ ...body, locations: [{ city: "Austin", region: "TX", country: "US" }] });
    const hand = companyRequestDetails({ ...body, name: "Harbor\r\nDental", ownerName: "Sam\nAsker", website: `https://x.example/${"y".repeat(5000)}\nBcc: z`, locations: Array.from({ length: 50 }, () => ({ city: `Aus\ntin${"z".repeat(500)}`, region: "T\nX", country: "US" })) });
    expect(hand.name).toBe("Harbor Dental");
    expect(hand.ownerName).toBe("Sam Asker");
    expect(hand.website).toHaveLength(200);
    expect(hand.website).not.toMatch(/\s/);
    // the one place the form sends, and no more: a hand-made body cannot store fifty (the review of 6 November 2026)
    expect(hand.locations).toHaveLength(1);
    expect(hand.locations[0].city).toHaveLength(120);
    expect(hand.locations[0].region).toBe("T X");
    // what is left of a name that was only line breaks is no name
    expect(() => companyRequestDetails({ ...body, name: " \r\n\t " })).toThrow(/missing or invalid/);
  });

  it("the accepted email says the company's name in one line, whatever is in the row", () => {
    const { subject, text } = renderAlertEmail({ kind: "company.access_accepted", recipientName: "Sam Asker", companyName: "Acme\r\nBcc: evil@example.test", roleTitle: null, link: "https://app.example/", appBaseUrl: "https://app.example" });
    expect(subject).toBe("Your request was approved");
    expect(text).toContain("Your request was approved.");
    expect(text).toContain("Company: Acme Bcc: evil@example.test\n");
    expect(text).toContain("Open it: https://app.example/\n");
    expect(text).toContain("This email is always sent");
    expect(text.split("\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
  });
});

describe("whether an email really left", () => {
  const sent = { status: "sent" as const, providerMessageId: "m1" };
  it("the provider took it; the fake on a hosted deployment says so of everything, and that is not enough", () => {
    expect(emailReallyLeft(sent, { status: "live" }, "production")).toBe(true);
    expect(emailReallyLeft(sent, { status: "fake" }, "test")).toBe(true);
    expect(emailReallyLeft(sent, { status: "fake" }, "development")).toBe(true);
    expect(emailReallyLeft(sent, { status: "fake" }, "production")).toBe(false);
    expect(emailReallyLeft({ status: "pending", reason: "no token" }, { status: "not_connected" }, "production")).toBe(false);
    expect(emailReallyLeft({ status: "failed", error: "refused", retryable: false }, { status: "live" }, "production")).toBe(false);
    expect(emailReallyLeft({ status: "failed", error: "cut off", retryable: false, uncertain: true }, { status: "live" }, "production")).toBe(false);
  });
});

describe("first sign-in asks for approval (SIGNUP_MODE=approval, COMPANY_CHECK=its)", () => {
  let w: World;
  let adminCookie = "";

  beforeAll(async () => {
    w = await boot("its");
    adminCookie = await w.admin();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("the configuration says which door each person has, and never the list", async () => {
    const signedOut = await w.signupOf();
    expect(signedOut).toEqual({ mode: "approval", allowed: false, contact: "recruiting@its.example", door: "none" });
    const stranger = await w.signupOf(await w.google("first.look@stranger.test"));
    expect(stranger).toEqual({ mode: "approval", allowed: true, contact: "recruiting@its.example", door: "request" });
    expect((await w.signupOf(await w.google("pat.first@listed-domain.test"))).door).toBe("direct");
    expect((await w.signupOf(adminCookie)).door).toBe("direct");
    expect(JSON.stringify([signedOut, stranger])).not.toMatch(/listed/);
  });

  it("the full journey: the form sends a request, nothing starts, Accept opens everything", async () => {
    const before = w.mail().sent.length;
    const asker = await w.ask("sam@stranger.test", "Harbor Dental");
    // the answer says where they stand, and the email really left
    expect(asker.accessRequest).toMatchObject({ status: "requested", companyName: "Harbor Dental", email: "sam@stranger.test" });
    expect(asker.accessRequest.emailedAt).toEqual(expect.any(String));
    // a request is a company with its owner's membership `requested`, on Free, unconfirmed, its entitlements there and counting nothing
    expect(await w.statusOf(asker.id)).toBe("requested");
    const row = await w.rowOf(asker.id);
    expect(row.planKey).toBe(FREE_PLAN_KEY);
    expect(row.settings.verifiedAt).toBeUndefined();
    expect(row.settings.accessRequestEmailedAt).toBe(asker.accessRequest.emailedAt);
    expect(row.settings.website).toBe("https://asker.example");
    expect((await w.container.db.select().from(entitlements).where(eq(entitlements.companyId, asker.id))).every((e) => e.used === 0)).toBe(true);
    // no active company, no tenant, and nothing started
    const me = await w.meOf(asker.cookie);
    expect(me.activeCompanyId).toBeNull();
    expect(me.memberships).toEqual([]);
    expect((await w.container.db.select({ active: sessions.activeCompanyId }).from(sessions).where(eq(sessions.userId, me.user.id))).every((s) => s.active === null)).toBe(true);
    expect(await w.code(await w.json(asker.cookie, "GET", "/api/v1/companies/current"))).toBe("no_company");
    expect(await w.runsOf(asker.id)).toEqual([]);
    expect(await w.aiRunsOf(asker.id)).toEqual([]);
    expect(await w.noticesOf(asker.id)).toEqual([]);
    expect(await w.container.db.select().from(jobs).where(sql`${jobs.payload}->>'companyId' = ${asker.id}`)).toEqual([]);
    // signing in again opens no company either, so the browser lands on the same step
    const signIn = async () => {
      const accessToken = (w.container.integrations.identity as FakeIdentityProvider).mint({ email: "sam@stranger.test", provider: "google" });
      return w.read<{ activeCompanyId: string | null }>(await w.app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken }) }));
    };
    expect((await signIn()).activeCompanyId).toBeNull();
    // the configuration says the state of their request, with the same date
    expect(await w.signupOf(asker.cookie)).toEqual({ mode: "approval", allowed: false, contact: "recruiting@its.example", door: "request", request: { status: "requested", companyName: "Harbor Dental", email: "sam@stranger.test", emailedAt: asker.accessRequest.emailedAt } });
    // the person's email and ITS's, and no other
    const sent = w.mail().sent.slice(before);
    expect(sent.map((m) => m.to).sort()).toEqual(["queue@its.example", "sam@stranger.test"]);
    const copy = sent.find((m) => m.to === "sam@stranger.test")!;
    expect(copy.subject).toBe("Your request has been sent");
    expect(copy.text).toContain("Thanks");
    expect(copy.text).toContain("Harbor Dental");
    expect(copy.text).toContain("Please wait for approval.");
    expect(copy.text).toContain("ITS reviews each company, usually within one business day");
    expect(copy.text).toContain("we will email you when it is decided");
    const toIts = sent.find((m) => m.to === "queue@its.example")!;
    expect(toIts.subject).toBe("[access request] Harbor Dental is asking for access");
    for (const line of ["Company: Harbor Dental", "Person: Sam Asker <sam@stranger.test>", "Kind of business: dental", "Size: 1-19 employees", "City and state: Austin, TX", "Website: https://asker.example", `${w.container.env.APP_BASE_URL}/admin`]) expect(toIts.text, line).toContain(line);
    expect(sent.some((m) => m.subject.includes("[company check]"))).toBe(false);

    // Nadine's list: the person, and what the row needs
    const listed = (await w.customers(adminCookie)).find((c) => c.id === asker.id)!;
    expect(listed.accessRequest).toEqual({ status: "requested", person: { name: "Sam Asker", email: "sam@stranger.test" }, declined: null });
    expect(listed).toMatchObject({ name: "Harbor Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Austin", region: "TX" }], settings: { website: "https://asker.example", accessRequestEmailedAt: asker.accessRequest.emailedAt } });
    expect(listed.createdAt).toEqual(expect.any(String));
    expect(listed.seats.used).toBe(0);
    expect(listed.verifiedAt).toBeNull();
    expect((await w.customers(adminCookie)).filter((c) => c.id !== asker.id).every((c) => c.accessRequest === null)).toBe(true);

    // Accept
    const accepted = await w.decide(adminCookie, asker.id, "accept");
    expect(accepted.status).toBe(200);
    expect(await w.read<CustomerAccessAnswer>(accepted)).toEqual({ ok: true, companyId: asker.id, decision: "accept", status: "active", changed: true, message: "Harbor Dental was accepted." });
    // no draining here: the route kicks the worker itself, as the verification route does
    expect(await w.statusOf(asker.id)).toBe("active");
    const after = await w.rowOf(asker.id);
    // on Free, and the one approval counts as the one-time check: confirmed by the administrator who pressed
    expect(after.planKey).toBe(FREE_PLAN_KEY);
    expect(after.settings.verifiedAt).toEqual(expect.any(String));
    expect(after.settings.verifiedBy).toMatchObject({ kind: "user", name: "Ada Admin" });
    // exactly one notice, to the owner, and never "ITS confirmed your company" as well
    const notices = await w.noticesOf(asker.id);
    expect(notices.map((n) => [n.kind, n.title])).toEqual([["company.access_accepted", "Your request was approved"]]);
    expect(notices[0].userId).toBe(me.user.id);
    expect(notices[0].action).toEqual({ label: "Open Home", href: "/" });
    expect(w.mailTo("sam@stranger.test").filter((m) => m.subject === "Your request was approved")).toHaveLength(1);
    const email = w.mailTo("sam@stranger.test").find((m) => m.subject === "Your request was approved")!;
    expect(email.text).toContain("Your request was approved.");
    expect(email.text).toContain(`Open it: ${w.container.env.APP_BASE_URL}/`);
    expect(w.mailTo("sam@stranger.test").some((m) => m.subject.includes("ITS confirmed"))).toBe(false);
    // one workflow, and it is the daily check
    expect((await w.runsOf(asker.id)).filter((r) => r.workflowKey === "stuck_role_detector")).toHaveLength(1);
    // recorded: accepted and confirmed, by the administrator, with the stock reason
    const audited = await w.container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, asker.id), inArray(auditRecords.action, ["company.access_accepted", "company.verified"])));
    expect(audited.map((a) => a.action).sort()).toEqual(["company.access_accepted", "company.verified"]);
    for (const a of audited) {
      expect(a.reason).toBe("Accepted from the console");
      expect(a.actor).toMatchObject({ kind: "user", name: "Ada Admin" });
    }
    expect(await w.eventsOf(asker.id, "company.access_accepted")).toHaveLength(1);
    expect(await w.eventsOf(asker.id, "company.verified")).toHaveLength(1);
    // their waiting screen moves on by itself: the same session now has the tenant, with no reload of anything
    const open = await w.meOf(asker.cookie);
    expect(open.activeCompanyId).toBe(asker.id);
    expect(open.memberships).toEqual([expect.objectContaining({ companyId: asker.id, role: "owner" })]);
    expect((await signIn()).activeCompanyId).toBe(asker.id);
    const current = await w.json(asker.cookie, "GET", "/api/v1/companies/current");
    expect(current.status).toBe(200);
    expect(await w.read<{ planKey: string; id: string }>(current)).toMatchObject({ id: asker.id, planKey: FREE_PLAN_KEY });
    expect((await w.json(asker.cookie, "GET", "/api/v1/brief")).status).toBe(200);
    expect((await w.json(asker.cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE })).status).toBe(201);
    // and it is confirmed, so its public side is up
    expect((await w.app.request(`/careers/${asker.slug}`)).status).toBe(200);
    // the configuration has moved on too
    expect((await w.signupOf(asker.cookie)).request).toBeUndefined();
    expect((await w.customers(adminCookie)).find((c) => c.id === asker.id)).toMatchObject({ accessRequest: null, seats: { used: 1 } });
    // the customer's own history says it in plain words
    const history = await w.read<Array<{ action: string; description: string }>>(await w.json(asker.cookie, "GET", "/api/v1/companies/current/audit?actions=company.access_accepted"));
    expect(history.map((h) => h.description)).toEqual(["ITS accepted your request for access."]);
  });

  it("one account makes one request, even two sent at the same moment; a bad body still answers 400", async () => {
    const cookie = await w.google("once@stranger.test");
    expect((await w.json(cookie, "POST", "/api/v1/companies", { name: "" })).status).toBe(400);
    const [one, two] = await Promise.all([w.json(cookie, "POST", "/api/v1/companies", w.form("Once Dental")), w.json(cookie, "POST", "/api/v1/companies", w.form("Twice Dental"))]);
    expect([one.status, two.status].sort()).toEqual([201, 409]);
    const again = await w.json(cookie, "POST", "/api/v1/companies", w.form("Third Dental"));
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "another_company_needs_its", message: "To open another company, contact ITS." } });
    const me = await w.meOf(cookie);
    expect(await w.container.db.select().from(memberships).where(eq(memberships.userId, me.user.id))).toHaveLength(1);
    expect(await w.container.db.select().from(companies).where(inArray(companies.name, ["Third Dental"]))).toEqual([]);
  });

  it("Decline stops there, politely; a declined person cannot send a second one; Accept afterwards is the undo", async () => {
    const asker = await w.ask("dee@stranger.test", "Declined Dental");
    const declined = await w.decide(adminCookie, asker.id, "decline");
    expect(declined.status).toBe(200);
    expect(await w.read<CustomerAccessAnswer>(declined)).toMatchObject({ status: "declined", changed: true });
    await w.container.drain();
    expect(await w.statusOf(asker.id)).toBe("declined");
    expect(await w.code(await w.json(asker.cookie, "GET", "/api/v1/companies/current"))).toBe("no_company");
    expect((await w.meOf(asker.cookie)).activeCompanyId).toBeNull();
    expect(await w.runsOf(asker.id)).toEqual([]);
    expect(await w.noticesOf(asker.id)).toEqual([]);
    expect((await w.rowOf(asker.id)).settings.verifiedAt).toBeUndefined();
    const emailed = w.mailTo("dee@stranger.test").find((m) => m.subject === "We can't offer access right now")!;
    expect(emailed.text).toContain("We can't offer access right now.");
    expect(emailed.text).toContain("Questions? recruiting@its.example");
    expect(emailed.text).toContain("Declined Dental");
    // the screen reads where they stand; no second request
    expect(await w.signupOf(asker.cookie)).toMatchObject({ allowed: false, request: { status: "declined", companyName: "Declined Dental" } });
    const second = await w.json(asker.cookie, "POST", "/api/v1/companies", w.form("Another Try"));
    expect(second.status).toBe(409);
    expect(await w.code(second)).toBe("another_company_needs_its");
    // the console shows when and by whom
    const listed = (await w.customers(adminCookie)).find((c) => c.id === asker.id)!;
    expect(listed.accessRequest?.status).toBe("declined");
    expect(listed.accessRequest?.declined).toEqual({ at: expect.any(String), by: "Ada Admin" });
    const audited = await w.container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, asker.id), eq(auditRecords.action, "company.access_declined")));
    expect(audited).toHaveLength(1);
    expect(audited[0].reason).toBe("Declined from the console");
    expect(await w.eventsOf(asker.id, "company.access_declined")).toHaveLength(1);
    // a second press changes nothing, and sends nothing
    const mails = w.mailTo("dee@stranger.test").length;
    const again = await w.decide(adminCookie, asker.id, "decline");
    expect(await w.read<CustomerAccessAnswer>(again)).toMatchObject({ status: "declined", changed: false, message: "Declined Dental was already declined. Nothing changed." });
    expect(await w.eventsOf(asker.id, "company.access_declined")).toHaveLength(1);
    expect(w.mailTo("dee@stranger.test")).toHaveLength(mails);
    // the undo
    const undone = await w.decide(adminCookie, asker.id, "accept");
    expect(await w.read<CustomerAccessAnswer>(undone)).toMatchObject({ status: "active", changed: true });
    await w.container.drain();
    expect(await w.statusOf(asker.id)).toBe("active");
    expect((await w.meOf(asker.cookie)).activeCompanyId).toBe(asker.id);
    expect((await w.noticesOf(asker.id)).map((n) => n.kind)).toEqual(["company.access_accepted"]);
    expect((await w.eventsOf(asker.id, "company.access_accepted"))[0].payload).toEqual({ from: "declined" });
    expect((await w.customers(adminCookie)).find((c) => c.id === asker.id)?.accessRequest).toBeNull();
    expect((await w.rowOf(asker.id)).settings.verifiedAt).toEqual(expect.any(String));
  });

  it("two administrators pressing at once change one thing, and the second is told calmly", async () => {
    const asker = await w.ask("both@stranger.test", "Both Dental");
    const results = await Promise.all([w.decide(adminCookie, asker.id, "accept"), w.decide(adminCookie, asker.id, "accept")]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const answers = await Promise.all(results.map((r) => w.read<CustomerAccessAnswer>(r)));
    expect(answers.map((a) => a.changed).sort()).toEqual([false, true]);
    expect(answers.find((a) => !a.changed)).toMatchObject({ status: "active", message: "Both Dental already has access. Nothing changed." });
    await w.container.drain();
    expect(await w.eventsOf(asker.id, "company.access_accepted")).toHaveLength(1);
    expect(await w.eventsOf(asker.id, "company.verified")).toHaveLength(1);
    expect(await w.noticesOf(asker.id)).toHaveLength(1);
    expect((await w.runsOf(asker.id)).filter((r) => r.workflowKey === "stuck_role_detector")).toHaveLength(1);
    expect(w.mailTo("both@stranger.test").filter((m) => m.subject === "Your request was approved")).toHaveLength(1);
    // a later press changes nothing and says so; a Decline now is a 409
    expect(await w.read<CustomerAccessAnswer>(await w.decide(adminCookie, asker.id, "accept"))).toMatchObject({ changed: false, status: "active" });
    const late = await w.decide(adminCookie, asker.id, "decline");
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: { code: "already_accepted", message: "Both Dental already has access, so it cannot be declined now." } });
    expect(await w.statusOf(asker.id)).toBe("active");

    // two Declines at once: one change, one email
    const twice = await w.ask("twice@stranger.test", "Twice Declined");
    const declines = await Promise.all([w.decide(adminCookie, twice.id, "decline"), w.decide(adminCookie, twice.id, "decline")]);
    const said = await Promise.all(declines.map((r) => w.read<CustomerAccessAnswer>(r)));
    expect(said.map((a) => a.changed).sort()).toEqual([false, true]);
    expect(await w.eventsOf(twice.id, "company.access_declined")).toHaveLength(1);
    expect(w.mailTo("twice@stranger.test").filter((m) => m.subject === "We can't offer access right now")).toHaveLength(1);

    // an Accept and a Decline at once, from two rows that both showed the request: the first press wins, once, and the
    // second changes nothing and is told so (the review of 6 November 2026; it used to be that Accept always won)
    const race = await w.ask("race@stranger.test", "Race Dental");
    const shown = { from: "requested", confirm: true };
    const raced = await Promise.all([w.decide(adminCookie, race.id, "accept", shown), w.decide(adminCookie, race.id, "decline", shown)]);
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409]);
    const second = raced.find((r) => r.status === 409)!;
    expect(["already_accepted", "access_decided"]).toContain(await w.code(second));
    await w.container.drain();
    const won = await w.statusOf(race.id);
    expect(["active", "declined"]).toContain(won);
    expect(await w.eventsOf(race.id, "company.access_accepted")).toHaveLength(won === "active" ? 1 : 0);
    expect(await w.eventsOf(race.id, "company.access_declined")).toHaveLength(won === "declined" ? 1 : 0);
    expect(await w.noticesOf(race.id)).toHaveLength(won === "active" ? 1 : 0);
    // the person hears the decision that stands, and only that one
    expect(w.mailTo("race@stranger.test").map((m) => m.subject).filter((s) => s !== "Your request has been sent")).toEqual([won === "active" ? "Your request was approved" : "We can't offer access right now"]);
  });

  it("the first press wins: an Accept from a row that still showed the request, once it was declined, changes nothing and says who declined it and when", async () => {
    const asker = await w.ask("stale@stranger.test", "Stale Dental");
    const shown = { from: "requested", confirm: true };
    // one console declines; another, not looked at again, still shows the request with Accept
    expect((await w.decide(adminCookie, asker.id, "decline", shown)).status).toBe(200);
    const stale = await w.decide(adminCookie, asker.id, "accept", shown);
    expect(stale.status).toBe(409);
    const error = ((await stale.json()) as { error: { code: string; message: string; details: unknown } }).error;
    expect(error.code).toBe("access_decided");
    expect(error.message).toBe("Stale Dental was declined a moment ago by Ada Admin. Nothing changed. To let them in, accept it under Declined.");
    expect(error.details).toEqual({ status: "declined", decidedAt: expect.any(String), decidedBy: "Ada Admin" });
    await w.container.drain();
    // nothing moved: still declined and unconfirmed, no Accept, no notice, no workflow, and one email, the Decline's
    expect(await w.statusOf(asker.id)).toBe("declined");
    expect((await w.rowOf(asker.id)).settings.verifiedAt).toBeUndefined();
    expect(await w.eventsOf(asker.id, "company.access_accepted")).toEqual([]);
    expect(await w.noticesOf(asker.id)).toEqual([]);
    expect(await w.runsOf(asker.id)).toEqual([]);
    expect(w.mailTo("stale@stranger.test").map((m) => m.subject)).toEqual(["Your request has been sent", "We can't offer access right now"]);
    // a row left open for hours says how long ago, in words that need no time zone
    const hoursAgo = new Date(w.container.engine.clock().getTime() - 3 * 3_600_000 - 60_000).toISOString();
    await withPlatform(w.container.db, (tx) => tx.update(events).set({ occurredAt: hoursAgo }).where(and(eq(events.companyId, asker.id), eq(events.type, "company.access_declined"))));
    expect(((await (await w.decide(adminCookie, asker.id, "accept", shown)).json()) as { error: { message: string } }).error.message).toBe("Stale Dental was declined 3 hours ago by Ada Admin. Nothing changed. To let them in, accept it under Declined.");
    // a second Decline from the same stale row stays a calm "nothing changed"
    expect(await w.read<CustomerAccessAnswer>(await w.decide(adminCookie, asker.id, "decline", shown))).toMatchObject({ status: "declined", changed: false });
    // the declined company's own Accept, under Declined, is still the undo
    const undone = await w.decide(adminCookie, asker.id, "accept", { from: "declined", confirm: true });
    expect(undone.status).toBe(200);
    expect(await w.read<CustomerAccessAnswer>(undone)).toMatchObject({ status: "active", changed: true });
    await w.container.drain();
    expect(w.mailTo("stale@stranger.test").filter((m) => m.subject === "Your request was approved")).toHaveLength(1);
    // and a declined row's Accept on a request still waiting (no console draws one) is refused the same way
    const waiting = await w.ask("still.waiting@stranger.test", "Still Waiting Dental");
    const odd = await w.decide(adminCookie, waiting.id, "accept", { from: "declined", confirm: true });
    expect(odd.status).toBe(409);
    expect(await w.code(odd)).toBe("access_decided");
    expect(await w.statusOf(waiting.id)).toBe("requested");
  });

  it("a decision holds the company's row until it commits, which is what makes the second press wait and then read the first", async () => {
    // PGlite runs one connection, so it cannot show a second transaction waiting (on Postgres, the presses above race for
    // real). What it can show is the row lock itself: a row locked FOR UPDATE carries the locking transaction's id in xmax.
    const asker = await w.ask("locked@stranger.test", "Locked Dental");
    const actor = { kind: "user" as const, id: "ada", name: "Ada Admin" };
    await withPlatform(w.container.db, async (tx) => {
      const lock = async () => {
        const result: unknown = await tx.execute(sql`select xmax::text as xmax, pg_current_xact_id()::text as me from companies where id = ${asker.id}`);
        return ((Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ xmax: string; me: string }>)[0];
      };
      expect((await lock()).xmax).toBe("0");
      await decideAccess(tx, w.container, { companyId: asker.id, decision: "decline", from: "requested", actor, now: w.container.engine.clock() });
      const held = await lock();
      expect(held.xmax).toBe(held.me);
    });
    expect(await w.statusOf(asker.id)).toBe("declined");
  });

  it("only a platform administrator with a second factor, a confirmation, and a real company", async () => {
    const asker = await w.ask("guarded@stranger.test", "Guarded Dental");
    const body = { decision: "accept", from: "requested", confirm: true };
    expect((await w.json("", "POST", `/api/v1/admin/customers/${asker.id}/access`, body)).status).toBe(401);
    // the person themselves, another customer, an ITS recruiter
    expect(await w.code(await w.json(asker.cookie, "POST", `/api/v1/admin/customers/${asker.id}/access`, body))).toBe("forbidden");
    expect((await w.json(asker.cookie, "POST", `/api/v1/admin/customers/${asker.id}/access`, body)).status).toBe(403);
    const recruiter = await signInStaff(w.app, w.container, "rae@identifiedtalent.com", "its_recruiter", "Rae Recruiter");
    expect((await w.json(recruiter, "POST", `/api/v1/admin/customers/${asker.id}/access`, body)).status).toBe(403);
    // an administrator whose session carries no second factor
    const second = await signInAdmin(w.app, w.container, "second.admin@identifiedtalent.com", "Second Admin");
    await withPlatform(w.container.db, (tx) => tx.update(sessions).set({ aal: "aal1" }).where(sql`${sessions.userId} = (select id from users where email = 'second.admin@identifiedtalent.com')`));
    const noFactor = await w.json(second, "POST", `/api/v1/admin/customers/${asker.id}/access`, body);
    expect(noFactor.status).toBe(403);
    expect(await w.code(noFactor)).toBe("mfa_required");
    // a bad body changes nothing
    // what the row showed is part of the press: without it, or with anything but a request's two states, nothing happens
    for (const bad of [{ decision: "accept", from: "requested" }, { decision: "accept", from: "requested", confirm: false }, { decision: "maybe", from: "requested", confirm: true }, { decision: "accept", from: "requested", confirm: true, reason: "no reason is typed" }, { decision: "accept", confirm: true }, { decision: "accept", from: "active", confirm: true }, {}]) {
      const r = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${asker.id}/access`, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await w.code(r)).toBe("invalid_request");
    }
    expect((await w.json(adminCookie, "POST", `/api/v1/admin/customers/${randomUUID()}/access`, body)).status).toBe(404);
    expect((await w.json(adminCookie, "POST", "/api/v1/admin/customers/not-a-uuid/access", body)).status).toBe(404);
    expect(await w.statusOf(asker.id)).toBe("requested");
    // audited like its neighbours: the administrator's call is on the record, with the route
    await w.decide(adminCookie, asker.id, "decline");
    const bypass = await w.container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "admin.bypass"), sql`${auditRecords.reason} like ${`POST /api/v1/admin/customers/${asker.id}/access%`}`));
    expect(bypass.length).toBeGreaterThanOrEqual(1);
  });

  it("the verification route, and every other console action on a customer, refuses a request and a declined company; none lets anyone in", async () => {
    const waiting = await w.ask("console.waiting@stranger.test", "Console Waiting");
    const declined = await w.ask("console.declined@stranger.test", "Console Declined");
    await w.decide(adminCookie, declined.id, "decline");
    const actions: Array<[string, string, (id: string) => unknown]> = [
      ["confirm", "/verification", () => ({ verified: true, reason: "Checked the website.", confirm: true })],
      ["take back", "/verification", () => ({ verified: false, reason: "Checked the website.", confirm: true })],
      ["job boards", "/job-boards", () => ({ confirmed: true })],
      ["apply flow", "/apply-flow", () => ({ applyFlow: "one_visit", reason: "A pilot company." })],
      ["trial", "/trial", () => ({ days: 10, reason: "A longer look.", confirm: true })],
      ["candidate score", "/candidate-score", () => ({ shown: false, reason: "Asked by counsel." })],
      ["plan", "/plan", () => ({ planKey: "basic", reason: "A bigger plan." })],
    ];
    for (const { id, cookie } of [waiting, declined]) {
      const before = await w.rowOf(id);
      const history = (await w.container.db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.companyId, id)))[0].n;
      for (const [what, suffix, body] of actions) {
        const r = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${id}${suffix}`, body(id));
        expect(r.status, what).toBe(409);
        const error = ((await r.json()) as { error: { code: string; message: string; details: { path: string } } }).error;
        expect(error.code, what).toBe("access_request_open");
        expect(error.message, what).toMatch(/^This company/);
        expect(error.details.path, what).toBe(`/api/v1/admin/customers/${id}/access`);
      }
      const glass = await w.json(adminCookie, "POST", "/api/v1/admin/break-glass", { companyId: id, reason: "An emergency, in a test.", minutes: 5 });
      expect(glass.status).toBe(409);
      expect(await w.code(glass)).toBe("access_request_open");
      // reads answer, and say nothing odd
      const report = await w.json(adminCookie, "GET", `/api/v1/admin/customers/${id}/report`);
      expect(report.status).toBe(200);
      // signing the person out works, and is no door
      expect((await w.json(adminCookie, "POST", "/api/v1/admin/sessions/revoke", { email: (await w.container.db.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.companyId, id)))[0].email, reason: "A lost phone.", confirm: true })).status).toBe(200);
      expect((await w.json(cookie, "GET", "/api/v1/auth/me")).status).toBe(401);
      // nothing moved: the row, the history, no alert, nobody told, nobody in
      expect(await w.rowOf(id)).toEqual(before);
      expect((await w.container.db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.companyId, id)))[0].n).toBe(history);
      expect(await w.alertsOf(id)).toEqual([]);
      expect(await w.noticesOf(id)).toEqual([]);
      expect(await w.runsOf(id)).toEqual([]);
    }
    expect(await w.statusOf(waiting.id)).toBe("requested");
    expect(await w.statusOf(declined.id)).toBe("declined");
    // Accepted, each action is open again
    await w.decide(adminCookie, waiting.id, "accept");
    const plan = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${waiting.id}/plan`, { planKey: "basic", reason: "A bigger plan." });
    expect(plan.status).toBe(200);
    const taken = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${waiting.id}/verification`, { verified: false, reason: "A doubt about the company.", confirm: true });
    expect(taken.status).toBe(200);
    // and the accepted company's status for Accept stays "nobody is waiting", even with the confirmation taken back
    expect(await w.read<CustomerAccessAnswer>(await w.decide(adminCookie, waiting.id, "accept"))).toMatchObject({ changed: false, status: "active" });
    expect((await w.rowOf(waiting.id)).settings.verifiedAt).toBeUndefined();
  });

  it("Accept of a company already confirmed sends the same one notice, with no second confirmation", async () => {
    const asker = await w.ask("confirmed@stranger.test", "Confirmed Already");
    await withPlatform(w.container.db, (tx) => tx.update(companies).set({ settings: sql`${companies.settings} || jsonb_build_object('verifiedAt', '2026-11-01T00:00:00.000Z'::text)` }).where(eq(companies.id, asker.id)));
    expect((await w.decide(adminCookie, asker.id, "accept")).status).toBe(200);
    await w.container.drain();
    expect((await w.rowOf(asker.id)).settings.verifiedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(await w.eventsOf(asker.id, "company.verified")).toEqual([]);
    expect((await w.noticesOf(asker.id)).map((n) => n.kind)).toEqual(["company.access_accepted"]);
    expect(w.mailTo("confirmed@stranger.test").filter((m) => m.subject === "Your request was approved")).toHaveLength(1);
  });

  it("a failed email changes nothing and raises no alert; accessRequestEmailedAt is set only when the send really left", async () => {
    // the provider refuses both of the request's emails
    w.mail().failNext(2);
    const failed = await w.ask("nomail@stranger.test", "No Mail Dental");
    expect(failed.accessRequest.emailedAt).toBeNull();
    expect(await w.statusOf(failed.id)).toBe("requested");
    expect((await w.rowOf(failed.id)).settings.accessRequestEmailedAt).toBeUndefined();
    expect((await w.signupOf(failed.cookie)).request).toMatchObject({ status: "requested", emailedAt: null });
    expect(await w.alertsOf(failed.id)).toEqual([]);
    expect(await w.container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "company.check_notice_failed"))).toEqual([]);
    // the Overview row is what tells Nadine
    expect((await w.customers(adminCookie)).find((c) => c.id === failed.id)?.accessRequest?.status).toBe("requested");

    // only the person's copy fails: ITS still hears, and the screen still makes no claim
    w.mail().failNext(1);
    const half = await w.ask("half@stranger.test", "Half Mail Dental");
    expect(half.accessRequest.emailedAt).toBeNull();
    expect(w.mailTo("half@stranger.test")).toEqual([]);
    expect(w.mailTo("queue@its.example").map((m) => m.subject)).toContain("[access request] Half Mail Dental is asking for access");

    // a send that throws, a provider that is not set up, and a reply that was cut off: none of them is "it left"
    const quietLog = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const realSend = vi.spyOn(w.mail(), "send");
    for (const [i, answer] of ([() => Promise.reject(new Error("boom")), () => Promise.resolve({ status: "pending", reason: "Postmark server token not configured" }), () => Promise.resolve({ status: "failed", error: "cut off", retryable: false, uncertain: true })] as const).entries()) {
      realSend.mockImplementation(answer as never);
      const asker = await w.ask(`odd${i}@stranger.test`, `Odd Mail ${i}`);
      expect(asker.accessRequest.emailedAt).toBeNull();
      expect((await w.rowOf(asker.id)).settings.accessRequestEmailedAt).toBeUndefined();
      expect(await w.alertsOf(asker.id)).toEqual([]);
      // and the decision goes through while the provider is still down
      expect((await w.decide(adminCookie, asker.id, "decline")).status).toBe(200);
      expect(await w.statusOf(asker.id)).toBe("declined");
      expect(await w.alertsOf(asker.id)).toEqual([]);
    }
    realSend.mockRestore();
    expect(quietLog).toHaveBeenCalledWith(expect.stringContaining("could not be sent: boom"));
    quietLog.mockRestore();

    // Accept while the provider is down: everything happens, and the notice's email, tried until it gives up, raises nothing
    w.mail().failNext(1_000);
    try {
      expect((await w.decide(adminCookie, failed.id, "accept")).status).toBe(200);
      await w.container.drain();
      expect(await w.statusOf(failed.id)).toBe("active");
      expect((await w.meOf(failed.cookie)).activeCompanyId).toBe(failed.id);
      expect((await w.noticesOf(failed.id)).map((n) => n.kind)).toEqual(["company.access_accepted"]);
      const [row] = await w.container.db.select().from(communications).where(and(eq(communications.companyId, failed.id), eq(communications.templateKey, "notification_alert")));
      expect(row.tags).toMatchObject({ quietOnFailure: "true" });
      expect(row.status).toBe("queued");
      expect(await sendQueuedCommunication(w.container.db, w.container.integrations, { communicationId: row.id, companyId: failed.id }, { attempt: SEND_MAX_ATTEMPTS, maxAttempts: SEND_MAX_ATTEMPTS, now: w.container.engine.clock() })).toBe("failed");
      expect(await w.alertsOf(failed.id)).toEqual([]);
      // a send interrupted by a crash reads as unknown for the record, and raises nothing either
      const crashed = await w.ask("crashed@stranger.test", "Crashed Dental");
      expect((await w.decide(adminCookie, crashed.id, "accept")).status).toBe(200);
      await w.container.drain();
      const old = new Date(w.container.engine.clock().getTime() - 3_600_000).toISOString();
      await withPlatform(w.container.db, (tx) => tx.update(communications).set({ status: "sending", sendingAt: old }).where(eq(communications.companyId, crashed.id)));
      expect(await sweepStaleSending(w.container.db, w.container.engine.clock())).toBeGreaterThanOrEqual(1);
      expect((await w.container.db.select().from(communications).where(eq(communications.companyId, crashed.id)))[0].status).toBe("unknown");
      expect(await w.alertsOf(crashed.id)).toEqual([]);
      expect(await w.container.db.select().from(adminAlerts).where(inArray(adminAlerts.kind, ["message.delivery_failed", "message.delivery_unknown", "company.check_notice_failed"]))).toEqual([]);
    } finally {
      w.mail().failNext(0);
    }

    // a reply that was cut off: never sent again on a guess, and the same
    const cutOff = await w.ask("cutoff@stranger.test", "Cut Off Dental");
    const cut = vi.spyOn(w.mail(), "send").mockResolvedValue({ status: "failed", error: "cut off", retryable: false, uncertain: true });
    expect((await w.decide(adminCookie, cutOff.id, "accept")).status).toBe(200);
    await w.container.drain();
    cut.mockRestore();
    expect((await w.container.db.select().from(communications).where(eq(communications.companyId, cutOff.id)))[0].status).toBe("unknown");
    expect(await w.alertsOf(cutOff.id)).toEqual([]);

    // the door that goes in directly keeps its alert: a company waiting for the ITS check must not wait unseen
    w.mail().failNext(1);
    const pat = await w.google("pat@listed.test", "Pat Partner");
    const made = await w.json(pat, "POST", "/api/v1/companies", w.form("Listed Dental"));
    expect(made.status).toBe(201);
    const listed = await w.read<{ id: string }>(made);
    expect((await w.alertsOf(listed.id)).map((a) => a.kind)).toEqual(["company.check_notice_failed"]);
  });

  it("on a hosted deployment still on the fake adapter, which reports every email sent, no claim about email is kept", async () => {
    const [user] = await w.container.db.insert(users).values({ email: "staging.person@stranger.test", name: "Staging Person" }).returning();
    const real = w.container.env.NODE_ENV;
    w.container.env.NODE_ENV = "production";
    try {
      const answer = await sendAccessRequest(w.container, { body: CreateCompany.parse(w.form("Staging Dental")), user: { id: user.id, email: user.email, name: user.name }, actor: { kind: "user", id: user.id, name: "Staging Person" } });
      expect(answer.accessRequest).toMatchObject({ status: "requested", emailedAt: null });
      expect((await w.rowOf(answer.id)).settings.accessRequestEmailedAt).toBeUndefined();
      // the fake did keep it, as it keeps everything: it did not leave
      expect(w.mailTo("staging.person@stranger.test").map((m) => m.subject)).toEqual(["Your request has been sent"]);
    } finally {
      w.container.env.NODE_ENV = real;
    }
  });

  it("a person's words cannot break an email: a line break and a very long value in the name, the website and their own name", async () => {
    const typed = await w.ask("typed@stranger.test", "Acme\r\nBcc: evil@example.test", { ownerName: "Sam\r\nAsker", website: `https://acme.example/${"y".repeat(5000)}\r\nBcc: evil@example.test`, vertical: "den\ntal", locations: [{ city: "Aus\r\ntin", region: "T\nX", country: "US" }] });
    const row = await w.rowOf(typed.id);
    expect(row.name).toBe("Acme Bcc: evil@example.test");
    expect(row.settings.website).toHaveLength(200);
    const sent = [...w.mailTo("typed@stranger.test"), ...w.mailTo("queue@its.example").filter((m) => m.subject.includes("Acme"))];
    expect(sent).toHaveLength(2);
    for (const m of sent) {
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.subject.length).toBeLessThan(200);
      // every line of the body is one of the lines the email means to have: nothing typed started a line of its own
      expect(m.text).not.toMatch(/\r/);
      expect(m.text.split("\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
      expect(m.text.length).toBeLessThan(1_000);
    }
    const toIts = sent.find((m) => m.to === "queue@its.example")!;
    expect(toIts.subject).toBe("[access request] Acme Bcc: evil@example.test is asking for access");
    expect(toIts.text).toContain("Person: Sam Asker <typed@stranger.test>");
    expect(toIts.text).toContain("City and state: Aus tin, T X");
    expect(toIts.text.split("\n").find((l) => l.startsWith("Website: "))!.length).toBeLessThanOrEqual(209);
    // the door that goes in directly keeps what was typed, as in every mode, and its email to ITS is one line each all the same
    const direct = await w.google("typed.direct@listed-domain.test", "Typed Direct");
    expect((await w.json(direct, "POST", "/api/v1/companies", w.form("Direct\r\nBcc: evil@example.test", { website: `https://direct.example/${"y".repeat(5000)}\r\nBcc: evil@example.test` }))).status).toBe(201);
    const check = w.mailTo("queue@its.example").find((m) => m.subject.includes("[company check] Direct"))!;
    expect(check.subject).toBe("[company check] Direct Bcc: evil@example.test is waiting for the ITS check");
    expect(check.text.split("\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
    expect(check.text.length).toBeLessThan(1_000);
    // a name past the form's own limit is refused before anything is made, as in every mode
    const cookie = await w.google("toolong@stranger.test");
    expect((await w.json(cookie, "POST", "/api/v1/companies", w.form("x".repeat(121)))).status).toBe(400);
    expect((await w.json(cookie, "POST", "/api/v1/companies", w.form(" \r\n "))).status).toBe(400);
    // the decisions' emails carry the same one line
    await w.decide(adminCookie, typed.id, "decline");
    const declined = w.mailTo("typed@stranger.test").find((m) => m.subject === "We can't offer access right now")!;
    expect(declined.text.split("\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
    await w.decide(adminCookie, typed.id, "accept");
    await w.container.drain();
    const accepted = w.mailTo("typed@stranger.test").find((m) => m.subject === "Your request was approved")!;
    expect(accepted.text).toContain("Company: Acme Bcc: evil@example.test\n");
    expect(accepted.text.split("\n").filter((l) => l.startsWith("Bcc:"))).toEqual([]);
  });

  it("the request's email goes only to an address its holder proved: no session for an unverified one, and a body cannot name another", async () => {
    const before = w.mail().sent.length;
    const unverified = (w.container.integrations.identity as FakeIdentityProvider).mint({ email: "someone.else@stranger.test", provider: "google", emailVerified: false });
    const refused = await w.app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: unverified }) });
    expect(refused.status).toBe(403);
    expect(await w.code(refused)).toBe("email_unverified");
    expect(w.mail().sent).toHaveLength(before);
    // whatever a body says, the address is the session's
    const cookie = await w.google("holder@stranger.test");
    const r = await w.json(cookie, "POST", "/api/v1/companies", { ...w.form("Holder Dental"), email: "victim@elsewhere.test", to: "victim@elsewhere.test", ownerEmail: "victim@elsewhere.test" });
    expect(r.status).toBe(201);
    expect(w.mailTo("victim@elsewhere.test")).toEqual([]);
    expect(w.mailTo("holder@stranger.test")).toHaveLength(1);
    // the email link proves the mailbox the same way: the session's address is the one the link went to
    const asked = await w.app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "linked@stranger.test" }) });
    const token = new URL(((await asked.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    const linked = (await w.app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    expect((await w.json(linked, "POST", "/api/v1/companies", w.form("Linked Dental"))).status).toBe(201);
    expect(w.mailTo("linked@stranger.test").map((m) => m.subject)).toEqual(["Your sign-in link", "Your request has been sent"]);
  });

  it("a platform administrator and an address on the allow-list go in directly, and the normal ITS check still applies", async () => {
    const before = w.mail().sent.length;
    const quinn = await w.google("quinn@listed-domain.test", "Quinn");
    expect(await w.signupOf(quinn)).toEqual({ mode: "approval", allowed: true, contact: "recruiting@its.example", door: "direct" });
    const made = await w.json(quinn, "POST", "/api/v1/companies", w.form("Quinn Dental"));
    expect(made.status).toBe(201);
    const company = await w.read<{ id: string; slug: string; accessRequest?: unknown }>(made);
    expect(company.accessRequest).toBeUndefined();
    expect(await w.statusOf(company.id)).toBe("active");
    const me = await w.meOf(quinn);
    expect(me.activeCompanyId).toBe(company.id);
    expect((await w.runsOf(company.id)).map((r) => r.workflowKey)).toContain("stuck_role_detector");
    expect(w.mail().sent.slice(before).map((m) => m.subject)).toEqual(["[company check] Quinn Dental is waiting for the ITS check"]);
    expect((await w.rowOf(company.id)).settings.verifiedAt).toBeUndefined();
    expect((await w.app.request(`/careers/${company.slug}`)).status).toBe(404);
    expect((await w.customers(adminCookie)).find((c) => c.id === company.id)?.accessRequest).toBeNull();
    // the ordinary check, on the ordinary route, is not refused: nobody is asking for access here
    const confirmed = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${company.id}/verification`, { verified: true, reason: "Checked the website.", confirm: true });
    expect(confirmed.status).toBe(200);
    expect((await w.noticesOf(company.id)).map((n) => n.kind)).toContain("company.verified");
    // an administrator sets up companies as before, more than one
    for (const name of ["Set Up One", "Set Up Two"]) expect((await w.json(adminCookie, "POST", "/api/v1/companies", w.form(name))).status).toBe(201);
  });

  it("a team invitation to some other company still works for someone waiting or declined; none opens their own request", async () => {
    const host = await w.openDirect("host@listed-domain.test", "Host Dental");
    await withPlatform(w.container.db, (tx) => tx.update(entitlements).set({ limit: 10 }).where(and(eq(entitlements.companyId, host.id), eq(entitlements.key, "seats"))));
    const waiting = await w.ask("invited.waiting@stranger.test", "Invited Waiting");
    const declined = await w.ask("invited.declined@stranger.test", "Invited Declined");
    await w.decide(adminCookie, declined.id, "decline");
    for (const person of [waiting, declined]) {
      expect((await w.json(host.cookie, "POST", "/api/v1/companies/current/members/invite", { email: person.email, role: "interviewer" })).status).toBe(201);
      const again = await w.google(person.email);
      const me = await w.meOf(again);
      expect(me.activeCompanyId).toBe(host.id);
      expect(me.memberships).toEqual([expect.objectContaining({ companyId: host.id, role: "interviewer" })]);
      // their own request stands as it was, and they cannot send another
      expect(await w.statusOf(person.id)).toBe(person === waiting ? "requested" : "declined");
      expect((await w.json(again, "POST", "/api/v1/companies", w.form("One More"))).status).toBe(409);
      expect((await w.signupOf(again)).request?.status).toBe(person === waiting ? "requested" : "declined");
      expect((await w.json(again, "POST", "/api/v1/auth/switch", { companyId: person.id })).status).toBe(403);
    }
    // an invitation to their own company (nobody can send one; written straight here) stays open, and opens nothing, at any sign-in
    for (const person of [waiting, declined]) {
      const { token, row } = await withPlatform(w.container.db, (tx) => createInvitation(tx, { companyId: person.id, email: person.email, role: "admin", invitedBy: { kind: "system", id: "test" } }));
      expect(token).toBeTruthy();
      const again = await w.google(person.email);
      expect((await w.meOf(again)).memberships.map((m) => m.companyId)).toEqual([host.id]);
      expect(await w.statusOf(person.id)).toBe(person === waiting ? "requested" : "declined");
      const [still] = await w.container.db.select().from(invitations).where(eq(invitations.id, row.id));
      expect(still.status).toBe("pending");
      await withPlatform(w.container.db, (tx) => tx.delete(invitations).where(eq(invitations.id, row.id)));
    }
    // Accepting them adds their own company beside the other; they stay where they were working
    await w.decide(adminCookie, waiting.id, "accept");
    await w.container.drain();
    const session = await w.google(waiting.email);
    const me = await w.meOf(session);
    expect(me.memberships.map((m) => m.companyId).sort()).toEqual([host.id, waiting.id].sort());
    expect((await w.json(session, "POST", "/api/v1/auth/switch", { companyId: waiting.id })).status).toBe(200);
  });

  it("the modes still hold for someone waiting: invite shuts the door again, and they still read where they stand and can be accepted", async () => {
    const asker = await w.ask("door@stranger.test", "Door Dental");
    w.container.env.SIGNUP_MODE = "invite";
    try {
      expect(await w.signupOf(asker.cookie)).toEqual({ mode: "invite", allowed: false, contact: "recruiting@its.example", request: { status: "requested", companyName: "Door Dental", email: "door@stranger.test", emailedAt: asker.accessRequest.emailedAt } });
      const stranger = await w.google("shut.out@stranger.test");
      expect(await w.signupOf(stranger)).toEqual({ mode: "invite", allowed: false, contact: "recruiting@its.example" });
      const refused = await w.json(stranger, "POST", "/api/v1/companies", w.form("Shut Out"));
      expect(refused.status).toBe(403);
      expect(await w.code(refused)).toBe("signup_invite_only");
      expect(await w.code(await w.json(asker.cookie, "POST", "/api/v1/companies", w.form("Door Again")))).toBe("signup_invite_only");
      w.container.env.SIGNUP_MODE = "open";
      expect((await w.signupOf(asker.cookie)).allowed).toBe(false);
      expect(await w.signupOf(stranger)).toEqual({ mode: "open", allowed: true, contact: "recruiting@its.example" });
      expect(await w.code(await w.json(asker.cookie, "POST", "/api/v1/companies", w.form("Door Again")))).toBe("another_company_needs_its");
      expect((await w.decide(adminCookie, asker.id, "accept")).status).toBe(200);
      expect((await w.meOf(asker.cookie)).activeCompanyId).toBe(asker.id);
    } finally {
      w.container.env.SIGNUP_MODE = "approval";
    }
  });

  it("no job or sweep starts work for a request, counts it wrongly or writes to its owner", async () => {
    const waiting = await w.ask("sweep.waiting@stranger.test", "Sweep Waiting");
    const declined = await w.ask("sweep.declined@stranger.test", "Sweep Declined");
    await w.decide(adminCookie, declined.id, "decline");
    const mails = w.mail().sent.length;
    const now = w.container.engine.clock();
    await runHourlyChecks(w.container.db, now, { workerInline: true });
    await runMaintenance(w.container.db, now, { workerInline: true, fullAiScrub: true });
    await backfillPublishing(w.container);
    await w.container.drain();
    expect(w.mail().sent.slice(mails).filter((m) => [waiting.email, declined.email].includes(m.to))).toEqual([]);
    for (const { id } of [waiting, declined]) {
      expect(await w.runsOf(id)).toEqual([]);
      expect(await w.aiRunsOf(id)).toEqual([]);
      expect(await w.noticesOf(id)).toEqual([]);
      expect(await w.alertsOf(id)).toEqual([]);
      expect(await w.container.db.select().from(communications).where(eq(communications.companyId, id))).toEqual([]);
      const row = await w.rowOf(id);
      expect(row.settings.trial).toBeUndefined();
      expect(row.settings.verifiedAt).toBeUndefined();
      expect((await w.container.db.select().from(entitlements).where(eq(entitlements.companyId, id))).every((e) => e.used === 0)).toBe(true);
    }
    expect(await w.statusOf(waiting.id)).toBe("requested");
    expect(await w.statusOf(declined.id)).toBe("declined");
  });

  it("a customer cannot write the record of the request's email", async () => {
    const asker = await w.ask("settings@stranger.test", "Settings Dental");
    await w.decide(adminCookie, asker.id, "accept");
    const refused = await w.json(asker.cookie, "PATCH", "/api/v1/companies/current", { settings: { accessRequestEmailedAt: "2026-01-01T00:00:00.000Z" } });
    expect(refused.status).toBe(400);
    expect(await w.code(refused)).toBe("not_yours_to_change");
  });

  it("a bounce of these emails stops the address as ever and raises nothing about a team member: they are on nobody's team yet", async () => {
    const asker = await w.ask("bounced@stranger.test", "Bounced Dental");
    const [copy] = w.mailTo("bounced@stranger.test");
    const bounce = async (id: number, providerMessageId: string) => w.app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fakePostmarkEvent({ providerMessageId, email: "bounced@stranger.test", type: "HardBounce", id })) });
    const unreachable = () => w.container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "email.person_unreachable"), sql`${adminAlerts.title} like '%bounced@stranger.test%'`));
    expect((await bounce(910_001, copy.providerMessageId)).status).toBe(200);
    expect(await unreachable()).toEqual([]);
    const [stopped] = await w.container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "bounced@stranger.test"));
    expect(stopped.active).toBe(true);
    // Accept still goes through with the address stopped, and the email that cannot go raises nothing
    expect((await w.decide(adminCookie, asker.id, "accept")).status).toBe(200);
    await w.container.drain();
    expect(await w.statusOf(asker.id)).toBe("active");
    expect((await w.container.db.select().from(communications).where(eq(communications.companyId, asker.id)))[0].status).toBe("failed");
    expect(await w.alertsOf(asker.id)).toEqual([]);
    // on a team now, so a bounce is told as for anyone on a team
    expect((await bounce(910_002, copy.providerMessageId)).status).toBe(200);
    expect(await unreachable()).toHaveLength(1);
  });
});

/**
 * The public door's own bounds (the review of 6 November 2026): one address sends five requests an hour, past 25 waiting at
 * once a request is still taken but sends no email, and spam complaints about those emails raise one alert, not one each.
 * A container of its own, with every other limit out of the way and this one at its real value.
 */
describe("the door's own bounds under SIGNUP_MODE=approval", () => {
  let w: World;
  let adminCookie = "";
  const OTHERS_UNLIMITED = JSON.stringify(Object.fromEntries(Object.values(POLICIES).filter((p) => p.name !== POLICIES.accessRequest.name).map((p) => [p.name, 1_000_000])));
  /** The form sent by a new account from one address, as a browser behind the proxy sends it. */
  const askFrom = async (address: string, email: string, name: string, body: unknown = undefined) => {
    const cookie = await w.google(email, "Sam Asker");
    return w.app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie, "x-forwarded-for": address }, body: JSON.stringify(body ?? w.form(name)) });
  };

  beforeAll(async () => {
    w = await boot("its", { RATE_LIMIT_OVERRIDES: OTHERS_UNLIMITED });
    adminCookie = await w.admin();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("one address sends five requests an hour, whichever accounts it signs in with; the sixth makes nothing; a bad body, another address and the direct door are not counted", async () => {
    expect(POLICIES.accessRequest).toEqual({ name: "access.request", rules: [{ by: "ip", windowMs: 3_600_000, limit: 5 }] });
    for (let i = 1; i <= 5; i++) expect((await askFrom("203.0.113.7", `flood${i}@stranger.test`, `Flood Dental ${i}`)).status, `request ${i}`).toBe(201);
    const mails = w.mail().sent.length;
    const sixth = await askFrom("203.0.113.7", "flood6@stranger.test", "Flood Dental 6");
    expect(sixth.status).toBe(429);
    expect(await w.code(sixth)).toBe("rate_limited");
    expect(await w.container.db.select().from(companies).where(eq(companies.name, "Flood Dental 6"))).toEqual([]);
    expect(w.mail().sent.length).toBe(mails);
    // a body the form would never send is refused before anything counts
    for (let i = 1; i <= 6; i++) expect((await askFrom("192.0.2.9", `typo${i}@stranger.test`, "", { name: "" })).status).toBe(400);
    expect((await askFrom("192.0.2.9", "typo7@stranger.test", "Typo Dental")).status).toBe(201);
    // another address still asks, and the allow-list's door is not this door
    expect((await askFrom("198.51.100.20", "elsewhere@stranger.test", "Elsewhere Dental")).status).toBe(201);
    const pat = await w.google("pat@listed.test", "Pat Partner");
    expect((await w.app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie: pat, "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(w.form("Listed Flood Dental")) })).status).toBe(201);
  });

  it("past 25 waiting at once, a request is still taken and on the Overview, but neither email goes and the screen claims none; with fewer waiting they go again", async () => {
    expect(OPEN_REQUESTS_EMAILED).toBe(25);
    const open = async () => Number((await w.container.db.select({ n: sql<number>`count(*)` }).from(memberships).where(eq(memberships.status, "requested")))[0].n);
    // up to the bound straight through the service: the route's own limit is the case above
    for (let i = 1; (await open()) < OPEN_REQUESTS_EMAILED; i++) {
      const [user] = await w.container.db.insert(users).values({ email: `many${i}@stranger.test`, name: "Many Asker" }).returning();
      await sendAccessRequest(w.container, { body: CreateCompany.parse(w.form(`Many Dental ${i}`)), user: { id: user.id, email: user.email, name: user.name }, actor: { kind: "user", id: user.id, name: "Many Asker" } });
    }
    const before = w.mail().sent.length;
    const quiet = await askFrom("192.0.2.50", "one.too.many@stranger.test", "One Too Many Dental");
    expect(quiet.status).toBe(201);
    const made = await w.read<{ id: string; accessRequest: { status: string; emailedAt: string | null } }>(quiet);
    expect(made.accessRequest).toMatchObject({ status: "requested", emailedAt: null });
    expect(w.mail().sent.length).toBe(before);
    expect(await w.statusOf(made.id)).toBe("requested");
    expect((await w.rowOf(made.id)).settings.accessRequestEmailedAt).toBeUndefined();
    expect((await w.signupOf(await w.google("one.too.many@stranger.test"))).request).toMatchObject({ status: "requested", emailedAt: null });
    expect((await w.customers(adminCookie)).find((c) => c.id === made.id)?.accessRequest?.status).toBe("requested");
    // an administrator works through the list: with fewer waiting, the next request is emailed again
    for (const c of (await w.customers(adminCookie)).filter((c) => c.accessRequest?.status === "requested").slice(0, 2)) expect((await w.decide(adminCookie, c.id, "decline")).status).toBe(200);
    const after = await askFrom("192.0.2.51", "next.one@stranger.test", "Next One Dental");
    expect((await w.read<{ accessRequest: { emailedAt: string | null } }>(after)).accessRequest.emailedAt).toEqual(expect.any(String));
    expect(w.mailTo("next.one@stranger.test").map((m) => m.subject)).toEqual(["Your request has been sent"]);
    expect(w.mailTo("queue@its.example").map((m) => m.subject)).toContain("[access request] Next One Dental is asking for access");
  });

  it("spam complaints about these emails raise one alert while it stands, and at most one an hour, however many accounts complain; every address is stopped", async () => {
    const complain = (email: string, id: number) => w.app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fakePostmarkEvent({ providerMessageId: w.mailTo(email)[0].providerMessageId, email, type: "SpamComplaint", id })) });
    const spam = () => w.container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "email.spam_complaint"));
    const stopped = async (email: string) => (await w.container.db.select().from(emailSuppressions).where(and(eq(emailSuppressions.address, email), eq(emailSuppressions.active, true)))).length;
    for (const [i, email] of ["flood1@stranger.test", "flood2@stranger.test", "flood3@stranger.test"].entries()) {
      expect((await complain(email, 920_001 + i)).status).toBe(200);
      expect(await stopped(email), email).toBe(1);
    }
    const [one] = await spam();
    expect(await spam()).toHaveLength(1);
    expect(one.severity).toBe("critical");
    // resolved, a complaint within the hour raises nothing; one after the hour does
    await withPlatform(w.container.db, (tx) => tx.update(adminAlerts).set({ status: "resolved", resolvedAt: new Date().toISOString() }).where(eq(adminAlerts.id, one.id)));
    expect((await complain("flood4@stranger.test", 920_010)).status).toBe(200);
    expect(await spam()).toHaveLength(1);
    expect(await stopped("flood4@stranger.test")).toBe(1);
    const clock = w.container.engine as unknown as { now: () => Date };
    const real = clock.now;
    clock.now = () => new Date(Date.now() + SPAM_ALERT_WINDOW_MS + 60_000);
    try {
      expect((await complain("flood5@stranger.test", 920_011)).status).toBe(200);
    } finally {
      clock.now = real;
    }
    expect(await spam()).toHaveLength(2);
  });
});

/**
 * Nothing public, under any value of COMPANY_CHECK. A request is never confirmed, not even by COMPANY_CHECK=auto, and every
 * public page and feed needs a confirmed company. Here each has a real open role and a logo-free careers page behind it, so
 * only the confirmation stands between them and the public.
 */
describe.each(["its", "auto"] as const)("a request or a declined company shows nothing publicly (COMPANY_CHECK=%s)", (check) => {
  let w: World;
  let adminCookie = "";

  beforeAll(async () => {
    w = await boot(check);
    adminCookie = await w.admin();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("no careers page, job page, apply form, feed entry, sitemap entry, tracked link or privacy-form mention; Accept is what opens them", async () => {
    const source = await w.openDirect(`pat.public.${check}@listed-domain.test`, `Public Source ${check}`);
    const waiting = await w.ask(`public.waiting.${check}@stranger.test`, `Zqpublicwaitingname ${check}`);
    const declined = await w.ask(`public.declined.${check}@stranger.test`, `Zqpublicdeclinedname ${check}`);
    await w.decide(adminCookie, declined.id, "decline");
    for (const person of [waiting, declined]) {
      const row = await w.rowOf(person.id);
      // the point of it all: a request is never confirmed, and nothing says it was
      expect(row.settings.verifiedAt).toBeUndefined();
      expect(await w.eventsOf(person.id, "company.verified")).toEqual([]);
      const roleId = await w.plantRole(source.roleId, person.id, `Zqpublicrole ${check}`);
      const link = await withPlatform(w.container.db, (tx) => createApplicationLink(tx, { companyId: person.id, roleId, source: "referral", label: "A friend", actor: { kind: "system", id: "test" } }));
      for (const path of [`/careers/${person.slug}`, `/careers/${person.slug}/logo/x.png`, `/careers/${person.slug}/jobs/${roleId}`, `/careers/${person.slug}/jobs/${roleId}/apply`, `/careers/${person.slug}/jobs/${roleId}/applied`, `/careers/${person.slug}/jobs/${roleId}/apply/reuse`]) expect((await w.app.request(path)).status, path).toBe(404);
      expect((await w.app.request(`/careers/${person.slug}/jobs/${roleId}/apply`, { method: "POST", body: new FormData() })).status).toBe(404);
      expect((await w.app.request(`/a/${link.token}`)).status).toBe(404);
      resetPublicFeedCache(w.container);
      for (const path of ["/feeds/jobs.xml", "/feeds/jobs.json", "/feeds/linkedin.xml", "/sitemap.xml"]) {
        const body = await (await w.app.request(path)).text();
        expect(body, path).not.toContain(roleId);
        expect(body, path).not.toMatch(/Zqpublic/i);
        expect(body, path).not.toContain(person.slug);
      }
      // the privacy form, named by the careers address, answers as if there were no such company
      const mails = w.mail().sent.length;
      const form = new URLSearchParams({ email: "curious@people.test", kind: "access", company: person.slug });
      expect((await w.app.request("/c/privacy-request", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })).status).toBe(200);
      const told = w.mail().sent.slice(mails);
      expect(told.map((m) => m.subject)).toEqual(["About your privacy request"]);
      expect(told[0].text).not.toMatch(/Zqpublic/i);
    }
    // Accept opens them: under `its` by this one approval, under `auto` the same, recorded with who pressed
    expect((await w.decide(adminCookie, waiting.id, "accept")).status).toBe(200);
    await w.container.drain();
    expect((await w.rowOf(waiting.id)).settings.verifiedBy).toMatchObject({ kind: "user", name: "Ada Admin" });
    expect((await w.app.request(`/careers/${waiting.slug}`)).status).toBe(200);
    expect(await (await w.app.request(`/careers/${waiting.slug}`)).text()).toContain("Zqpublicrole");
    // no reset here: the route rebuilds the feeds itself, as the verification route does
    expect(await (await w.app.request("/feeds/jobs.json")).text()).toContain(waiting.slug);
    // one notice under either value
    expect((await w.noticesOf(waiting.id)).map((n) => n.kind)).toEqual(["company.access_accepted"]);
    // the declined one stays dark
    expect((await w.app.request(`/careers/${declined.slug}`)).status).toBe(404);
    expect(await (await w.app.request("/feeds/jobs.json")).text()).not.toContain(declined.slug);
  });

  it("the allow-list's door follows COMPANY_CHECK as ever", async () => {
    const direct = await w.google(`pat.door.${check}@listed-domain.test`);
    const made = await w.read<{ id: string; slug: string }>(await w.json(direct, "POST", "/api/v1/companies", w.form(`Door ${check}`)));
    expect(!!(await w.rowOf(made.id)).settings.verifiedAt).toBe(check === "auto");
    expect((await w.app.request(`/careers/${made.slug}`)).status).toBe(check === "auto" ? 200 : 404);
  });
});

/** A made-up token for the pages behind a person's own link: nobody waiting holds one. */
const NOT_A_TOKEN = "not-a-real-token";
const NOBODY = "00000000-0000-4000-8000-000000000000";

type Targets = { company: string; userId: string; slug: string; role: string; application: string; interview: string; session: string };

/** What each parameter of each route is filled with, by the prefix it sits under. A new route with a new parameter joins here. */
const FILL = (t: Targets): Array<[string, Record<string, string>]> => [
  ["/api/v1/auth/start", { provider: "google" }],
  ["/api/v1/auth/sessions", { id: NOBODY }],
  ["/api/v1/companies/current/invitations", { id: NOBODY }],
  ["/api/v1/companies/current/members", { userId: t.userId }],
  ["/api/v1/companies/current/staff-access", { grantId: NOBODY }],
  ["/api/v1/intake/sessions", { id: t.session, revisionId: NOBODY }],
  ["/api/v1/roles", { id: t.role, channel: "careers_page", kind: "missing_must_have", revisionId: NOBODY, version: "1", linkId: NOBODY }],
  ["/api/v1/applications", { id: t.application, communicationId: NOBODY, documentId: NOBODY, assessmentId: NOBODY }],
  ["/api/v1/approvals", { id: NOBODY }],
  ["/api/v1/escalations", { id: NOBODY }],
  ["/api/v1/admin/platform-roles", { grantId: NOBODY }],
  ["/api/v1/admin/users", { userId: t.userId }],
  ["/api/v1/admin/customers", { id: t.company }],
  ["/api/v1/admin", { id: NOBODY }],
  ["/api/v1/integrations", { id: NOBODY, provider: "google" }],
  ["/api/v1/interviews", { id: t.interview }],
  ["/c/status", { token: NOT_A_TOKEN, id: NOBODY, roleId: t.role }],
  ["/c/screen", { token: NOT_A_TOKEN, key: "q1" }],
  ["/c/", { token: NOT_A_TOKEN }],
  ["/careers", { slug: t.slug, roleId: t.role, file: "x.png" }],
  ["/files", { token: NOT_A_TOKEN }],
  ["/a/", { token: NOT_A_TOKEN }],
];

/** A route with its parameters filled, or a failure that names it. */
function fillRoute(route: string, table: Array<[string, Record<string, string>]>): string {
  return route.replace(/:([A-Za-z]+)/g, (_, param: string) => {
    const value = table.find(([prefix]) => route.startsWith(prefix))?.[1][param];
    if (value === undefined) throw new Error(`The canary sweep cannot fill :${param} of ${route}. Say what it takes in FILL (apps/api/src/access-approval.test.ts), so this route is proved too.`);
    return value;
  });
}

type Outside = { routes: string[] | RegExp; allow: number[]; why: string };

/**
 * Every route a person with no tenant is answered by anything but the wall (403 `no_company`) or the staff's own (403
 * `forbidden`), and why that is right. Each is read for the markers like every other. A route that is not here and answers
 * anything else fails the sweep and names itself: it either goes behind `requireTenant`, or it says here what it gives.
 */
const OUTSIDE_THE_WALL: Outside[] = [
  // The person themselves.
  { routes: ["GET /api/v1/auth/config"], allow: [200], why: "The sign-in page's public settings, and this person's own request: their company's name and nothing else of it." },
  { routes: ["GET /api/v1/auth/me"], allow: [200], why: "Who they are, with active memberships only: none." },
  { routes: ["POST /api/v1/auth/switch"], allow: [400], why: "Asked with no company: 400. Asked with one, 403: only a company they are an active member of (tested below)." },
  { routes: ["GET /api/v1/auth/sessions", "POST /api/v1/auth/sessions/revoke-all", "POST /api/v1/auth/sessions/:id/revoke", "POST /api/v1/auth/logout"], allow: [200, 404], why: "Their own sessions, by their own user id." },
  { routes: ["POST /api/v1/auth/reauth/start"], allow: [200], why: "Confirming it is them, about their own session; it reads no company." },
  { routes: ["POST /api/v1/companies"], allow: [400], why: "The form itself. A body this empty is refused; a real one, for someone waiting or declined, answers 409 (tested below)." },
  // Signing in: they answer any browser the same, and open nothing without a proof nobody here sent.
  { routes: ["GET /api/v1/auth/start/:provider", "GET /api/v1/auth/callback", "GET /api/v1/auth/consume", "POST /api/v1/auth/consume", "GET /api/v1/auth/mfa", "POST /api/v1/auth/mfa", "GET /api/v1/auth/mfa/backup", "POST /api/v1/auth/mfa/skip", "POST /api/v1/auth/mfa/cancel"], allow: [302], why: "The steps of a sign-in: a redirect to the provider, the sign-in page or Home." },
  { routes: ["POST /api/v1/auth/session", "POST /api/v1/auth/magic-link", "POST /api/v1/auth/magic-link/consume"], allow: [400], why: "A sign-in with nothing to prove it." },
  { routes: ["GET /api/v1/auth/invite", "POST /api/v1/auth/invite/email", "POST /api/v1/auth/invite/forget"], allow: [200], why: "The invitation page: with no token, it says so." },
  // Development only: each answers 404 in production or with a real provider.
  { routes: ["GET /api/v1/auth/fake/authorize", "POST /api/v1/auth/fake/authorize", "GET /api/v1/integrations/calendar/fake/authorize", "POST /api/v1/integrations/calendar/fake/authorize"], allow: [200, 302], why: "The fake identity and calendar providers' own pages." },
  // Their refusal, as a page.
  { routes: ["GET /api/v1/roles/:id/preview", "GET /api/v1/roles/:id/preview/page", "GET /api/v1/intake/sessions/:id/preview", "GET /api/v1/intake/sessions/:id/preview/page"], allow: [403], why: "A browser tab gets the preview's own plain page for the same refusal." },
  { routes: ["GET /api/v1/integrations/calendar/:provider/callback"], allow: [302], why: "It connects a calendar only for a tenant: with none, back to Settings with `incomplete`." },
  // What anyone can read, whoever is asking.
  { routes: /^(GET|POST) \/careers\//, allow: [404], why: "Their own company and the other are unconfirmed, so these answer as if neither existed." },
  { routes: /^(GET|POST) \/c\/(schedule|status|screen|confirm-answers)\//, allow: [404], why: "A candidate's own pages behind a token, and nobody here holds one." },
  { routes: ["GET /a/:token"], allow: [404], why: "A tracked link: no such token." },
  { routes: ["GET /files/get/:token"], allow: [403], why: "A grant for one object: this is none." },
  { routes: ["GET /c/link-request", "POST /c/link-request", "GET /c/privacy-request", "POST /c/privacy-request"], allow: [200, 400], why: "A candidate's forms: empty, they ask again." },
  { routes: ["GET /c/privacy-request/verify/:token", "POST /c/privacy-request/verify"], allow: [410], why: "The confirmation link of a privacy request: this is none." },
  { routes: ["GET /privacy", "GET /healthz", "GET /sitemap.xml", "GET /robots.txt", "GET /feeds/jobs.xml", "GET /feeds/jobs.json", "GET /feeds/linkedin.xml"], allow: [200], why: "Public, for everyone: read for the markers, and the feeds hold none." },
  { routes: ["POST /api/csp-report"], allow: [204], why: "A browser's report: it reads nothing." },
  // Machines, by their own secrets, and the session is not read.
  { routes: /^POST \/webhooks\//, allow: [200, 400, 401, 403], why: "Providers' webhooks; an empty delivery changes nothing." },
];

type Answer = { method: string; route: string; status: number; code: string | undefined; text: string; ownName: string; ownEmail: string };

/** What is wrong with one answer to someone waiting or declined, in words that name the route; null when nothing is. */
function judge(a: Answer, marks: readonly string[], outside: Outside[]): string | null {
  const name = `${a.method} ${a.route}`;
  if (a.status >= 500) return `${name} answered ${a.status}: ${a.text.slice(0, 200)}`;
  if (a.status === 429) return `${name} answered 429: a limit is no proof of the wall`;
  const hits = marks.filter((m) => a.text.toLowerCase().includes(m.toLowerCase())).filter((m) => {
    if (m === a.ownEmail) return false;
    return !(m === a.ownName && name === "GET /api/v1/auth/config");
  });
  if (hits.length) return `${name} holds ${hits.join(", ")}`;
  if (a.status === 403 && (a.code === "no_company" || a.code === "forbidden")) return null;
  const known = outside.find((e) => (Array.isArray(e.routes) ? e.routes.includes(name) : e.routes.test(name)));
  if (!known) return `${name} answered ${a.status}${a.code ? ` ${a.code}` : ""}, which is neither the wall nor listed in OUTSIDE_THE_WALL: put it behind requireTenant, or say there why it is right. It said: ${a.text.slice(0, 160)}`;
  if (!known.allow.includes(a.status)) return `${name} answered ${a.status}${a.code ? ` ${a.code}` : ""}, and OUTSIDE_THE_WALL allows ${known.allow.join(" or ")}: ${a.text.slice(0, 160)}`;
  return null;
}

/** Every route of the app but the two development outboxes (app.ts never mounts them in production), Sign out last: it ends the session being swept. */
function everyRoute(app: ReturnType<typeof createApp>, only?: (route: string) => boolean): Array<{ method: string; route: string }> {
  const seen = new Set<string>();
  const out: Array<{ method: string; route: string }> = [];
  for (const r of app.routes) {
    // "ALL" is middleware only: nothing in the API is mounted with app.all
    if (r.method === "ALL" || r.path.startsWith("/dev/") || (only && !only(r.path))) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, route: r.path });
  }
  return out.sort((a, b) => Number(a.route === "/api/v1/auth/logout") - Number(b.route === "/api/v1/auth/logout"));
}

/** One person, one set of ids, every route: what was wrong with any answer, and how many the wall itself refused. */
async function sweep(w: World, app: ReturnType<typeof createApp>, person: { email: string; name: string }, targets: Targets, marks: readonly string[], only?: (route: string) => boolean) {
  const table = FILL(targets);
  const problems: string[] = [];
  let wall = 0;
  let answers = 0;
  const cookie = await w.google(person.email);
  for (const { method, route } of everyRoute(app, only)) {
    const path = fillRoute(route, table);
    // the preview's own page answers a browser tab, and its data route the app's requests: both are read
    for (const accept of method === "GET" && /\/preview/.test(route) ? ["application/json", "text/html"] : ["application/json"]) {
      const r = await app.request(path, { method, headers: { cookie, accept, "content-type": "application/json", "x-admin-reason": "sweep" }, body: method === "GET" || method === "HEAD" ? undefined : "{}" });
      const text = await r.text();
      let code: string | undefined;
      try {
        code = (JSON.parse(text) as { error?: { code?: string } }).error?.code;
      } catch {
        code = undefined;
      }
      answers += 1;
      if (r.status === 403 && code === "no_company") wall += 1;
      const problem = judge({ method, route, status: r.status, code, text: `${text} ${r.headers.get("location") ?? ""} ${r.headers.get("content-disposition") ?? ""}`, ownName: person.name, ownEmail: person.email }, marks, OUTSIDE_THE_WALL);
      if (problem) problems.push(problem);
    }
  }
  return { problems, wall, answers };
}

/** The rows a sweep must leave as they were, for the companies it was aimed at. */
async function snapshot(w: World, ids: string[]) {
  const db = w.container.db;
  const of = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id).sort();
  return {
    companies: (await db.select().from(companies).where(inArray(companies.id, ids))).sort((a, b) => a.id.localeCompare(b.id)),
    memberships: (await db.select({ id: memberships.id, status: memberships.status, role: memberships.role }).from(memberships).where(inArray(memberships.companyId, ids))).sort((a, b) => a.id.localeCompare(b.id)),
    events: (await db.select({ n: sql<number>`count(*)` }).from(events).where(inArray(events.companyId, ids)))[0].n,
    audit: (await db.select({ n: sql<number>`count(*)` }).from(auditRecords).where(inArray(auditRecords.companyId, ids)))[0].n,
    runs: of(await db.select({ id: workflowRuns.id }).from(workflowRuns).where(inArray(workflowRuns.companyId, ids))),
    ai: of(await db.select({ id: aiRuns.id }).from(aiRuns).where(inArray(aiRuns.companyId, ids))),
    notices: of(await db.select({ id: notifications.id }).from(notifications).where(inArray(notifications.companyId, ids))),
    messages: of(await db.select({ id: communications.id }).from(communications).where(inArray(communications.companyId, ids))),
    roles: of(await db.select({ id: roles.id }).from(roles).where(inArray(roles.companyId, ids))),
    alerts: of(await db.select({ id: adminAlerts.id }).from(adminAlerts).where(inArray(adminAlerts.companyId, ids))),
    jobs: (await db.select({ id: jobs.id }).from(jobs).where(sql`${jobs.payload}->>'companyId' in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).length,
  };
}

const MARK = {
  otherName: "Zqothercompanymark",
  otherRole: "Zqotherrolemark",
  otherPerson: "Zqotherpersonmark",
  otherOwner: "pat.zqotherownermark@listed-domain.test",
  waitingName: "Zqwaitingcompanymark",
  waitingEmail: "zqwaitingperson@stranger.test",
  waitingRole: "Zqwaitingrolemark",
  waitingPerson: "Zqwaitingpersonmark",
  waitingSite: "zqwaitingsitemark",
  declinedName: "Zqdeclinedcompanymark",
  declinedEmail: "zqdeclinedperson@stranger.test",
  declinedRole: "Zqdeclinedrolemark",
  declinedPerson: "Zqdeclinedpersonmark",
  declinedSite: "zqdeclinedsitemark",
};
const MARKS = Object.values(MARK);

/**
 * The wall, proved by the routes themselves: a waiting and a declined person, every route Hono knows, requireTenant or not,
 * with the real ids of their own company and of another one. Their own company and the other one each hold a role, a
 * candidate and an interview carrying a marker, so an answer that read any of them would be seen.
 */
describe("a waiting and a declined person reach nothing, by any route", () => {
  let w: World;
  let adminCookie = "";
  let other: Awaited<ReturnType<World["openDirect"]>>;
  let otherTargets: Targets;
  let waitingTargets: Targets;
  let declinedTargets: Targets;
  let waiting: Awaited<ReturnType<World["ask"]>>;
  let declined: Awaited<ReturnType<World["ask"]>>;

  beforeAll(async () => {
    w = await boot("its");
    adminCookie = await w.admin();
    other = await w.openDirect(MARK.otherOwner, MARK.otherName);
    const otherRole = await w.plantRole(other.roleId, other.id, MARK.otherRole);
    const otherPerson = await w.plantPerson(other.id, otherRole, MARK.otherPerson);
    otherTargets = { company: other.id, userId: (await w.meOf(other.cookie)).user.id, slug: other.slug, role: otherRole, application: otherPerson.application, interview: otherPerson.interview, session: other.session };
    const prepare = async (email: string, name: string, site: string, roleMark: string, personMark: string) => {
      const asker = await w.ask(email, name, { website: `https://${site}.example`, ownerName: "Sam Asker" });
      const role = await w.plantRole(other.roleId, asker.id, roleMark);
      const person = await w.plantPerson(asker.id, role, personMark);
      return { asker, targets: { company: asker.id, userId: (await w.meOf(asker.cookie)).user.id, slug: asker.slug, role, application: person.application, interview: person.interview, session: NOBODY } };
    };
    ({ asker: waiting, targets: waitingTargets } = await prepare(MARK.waitingEmail, MARK.waitingName, MARK.waitingSite, MARK.waitingRole, MARK.waitingPerson));
    ({ asker: declined, targets: declinedTargets } = await prepare(MARK.declinedEmail, MARK.declinedName, MARK.declinedSite, MARK.declinedRole, MARK.declinedPerson));
    expect((await w.decide(adminCookie, declined.id, "decline")).status).toBe(200);
    await w.container.drain();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("a route the sweep cannot fill fails and names itself", () => {
    expect(() => fillRoute("/api/v1/something-new/:widgetId", FILL(otherTargets))).toThrow(/cannot fill :widgetId of \/api\/v1\/something-new\/:widgetId/);
    expect(() => fillRoute("/api/v1/roles/:id/brand-new/:widgetId", FILL(otherTargets))).toThrow(/:widgetId of \/api\/v1\/roles\/:id\/brand-new\/:widgetId/);
    expect(fillRoute("/api/v1/roles/:id/postings/:channel/package", FILL(otherTargets))).toBe(`/api/v1/roles/${otherTargets.role}/postings/careers_page/package`);
  });

  it("an answer the sweep does not know fails and names itself: a marker, a server error, a limit, or anything but the wall", () => {
    const base = { method: "GET", route: "/api/v1/brand-new", status: 200, code: undefined, text: "{}", ownName: MARK.waitingName, ownEmail: MARK.waitingEmail };
    expect(judge(base, MARKS, [])).toMatch(/^GET \/api\/v1\/brand-new answered 200, which is neither the wall nor listed/);
    expect(judge({ ...base, status: 403, code: "no_company" }, MARKS, [])).toBeNull();
    expect(judge({ ...base, status: 403, code: "no_company", text: MARK.otherRole }, MARKS, [])).toMatch(/holds Zqotherrolemark/);
    expect(judge({ ...base, status: 500 }, MARKS, [{ routes: ["GET /api/v1/brand-new"], allow: [500], why: "" }])).toMatch(/answered 500/);
    expect(judge({ ...base, status: 429 }, MARKS, [{ routes: ["GET /api/v1/brand-new"], allow: [429], why: "" }])).toMatch(/answered 429/);
    expect(judge({ ...base, status: 404 }, MARKS, [{ routes: ["GET /api/v1/brand-new"], allow: [200], why: "" }])).toMatch(/OUTSIDE_THE_WALL allows 200/);
    expect(judge({ ...base, text: MARK.waitingName }, MARKS, [{ routes: ["GET /api/v1/brand-new"], allow: [200], why: "" }])).toMatch(/holds Zqwaitingcompanymark/);
    expect(judge({ ...base, route: "/api/v1/auth/config", text: MARK.waitingName }, MARKS, [{ routes: ["GET /api/v1/auth/config"], allow: [200], why: "" }])).toBeNull();
    expect(judge({ ...base, text: MARK.waitingEmail }, MARKS, [{ routes: ["GET /api/v1/brand-new"], allow: [200], why: "" }])).toBeNull();
  });

  it("every route, as someone waiting and as someone declined, with the ids of their own company and of another: nothing, and nothing moved", async () => {
    const ids = [waiting.id, declined.id, other.id];
    const before = await snapshot(w, ids);
    const allAi = (await w.container.db.select({ n: sql<number>`count(*)` }).from(aiRuns))[0].n;
    const problems: string[] = [];
    let wall = 0;
    let answers = 0;
    for (const [person, own] of [[{ email: MARK.waitingEmail, name: MARK.waitingName }, waitingTargets], [{ email: MARK.declinedEmail, name: MARK.declinedName }, declinedTargets]] as const) {
      for (const targets of [own, otherTargets]) {
        const done = await sweep(w, w.app, person, targets, MARKS);
        problems.push(...done.problems);
        wall += done.wall;
        answers += done.answers;
      }
    }
    expect([...new Set(problems)]).toEqual([]);
    // It is not a sweep of nothing: the route table is all there, and the wall itself refused most of it, each of the four times.
    expect(everyRoute(w.app).length).toBeGreaterThan(300);
    expect(answers).toBeGreaterThan(1200);
    expect(wall).toBeGreaterThan(600);
    await w.container.drain();
    // Nothing moved: no AI run, no workflow, no notice, no message, no alert, not one event, in any company.
    expect(await snapshot(w, ids)).toEqual(before);
    expect((await w.container.db.select({ n: sql<number>`count(*)` }).from(aiRuns))[0].n).toBe(allAi);
    expect(await w.aiRunsOf(waiting.id)).toEqual([]);
    expect(await w.aiRunsOf(declined.id)).toEqual([]);
    expect(await w.runsOf(waiting.id)).toEqual([]);
    expect(await w.runsOf(declined.id)).toEqual([]);
  }, 300_000);

  it("the sweep would see a reader that forgot to filter on active: a membership read at any status, a route with no filling", async () => {
    const leaky = createApp(w.container);
    leaky.get("/api/v1/leak-check", async (c) => c.json(await w.container.db.select({ name: companies.name }).from(memberships).innerJoin(companies, eq(companies.id, memberships.companyId)).where(eq(memberships.userId, c.get("session")?.user.id ?? ""))));
    leaky.get("/api/v1/leak-check/:widgetId", (c) => c.json({}));
    const caught = await sweep(w, leaky, { email: MARK.waitingEmail, name: MARK.waitingName }, waitingTargets, MARKS, (route) => route === "/api/v1/leak-check");
    expect(caught.problems).toEqual([`GET /api/v1/leak-check holds ${MARK.waitingName}`]);
    await expect(sweep(w, leaky, { email: MARK.waitingEmail, name: MARK.waitingName }, waitingTargets, MARKS, (route) => route.startsWith("/api/v1/leak-check/"))).rejects.toThrow(/cannot fill :widgetId of \/api\/v1\/leak-check\/:widgetId/);
  });

  it("the routes a signed-in person reaches without a tenant give them only themselves", async () => {
    for (const [person, id] of [[waiting, waiting.id], [declined, declined.id]] as const) {
      const cookie = await w.google(person.email);
      const me = await w.meOf(cookie);
      expect(me.activeCompanyId).toBeNull();
      expect(me.memberships).toEqual([]);
      // Switching to their own company, or to another, is refused; so is one that does not exist.
      for (const companyId of [id, other.id, NOBODY]) {
        const r = await w.json(cookie, "POST", "/api/v1/auth/switch", { companyId });
        expect(r.status, companyId).toBe(403);
        expect(await w.code(r)).toBe("forbidden");
      }
      expect((await w.meOf(cookie)).activeCompanyId).toBeNull();
      // their own sessions, and no company in them
      const open = await w.read<Array<{ current: boolean }>>(await w.json(cookie, "GET", "/api/v1/auth/sessions"));
      expect(open.some((s) => s.current)).toBe(true);
      expect(JSON.stringify(open)).not.toContain(id);
      // a second request is refused however it is asked
      expect(await w.code(await w.json(cookie, "POST", "/api/v1/companies", w.form("One More")))).toBe("another_company_needs_its");
    }
  });

  it("the markers would be seen: the other company's owner reads theirs in the same routes, and Accept opens the waiting person's", async () => {
    const roleList = await (await w.json(other.cookie, "GET", "/api/v1/roles")).text();
    expect(roleList).toContain(MARK.otherRole);
    expect(await (await w.json(other.cookie, "GET", `/api/v1/applications/${otherTargets.application}`)).text()).toContain(MARK.otherPerson);
    expect((await w.decide(adminCookie, waiting.id, "accept")).status).toBe(200);
    await w.container.drain();
    const cookie = await w.google(MARK.waitingEmail);
    expect(await (await w.json(cookie, "GET", "/api/v1/roles")).text()).toContain(MARK.waitingRole);
    expect(await (await w.json(cookie, "GET", `/api/v1/applications/${waitingTargets.application}`)).text()).toContain(MARK.waitingPerson);
    expect(await (await w.json(cookie, "GET", "/api/v1/companies/current")).text()).toContain(MARK.waitingName);
    // and nobody else's came with it
    const after = await (await w.json(cookie, "GET", "/api/v1/roles")).text();
    expect(after).not.toContain(MARK.otherRole);
    expect(after).not.toContain(MARK.declinedRole);
  });
});

describe("the same sweep under COMPANY_CHECK=auto", () => {
  it("a person whose company was not confirmed by the environment reaches nothing either", async () => {
    const w = await boot("auto");
    try {
      const source = await w.openDirect("pat.source@listed-domain.test", "Auto Source");
      const asker = await w.ask(MARK.waitingEmail, MARK.waitingName, { website: `https://${MARK.waitingSite}.example` });
      const role = await w.plantRole(source.roleId, asker.id, MARK.waitingRole);
      const person = await w.plantPerson(asker.id, role, MARK.waitingPerson);
      const targets = { company: asker.id, userId: (await w.meOf(asker.cookie)).user.id, slug: asker.slug, role, application: person.application, interview: person.interview, session: NOBODY };
      const before = await snapshot(w, [asker.id]);
      const done = await sweep(w, w.app, { email: MARK.waitingEmail, name: MARK.waitingName }, targets, MARKS);
      expect([...new Set(done.problems)]).toEqual([]);
      expect(done.wall).toBeGreaterThan(150);
      expect(await snapshot(w, [asker.id])).toEqual(before);
    } finally {
      await w.container.close();
    }
  }, 300_000);
});
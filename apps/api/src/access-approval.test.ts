import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { SEND_MAX_ATTEMPTS, SPAM_ALERT_WINDOW_MS, sendQueuedCommunication, sweepStaleSending } from "@ros/agents";
import { ALWAYS_EMAILED_LINE, CreateCompany, FREE_PLAN_KEY, oneLine, typedName, visibleLength, type AdminCompany, type AdminCompanyJobs, type CompanyView, type CustomerAccessAnswer, type SignupConfig } from "@ros/contracts";
import { createInvitation, renderAlertEmail } from "@ros/core";
import { adminAlerts, aiRuns, auditRecords, communications, companies, emailSuppressions, entitlements, events, intakeSessions, invitations, jobs, memberships, notifications, roles, sessions, users, withPlatform, workflowRuns, type Tx } from "@ros/db";
import { fakePostmarkEvent, type FakeEmailAdapter, type FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { loadEnv, signupModeOf } from "./env";
import { runHourlyChecks, runMaintenance } from "./maintenance";
import { POLICIES } from "./middleware/rate-limit";
import { resetSitemapCache } from "./pages/sitemap";
import { OPEN_REQUESTS_EMAILED, companyRequestDetails, decideAccess, emailReallyLeft, sendAccessRequest } from "./services/access-requests";
import { createCompany, signupDoor } from "./services/companies";
import { plantApplicant, plantJob, signInAdmin, signInWithIdentity, testContainerOptions } from "./test-helpers";

/**
 * A company comes in by approval (SIGNUP_MODE=approval). Someone signed in fills in the company form; their company starts
 * as a request, with their membership `requested`; nothing else works for them, so no AI runs and no money is spent; a
 * platform administrator accepts, which makes the company live, or declines. That is the one gate. The wall is the
 * membership: the sweep below walks Hono's own route table, every route, as someone waiting and as someone declined, with
 * the real ids of their own company and of another one.
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
    const company = await read<{ id: string; name: string; accessRequest: { status: string; emailedAt: string | null } }>(r);
    // with the neutral address a request holds until it is accepted
    return { cookie, email, ...company, slug: (await rowOf(company.id)).slug };
  };
  const statusOf = async (companyId: string) => (await container.db.select({ status: memberships.status }).from(memberships).where(eq(memberships.companyId, companyId)))[0]?.status;
  const rowOf = async (companyId: string) => (await container.db.select().from(companies).where(eq(companies.id, companyId)))[0];
  const runsOf = (companyId: string) => container.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId));
  const aiRunsOf = (companyId: string) => container.db.select().from(aiRuns).where(eq(aiRuns.companyId, companyId));
  const noticesOf = (companyId: string) => container.db.select().from(notifications).where(eq(notifications.companyId, companyId));
  const eventsOf = (companyId: string, ...types: string[]) => container.db.select().from(events).where(and(eq(events.companyId, companyId), inArray(events.type, types)));
  const alertsOf = (companyId: string) => container.db.select().from(adminAlerts).where(eq(adminAlerts.companyId, companyId));
  const customers = (cookie: string) => json(cookie, "GET", "/api/v1/admin/customers").then((r) => read<AdminCompany[]>(r));
  const mailTo = (to: string) => mail().sent.filter((m) => m.to === to);
  /** A real open job of `companyId` under `title`, straight into the tables: as if the company had one. */
  const plantRole = (companyId: string, title: string) => plantJob(container, { companyId, title });
  /** A person with an application on a job, straight into the tables, carrying a marker for a name. */
  const plantPerson = async (companyId: string, roleId: string, mark: string) => ({ application: await plantApplicant(container, { companyId, roleId, mark }) });
  /** Someone on a company's team, active, straight into the tables: their account and their membership. */
  const addMember = async (companyId: string, email: string, role: string) => withPlatform(container.db, async (tx) => {
    let [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) [user] = await tx.insert(users).values({ email, name: email.split("@")[0] }).returning();
    await tx.insert(memberships).values({ companyId, userId: user.id, role, status: "active" });
    return user.id;
  });
  /** Everyone on a company, by status. */
  const statusesOf = async (companyId: string) => (await container.db.select({ status: memberships.status }).from(memberships).where(eq(memberships.companyId, companyId))).map((m) => m.status).sort();
  /** A company an administrator accepted: live, its owner signed in, with a real open job and a draft of its own. */
  const openCompany = async (email: string, name: string) => {
    const asker = await ask(email, name);
    const accepted = await decide(await admin(), asker.id, "accept");
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    const roleId = await plantRole(asker.id, `${name} assistant`);
    const owner = (await meOf(asker.cookie)).user.id;
    const [draft] = await container.db.insert(intakeSessions).values({ companyId: asker.id, createdBy: { kind: "user", id: owner }, createdByUserId: owner }).returning({ id: intakeSessions.id });
    return { cookie: asker.cookie, id: asker.id, slug: (await rowOf(asker.id)).slug, roleId, session: draft.id };
  };
  return { container, app, json, read, code, mail, form, google, signupOf, meOf, admin, decide, ask, statusOf, rowOf, runsOf, aiRunsOf, noticesOf, eventsOf, alertsOf, customers, mailTo, plantRole, plantPerson, openCompany, addMember, statusesOf };
}

async function boot(extra: Env = {}): Promise<World> {
  const container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SIGNUP_MODE: "approval", EMAIL_REPLY_TO: "recruiting@its.example", ITS_QUEUE_EMAIL: "queue@its.example", RATE_LIMIT_OVERRIDES: NO_LIMITS, ...extra }));
  return worldOf(container, createApp(container));
}

describe("the sign-up mode (env.ts)", () => {
  const refusal = (source: Env): string | null => {
    try {
      loadEnv(source);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it("reads approval and open, refuses anything else by name, and the welcome page's reader agrees", () => {
    expect(loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "approval" }).SIGNUP_MODE).toBe("approval");
    expect(signupModeOf({ SIGNUP_MODE: "approval" })).toBe("approval");
    expect(loadEnv({ NODE_ENV: "test" }).SIGNUP_MODE).toBe("open");
    expect(signupModeOf({ SIGNUP_MODE: "" })).toBe("open");
    for (const other of ["Approval", "approved", "invite"]) expect(refusal({ NODE_ENV: "test", SIGNUP_MODE: other }), other).toContain(`SIGNUP_MODE must be "approval" or "open" (it is "${other}")`);
  });

  it("by approval everyone sends a request but a platform administrator; where sign-up is open everyone goes straight in", () => {
    const person = (platformRole = "none") => ({ platformRole });
    const approval = loadEnv({ NODE_ENV: "test", SIGNUP_MODE: "approval" });
    expect(signupDoor(approval, person())).toBe("request");
    expect(signupDoor(approval, person("platform_admin"))).toBe("direct");
    expect(signupDoor(loadEnv({ NODE_ENV: "test" }), person())).toBe("direct");
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

  it("what turns text around or takes no room goes, two of those are no name, and a typed name cannot pass for an address (the review of 6 November 2026)", () => {
    const ch = (...codes: number[]) => String.fromCharCode(...codes);
    const [zwsp, wordJoiner, rlo, lri, pdi, lrm, zwnj] = [ch(0x200b), ch(0x2060), ch(0x202e), ch(0x2066), ch(0x2069), ch(0x200e), ch(0x200c)];
    expect(oneLine(`Harbor Dental${rlo} is asking`)).toBe("Harbor Dental is asking");
    expect(oneLine(`${lri}Harbor${pdi}${lrm} ${zwsp}Dental${wordJoiner}`)).toBe("Harbor Dental");
    expect(oneLine(zwsp + zwsp)).toBe("");
    // the joiners stay: some names and emoji need them
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469);
    expect(oneLine(`Ni${zwnj}na ${family}`)).toBe(`Ni${zwnj}na ${family}`);
    expect(visibleLength("Al")).toBe(2);
    expect(visibleLength(`A${zwnj}`)).toBe(1);
    expect(visibleLength(ch(0x3164, 0x3164))).toBe(0);
    expect(visibleLength(String.fromCodePoint(0x1f600))).toBe(1);
    expect(typedName("Pat Example <pat@its.example>")).toBe("Pat Example pat@its.example");
    expect(typedName(" Sam\nAsker ")).toBe("Sam Asker");
    for (const none of [zwsp + zwsp, "A", ch(0x3164, 0x3164), "", null, undefined]) expect(typedName(none)).toBeNull();
    // a request's name needs two characters a reader can see; the person's name too, or it is left out
    const body = { name: "Harbor Dental", ownerName: "Sam Asker", vertical: "dental", sizeBand: "1-19" as const, timezone: "America/Chicago", locations: [{ city: "Austin", region: "TX", country: "US" }] };
    for (const blank of [zwsp + zwsp, ch(0x3164, 0x3164), `${rlo}A`]) expect(() => companyRequestDetails({ ...body, name: blank })).toThrow(/missing or invalid/);
    expect(companyRequestDetails({ ...body, name: `Harbor Dental${rlo}` }).name).toBe("Harbor Dental");
    expect(companyRequestDetails({ ...body, ownerName: "Pat Example <pat@its.example>" }).ownerName).toBe("Pat Example pat@its.example");
    expect(companyRequestDetails({ ...body, ownerName: zwsp + zwsp }).ownerName).toBeUndefined();
  });

  it("half a character never stays: the cut at the limit keeps an emoji whole or leaves it out, and a lone half from a hand-made body goes", () => {
    const smile = String.fromCodePoint(0x1f600);
    const [high, low] = [String.fromCharCode(0xd83d), String.fromCharCode(0xde00)];
    expect(oneLine(`${"w".repeat(199)}${smile}`, 200)).toBe("w".repeat(199));
    expect(oneLine(`${"w".repeat(198)}${smile}`, 200)).toBe(`${"w".repeat(198)}${smile}`);
    expect(oneLine(`Harbor${high} Dental${low}`)).toBe("Harbor Dental");
    expect(oneLine(`${low}${high}`)).toBe("");
    expect(oneLine(`Smile ${smile}`)).toBe(`Smile ${smile}`);
    expect(/\p{Cs}/u.test(oneLine(`${"c".repeat(119)}${smile}`, 120))).toBe(false);
  });

  it("the accepted email says the company's name in one line, whatever is in the row", () => {
    const { subject, text } = renderAlertEmail({ kind: "company.access_accepted", recipientName: "Sam Asker", companyName: "Acme\r\nBcc: evil@example.test", roleTitle: null, link: "https://app.example/", appBaseUrl: "https://app.example" });
    expect(subject).toBe("Your request was approved");
    expect(text).toContain("Your request was approved.");
    expect(text).toContain("Company: Acme Bcc: evil@example.test\n");
    expect(text).toContain("Open it: https://app.example/\n");
    expect(text).toContain(ALWAYS_EMAILED_LINE);
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

describe("a company comes in by approval (SIGNUP_MODE=approval)", () => {
  let w: World;
  let adminCookie = "";

  beforeAll(async () => {
    w = await boot();
    adminCookie = await w.admin();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("the configuration says which door each person has", async () => {
    const signedOut = await w.signupOf();
    expect(signedOut).toEqual({ mode: "approval", allowed: false, contact: "recruiting@its.example", door: "none" });
    const stranger = await w.signupOf(await w.google("first.look@stranger.test"));
    expect(stranger).toEqual({ mode: "approval", allowed: true, contact: "recruiting@its.example", door: "request" });
    expect((await w.signupOf(adminCookie)).door).toBe("direct");
  });

  it("the full journey: the form sends a request, nothing starts, Accept opens everything", async () => {
    const before = w.mail().sent.length;
    const asker = await w.ask("sam@stranger.test", "Harbor Dental");
    // no careers address of its name until it is accepted: a neutral one (the review of 6 November 2026)
    expect(asker.slug).toBe(`request-${asker.id.slice(0, 8)}`);
    // the answer says where they stand, and the email really left
    expect(asker.accessRequest).toMatchObject({ status: "requested", companyName: "Harbor Dental", email: "sam@stranger.test" });
    expect(asker.accessRequest.emailedAt).toEqual(expect.any(String));
    // a request is a company with its owner's membership `requested`, on Free, not live, its entitlements there and counting nothing
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
    for (const line of ["Company: Harbor Dental", "Person: sam@stranger.test (Sam Asker)", "Kind of business: dental", "Size: 1-19 employees", "City and state: Austin, TX", "Website: https://asker.example", `${w.container.env.APP_BASE_URL}/admin`]) expect(toIts.text, line).toContain(line);

    // the administrator's list: the person, and what the row needs
    const listed = (await w.customers(adminCookie)).find((c) => c.id === asker.id)!;
    expect(listed.accessRequest).toEqual({ status: "requested", person: { name: "Sam Asker", email: "sam@stranger.test" }, declined: null });
    expect(listed).toMatchObject({ name: "Harbor Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Austin", region: "TX" }], website: "https://asker.example", status: "waiting", statusLabel: "Waiting", accessDecisions: ["accept", "decline"], owner: null, planKey: FREE_PLAN_KEY, planName: "Free", jobs: { open: 0, total: 0 }, applicants: 0, careersUrl: null, planRequest: null });
    expect(listed.createdAt).toBe(new Date(listed.createdAt).toISOString());
    expect(listed.seats.used).toBe(0);
    expect((await w.customers(adminCookie)).filter((c) => c.id !== asker.id).every((c) => c.accessRequest === null)).toBe(true);

    // Accept
    const accepted = await w.decide(adminCookie, asker.id, "accept");
    expect(accepted.status).toBe(200);
    expect(await w.read<CustomerAccessAnswer>(accepted)).toEqual({ ok: true, companyId: asker.id, decision: "accept", status: "active", changed: true, message: "Harbor Dental was accepted." });
    // no draining here: the route kicks the worker itself
    expect(await w.statusOf(asker.id)).toBe("active");
    const after = await w.rowOf(asker.id);
    // on Free, and accepting is the one gate: the company is live from this press
    expect(after.planKey).toBe(FREE_PLAN_KEY);
    expect(after.settings.verifiedAt).toEqual(expect.any(String));
    // exactly one notice, to the owner, and one email about it
    const notices = await w.noticesOf(asker.id);
    expect(notices.map((n) => [n.kind, n.title])).toEqual([["company.access_accepted", "Your request was approved"]]);
    expect(notices[0].userId).toBe(me.user.id);
    expect(notices[0].action).toEqual({ label: "Open Home", href: "/" });
    expect(w.mailTo("sam@stranger.test").filter((m) => m.subject === "Your request was approved")).toHaveLength(1);
    const email = w.mailTo("sam@stranger.test").find((m) => m.subject === "Your request was approved")!;
    expect(email.text).toContain("Your request was approved.");
    expect(email.text).toContain(`Open it: ${w.container.env.APP_BASE_URL}/`);
    expect(w.mailTo("sam@stranger.test").map((m) => m.subject)).toEqual(["Your request has been sent", "Your request was approved"]);
    // recorded once, by the administrator, with the stock reason
    const audited = await w.container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, asker.id), eq(auditRecords.action, "company.access_accepted")));
    expect(audited.map((a) => [a.reason, a.actor.name])).toEqual([["Accepted from the dashboard", "Ada Admin"]]);
    expect(await w.eventsOf(asker.id, "company.access_accepted")).toHaveLength(1);
    // their waiting screen moves on by itself: the same session now has the tenant, with no reload of anything
    const open = await w.meOf(asker.cookie);
    expect(open.activeCompanyId).toBe(asker.id);
    expect(open.memberships).toEqual([expect.objectContaining({ companyId: asker.id, role: "owner" })]);
    expect((await signIn()).activeCompanyId).toBe(asker.id);
    const current = await w.json(asker.cookie, "GET", "/api/v1/companies/current");
    expect(current.status).toBe(200);
    expect(await w.read<CompanyView>(current)).toMatchObject({ id: asker.id, name: "Harbor Dental", plan: { key: FREE_PLAN_KEY }, viewer: { mayEdit: true } });
    expect((await w.json(asker.cookie, "GET", "/api/v1/home")).status).toBe(200);
    expect((await w.json(asker.cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE })).status).toBe(201);
    // and it is live, so its public side is up, at the careers address of its name, given at Accept
    expect(after.slug).toBe("harbor-dental");
    expect((await w.app.request("/careers/harbor-dental")).status).toBe(200);
    expect((await w.app.request(`/careers/${asker.slug}`)).status).toBe(404);
    // the configuration has moved on too
    expect((await w.signupOf(asker.cookie)).request).toBeUndefined();
    expect((await w.customers(adminCookie)).find((c) => c.id === asker.id)).toMatchObject({ accessRequest: null, status: "active", statusLabel: "Active", accessDecisions: ["remove"], owner: { name: "Sam Asker", email: "sam@stranger.test" }, seats: { used: 1 }, careersUrl: `${w.container.env.JOBS_BASE_URL}/careers/harbor-dental` });
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
    // the dashboard shows when and by whom
    const listed = (await w.customers(adminCookie)).find((c) => c.id === asker.id)!;
    expect(listed.accessRequest?.status).toBe("declined");
    expect(listed.accessRequest?.declined).toEqual({ at: expect.any(String), by: "Ada Admin" });
    const audited = await w.container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, asker.id), eq(auditRecords.action, "company.access_declined")));
    expect(audited).toHaveLength(1);
    expect(audited[0].reason).toBe("Declined from the dashboard");
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
    expect(await w.noticesOf(asker.id)).toHaveLength(1);
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
    // nothing moved: still declined and not live, no Accept, no notice, no workflow, and one email, the Decline's
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

  it("the first press wins over Take away access too: an Accept from a row that still showed the request says the access was taken away, by whom and when, never an older Decline", async () => {
    const shown = { from: "requested", confirm: true };
    const refusal = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details: unknown } }).error;
    // one console accepts the request and later takes its access away; another, not looked at again, still shows the request
    const asker = await w.ask("stale.removed@stranger.test", "Stale Removed");
    expect((await w.decide(adminCookie, asker.id, "accept", shown)).status).toBe(200);
    expect((await w.decide(adminCookie, asker.id, "remove")).status).toBe(200);
    const [removed] = await w.eventsOf(asker.id, "company.access_removed");
    const stale = await w.decide(adminCookie, asker.id, "accept", shown);
    expect(stale.status).toBe(409);
    const error = await refusal(stale);
    expect(error.code).toBe("access_decided");
    expect(error.message).toBe("Stale Removed's access was taken away a moment ago by Ada Admin. Nothing changed. To let them in again, accept it under Declined.");
    expect(error.details).toEqual({ status: "declined", decidedAt: removed.occurredAt, decidedBy: "Ada Admin" });
    // nothing moved: still declined, one Accept on the record, the first
    expect(await w.statusOf(asker.id)).toBe("declined");
    expect(await w.eventsOf(asker.id, "company.access_accepted")).toHaveLength(1);
    // declined once as a request three days ago, accepted under Declined, then taken away: the removal is what it says
    const twice = await w.ask("declined.then.removed@stranger.test", "Declined Then Removed");
    expect((await w.decide(adminCookie, twice.id, "decline", shown)).status).toBe(200);
    const daysAgo = new Date(w.container.engine.clock().getTime() - 3 * 86_400_000 - 60_000).toISOString();
    await withPlatform(w.container.db, (tx) => tx.update(events).set({ occurredAt: daysAgo }).where(and(eq(events.companyId, twice.id), eq(events.type, "company.access_declined"))));
    expect((await w.decide(adminCookie, twice.id, "accept", { from: "declined", confirm: true })).status).toBe(200);
    expect((await w.decide(adminCookie, twice.id, "remove")).status).toBe(200);
    const [taken] = await w.eventsOf(twice.id, "company.access_removed");
    const late = await refusal(await w.decide(adminCookie, twice.id, "accept", shown));
    expect(late.message).toBe("Declined Then Removed's access was taken away a moment ago by Ada Admin. Nothing changed. To let them in again, accept it under Declined.");
    expect(late.details).toEqual({ status: "declined", decidedAt: taken.occurredAt, decidedBy: "Ada Admin" });
    // the declined company's own Accept, under Declined, is still the undo
    const undone = await w.decide(adminCookie, twice.id, "accept", { from: "declined", confirm: true });
    expect(await w.read<CustomerAccessAnswer>(undone)).toMatchObject({ status: "active", changed: true, message: "Declined Then Removed has access again." });
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
      await decideAccess(tx, { companyId: asker.id, decision: "decline", from: "requested", actor, now: w.container.engine.clock() });
      const held = await lock();
      expect(held.xmax).toBe(held.me);
    });
    expect(await w.statusOf(asker.id)).toBe("declined");
  });

  it("only a platform administrator with a second factor, a confirmation, and a real company", async () => {
    const asker = await w.ask("guarded@stranger.test", "Guarded Dental");
    const body = { decision: "accept", from: "requested", confirm: true };
    expect((await w.json("", "POST", `/api/v1/admin/customers/${asker.id}/access`, body)).status).toBe(401);
    // the person themselves
    expect(await w.code(await w.json(asker.cookie, "POST", `/api/v1/admin/customers/${asker.id}/access`, body))).toBe("forbidden");
    expect((await w.json(asker.cookie, "POST", `/api/v1/admin/customers/${asker.id}/access`, body)).status).toBe(403);
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

  it("the plan change and the trial extension refuse a request and a declined company; none lets anyone in", async () => {
    const waiting = await w.ask("console.waiting@stranger.test", "Console Waiting");
    const declined = await w.ask("console.declined@stranger.test", "Console Declined");
    await w.decide(adminCookie, declined.id, "decline");
    const actions: Array<[string, string, unknown]> = [
      ["trial", "/trial", { days: 10, reason: "A longer look.", confirm: true }],
      ["plan", "/plan", { planKey: "basic", reason: "A bigger plan." }],
    ];
    for (const { id, cookie } of [waiting, declined]) {
      const before = await w.rowOf(id);
      const history = (await w.container.db.select({ n: sql<number>`count(*)` }).from(events).where(eq(events.companyId, id)))[0].n;
      for (const [what, suffix, body] of actions) {
        const r = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${id}${suffix}`, body);
        expect(r.status, what).toBe(409);
        const error = ((await r.json()) as { error: { code: string; message: string; details: { path: string } } }).error;
        expect(error.code, what).toBe("access_request_open");
        expect(error.message, what).toMatch(/^This company/);
        expect(error.details.path, what).toBe(`/api/v1/admin/customers/${id}/access`);
      }
      // its jobs can be read, and there are none: a read is no door
      expect(await w.read<AdminCompanyJobs>(await w.json(adminCookie, "GET", `/api/v1/admin/customers/${id}/jobs`))).toMatchObject({ company: { id }, jobs: [] });
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
    // accepted, its plan can be changed, and the answer is the three facts
    await w.decide(adminCookie, waiting.id, "accept");
    const plan = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${waiting.id}/plan`, { planKey: "basic", reason: "A bigger plan." });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({ trialEnded: false, unlocked: 0, aiCreditMonthStarted: true });
    // and Accept of a company that is in changes nothing
    expect(await w.read<CustomerAccessAnswer>(await w.decide(adminCookie, waiting.id, "accept"))).toMatchObject({ changed: false, status: "active" });
  });

  it("a company that is already live keeps the time it went live, and Accept sends its one notice", async () => {
    const asker = await w.ask("confirmed@stranger.test", "Confirmed Already");
    await withPlatform(w.container.db, (tx) => tx.update(companies).set({ settings: sql`${companies.settings} || jsonb_build_object('verifiedAt', '2026-11-01T00:00:00.000Z'::text)` }).where(eq(companies.id, asker.id)));
    expect((await w.decide(adminCookie, asker.id, "accept")).status).toBe(200);
    await w.container.drain();
    expect((await w.rowOf(asker.id)).settings.verifiedAt).toBe("2026-11-01T00:00:00.000Z");
    expect((await w.noticesOf(asker.id)).map((n) => n.kind)).toEqual(["company.access_accepted"]);
    expect(w.mailTo("confirmed@stranger.test").filter((m) => m.subject === "Your request was approved")).toHaveLength(1);
  });

  it("a request holds no careers address of its name: a stranger cannot take a real company's, and Accept gives the name's address, or the next free one", async () => {
    const squatter = await w.ask("squatter@stranger.test", "Bright Smile Dental");
    expect(squatter.slug).toBe(`request-${squatter.id.slice(0, 8)}`);
    expect((await w.decide(adminCookie, squatter.id, "decline")).status).toBe(200);
    // the real company, set up by an administrator through the direct door, gets the address of its name
    const made = await w.read<{ id: string }>(await w.json(adminCookie, "POST", "/api/v1/companies", w.form("Bright Smile Dental")));
    expect((await w.rowOf(made.id)).slug).toBe("bright-smile-dental");
    // the declined one kept its neutral address; accepted after all, it gets the next free one, and the real one keeps its own
    expect((await w.rowOf(squatter.id)).slug).toBe(squatter.slug);
    expect((await w.decide(adminCookie, squatter.id, "accept")).status).toBe(200);
    expect((await w.rowOf(squatter.id)).slug).toMatch(/^bright-smile-dental-[a-z0-9]{1,4}$/);
    expect((await w.rowOf(made.id)).slug).toBe("bright-smile-dental");
    // a request whose name's address is free gets exactly that, and answers there once it is public
    const free = await w.ask("free.name@stranger.test", "Quiet Harbor Dental");
    expect((await w.app.request("/careers/quiet-harbor-dental")).status).toBe(404);
    expect((await w.decide(adminCookie, free.id, "accept")).status).toBe(200);
    expect((await w.rowOf(free.id)).slug).toBe("quiet-harbor-dental");
    expect((await w.app.request("/careers/quiet-harbor-dental")).status).toBe(200);
    expect((await w.app.request(`/careers/${free.slug}`)).status).toBe(404);
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
    // the dashboard's row is what tells an administrator
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
      expect(await w.container.db.select().from(adminAlerts).where(inArray(adminAlerts.kind, ["message.delivery_failed", "message.delivery_unknown"]))).toEqual([]);
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
    expect(toIts.text).toContain("Person: typed@stranger.test (Sam Asker)");
    expect(toIts.text).toContain("City and state: Aus tin, T X");
    expect(toIts.text.split("\n").find((l) => l.startsWith("Website: "))!.length).toBeLessThanOrEqual(209);
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

  it("half a character never fails a request: an emoji at the cut of a long website or place, and a lone half in a hand-made body (the review of 6 November 2026)", async () => {
    const smile = String.fromCodePoint(0x1f600);
    const half = String.fromCharCode(0xd83d);
    // 199 characters and then an emoji: the cut at 200 would keep half of it, which the database refuses in a jsonb value
    const cut = await w.ask("emoji.cut@stranger.test", "Emoji Cut Dental", { website: `https://${"w".repeat(191)}${smile}`, locations: [{ city: `${"c".repeat(119)}${smile}`, region: "TX", country: "US" }] });
    const row = await w.rowOf(cut.id);
    expect(row.settings.website).toBe(`https://${"w".repeat(191)}`);
    expect(row.locations[0]?.city).toBe("c".repeat(119));
    expect(w.mailTo("queue@its.example").some((m) => m.subject === "[access request] Emoji Cut Dental is asking for access")).toBe(true);
    // a hand-made body with half an emoji and nothing to cut: the half goes, and the request is sent
    const hand = await w.ask("half.char@stranger.test", `Half${half} Dental`, { website: `https://half${half}.example`, ownerName: `Sam${half} Asker` });
    expect((await w.rowOf(hand.id)).name).toBe("Half Dental");
    expect((await w.rowOf(hand.id)).settings.website).toBe("https://half.example");
    expect((await w.customers(adminCookie)).find((c) => c.id === hand.id)?.accessRequest?.person.name).toBe("Sam Asker");
    // a whole one stays
    const whole = await w.ask("whole.emoji@stranger.test", `Smile ${smile} Dental`);
    expect((await w.rowOf(whole.id)).name).toBe(`Smile ${smile} Dental`);
  });

  it("a typed name cannot pass for someone else, blank the row or turn it around: the proved address first, no angle brackets, two characters to see", async () => {
    const rlo = String.fromCharCode(0x202e);
    const zwsp = String.fromCharCode(0x200b);
    // two zero-width spaces are no company name, so nothing is made
    const blank = await w.google("blank.name@stranger.test");
    expect((await w.json(blank, "POST", "/api/v1/companies", w.form(zwsp + zwsp))).status).toBe(400);
    expect((await w.signupOf(blank)).request).toBeUndefined();
    const posing = await w.ask("real.person@gmail.test", `Harbor Dental${rlo} Group`, { ownerName: "Pat Example <pat@its.example>" });
    expect((await w.rowOf(posing.id)).name).toBe("Harbor Dental Group");
    const toIts = w.mailTo("queue@its.example").find((m) => m.subject === "[access request] Harbor Dental Group is asking for access")!;
    expect(toIts.text).toContain("Person: real.person@gmail.test (Pat Example pat@its.example)\n");
    expect(toIts.text).toContain("Only the email address is proved; the rest is what they typed.");
    expect(toIts.text).not.toMatch(/[<>]/);
    // the dashboard's row, from what was kept
    expect((await w.customers(adminCookie)).find((c) => c.id === posing.id)?.accessRequest?.person).toEqual({ name: "Pat Example pat@its.example", email: "real.person@gmail.test" });
    // a name from the sign-in provider, when they typed none, is read the same way
    const provider = await w.google("provider.name@stranger.test", `Ada <ada@identifiedtalent.com>${rlo}`);
    const made = await w.json(provider, "POST", "/api/v1/companies", w.form("Provider Dental", { ownerName: undefined }));
    expect(made.status, await made.clone().text()).toBe(201);
    const { id } = await w.read<{ id: string }>(made);
    expect((await w.customers(adminCookie)).find((c) => c.id === id)?.accessRequest?.person.name).toBe("Ada ada@identifiedtalent.com");
    expect(w.mailTo("queue@its.example").find((m) => m.subject === "[access request] Provider Dental is asking for access")!.text).toContain("Person: provider.name@stranger.test (Ada ada@identifiedtalent.com)\n");
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

  it("a platform administrator sets a company up through the direct door, more than one, each live at once", async () => {
    const before = w.mail().sent.length;
    expect(await w.signupOf(adminCookie)).toMatchObject({ mode: "approval", allowed: true, door: "direct" });
    for (const name of ["Set Up One", "Set Up Two"]) {
      const made = await w.json(adminCookie, "POST", "/api/v1/companies", w.form(name));
      expect(made.status).toBe(201);
      const company = await w.read<{ id: string; name: string; accessRequest: unknown }>(made);
      expect(company).toEqual({ id: company.id, name, accessRequest: null });
      expect(await w.statusOf(company.id)).toBe("active");
      const row = await w.rowOf(company.id);
      expect(row.settings.verifiedAt).toEqual(expect.any(String));
      expect((await w.app.request(`/careers/${row.slug}`)).status).toBe(200);
      expect((await w.customers(adminCookie)).find((c) => c.id === company.id)).toMatchObject({ accessRequest: null, status: "active" });
    }
    // nobody is asked: there is no request, so no email about one
    expect(w.mail().sent.slice(before)).toEqual([]);
  });

  it("a team invitation to some other company still works for someone waiting or declined; none opens their own request", async () => {
    const host = await w.openCompany("host@listed-domain.test", "Host Dental");
    await withPlatform(w.container.db, (tx) => tx.update(entitlements).set({ limit: 10 }).where(and(eq(entitlements.companyId, host.id), eq(entitlements.key, "seats"))));
    const waiting = await w.ask("invited.waiting@stranger.test", "Invited Waiting");
    const declined = await w.ask("invited.declined@stranger.test", "Invited Declined");
    await w.decide(adminCookie, declined.id, "decline");
    for (const person of [waiting, declined]) {
      expect((await w.json(host.cookie, "POST", "/api/v1/companies/current/members/invite", { email: person.email, role: "hiring_manager" })).status).toBe(201);
      const again = await w.google(person.email);
      const me = await w.meOf(again);
      expect(me.activeCompanyId).toBe(host.id);
      expect(me.memberships).toEqual([expect.objectContaining({ companyId: host.id, role: "hiring_manager" })]);
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

  it("someone waiting still reads where they stand, and can be accepted, where sign-up is open", async () => {
    const asker = await w.ask("door@stranger.test", "Door Dental");
    w.container.env.SIGNUP_MODE = "open";
    try {
      expect(await w.signupOf(asker.cookie)).toEqual({ mode: "open", allowed: false, contact: "recruiting@its.example", request: { status: "requested", companyName: "Door Dental", email: "door@stranger.test", emailedAt: asker.accessRequest.emailedAt } });
      expect(await w.signupOf(await w.google("walk.in@stranger.test"))).toEqual({ mode: "open", allowed: true, contact: "recruiting@its.example" });
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

  it("a company cannot write the record of its request's email, nor what makes it live", async () => {
    const asker = await w.ask("settings@stranger.test", "Settings Dental");
    await w.decide(adminCookie, asker.id, "accept");
    const before = await w.rowOf(asker.id);
    for (const body of [{ settings: { accessRequestEmailedAt: "2026-01-01T00:00:00.000Z" } }, { settings: { verifiedAt: null } }, { verifiedAt: "2026-01-01T00:00:00.000Z" }, { accessRequestEmailedAt: "2026-01-01T00:00:00.000Z" }]) {
      const refused = await w.json(asker.cookie, "PATCH", "/api/v1/companies/current", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(await w.code(refused)).toBe("invalid_request");
    }
    expect((await w.rowOf(asker.id)).settings).toEqual(before.settings);
  });

  it("a bounce of these emails stops the address as ever and raises nothing about a team member: they are on nobody's team yet", async () => {
    const asker = await w.ask("bounced@stranger.test", "Bounced Dental");
    const [copy] = w.mailTo("bounced@stranger.test");
    const bounce = async (id: number, providerMessageId: string) => w.app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fakePostmarkEvent({ providerMessageId, email: "bounced@stranger.test", type: "HardBounce", id })) });
    const unreachable = () => w.container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "email.person_unreachable"), sql`${adminAlerts.title} like '%bounced@stranger.test%'`));
    expect((await w.signupOf(asker.cookie)).request?.emailedAt).toEqual(expect.any(String));
    expect((await bounce(910_001, copy.providerMessageId)).status).toBe(200);
    expect(await unreachable()).toEqual([]);
    const [stopped] = await w.container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "bounced@stranger.test"));
    expect(stopped.active).toBe(true);
    // the copy did leave, but nothing more can reach that address: the screen stops promising an email (the review of
    // 6 November 2026), and says to keep the page open instead; the record of the copy stays as it was
    expect((await w.signupOf(asker.cookie)).request).toMatchObject({ status: "requested", emailedAt: null });
    expect((await w.rowOf(asker.id)).settings.accessRequestEmailedAt).toEqual(expect.any(String));
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

  it("two companies of one name accepted or made at the same moment do not both take its address: each waits on the name's lock, then reads the other's (the review of 9 November 2026)", async () => {
    // PGlite runs one connection, so it cannot show a second transaction waiting; this shows the order of the statements
    // only. The lock on the name's address is asked before the address is read as free: at that moment a company of the
    // same name takes it, as one committed by the transaction the lock waited for, and the address read after the lock is
    // the next free one. Read before the lock, it would have been taken twice and failed on the unique index.
    const seen: string[] = [];
    const rival = (slug: string) => async (tx: Tx) => {
      await tx.insert(companies).values({ name: "A company of the same name", slug, vertical: "dental", sizeBand: "1-19", planKey: FREE_PLAN_KEY, status: "active" });
    };
    const watched = (tx: Tx, atLock: (tx: Tx) => Promise<void>) => new Proxy(tx, {
      get(target, prop) {
        if (prop !== "execute") return Reflect.get(target, prop);
        return async (statement: Parameters<Tx["execute"]>[0]) => {
          const key = slugLockOf(statement);
          if (key) {
            seen.push(key);
            await atLock(target);
          }
          return target.execute(statement);
        };
      },
    });
    // Accept of a request, while another Twin Harbor Dental takes the name's address
    const asker = await w.ask("twin.request@stranger.test", "Twin Harbor Dental");
    const actor = { kind: "user" as const, id: "ada", name: "Ada Admin" };
    await withPlatform(w.container.db, (tx) => decideAccess(watched(tx, rival("twin-harbor-dental")), { companyId: asker.id, decision: "accept", from: "requested", actor, now: w.container.engine.clock() }));
    expect(seen).toEqual(["company_slug:twin-harbor-dental"]);
    expect((await w.rowOf(asker.id)).slug).toMatch(/^twin-harbor-dental-[a-z0-9]{1,4}$/);
    expect(await w.statusOf(asker.id)).toBe("active");
    // the direct door, while another Twin Direct Dental takes it
    seen.length = 0;
    const owner = (await w.meOf(await w.google("twin.direct@listed-domain.test", "Twin Owner"))).user;
    const db = new Proxy(w.container.db, {
      get(target, prop) {
        if (prop !== "transaction") return Reflect.get(target, prop);
        return (fn: (tx: Tx) => Promise<unknown>) => target.transaction((tx) => fn(watched(tx as unknown as Tx, rival("twin-direct-dental"))));
      },
    });
    const made = await createCompany(db, CreateCompany.parse(w.form("Twin Direct Dental")), owner.id, { kind: "user", id: owner.id, name: "Twin Owner" });
    expect(seen).toEqual(["company_slug:twin-direct-dental"]);
    expect(made.slug).toMatch(/^twin-direct-dental-[a-z0-9]{1,4}$/);
  });
});

/** The key of a lock on a careers address (`freeSlug`), when the statement is one; null for any other statement. */
function slugLockOf(statement: unknown): string | null {
  const chunks = (statement as { queryChunks?: unknown[] }).queryChunks ?? [];
  const text = chunks.map((c) => (c && typeof c === "object" && Array.isArray((c as { value?: unknown }).value) ? (c as { value: unknown[] }).value.join("") : "")).join("");
  const key = chunks.find((c): c is string => typeof c === "string" && c.startsWith("company_slug:"));
  return text.includes("pg_advisory_xact_lock") && key ? key : null;
}

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
    w = await boot({ RATE_LIMIT_OVERRIDES: OTHERS_UNLIMITED });
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
    // another address still asks, and an administrator's direct door is not this door
    expect((await askFrom("198.51.100.20", "elsewhere@stranger.test", "Elsewhere Dental")).status).toBe(201);
    expect((await w.app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie: adminCookie, "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(w.form("Listed Flood Dental")) })).status).toBe(201);
  });

  it("past 25 waiting at once, a request is still taken and on the dashboard, but neither email goes and the screen claims none; with fewer waiting they go again", async () => {
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
 * Nothing public until an administrator accepts. Here each company has a real open job behind it, so only the gate stands
 * between it and the public.
 */
describe("a request or a declined company shows nothing publicly", () => {
  let w: World;
  let adminCookie = "";

  beforeAll(async () => {
    w = await boot();
    adminCookie = await w.admin();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("no careers page, job page, apply form, sitemap entry or privacy-form mention; Accept is what opens them", async () => {
    const waiting = await w.ask("public.waiting@stranger.test", "Zqpublicwaitingname");
    const declined = await w.ask("public.declined@stranger.test", "Zqpublicdeclinedname");
    await w.decide(adminCookie, declined.id, "decline");
    for (const person of [waiting, declined]) {
      // the point of it all: a request is not live, and nothing says it was
      expect((await w.rowOf(person.id)).settings.verifiedAt).toBeUndefined();
      const roleId = await w.plantRole(person.id, "Zqpublicrole");
      for (const path of [`/careers/${person.slug}`, `/careers/${person.slug}/logo/x.png`, `/careers/${person.slug}/jobs/${roleId}`, `/careers/${person.slug}/jobs/${roleId}/apply`, `/careers/${person.slug}/jobs/${roleId}/applied`]) expect((await w.app.request(path)).status, path).toBe(404);
      expect((await w.app.request(`/careers/${person.slug}/jobs/${roleId}/apply`, { method: "POST", body: new FormData() })).status).toBe(404);
      resetSitemapCache(w.container);
      const sitemap = await (await w.app.request("/sitemap.xml")).text();
      expect(sitemap).not.toContain(roleId);
      expect(sitemap).not.toMatch(/Zqpublic/i);
      expect(sitemap).not.toContain(person.slug);
      // the administrator reads the job as counts, with no public page to open
      const listed = await w.read<AdminCompanyJobs>(await w.json(adminCookie, "GET", `/api/v1/admin/customers/${person.id}/jobs`));
      expect(listed.jobs).toEqual([expect.objectContaining({ id: roleId, title: "Zqpublicrole", status: "open", jobPageUrl: null })]);
      // the privacy form, named by the careers address, answers as if there were no such company
      const mails = w.mail().sent.length;
      const form = new URLSearchParams({ email: "curious@people.test", kind: "access", company: person.slug });
      expect((await w.app.request("/c/privacy-request", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() })).status).toBe(200);
      const told = w.mail().sent.slice(mails);
      expect(told.map((m) => m.subject)).toEqual(["About your privacy request"]);
      expect(told[0].text).not.toMatch(/Zqpublic/i);
    }
    // Accept opens them, at the careers address of its name, given at Accept: the neutral one it held answers nothing
    expect((await w.decide(adminCookie, waiting.id, "accept")).status).toBe(200);
    await w.container.drain();
    const { slug } = await w.rowOf(waiting.id);
    expect(slug).toBe("zqpublicwaitingname");
    expect((await w.app.request(`/careers/${slug}`)).status).toBe(200);
    expect(await (await w.app.request(`/careers/${slug}`)).text()).toContain("Zqpublicrole");
    expect((await w.app.request(`/careers/${waiting.slug}`)).status).toBe(404);
    // no reset here: the route rebuilds the sitemap itself
    expect(await (await w.app.request("/sitemap.xml")).text()).toContain(slug);
    const [job] = (await w.read<AdminCompanyJobs>(await w.json(adminCookie, "GET", `/api/v1/admin/customers/${waiting.id}/jobs`))).jobs;
    expect(job.jobPageUrl).toBe(`${w.container.env.JOBS_BASE_URL}/careers/${slug}/jobs/${job.id}`);
    expect((await w.noticesOf(waiting.id)).map((n) => n.kind)).toEqual(["company.access_accepted"]);
    // the declined one stays dark
    expect((await w.app.request(`/careers/${declined.slug}`)).status).toBe(404);
    expect(await (await w.app.request("/sitemap.xml")).text()).not.toContain(declined.slug);
  });
});

describe("where sign-up is open (SIGNUP_MODE=open: a person's machine and the tests)", () => {
  it("a company is live the moment it is created: no request, no email, its owner at work and its careers page public", async () => {
    const w = await boot({ SIGNUP_MODE: "open" });
    try {
      expect(await w.signupOf()).toEqual({ mode: "open", allowed: true, contact: "recruiting@its.example" });
      const cookie = await w.google("open.owner@stranger.test", "Open Owner");
      const before = w.mail().sent.length;
      expect((await w.json(cookie, "POST", "/api/v1/companies", { name: "" })).status).toBe(400);
      const made = await w.json(cookie, "POST", "/api/v1/companies", w.form("Open Door Dental"));
      expect(made.status).toBe(201);
      const company = await w.read<{ id: string; name: string; accessRequest: unknown }>(made);
      expect(company).toEqual({ id: company.id, name: "Open Door Dental", accessRequest: null });
      expect(w.mail().sent.slice(before)).toEqual([]);
      expect(await w.statusOf(company.id)).toBe("active");
      expect((await w.meOf(cookie)).activeCompanyId).toBe(company.id);
      const row = await w.rowOf(company.id);
      expect(row.slug).toBe("open-door-dental");
      expect(row.settings.verifiedAt).toEqual(expect.any(String));
      expect((await w.app.request("/careers/open-door-dental")).status).toBe(200);
      // a second company of their own still goes through ITS
      expect(await w.code(await w.json(cookie, "POST", "/api/v1/companies", w.form("Open Door Two")))).toBe("another_company_needs_its");
    } finally {
      await w.container.close();
    }
  });
});

/** A made-up token for the pages behind a person's own link: nobody waiting holds one. */
const NOT_A_TOKEN = "not-a-real-token";
const NOBODY = "00000000-0000-4000-8000-000000000000";

type Targets = { company: string; userId: string; slug: string; role: string; application: string; session: string };

/** What each parameter of each route is filled with, by the prefix it sits under. A new route with a new parameter joins here. */
const FILL = (t: Targets): Array<[string, Record<string, string>]> => [
  ["/api/v1/auth/start", { provider: "google" }],
  ["/api/v1/companies/current/invitations", { id: NOBODY }],
  ["/api/v1/companies/current/members", { userId: t.userId }],
  ["/api/v1/intake/sessions", { id: t.session, revisionId: NOBODY }],
  ["/api/v1/roles", { id: t.role, channel: "linkedin", revisionId: NOBODY, version: "1" }],
  ["/api/v1/applications", { id: t.application, communicationId: NOBODY, documentId: NOBODY, assessmentId: NOBODY }],
  ["/api/v1/admin/platform-roles", { grantId: NOBODY }],
  ["/api/v1/admin/customers", { id: t.company }],
  ["/api/v1/admin", { id: NOBODY }],
  ["/c/status", { token: NOT_A_TOKEN, id: NOBODY, roleId: t.role }],
  ["/c/screen", { token: NOT_A_TOKEN, key: "q1" }],
  ["/c/", { token: NOT_A_TOKEN }],
  ["/careers", { slug: t.slug, roleId: t.role, file: "x.png" }],
  ["/files", { token: NOT_A_TOKEN }],
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
  { routes: ["POST /api/v1/auth/logout"], allow: [200], why: "Signing out: their own session." },
  { routes: ["POST /api/v1/auth/reauth/start"], allow: [200], why: "Confirming it is them, about their own session; it reads no company." },
  { routes: ["POST /api/v1/companies"], allow: [400], why: "The form itself. A body this empty is refused; a real one, for someone waiting or declined, answers 409 (tested below)." },
  // Signing in: they answer any browser the same, and open nothing without a proof nobody here sent.
  { routes: ["GET /api/v1/auth/start/:provider", "GET /api/v1/auth/callback", "GET /api/v1/auth/consume", "POST /api/v1/auth/consume", "GET /api/v1/auth/mfa", "POST /api/v1/auth/mfa", "GET /api/v1/auth/mfa/backup", "POST /api/v1/auth/mfa/skip", "POST /api/v1/auth/mfa/cancel"], allow: [302], why: "The steps of a sign-in: a redirect to the provider, the sign-in page or Home." },
  { routes: ["POST /api/v1/auth/session", "POST /api/v1/auth/magic-link", "POST /api/v1/auth/magic-link/consume"], allow: [400], why: "A sign-in with nothing to prove it." },
  { routes: ["GET /api/v1/auth/invite", "POST /api/v1/auth/invite/email", "POST /api/v1/auth/invite/forget"], allow: [200], why: "The invitation page: with no token, it says so." },
  // Development only: each answers 404 in production or with a real provider.
  { routes: ["GET /api/v1/auth/fake/authorize", "POST /api/v1/auth/fake/authorize"], allow: [200, 302], why: "The fake identity provider's own pages." },
  // Their refusal, as a page.
  { routes: ["GET /api/v1/roles/:id/preview/page", "GET /api/v1/intake/sessions/:id/preview/page"], allow: [403], why: "A browser tab gets the preview's own plain page for the same refusal." },
  // What anyone can read, whoever is asking.
  { routes: /^(GET|POST) \/careers\//, allow: [404], why: "Their own company is not live, so these answer as if it did not exist. A live company's public pages are judged apart (PUBLIC_PAGES)." },
  { routes: /^(GET|POST) \/c\/(status|screen)\//, allow: [404], why: "A candidate's own pages behind a token, and nobody here holds one." },
  { routes: ["GET /files/get/:token"], allow: [403], why: "A grant for one object: this is none." },
  { routes: ["GET /c/link-request", "POST /c/link-request", "GET /c/privacy-request", "POST /c/privacy-request"], allow: [200, 400], why: "A candidate's forms: empty, they ask again." },
  { routes: ["GET /c/privacy-request/verify/:token", "POST /c/privacy-request/verify"], allow: [410], why: "The confirmation link of a privacy request: this is none." },
  { routes: ["GET /privacy", "GET /healthz", "GET /sitemap.xml", "GET /robots.txt"], allow: [200], why: "Public, for everyone: read for the markers; the sitemap names live companies only." },
  { routes: ["POST /api/csp-report"], allow: [204], why: "A browser's report: it reads nothing." },
  // Machines, by their own secrets, and the session is not read.
  { routes: /^POST \/webhooks\//, allow: [200, 400, 401, 403], why: "Providers' webhooks; an empty delivery changes nothing." },
];

type Answer = { method: string; route: string; status: number; code: string | undefined; text: string; ownName: string; ownEmail: string };

/** What is wrong with one answer to someone waiting or declined, in words that name the route; null when nothing is. */
function judge(a: Answer, marks: readonly string[], outside: Outside[], live = false): string | null {
  const name = `${a.method} ${a.route}`;
  if (a.status >= 500) return `${name} answered ${a.status}: ${a.text.slice(0, 200)}`;
  if (a.status === 429) return `${name} answered 429: a limit is no proof of the wall`;
  const publicPage = PUBLIC_PAGES.test(name);
  const hits = marks.filter((m) => a.text.toLowerCase().includes(m.toLowerCase())).filter((m) => {
    if (m === a.ownEmail) return false;
    if (publicPage && PUBLIC_MARKS.includes(m)) return false;
    return !(m === a.ownName && name === "GET /api/v1/auth/config");
  });
  if (hits.length) return `${name} holds ${hits.join(", ")}`;
  if (a.status === 403 && (a.code === "no_company" || a.code === "forbidden")) return null;
  // A live company's public pages answer anyone, signed in or not: only what they hold is judged, above.
  if (live && publicPage) return null;
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
async function sweep(w: World, app: ReturnType<typeof createApp>, person: { email: string; name: string }, targets: Targets, marks: readonly string[], opts: { live?: boolean; only?: (route: string) => boolean } = {}) {
  const table = FILL(targets);
  const problems: string[] = [];
  let wall = 0;
  let answers = 0;
  const cookie = await w.google(person.email);
  for (const { method, route } of everyRoute(app, opts.only)) {
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
      const problem = judge({ method, route, status: r.status, code, text: `${text} ${r.headers.get("location") ?? ""} ${r.headers.get("content-disposition") ?? ""}`, ownName: person.name, ownEmail: person.email }, marks, OUTSIDE_THE_WALL, opts.live);
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
  // An accepted company in use whose access was taken away (6 November 2026): its owner, a teammate, a job and a candidate.
  removedName: "Zqremovedcompanymark",
  removedEmail: "pat.zqremovedownermark@listed-domain.test",
  removedMemberEmail: "zqremovedmembermark@stranger.test",
  removedRole: "Zqremovedrolemark",
  removedPerson: "Zqremovedpersonmark",
};
const MARKS = Object.values(MARK);
/** A live company's careers pages and the sitemap are for everyone: they hold its name and its jobs' titles, and never a candidate. */
const PUBLIC_PAGES = /^(GET|POST) \/careers\/|^GET \/sitemap\.xml$/;
const PUBLIC_MARKS: readonly string[] = [MARK.otherName, MARK.otherRole];

/**
 * The wall, proved by the routes themselves: a waiting and a declined person, every route Hono knows, requireTenant or not,
 * with the real ids of their own company and of another one. Their own company and the other one each hold a role, a
 * candidate carrying a marker, so an answer that read any of them would be seen.
 */
describe("a waiting and a declined person reach nothing, by any route", () => {
  let w: World;
  let adminCookie = "";
  let other: Awaited<ReturnType<World["openCompany"]>>;
  let otherTargets: Targets;
  let waitingTargets: Targets;
  let declinedTargets: Targets;
  let waiting: Awaited<ReturnType<World["ask"]>>;
  let declined: Awaited<ReturnType<World["ask"]>>;
  let removed: Awaited<ReturnType<World["openCompany"]>>;
  let removedTargets: Targets;

  beforeAll(async () => {
    w = await boot();
    adminCookie = await w.admin();
    other = await w.openCompany(MARK.otherOwner, MARK.otherName);
    const otherRole = await w.plantRole(other.id, MARK.otherRole);
    const otherPerson = await w.plantPerson(other.id, otherRole, MARK.otherPerson);
    otherTargets = { company: other.id, userId: (await w.meOf(other.cookie)).user.id, slug: other.slug, role: otherRole, application: otherPerson.application, session: other.session };
    const prepare = async (email: string, name: string, site: string, roleMark: string, personMark: string) => {
      const asker = await w.ask(email, name, { website: `https://${site}.example`, ownerName: "Sam Asker" });
      const role = await w.plantRole(asker.id, roleMark);
      const person = await w.plantPerson(asker.id, role, personMark);
      return { asker, targets: { company: asker.id, userId: (await w.meOf(asker.cookie)).user.id, slug: asker.slug, role, application: person.application, session: NOBODY } };
    };
    ({ asker: waiting, targets: waitingTargets } = await prepare(MARK.waitingEmail, MARK.waitingName, MARK.waitingSite, MARK.waitingRole, MARK.waitingPerson));
    ({ asker: declined, targets: declinedTargets } = await prepare(MARK.declinedEmail, MARK.declinedName, MARK.declinedSite, MARK.declinedRole, MARK.declinedPerson));
    expect((await w.decide(adminCookie, declined.id, "decline")).status).toBe(200);
    // A company that had access and used it: live, with an open job, a candidate and a
    // teammate. Before its access is taken away its owner and teammate really do read the markers, so the sweep below
    // would see a single one of them leak.
    removed = await w.openCompany(MARK.removedEmail, MARK.removedName);
    const removedRole = await w.plantRole(removed.id, MARK.removedRole);
    const removedPerson = await w.plantPerson(removed.id, removedRole, MARK.removedPerson);
    await w.addMember(removed.id, MARK.removedMemberEmail, "hiring_manager");
    removedTargets = { company: removed.id, userId: (await w.meOf(removed.cookie)).user.id, slug: removed.slug, role: removedRole, application: removedPerson.application, session: removed.session };
    expect(await (await w.json(removed.cookie, "GET", `/api/v1/applications/${removedPerson.application}`)).text()).toContain(MARK.removedPerson);
    const teammate = await w.google(MARK.removedMemberEmail);
    expect(await (await w.json(teammate, "GET", "/api/v1/roles")).text()).toContain(MARK.removedRole);
    expect((await w.app.request(`/careers/${removed.slug}`)).status).toBe(200);
    expect((await w.decide(adminCookie, removed.id, "remove")).status).toBe(200);
    await w.container.drain();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("a route the sweep cannot fill fails and names itself", () => {
    expect(() => fillRoute("/api/v1/something-new/:widgetId", FILL(otherTargets))).toThrow(/cannot fill :widgetId of \/api\/v1\/something-new\/:widgetId/);
    expect(() => fillRoute("/api/v1/roles/:id/brand-new/:widgetId", FILL(otherTargets))).toThrow(/:widgetId of \/api\/v1\/roles\/:id\/brand-new\/:widgetId/);
    expect(fillRoute("/api/v1/applications/:id/documents/:documentId/file", FILL(otherTargets))).toBe(`/api/v1/applications/${otherTargets.application}/documents/${NOBODY}/file`);
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
        const done = await sweep(w, w.app, person, targets, MARKS, { live: targets === otherTargets });
        problems.push(...done.problems);
        wall += done.wall;
        answers += done.answers;
      }
    }
    expect([...new Set(problems)]).toEqual([]);
    // It is not a sweep of nothing: the route table is all there, and the wall itself refused most of it, each of the four times.
    expect(everyRoute(w.app).length).toBeGreaterThan(110);
    expect(answers).toBeGreaterThan(440);
    expect(wall).toBeGreaterThan(180);
    await w.container.drain();
    // Nothing moved: no AI run, no workflow, no notice, no message, no alert, not one event, in any company.
    expect(await snapshot(w, ids)).toEqual(before);
    expect((await w.container.db.select({ n: sql<number>`count(*)` }).from(aiRuns))[0].n).toBe(allAi);
    expect(await w.aiRunsOf(waiting.id)).toEqual([]);
    expect(await w.aiRunsOf(declined.id)).toEqual([]);
    expect(await w.runsOf(waiting.id)).toEqual([]);
    expect(await w.runsOf(declined.id)).toEqual([]);
  }, 300_000);

  it("an owner and a teammate whose company's access was taken away reach nothing either, by any route, with the ids of their own company and of another; nothing moved (6 November 2026)", async () => {
    const ids = [removed.id, other.id];
    const before = await snapshot(w, ids);
    const problems: string[] = [];
    let wall = 0;
    let answers = 0;
    // their own request reads the company's name on GET /auth/config (the declined screen), as a declined person's does
    for (const email of [MARK.removedEmail, MARK.removedMemberEmail]) {
      for (const targets of [removedTargets, otherTargets]) {
        const done = await sweep(w, w.app, { email, name: MARK.removedName }, targets, MARKS, { live: targets === otherTargets });
        problems.push(...done.problems);
        wall += done.wall;
        answers += done.answers;
      }
    }
    expect([...new Set(problems)]).toEqual([]);
    // not a sweep of nothing: the wall itself refused most of it, each of the four times
    expect(answers).toBeGreaterThan(440);
    expect(wall).toBeGreaterThan(180);
    await w.container.drain();
    expect(await snapshot(w, ids)).toEqual(before);
    // and neither of them can switch back into it
    for (const email of [MARK.removedEmail, MARK.removedMemberEmail]) {
      const cookie = await w.google(email);
      expect((await w.meOf(cookie)).memberships).toEqual([]);
      const r = await w.json(cookie, "POST", "/api/v1/auth/switch", { companyId: removed.id });
      expect(r.status, email).toBe(403);
    }
  }, 400_000);

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

/**
 * Taking an accepted company's access away: an administrator who accepts strangers must be able to undo that. Take away
 * access makes it a declined company in one transaction, no longer live; Accept is the undo.
 */
describe("taking an accepted company's access away", () => {
  let w: World;
  let adminCookie = "";
  /**
   * A company in use: accepted, with an open job and a teammate signed in. `meanwhile`
   * runs before the teammate joins (Free has two people, and an invitation takes one).
   */
  const inUse = async (owner: string, name: string, teammate: string, meanwhile?: (co: { cookie: string }) => Promise<void>) => {
    const co = await w.openCompany(owner, name);
    if (meanwhile) await meanwhile(co);
    await w.addMember(co.id, teammate, "hiring_manager");
    const mate = await w.google(teammate);
    expect((await w.meOf(mate)).activeCompanyId).toBe(co.id);
    return { ...co, mate };
  };

  beforeAll(async () => {
    w = await boot();
    adminCookie = await w.admin();
  });
  afterAll(async () => {
    await w.container.close();
  });

  it("everyone on it is out at once, in one press: memberships, sessions, invitations and the public side; one email to the owner, and they read the declined screen", async () => {
    // an invitation still open when the access goes
    const co = await inUse("pat.remove@listed-domain.test", "Remove Dental", "mel.mate@stranger.test", async (c) => {
      const invited = await w.json(c.cookie, "POST", "/api/v1/companies/current/members/invite", { email: "ivy.invited@stranger.test", role: "hiring_manager" });
      expect(invited.status, await invited.clone().text()).toBe(201);
    });
    expect((await w.app.request(`/careers/${co.slug}`)).status).toBe(200);
    await w.container.drain();
    const before = w.mail().sent.length;
    const r = await w.decide(adminCookie, co.id, "remove");
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await w.read<CustomerAccessAnswer>(r)).toEqual({ ok: true, companyId: co.id, decision: "remove", status: "declined", changed: true, message: "Remove Dental no longer has access.", people: 2, emailed: true });
    // everyone on it is declined, and every session they had in it ended
    expect(await w.statusesOf(co.id)).toEqual(["declined", "declined"]);
    expect((await w.json(co.cookie, "GET", "/api/v1/auth/me")).status).toBe(401);
    expect((await w.json(co.mate, "GET", "/api/v1/auth/me")).status).toBe(401);
    // signing in again opens nothing: the wall, and the declined screen
    for (const email of ["pat.remove@listed-domain.test", "mel.mate@stranger.test"]) {
      const again = await w.google(email);
      expect((await w.meOf(again)).activeCompanyId, email).toBeNull();
      expect(await w.code(await w.json(again, "GET", "/api/v1/companies/current")), email).toBe("no_company");
      expect(await w.signupOf(again), email).toMatchObject({ allowed: false, request: { status: "declined", companyName: "Remove Dental" } });
    }
    // an invitation still open would have let someone in: it is withdrawn
    expect(await w.container.db.select().from(invitations).where(and(eq(invitations.companyId, co.id), eq(invitations.status, "pending")))).toEqual([]);
    // it is no longer live: its pages are offline
    expect((await w.rowOf(co.id)).settings.verifiedAt).toBeUndefined();
    expect((await w.app.request(`/careers/${co.slug}`)).status).toBe(404);
    // one email, to the owner, with the declined email's words; nothing to the teammate, and nobody else was told
    const sent = w.mail().sent.slice(before);
    expect(sent.filter((m) => m.to === "pat.remove@listed-domain.test").map((m) => m.subject)).toEqual(["We can't offer access right now"]);
    expect(sent.find((m) => m.to === "pat.remove@listed-domain.test")!.text).toContain("Questions? recruiting@its.example");
    expect(sent.some((m) => m.to === "mel.mate@stranger.test")).toBe(false);
    // on the record, with the stock reason, and no alert
    expect(await w.eventsOf(co.id, "company.access_removed")).toHaveLength(1);
    const audited = await w.container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, co.id), eq(auditRecords.action, "company.access_removed")));
    expect(audited.map((a) => [a.reason, a.actor.name])).toEqual([["Access taken away from the dashboard", "Ada Admin"]]);
    expect(await w.alertsOf(co.id)).toEqual([]);
    // the dashboard: a declined company, its owner named, that its access was taken away, and its job with no public page
    const listed = (await w.customers(adminCookie)).find((c) => c.id === co.id)!;
    expect(listed).toMatchObject({ status: "declined", statusLabel: "Declined", accessDecisions: ["accept"], careersUrl: null, accessRequest: { status: "declined", removed: true, person: { email: "pat.remove@listed-domain.test" }, declined: { at: expect.any(String), by: "Ada Admin" } } });
    expect((await w.read<AdminCompanyJobs>(await w.json(adminCookie, "GET", `/api/v1/admin/customers/${co.id}/jobs`))).jobs.map((j) => [j.id, j.jobPageUrl])).toEqual([[co.roleId, null]]);
    // and its plan cannot be changed, as for any declined company
    const plan = await w.json(adminCookie, "POST", `/api/v1/admin/customers/${co.id}/plan`, { planKey: "basic", reason: "A bigger plan." });
    expect(plan.status).toBe(409);
    expect(((await plan.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "access_request_open", message: "This company's access was taken away. Accept it first if you want to let it in again." });
  });

  it("Accept brings everyone back, makes the company live again, tells each of them, and keeps everything they had", async () => {
    const co = await inUse("pat.undo@listed-domain.test", "Undo Dental", "una.mate@stranger.test");
    expect((await w.decide(adminCookie, co.id, "remove")).status).toBe(200);
    const mailsBefore = w.mail().sent.length;
    // the owner's first Accept told them their request was approved, once; the undo does not say so again
    const approvals = async () => (await w.noticesOf(co.id)).filter((n) => n.kind === "company.access_accepted").length;
    const approvalsBefore = await approvals();
    const undone = await w.decide(adminCookie, co.id, "accept");
    expect(await w.read<CustomerAccessAnswer>(undone)).toMatchObject({ status: "active", changed: true, message: "Undo Dental has access again." });
    await w.container.drain();
    expect(await w.statusesOf(co.id)).toEqual(["active", "active"]);
    expect((await w.rowOf(co.id)).settings.verifiedAt).toEqual(expect.any(String));
    expect((await w.app.request(`/careers/${co.slug}`)).status).toBe(200);
    // each of them hears their access is back, in those words: the notice has a kind of its own, so its email says the same
    const back = (await w.noticesOf(co.id)).filter((n) => n.kind === "company.access_restored");
    expect(back.map((n) => n.title)).toEqual(["Your access is back", "Your access is back"]);
    expect([approvalsBefore, await approvals()]).toEqual([1, 1]);
    // the email too, to the owner and the teammate alike: nobody made a request (the release review, 11 November 2026, L3-4)
    const told = w.mail().sent.slice(mailsBefore).filter((m) => ["pat.undo@listed-domain.test", "una.mate@stranger.test"].includes(m.to) && /^Your (access is back|request was approved)/.test(m.subject));
    expect(told.map((m) => [m.to, m.subject]).sort()).toEqual([["pat.undo@listed-domain.test", "Your access is back"], ["una.mate@stranger.test", "Your access is back"]]);
    for (const m of told) {
      expect(m.text).toContain("Your access is back.");
      expect(m.text).not.toContain("Your request was approved");
    }
    // they sign in to it as before, and what they had is there
    const owner = await w.google("pat.undo@listed-domain.test");
    expect((await w.meOf(owner)).activeCompanyId).toBe(co.id);
    expect(await (await w.json(owner, "GET", "/api/v1/roles")).text()).toContain(co.roleId);
    expect((await w.meOf(await w.google("una.mate@stranger.test"))).activeCompanyId).toBe(co.id);
    expect((await w.customers(adminCookie)).find((c) => c.id === co.id)?.accessRequest).toBeNull();
  });

  it("a second press changes nothing; a request, a declined company and one with nobody active are told calmly, and nothing moves", async () => {
    const co = await inUse("pat.twice@listed-domain.test", "Twice Removed", "tom.mate@stranger.test");
    expect((await w.decide(adminCookie, co.id, "remove")).status).toBe(200);
    const mails = w.mail().sent.length;
    const again = await w.decide(adminCookie, co.id, "remove");
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "no_access", message: "Twice Removed has no access to take away. Nothing changed." } });
    expect(await w.eventsOf(co.id, "company.access_removed")).toHaveLength(1);
    expect(w.mail().sent.length).toBe(mails);
    // a request: there is nothing to take away, and Decline is its door
    const asker = await w.ask("still.asking@stranger.test", "Still Asking");
    const onRequest = await w.decide(adminCookie, asker.id, "remove");
    expect(onRequest.status).toBe(409);
    expect(await onRequest.json()).toMatchObject({ error: { code: "no_access", message: "Still Asking is asking for access and has none to take away. Decline it instead." } });
    expect(await w.statusOf(asker.id)).toBe("requested");
    // a declined one
    expect((await w.decide(adminCookie, asker.id, "decline")).status).toBe(200);
    expect((await w.decide(adminCookie, asker.id, "remove")).status).toBe(409);
    expect(await w.statusOf(asker.id)).toBe("declined");
    // a company with nobody active on it
    const empty = await w.openCompany("pat.empty@listed-domain.test", "Empty Dental");
    await withPlatform(w.container.db, (tx) => tx.update(memberships).set({ status: "removed" }).where(eq(memberships.companyId, empty.id)));
    const none = await w.decide(adminCookie, empty.id, "remove");
    expect(none.status).toBe(409);
    expect(await none.json()).toMatchObject({ error: { code: "no_access", message: "Empty Dental has nobody with access to take away. Nothing changed." } });
    expect(await w.eventsOf(empty.id, "company.access_removed")).toEqual([]);
    // two administrators at once: one change, one email
    const race = await inUse("pat.race@listed-domain.test", "Race Removed", "rob.mate@stranger.test");
    const raced = await Promise.all([w.decide(adminCookie, race.id, "remove"), w.decide(adminCookie, race.id, "remove")]);
    expect(raced.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await w.eventsOf(race.id, "company.access_removed")).toHaveLength(1);
    expect(w.mailTo("pat.race@listed-domain.test").filter((m) => m.subject === "We can't offer access right now")).toHaveLength(1);
  });

  it("only a platform administrator with a second factor may take it away", async () => {
    const co = await inUse("pat.guarded@listed-domain.test", "Guarded Removal", "gus.mate@stranger.test");
    const body = { decision: "remove", confirm: true };
    expect((await w.json("", "POST", `/api/v1/admin/customers/${co.id}/access`, body)).status).toBe(401);
    expect((await w.json(co.cookie, "POST", `/api/v1/admin/customers/${co.id}/access`, body)).status).toBe(403);
    expect((await w.json(adminCookie, "POST", `/api/v1/admin/customers/${co.id}/access`, { decision: "remove" })).status).toBe(400);
    expect(await w.statusesOf(co.id)).toEqual(["active", "active"]);
  });

  it("a failed email changes none of it and raises nothing, and the answer says it did not leave", async () => {
    const co = await inUse("pat.nomail@listed-domain.test", "No Mail Removal", "nia.mate@stranger.test");
    w.mail().failNext(1);
    const r = await w.decide(adminCookie, co.id, "remove");
    expect(r.status).toBe(200);
    expect(await w.read<CustomerAccessAnswer>(r)).toMatchObject({ changed: true, status: "declined", emailed: false });
    expect(await w.statusesOf(co.id)).toEqual(["declined", "declined"]);
    expect((await w.rowOf(co.id)).settings.verifiedAt).toBeUndefined();
    expect(await w.alertsOf(co.id)).toEqual([]);
    expect(await w.container.db.select().from(adminAlerts).where(inArray(adminAlerts.kind, ["message.delivery_failed", "message.provider_refused"]))).toEqual([]);
  });

  it("someone also on another company simply loses this one: their session there stays open, and they land in it", async () => {
    const keep = await w.openCompany("pat.keep@listed-domain.test", "Keep Dental");
    const gone = await inUse("pat.gone@listed-domain.test", "Gone Dental", "both.companies@stranger.test");
    await w.addMember(keep.id, "both.companies@stranger.test", "hiring_manager");
    // the other company's owner is on this one's team too
    await w.addMember(gone.id, "pat.keep@listed-domain.test", "hiring_manager");
    // their session working in the other company
    const there = await w.google("both.companies@stranger.test");
    expect((await w.json(there, "POST", "/api/v1/auth/switch", { companyId: keep.id })).status).toBe(200);
    expect((await w.decide(adminCookie, gone.id, "remove")).status).toBe(200);
    // the session in the removed company ended; the one in the other company did not
    expect((await w.json(gone.mate, "GET", "/api/v1/auth/me")).status).toBe(401);
    const still = await w.meOf(there);
    expect(still.activeCompanyId).toBe(keep.id);
    expect(still.memberships.map((m) => m.companyId)).toEqual([keep.id]);
    // signing in again lands in the company they still have
    expect((await w.meOf(await w.google("both.companies@stranger.test"))).activeCompanyId).toBe(keep.id);
    // and the other company's own people are untouched
    expect(await w.statusesOf(keep.id)).toEqual(["active", "active"]);
    // Home there says nothing of the company taken away (the merge's check of 10 November 2026): it was not their request,
    // and Home's line would call it "your own company" in the one they are in, and look again every minute. Whatever their
    // role, the other company's owner too.
    for (const cookie of [there, await w.google("pat.keep@listed-domain.test")]) expect((await w.signupOf(cookie)).request).toBeUndefined();
    // its own owner, with no other company, still reads the declined screen
    expect(await w.signupOf(await w.google("pat.gone@listed-domain.test"))).toMatchObject({ allowed: false, request: { status: "declined", companyName: "Gone Dental" } });
  });
});
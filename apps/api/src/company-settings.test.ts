import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { CompanyView, InviteAnswer, MemberChanged, TeamView } from "@ros/contracts";
import { DEFAULT_NOTICES, hashToken, maskTokenPath, redactString, sealPayload } from "@ros/core";
import { applications, auditRecords, candidates, communications, companies, dataRequests, events, randomToken, sessions, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantJob, signInAdmin, signInAs, signInWithIdentity, usePlan } from "./test-helpers";

/**
 * Settings, Company: the six details an owner or an admin changes, answered as the company Settings reads, audited by
 * field name and emitted; "Confirm it's you" before someone is made an admin or an owner; and the public
 * privacy-request form, confirmed by an emailed single-use link.
 */
describe("company details, re-authentication and the privacy-request form", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const json = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string>, ip = "203.0.113.10") =>
    app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": ip }, body: new URLSearchParams(fields).toString() });
  const errorCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
  const cookieNamed = (r: Response, name: string) => r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? null;
  const BASE = Date.now();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const company = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/companies/current")).json()) as CompanyView;
  const detailsAudits = () => container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.updated"))).orderBy(auditRecords.createdAt);

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signInWithIdentity(app, container, { email: "dana@settings.test", name: "Dana Owner", provider: "google", aal2: false });
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Settings Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    companySlug = (await company(owner)).slug;
    ownerId = ((await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    // Room for the people these cases invite: the Free plan has two.
    await usePlan(container, companyId);
    roleId = await plantJob(container, { companyId, title: "Dental Hygienist" });
  });
  afterAll(async () => {
    await container.close();
  });

  describe("company details", () => {
    it("changes the six fields, answers the company as Settings reads it, records which fields changed and emits the change", async () => {
      const r = await json(owner, "PATCH", "/api/v1/companies/current", {
        name: "Settings Dental Group", website: "settingsdental.com", timezone: "America/Chicago", sizeBand: "50-99",
        locations: [{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }], benefitsSummary: "Health, dental, 401k match.",
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as CompanyView;
      expect(body).toMatchObject({ id: companyId, name: "Settings Dental Group", slug: companySlug, vertical: "dental", timezone: "America/Chicago", sizeBand: "50-99", website: "settingsdental.com", benefitsSummary: "Health, dental, 401k match.", logoUrl: null, about: null, aboutDraft: null, hiringContact: null, viewer: { mayEdit: true } });
      expect(body.locations.map((l) => l.city)).toEqual(["Irvine", "Tustin"]);
      expect(body.careersUrl).toContain(`/careers/${companySlug}`);
      expect(body.plan).toMatchObject({ key: "growth", upgradeRequestedAt: null });
      // named fields only: nothing of the stored settings, which also hold what an administrator sets
      expect(body).not.toHaveProperty("settings");
      expect(JSON.stringify(body)).not.toMatch(/verifiedAt|verifiedBy/);
      // the same answer as reading it
      expect(await company(owner)).toEqual(body);
      const audited = await detailsAudits();
      expect(audited).toHaveLength(1);
      expect((audited[0].details as { fields: string[] }).fields.sort()).toEqual(["benefitsSummary", "locations", "name", "sizeBand", "timezone", "website"]);
      expect(audited[0].actor.name).toBe("Dana Owner");
      // the record names the fields, never what was written in them
      expect(JSON.stringify(audited[0].details)).not.toMatch(/settingsdental|401k/);
      const emitted = await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "company.updated")));
      expect(emitted).toHaveLength(1);
      expect((emitted[0].payload as { fields: string[] }).fields).toContain("name");
      // the careers page shows the new name at once
      expect(await (await app.request(`/careers/${companySlug}`)).text()).toContain("Settings Dental Group");
      // saving the same values again changes nothing and records nothing
      const again = await json(owner, "PATCH", "/api/v1/companies/current", { name: "Settings Dental Group", timezone: "America/Chicago", website: "settingsdental.com" });
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(body);
      expect(await detailsAudits()).toHaveLength(1);
      // a text sent empty is taken off
      const cleared = (await (await json(owner, "PATCH", "/api/v1/companies/current", { website: "", benefitsSummary: "" })).json()) as CompanyView;
      expect([cleared.website, cleared.benefitsSummary]).toEqual([null, null]);
      expect(((await detailsAudits())[1].details as { fields: string[] }).fields).toEqual(["website", "benefitsSummary"]);
    });

    it("refuses the plan, the company's standing, the stored settings and anything else that is not one of the six fields, with 400", async () => {
      const [before] = await container.db.select().from(companies).where(eq(companies.id, companyId));
      const notTheirs = [
        { planKey: "ultra" }, { status: "active" }, { vertical: "beauty" }, { slug: "other" },
        // what an administrator sets, and what the gate stores
        { settings: { verifiedAt: "2026-01-01T00:00:00.000Z" } }, { settings: { trial: { startedAt: "2026-01-01T00:00:00.000Z", endsAt: "2027-01-01T00:00:00.000Z", startedBy: "its_check" } } }, { settings: { benefitsSummary: "Health." } },
        // what has its own route, where a person approves it or a file is judged
        { about: { text: "We are great." } }, { logoUrl: "https://settingsdental.com/logo.png" }, { hiringContact: { email: "jobs@settings.test" } },
        { somethingElse: true },
      ];
      for (const body of notTheirs) {
        const r = await json(owner, "PATCH", "/api/v1/companies/current", body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(await errorCode(r)).toBe("invalid_request");
      }
      // a value that is not one: a name too short, a web address that is none, no location, a time zone the server does not
      // know (the company's days are counted in it)
      for (const body of [{ name: "S" }, { website: "not a web address" }, { locations: [] }, { sizeBand: "huge" }, { timezone: "Pacific" }, { timezone: "Pacific Time" }]) {
        const r = await json(owner, "PATCH", "/api/v1/companies/current", body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(await errorCode(r)).toBe("invalid_request");
      }
      const notJson = await app.request("/api/v1/companies/current", { method: "PATCH", headers: { "content-type": "application/json", cookie: owner }, body: "name=Nope" });
      expect(notJson.status).toBe(400);
      expect(await container.db.select().from(companies).where(eq(companies.id, companyId))).toEqual([before]);
      expect(await detailsAudits()).toHaveLength(2);
    });

    it("an owner and an admin change the details; a member reads them and is told they may not change them", async () => {
      const admin = await signInAs(container, app, { companyId, role: "admin" });
      const member = await signInAs(container, app, { companyId, role: "hiring_manager" });
      expect((await company(admin)).viewer).toEqual({ mayEdit: true });
      expect((await json(admin, "PATCH", "/api/v1/companies/current", { benefitsSummary: "Health and dental." })).status).toBe(200);
      const seen = await company(member);
      expect(seen.viewer).toEqual({ mayEdit: false });
      expect(seen.benefitsSummary).toBe("Health and dental.");
      const refused = await json(member, "PATCH", "/api/v1/companies/current", { name: "Nope" });
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe("forbidden");
      expect((await company(owner)).name).toBe("Settings Dental Group");
      // someone signed out, and someone with no company, read nothing
      expect((await app.request("/api/v1/companies/current")).status).toBe(401);
      const stranger = await signInWithIdentity(app, container, { email: "sam@elsewhere.test", name: "Sam Stranger", provider: "google", aal2: false });
      const none = await json(stranger, "GET", "/api/v1/companies/current");
      expect(none.status).toBe(403);
      expect(await errorCode(none)).toBe("no_company");
    });
  });

  describe("re-authentication before someone is made an admin or an owner", () => {
    let miaId = "";
    const memberPath = () => `/api/v1/companies/current/members/${miaId}`;
    const team = async () => (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as TeamView;
    const roleOfMia = async () => (await team()).members.find((m) => m.userId === miaId)!.role;

    it("a grant is refused once the session is older than thirty minutes, and accepted again for ten minutes after confirming with the provider", async () => {
      const mia = await signInAs(container, app, { companyId, role: "hiring_manager", email: "mia@settings.test", name: "Mia Member" });
      miaId = ((await (await json(mia, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
      // a fresh session: the grant goes through, and so does taking it back
      const granted = await json(owner, "PATCH", memberPath(), { role: "admin" });
      expect(granted.status).toBe(200);
      expect((await granted.json()) as MemberChanged).toEqual({ ok: true, userId: miaId, role: "admin", status: "active" });
      expect((await json(owner, "PATCH", memberPath(), { role: "hiring_manager" })).status).toBe(200);

      setClock(31 * 60_000);
      for (const role of ["admin", "owner"]) {
        const refused = await json(owner, "PATCH", memberPath(), { role });
        expect(refused.status, role).toBe(403);
        const { error } = (await refused.json()) as { error: { code: string; details: unknown } };
        expect(error.code).toBe("reauth_required");
        expect(error.details).toEqual({ freshSessionMinutes: 30, reauthMinutes: 10 });
      }
      const sentBefore = mail().sent.length;
      const invite = await json(owner, "POST", "/api/v1/companies/current/members/invite", { email: "ada.admin@settings.test", role: "admin" });
      expect(invite.status).toBe(403);
      expect(await errorCode(invite)).toBe("reauth_required");
      await container.drain();
      expect(mail().sent.slice(sentBefore).some((m) => m.to === "ada.admin@settings.test")).toBe(false);
      expect(await roleOfMia()).toBe("hiring_manager");
      expect((await team()).invitations).toEqual([]);
      // what makes nobody an admin or an owner still goes without it: the company's details, and inviting a member
      expect((await json(owner, "PATCH", "/api/v1/companies/current", { benefitsSummary: "Health, dental, vision." })).status).toBe(200);
      const member = await json(owner, "POST", "/api/v1/companies/current/members/invite", { email: "max.member@settings.test", role: "hiring_manager" });
      expect(member.status).toBe(201);
      expect(((await member.json()) as InviteAnswer).invitation).toMatchObject({ email: "max.member@settings.test", role: "hiring_manager", roleLabel: "Member" });

      // "Confirm it's you": the same PKCE flow, marked, through the fake consent page; Settings asks to come back to itself
      const start = await json(owner, "POST", "/api/v1/auth/reauth/start", { returnTo: "/setup" });
      expect(start.status).toBe(200);
      const { url, provider } = (await start.json()) as { url: string; provider: string };
      expect(provider).toBe("google");
      const pkce = cookieNamed(start, "ros_pkce")!;
      const marker = cookieNamed(start, "ros_reauth")!;
      expect(pkce && marker).toBeTruthy();
      const authorize = new URL(url);
      expect(authorize.searchParams.get("state")).toMatch(/-reauth1$/);
      const consent = await form("/api/v1/auth/fake/authorize", { provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")!, email: "dana@settings.test", name: "Dana Owner", email_verified: "1" });
      const cb = new URL(consent.headers.get("location")!);
      const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${owner}; ${pkce}; ${marker}` } });
      expect(done.status).toBe(302);
      expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=ok`);
      // no new session was opened; the existing one is stamped
      expect(cookieNamed(done, "ros_session")).toBeNull();
      const [row] = await container.db.select().from(sessions).where(and(eq(sessions.userId, ownerId), eq(sessions.tokenHash, hashToken(owner.split("=")[1]))));
      expect(row.reauthenticatedAt).toBeTruthy();
      expect(Math.abs(Date.parse(row.reauthenticatedAt!) - container.engine.clock().getTime())).toBeLessThan(5_000);
      const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.reauthenticated"), eq(auditRecords.companyId, companyId)));
      expect(audited).toHaveLength(1);

      // now both grants go through, for ten minutes
      expect((await json(owner, "PATCH", memberPath(), { role: "admin" })).status).toBe(200);
      expect(await roleOfMia()).toBe("admin");
      expect((await json(owner, "POST", "/api/v1/companies/current/members/invite", { email: "ada.admin@settings.test", role: "admin" })).status).toBe(201);
      setClock(31 * 60_000 + 11 * 60_000);
      const late = await json(owner, "PATCH", memberPath(), { role: "owner" });
      expect(late.status).toBe(403);
      expect(await errorCode(late)).toBe("reauth_required");
      expect(await roleOfMia()).toBe("admin");
      // taking a role away never needs it
      expect((await json(owner, "PATCH", memberPath(), { role: "hiring_manager" })).status).toBe(200);
      expect(await roleOfMia()).toBe("hiring_manager");
    });

    it("confirming with a different account changes nothing, and a stale marker never hijacks a plain sign-in", async () => {
      // with no address given, the browser comes back to Settings
      const start = await json(owner, "POST", "/api/v1/auth/reauth/start", {});
      const { url } = (await start.json()) as { url: string };
      const pkce = cookieNamed(start, "ros_pkce")!;
      const marker = cookieNamed(start, "ros_reauth")!;
      const authorize = new URL(url);
      const consent = await form("/api/v1/auth/fake/authorize", { provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")!, email: "someone.else@settings.test", name: "Someone Else", email_verified: "1" });
      const cb = new URL(consent.headers.get("location")!);
      const stampOf = async () => (await container.db.select().from(sessions).where(and(eq(sessions.userId, ownerId), eq(sessions.tokenHash, hashToken(owner.split("=")[1])))))[0].reauthenticatedAt;
      const before = await stampOf();
      const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${owner}; ${pkce}; ${marker}` } });
      expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=mismatch`);
      expect(await stampOf()).toBe(before);
      expect((await json(owner, "PATCH", memberPath(), { role: "admin" })).status).toBe(403);
      // an address outside the app is never where the browser is sent back to
      const outside = await json(owner, "POST", "/api/v1/auth/reauth/start", { returnTo: "https://elsewhere.example/setup" });
      const outsideMarker = cookieNamed(outside, "ros_reauth")!;
      const outsidePkce = cookieNamed(outside, "ros_pkce")!;
      const outsideAuthorize = new URL(((await outside.json()) as { url: string }).url);
      const outsideConsent = await form("/api/v1/auth/fake/authorize", { provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: outsideAuthorize.searchParams.get("code_challenge")!, state: outsideAuthorize.searchParams.get("state")!, email: "someone.else@settings.test", name: "Someone Else", email_verified: "1" });
      const outsideCb = new URL(outsideConsent.headers.get("location")!);
      const outsideDone = await app.request(`${outsideCb.pathname}?${outsideCb.searchParams.toString()}`, { headers: { cookie: `${owner}; ${outsidePkce}; ${outsideMarker}` } });
      expect(outsideDone.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=mismatch`);
      // a plain sign-in with the abandoned marker still in the cookie jar opens a session as usual
      const plain = await app.request("/api/v1/auth/start/google");
      const plainPkce = plain.headers.get("set-cookie")!.split(";")[0];
      const plainAuthorize = new URL(plain.headers.get("location")!);
      const plainConsent = await form("/api/v1/auth/fake/authorize", { provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: plainAuthorize.searchParams.get("code_challenge")!, state: plainAuthorize.searchParams.get("state")!, email: "newcomer@settings.test", name: "New Comer", email_verified: "1" });
      const plainCb = new URL(plainConsent.headers.get("location")!);
      const opened = await app.request(`${plainCb.pathname}?${plainCb.searchParams.toString()}`, { headers: { cookie: `${plainPkce}; ${marker}` } });
      expect(opened.status).toBe(302);
      expect(cookieNamed(opened, "ros_session")).toMatch(/^ros_session=/);
      expect(opened.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup/company`);
    });
  });

  describe("the public privacy-request form (D13)", () => {
    const candidateEmail = "maria.reyes@candidate.test";
    let requestId = "";
    let verifyLink = "";
    const linkIn = (text: string) => /https?:\/\/\S+\/c\/privacy-request\/verify\/\S+/.exec(text)?.[0] ?? "";
    const pathOf = (link: string) => link.replace(container.env.APP_BASE_URL, "");
    const tokenOf = (link: string) => decodeURIComponent(link.split("/verify/")[1]);
    /** Pressing the button on the link page: the token travels in the form body, never consumed by the page itself. */
    const press = (link: string, ip = "203.0.113.10") => form("/c/privacy-request/verify", { token: tokenOf(link) }, ip);

    beforeAll(async () => {
      await withTenant(container.db, companyId, async (tx) => {
        const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Maria", lastName: "Reyes", email: candidateEmail }).returning();
        await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "received", statusToken: randomToken(16) });
      });
    });

    it("shows the form with the transparency text, and the privacy page links to it instead of asking for an email", async () => {
      const page = await app.request("/c/privacy-request");
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("Send me a copy of my information");
      expect(html).toContain("What we collect and why");
      expect(html).toContain("a person handles every request");
      expect(html).toContain(DEFAULT_NOTICES.find((n) => n.key === "privacy")!.text.slice(0, 60));
      expect(html).toContain("Send me the confirmation link");
      const privacy = await (await app.request("/privacy")).text();
      expect(privacy).toContain("href=\"/c/privacy-request\"");
      expect(privacy).toContain("use the request form");
    });

    it("emails a confirmation link and records nothing; opening the link changes nothing; pressing the button records the request, verified, once", async () => {
      const sentBefore = mail().sent.length;
      const r = await form("/c/privacy-request", { email: candidateEmail.toUpperCase(), kind: "access", details: "Please send everything you have on me." });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("Check your email");
      await container.drain();
      // nothing is recorded, audited or announced until the person confirms from the mailbox
      const mine = () => container.db.select().from(dataRequests).where(and(eq(dataRequests.companyId, companyId), eq(dataRequests.requesterEmail, candidateEmail)));
      expect(await mine()).toHaveLength(0);
      const confirm = mail().sent.slice(sentBefore).find((m) => m.to === candidateEmail && /Confirm your request/.test(m.subject))!;
      expect(confirm).toBeTruthy();
      expect(confirm.text).toContain("Settings Dental Group");
      expect(confirm.replyTo).toBe(container.env.PRIVACY_EMAIL);
      verifyLink = linkIn(confirm.text);
      expect(verifyLink).toBeTruthy();
      expect(mail().sent.slice(sentBefore).some((m) => /received your request/.test(m.subject))).toBe(false);
      // the link is not in the candidate's message thread, where the hiring team could read it
      expect(await container.db.select().from(communications).where(eq(communications.templateKey, "privacy_verify"))).toHaveLength(0);
      // and never in a log, an error report or a security event
      const path = pathOf(verifyLink);
      expect(redactString(`GET ${path} 200`)).not.toContain(tokenOf(verifyLink));
      expect(redactString(`GET ${path} 200`)).toContain("/c/privacy-request/verify/");
      expect(maskTokenPath(path)).toBe("/c/privacy-request/verify/[token]");

      // opening the link (a person, a preview, a mail scanner) shows what would be confirmed and one button
      const opened = await app.request(path);
      expect(opened.status).toBe(200);
      const page = await opened.text();
      expect(page).toContain("Yes, confirm my request");
      expect(page).toContain("Settings Dental Group");
      expect(page).toContain("a copy of the information");
      expect(page).toContain("action=\"/c/privacy-request/verify\"");
      expect(await mine()).toHaveLength(0);
      expect(mail().sent.slice(sentBefore).some((m) => /received your request/.test(m.subject))).toBe(false);

      // the button: once
      const verified = await press(verifyLink);
      expect(verified.status).toBe(200);
      const html = await verified.text();
      expect(html).toContain("your request is confirmed");
      await container.drain();
      const rows = await mine();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      requestId = row.id;
      expect(html).toContain(row.id.slice(0, 8));
      expect(page).toContain(row.id.slice(0, 8)); // the reference named on the link page is the one the row got
      expect(row).toMatchObject({ kind: "access", channel: "email_form", verificationStatus: "verified_by_link", status: "in_progress", details: "Please send everything you have on me." });
      expect(row.candidateId).toBeTruthy();
      expect(row.applicationId).toBeTruthy();
      expect(row.verifiedAt).toBeTruthy();
      expect(row.verificationNote).toContain("confirmed the address");
      const ack = mail().sent.slice(sentBefore).find((m) => m.to === candidateEmail && /received your request/.test(m.subject))!;
      expect(ack).toBeTruthy();
      expect(ack.text).toContain("confirmed this request from your email address");
      const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "data_request.created")));
      expect(audited.some((a) => (a.details as { requestId: string; channel: string; verified: boolean }).requestId === row.id && (a.details as { channel: string }).channel === "email_form" && (a.details as { verified: boolean }).verified === true)).toBe(true);
      // the company's history holds that a request exists, and its kind, not the words
      const seen = await container.db.select({ payload: events.payload }).from(events).where(and(eq(events.companyId, companyId), eq(events.type, "candidate.data_request")));
      expect(seen.some((e) => e.payload.requestId === row.id)).toBe(true);
      expect(JSON.stringify(seen)).not.toContain("everything you have on me");
    });

    it("a reused link, a forged link and an expired link all stop with a plain page and change nothing", async () => {
      const again = await press(verifyLink);
      expect(again.status).toBe(410);
      expect(await again.text()).toContain("Already confirmed");
      const openedAgain = await app.request(pathOf(verifyLink));
      expect(openedAgain.status).toBe(410);
      expect(await openedAgain.text()).toContain("Already confirmed");
      const forged = await app.request("/c/privacy-request/verify/v1.not.a.real.token");
      expect(forged.status).toBe(410);
      expect(await forged.text()).toContain("no longer valid");
      expect((await form("/c/privacy-request/verify", { token: "v1.not.a.real.token" })).status).toBe(410);
      expect((await form("/c/privacy-request/verify", {})).status).toBe(410);
      const request = { v: 2, id: "00000000-0000-7000-8000-000000000000", email: candidateEmail, kind: "access", companyId, candidateId: null, applicationId: null };
      const expired = sealPayload("privacy_request_verify", { ...request, exp: container.engine.clock().getTime() - 1 }, container.env.SESSION_SECRET);
      expect((await app.request(`/c/privacy-request/verify/${encodeURIComponent(expired)}`)).status).toBe(410);
      expect((await form("/c/privacy-request/verify", { token: expired })).status).toBe(410);
      const wrongPurpose = sealPayload("invitation", { ...request, exp: container.engine.clock().getTime() + 60_000 }, container.env.SESSION_SECRET);
      expect((await app.request(`/c/privacy-request/verify/${encodeURIComponent(wrongPurpose)}`)).status).toBe(410);
      expect((await form("/c/privacy-request/verify", { token: wrongPurpose })).status).toBe(410);
      const oldShape = sealPayload("privacy_request_verify", { v: 1, requestId, exp: container.engine.clock().getTime() + 60_000 }, container.env.SESSION_SECRET);
      expect((await form("/c/privacy-request/verify", { token: oldShape })).status).toBe(410);
      const [row] = await container.db.select().from(dataRequests).where(eq(dataRequests.id, requestId));
      expect(row.status).toBe("in_progress");
      expect(await container.db.select().from(dataRequests).where(eq(dataRequests.id, request.id))).toHaveLength(0);
      // still one acknowledgment only
      expect(mail().sent.filter((m) => m.to === candidateEmail && /received your request/.test(m.subject))).toHaveLength(1);
    });

    it("an unknown address gets the same page and only its own mailbox learns nothing was found; the honeypot records nothing; a bad address is asked again", async () => {
      const sentBefore = mail().sent.length;
      const r = await form("/c/privacy-request", { email: "nobody@candidate.test", kind: "delete" }, "203.0.113.11");
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("Check your email");
      expect(await container.db.select().from(dataRequests).where(eq(dataRequests.requesterEmail, "nobody@candidate.test"))).toHaveLength(0);
      const told = mail().sent.slice(sentBefore).find((m) => m.to === "nobody@candidate.test")!;
      expect(told.subject).toBe("About your privacy request");
      expect(told.text).toContain("We found no application under nobody@candidate.test");
      const bot = await form("/c/privacy-request", { email: "bot@candidate.test", kind: "access", website: "http://spam" }, "203.0.113.12");
      expect(bot.status).toBe(200);
      expect(mail().sent.some((m) => m.to === "bot@candidate.test")).toBe(false);
      const bad = await form("/c/privacy-request", { email: "not-an-email", kind: "access" }, "203.0.113.13");
      expect(bad.status).toBe(400);
      expect(await bad.text()).toContain("check your email address");
      const badKind = await form("/c/privacy-request", { email: candidateEmail, kind: "human_review" }, "203.0.113.13");
      expect(badKind.status).toBe(400);
    });

    it("the same person asking again within a day gets a second link that lands on the first record; the console shows the source; the form is rate-limited per mailbox", async () => {
      const sentBefore = mail().sent.length;
      const r = await form("/c/privacy-request", { email: candidateEmail, kind: "correct", details: "My phone number is wrong." }, "203.0.113.14");
      expect(r.status).toBe(200);
      const r2 = await form("/c/privacy-request", { email: candidateEmail, kind: "correct", details: "My phone number is wrong." }, "203.0.113.15");
      expect(r2.status).toBe(200);
      const links = mail().sent.slice(sentBefore).filter((m) => m.to === candidateEmail && /Confirm your request/.test(m.subject)).map((m) => linkIn(m.text));
      expect(links).toHaveLength(2);
      expect(links[0]).not.toBe(links[1]);
      const corrections = () => container.db.select().from(dataRequests).where(and(eq(dataRequests.requesterEmail, candidateEmail), eq(dataRequests.kind, "correct")));
      expect(await corrections()).toHaveLength(0);
      expect((await press(links[0], "203.0.113.14")).status).toBe(200);
      await container.drain();
      const rows = await corrections();
      expect(rows).toHaveLength(1);
      const second = await press(links[1], "203.0.113.15");
      expect(second.status).toBe(410);
      expect(await second.text()).toContain(rows[0].id.slice(0, 8));
      await container.drain();
      expect(await corrections()).toHaveLength(1);
      expect(mail().sent.slice(sentBefore).filter((m) => m.to === candidateEmail && /received your request/.test(m.subject))).toHaveLength(1);
      const replayed = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "data_request.replayed")));
      expect(replayed.some((a) => (a.details as { requestId: string; channel: string }).requestId === rows[0].id && (a.details as { channel: string }).channel === "email_form")).toBe(true);
      // the administrator's list names the source
      const admin = await signInAdmin(app, container, "admin@its.test", "admin");
      const list = (await (await json(admin, "GET", "/api/v1/admin/data-requests", undefined, { "x-admin-reason": "company settings test" })).json()) as Array<{ id: string; channel: string; verificationStatus: string }>;
      expect(list.find((x) => x.id === rows[0].id)).toMatchObject({ channel: "email_form", verificationStatus: "verified_by_link" });
      expect(list.find((x) => x.id === requestId)).toMatchObject({ channel: "email_form", verificationStatus: "verified_by_link" });
      // per-mailbox limit: five an hour, whoever posts, from wherever, however the address is typed
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push((await form("/c/privacy-request", { email: i % 2 ? " Flood@Candidate.test " : "flood@candidate.test", kind: "access" }, `203.0.113.${20 + i}`)).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses[5]).toBe(429);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { NoticeKey } from "@ros/contracts";
import { DEFAULT_NOTICES, boardPostingOf, hashToken, maskTokenPath, nextContactWindow, redactString, sealPayload, withinContactHours, zipRecruiterOffered } from "@ros/core";
import { applications, auditRecords, candidates, communications, companies, dataRequests, events, randomToken, sessions, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInAs, signInWithIdentity } from "./test-helpers";

/**
 * Package COMPANY (audit findings A8, A9, A11, A12, D13, J16): typed company preferences with audit and notice
 * versions, the customer's own audit history with filters and a CSV, a person's sessions and their revocation,
 * re-authentication before a policy or notice change, contact hours feeding the texting window, and the public
 * privacy-request form confirmed by an emailed single-use link.
 */
describe("company preferences, audit history, sessions, re-authentication and the privacy-request form", () => {
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
  const today = () => container.engine.clock().toISOString().slice(0, 10);

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
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Settings Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    ownerId = ((await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    const started = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("the notice keys the API accepts are exactly the notices the product defines", () => {
    expect([...NoticeKey.options].sort()).toEqual(DEFAULT_NOTICES.map((n) => n.key).sort());
  });

  describe("company preferences (A8, J16)", () => {
    it("accepts a typed update, records which keys changed, and emits the change", async () => {
      const r = await json(owner, "PATCH", "/api/v1/companies/current", {
        name: "Settings Dental Group", website: "settingsdental.com", timezone: "America/Chicago", sizeBand: "50-99", locations: [{ city: "Irvine", region: "CA", country: "US" }, { city: "Tustin", region: "CA", country: "US" }],
        settings: { careersPage: { intro: "A small team that answers every applicant." }, benefitsSummary: "Health, dental, 401k match.", logoUrl: "", businessHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" } },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { name: string; timezone: string; sizeBand: string; changed: string[]; settings: { website?: string; careersPage?: { intro?: string; enabled: boolean }; businessHours?: { days: number[]; start: string; end: string }; logoUrl?: string } };
      expect(body.name).toBe("Settings Dental Group");
      expect(body.timezone).toBe("America/Chicago");
      // an empty logo address where there is none changes nothing
      expect(body.changed.sort()).toEqual(["benefitsSummary", "businessHours", "careersPage", "locations", "name", "sizeBand", "timezone", "website"].sort());
      expect(body.settings.website).toBe("settingsdental.com");
      expect(body.settings.careersPage).toEqual({ enabled: true, intro: "A small team that answers every applicant." });
      expect(body.settings.businessHours).toEqual({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
      const current = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { name: string; settings: { logoUrl?: string } };
      expect(current.name).toBe("Settings Dental Group");
      expect(current.settings.logoUrl).toBeUndefined();
      // the logo is uploaded and served by us (plan D10): a typed address is refused with a plain way forward
      const typed = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { logoUrl: "https://settingsdental.com/logo.png" } });
      expect(typed.status).toBe(400);
      expect(await errorCode(typed)).toBe("logo_upload_only");
      const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.updated")));
      expect(audited).toHaveLength(1);
      expect((audited[0].details as { fields: string[] }).fields).toContain("businessHours");
      expect(audited[0].actor.name).toBe("Dana Owner");
      const emitted = await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "company.updated")));
      expect(emitted.length).toBeGreaterThanOrEqual(1);
      // the careers page shows the new introduction at once
      expect(await (await app.request(`/careers/${companySlug}`)).text()).toContain("A small team that answers every applicant.");
      // saving the same values again changes nothing and records nothing
      const again = await json(owner, "PATCH", "/api/v1/companies/current", { name: "Settings Dental Group" });
      expect(((await again.json()) as { changed: string[] }).changed).toEqual([]);
      expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.updated")))).toHaveLength(1);
    });

    it("refuses the plan, the pilot term, the allowances and anything else that is not a preference, with 400", async () => {
      for (const body of [{ planKey: "growth" }, { status: "active" }, { vertical: "beauty" }, { slug: "other" }, { settings: { pilot: { startedAt: "2026-01-01", endsAt: "2027-01-01" } } }, { settings: { retention: { documents: 1 } } }, { settings: { brief: { channel: "email", hourLocal: 7 } } }]) {
        const r = await json(owner, "PATCH", "/api/v1/companies/current", body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(await errorCode(r)).toBe("not_yours_to_change");
      }
      const unknown = await json(owner, "PATCH", "/api/v1/companies/current", { somethingElse: true });
      expect(unknown.status).toBe(400);
      expect(await errorCode(unknown)).toBe("invalid_request");
      const badHours = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { businessHours: { days: [1], start: "17:00", end: "09:00" } } });
      expect(badHours.status).toBe(400);
      const badLogo = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { logoUrl: "http://insecure.example/logo.png" } });
      expect(badLogo.status).toBe(400);
      // what the job pages say about the company has its own routes, where a person approves it (plan D10)
      for (const settings of [{ about: { text: "We are great." } }, { logo: { file: "x.png" } }, { hiringContact: { email: "jobs@settings.test" } }]) {
        const r = await json(owner, "PATCH", "/api/v1/companies/current", { settings });
        expect(r.status, JSON.stringify(settings)).toBe(400);
        expect(await errorCode(r)).toBe("use_its_own_page");
      }
      // no company.update for a hiring manager
      const hm = await signInAs(container, app, { companyId, role: "hiring_manager" });
      expect((await json(hm, "PATCH", "/api/v1/companies/current", { name: "Nope" })).status).toBe(403);
      expect((await container.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)))[0].name).toBe("Settings Dental Group");
    });

    it("saves who posts on the job boards and the company's own ZipRecruiter plan (plan D3, Q11)", async () => {
      const stored = async () => (await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)))[0].settings;
      expect(boardPostingOf(await stored())).toBe("its");
      expect(zipRecruiterOffered(await stored())).toBe(false);
      const self = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { boardPosting: "self" } });
      expect(self.status).toBe(200);
      expect(((await self.json()) as { changed: string[] }).changed).toEqual(["boardPosting"]);
      expect(boardPostingOf(await stored())).toBe("self");
      const plan = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { zipRecruiterPlan: true } });
      expect(((await plan.json()) as { changed: string[] }).changed).toEqual(["zipRecruiterPlan"]);
      expect(zipRecruiterOffered(await stored())).toBe(true);
      // the same choice again changes nothing
      const same = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { boardPosting: "self", zipRecruiterPlan: true } });
      expect(((await same.json()) as { changed: string[] }).changed).toEqual([]);
      // and back: ITS posts, no plan (the key is dropped rather than kept as false)
      const back = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { boardPosting: "its", zipRecruiterPlan: false } });
      expect(((await back.json()) as { changed: string[] }).changed.sort()).toEqual(["boardPosting", "zipRecruiterPlan"]);
      const after = await stored();
      expect(boardPostingOf(after)).toBe("its");
      expect(after).not.toHaveProperty("zipRecruiterPlan");
      const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.updated"))).orderBy(desc(auditRecords.createdAt), desc(auditRecords.id));
      expect((audited[0].details as { fields: string[] }).fields.sort()).toEqual(["boardPosting", "zipRecruiterPlan"]);
      const bad = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { boardPosting: "someone" } });
      expect(bad.status).toBe(400);
    });

    it("rewords a notice with a new version (the date) that the job page and the apply form show from then on", async () => {
      const custom = "Settings Dental uses software with artificial intelligence to organize applications and summarize them for the hiring team. People make every hiring decision. Reply HUMAN at any time to reach a person.";
      const r = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { notices: { ai_use: { text: custom } } } });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { changed: string[]; notices: Array<{ key: string; version: string; text: string; overridden: boolean; defaultText: string }> };
      expect(body.changed).toEqual(["notices"]);
      const ai = body.notices.find((n) => n.key === "ai_use")!;
      expect(ai).toMatchObject({ version: today(), text: custom, overridden: true });
      expect(ai.defaultText).not.toBe(custom);
      expect(body.notices.find((n) => n.key === "privacy")!.overridden).toBe(false);
      const noticeAudit = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "notice.changed")));
      expect(noticeAudit).toHaveLength(1);
      expect(noticeAudit[0].details).toMatchObject({ key: "ai_use", version: today(), previousVersion: null });
      // the candidate pages pick it up
      const job = await (await app.request(`/careers/${companySlug}/jobs/${roleId}`)).text();
      expect(job).toContain(custom);
      const apply = await (await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`)).text();
      expect(apply).toContain(custom);
      expect(apply).toContain(`ai_use@${today()}`);
      // the list endpoint says the same; the standard text comes back with null
      const list = (await (await json(owner, "GET", "/api/v1/companies/current/notices")).json()) as Array<{ key: string; overridden: boolean }>;
      expect(list.find((n) => n.key === "ai_use")!.overridden).toBe(true);
      const back = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { notices: { ai_use: null } } });
      expect(((await back.json()) as { notices: Array<{ key: string; overridden: boolean }> }).notices.find((n) => n.key === "ai_use")!.overridden).toBe(false);
      expect(await (await app.request(`/careers/${companySlug}/jobs/${roleId}`)).text()).not.toContain(custom);
      // a text that is too short to be a notice is refused
      expect((await json(owner, "PATCH", "/api/v1/companies/current", { settings: { notices: { privacy: { text: "short" } } } })).status).toBe(400);
    });

    it("the company's contact hours narrow the texting window and never widen the legal one", async () => {
      const [co] = await container.db.select().from(companies).where(eq(companies.id, companyId));
      expect(co.settings.businessHours).toEqual({ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" });
      // Saturday 12:00 Chicago (17:00 UTC on a Saturday): inside the legal window, outside the company's days
      const saturdayNoon = new Date("2026-10-03T17:00:00Z");
      expect(withinContactHours(saturdayNoon, co.timezone)).toBe(true);
      expect(withinContactHours(saturdayNoon, co.timezone, co.settings.businessHours)).toBe(false);
      const next = nextContactWindow(saturdayNoon, co.timezone, co.settings.businessHours);
      expect(next.toISOString()).toBe("2026-10-05T14:00:00.000Z"); // Monday 09:00 Chicago (CDT)
      // Monday 08:30 Chicago: legal, but before the company's start; the window opens at 09:00
      const mondayEarly = new Date("2026-10-05T13:30:00Z");
      expect(nextContactWindow(mondayEarly, co.timezone, co.settings.businessHours).toISOString()).toBe("2026-10-05T14:00:00.000Z");
      // hours earlier than the law allows are clipped to 08:00; hours later than 21:00 are clipped too
      expect(withinContactHours(new Date("2026-10-05T12:00:00Z"), co.timezone, { days: [1], start: "06:00", end: "23:00" })).toBe(false); // 07:00 Chicago
      expect(withinContactHours(new Date("2026-10-06T02:30:00Z"), co.timezone, { days: [1], start: "06:00", end: "23:00" })).toBe(false); // 21:30 Chicago on Monday
      expect(withinContactHours(new Date("2026-10-05T13:00:00Z"), co.timezone, { days: [1], start: "06:00", end: "23:00" })).toBe(true); // 08:00 Chicago
      // without company hours the legal window alone applies
      expect(nextContactWindow(saturdayNoon, co.timezone, undefined).toISOString()).toBe(saturdayNoon.toISOString());
    });
  });

  describe("audit history (A9)", () => {
    it("lists what the team may see in plain words, filters by action, prefix and dates, and pages", async () => {
      const all = (await (await json(owner, "GET", "/api/v1/companies/current/audit")).json()) as Array<{ id: string; action: string; description: string; actor: { name: string | null }; at: string; details: Record<string, unknown> }>;
      expect(all.length).toBeGreaterThanOrEqual(3);
      expect(all.map((r) => r.action)).toEqual(expect.arrayContaining(["company.updated", "notice.changed"]));
      const companyRows = all.filter((r) => r.action === "company.updated");
      expect(companyRows.every((r) => /^Dana Owner changed the company details \(/.test(r.description))).toBe(true);
      expect(companyRows.some((r) => r.description.includes("contact hours"))).toBe(true);
      expect(companyRows.some((r) => r.description.includes("candidate notices"))).toBe(true);
      const noticeRows = all.filter((r) => r.action === "notice.changed").map((r) => r.description);
      expect(noticeRows).toEqual(expect.arrayContaining([expect.stringContaining("reworded the AI-use notice"), expect.stringContaining("restored the standard text of the AI-use notice")]));
      // newest first
      for (let i = 1; i < all.length; i++) expect(Date.parse(all[i - 1].at)).toBeGreaterThanOrEqual(Date.parse(all[i].at));
      // filters
      const only = (await (await json(owner, "GET", "/api/v1/companies/current/audit?actions=company.updated")).json()) as Array<{ action: string }>;
      expect(only.length).toBeGreaterThanOrEqual(1);
      expect(only.every((r) => r.action === "company.updated")).toBe(true);
      const prefixed = (await (await json(owner, "GET", "/api/v1/companies/current/audit?prefix=notice.")).json()) as Array<{ action: string }>;
      expect(prefixed.length).toBe(2);
      expect(prefixed.every((r) => r.action === "notice.changed")).toBe(true);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect((await (await json(owner, "GET", `/api/v1/companies/current/audit?from=${tomorrow}`)).json()) as unknown[]).toEqual([]);
      expect(((await (await json(owner, "GET", `/api/v1/companies/current/audit?to=${tomorrow}`)).json()) as unknown[]).length).toBe(all.length);
      expect((await json(owner, "GET", "/api/v1/companies/current/audit?from=yesterday")).status).toBe(400);
      // paging: one at a time, then everything after it in this order. The newest two rows (company.updated and
      // notice.changed from the last PATCH) were written in one transaction and share their time to the microsecond,
      // so a cursor on the time alone would lose the sibling; the cursor is the row.
      const first = (await (await json(owner, "GET", "/api/v1/companies/current/audit?limit=1")).json()) as Array<{ id: string; at: string }>;
      expect(first).toHaveLength(1);
      expect(all[0].id).toBe(first[0].id);
      expect(all[1].at).toBe(all[0].at);
      const rest = (await (await json(owner, "GET", `/api/v1/companies/current/audit?before=${first[0].id}`)).json()) as Array<{ id: string }>;
      expect(rest.some((r) => r.id === first[0].id)).toBe(false);
      expect(rest.map((r) => r.id)).toEqual(all.slice(1).map((r) => r.id));
      // page by page, nothing lost and nothing twice
      const paged: string[] = [];
      for (let cursor = ""; ;) {
        const page = (await (await json(owner, "GET", `/api/v1/companies/current/audit?limit=2${cursor ? `&before=${cursor}` : ""}`)).json()) as Array<{ id: string }>;
        if (!page.length) break;
        paged.push(...page.map((r) => r.id));
        cursor = page[page.length - 1].id;
      }
      expect(paged).toEqual(all.map((r) => r.id));
      // a cursor that is not a row of this list is refused in plain words
      expect((await json(owner, "GET", `/api/v1/companies/current/audit?before=${encodeURIComponent(first[0].at)}`)).status).toBe(400);
      expect((await json(owner, "GET", "/api/v1/companies/current/audit?before=00000000-0000-4000-8000-000000000000")).status).toBe(400);
      // an action the customer may not see is never listed, even when asked for by name
      const hidden = (await (await json(owner, "GET", "/api/v1/companies/current/audit?actions=data_request.created,signin.refused")).json()) as unknown[];
      expect(hidden).toEqual([]);
      // an interviewer has no events.read
      const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
      expect((await json(interviewer, "GET", "/api/v1/companies/current/audit")).status).toBe(403);
      // the older shape the recruiter-access card relies on still works
      const access = (await (await json(owner, "GET", "/api/v1/companies/current/audit?actions=staff.access_granted,staff.access_ended,staff.access_revoked,admin.break_glass")).json()) as unknown[];
      expect(access).toEqual([]);
    });

    it("downloads the same history as a spreadsheet and records the download", async () => {
      const r = await json(owner, "GET", "/api/v1/companies/current/audit.csv");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/csv");
      expect(r.headers.get("content-disposition")).toMatch(/activity-\d{4}-\d{2}-\d{2}\.csv/);
      const csv = await r.text();
      const lines = csv.trim().split("\r\n");
      expect(lines[0]).toBe("\"when\",\"what\",\"who\",\"reason\",\"action\",\"target type\",\"target id\"");
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(csv).toContain("changed the company details");
      expect(csv).toContain("\"Dana Owner\"");
      const exported = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "audit.exported")));
      expect(exported).toHaveLength(1);
      expect((exported[0].details as { rows: number }).rows).toBe(lines.length - 1);
      // and the download itself is now part of the history
      const after = (await (await json(owner, "GET", "/api/v1/companies/current/audit?actions=audit.exported")).json()) as Array<{ description: string }>;
      expect(after[0].description).toMatch(/downloaded this history \(\d+ rows\)/);
    });
  });

  describe("sessions (A11)", () => {
    it("lists a person's own sessions with the current one marked, revokes one by id, and signs out everywhere else", async () => {
      const second = await signInWithIdentity(app, container, { email: "dana@settings.test", name: "Dana Owner", provider: "google", aal2: false });
      const third = await signInWithIdentity(app, container, { email: "dana@settings.test", name: "Dana Owner", provider: "google", aal2: false });
      const list = (await (await json(owner, "GET", "/api/v1/auth/sessions")).json()) as Array<{ id: string; current: boolean; addressHash: string | null; provider: string; createdAt: string; lastSeenAt: string | null }>;
      expect(list).toHaveLength(3);
      expect(list.filter((s) => s.current)).toHaveLength(1);
      expect(list[0].current).toBe(true);
      expect(list.every((s) => s.provider === "google" && s.createdAt)).toBe(true);
      expect(JSON.stringify(list)).not.toMatch(/tokenHash|token_hash/);
      // the same person from another session sees a different one as current
      const fromSecond = (await (await json(second, "GET", "/api/v1/auth/sessions")).json()) as Array<{ id: string; current: boolean }>;
      expect(fromSecond.find((s) => s.current)!.id).not.toBe(list.find((s) => s.current)!.id);
      const other = list.find((s) => !s.current)!;
      // revoke one by id: it stops working; a stranger's session id is not found
      expect((await json(owner, "POST", `/api/v1/auth/sessions/${other.id}/revoke`)).status).toBe(200);
      expect((await json(owner, "POST", `/api/v1/auth/sessions/${other.id}/revoke`)).status).toBe(404);
      expect((await json(owner, "POST", "/api/v1/auth/sessions/not-a-uuid/revoke")).status).toBe(404);
      const remaining = (await (await json(owner, "GET", "/api/v1/auth/sessions")).json()) as Array<{ id: string }>;
      expect(remaining).toHaveLength(2);
      const revokedCookie = other.id === fromSecond.find((s) => s.current)!.id ? second : third;
      expect((await json(revokedCookie, "GET", "/api/v1/auth/me")).status).toBe(401);
      // sign out everywhere else keeps this one
      const all = (await (await json(owner, "POST", "/api/v1/auth/sessions/revoke-all")).json()) as { sessionsEnded: number };
      expect(all.sessionsEnded).toBe(1);
      expect((await json(owner, "GET", "/api/v1/auth/me")).status).toBe(200);
      expect((await (await json(owner, "GET", "/api/v1/auth/sessions")).json()) as unknown[]).toHaveLength(1);
      const stranger = await signInAs(container, app, { companyId, role: "hr" });
      expect((await json(stranger, "POST", `/api/v1/auth/sessions/${list.find((s) => s.current)!.id}/revoke`)).status).toBe(404);
      const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.revoked"), eq(auditRecords.companyId, companyId)));
      expect(audited.length).toBeGreaterThanOrEqual(2);
      // no other session left to end
      expect(((await (await json(owner, "POST", "/api/v1/auth/sessions/revoke-all")).json()) as { sessionsEnded: number }).sessionsEnded).toBe(0);
    });

    it("an owner or admin signs a member out everywhere; not themselves, not a non-member, and never an interviewer", async () => {
      const hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@settings.test" });
      const hmId = ((await (await json(hm, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
      expect((await json(hm, "GET", "/api/v1/auth/me")).status).toBe(200);
      const r = await json(owner, "POST", `/api/v1/companies/current/members/${hmId}/sign-out`);
      expect(r.status).toBe(200);
      expect((await r.json()) as { sessionsEnded: number }).toMatchObject({ ok: true, userId: hmId, sessionsEnded: 1 });
      expect((await json(hm, "GET", "/api/v1/auth/me")).status).toBe(401);
      const self = await json(owner, "POST", `/api/v1/companies/current/members/${ownerId}/sign-out`);
      expect(self.status).toBe(400);
      expect(await errorCode(self)).toBe("self_sign_out");
      expect((await json(owner, "POST", "/api/v1/companies/current/members/00000000-0000-4000-8000-000000000000/sign-out")).status).toBe(404);
      expect((await json(owner, "POST", "/api/v1/companies/current/members/nope/sign-out")).status).toBe(404);
      const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
      expect((await json(interviewer, "POST", `/api/v1/companies/current/members/${hmId}/sign-out`)).status).toBe(403);
      const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.action, "session.revoked"), eq(auditRecords.companyId, companyId))).orderBy(desc(auditRecords.createdAt));
      expect(audited[0].details).toMatchObject({ sessionsEnded: 1, scope: "all" });
      expect(audited[0].target).toEqual({ type: "user", id: hmId });
    });
  });

  describe("re-authentication before sensitive changes (A12)", () => {
    it("a rule change is refused once the session is older than thirty minutes, and accepted again after confirming with the provider", async () => {
      // fresh session: the rule change goes through
      expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: [] })).status).toBe(200);
      setClock(31 * 60_000);
      const refused = await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] });
      expect(refused.status).toBe(403);
      expect(await errorCode(refused)).toBe("reauth_required");
      const notice = await json(owner, "PATCH", "/api/v1/companies/current", { settings: { notices: { privacy: { text: "We keep what you give us only as long as the law requires, and a person handles every request about it." } } } });
      expect(notice.status).toBe(403);
      expect(await errorCode(notice)).toBe("reauth_required");
      // an ordinary preference still saves without it
      expect((await json(owner, "PATCH", "/api/v1/companies/current", { settings: { benefitsSummary: "Health, dental, vision." } })).status).toBe(200);

      // "Confirm it's you": the same PKCE flow, marked, through the fake consent page
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
      // now the change goes through, for ten minutes
      expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "auto_notify", approverRoles: [] })).status).toBe(200);
      expect((await json(owner, "PATCH", "/api/v1/companies/current", { settings: { notices: { privacy: { text: "We keep what you give us only as long as the law requires, and a person handles every request about it." } } } })).status).toBe(200);
      setClock(31 * 60_000 + 11 * 60_000);
      expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: [] })).status).toBe(403);
      // the sessions list shows when it was confirmed
      const list = (await (await json(owner, "GET", "/api/v1/auth/sessions")).json()) as Array<{ current: boolean; reauthenticatedAt: string | null }>;
      expect(list.find((s) => s.current)!.reauthenticatedAt).toBeTruthy();
    });

    it("confirming with a different account changes nothing, and a stale marker never hijacks a plain sign-in", async () => {
      const start = await json(owner, "POST", "/api/v1/auth/reauth/start", {});
      const { url } = (await start.json()) as { url: string };
      const pkce = cookieNamed(start, "ros_pkce")!;
      const marker = cookieNamed(start, "ros_reauth")!;
      const authorize = new URL(url);
      const consent = await form("/api/v1/auth/fake/authorize", { provider: "google", redirect_to: `${container.env.APP_BASE_URL}/api/v1/auth/callback`, code_challenge: authorize.searchParams.get("code_challenge")!, state: authorize.searchParams.get("state")!, email: "someone.else@settings.test", name: "Someone Else", email_verified: "1" });
      const cb = new URL(consent.headers.get("location")!);
      const before = (await container.db.select().from(sessions).where(eq(sessions.userId, ownerId)))[0].reauthenticatedAt;
      const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${owner}; ${pkce}; ${marker}` } });
      expect(done.headers.get("location")).toBe(`${container.env.APP_BASE_URL}/setup?reauth=mismatch`);
      expect((await container.db.select().from(sessions).where(eq(sessions.userId, ownerId)))[0].reauthenticatedAt).toBe(before);
      expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "application.invite_screen", level: "approval", approverRoles: [] })).status).toBe(403);
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
        const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Maria", lastName: "Reyes", email: candidateEmail, firstSource: "direct" }).returning();
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
      // the customer sees that a request exists, and its kind, not the words
      const seen = (await (await json(owner, "GET", "/api/v1/events?type=candidate.data_request")).json()) as Array<{ payload: Record<string, unknown> }>;
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

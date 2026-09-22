import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { applications, auditRecords, events, interviews, users, withTenant } from "@ros/db";
import { PRODUCT_EVENT_NAMES, toProductEvent, type FakeAnalyticsAdapter, type FakeGoogleCalendarProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Item 8 of the founder's instruction of 18 September 2026: the tests that must never be deferred. Tenant isolation,
 * candidate-link authorization, audit completeness for privileged reads, analytics payload privacy, and scheduling retries
 * under calendar failure. (Staff grants, MFA and break-glass, human-only decisions, no automatic rejection, calendar
 * disconnection, secret revocation, email suppression, privacy requests, accessibility and browser journeys have their own suites.)
 */
describe("release-1 security coverage", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "coverage" }, body: body ? JSON.stringify(body) : undefined });

  let ownerA = "";
  let ownerB = "";
  let companyA = "";
  let companyB = "";
  let slugA = "";
  let roleA = "";
  let statusTokenA = "";
  let applicationA = "";
  let ownerAId = "";

  const setup = async (cookie: string, name: string, city: string) => {
    const co = (await (await json(cookie, "POST", "/api/v1/companies", { name, vertical: "dental", sizeBand: "20-49", locations: [{ city, region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    await entitlements.applyPlan(container.db, co.id, "growth");
    const s = (await (await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: `I need a registered dental hygienist in ${city}, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.` })).json()) as { session: { id: string } };
    const { roleId } = (await (await json(cookie, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
    await json(cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    return { ...co, roleId };
  };
  const apply = async (slug: string, roleId: string, first: string, email: string) => {
    const role = (await (await json(ownerA, "GET", `/api/v1/roles/${roleId}`)).json().catch(() => null)) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } } | null;
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", "Tester"); fd.set("email", email); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File([`${first} Tester, RDH\nRegistered Dental Hygienist 2019 - present`], "r.txt", { type: "text/plain" }));
    for (const rule of role?.currentPacket.packet.requirements.eligibility ?? []) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(r.status).toBe(302);
    await container.drain();
    return r.headers.get("location")!.split("/c/status/")[1].split("?")[0];
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    ownerA = await signIn("owner-a@brightline.test");
    ownerB = await signIn("owner-b@other.test");
    ownerAId = (await (await json(ownerA, "GET", "/api/v1/auth/me")).json() as { user: { id: string } }).user.id;
    const a = await setup(ownerA, "Brightline Dental", "Irvine");
    const b = await setup(ownerB, "Other Dental", "Tustin");
    companyA = a.id; slugA = a.slug; roleA = a.roleId; companyB = b.id;
    statusTokenA = await apply(slugA, roleA, "Maria", "maria.tester@example.com");
    const [appRow] = await container.db.select().from(applications).where(eq(applications.roleId, roleA));
    applicationA = appRow.id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("tenant isolation: another company's owner cannot read, act on, or schedule anything in company A", async () => {
    expect((await json(ownerB, "GET", `/api/v1/roles/${roleA}`)).status).toBe(404);
    expect((await json(ownerB, "GET", `/api/v1/applications/${applicationA}`)).status).toBe(404);
    expect((await json(ownerB, "POST", `/api/v1/applications/${applicationA}/actions`, { action: "hold" })).status).toBe(404);
    expect((await json(ownerB, "POST", `/api/v1/applications/${applicationA}/interviews`, { roundKey: "x", interviewerUserIds: [ownerAId] })).status).toBe(404);
    const rowsSeenByB = await withTenant(container.db, companyB, (tx) => tx.select({ id: applications.id }).from(applications));
    expect(rowsSeenByB.some((r) => r.id === applicationA)).toBe(false);
    expect((await json(ownerB, "GET", "/api/v1/interviews")).status).toBe(200);
    expect(((await (await json(ownerB, "GET", "/api/v1/interviews")).json()) as unknown[]).length).toBe(0);
  });

  it("candidate-link authorization: a token opens only its own application; a guessed or foreign token is refused; the schedule token is separate", async () => {
    expect((await app.request(`/c/status/${statusTokenA}`)).status).toBe(200);
    expect((await app.request(`/c/status/${statusTokenA.slice(0, -2)}xx`)).status).toBe(404);
    expect((await app.request(`/c/status/not-a-real-token`)).status).toBe(404);
    expect((await app.request(`/c/schedule/${statusTokenA}`)).status).toBe(404); // a status token never opens scheduling
    expect((await app.request(`/c/screen/${statusTokenA}`)).status).toBe(404); // nor a screening conversation
    const withdraw = await app.request(`/c/status/${statusTokenA.slice(0, -2)}xx/withdraw`, { method: "POST" });
    expect(withdraw.status).toBe(404);
    const privacy = await app.request(`/c/status/${statusTokenA.slice(0, -2)}xx/privacy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "kind=access" });
    expect(privacy.status).toBe(404);
    // the status page reveals nothing about other applicants
    const html = await (await app.request(`/c/status/${statusTokenA}`)).text();
    expect(html).not.toMatch(/Other Dental|owner-b/);
  });

  it("audit completeness: every privileged read and human decision leaves an audit record with actor, target and reason", async () => {
    await json(ownerA, "GET", `/api/v1/applications/${applicationA}`);
    await json(ownerA, "POST", `/api/v1/applications/${applicationA}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Coverage test." });
    const records = await container.db.select().from(auditRecords).where(eq(auditRecords.companyId, companyA));
    const viewed = records.find((r) => r.action === "candidate.viewed" && r.target?.id === applicationA);
    expect(viewed).toBeTruthy();
    expect(viewed!.actor.kind).toBe("user");
    expect(viewed!.actor.id).toBe(ownerAId);
    for (const r of records) {
      expect(r.actor?.kind).toBeTruthy();
      expect(r.action).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(JSON.stringify(r)).not.toMatch(/ya29\.|1\/\/0|Bearer /);
    }
    const decision = await container.db.select().from(events).where(and(eq(events.companyId, companyA), eq(events.type, "human.override")));
    expect(decision.some((e) => (e.payload as { action: string }).action === "reject")).toBe(true);
    expect(decision.every((e) => e.actor.kind === "user")).toBe(true);
  });

  it("analytics payload privacy: only allow-listed events leave, with keyed references and no names, emails, phones or free text", async () => {
    const analytics = container.integrations.analytics as FakeAnalyticsAdapter;
    const all = JSON.stringify(analytics.captured);
    expect(analytics.captured.length).toBeGreaterThan(0);
    for (const ev of analytics.captured) {
      expect(PRODUCT_EVENT_NAMES).toContain(ev.name);
      expect(ev.subjectRef).toMatch(/^[a-f0-9]{16,}$|^[A-Za-z0-9_-]{12,}$/);
      expect(ev.companyRef).not.toBe(companyA);
      for (const v of Object.values(ev.properties)) expect(typeof v === "string" ? v.length : 0).toBeLessThan(40);
    }
    expect(all).not.toMatch(/maria|tester|example\.com|Brightline|@|\+1|\(949\)/i);
    expect(toProductEvent({ type: "application.rejected", companyId: companyA, subjectId: applicationA, payload: { reason: "not_a_match_experience", note: "Coverage test." } }, "salt")).toBeNull();
    const started = toProductEvent({ type: "screen.completed", companyId: companyA, subjectId: applicationA, payload: { channel: "sms", transcript: "secret words" } }, "salt");
    expect(started).not.toBeNull();
    expect(JSON.stringify(started)).not.toContain("secret words");
  });

  it("scheduling retries: a transient calendar error retries the step; a revoked credential falls back instead of failing the interview", async () => {
    await json(ownerA, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3 });
    const start = await app.request("/api/v1/integrations/calendar/google/connect", { headers: { cookie: ownerA } });
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    const authorize = new URL(start.headers.get("location")!);
    const consent = await app.request("/api/v1/integrations/calendar/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ redirect_to: `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/google/callback`, state: authorize.searchParams.get("state")!, code_challenge: authorize.searchParams.get("code_challenge")!, email: "owner-a@brightline.test", timezone: "America/Los_Angeles" }).toString() });
    const cb = new URL(consent.headers.get("location")!);
    await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${ownerA}; ${pkce}` } });
    const gcal = container.integrations.calendars.google as FakeGoogleCalendarProvider;
    const statusToken = await apply(slugA, roleA, "Luis", "luis.tester@example.com");
    expect(statusToken).toBeTruthy();
    const [luis] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleA), inArray(applications.stage, ["triaged", "screen_invited", "eligible", "screen_complete", "interview_recommended"])));
    const role = (await (await json(ownerA, "GET", `/api/v1/roles/${roleA}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
    gcal.failNext("transient", 2); // the first two free/busy calls fail; the engine retries the step
    const r = await json(ownerA, "POST", `/api/v1/applications/${luis.id}/interviews`, { roundKey: role.currentPacket.packet.interviews.plan[0].key, interviewerUserIds: [ownerAId] });
    expect(r.status).toBe(201);
    const iv = (await r.json()) as { id: string };
    await container.drain();
    // retries are scheduled with backoff on the engine clock: move it forward and drain again
    const clock = container.engine as unknown as { now: () => Date };
    const base = Date.now();
    for (let i = 1; i <= 3; i++) { clock.now = () => new Date(base + i * 5 * 60_000); await container.drain(); }
    let row = (await container.db.select().from(interviews).where(eq(interviews.id, iv.id)))[0];
    expect(row.status).toBe("scheduling");
    expect(row.offeredSlots.length).toBeGreaterThan(0);
    expect(row.offeredSlots[0].source).toBe("calendar");
    const retried = await container.db.select().from(events).where(and(eq(events.companyId, companyA), eq(events.type, "workflow.retried")));
    expect(retried.length).toBeGreaterThanOrEqual(1);
    // now the credential is revoked at the provider: booking still succeeds on declared hours and the person is told
    gcal.revokeAccount("owner-a@brightline.test");
    await json(ownerA, "POST", `/api/v1/interviews/${iv.id}/reschedule`, {});
    await container.drain();
    row = (await container.db.select().from(interviews).where(eq(interviews.id, iv.id)))[0];
    expect(row.status).toBe("scheduling");
    expect(row.offeredSlots[0].source).toBe("declared");
    clock.now = () => new Date();
  });
});

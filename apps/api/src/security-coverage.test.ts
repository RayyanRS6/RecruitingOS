import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { applications, auditRecords, events, withTenant } from "@ros/db";
import { PRODUCT_EVENT_NAMES, toProductEvent, type FakeAnalyticsAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { plantJob, statusTokenFor, testContainerOptions } from "./test-helpers";

/**
 * Item 8 of the founder's instruction of 18 September 2026: the tests that must never be deferred. Tenant isolation,
 * candidate-link authorization, audit completeness for privileged reads and analytics payload privacy. (MFA, human-only
 * decisions, no automatic rejection, email suppression, privacy requests, accessibility and browser journeys have their
 * own suites.)
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
    const co = (await (await json(cookie, "POST", "/api/v1/companies", { name, vertical: "dental", sizeBand: "20-49", locations: [{ city, region: "CA", country: "US" }] })).json()) as { id: string };
    await entitlements.applyPlan(container.db, co.id, "growth");
    const { slug } = (await (await json(cookie, "GET", "/api/v1/companies/current")).json()) as { slug: string };
    return { id: co.id, slug, roleId: await plantJob(container, { companyId: co.id, title: "Registered Dental Hygienist" }) };
  };
  const apply = async (slug: string, roleId: string, first: string, email: string) => {
    const fd = new FormData();
    fd.set("firstName", first); fd.set("lastName", "Tester"); fd.set("email", email);
    fd.set("resume", new File([`${first} Tester, RDH\nRegistered Dental Hygienist 2019 - present`], "r.txt", { type: "text/plain" }));
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    expect(r.status).toBe(302);
    // the response is the receipt; it never carries the status link (Wave 0 item 0.1)
    const to = r.headers.get("location") ?? "";
    expect(to).toBe(`/careers/${slug}/jobs/${roleId}/applied`);
    await container.drain();
    const token = await statusTokenFor(container, { roleId, email });
    expect(to).not.toContain(token);
    return token;
  };

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" }));
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

  it("tenant isolation: another company's owner cannot read or act on anything in company A", async () => {
    expect((await json(ownerB, "GET", `/api/v1/roles/${roleA}`)).status).toBe(404);
    expect((await json(ownerB, "GET", `/api/v1/applications/${applicationA}`)).status).toBe(404);
    expect((await json(ownerB, "POST", `/api/v1/applications/${applicationA}/actions`, { action: "reject" })).status).toBe(404);
    const rowsSeenByB = await withTenant(container.db, companyB, (tx) => tx.select({ id: applications.id }).from(applications));
    expect(rowsSeenByB.some((r) => r.id === applicationA)).toBe(false);
  });

  it("candidate-link authorization: a token opens only its own application; a guessed or foreign token is refused", async () => {
    expect((await app.request(`/c/status/${statusTokenA}`)).status).toBe(200);
    expect((await app.request(`/c/status/${statusTokenA.slice(0, -2)}xx`)).status).toBe(404);
    expect((await app.request(`/c/status/not-a-real-token`)).status).toBe(404);
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
    await json(ownerA, "POST", `/api/v1/applications/${applicationA}/actions`, { action: "reject" });
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
});

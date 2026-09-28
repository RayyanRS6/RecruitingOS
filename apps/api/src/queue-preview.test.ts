import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ESCALATION_PREVIEW_FIELDS, ESCALATION_PREVIEW_FORBIDDEN_KEYS, defaultUrgency, entitlements, genericSummary } from "@ros/core";
import { applications, auditRecords, staffAccessGrants } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInStaff } from "./test-helpers";

/**
 * Correction 11 (18 September 2026): before an ITS recruiter accepts an assignment, no response and no notification may
 * carry candidate identity, the customer's words, contact details, resume text, transcripts, compensation, or evaluations.
 * This test builds a request that mentions all of those, then proves every pre-acceptance surface is clean.
 */
const SENSITIVE_STRINGS = ["Maria", "Reyes", "maria.reyes", "555-0100", "$60", "working interview", "Dentrix", "Coastal Family"];

function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) allKeys(v, out);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.add(k); allKeys(v, out); }
  return out;
}
function expectClean(body: unknown) {
  const text = JSON.stringify(body);
  for (const s of SENSITIVE_STRINGS) expect(text, `response must not contain ${s}`).not.toContain(s);
  const keys = allKeys(body);
  for (const k of ESCALATION_PREVIEW_FORBIDDEN_KEYS) expect(keys.has(k), `response must not carry key ${k}`).toBe(false);
}
function expectPreviewShape(row: Record<string, unknown>, extra: string[] = []) {
  const allowed = new Set<string>([...ESCALATION_PREVIEW_FIELDS, ...extra]);
  for (const k of Object.keys(row)) expect(allowed.has(k), `unexpected pre-acceptance field ${k}`).toBe(true);
}

describe("recruiter queue preview carries no candidate-sensitive data before acceptance", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });

  let owner = "";
  let recruiter = "";
  let admin = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let applicationId = "";
  let escalationId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@smilebright.test");
    recruiter = await signInStaff(app, container, "sam@its.test", "its_recruiter", "sam");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Smile Bright Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = (await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const form = new FormData();
    form.set("firstName", "Maria");
    form.set("lastName", "Reyes");
    form.set("email", "maria.reyes@example.com");
    form.set("phone", "(949) 555-0100");
    form.set("locationText", "Tustin, CA");
    form.set("resume", new File(["Maria Reyes, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nSkills: Dentrix, periodontal charting"], "maria-reyes.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    form.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    applicationId = a.id;
    const created = await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId, applicationId, urgency: "high", question: "Is Maria Reyes (maria.reyes@example.com, 949-555-0100) worth a working interview? She wants $60 an hour and knows Dentrix." });
    expect(created.status).toBe(201);
    escalationId = ((await created.json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("the queue list shows only the allowed preview fields, and audits the view for the customer", async () => {
    const r = await json(recruiter, "GET", "/api/v1/escalations");
    expect(r.status).toBe(200);
    const list = (await r.json()) as Array<Record<string, unknown>>;
    const row = list.find((e) => e.id === escalationId)!;
    expect(row).toBeTruthy();
    expectPreviewShape(row);
    expectClean(list);
    expect(row.companyName).toBe("Smile Bright Dental");
    expect(row.roleTitle).toMatch(/hygienist/i);
    expect(row.kind).toBe("review");
    expect(row.urgency).toBe("high");
    expect(row.requiredExpertise).toBe("candidate evaluation; dental hiring");
    expect(row.summary).toBe(genericSummary("review", { hasRole: true, hasApplication: true }));
    expect(typeof row.businessMinutesRemaining).toBe("number");
    expect(typeof row.slaRemainingMinutes).toBe("number");
    expect(row.claimedByMe).toBe(false);
    const views = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "escalation.preview_viewed")));
    expect(views.length).toBeGreaterThanOrEqual(1);
    expect((views[0].details as { escalationIds: string[] }).escalationIds).toContain(escalationId);
  });

  it("the detail page before acceptance is the same preview plus the reason access is closed", async () => {
    const r = await json(recruiter, "GET", `/api/v1/escalations/${escalationId}`);
    const detail = (await r.json()) as Record<string, unknown>;
    expectPreviewShape(detail, ["accessGranted", "why"]);
    expectClean(detail);
    expect(detail.accessGranted).toBe(false);
    expect(detail.why).toBe("claim it to open the full context");
  });

  it("the admin console's escalation view is operational only", async () => {
    const r = await json(admin, "GET", "/api/v1/admin/escalations", undefined, { "x-admin-reason": "test" });
    expect(r.status).toBe(200);
    const rows = (await r.json()) as Array<Record<string, unknown>>;
    const row = rows.find((e) => e.id === escalationId)!;
    expect(row).toBeTruthy();
    expectClean(rows);
    expect(row.summary).toBe(genericSummary("review", { hasRole: true, hasApplication: true }));
    expect(row.assignedTo).toBeNull();
  });

  it("the notification to the ITS queue carries the category, urgency, expertise and generic summary only", () => {
    const outbox = (container.integrations.email as FakeEmailAdapter).sent;
    const mail = outbox.find((m) => m.to === container.env.ITS_QUEUE_EMAIL && /\[review\]/.test(m.subject));
    expect(mail).toBeTruthy();
    for (const s of SENSITIVE_STRINGS) {
      expect(mail!.subject).not.toContain(s);
      expect(mail!.text).not.toContain(s);
    }
    expect(mail!.text).toContain("Urgency: high");
    expect(mail!.text).toContain("Summary: The customer wants a recruiter to review one candidate for this role.");
  });

  it("the customer keeps their own words; acceptance opens them and the context under a grant whose purpose is generic", async () => {
    const mine = (await (await json(owner, "GET", "/api/v1/escalations/mine")).json()) as Array<{ id: string; question: string; summary: string; urgency: string }>;
    const own = mine.find((e) => e.id === escalationId)!;
    expect(own.question).toContain("Maria Reyes");
    expect(own.urgency).toBe("high");
    expect((await json(recruiter, "POST", `/api/v1/escalations/${escalationId}/claim`)).status).toBe(200);
    const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${escalationId}`)).json()) as { accessGranted: boolean; question: string; contextSnapshot: { candidate: { name: string } }; grant: { purpose: string } };
    expect(detail.accessGranted).toBe(true);
    expect(detail.question).toContain("Maria Reyes");
    expect(detail.contextSnapshot.candidate.name).toBe("Maria Reyes");
    expect(detail.grant.purpose).not.toContain("Maria");
    const [grant] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, escalationId));
    expect(grant.purpose).toBe("review: The customer wants a recruiter to review one candidate for this role.");
  });

  it("urgency defaults follow the category and the summary is always template text", () => {
    expect(defaultUrgency("candidate_issue")).toBe("high");
    expect(defaultUrgency("platform_blocking")).toBe("critical");
    expect(defaultUrgency("review")).toBe("normal");
    expect(genericSummary("candidate_issue", { hasRole: true, origin: "system" })).toMatch(/screening assistant could not continue/);
    expect(genericSummary("candidate_issue", { hasRole: true, origin: "candidate" })).toMatch(/asked for a person/);
    expect(genericSummary("stuck_role")).toMatch(/stalled/);
  });
});

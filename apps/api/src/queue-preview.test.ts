import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ESCALATION_PREVIEW_FIELDS, ESCALATION_PREVIEW_FORBIDDEN_KEYS, anonymizeCandidate, createEscalation, defaultUrgency, entitlements, genericSummary, notify, stoppedRunQuestion } from "@ros/core";
import { applications, auditRecords, candidates, notifications, randomToken, recruiterEscalations, staffAccessGrants, withPlatform, withTenant } from "@ros/db";
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
    form.set("acknowledged", "yes");
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

  it("deleting the candidate's data reaches the recruiter's copy, the requests that name them and the team's notices", async () => {
    // a second request about the role names her too, and so does a notice to the team
    const roleWide = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "ask", roleId, question: "Should we interview Maria Reyes or wait? Her number is (949) 555-0100." })).json()) as { id: string };
    await withTenant(container.db, companyId, (tx) => notify(tx, { companyId, kind: "test.named", title: "Maria Reyes finished her screen", body: "Maria Reyes (maria.reyes@example.com) answered every question." }));
    const [app] = await container.db.select().from(applications).where(eq(applications.id, applicationId));
    await withPlatform(container.db, (tx) => anonymizeCandidate(tx, { companyId, candidateId: app.candidateId, actor: { kind: "user", id: "admin-test", name: "ITS admin" }, deleteFile: async () => {} }));
    // what identifies her (the role's own packet, pay and interview plan included, stays: it is not about her)
    const expectNoTrace = (body: unknown) => { const text = JSON.stringify(body); for (const s of ["Maria", "Reyes", "maria.reyes", "555-0100", "Coastal Family"]) expect(text, `must not contain ${s}`).not.toContain(s); };
    // the recruiter's copy keeps the company and the role, nothing about her
    const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${escalationId}`)).json()) as { accessGranted: boolean; question: string; contextSnapshot: Record<string, unknown> };
    expect(detail.accessGranted).toBe(true);
    expectNoTrace({ question: detail.question, contextSnapshot: detail.contextSnapshot });
    expect(detail.question).toBe("[removed at the candidate's request]");
    expect(detail.contextSnapshot).not.toHaveProperty("candidate");
    expect(detail.contextSnapshot).not.toHaveProperty("resumeText");
    expect((detail.contextSnapshot.role as { title?: string } | null)?.title).toMatch(/hygienist/i);
    // the other request keeps its words with her name and number taken out
    const [other] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, roleWide.id));
    expect(other.question).toBe("Should we interview a candidate or wait? Her number is [removed].");
    // and the notices the team got no longer name her
    const named = await container.db.select().from(notifications).where(eq(notifications.kind, "test.named"));
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expectNoTrace({ title: n.title, body: n.body });
    expect(named[0].title).toBe("A candidate finished her screen");
    // the customer's own list is clean as well
    expectNoTrace(await (await json(owner, "GET", "/api/v1/escalations/mine")).json());
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

/**
 * 15 October 2026, seen on staging: two requests read "The customer wants a recruiter to review one candidate for this
 * role" when Recruiting OS had raised them on its own (processing an application stopped), and requests from before 13
 * October showed the technical error to the customer. The queue now says who raised a request, in template text chosen
 * on the server from who raised it (still exactly the preview fields, founder decision I11), and the old error reads in
 * plain words wherever the request is shown. The candidate's name still opens only after Accept.
 */
describe("a request Recruiting OS raised says so, and an old stopped run's request reads in plain words", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let recruiter = "";
  let admin = "";
  let companyId = "";
  let roleId = "";
  let applicationId = "";
  let freshId = "";
  let legacyId = "";
  const LEGACY = 'Workflow application_intake failed at step "extract" after 4 attempts: provider error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: Input should be a valid list"}}. Please take over.';
  const PLAIN = "Processing this application stopped after 4 tries and needs a person to take over.";
  const RAISED = "Raised automatically by Recruiting OS: one candidate's application needs a recruiter to take over.";
  // What must never reach anyone before Accept, nor the customer: the candidate, and the technical error.
  const HIDDEN = ["Lena", "Ortiz", "lena.ortiz", "failed at step", "provider error", "invalid_request_error", "Please take over"];
  const json = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const expectExactPreview = (row: Record<string, unknown>, extra: string[] = []) => {
    expect(Object.keys(row).sort()).toEqual([...ESCALATION_PREVIEW_FIELDS, ...extra].sort());
    expectClean(row);
    const text = JSON.stringify(row);
    for (const s of HIDDEN) expect(text, `must not contain ${s}`).not.toContain(s);
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@salman.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    recruiter = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
    admin = await signInAdmin(app, container, "ops@its.test", "ops");
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Salman Family Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, $22 to $26 an hour, full time. It's a replacement. Ceiling $28. I decide. Must-haves: x-ray certificate. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    applicationId = await withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Lena", lastName: "Ortiz", email: "lena.ortiz@example.com", firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning();
      return a.id;
    });
    // As engine.ts failForGood raises it for application_intake today: a review about one candidate, by the system.
    const system = { kind: "system" as const, id: "workflow:application_intake" };
    freshId = (await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, roleId, applicationId, kind: "review", question: stoppedRunQuestion("application_intake", 4), requestedBy: system }))).id;
    // As one stored before 13 October 2026: the technical error as the request, and the customer's template as its summary.
    legacyId = (await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, roleId, applicationId, kind: "review", question: LEGACY, requestedBy: system }))).id;
    await container.db.update(recruiterEscalations).set({ summary: genericSummary("review", { hasRole: true, hasApplication: true }) }).where(eq(recruiterEscalations.id, legacyId));
  });
  afterAll(async () => {
    await container.close();
  });

  it("stores the new wording, and leaves the old row's words as they were", async () => {
    const [fresh] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, freshId));
    expect(fresh.summary).toBe(RAISED);
    expect(fresh.question).toBe(PLAIN);
    const [legacy] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, legacyId));
    expect(legacy.summary).toBe("The customer wants a recruiter to review one candidate for this role.");
    expect(legacy.question).toBe(LEGACY);
  });

  it("the queue says Recruiting OS raised it, with exactly the preview fields and no candidate", async () => {
    const list = (await (await json(recruiter, "GET", "/api/v1/escalations")).json()) as Array<Record<string, unknown>>;
    for (const id of [freshId, legacyId]) {
      const row = list.find((e) => e.id === id)!;
      expect(row, id).toBeTruthy();
      expectExactPreview(row);
      expect(row.summary).toBe(RAISED);
      expect(row.companyName).toBe("Salman Family Dental");
      expect(row.kind).toBe("review");
    }
  });

  it("the request page before Accept is the same preview, and says the full request opens on Accept", async () => {
    for (const id of [freshId, legacyId]) {
      const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${id}`)).json()) as Record<string, unknown>;
      expectExactPreview(detail, ["accessGranted", "why"]);
      expect(detail.summary).toBe(RAISED);
      expect(detail.accessGranted).toBe(false);
      expect(detail.why).toBe("claim it to open the full context");
    }
  });

  it("the ITS console reads the same words and carries no identifiers", async () => {
    const rows = (await (await json(admin, "GET", "/api/v1/admin/escalations", undefined, { "x-admin-reason": "test" })).json()) as Array<Record<string, unknown>>;
    for (const id of [freshId, legacyId]) {
      const row = rows.find((e) => e.id === id)!;
      expect(row, id).toBeTruthy();
      expect(row.summary).toBe(RAISED);
    }
    expectClean(rows);
    for (const s of HIDDEN) expect(JSON.stringify(rows)).not.toContain(s);
  });

  it("the customer reads the old request in plain words, on their requests and on Today", async () => {
    const mine = (await (await json(owner, "GET", "/api/v1/escalations/mine")).json()) as Array<{ id: string; question: string; summary: string; askedBy: { kind: string }; thread: Array<{ kind: string; body: string }> }>;
    for (const id of [freshId, legacyId]) {
      const own = mine.find((e) => e.id === id)!;
      expect(own.question).toBe(PLAIN);
      expect(own.thread[0]).toMatchObject({ kind: "question", body: PLAIN });
      expect(own.summary).toBe(RAISED);
      expect(own.askedBy.kind).toBe("system");
      for (const s of ["failed at step", "provider error", "invalid_request_error", "Please take over"]) expect(JSON.stringify(own)).not.toContain(s);
    }
    const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; body: string; actions: Array<{ path: string }> }> };
    for (const id of [freshId, legacyId]) {
      const card = brief.cards.find((c) => c.kind === "escalation" && c.actions.some((a) => a.path === `/?request=${id}`));
      expect(card, id).toBeTruthy();
      expect(card!.body).toBe(PLAIN);
    }
  });

  it("after Accept the recruiter reads who it is about, and the old request in plain words", async () => {
    expect((await json(recruiter, "POST", `/api/v1/escalations/${legacyId}/claim`)).status).toBe(200);
    const detail = (await (await json(recruiter, "GET", `/api/v1/escalations/${legacyId}`)).json()) as { accessGranted: boolean; summary: string; question: string; thread: Array<{ kind: string; body: string }>; contextSnapshot: { candidate: { name: string } }; grant: { purpose: string } };
    expect(detail.accessGranted).toBe(true);
    expect(detail.summary).toBe(RAISED);
    expect(detail.question).toBe(PLAIN);
    expect(detail.thread[0]).toMatchObject({ kind: "question", body: PLAIN });
    expect(detail.contextSnapshot.candidate.name).toBe("Lena Ortiz");
    expect(detail.grant.purpose).toBe(`review: ${RAISED}`);
    for (const s of ["failed at step", "provider error", "invalid_request_error"]) expect(JSON.stringify(detail)).not.toContain(s);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { adminAlerts, applications, auditRecords, candidates, communications, dataRequests, documents, events, recruiterEscalations, screens, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter, MemoryStorageAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, testContainerOptions } from "./test-helpers";

/**
 * Correction 7 (docs/runbooks/privacy-requests.md), built with synthetic data: a candidate can ask for a copy, a
 * correction, deletion, no more texts, or a person's review from their own status page; every request is recorded,
 * verified, acknowledged, tracked to a deadline, assigned, noted, escalated to counsel where needed, resolved and
 * confirmed; the customer sees only that a request exists; nothing is deleted automatically.
 */
describe("candidate privacy requests", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "privacy test" }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;

  let owner = "";
  let admin = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let statusToken = "";
  let applicationId = "";
  let candidateId = "";

  beforeAll(async () => {
    // Texting on: the text-message choices on the status page need an applicant who consented on the form.
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SMS_ENABLED: "true" }));
    app = createApp(container);
    owner = await signIn("owner@harbor.test");
    admin = await signInAdmin(app, container, "admin@its.test", "admin");
    await container.db.update(users).set({ platformRole: "platform_admin", name: "admin" }).where(eq(users.email, "admin@its.test"));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Newport Beach", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Newport Beach, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = (await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string }).roleId;
    await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", "Maria"); fd.set("lastName", "Reyes"); fd.set("email", "maria.reyes@example.com"); fd.set("phone", "(949) 555-0100"); fd.set("smsConsent", "yes"); fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File(["Maria Reyes, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nSkills: Dentrix"], "maria.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    statusToken = r.headers.get("location")!.split("/c/status/")[1].split("?")[0];
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    applicationId = a.id;
    candidateId = a.candidateId;
  });
  afterAll(async () => {
    await container.close();
  });

  it("an access request from the status page is verified by the link, acknowledged, tracked, and visible to the customer only as a kind", async () => {
    const r = await form(`/c/status/${statusToken}/privacy`, { kind: "access", details: "Please send everything you have on me." });
    expect(r.status).toBe(302);
    const [req] = await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, candidateId), eq(dataRequests.kind, "access")));
    expect(req.verificationStatus).toBe("verified_by_link");
    expect(req.status).toBe("in_progress");
    expect(Date.parse(req.slaDueAt) - Date.now()).toBeGreaterThan(40 * 86_400_000);
    const ack = outbox().find((m) => m.to === "maria.reyes@example.com" && /received your request/.test(m.subject))!;
    expect(ack).toBeTruthy();
    expect(ack.text).toContain("a copy of the information we hold about you");
    expect(ack.replyTo).toBe(container.env.PRIVACY_EMAIL);
    // the customer sees that a request exists and its kind; not the words
    const seen = (await (await json(owner, "GET", "/api/v1/events?type=candidate.data_request")).json()) as Array<{ payload: Record<string, unknown> }>;
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(seen)).not.toContain("everything you have on me");
    // the tenant role cannot read the table at all
    await expect(withTenant(container.db, companyId, (tx) => tx.select().from(dataRequests))).rejects.toThrow();
    // the status page confirms with a reference
    const page = await app.request(`/c/status/${statusToken}?request=${req.id.slice(0, 8)}`);
    expect(await page.text()).toContain("We have your request");
  });

  it("an administrator assigns, notes, exports the person's own data without others' data or internal rationale, fulfils, and the requester is confirmed", async () => {
    const [req] = await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, candidateId), eq(dataRequests.kind, "access")));
    expect((await json(owner, "GET", `/api/v1/admin/data-requests/${req.id}`)).status).toBe(403);
    const list = (await (await json(admin, "GET", "/api/v1/admin/data-requests")).json()) as Array<{ id: string; companyName: string }>;
    expect(list.find((x) => x.id === req.id)?.companyName).toBe("Harbor Dental");
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/assign`, { userId: "me" })).status).toBe(200);
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/notes`, { text: "Located one application and one resume." })).status).toBe(200);
    const exp = await json(admin, "GET", `/api/v1/admin/data-requests/${req.id}/export`);
    expect(exp.status).toBe(200);
    const bundle = (await exp.json()) as { person: { email: string }; applications: Array<{ eligibility: unknown }>; documents: Array<{ textExtracted: string | null }>; messagesWeSent: unknown[] };
    expect(bundle.person.email).toBe("maria.reyes@example.com");
    expect(bundle.applications).toHaveLength(1);
    expect(JSON.stringify(bundle)).not.toMatch(/rationale|strengths|concerns/);
    const done = await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/fulfil`, { resolution: "Your information is attached." });
    expect(done.status).toBe(200);
    const [after] = await container.db.select().from(dataRequests).where(eq(dataRequests.id, req.id));
    expect(after.status).toBe("fulfilled");
    expect(after.assignedTo).toBeTruthy();
    expect(after.notes).toHaveLength(1);
    expect(after.confirmationSentAt).toBeTruthy();
    const confirmation = outbox().find((m) => m.to === "maria.reyes@example.com" && /Your request is complete/.test(m.subject))!;
    expect(confirmation.attachments?.[0].filename).toMatch(/your-information/);
    const actions = (await container.db.select().from(auditRecords).where(eq(auditRecords.companyId, companyId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["data_request.created", "data_request.updated", "data.exported", "data_request.resolved"]));
    const fulfilled = (await (await json(owner, "GET", "/api/v1/events?type=candidate.data_request_fulfilled")).json()) as Array<{ payload: { kind: string } }>;
    expect(fulfilled[0].payload.kind).toBe("access");
  });

  it("a correction changes the field and records what changed; unverified email requests cannot be acted on until verified", async () => {
    const created = await json(admin, "POST", "/api/v1/admin/data-requests", { companyId, requesterEmail: "maria.reyes@example.com", kind: "correct", details: "My phone number should end in 0199." });
    expect(created.status).toBe(201);
    const req = (await created.json()) as { id: string; verificationStatus: string; candidateId: string };
    expect(req.verificationStatus).toBe("pending");
    expect(req.candidateId).toBe(candidateId);
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/fulfil`, { resolution: "x", correction: { field: "phone", value: "(949) 555-0199" } })).status).toBe(409);
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/verify`, { method: "replied from the applying address on 18 Sep", outcome: "verified" })).status).toBe(200);
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/fulfil`, { resolution: "Phone number corrected.", correction: { field: "phone", value: "(949) 555-0199" } })).status).toBe(200);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(cand.phone).toBe("(949) 555-0199");
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "data.corrected")))).length).toBe(1);
  });

  it("stopping texts from the status page is applied at once and recorded", async () => {
    expect((await form(`/c/status/${statusToken}/sms`, { pref: "off" })).status).toBe(302);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(cand.preferences.smsOptOut).toBe(true);
    const [req] = await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, candidateId), eq(dataRequests.kind, "sms_opt_out")));
    expect(req.status).toBe("fulfilled");
  });

  it("asking for a person opens a recruiter escalation with the generic preview", async () => {
    expect((await form(`/c/status/${statusToken}/privacy`, { kind: "human_review", details: "I think my resume was misread." })).status).toBe(302);
    const [req] = await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, candidateId), eq(dataRequests.kind, "human_review")));
    expect(req.escalationId).toBeTruthy();
    const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, req.escalationId!));
    expect(esc.kind).toBe("candidate_issue");
    expect(esc.summary).toMatch(/asked for a person/);
    expect(esc.summary).not.toContain("misread");
  });

  it("a deletion is never automatic: refused without a recorded counsel approval and an explicit confirmation; then anonymizes and keeps the stage history", async () => {
    const storage = container.integrations.storage as MemoryStorageAdapter;
    expect((await form(`/c/status/${statusToken}/privacy`, { kind: "delete", details: "Please delete my data." })).status).toBe(302);
    const [req] = await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, candidateId), eq(dataRequests.kind, "delete")));
    const refused = await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/fulfil`, { resolution: "Deleted.", confirmAnonymize: true });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("counsel_decision_required");
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/escalate`, { note: "Any retention duty for an applicant who was not hired?" })).status).toBe(200);
    expect((await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "privacy_request.counsel"))).length).toBe(1);
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/counsel`, { decision: "approved", note: "Anonymize; keep stage history." })).status).toBe(200);
    // approved by counsel but the administrator did not confirm: still refused
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/fulfil`, { resolution: "Deleted." })).status).toBe(409);
    const [docBefore] = await container.db.select().from(documents).where(eq(documents.candidateId, candidateId));
    expect(storage.has(docBefore.storageKey)).toBe(true);
    const ok = await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/fulfil`, { resolution: "Your information was removed.", confirmAnonymize: true });
    expect(ok.status).toBe(200);
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(cand.firstName).toBe("Removed");
    expect(cand.email).toBeNull();
    expect(cand.phone).toBeNull();
    expect(cand.anonymizedAt).toBeTruthy();
    const [doc] = await container.db.select().from(documents).where(eq(documents.id, docBefore.id));
    expect(doc.textExtracted).toBeNull();
    expect(storage.has(docBefore.storageKey)).toBe(false);
    for (const s of await container.db.select().from(screens).where(eq(screens.applicationId, applicationId))) { expect(s.transcript).toEqual([]); expect(s.answers).toEqual({}); }
    for (const m of await container.db.select().from(communications).where(eq(communications.candidateId, candidateId))) expect(m.bodyText).not.toContain("Maria");
    const [a] = await container.db.select().from(applications).where(eq(applications.id, applicationId));
    expect(a.stage).toBeTruthy(); // the stage history stays
    expect((await container.db.select().from(events).where(eq(events.type, "candidate.anonymized"))).length).toBe(1);
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "data.anonymized")))).length).toBe(1);
    const confirmation = outbox().find((m) => m.to === "maria.reyes@example.com" && /Your request is complete/.test(m.subject) && /identified you has been removed/.test(m.text));
    expect(confirmation).toBeTruthy();
  });

  it("deadlines raise an alert ten days before and again when overdue, once each", async () => {
    const created = await json(admin, "POST", "/api/v1/admin/data-requests", { companyId, requesterEmail: "someone@example.com", kind: "access" });
    const req = (await created.json()) as { id: string };
    const soon = new Date(Date.now() + 40 * 86_400_000);
    (container.engine as unknown as { now: () => Date }).now = () => soon;
    const first = (await (await json(admin, "GET", "/api/v1/admin/data-requests/deadlines/check")).json()) as { soon: number; overdue: number };
    expect(first.soon).toBeGreaterThanOrEqual(1);
    const again = (await (await json(admin, "GET", "/api/v1/admin/data-requests/deadlines/check")).json()) as { soon: number };
    expect(again.soon).toBe(0);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(Date.now() + 50 * 86_400_000);
    const late = (await (await json(admin, "GET", "/api/v1/admin/data-requests/deadlines/check")).json()) as { overdue: number };
    expect(late.overdue).toBeGreaterThanOrEqual(1);
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "privacy_request.deadline"));
    expect(alerts.some((a) => a.severity === "critical" && (a.details as { requestId: string }).requestId === req.id)).toBe(true);
    (container.engine as unknown as { now: () => Date }).now = () => new Date();
    expect((await json(admin, "POST", `/api/v1/admin/data-requests/${req.id}/decline`, { resolution: "We could not match this address to any application." })).status).toBe(200);
  });

  it("the status link is the whole trust boundary: forged links write nothing, injected ids are ignored, replays are idempotent, tokens never reach logs, dead links stay dead", async () => {
    const { redactString } = await import("@ros/core");
    const { auditRecords, events, dataRequests: dr } = await import("@ros/db");
    // the first applicant was anonymized above: her link is dead for reading and for every write
    expect((await app.request(`/c/status/${statusToken}`)).status).toBe(410);
    expect((await form(`/c/status/${statusToken}/privacy`, { kind: "access" })).status).toBe(410);
    expect((await form(`/c/status/${statusToken}/withdraw`, { confirm: "yes" })).status).toBe(410);
    expect((await form(`/c/status/${statusToken}/sms`, { pref: "off" })).status).toBe(410);
    // a second applicant
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", "Noor"); fd.set("lastName", "Haddad"); fd.set("email", "noor.haddad@example.com"); fd.set("phone", "(949) 555-0101"); fd.set("smsConsent", "yes"); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File(["Noor Haddad, RDH"], "noor.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const applied = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    const token = applied.headers.get("location")!.split("/c/status/")[1].split("?")[0];
    await container.drain();
    const [appRow0] = await container.db.select().from(applications).where(eq(applications.statusToken, token));
    const before = (await container.db.select().from(dr)).length;
    const auditsBefore = (await container.db.select().from(auditRecords)).length;
    // a forged or truncated token is a 404 and writes nothing
    expect((await form(`/c/status/${token.slice(0, -2)}zz/privacy`, { kind: "access" })).status).toBe(404);
    expect((await form("/c/status/not-a-token/privacy", { kind: "access" })).status).toBe(404);
    expect((await form("/c/status/not-a-token/withdraw", { confirm: "yes" })).status).toBe(404);
    expect((await form("/c/status/not-a-token/sms", { pref: "off" })).status).toBe(404);
    expect((await container.db.select().from(dr)).length).toBe(before);
    expect((await container.db.select().from(auditRecords)).length).toBe(auditsBefore);
    // only the four kinds the page offers; a withdrawal or text choice through this form is refused without a record
    expect((await form(`/c/status/${token}/privacy`, { kind: "sms_opt_out" })).status).toBe(302);
    expect((await form(`/c/status/${token}/privacy`, { kind: "withdrawal" })).status).toBe(302);
    expect((await container.db.select().from(dr)).length).toBe(before);
    // another company's ids in the form change nothing: everything comes from the token
    const other = (await (await json(owner, "POST", "/api/v1/companies", { name: "Other Co", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    outbox().length = 0;
    const r = await form(`/c/status/${token}/privacy`, { kind: "access", details: "What do you hold about me?", companyId: other.id, candidateId: "00000000-0000-0000-0000-000000000000", applicationId: "00000000-0000-0000-0000-000000000000", requesterEmail: "attacker@example.com", status: "fulfilled" });
    expect(r.status).toBe(302);
    const rows = await container.db.select().from(dr).where(eq(dr.applicationId, appRow0.id));
    const created = rows.filter((x) => x.kind === "access" && x.details === "What do you hold about me?");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ companyId, candidateId: appRow0.candidateId, applicationId: appRow0.id, requesterEmail: "noor.haddad@example.com", channel: "status_page", verificationStatus: "verified_by_link", status: "in_progress" });
    expect(outbox().filter((m) => m.to === "noor.haddad@example.com").length).toBe(1);
    // the same request again within a day answers the same record; nothing new, no second acknowledgment, and the replay is audited
    const countAfterFirst = (await container.db.select().from(dr)).length;
    const again = await form(`/c/status/${token}/privacy`, { kind: "access", details: "What do you hold about me?" });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toContain(created[0].id.slice(0, 8));
    expect((await container.db.select().from(dr)).length).toBe(countAfterFirst);
    expect(outbox().filter((m) => m.to === "noor.haddad@example.com").length).toBe(1);
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "data_request.replayed"))).length).toBeGreaterThanOrEqual(1);
    // a request for a person opens an escalation whose text never carries the candidate's words to the customer
    await form(`/c/status/${token}/privacy`, { kind: "human_review", details: "My manager at Coastal is the owner's cousin, please keep this private." });
    const mine = (await (await json(owner, "GET", "/api/v1/escalations/mine")).json()) as Array<{ question?: string; summary?: string }>;
    expect(JSON.stringify(mine)).not.toContain("cousin");
    // every creation is audited with the request id, and the token appears in no audit record, event or product event
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "data_request.created"));
    expect(audits.some((a) => (a.details as { requestId?: string }).requestId === created[0].id)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(await container.db.select().from(events).where(eq(events.companyId, companyId)))).not.toContain(token);
    // the request logger and error handler redact tokens and addresses from paths and query strings
    expect(redactString(`POST /c/status/${token}/privacy 302`)).not.toContain(token);
    expect(redactString(`POST /c/status/${token}/privacy 302`)).toContain("/c/status/");
    expect(redactString(`GET /api/v1/auth/consume?token=${token}`)).not.toContain(token);
    expect(redactString("GET /api/v1/admin/data-requests/lookup/candidate?email=noor.haddad@example.com 200")).not.toContain("noor.haddad");
    // text-message choice: opting out is idempotent, opting in is not offered while texting is off (switched off from here; the consent above was given while it was on)
    container.env.SMS_ENABLED = false;
    await form(`/c/status/${token}/sms`, { pref: "off" });
    await form(`/c/status/${token}/sms`, { pref: "off" });
    expect((await container.db.select().from(dr).where(and(eq(dr.applicationId, appRow0.id), eq(dr.kind, "sms_opt_out")))).length).toBe(1);
    expect((await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "candidate.opted_out")))).filter((e) => e.subjectId === appRow0.candidateId).length).toBe(1);
    expect((await form(`/c/status/${token}/sms`, { pref: "on" })).status).toBe(302);
    const [afterOn] = await container.db.select().from(candidates).where(eq(candidates.id, appRow0.candidateId));
    expect(afterOn.preferences.smsOptOut).toBe(true);
    expect(await (await app.request(`/c/status/${token}`)).text()).not.toContain("Allow text messages");
    // a withdrawal needs the explicit confirmation (no inline script on the page); without it nothing changes
    const noConfirm = await form(`/c/status/${token}/withdraw`, {});
    expect(noConfirm.status).toBe(302);
    expect(noConfirm.headers.get("location")).toContain("confirm=withdraw");
    expect((await container.db.select().from(applications).where(eq(applications.id, appRow0.id)))[0].stage).not.toBe("withdrawn");
    const page = await (await app.request(`/c/status/${token}`)).text();
    expect(page).not.toMatch(/ on(submit|click|change)=/);
    // with the confirmation: the application is withdrawn, the request is closed through the same path as every request, and the candidate is told
    outbox().length = 0;
    expect((await form(`/c/status/${token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    expect((await container.db.select().from(applications).where(eq(applications.id, appRow0.id)))[0].stage).toBe("withdrawn");
    const [wd] = await container.db.select().from(dr).where(and(eq(dr.applicationId, appRow0.id), eq(dr.kind, "withdrawal")));
    expect(wd.status).toBe("fulfilled");
    expect(wd.resolvedAt).toBeTruthy();
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "data_request.resolved"))).some((a) => (a.details as { requestId: string }).requestId === wd.id)).toBe(true);
    expect(outbox().some((m) => m.to === "noor.haddad@example.com" && /withdrawal/i.test(m.text))).toBe(true);
    // repeating the withdrawal changes and records nothing more
    expect((await form(`/c/status/${token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    expect((await container.db.select().from(dr).where(and(eq(dr.applicationId, appRow0.id), eq(dr.kind, "withdrawal")))).length).toBe(1);
    // an administrator recording an email request cannot attach another company's candidate or application
    const bad = await json(admin, "POST", "/api/v1/admin/data-requests", { companyId: other.id, requesterEmail: "noor.haddad@example.com", kind: "access", candidateId: appRow0.candidateId });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("mismatched_ids");
  });
});

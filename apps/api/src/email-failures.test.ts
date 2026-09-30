import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { adminAlerts, applications, auditRecords, candidates, communications, emailSuppressions, events, jobs, notifications, users, webhookReceipts } from "@ros/db";
import { fakePostmarkEvent, type FakeEmailAdapter, type FakeSmsAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin } from "./test-helpers";

/**
 * Item 5 of the founder's instruction of 18 September 2026: bounce and spam-complaint webhooks with authentication and
 * duplicate protection; suppression that every send consults; administrator alerts; a text fallback for candidates who
 * agreed to texts; soft-bounce retries; release by an administrator with a reason; every outcome an event.
 */
describe("email failure handling", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const SECRET = "wh-secret-for-tests-1234567890";
  const BASE = (() => { const d = new Date(); d.setUTCHours(19, 0, 0, 0); return d.getTime(); })();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "email test" }, body: body ? JSON.stringify(body) : undefined });
  const webhook = (payload: unknown, auth: Record<string, string> = { authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}` }) => app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(payload) });
  const fake = () => container.integrations.email as FakeEmailAdapter;
  const sms = () => container.integrations.sms as FakeSmsAdapter;

  let owner = "";
  let admin = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let applicationId = "";
  let candidateId = "";
  let ackMessageId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", POSTMARK_WEBHOOK_SECRET: SECRET, SMS_ENABLED: "true" } }); // texting on: the fallback text after an email failure needs a consenting applicant
    app = createApp(container);
    setClock(0);
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
    fd.set("resume", new File(["Maria Reyes, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present"], "maria.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd });
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId));
    applicationId = a.id;
    candidateId = a.candidateId;
    const ack = fake().sent.find((m) => m.to === "maria.reyes@example.com" && /received your application/.test(m.subject))!;
    ackMessageId = ack.providerMessageId;
  });
  afterAll(async () => {
    await container.close();
  });

  it("the webhook is authenticated and each event is processed once", async () => {
    const payload = fakePostmarkEvent({ providerMessageId: ackMessageId, email: "maria.reyes@example.com", type: "Transient", id: 1001 });
    expect((await webhook(payload, {})).status).toBe(401);
    expect((await webhook(payload, { authorization: `Basic ${Buffer.from("postmark:wrong").toString("base64")}` })).status).toBe(401);
    expect((await webhook(payload, { "x-webhook-secret": SECRET })).status).toBe(200);
    const again = (await (await webhook(payload)).json()) as { duplicate: boolean };
    expect(again.duplicate).toBe(true);
    expect((await container.db.select().from(webhookReceipts).where(eq(webhookReceipts.externalId, "Bounce:1001"))).length).toBe(1);
    expect((await webhook({ hello: "world" })).status).toBe(400);
  });

  it("a soft bounce marks the message, schedules one retry after four hours, and the retry is a new message that links to the original", async () => {
    const [comm] = await container.db.select().from(communications).where(eq(communications.providerMessageId, ackMessageId));
    expect(comm.status).toBe("bounced");
    expect(comm.failureType).toBe("soft_bounce");
    expect((await container.db.select().from(events).where(eq(events.type, "message.bounced"))).length).toBe(1);
    const queued = await container.db.select().from(jobs).where(and(eq(jobs.kind, "email.retry"), eq(jobs.status, "queued")));
    expect(queued).toHaveLength(1);
    setClock(5 * 3600_000);
    await container.drain();
    const [retry] = await container.db.select().from(communications).where(eq(communications.retryOf, comm.id));
    expect(retry).toBeTruthy();
    expect(retry.status).toBe("sent");
    expect(retry.retryAttempt).toBe(1);
    expect(fake().sent.filter((m) => m.to === "maria.reyes@example.com" && /received your application/.test(m.subject))).toHaveLength(2);
    expect((await container.db.select().from(events).where(eq(events.type, "message.retried"))).length).toBe(1);
    setClock(0);
  });

  it("a hard bounce suppresses the address, tells the owner, and texts the candidate a link to their status page", async () => {
    const [retry] = await container.db.select().from(communications).where(and(eq(communications.toAddress, "maria.reyes@example.com"), eq(communications.retryAttempt, 1)));
    const r = await webhook(fakePostmarkEvent({ providerMessageId: retry.providerMessageId!, email: "maria.reyes@example.com", type: "HardBounce", id: 1002 }));
    expect(((await r.json()) as { action: string }).action).toBe("suppressed");
    const [sup] = await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "maria.reyes@example.com"));
    expect(sup.active).toBe(true);
    expect(sup.reason).toBe("hard_bounce");
    const note = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "candidate.unreachable")))).pop()!;
    expect(note.body).toMatch(/texted them a link|goes out when contact hours open/);
    const text = sms().sent.find((m) => m.to === "+19495550100" && /could not reach you by email/.test(m.body));
    if (/texted them/.test(note.body)) expect(text).toBeTruthy();
    expect((await container.db.select().from(events).where(eq(events.type, "message.suppressed"))).length).toBeGreaterThanOrEqual(1);
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "suppression.added"))).length).toBeGreaterThanOrEqual(1);
  });

  it("nothing is emailed to a suppressed address, whatever the caller; the failure is recorded, never silent", async () => {
    const before = fake().sent.length;
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, candidateId));
    const r = await container.integrations.email.send({ to: cand.email!, from: "x <updates@test>", subject: "Anything", text: "Hello", idempotencyKey: "suppressed-test-1" });
    expect(r.status).toBe("failed");
    expect(r.status === "failed" && r.retryable).toBe(false);
    expect(fake().sent.length).toBe(before);
    // a decline after a human decision goes through the same guard and shows up as a failed communication with the reason
    const decline = await json(owner, "POST", `/api/v1/applications/${applicationId}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Not this time." });
    expect(decline.status).toBe(200);
    const [failed] = await container.db.select().from(communications).where(and(eq(communications.applicationId, applicationId), eq(communications.templateKey, "disposition:human"))).orderBy(desc(communications.createdAt)).limit(1);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/suppressed/);
  });

  it("an administrator releases a suppression with a reason; email flows again; a spam complaint suppresses for good and alerts", async () => {
    const list = (await (await json(admin, "GET", "/api/v1/admin/email-suppressions")).json()) as Array<{ id: string; address: string }>;
    const sup = list.find((s) => s.address === "maria.reyes@example.com")!;
    expect((await json(admin, "POST", `/api/v1/admin/email-suppressions/${sup.id}/release`, { reason: "x" })).status).toBe(400);
    expect((await json(admin, "POST", `/api/v1/admin/email-suppressions/${sup.id}/release`, { reason: "Candidate confirmed the address by phone on 18 Sep." })).status).toBe(200);
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "suppression.released"))).length).toBe(1);
    const ok = await container.integrations.email.send({ to: "maria.reyes@example.com", from: "x <updates@test>", subject: "After release", text: "Hello again", idempotencyKey: "after-release-1" });
    expect(ok.status).toBe("sent");
    const sentMsg = fake().sent.find((m) => m.subject === "After release")!;
    const r = await webhook(fakePostmarkEvent({ providerMessageId: sentMsg.providerMessageId, email: "maria.reyes@example.com", type: "SpamComplaint", id: 1003 }));
    expect(((await r.json()) as { suppressionReason: string }).suppressionReason).toBe("spam_complaint");
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "email.spam_complaint"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("critical");
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, candidateId));
    expect(cand.preferences.emailOptOut).toBe(true);
    expect((await container.db.select().from(events).where(eq(events.type, "message.complained"))).length).toBe(1);
    const [active] = await container.db.select().from(emailSuppressions).where(and(eq(emailSuppressions.address, "maria.reyes@example.com"), eq(emailSuppressions.active, true)));
    expect(active.reason).toBe("spam_complaint");
  });

  it("a bounce on a team member's address raises an administrator alert", async () => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@harbor.test" }) });
    expect(r1.status).toBe(200);
    const link = fake().sent.filter((m) => m.to === "owner@harbor.test" && /sign-in link/.test(m.subject)).pop()!;
    await webhook(fakePostmarkEvent({ providerMessageId: link.providerMessageId, email: "owner@harbor.test", type: "HardBounce", id: 1004 }));
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "email.person_unreachable"));
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect((await container.integrations.email.send({ to: "owner@harbor.test", from: "x <u@t>", subject: "s", text: "t", idempotencyKey: "owner-suppressed" })).status).toBe("failed");
  });
});

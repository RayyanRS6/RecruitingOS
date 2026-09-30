import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { anonymizeCandidate, entitlements } from "@ros/core";
import { applications, approvalRequests, assessments, auditRecords, communications, inboundEmails, interviews, notifications, recruiterEscalations, screens, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * Package MESSAGES (docs/spec/21 F5, F7, F8, F10, F11, F12): a person writes to a candidate through the outbox under
 * each policy level; every candidate email carries a per-application reply address once the inbound domain is
 * configured; a reply comes back onto the application, tells the team, and HUMAN hands the conversation to a person;
 * the interviewer's confirmation and their view of the candidate carry the brief without pay; the comparison view
 * answers owners, refuses interviewers and takes five at most.
 */
describe("writing to a candidate, hearing back, the interviewer brief, the comparison view", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  // The engine clock is pinned at the real "now": a rule change needs a session opened within thirty minutes of the
  // clock the product reads (audit finding A12), and interview times are offered from the next business days either way.
  const BASE = Date.now();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const inbound = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

  type Brief = { summary: string; cards: Array<{ kind: string; title: string; body: string; applicationId?: string; actions: Array<{ label: string; method: string; path: string; body?: Record<string, unknown> }> }> };
  type Packet = { requirements: { mustHaves: Array<{ key: string; text: string }>; eligibility: Array<{ key: string }> }; competencies: Array<{ key: string; name: string }>; interviews: { plan: Array<{ key: string; title: string; competencyKeys: string[] }> }; compensation: { min: number; max: number } };

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let packet: Packet;
  let n = 0;

  const apply = async (first: string, last: string) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@example.com`;
    const form = new FormData();
    form.set("firstName", first);
    form.set("lastName", last);
    form.set("email", email);
    form.set("locationText", "Tustin, CA");
    form.set("resume", new File([`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nActive CA RDH license\nSkills: periodontal charting, patient education`], "resume.txt", { type: "text/plain" }));
    for (const rule of packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    form.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, roleId)).orderBy(desc(applications.createdAt)).limit(1);
    return { id: a.id, email, name: `${first} ${last}`, row: a };
  };
  const application = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const interview = async (id: string) => (await container.db.select().from(interviews).where(eq(interviews.id, id)))[0];
  const brief = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/brief")).json()) as Brief;
  const audits = (action: string) => container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, action)));
  const told = (kind: string, userId?: string) => container.db.select().from(notifications).where(userId ? and(eq(notifications.companyId, companyId), eq(notifications.kind, kind), eq(notifications.userId, userId)) : and(eq(notifications.companyId, companyId), eq(notifications.kind, kind)));
  const userIdOf = async (email: string) => (await container.db.select({ id: users.id }).from(users).where(eq(users.email, email)))[0].id;
  const setPolicy = async (level: string) => expect((await json(owner, "PUT", "/api/v1/policies", { actionType: "message.send_freeform", level, approverRoles: ["owner", "admin"] })).status).toBe(200);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@messages.test");
    ownerId = await userIdOf("owner@messages.test");
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental Group", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = (await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: Packet } };
    packet = role.currentPacket.packet;
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  it("a person's message goes out through the outbox under the hiring team's name, with the writer in the footer and no disclosure line; audited; on the sheet", async () => {
    const cand = await apply("Maria", "Reyes");
    const before = outbox().length;
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/messages`, { subject: "Quick question about your license", text: "Hi Maria,\n\nCould you send me your license number when you have a minute?" });
    expect(r.status, await r.clone().text()).toBe(201);
    const body = (await r.json()) as { status: string; communicationId: string };
    expect(body.status).toBe("queued");
    await container.drain();
    const [row] = await container.db.select().from(communications).where(eq(communications.id, body.communicationId));
    expect(row).toMatchObject({ templateKey: "freeform", status: "sent", direction: "outbound", channel: "email", disclosureIncluded: false, toAddress: cand.email });
    expect(row.fromAddress).toMatch(/^Harbor Dental Group hiring team </);
    const mail = outbox().slice(before).find((m) => m.subject === "Quick question about your license");
    expect(mail).toBeTruthy();
    expect(mail!.to).toBe(cand.email);
    expect(mail!.text).toContain("Could you send me your license number");
    expect(mail!.text).toContain("Dana Whitfield");
    expect(mail!.text).toContain("Harbor Dental Group hiring team");
    expect(mail!.text).toContain("Reply to this email to reach a person");
    expect(mail!.text).not.toMatch(/AI recruiting assistant/);
    // audited, without the text
    const sent = await audits("message.sent");
    expect(sent.some((a) => (a.details as { communicationId?: string }).communicationId === body.communicationId)).toBe(true);
    expect(JSON.stringify(sent)).not.toContain("license number");
    // auto_notify: the team is told
    expect((await told("message.sent")).some((x) => x.title === "Dana Whitfield wrote to Maria Reyes" && x.action?.href === `/roles/${roleId}/talent?open=${cand.id}`)).toBe(true);
    // shown on the sheet
    const detail = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { communications: Array<{ id: string; direction: string; templateKey: string | null }> };
    expect(detail.communications.some((m) => m.id === body.communicationId && m.direction === "outbound" && m.templateKey === "freeform")).toBe(true);
    // the preview the sheet shows first
    const preview = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}/messages/preview`)).json()) as { to: string; footer: string; needsApproval: boolean; repliesComeBack: boolean };
    expect(preview.to).toBe(cand.email);
    expect(preview.footer).toContain("Dana Whitfield");
    expect(preview.needsApproval).toBe(false);
    expect(preview.repliesComeBack).toBe(false);
  });

  it("under an approval rule a hiring manager's message waits; the owner decides from the brief; an approver's own message goes at once", async () => {
    await setPolicy("approval");
    const cand = await apply("Luis", "Ortega");
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "priya@messages.test", name: "Priya Natarajan" });
    const preview = (await (await json(hm, "GET", `/api/v1/applications/${cand.id}/messages/preview`)).json()) as { needsApproval: boolean };
    expect(preview.needsApproval).toBe(true);
    const r = await json(hm, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Luis, are you available for a call on Thursday?" });
    expect(r.status, await r.clone().text()).toBe(202);
    const body = (await r.json()) as { status: string; approvalRequestId: string };
    expect(body.status).toBe("pending_approval");
    const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, body.approvalRequestId));
    expect(req).toMatchObject({ status: "pending", actionType: "message.send_freeform", applicationId: cand.id, requiredRoles: ["owner", "admin"] });
    expect(outbox().some((m) => m.to === cand.email && /Thursday/.test(m.text))).toBe(false);
    expect((await audits("message.approval_requested")).some((a) => (a.details as { approvalRequestId?: string }).approvalRequestId === body.approvalRequestId)).toBe(true);
    expect((await told("message.approval_requested", ownerId)).some((x) => x.title === "Send this message to Luis Ortega?")).toBe(true);
    // the brief carries the message and the decision
    const card = (await brief(owner)).cards.find((c) => c.title === "Send this message to Luis Ortega?");
    expect(card, "the owner's brief has the card").toBeTruthy();
    expect(card!.body).toContain("Thursday");
    expect(card!.body).toContain("Priya Natarajan");
    const approve = card!.actions.find((a) => a.label === "Yes, send it")!;
    expect(approve.path).toBe(`/api/v1/approvals/${body.approvalRequestId}/decide`);
    // the sheet shows the text to the approver
    const detail = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { pendingApprovals: Array<{ id: string; actionType: string; proposal: { text: string } }> };
    expect(detail.pendingApprovals.find((p) => p.id === body.approvalRequestId)?.proposal.text).toContain("Thursday");
    // the writer cannot approve their own message
    expect((await json(hm, "POST", approve.path, { decision: "approve" })).status).toBe(403);
    // the owner decides from the brief
    expect((await json(owner, "POST", approve.path, approve.body)).status).toBe(200);
    await container.drain();
    const mail = outbox().find((m) => m.to === cand.email && /Thursday/.test(m.text));
    expect(mail).toBeTruthy();
    expect(mail!.text).toContain("Priya Natarajan");
    expect(mail!.text).not.toContain("Dana Whitfield");
    expect((await audits("message.sent")).some((a) => (a.details as { approvalRequestId?: string; approvedBy?: string }).approvalRequestId === body.approvalRequestId && (a.details as { approvedBy?: string }).approvedBy === ownerId)).toBe(true);
    const priyaId = await userIdOf("priya@messages.test");
    expect((await told("message.sent", priyaId)).some((x) => x.title === "Your message to Luis Ortega was sent")).toBe(true);
    // an approver's own message under the same rule: their click is the approval
    const r2 = await json(owner, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Luis, looking forward to Thursday." });
    expect(r2.status, await r2.clone().text()).toBe(201);
    const own = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, cand.id), eq(approvalRequests.actionType, "message.send_freeform"), eq(approvalRequests.status, "approved")));
    expect(own.some((x) => x.decidedBy === ownerId && x.decisionNote === "sent by an approver")).toBe(true);
    // a declined message is not sent and the writer is told
    const r3 = await json(hm, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Luis, one more thing about parking." });
    expect(r3.status).toBe(202);
    const pending = (await r3.json()) as { approvalRequestId: string };
    expect((await json(owner, "POST", `/api/v1/approvals/${pending.approvalRequestId}/decide`, { decision: "reject", note: "Not needed yet." })).status).toBe(200);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /parking/.test(m.text))).toBe(false);
    expect((await told("message.declined", priyaId)).some((x) => x.title === "Your message to Luis Ortega was not sent" && /Not needed yet/.test(x.body))).toBe(true);
  });

  it("a rule that keeps the decision with a person: an approver's own message goes at once; anyone else's waits for an owner or admin, as under approval", async () => {
    await setPolicy("human_only");
    const cand = await apply("Ana", "Silva");
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Ana, thanks for applying." });
    expect(r.status, await r.clone().text()).toBe(201);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /thanks for applying/.test(m.text))).toBe(true);
    // a hiring manager's message waits: nothing is sent, the owner is told, and the strictest rule never reads less than "approval"
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "priya@messages.test", name: "Priya Natarajan" });
    expect(((await (await json(hm, "GET", `/api/v1/applications/${cand.id}/messages/preview`)).json()) as { needsApproval: boolean }).needsApproval).toBe(true);
    const r2 = await json(hm, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Ana, could you send your license number?" });
    expect(r2.status, await r2.clone().text()).toBe(202);
    const pending = (await r2.json()) as { status: string; approvalRequestId: string };
    expect(pending.status).toBe("pending_approval");
    const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.approvalRequestId));
    expect(req).toMatchObject({ status: "pending", actionType: "message.send_freeform", applicationId: cand.id, requiredRoles: ["owner", "admin"] });
    expect(outbox().some((m) => m.to === cand.email && /license number/.test(m.text))).toBe(false);
    expect((await told("message.approval_requested", ownerId)).some((x) => x.title === "Send this message to Ana Silva?")).toBe(true);
    // the owner's brief carries the card; the writer's does not ask them to approve their own message
    expect((await brief(owner)).cards.some((c) => c.title === "Send this message to Ana Silva?")).toBe(true);
    expect((await brief(hm)).cards.some((c) => c.title === "Send this message to Ana Silva?")).toBe(false);
    // the sheet says who may decide, and never carries the application's tokens
    const detail = (await (await json(hm, "GET", `/api/v1/applications/${cand.id}`)).json()) as { pendingApprovals: Array<{ id: string; requiredRoles: string[] }>; statusToken?: string; replyToken?: string };
    expect(detail.pendingApprovals.find((p) => p.id === pending.approvalRequestId)?.requiredRoles).toEqual(["owner", "admin"]);
    expect(detail.statusToken).toBeUndefined();
    expect(detail.replyToken).toBeUndefined();
    expect((await json(owner, "POST", `/api/v1/approvals/${pending.approvalRequestId}/decide`, { decision: "approve" })).status).toBe(200);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /license number/.test(m.text))).toBe(true);
  });

  it("under a plain auto rule the message goes out and nobody is told", async () => {
    await setPolicy("auto");
    const cand = await apply("Bruno", "Costa");
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Bruno, thanks for applying." });
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as { status: string }).status).toBe("queued");
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /thanks for applying/.test(m.text))).toBe(true);
    expect((await told("message.sent")).some((x) => x.title === "Dana Whitfield wrote to Bruno Costa")).toBe(false);
    await setPolicy("auto_notify");
  });

  it("every candidate email carries a per-application reply address when the inbound domain is configured, and the monitored mailbox otherwise", async () => {
    const cand = await apply("Ben", "Ito");
    const a = await application(cand.id);
    expect(a.replyToken).toMatch(/^[a-z0-9]{16}$/);
    expect(a.replyToken).not.toBe(a.statusToken);
    expect(a.statusToken.startsWith(a.replyToken)).toBe(false);
    // not configured (the default here): the monitored ITS mailbox
    expect(container.integrations.env.emailInConfigured).toBe(false);
    const r1 = await json(owner, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Ben, a first note." });
    const first = (await r1.json()) as { communicationId: string };
    await container.drain();
    expect((await container.db.select().from(communications).where(eq(communications.id, first.communicationId)))[0].replyTo).toBe(container.integrations.env.replyTo);
    // configured: the per-application address, never the status token
    container.integrations.env.emailInConfigured = true;
    container.integrations.env.intakeDomain = "intake.example.test";
    const r2 = await json(owner, "POST", `/api/v1/applications/${cand.id}/messages`, { text: "Hi Ben, a second note." });
    const second = (await r2.json()) as { communicationId: string };
    await container.drain();
    const expected = `reply-${a.replyToken}@intake.example.test`;
    expect((await container.db.select().from(communications).where(eq(communications.id, second.communicationId)))[0].replyTo).toBe(expected);
    expect(outbox().find((m) => /a second note/.test(m.text))?.replyTo).toBe(expected);
    expect(expected).not.toContain(a.statusToken.slice(0, 8));
    // templated mail too: the acknowledgment of a new application
    const cand2 = await apply("Chloe", "Baptiste");
    const a2 = await application(cand2.id);
    const [ack] = await container.db.select().from(communications).where(and(eq(communications.applicationId, a2.id), eq(communications.templateKey, "acknowledgment")));
    expect(ack.replyTo).toBe(`reply-${a2.replyToken}@intake.example.test`);
    expect((await (await json(owner, "GET", `/api/v1/applications/${cand.id}/messages/preview`)).json() as { repliesComeBack: boolean }).repliesComeBack).toBe(true);
  });

  it("a reply to the application's address is recorded on the application and the owner is told with a link to the sheet", async () => {
    const cand = await apply("Nora", "Quinn");
    const a = await application(cand.id);
    const r = await inbound({ From: cand.email, FromName: "Nora Quinn", To: `reply-${a.replyToken}@intake.example.test`, Subject: "Re: We received your application", TextBody: "Thanks! When would you like to talk?\n\nNora", MessageID: "msg-nora-1" });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, matched: true, reply: true, applicationId: a.id, humanRequested: false });
    const [row] = await container.db.select().from(communications).where(and(eq(communications.applicationId, a.id), eq(communications.direction, "inbound")));
    expect(row).toMatchObject({ channel: "email", status: "received", providerMessageId: "msg-nora-1", fromAddress: cand.email });
    expect(row.bodyText).toContain("When would you like to talk");
    const notices = await told("message.received");
    expect(notices.some((x) => x.title === "Nora Quinn wrote back" && x.action?.href === `/roles/${roleId}/talent?open=${a.id}` && /When would you like to talk/.test(x.body))).toBe(true);
    // never an application, never a stage change
    expect((await application(cand.id)).stage).toBe(a.stage);
    expect((await container.db.select().from(applications).where(eq(applications.roleId, roleId))).filter((x) => x.candidateId === a.candidateId)).toHaveLength(1);
    const detail = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { communications: Array<{ id: string; direction: string }> };
    expect(detail.communications.some((m) => m.id === row.id && m.direction === "inbound")).toBe(true);
    const [log] = await container.db.select().from(inboundEmails).where(eq(inboundEmails.toAddress, `reply-${a.replyToken}@intake.example.test`));
    expect(log).toMatchObject({ status: "matched", applicationId: a.id, companyId });
  });

  it("HUMAN on the first line hands the conversation to a person and answers with the response time", async () => {
    const cand = await apply("Omar", "Haddad");
    const a = await application(cand.id);
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, a.id));
    expect(scr?.status, "the applicant was invited to a screen on apply").toBe("invited");
    const before = outbox().length;
    const r = await inbound({ From: cand.email, To: `reply-${a.replyToken}@intake.example.test`, Subject: "Re: Next step: a short screening conversation", TextBody: "human\n\nI would rather talk to someone, please.", MessageID: "msg-omar-1" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ matched: true, reply: true, humanRequested: true });
    const esc = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, a.id));
    expect(esc.length).toBeGreaterThanOrEqual(1);
    expect(esc[0].kind).toBe("candidate_issue");
    expect((await container.db.select().from(screens).where(eq(screens.id, scr.id)))[0].status).toBe("human_requested");
    expect((await told("screen.human_requested")).some((x) => x.title === "Omar asked for a person")).toBe(true);
    await container.drain();
    const reply = outbox().slice(before).find((m) => m.to === cand.email);
    expect(reply).toBeTruthy();
    expect(reply!.subject).toBe("Re: Next step: a short screening conversation");
    expect(reply!.text).toMatch(/A person from Harbor Dental Group will follow up with you/);
    expect(reply!.text).toMatch(/business/);
    expect(reply!.replyTo).toBe(`reply-${a.replyToken}@intake.example.test`);
    const [sent] = await container.db.select().from(communications).where(and(eq(communications.applicationId, a.id), eq(communications.templateKey, "human_requested_reply")));
    expect(sent.status).toBe("sent");
  });

  it("a reply to an address nobody has is ignored safely", async () => {
    const commsBefore = (await container.db.select({ id: communications.id }).from(communications)).length;
    const appsBefore = (await container.db.select({ id: applications.id }).from(applications)).length;
    const r = await inbound({ From: "stranger@example.com", To: "reply-nosuchtoken0001@intake.example.test", Subject: "hello", TextBody: "HUMAN" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, matched: false });
    const [log] = await container.db.select().from(inboundEmails).where(eq(inboundEmails.toAddress, "reply-nosuchtoken0001@intake.example.test"));
    expect(log).toMatchObject({ status: "unmatched", error: "unknown reply token" });
    expect((await container.db.select({ id: communications.id }).from(communications)).length).toBe(commsBefore);
    expect((await container.db.select({ id: applications.id }).from(applications)).length).toBe(appsBefore);
    expect(outbox().some((m) => m.to === "stranger@example.com")).toBe(false);
  });

  it("a reply Postmark delivers twice (same MessageID) is recorded, told and acted on once", async () => {
    const cand = await apply("Rae", "Burke");
    const a = await application(cand.id);
    const payload = { From: cand.email, To: `reply-${a.replyToken}@intake.example.test`, Subject: "Re: Next step", TextBody: "HUMAN\n\nPlease call me instead.", MessageID: "msg-rae-1" };
    const first = await inbound(payload);
    expect(await first.json()).toMatchObject({ matched: true, humanRequested: true });
    await container.drain();
    const count = async () => ({
      inbound: (await container.db.select().from(communications).where(and(eq(communications.applicationId, a.id), eq(communications.direction, "inbound")))).length,
      replies: (await container.db.select().from(communications).where(and(eq(communications.applicationId, a.id), eq(communications.templateKey, "human_requested_reply")))).length,
      escalations: (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, a.id))).length,
      notices: (await told("message.received")).filter((x) => x.title === "Rae Burke wrote back").length,
      sent: outbox().filter((m) => m.to === cand.email && m.subject === "Re: Next step").length,
    });
    const once = await count();
    expect(once).toMatchObject({ inbound: 1, replies: 1, sent: 1 });
    expect(once.escalations).toBeGreaterThanOrEqual(1);
    // the redelivery after a timeout: acknowledged, nothing recorded, nobody told again, no second "a person will follow up"
    const again = await inbound(payload);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, matched: true, reply: true, duplicate: true, applicationId: a.id });
    await container.drain();
    expect(await count()).toEqual(once);
    const logs = await container.db.select().from(inboundEmails).where(eq(inboundEmails.toAddress, `reply-${a.replyToken}@intake.example.test`));
    expect(logs.map((l) => l.status).sort()).toEqual(["duplicate", "matched"]);
  });

  it("a reply to someone whose record was removed at their request writes nothing back: no address, no words, nobody told", async () => {
    const cand = await apply("Tess", "Moreno");
    const a = await application(cand.id);
    const oldAddress = `reply-${a.replyToken}@intake.example.test`;
    // the deletion request is fulfilled: the reply address of every old email is retired
    await withTenant(container.db, companyId, (tx) => anonymizeCandidate(tx, { companyId, candidateId: a.candidateId, actor: { kind: "user", id: ownerId }, deleteFile: (key) => container.integrations.storage.delete(key) }));
    const after = await application(cand.id);
    expect(after.replyToken).not.toBe(a.replyToken);
    const commsBefore = (await container.db.select().from(communications).where(eq(communications.applicationId, a.id))).length;
    const noticesBefore = (await told("message.received")).length;
    const r = await inbound({ From: cand.email, FromName: "Tess Moreno", To: oldAddress, Subject: "Re: Your application", TextBody: "Tess Moreno here, my new number is 555-0100.", MessageID: "msg-tess-1" });
    expect(await r.json()).toEqual({ ok: true, matched: false });
    // a record anonymized before the address was retired is refused the same way, and the inbound log keeps nothing personal
    await container.db.update(applications).set({ replyToken: a.replyToken }).where(eq(applications.id, a.id));
    const r2 = await inbound({ From: cand.email, FromName: "Tess Moreno", To: oldAddress, Subject: "Re: Your application", TextBody: "Tess Moreno here, my new number is 555-0100.", MessageID: "msg-tess-2" });
    expect(await r2.json()).toEqual({ ok: true, matched: false });
    const logs = await container.db.select().from(inboundEmails).where(eq(inboundEmails.toAddress, oldAddress));
    const refused = logs.find((l) => l.error?.includes("removed at the person's request"))!;
    expect(refused).toMatchObject({ status: "unmatched", fromAddress: "(removed)", subject: null, applicationId: null });
    expect(refused.parsed).toEqual({});
    expect(JSON.stringify(refused)).not.toContain("555-0100");
    expect((await container.db.select().from(communications).where(eq(communications.applicationId, a.id))).length).toBe(commsBefore);
    expect((await told("message.received")).length).toBe(noticesBefore);
  });

  it("the interviewer's confirmation carries the brief without pay, and the interviewer may open that candidate only", async () => {
    container.integrations.env.emailInConfigured = false;
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "sam@messages.test", name: "Sam Okafor" });
    const samId = await userIdOf("sam@messages.test");
    expect((await json(interviewer, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 6 })).status).toBe(200);
    const cand = await apply("Elena", "Park");
    const other = await apply("Diego", "Alvarez");
    // Elena finished a screen: she answered the compensation question, and her scorecard raises a concern that quotes it. Neither reaches an interviewer.
    const questions = (packet as unknown as { screening: { questions: Array<{ key: string; question: string; kind: string }> } }).screening.questions;
    const payQuestion = questions.find((q) => q.kind === "compensation")!;
    const workQuestion = questions.find((q) => q.kind === "skills")!;
    expect(payQuestion, "the playbook asks about pay").toBeTruthy();
    const payAnswer = "I am looking for $61 to $64 an hour";
    const workAnswer = "Six years of perio charting and patient education at a busy family practice";
    await container.db.insert(screens).values({ companyId, applicationId: cand.id, channel: "web", status: "completed", token: `pay-brief-${cand.id}`, completedAt: new Date(BASE).toISOString(), answers: { [payQuestion.key]: payAnswer, [workQuestion.key]: workAnswer } });
    const scorecard = { overall: "potential", confidence: "medium", summary: "Two answers.", strengths: [{ claim: "Gave a concrete answer about recent work", evidence: { source: "screen", quote: workAnswer } }], concerns: [{ claim: "Expects more than the posted range", evidence: { source: "screen", quote: payAnswer } }], unknowns: [], competencyFindings: [], requirementFindings: [], anomalies: [], questionFindings: [], compensationExpectation: { stated: payAnswer, withinRange: "above" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "hold", rationale: "x" };
    await container.db.insert(assessments).values({ companyId, applicationId: cand.id, kind: "screen", packetVersion: cand.row.packetVersion, result: scorecard as never, overall: "potential", confidence: "medium" });
    // not on any of their interviews yet: refused
    expect((await json(interviewer, "GET", `/api/v1/applications/${cand.id}`)).status).toBe(403);
    const round = packet.interviews.plan[0];
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey: round.key, interviewerUserIds: [samId], linkSource: "calendar" });
    expect(r.status, await r.clone().text()).toBe(201);
    const iv = (await r.json()) as { id: string };
    // the candidate picks the first time; the workflow books it and confirms the interviewer
    const row = await interview(iv.id);
    expect(row.status, "times must be on offer").toBe("scheduling");
    const pick = await app.request(`/c/schedule/${row.scheduleToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId: row.offeredSlots[0].id, timezone: "America/New_York" }).toString() });
    expect(pick.status).toBe(302);
    await container.drain();
    expect((await interview(iv.id)).status).toBe("scheduled");
    const mail = outbox().find((m) => m.to === "sam@messages.test" && /^Interview booked/.test(m.subject));
    expect(mail, "the interviewer's confirmation").toBeTruthy();
    expect(mail!.text).toContain(`Your interview brief: ${round.title} with Elena`);
    expect(mail!.text).toContain("What this round is for:");
    expect(mail!.text).toContain("Must-haves and what we know:");
    for (const m of packet.requirements.mustHaves) expect(mail!.text).toContain(m.text);
    for (const key of round.competencyKeys) expect(mail!.text).toContain(packet.competencies.find((c) => c.key === key)!.name);
    expect(mail!.text).toContain("Strengths so far:");
    expect(mail!.text).not.toMatch(/Pay expectation/);
    // pay is always written with its dollar sign; a bare number could match the random interview id in the link
    for (const n of [packet.compensation.min, packet.compensation.max]) expect(mail!.text).not.toContain(`$${n.toLocaleString("en-US")}`);
    expect(mail!.text).not.toMatch(/rationale/i);
    // what she said in the screen is there, except what she said about pay: not the answer, not the question, not the concern quoting it
    expect(mail!.text).toContain("What they said in the screen:");
    expect(mail!.text).toContain(workAnswer);
    expect(mail!.text).not.toContain("$61");
    expect(mail!.text).not.toContain(payQuestion.question);
    expect(mail!.text).not.toContain("Expects more than the posted range");
    // the interviewer's view of that candidate: the brief and little else
    const view = (await (await json(interviewer, "GET", `/api/v1/applications/${cand.id}`)).json()) as { viewer: string; allowedActions: string[]; candidate: Record<string, unknown>; brief: { round: { key: string }; includesPay: boolean; pay: unknown; mustHaves: Array<{ text: string; met: string }> }; interviews: Array<{ id: string }> };
    expect(view.viewer).toBe("interviewer");
    expect(view.allowedActions).toEqual([]);
    expect(view.brief.round.key).toBe(round.key);
    expect(view.brief.includesPay).toBe(false);
    expect(view.brief.pay).toBeNull();
    expect(view.brief.mustHaves.map((m) => m.text)).toEqual(packet.requirements.mustHaves.map((m) => m.text));
    expect(view.interviews.map((i) => i.id)).toContain(iv.id);
    expect(view.candidate).toEqual({ firstName: "Elena", lastName: "Park" });
    const text = JSON.stringify(view);
    expect(text).not.toContain(cand.email);
    expect(text).not.toMatch(/rationale|compensation|internalNotes|communications|documents/);
    expect(text).toContain(workAnswer);
    expect(text).not.toContain("$61");
    expect(text).not.toContain(payQuestion.question);
    expect((await audits("candidate.viewed")).some((a) => a.actor.id === samId && a.target?.id === cand.id)).toBe(true);
    // another candidate: refused
    expect((await json(interviewer, "GET", `/api/v1/applications/${other.id}`)).status).toBe(403);
    // the interview page carries the same brief; the owner's copy may include pay
    const mine = (await (await json(interviewer, "GET", `/api/v1/interviews/${iv.id}`)).json()) as { brief: { round: { key: string }; includesPay: boolean } | null };
    expect(mine.brief?.round.key).toBe(round.key);
    expect(mine.brief?.includesPay).toBe(false);
    expect(JSON.stringify(mine.brief)).toContain(workAnswer);
    expect(JSON.stringify(mine.brief)).not.toContain("$61");
    const theirs = (await (await json(owner, "GET", `/api/v1/interviews/${iv.id}`)).json()) as { brief: { includesPay: boolean } | null };
    expect(theirs.brief?.includesPay).toBe(true);
    // the owner may see pay: the answer, the concern and the expectation are all in their copy
    expect(theirs.brief).toMatchObject({ pay: { expectation: payAnswer, withinRange: "above" }, concerns: expect.arrayContaining([expect.objectContaining({ quote: payAnswer, aboutPay: true })]), screen: { answers: expect.arrayContaining([expect.objectContaining({ answer: payAnswer, aboutPay: true })]) } });
    // the interview page's "Message the candidate" leads to the sheet with the text box open
    const sheet = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { interviews: Array<{ id: string }> };
    expect(sheet.interviews.some((i) => i.id === iv.id)).toBe(true);
  });

  it("the comparison view answers owners with the columns in the chosen order, refuses interviewers and takes five at most", async () => {
    const a = await apply("Faith", "Nguyen");
    const b = await apply("Gabe", "Moreno");
    const r = await json(owner, "GET", `/api/v1/roles/${roleId}/compare?ids=${b.id},${a.id}`);
    expect(r.status, await r.clone().text()).toBe(200);
    const out = (await r.json()) as { role: { id: string }; mustHaves: Array<{ key: string; text: string }>; competencies: Array<{ key: string; name: string }>; candidates: Array<{ applicationId: string; name: string; stageLabel: string; mustHaves: Record<string, { met: string }>; competencies: Record<string, { finding: string }>; resume: { overall: string } | null; screen: unknown; unknownCount: number; open: string }>; reminder: string; max: number };
    expect(out.role.id).toBe(roleId);
    expect(out.candidates.map((c) => c.applicationId)).toEqual([b.id, a.id]);
    expect(out.candidates.map((c) => c.name)).toEqual(["Gabe Moreno", "Faith Nguyen"]);
    expect(out.mustHaves.map((m) => m.text)).toEqual(packet.requirements.mustHaves.map((m) => m.text));
    expect(out.competencies.map((c) => c.key)).toEqual(packet.competencies.map((c) => c.key));
    expect(out.reminder).toMatch(/People decide/);
    expect(out.max).toBe(5);
    const first = out.candidates[0];
    expect(first.open).toBe(`/roles/${roleId}/talent?open=${b.id}`);
    expect(first.resume, "the résumé assessment written on apply").toBeTruthy();
    expect(typeof first.unknownCount).toBe("number");
    for (const m of out.mustHaves) if (first.mustHaves[m.key]) expect(["yes", "partially", "no", "unknown"]).toContain(first.mustHaves[m.key].met);
    for (const c of out.competencies) if (first.competencies[c.key]) expect(["evidenced", "partially_evidenced", "not_evidenced", "contradicted"]).toContain(first.competencies[c.key].finding);
    expect(JSON.stringify(out)).not.toMatch(/rationale|secondaryScore/);
    // an id from another role, an unknown one, or one that is not an id at all is simply left out; nothing but ids is a 400, never a 500
    expect(((await (await json(owner, "GET", `/api/v1/roles/${roleId}/compare?ids=${a.id},00000000-0000-7000-8000-000000000000,not-an-id`)).json()) as { candidates: unknown[] }).candidates).toHaveLength(1);
    expect((await json(owner, "GET", `/api/v1/roles/${roleId}/compare?ids=not-an-id`)).status).toBe(400);
    // interviewers have no application.read
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "sam@messages.test" });
    expect((await json(interviewer, "GET", `/api/v1/roles/${roleId}/compare?ids=${a.id}`)).status).toBe(403);
    // five at most, and at least one
    const six = [a.id, b.id, "c", "d", "e", "f"].join(",");
    expect((await json(owner, "GET", `/api/v1/roles/${roleId}/compare?ids=${six}`)).status).toBe(400);
    expect((await json(owner, "GET", `/api/v1/roles/${roleId}/compare`)).status).toBe(400);
    // a hiring manager may compare too (application.read)
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "priya@messages.test" });
    expect((await json(hm, "GET", `/api/v1/roles/${roleId}/compare?ids=${a.id},${b.id}`)).status).toBe(200);
  });
});

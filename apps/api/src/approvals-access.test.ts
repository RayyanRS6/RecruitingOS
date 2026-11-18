import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { applications, approvalRequests, candidates, communications, interviewParticipants, interviews, memberships, policies, randomToken, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { putOnInterview, signInAs } from "./test-helpers";

/**
 * Approvals and who may see or decide them (final review, api area): a decline message held for approval goes out when
 * it is approved, including under a policy saved in Setup with no approver roles; the brief offers a decision only to
 * the people the decide route accepts, in plain words; an interviewer reads neither the requests (candidate names,
 * messages) nor any pay figure.
 */
describe("approvals: sending the held decline, who sees and decides what", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let hr = "";
  let interviewer = "";
  let companyId = "";
  let roleA = "";
  let roleB = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const emails = () => (container.integrations.email as FakeEmailAdapter).sent;
  type Card = { kind: string; title: string; body: string; approvalRequestId?: string; actions: Array<{ label: string; method: string; path: string }> };
  const brief = async (cookie: string) => ((await (await json(cookie, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards;
  const interviewerHead = (path: string) => app.request(path, { method: "HEAD", headers: { cookie: interviewer } });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  const member = async (email: string, name: string, role: "hr" | "interviewer") => {
    const [u] = await container.db.insert(users).values({ email, name }).returning();
    await container.db.insert(memberships).values({ companyId, userId: u.id, role, status: "active" });
    return signIn(email);
  };
  const compile = async (message: string) => {
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    return ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
  };
  /** A candidate at "Ready for your review" on a role, straight into the tables (the apply flow is covered elsewhere). */
  const seedApplication = (roleId: string, first: string, last: string) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: last, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning();
      return a.id;
    });
  const seedInterview = (applicationId: string) =>
    withTenant(container.db, companyId, async (tx) => {
      const [iv] = await tx.insert(interviews).values({ companyId, applicationId, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "scheduling", timezone: "America/Los_Angeles", createdBy: { kind: "user", id: ownerId } }).returning();
      await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: ownerId, role: "interviewer", status: "invited" });
      return iv.id;
    });
  /** A decline is private (founder decision B6); its message is a person's later Send, which these settings hold for approval. */
  const decline = async (applicationId: string) => {
    expect((await json(owner, "POST", `/api/v1/applications/${applicationId}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Not enough chairside time." })).status).toBe(200);
    return json(owner, "POST", `/api/v1/applications/${applicationId}/actions`, { action: "send_decision" });
  };
  const pendingFor = async (applicationId: string, actionType: string) => (await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, applicationId), eq(approvalRequests.actionType, actionType), eq(approvalRequests.status, "pending"))))[0] ?? null;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@approvals.test");
    ownerId = (await container.db.select().from(users).where(eq(users.email, "owner@approvals.test")))[0].id;
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Approvals Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    roleA = await compile("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    expect((await json(owner, "POST", `/api/v1/roles/${roleA}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    roleB = await compile("I need a front office coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $28. I decide. Must-haves: Dentrix scheduling. Just draft it.");
    await container.drain();
    hr = await member("holly.hr@approvals.test", "Holly HR", "hr");
    interviewer = await member("ivy.interviewer@approvals.test", "Ivy Interviewer", "interviewer");
  });
  afterAll(async () => {
    await container.close();
  });

  it("a decline message held for approval is sent when an owner approves it, even under a policy saved with no approver roles", async () => {
    // what Setup's policy editor saves when "Send a decline message" is switched to "approval": the action's empty list
    await withTenant(container.db, companyId, (tx) => tx.insert(policies).values({ companyId, roleId: null, actionType: "disposition.send", level: "approval", approverRoles: [], createdBy: { kind: "user", id: ownerId } }));
    const pat = await seedApplication(roleA, "Pat", "Lee");
    const r = await decline(pat);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ stage: "rejected", dispositionSent: false, candidateNotice: "waiting_approval" });
    const req = await pendingFor(pat, "disposition.send");
    expect(req).toBeTruthy();
    expect(req!.requiredRoles).toEqual([]);
    expect(emails().filter((m) => m.to === "pat.lee@example.com")).toHaveLength(0);
    // the owner's brief asks in plain words, naming the person; HR, who cannot decide it, gets no card
    const card = (await brief(owner)).find((c) => c.approvalRequestId === req!.id);
    expect(card?.title).toBe("Send the decision message to Pat Lee?");
    expect(card?.title).not.toMatch(/disposition|Decision needed/);
    expect(card?.actions.map((a) => a.label)).toEqual(["Yes, send it", "Do not send", "Review first"]);
    expect((await brief(hr)).some((c) => c.approvalRequestId === req!.id)).toBe(false);
    const hrDecide = await json(hr, "POST", `/api/v1/approvals/${req!.id}/decide`, { decision: "approve" });
    expect(hrDecide.status).toBe(403);
    // approving it sends the message the decline was waiting for, through the outbox
    const approved = await json(owner, "POST", `/api/v1/approvals/${req!.id}/decide`, { decision: "approve" });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ ok: true, status: "approved", dispositionSent: true });
    const [sent] = await container.db.select().from(communications).where(and(eq(communications.applicationId, pat), eq(communications.templateKey, "disposition:human")));
    expect(sent).toBeTruthy();
    expect(emails().filter((m) => m.to === "pat.lee@example.com" && m.subject.startsWith("Your application to"))).toHaveLength(1);
    // declined instead: nothing goes
    const sam = await seedApplication(roleA, "Sam", "Ortiz");
    await decline(sam);
    const samReq = await pendingFor(sam, "disposition.send");
    expect(await (await json(owner, "POST", `/api/v1/approvals/${samReq!.id}/decide`, { decision: "reject", note: "I will call them myself." })).json()).toMatchObject({ status: "rejected" });
    expect(emails().filter((m) => m.to === "sam.ortiz@example.com")).toHaveLength(0);
    await withTenant(container.db, companyId, (tx) => tx.delete(policies).where(and(eq(policies.companyId, companyId), eq(policies.actionType, "disposition.send"))));
  });

  it("the brief's posting card opens the Posting tab", async () => {
    const posting = (await brief(owner)).find((c) => c.kind === "posting_action" && c.title.includes("post it on"));
    expect(posting?.actions[0]).toMatchObject({ label: "See instructions", method: "GET", path: `/roles/${roleA}?tab=posting` });
  });

  it("an interviewer reads neither the waiting requests nor any pay figure: not the range, the ceiling, the bonus or the sources that quote them", async () => {
    // requests carry names and messages: the list needs application.read, and the role page leaves them out. One waits here: an interview suggestion.
    const lou = await seedApplication(roleA, "Lou", "Park");
    await withTenant(container.db, companyId, (tx) => tx.insert(approvalRequests).values({ companyId, roleId: roleA, applicationId: lou, actionType: "application.recommend_interview", subject: { type: "application", id: lou }, requestedBy: { kind: "agent", id: "orchestrator" }, requiredRoles: [] }));
    expect((await json(interviewer, "GET", "/api/v1/approvals")).status).toBe(403);
    const ownerView = (await (await json(owner, "GET", `/api/v1/roles/${roleA}`)).json()) as { pendingApprovals: unknown[] };
    expect(ownerView.pendingApprovals.length).toBeGreaterThan(0);
    // a role they do not interview for is not theirs to open; once they are on one of its interviews it is
    expect((await json(interviewer, "GET", `/api/v1/roles/${roleA}`)).status).toBe(404);
    expect((await json(interviewer, "GET", `/api/v1/roles/${roleA}/interviews`)).status).toBe(404);
    const mine = await putOnInterview(container, app, { cookie: interviewer, roleId: roleA });
    // the role's interviews: theirs only, never another candidate's name, decision or the team's emails
    await seedInterview(await seedApplication(roleA, "Ola", "Reyes"));
    const ivs = (await (await json(interviewer, "GET", `/api/v1/roles/${roleA}/interviews`)).json()) as Array<{ id: string }>;
    expect(ivs.map((i) => i.id)).toEqual([mine.interviewId]);
    expect(JSON.stringify(ivs)).not.toContain("Reyes");
    expect(JSON.stringify(ivs)).not.toContain("owner@approvals.test");
    // the other role stays closed, its tabs too; the roles list names only their own
    for (const path of ["", "/packets", "/interview-plan", "/requirements-check", "/postings", "/volume", "/interviews"]) expect((await json(interviewer, "GET", `/api/v1/roles/${roleB}${path}`)).status, path).toBe(404);
    expect(((await (await json(interviewer, "GET", "/api/v1/roles")).json()) as Array<{ id: string }>).map((r) => r.id)).toEqual([roleA]);
    const detail = (await (await json(interviewer, "GET", `/api/v1/roles/${roleA}`)).json()) as { pendingApprovals: unknown[]; currentPacket: { packet: { compensation: Record<string, unknown> } } };
    expect(detail.pendingApprovals).toEqual([]);
    // no applicant counts either, as on the roles list (countsHidden)
    expect((detail as unknown as { counts: Record<string, number> }).counts).toEqual({});
    // the role page keeps the pay section's shape with nothing in it
    expect(detail.currentPacket.packet.compensation).toMatchObject({ min: 0, max: 0, ceiling: 0, sources: [] });
    expect(detail.currentPacket.packet.compensation).not.toHaveProperty("bonus");
    expect(detail.currentPacket.packet.compensation).not.toHaveProperty("benefitsSummary");
    expect(JSON.stringify(detail.currentPacket.packet.compensation)).not.toMatch(/45|55|58/);
    // the packets route returns only how pay is paid; the owner still sees where the figures came from
    const own = (await (await json(owner, "GET", `/api/v1/roles/${roleA}/packets`)).json()) as Array<{ packet: { compensation: { sources: Array<{ detail?: string }>; max: number } } }>;
    expect(own[0].packet.compensation.max).toBeGreaterThan(0);
    const quoted = own[0].packet.compensation.sources.map((s) => s.detail).filter((d): d is string => !!d);
    expect(quoted).toContain("45–55 hourly"); // the owner-stated source quotes the range
    const packets = (await (await json(interviewer, "GET", `/api/v1/roles/${roleA}/packets`)).json()) as Array<{ packet: { compensation: Record<string, unknown> } }>;
    for (const p of packets) expect(Object.keys(p.packet.compensation).sort()).toEqual(["basis", "currency", "discloseRange"]);
    const body = JSON.stringify(packets);
    for (const d of quoted) expect(body).not.toContain(d);
    // the Share tab's volume on their own role: the switch's state, no applicant numbers
    const volume = (await (await json(interviewer, "GET", `/api/v1/roles/${roleA}/volume`)).json()) as { totals: { total: number; bySource: Record<string, number> }; days: Array<{ total: number }>; sources: unknown[]; yesterday: { total: number }; today: { total: number }; acceptingApplications: boolean };
    expect(volume.totals).toEqual({ total: 0, bySource: {} });
    expect(volume.days.every((d) => d.total === 0)).toBe(true);
    expect(volume.sources).toEqual([]);
    expect(typeof volume.acceptingApplications).toBe("boolean");
    expect(((await (await json(owner, "GET", `/api/v1/roles/${roleA}/volume`)).json()) as { totals: { total: number } }).totals.total).toBeGreaterThan(0);
    // HEAD is held to the same rule as GET
    expect((await interviewerHead(`/api/v1/roles/${roleB}`)).status).toBe(404);
    expect((await interviewerHead(`/api/v1/roles/${roleA}`)).status).toBe(200);
    // taken off the interview's panel, the role is closed to them again
    await mine.remove();
    expect((await json(interviewer, "GET", `/api/v1/roles/${roleA}`)).status).toBe(404);
    expect((await json(interviewer, "GET", `/api/v1/roles/${roleA}/interviews`)).status).toBe(404);
  });

  it("the 'Approve the role' card goes only to people the approve route accepts: not the hiring manager who drafted it, not HR", async () => {
    const manager = await signInAs(container, app, { companyId, role: "hiring_manager" });
    // "Ask for approval" waits for the six essentials (founder decision Q8), so the draft names who decides
    const s = (await (await json(manager, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, $24 to $28 an hour, full time. It's growth. Ceiling $30. I decide. Must-haves: radiography certificate. Just draft it." })).json()) as { session: { id: string } };
    const { roleId } = (await (await json(manager, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
    await container.drain();
    const [pending] = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending")));
    expect(pending).toBeTruthy();
    const cardFor = async (cookie: string) => (await brief(cookie)).find((c) => c.approvalRequestId === pending.id);
    // the person who drafted it cannot approve it (they are not the sole owner), so they get no card to press
    expect(await cardFor(manager)).toBeUndefined();
    expect((await json(manager, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(409);
    // HR holds no role.approve
    expect(await cardFor(hr)).toBeUndefined();
    // the owner gets it, and the route agrees
    expect((await cardFor(owner))?.title).toMatch(/Approve the job/);
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
  });
});

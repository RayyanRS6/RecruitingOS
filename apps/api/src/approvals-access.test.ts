import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { emit, entitlements } from "@ros/core";
import { applications, approvalRequests, candidates, communications, companies, interviewParticipants, interviews, memberships, policies, randomToken, takeovers, users, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { putOnInterview, signInAs, signInStaff } from "./test-helpers";

/**
 * Approvals and who may see or decide them (final review, api area): a decline message held for approval goes out when
 * it is approved, including under a policy saved in Setup with no approver roles; the brief offers a decision only to
 * the people the decide route accepts, in plain words; an interviewer reads neither the requests (candidate names,
 * messages) nor any pay figure; ITS staff under a scoped grant see only the requests and interviews their grant covers.
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
  /** An interview suggestion waiting for a recruiter's yes or no, straight into the table; the id. */
  const askRecruiter = (roleId: string, applicationId: string) =>
    withTenant(container.db, companyId, async (tx) => {
      const [r] = await tx.insert(approvalRequests).values({ companyId, roleId, applicationId, actionType: "application.recommend_interview", subject: { type: "application", id: applicationId }, requestedBy: { kind: "agent", id: "orchestrator" }, requiredRoles: ["recruiter"] }).returning();
      return r.id;
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

  it("the brief's posting card opens the Posting tab, and a decision reserved for the takeover recruiter is not offered to the owner", async () => {
    // the card goes to a company that posts on the boards itself; with ITS posting (the default) the boards are ITS's tasks (plan D3)
    expect((await brief(owner)).some((c) => c.kind === "posting_action" && c.title.includes("post it on"))).toBe(false);
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: { ...co.settings, boardPosting: "self" } }).where(eq(companies.id, companyId));
    const posting = (await brief(owner)).find((c) => c.kind === "posting_action" && c.title.includes("post it on"));
    expect(posting?.actions[0]).toMatchObject({ label: "See instructions", method: "GET", path: `/roles/${roleA}?tab=posting` });
    // during a recruiter takeover every decision message waits for the recruiter; the owner's Approve would be refused, so no card
    const [recruiterUser] = await container.db.insert(users).values({ email: "takeover@its.test", name: "Takeover Recruiter" }).returning();
    const [takeover] = await container.db.insert(takeovers).values({ companyId, roleId: roleA, recruiterUserId: recruiterUser.id, status: "active" }).returning();
    const lou = await seedApplication(roleA, "Lou", "Park");
    expect(await (await decline(lou)).json()).toMatchObject({ dispositionSent: false });
    const req = await pendingFor(lou, "disposition.send");
    expect(req!.requiredRoles).toEqual(["recruiter"]);
    expect((await brief(owner)).some((c) => c.approvalRequestId === req!.id)).toBe(false);
    expect((await json(owner, "POST", `/api/v1/approvals/${req!.id}/decide`, { decision: "approve" })).status).toBe(403);
    await container.db.update(takeovers).set({ status: "ended" }).where(eq(takeovers.id, takeover.id));
  });

  it("an interviewer reads neither the waiting requests nor any pay figure: not the range, the ceiling, the bonus or the sources that quote them", async () => {
    // requests carry names and messages: the list needs application.read, and the role page leaves them out
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

  it("ITS staff under a grant for one role see only that role's requests and interviews; another role's interview is refused", async () => {
    const ada = await seedApplication(roleA, "Ada", "Nguyen");
    const bea = await seedApplication(roleB, "Bea", "Stone");
    const inA = await seedInterview(ada);
    const inB = await seedInterview(bea);
    const recruiter = await signInStaff(app, container, "sam@its.test", "its_recruiter", "Sam Recruiter");
    const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId: roleA, question: "Can you look at our hygienist candidates?" })).json()) as { id: string };
    expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    // the interview of the role in scope opens; the other role's is refused on every route that takes an id
    expect((await json(recruiter, "GET", `/api/v1/interviews/${inA}`)).status).toBe(200);
    const denied = await json(recruiter, "GET", `/api/v1/interviews/${inB}`);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    expect((await json(recruiter, "POST", `/api/v1/interviews/${inB}/cancel`, { reason: "no" })).status).toBe(403);
    expect((await json(recruiter, "POST", `/api/v1/interviews/${inB}/reschedule`, {})).status).toBe(403);
    expect((await container.db.select().from(interviews).where(eq(interviews.id, inB)))[0].status).toBe("scheduling");
    const list = (await (await json(recruiter, "GET", "/api/v1/interviews")).json()) as Array<{ id: string }>;
    expect(list.map((i) => i.id)).toContain(inA);
    expect(list.map((i) => i.id)).not.toContain(inB);
    // the approvals list: role A's waiting decline, not role B's packet approval
    const approvals = (await (await json(recruiter, "GET", "/api/v1/approvals")).json()) as Array<{ roleId: string | null; actionType: string }>;
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals.every((a) => a.roleId === roleA || a.roleId === null)).toBe(true);
    expect((await (await json(owner, "GET", "/api/v1/approvals")).json() as Array<{ roleId: string | null }>).some((a) => a.roleId === roleB)).toBe(true);
    // deciding is held to the grant too: another role's request is refused and stays waiting; the grant's role's is decided
    const asked = await askRecruiter(roleB, bea);
    const refused = await json(recruiter, "POST", `/api/v1/approvals/${asked}/decide`, { decision: "reject", note: "Not this one." });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, asked)))[0].status).toBe("pending");
    const own = await askRecruiter(roleA, ada);
    expect((await json(recruiter, "POST", `/api/v1/approvals/${own}/decide`, { decision: "reject", note: "Not yet." })).status).toBe(200);
    // the role's interviews: the grant's role only
    expect((await json(recruiter, "GET", `/api/v1/roles/${roleB}/interviews`)).status).toBe(403);
    expect(((await (await json(recruiter, "GET", `/api/v1/roles/${roleA}/interviews`)).json()) as Array<{ id: string }>).map((i) => i.id)).toContain(inA);
  });

  it("ITS staff under a grant for one candidate see that candidate alone: the role's interviews, its counts, its report; the screening chat's figures and other candidates' requests are refused", async () => {
    const kim = await seedApplication(roleA, "Kim", "Lowe");
    const leo = await seedApplication(roleA, "Leo", "Marsh");
    const inKim = await seedInterview(kim);
    const inLeo = await seedInterview(leo);
    const leoAsk = await askRecruiter(roleA, leo);
    const kimAsk = await askRecruiter(roleA, kim);
    const rae = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
    const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "candidate_issue", applicationId: kim, question: "Kim asked for a call about the schedule." })).json()) as { id: string };
    expect((await json(rae, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    expect((await json(rae, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    // the role's interviews: Kim's only, never Leo's name, decision or the team's emails
    const ivs = (await (await json(rae, "GET", `/api/v1/roles/${roleA}/interviews`)).json()) as Array<{ id: string; applicationId: string }>;
    expect(ivs.map((i) => i.id)).toContain(inKim);
    expect(ivs.map((i) => i.id)).not.toContain(inLeo);
    expect(ivs.every((i) => i.applicationId === kim)).toBe(true);
    // the role page counts Kim alone
    const detail = (await (await json(rae, "GET", `/api/v1/roles/${roleA}`)).json()) as { counts: Record<string, number> };
    expect(Object.values(detail.counts).reduce((a, b) => a + b, 0)).toBe(1);
    // the report counts Kim alone and names no other application
    const report = (await (await json(rae, "GET", `/api/v1/roles/${roleA}/report`)).json()) as { applicants: { total: number }; stages: { total: number }; pendingDecisions: { list: Array<{ applicationId: string | null }> } };
    expect(report.applicants.total).toBe(1);
    expect(report.stages.total).toBe(1);
    expect(report.pendingDecisions.list.every((p) => p.applicationId === kim || p.applicationId === null)).toBe(true);
    expect(JSON.stringify(report)).not.toContain(leo);
    const ownerReport = (await (await json(owner, "GET", `/api/v1/roles/${roleA}/report`)).json()) as { applicants: { total: number } };
    expect(ownerReport.applicants.total).toBeGreaterThan(1);
    // the screening chat's figures cover the role's whole group
    const funnel = await json(rae, "GET", `/api/v1/roles/${roleA}/screening`);
    expect(funnel.status).toBe(403);
    expect(((await funnel.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    // another candidate's request is not theirs to decide; Kim's is
    expect((await json(rae, "POST", `/api/v1/approvals/${leoAsk}/decide`, { decision: "reject", note: "Not this one." })).status).toBe(403);
    expect((await json(rae, "POST", `/api/v1/approvals/${kimAsk}/decide`, { decision: "reject", note: "Not yet." })).status).toBe(200);

    // A request about the whole role names every applicant: the closing message waiting for approval (services/closing-messages.ts).
    // Not listed for a grant about one candidate, not on the role page, no Home card: the same rule as deciding it.
    const closing = await withTenant(container.db, companyId, async (tx) => {
      const [r] = await tx.insert(approvalRequests).values({ companyId, roleId: roleA, applicationId: null, actionType: "disposition.send", subject: { type: "role", id: roleA }, proposal: { kind: "role_closed", applicationIds: [leo], count: 1 }, requestedBy: { kind: "agent", id: "orchestrator" }, requiredRoles: [] }).returning();
      return r.id;
    });
    const listed = await (await json(rae, "GET", "/api/v1/approvals")).json() as Array<{ id: string }>;
    expect(listed.map((r) => r.id)).not.toContain(closing);
    expect(JSON.stringify(listed)).not.toContain(leo);
    expect(((await (await json(owner, "GET", "/api/v1/approvals")).json()) as Array<{ id: string }>).map((r) => r.id)).toContain(closing);
    const page = (await (await json(rae, "GET", `/api/v1/roles/${roleA}`)).json()) as { pendingApprovals: Array<{ id: string }> };
    expect(page.pendingApprovals.map((p) => p.id)).not.toContain(closing);
    expect(JSON.stringify(page.pendingApprovals)).not.toContain(leo);
    expect(((await (await json(owner, "GET", `/api/v1/roles/${roleA}`)).json()) as { pendingApprovals: Array<{ id: string }> }).pendingApprovals.map((p) => p.id)).toContain(closing);
    expect((await brief(rae)).some((c) => c.approvalRequestId === closing)).toBe(false);
    expect((await json(rae, "POST", `/api/v1/approvals/${closing}/decide`, { decision: "reject", note: "No." })).status).toBe(403);

    // The Activity tab: the role's own events and Kim's, never Leo's application or its note
    await withTenant(container.db, companyId, async (tx) => {
      await emit(tx, { type: "application.received", companyId, actor: { kind: "system", id: "test" }, subject: { type: "application", id: leo }, payload: { roleId: roleA, applicationId: leo, source: "direct", note: "Leo's private note" } });
      await emit(tx, { type: "application.received", companyId, actor: { kind: "system", id: "test" }, subject: { type: "application", id: kim }, payload: { roleId: roleA, applicationId: kim, source: "direct" } });
    });
    const ownerTimeline = JSON.stringify(await (await json(owner, "GET", `/api/v1/roles/${roleA}/timeline`)).json());
    expect(ownerTimeline).toContain(leo);
    const raeTimelineRes = await json(rae, "GET", `/api/v1/roles/${roleA}/timeline`);
    expect(raeTimelineRes.status).toBe(200);
    const raeTimeline = JSON.stringify(await raeTimelineRes.json());
    expect(raeTimeline).toContain(kim);
    expect(raeTimeline).not.toContain(leo);
    expect(raeTimeline).not.toContain("Leo's private note");

    // The Share tab's volume: Kim alone, the switch's state as it is
    const volume = (await (await json(rae, "GET", `/api/v1/roles/${roleA}/volume`)).json()) as { totals: { total: number }; acceptingApplications: boolean };
    const ownerVolume = (await (await json(owner, "GET", `/api/v1/roles/${roleA}/volume`)).json()) as { totals: { total: number }; acceptingApplications: boolean };
    expect(volume.totals.total).toBe(1);
    expect(ownerVolume.totals.total).toBeGreaterThan(1);
    expect(volume.acceptingApplications).toBe(ownerVolume.acceptingApplications);
    await container.db.update(approvalRequests).set({ status: "rejected" }).where(eq(approvalRequests.id, closing));
  });

  it("ITS staff under a grant for one role do not see a request about the whole company, which they could not decide", async () => {
    const companyWide = await withTenant(container.db, companyId, async (tx) => {
      const [r] = await tx.insert(approvalRequests).values({ companyId, roleId: null, applicationId: null, actionType: "disposition.send", subject: { type: "company", id: companyId }, proposal: {}, requestedBy: { kind: "agent", id: "orchestrator" }, requiredRoles: [] }).returning();
      return r.id;
    });
    const tess = await signInStaff(app, container, "tess@its.test", "its_recruiter", "Tess Recruiter");
    const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId: roleA, question: "Another look at the hygienist candidates?" })).json()) as { id: string };
    expect((await json(tess, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    expect((await json(tess, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    const listed = (await (await json(tess, "GET", "/api/v1/approvals")).json()) as Array<{ id: string }>;
    expect(listed.map((r) => r.id)).not.toContain(companyWide);
    expect(((await (await json(owner, "GET", "/api/v1/approvals")).json()) as Array<{ id: string }>).map((r) => r.id)).toContain(companyWide);
    expect((await json(tess, "POST", `/api/v1/approvals/${companyWide}/decide`, { decision: "reject", note: "No." })).status).toBe(403);
    await container.db.update(approvalRequests).set({ status: "rejected" }).where(eq(approvalRequests.id, companyWide));
  });

  it("ITS staff under a grant for all of the company's hiring keep everything: any role's request, interviews, report and screening figures", async () => {
    const cy = await seedApplication(roleB, "Cy", "Dunn");
    await seedInterview(cy);
    const asked = await askRecruiter(roleB, cy);
    const max = await signInStaff(app, container, "max@its.test", "its_recruiter", "Max Recruiter");
    const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "ask", scope: "company", question: "Can you help with all our hiring this month?" })).json()) as { id: string };
    expect((await json(max, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    expect((await json(max, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    expect((await json(max, "GET", "/api/v1/approvals")).status).toBe(200);
    expect((await json(max, "POST", `/api/v1/approvals/${asked}/decide`, { decision: "reject", note: "Not yet." })).status).toBe(200);
    for (const roleId of [roleA, roleB]) {
      const ids = async (cookie: string) => ((await (await json(cookie, "GET", `/api/v1/roles/${roleId}/interviews`)).json()) as Array<{ id: string }>).map((i) => i.id).sort();
      expect(await ids(max)).toEqual(await ids(owner));
      const total = async (cookie: string) => ((await (await json(cookie, "GET", `/api/v1/roles/${roleId}/report`)).json()) as { applicants: { total: number } }).applicants.total;
      expect(await total(max)).toBe(await total(owner));
      expect((await json(max, "GET", `/api/v1/roles/${roleId}/screening`)).status).toBe(200);
      const volumeTotal = async (cookie: string) => ((await (await json(cookie, "GET", `/api/v1/roles/${roleId}/volume`)).json()) as { totals: { total: number } }).totals.total;
      expect(await volumeTotal(max)).toBe(await volumeTotal(owner));
      const timelineLength = async (cookie: string) => ((await (await json(cookie, "GET", `/api/v1/roles/${roleId}/timeline`)).json()) as unknown[]).length;
      expect(await timelineLength(max)).toBe(await timelineLength(owner));
    }
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

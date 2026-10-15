import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { screenTurnPrompt, type ScreenContext } from "@ros/ai";
import type { RolePacket } from "@ros/contracts";
import { approvalRequests, entitlements, events, notifications, policies, rolePackets, roles, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { putOnInterview, signInAs, signInWithIdentity } from "./test-helpers";

/**
 * Role packets over HTTP (docs/spec/21 section 7: B1 to B13, J7, J14): the simple editor's shape saves as a valid
 * version; who may approve (no self-approval unless sole owner, the named decision maker, the wrong role refused);
 * an edit while the role runs waits for approval while the role keeps its version; a rejection or an expiry sends the
 * role back to draft with the note and "request again" starts a new run; an edit while pending cancels the older run;
 * the Interview plan tab's PATCH; the Activity tab's timeline; the brief's decision cards.
 */
describe("role packets: editor, approval rules, sent back, interview plan, timeline", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const json = (cookie: string, method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const me = async (cookie: string) => (await (await json(cookie, "GET", "/api/v1/auth/me")).json()) as { user: { id: string; name: string | null } };
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
  type Detail = {
    id: string; status: string; title: string;
    currentPacket: { version: number; status: string; packet: RolePacket } | null;
    proposedPacket: { version: number; status: string; changeSummary: string | null; packet: RolePacket } | null;
    packetVersions: Array<{ version: number; status: string; changeSummary: string | null }>;
    packetApproval: { pending: { id: string; version: number; editWhileOpen: boolean; requiredUserIds: string[]; decisionMaker: { userId: string; name: string | null } | null; expiresAt: string | null; viewer: { mayDecide: boolean; reason: string | null } } | null; latest: { id: string; status: string; version: number; decisionNote: string | null; decidedBy: { id: string; name: string } | null } | null };
    decisionMaker: { userId: string; name: string | null } | null;
  };
  const detail = async (cookie: string, roleId: string) => (await (await json(cookie, "GET", `/api/v1/roles/${roleId}`)).json()) as Detail;
  const pendingRequest = async (roleId: string) => (await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending"))))[0] ?? null;
  const run = async (id: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];

  // The engine clock: now, plus whatever a step advances (the expiry test moves it two weeks on).
  const BASE = Date.now();
  let clockOffset = 0;
  const setClock = (ms: number) => { clockOffset = ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + clockOffset); };

  let owner = "";
  let ownerId = "";
  let companyId = "";

  /** A drafted role with its pending approval, the way the owner makes one: an intake conversation compiled into a packet. */
  const compileRole = async (cookie: string, message = "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.") => {
    const started = (await (await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const r = await json(cookie, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`);
    expect(r.status).toBe(201);
    const compiled = (await r.json()) as { roleId: string; packet: RolePacket; workflowRunId: string };
    await container.drain();
    return compiled;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signInWithIdentity(app, container, { email: "dana@packet.test", name: "Dana Owner", provider: "google", aal2: false });
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Packet Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    ownerId = (await me(owner)).user.id;
    // the trial plan allows one active role; this file drafts several (and the Wave S5 tests a few more)
    await withTenant(container.db, companyId, (tx) => tx.update(entitlements).set({ limit: 40 }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "active_roles"))));
  });
  afterAll(async () => {
    await container.close();
  });

  it("the simple editor's shape saves as v2 with a valid new must-have and an editable work model; the edit replaces the pending approval and cancels its run", async () => {
    const compiled = await compileRole(owner, "I need a marketing manager in Irvine, $80,000 to $90,000 a year, full time. Hybrid, three days in the office. It's growth. Ceiling $95,000. I decide. Must-haves: ran paid campaigns. Just draft it.");
    expect(compiled.packet.identity.remotePolicy).toBe("hybrid"); // stated in the conversation, so the fake compiler kept it
    expect(compiled.packet.preferences.decisionMakerName).toBe("the owner");
    const before = await pendingRequest(compiled.roleId);
    expect(before?.workflowRunId).toBeTruthy();
    // what the editor posts: the packet with a new must-have row carrying text, why it matters and where it is evidenced, and the work model changed
    const next = structuredClone(compiled.packet);
    next.requirements.mustHaves.push({ key: "mh_9_shopify", text: "Comfortable with Shopify analytics", rationale: "Added by the owner", evidencedBy: ["resume", "screen"] });
    next.identity.remotePolicy = "remote";
    const r = await json(owner, "POST", `/api/v1/roles/${compiled.roleId}/packets`, { packet: next, changeSummary: "Added Shopify; fully remote" });
    expect(r.status).toBe(201);
    const saved = (await r.json()) as { version: number; status: string; outcome: string };
    expect(saved).toMatchObject({ version: 2, status: "proposed", outcome: "proposed_pending_approval" });
    await container.drain();
    // the older approval is cancelled and its run with it; the new version has its own pending request and waiting run
    const [old] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, before!.id));
    expect(old.status).toBe("cancelled");
    expect((await run(before!.workflowRunId!)).status).toBe("cancelled");
    const fresh = await pendingRequest(compiled.roleId);
    expect((fresh!.proposal as { version: number }).version).toBe(2);
    expect((await run(fresh!.workflowRunId!)).status).toBe("waiting");
    const d = await detail(owner, compiled.roleId);
    expect(d.status).toBe("pending_approval");
    expect(d.currentPacket?.version).toBe(2);
    expect(d.currentPacket?.packet.identity.remotePolicy).toBe("remote");
    expect(d.currentPacket?.packet.requirements.mustHaves.find((m) => m.key === "mh_9_shopify")?.evidencedBy).toEqual(["resume", "screen"]);
    expect(d.packetApproval.pending?.version).toBe(2);
    // the screening prompt tells the assistant which must-haves the screen confirms
    const ctx: ScreenContext = { company: { name: "Packet Dental" }, packet: next, candidate: { firstName: "Pat" }, channel: "web", progress: { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 }, answers: {}, transcript: [], focusUnknowns: [], latestCandidateMessage: null };
    const system = screenTurnPrompt.system(ctx).map((b) => b.text).join("\n");
    expect(system).toContain("[mh_9_shopify] Comfortable with Shopify analytics");
  });

  it("the sole owner may approve the role they drafted; once a second owner exists the drafter is refused (409 self_approval) and the other owner approves; an interviewer is refused (403)", async () => {
    const solo = await compileRole(owner);
    const ok = await json(owner, "POST", `/api/v1/roles/${solo.roleId}/approve`, { version: 1, note: "Fine." });
    expect(ok.status).toBe(200);
    await container.drain();
    expect((await detail(owner, solo.roleId)).status).toBe("open");

    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test", name: "Olive Owner" });
    const drafted = await compileRole(owner);
    const view = await detail(owner, drafted.roleId);
    expect(view.packetApproval.pending?.viewer.mayDecide).toBe(false);
    expect(view.packetApproval.pending?.viewer.reason).toMatch(/sole owner/);
    const refused = await json(owner, "POST", `/api/v1/roles/${drafted.roleId}/approve`, { version: 1 });
    expect(refused.status).toBe(409);
    const err = await errorOf(refused);
    expect(err.code).toBe("self_approval");
    expect(err.message).toMatch(/sole owner/);
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "wes@packet.test", name: "Wes Interviewer" });
    expect((await json(interviewer, "POST", `/api/v1/roles/${drafted.roleId}/approve`, { version: 1 })).status).toBe(403);
    expect((await detail(olive, drafted.roleId)).packetApproval.pending?.viewer.mayDecide).toBe(true);
    expect((await json(olive, "POST", `/api/v1/roles/${drafted.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await detail(owner, drafted.roleId)).status).toBe("open");
    // the same rule through the generic decide route
    const again = await compileRole(owner);
    const pend = await pendingRequest(again.roleId);
    const viaDecide = await json(owner, "POST", `/api/v1/approvals/${pend!.id}/decide`, { decision: "approve" });
    expect(viaDecide.status).toBe(409);
    expect((await errorOf(viaDecide)).code).toBe("self_approval");
    expect((await json(olive, "POST", `/api/v1/approvals/${pend!.id}/decide`, { decision: "approve", note: "Go." })).status).toBe(200);
    await container.drain();
    expect((await detail(owner, again.roleId)).status).toBe("open");
    expect((await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, again.roleId), eq(rolePackets.version, 1))))[0].approvedBy).toBe((await me(olive)).user.id);
    // the decide route records the same domain fact as POST /roles/:id/approve, so the Activity tab reads the same either way
    const approvedVia = async (roleId: string) => (await container.db.select().from(events).where(and(eq(events.type, "role.approved"), eq(events.subjectId, roleId))));
    expect((await approvedVia(again.roleId)).map((e) => e.payload)).toEqual([{ version: 1 }]);
    expect((await approvedVia(drafted.roleId)).map((e) => e.payload)).toEqual([{ version: 1 }]);
  });

  it("the person who wrote a version may not approve it: a hiring manager's edit is refused to them on both routes (409 self_approval, 'You wrote this version') and another owner approves it", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test", name: "Olive Owner" });
    const hana = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hana@packet.test", name: "Hana Editor" });
    // the owner starts the role; the hiring manager, who did not start it, writes version 2 while it waits for approval
    const compiled = await compileRole(owner);
    const next = structuredClone(compiled.packet);
    next.requirements.mustHaves.push({ key: "mh_9_dentrix", text: "Uses Dentrix every day", rationale: "Added by the hiring manager", evidencedBy: ["resume", "screen"] });
    const edited = await json(hana, "POST", `/api/v1/roles/${compiled.roleId}/packets`, { packet: next, changeSummary: "Added Dentrix" });
    expect(edited.status).toBe(201);
    expect(await edited.json()).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
    await container.drain();
    const pend = await pendingRequest(compiled.roleId);
    expect((pend!.proposal as { version: number }).version).toBe(2);
    // she holds role.approve and is in the request's approver roles, so only the authorship rule stands in her way
    expect(pend!.requiredRoles).toContain("hiring_manager");
    const view = (await detail(hana, compiled.roleId)).packetApproval.pending;
    expect(view?.viewer.mayDecide).toBe(false);
    expect(view?.viewer.reason).toMatch(/You wrote this version/);
    const refused = await json(hana, "POST", `/api/v1/roles/${compiled.roleId}/approve`, { version: 2 });
    expect(refused.status).toBe(409);
    const err = await errorOf(refused);
    expect(err.code).toBe("self_approval");
    expect(err.message).toMatch(/You wrote this version/);
    const viaDecide = await json(hana, "POST", `/api/v1/approvals/${pend!.id}/decide`, { decision: "approve" });
    expect(viaDecide.status).toBe(409);
    expect((await errorOf(viaDecide)).message).toMatch(/You wrote this version/);
    expect((await pendingRequest(compiled.roleId))?.id).toBe(pend!.id);
    // another owner, who neither started the role nor wrote the version, approves it
    expect((await detail(olive, compiled.roleId)).packetApproval.pending?.viewer.mayDecide).toBe(true);
    expect((await json(olive, "POST", `/api/v1/approvals/${pend!.id}/decide`, { decision: "approve" })).status).toBe(200);
    await container.drain();
    const opened = await detail(owner, compiled.roleId);
    expect(opened.status).toBe("open");
    expect(opened.currentPacket?.version).toBe(2);
    expect((await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, compiled.roleId), eq(rolePackets.version, 2))))[0].approvedBy).toBe((await me(olive)).user.id);
  });

  it("a named decision maker who is on the team is required: a hiring manager who is not named is refused (approving and sending back), the named one approves, an owner may decide too; a several-word name that is nobody on the team reserves nothing", async () => {
    const hank = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@packet.test", name: "Hank Manager" });
    const priya = await signInAs(container, app, { companyId, role: "hiring_manager", email: "priya@packet.test", name: "Priya Nair" });
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test", name: "Olive Owner" });
    const hankId = (await me(hank)).user.id;
    const reserved = (decider: string) => `I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. Interviewers: Hank Manager and me. ${decider} makes the final decision. Must-haves: active CA RDH license. Just draft it.`;
    const named = await compileRole(owner, reserved("Hank Manager"));
    expect(named.packet.preferences.decisionMakerName).toBe("Hank Manager");
    const req = await pendingRequest(named.roleId);
    expect((req!.proposal as { requiredUserIds?: string[] }).requiredUserIds).toEqual([hankId]);
    const d = await detail(owner, named.roleId);
    expect(d.decisionMaker?.userId).toBe(hankId);
    expect(d.packetApproval.pending?.decisionMaker?.name).toBe("Hank Manager");
    // the named person was told, personally
    const told = await container.db.select().from(notifications).where(and(eq(notifications.kind, "approval.requested"), eq(notifications.userId, hankId)));
    expect(told.length).toBeGreaterThanOrEqual(1);
    const wrong = await json(priya, "POST", `/api/v1/roles/${named.roleId}/approve`, { version: 1 });
    expect(wrong.status).toBe(403);
    expect((await errorOf(wrong)).code).toBe("named_decider");
    expect((await detail(priya, named.roleId)).packetApproval.pending?.viewer).toMatchObject({ mayDecide: false });
    // sending back is reserved the same way: the hiring manager who is not named cannot do it through the generic decide route either
    const wrongReject = await json(priya, "POST", `/api/v1/approvals/${req!.id}/decide`, { decision: "reject", note: "No" });
    expect(wrongReject.status).toBe(403);
    expect((await errorOf(wrongReject)).code).toBe("named_decider");
    expect((await pendingRequest(named.roleId))?.id).toBe(req!.id);
    // an owner who is not named may decide (the override), and is not the drafter, so nothing else stands in her way
    expect((await detail(olive, named.roleId)).packetApproval.pending?.viewer).toMatchObject({ mayDecide: true, reason: null });
    expect((await json(hank, "POST", `/api/v1/roles/${named.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    const opened = await detail(owner, named.roleId);
    expect(opened.status).toBe("open");
    expect(opened.packetApproval.latest).toMatchObject({ status: "approved", decidedBy: { id: hankId } });
    // the owner override on the send-back side: a second reserved role, sent back by the owner who is not named
    const reservedAgain = await compileRole(owner, reserved("Hank Manager"));
    const req2 = await pendingRequest(reservedAgain.roleId);
    expect((req2!.proposal as { requiredUserIds?: string[] }).requiredUserIds).toEqual([hankId]);
    expect((await json(olive, "POST", `/api/v1/approvals/${req2!.id}/decide`, { decision: "reject", note: "Hold on" })).status).toBe(200);
    await container.drain();
    expect((await detail(owner, reservedAgain.roleId)).status).toBe("draft");
    expect((await detail(owner, reservedAgain.roleId)).packetApproval.latest).toMatchObject({ status: "rejected", decisionNote: "Hold on" });
    // "Hank Blake" is not the team's Hank Manager: a several-word name that matches nobody in full reserves nothing, and any approver decides
    const stranger = await compileRole(owner, reserved("Hank Blake"));
    expect(stranger.packet.preferences.decisionMakerName).toBe("Hank Blake");
    const req3 = await pendingRequest(stranger.roleId);
    expect((req3!.proposal as { requiredUserIds?: string[] }).requiredUserIds).toBeUndefined();
    expect((await detail(owner, stranger.roleId)).decisionMaker).toBeNull();
    expect((await detail(priya, stranger.roleId)).packetApproval.pending?.viewer).toMatchObject({ mayDecide: true });
    // a single first name that fits exactly one approver still reserves the decision for them
    const firstName = await compileRole(owner, reserved("Hank"));
    expect(((await pendingRequest(firstName.roleId))!.proposal as { requiredUserIds?: string[] }).requiredUserIds).toEqual([hankId]);
  });

  it("a rejection sends the role back to draft with the note; editing keeps it a draft; 'request approval again' starts a new run; a further edit while pending cancels that run", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const sent = await compileRole(owner);
    const first = await pendingRequest(sent.roleId);
    const rejected = await json(olive, "POST", `/api/v1/approvals/${first!.id}/decide`, { decision: "reject", note: "Raise the ceiling first" });
    expect(rejected.status).toBe(200);
    await container.drain();
    let d = await detail(owner, sent.roleId);
    expect(d.status).toBe("draft");
    expect(d.packetApproval.pending).toBeNull();
    expect(d.packetApproval.latest).toMatchObject({ status: "rejected", version: 1, decisionNote: "Raise the ceiling first", decidedBy: { name: "Olive Owner" } });
    expect((await run(first!.workflowRunId!)).status).toBe("completed");
    const sentBack = await container.db.select().from(notifications).where(and(eq(notifications.kind, "role.sent_back"), eq(notifications.userId, ownerId)));
    expect(sentBack.at(-1)?.body).toContain("Raise the ceiling first");
    // an edit on the sent-back role is a new version with the draft; nothing is requested yet
    const next = structuredClone(sent.packet);
    next.compensation.ceiling = 60;
    const edited = await json(owner, "POST", `/api/v1/roles/${sent.roleId}/packets`, { packet: next, changeSummary: "Raised the ceiling" });
    expect(edited.status).toBe(201);
    expect(((await edited.json()) as { outcome: string }).outcome).toBe("proposed");
    expect(await pendingRequest(sent.roleId)).toBeNull();
    expect((await detail(owner, sent.roleId)).status).toBe("draft");
    // request again: a new request for v2 and a new waiting run
    const asked = await json(owner, "POST", `/api/v1/roles/${sent.roleId}/request-approval`, {});
    expect(asked.status).toBe(201);
    const body = (await asked.json()) as { version: number; workflowRunId: string };
    expect(body.version).toBe(2);
    expect(body.workflowRunId).not.toBe(first!.workflowRunId);
    await container.drain();
    d = await detail(owner, sent.roleId);
    expect(d.status).toBe("pending_approval");
    expect(d.packetApproval.pending?.version).toBe(2);
    const second = await pendingRequest(sent.roleId);
    expect(second!.workflowRunId).toBe(body.workflowRunId);
    expect((await run(body.workflowRunId)).status).toBe("waiting");
    expect((await json(owner, "POST", `/api/v1/roles/${sent.roleId}/request-approval`, {})).status).toBe(409); // already waiting
    // editing while pending: the older request is cancelled and its run marked cancelled before the new run starts
    const third = structuredClone(next);
    third.compensation.ceiling = 62;
    expect((await json(owner, "POST", `/api/v1/roles/${sent.roleId}/packets`, { packet: third, changeSummary: "Ceiling 62" })).status).toBe(201);
    await container.drain();
    expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, second!.id)))[0].status).toBe("cancelled");
    expect((await run(body.workflowRunId)).status).toBe("cancelled");
    const latest = await pendingRequest(sent.roleId);
    expect((latest!.proposal as { version: number }).version).toBe(3);
    expect((await run(latest!.workflowRunId!)).status).toBe("waiting");
  });

  it("an approval nobody decides expires after 14 days: the request is expired, the role is a draft again and the note says why", async () => {
    const waiting = await compileRole(owner);
    const req = await pendingRequest(waiting.roleId);
    expect(req!.expiresAt).toBeTruthy();
    setClock(clockOffset + 15 * 86_400_000);
    await container.drain();
    const [expired] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, req!.id));
    expect(expired.status).toBe("expired");
    const d = await detail(owner, waiting.roleId);
    expect(d.status).toBe("draft");
    expect(d.packetApproval.latest).toMatchObject({ status: "expired" });
    expect(d.packetApproval.latest?.decisionNote).toMatch(/14 days/);
    expect((await run(req!.workflowRunId!)).status).toBe("completed");
    // and it can be sent again
    expect((await json(owner, "POST", `/api/v1/roles/${waiting.roleId}/request-approval`, {})).status).toBe(201);
    await container.drain();
    expect((await detail(owner, waiting.roleId)).status).toBe("pending_approval");
  });

  it("an engine retry (a timer wake before the deadline) leaves a pending approval pending: only the clock expires it", async () => {
    const waiting = await compileRole(owner);
    const req = await pendingRequest(waiting.roleId);
    const runId = req!.workflowRunId!;
    expect((await run(runId)).status).toBe("waiting");
    // on_decision fails once, the way a dropped connection would: the engine parks the run on its retry timer and wakes it with a timer wake
    type Steps = { steps: Record<string, (ctx: unknown) => Promise<unknown>> };
    const def = (container.engine as unknown as { defs: Map<string, Steps> }).defs.get("role_approval")!;
    const original = def.steps.on_decision;
    let calls = 0;
    def.steps.on_decision = async (ctx) => {
      if (calls++ === 0) throw new Error("connection reset");
      return original(ctx);
    };
    try {
      await container.engine.tick(runId, { kind: "manual" });
      const parked = await run(runId);
      expect(parked.status).toBe("waiting");
      expect(parked.wait?.kind).toBe("timer");
      expect(parked.attempts).toBe(1);
      setClock(clockOffset + 60_000); // the retry is due a few seconds later
      await container.drain();
    } finally {
      def.steps.on_decision = original;
    }
    expect(calls).toBe(2);
    expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, req!.id)))[0].status).toBe("pending");
    const resumed = await run(runId);
    expect(resumed.status).toBe("waiting");
    expect(resumed.wait?.kind).toBe("human");
    expect((await detail(owner, waiting.roleId)).status).toBe("pending_approval");
  });

  it("an edit cancels a role_approval run that has not reached its gate yet (there is no request row to find it by), so only the new version asks for approval", async () => {
    const compiled = await compileRole(owner);
    const first = await pendingRequest(compiled.roleId);
    // a run for v1 that no worker has ticked yet: the shape of a compile whose run is still queued when the edit lands
    const { runId: early } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "role_approval", companyId, subject: { type: "role", id: compiled.roleId }, state: { roleId: compiled.roleId, packetVersion: 1 }, idempotencyKey: `role_approval:${compiled.roleId}:1:early`, actor: { kind: "user", id: ownerId, name: "Dana Owner" } }));
    expect((await run(early)).status).toBe("running");
    const next = structuredClone(compiled.packet);
    next.compensation.ceiling = 59;
    expect((await json(owner, "POST", `/api/v1/roles/${compiled.roleId}/packets`, { packet: next, changeSummary: "Ceiling 59" })).status).toBe(201);
    await container.drain();
    expect((await run(early)).status).toBe("cancelled");
    expect((await run(first!.workflowRunId!)).status).toBe("cancelled");
    const stillPending = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, compiled.roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending")));
    expect(stillPending.map((p) => (p.proposal as { version: number }).version)).toEqual([2]);
    expect((await run(stillPending[0].workflowRunId!)).status).toBe("waiting");
  });

  it("an edit to an open role by someone who may edit but not approve waits for approval while the role keeps v1; the brief names the version; approving swaps it in, a rejection retires it", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const opened = await compileRole(owner);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    // hr may not edit packets at all; a recruiter member may edit but not approve
    const hr = await signInAs(container, app, { companyId, role: "hr", email: "hr@packet.test", name: "Hope HR" });
    const rec = await signInAs(container, app, { companyId, role: "recruiter", email: "rae@packet.test", name: "Rae Recruiter" });
    const next = structuredClone(opened.packet);
    next.description.publicJobDescription = `${opened.packet.description.publicJobDescription} We also offer a sign-on bonus.`;
    expect((await json(hr, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: next, changeSummary: "Bonus" })).status).toBe(403);
    const r = await json(rec, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: next, changeSummary: "Mentioned the sign-on bonus" });
    expect(r.status).toBe(201);
    expect((await r.json()) as object).toMatchObject({ version: 2, status: "proposed", outcome: "proposed_pending_approval" });
    await container.drain();
    let d = await detail(olive, opened.roleId);
    expect(d.status).toBe("open");
    expect(d.currentPacket?.version).toBe(1);
    expect(d.proposedPacket?.version).toBe(2);
    expect(d.packetApproval.pending).toMatchObject({ version: 2, editWhileOpen: true, viewer: { mayDecide: true } });
    const brief = (await (await json(olive, "GET", "/api/v1/brief")).json()) as { cards: Array<{ title: string; actions: Array<{ method: string; path: string }> }> };
    const card = brief.cards.find((c) => c.title.startsWith("Approve version 2 of"));
    expect(card).toBeTruthy();
    expect(card!.actions[0]).toMatchObject({ method: "GET", path: `/roles/${opened.roleId}` });
    // approving the edit makes it current without touching the role's status
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 2 })).status).toBe(200);
    await container.drain();
    d = await detail(olive, opened.roleId);
    expect(d.status).toBe("open");
    expect(d.currentPacket?.version).toBe(2);
    expect(d.proposedPacket).toBeNull();
    expect(d.packetVersions.find((v) => v.version === 1)?.status).toBe("superseded");
    // a second proposed edit, sent back: the role stays on v2 and v3 is retired
    const third = structuredClone(next);
    third.compensation.max = next.compensation.max + 1;
    expect((await json(rec, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: third, changeSummary: "Max up by one" })).status).toBe(201);
    await container.drain();
    const pend = await pendingRequest(opened.roleId);
    expect((await json(olive, "POST", `/api/v1/approvals/${pend!.id}/decide`, { decision: "reject", note: "Not now" })).status).toBe(200);
    await container.drain();
    d = await detail(olive, opened.roleId);
    expect(d.status).toBe("open");
    expect(d.currentPacket?.version).toBe(2);
    expect(d.packetVersions.find((v) => v.version === 3)?.status).toBe("superseded");
    expect(d.packetApproval.latest).toMatchObject({ status: "rejected", version: 3, decisionNote: "Not now" });
    // an approver's own change to the pay of a live job needs the same approval as a new role (founder decision Q10 = B):
    // olive is not the only owner, so another approver decides, and the job keeps running on v2 meanwhile
    const fourth = structuredClone(next);
    fourth.compensation.ceiling = next.compensation.ceiling + 1;
    const own = await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: fourth, changeSummary: "Ceiling up by one" });
    expect(((await own.json()) as { outcome: string; version: number; needsApproval: unknown })).toMatchObject({ outcome: "proposed_pending_approval", version: 4, needsApproval: { changes: ["pay"], youMayConfirm: false } });
    await container.drain();
    expect((await detail(olive, opened.roleId)).currentPacket?.version).toBe(2);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 4 })).status).toBe(409); // she wrote it
    // a wording change by an approver is current at once (after the preview the page shows first)
    const fifth = structuredClone(next);
    fifth.description.publicJobDescription = `${next.description.publicJobDescription} Free parking on site.`;
    const wording = await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: fifth, changeSummary: "Parking" });
    expect(((await wording.json()) as { outcome: string; version: number; needsApproval: unknown })).toMatchObject({ outcome: "approved_current", version: 5, needsApproval: null });
    expect((await detail(olive, opened.roleId)).currentPacket?.version).toBe(5);
  });

  it("the Interview plan tab: rounds with interviewers by name and readiness; PATCH assigns people per round as a version 'Interviewers assigned'", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const hank = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@packet.test" });
    const hankId = (await me(hank)).user.id;
    const priyaId = (await me(await signInAs(container, app, { companyId, role: "hiring_manager", email: "priya@packet.test" }))).user.id;
    const opened = await compileRole(owner);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    type Plan = { version: number; rounds: Array<{ key: string; title: string; interviewers: Array<{ userId: string; name: string; schedulable: boolean }> }>; team: Array<{ userId: string; name: string; schedulable: boolean }>; outcome?: string };
    const before = (await (await json(olive, "GET", `/api/v1/roles/${opened.roleId}/interview-plan`)).json()) as Plan;
    expect(before.version).toBe(1);
    expect(before.rounds.length).toBeGreaterThanOrEqual(1);
    expect(before.rounds[0].interviewers).toEqual([]);
    expect(before.team.map((m) => m.name)).toEqual(expect.arrayContaining(["Hank Manager", "Priya Nair", "Dana Owner"]));
    const key = before.rounds[0].key;
    expect((await errorOf(await json(olive, "PATCH", `/api/v1/roles/${opened.roleId}/interview-plan`, { rounds: [{ key: "no_such_round", interviewerUserIds: [hankId] }] }))).code).toBe("unknown_round");
    expect((await errorOf(await json(olive, "PATCH", `/api/v1/roles/${opened.roleId}/interview-plan`, { rounds: [{ key, interviewerUserIds: ["00000000-0000-0000-0000-000000000000"] }] }))).code).toBe("unknown_member");
    const r = await json(olive, "PATCH", `/api/v1/roles/${opened.roleId}/interview-plan`, { rounds: [{ key, interviewerUserIds: [hankId, priyaId] }] });
    expect(r.status).toBe(200);
    const after = (await r.json()) as Plan;
    expect(after).toMatchObject({ version: 2, outcome: "approved_current" });
    expect(after.rounds[0].interviewers.map((i) => i.name)).toEqual(["Hank Manager", "Priya Nair"]);
    expect(after.rounds[0].interviewers.every((i) => i.schedulable === false)).toBe(true); // no calendar or hours declared yet
    const d = await detail(olive, opened.roleId);
    expect(d.currentPacket?.version).toBe(2);
    expect(d.currentPacket?.packet.interviews.plan[0].interviewerUserIds).toEqual([hankId, priyaId]);
    expect(d.packetVersions[0]).toMatchObject({ version: 2, changeSummary: "Interviewers assigned", status: "approved" });
    expect(((await (await json(olive, "GET", `/api/v1/roles/${opened.roleId}/interview-plan`)).json()) as Plan).rounds[0].interviewers.map((i) => i.userId)).toEqual([hankId, priyaId]);
  });

  it("the Activity tab: the role's timeline, newest first, only this role's events; needs events.read", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const one = await compileRole(owner);
    const other = await compileRole(owner);
    expect((await json(olive, "POST", `/api/v1/roles/${one.roleId}/approve`, { version: 1, note: "Yes" })).status).toBe(200);
    await container.drain();
    type Row = { type: string; occurredAt: string; subjectType: string; subjectId: string; payload: Record<string, unknown>; actor: { kind: string; name?: string } };
    const rows = (await (await json(olive, "GET", `/api/v1/roles/${one.roleId}/timeline`)).json()) as Row[];
    const types = rows.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["role.created", "role_packet.proposed", "approval.requested", "approval.granted", "role.approved", "role_packet.approved", "role.opened"]));
    for (let i = 1; i < rows.length; i++) expect(rows[i - 1].occurredAt >= rows[i].occurredAt).toBe(true);
    for (const r of rows) {
      const about = (r.subjectType === "role" && r.subjectId === one.roleId) || (r.subjectType === "role_packet" && r.subjectId.startsWith(`${one.roleId}:`)) || r.payload.roleId === one.roleId;
      expect(about, `${r.type} is not about this role`).toBe(true);
      expect(r.subjectId).not.toBe(other.roleId);
    }
    expect(rows.find((r) => r.type === "approval.granted")?.payload).toMatchObject({ roleId: one.roleId, note: "Yes" });
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "wes@packet.test" });
    // a role they do not interview for answers as one that does not exist; on one they do, the timeline needs events.read
    expect((await json(interviewer, "GET", `/api/v1/roles/${one.roleId}/timeline`)).status).toBe(404);
    await putOnInterview(container, app, { cookie: interviewer, roleId: one.roleId });
    expect((await json(interviewer, "GET", `/api/v1/roles/${one.roleId}/timeline`)).status).toBe(403);
    expect((await json(olive, "GET", "/api/v1/roles/00000000-0000-0000-0000-000000000000/timeline")).status).toBe(404);
  });

  it("an edit saved while the job is paused is never dropped: an approver's wording is current at once, anyone else's waits for approval, a version kept earlier asks for approval on resume, and resuming publishes what is current (row 12)", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const rec = await signInAs(container, app, { companyId, role: "recruiter", email: "rae@packet.test", name: "Rae Recruiter" });
    const opened = await compileRole(owner);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/pause`, {})).status).toBe(200);
    // an approver's wording change during the pause is current at once, and the job stays paused
    const wording = structuredClone(opened.packet);
    wording.description.publicJobDescription = `${opened.packet.description.publicJobDescription} Free parking on site.`;
    expect(await (await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: wording, changeSummary: "Parking" })).json()).toMatchObject({ version: 2, outcome: "approved_current", paused: true });
    let d = await detail(olive, opened.roleId);
    expect(d).toMatchObject({ status: "paused", currentPacket: { version: 2 } });
    // someone who may not approve: the edit waits for an approver, as on a live job, and approving it keeps the job paused
    const theirs = structuredClone(wording);
    theirs.description.publicJobDescription = `${wording.description.publicJobDescription} Uniforms provided.`;
    expect(await (await json(rec, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: theirs, changeSummary: "Uniforms" })).json()).toMatchObject({ version: 3, outcome: "proposed_pending_approval" });
    await container.drain();
    d = await detail(olive, opened.roleId);
    expect(d.packetApproval.pending).toMatchObject({ version: 3, editWhileOpen: true });
    expect(d.proposedPacket?.version).toBe(3);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 3 })).status).toBe(200);
    await container.drain();
    d = await detail(olive, opened.roleId);
    expect(d).toMatchObject({ status: "paused", currentPacket: { version: 3 } });
    // a version kept during a pause before this fix (proposed, nobody asked): resuming asks for its approval
    const [v3] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, opened.roleId), eq(rolePackets.version, 3)));
    const stranded = structuredClone(v3.packet);
    stranded.description.publicJobDescription = `${theirs.description.publicJobDescription} Paid lunch.`;
    await withTenant(container.db, companyId, (tx) => tx.insert(rolePackets).values({ companyId, roleId: opened.roleId, version: 4, packet: stranded, status: "proposed", source: "human_edit", changeSummary: "Paid lunch", createdBy: { kind: "user", id: (v3.createdBy as { id: string }).id, name: "Rae Recruiter" } }));
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/resume`, {})).status).toBe(200);
    await container.drain();
    d = await detail(olive, opened.roleId);
    expect(d).toMatchObject({ status: "open", currentPacket: { version: 3 } });
    expect(d.packetApproval.pending).toMatchObject({ version: 4, editWhileOpen: true });
    // the publish run the resume started carries the version that is current, not the one the job had when it paused
    const publishes = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "publish_role"))).filter((r) => (r.subject as { id: string }).id === opened.roleId).sort((a, b) => a.id.localeCompare(b.id)); // ids are time-ordered
    const lastPublish = publishes.at(-1);
    expect(lastPublish).toBeDefined();
    expect((lastPublish?.state as { packetVersion?: number } | undefined)?.packetVersion).toBe(3);
  });

  it("a closed job refuses a new version on every route, in plain words (row 64)", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const opened = await compileRole(owner);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/outcome`, { outcome: "no_hire", confirm: true })).status).toBe(200);
    const next = structuredClone(opened.packet);
    next.compensation.ceiling = 61;
    const saved = await json(owner, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: next, changeSummary: "Ceiling" });
    expect(saved.status).toBe(409);
    expect(await errorOf(saved)).toMatchObject({ code: "role_closed", message: expect.stringMatching(/closed, so it is not changed any more/) });
    const plan = (await (await json(olive, "GET", `/api/v1/roles/${opened.roleId}/interview-plan`)).json()) as { rounds: Array<{ key: string }> };
    const patched = await json(olive, "PATCH", `/api/v1/roles/${opened.roleId}/interview-plan`, { rounds: [{ key: plan.rounds[0].key, interviewerUserIds: [ownerId] }] });
    expect(patched.status).toBe(409);
    expect((await errorOf(patched)).code).toBe("role_closed");
    expect((await container.db.select().from(rolePackets).where(eq(rolePackets.roleId, opened.roleId))).map((p) => p.version)).toEqual([1]);
  });

  it("L-01: flagged wording an approver keeps on a live job waits for a second approver; whoever kept it may not approve it; the named decision maker is told of wording-only edits that went live", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const rec = await signInAs(container, app, { companyId, role: "recruiter", email: "rae@packet.test", name: "Rae Recruiter" });
    const hank = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hank@packet.test", name: "Hank Manager" });
    const hankId = (await me(hank)).user.id;
    const opened = await compileRole(owner, "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. Hank Manager makes the final decision. Must-haves: active CA RDH license. Just draft it.");
    expect((await json(hank, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    // the named decision maker is told (not asked) when someone else's wording-only edit goes live
    const wording = structuredClone(opened.packet);
    wording.description.publicJobDescription = `${opened.packet.description.publicJobDescription} Free parking on site.`;
    expect(await (await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: wording, changeSummary: "Parking" })).json()).toMatchObject({ version: 2, outcome: "approved_current" });
    const told = await container.db.select().from(notifications).where(and(eq(notifications.kind, "role.edited_live"), eq(notifications.userId, hankId)));
    expect(told.at(-1)?.body).toMatch(/Olive Owner changed the wording of the job: Parking\. It is live now\..*nothing waits for you/);
    // an owner adds flagged wording, then keeps it with a reason: it waits for someone else, though she may approve
    const flagged = structuredClone(wording);
    flagged.requirements.mustHaves.push({ key: "english", text: "Native English speaker", rationale: "Patients", evidencedBy: ["screen"] });
    const v3 = (await (await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: flagged, changeSummary: "Added English" })).json()) as { version: number; outcome: string; packet: RolePacket };
    expect(v3).toMatchObject({ version: 3, outcome: "proposed_pending_approval" });
    const flag = v3.packet.provenance.flags!.find((f) => !f.kept)!;
    const keep = structuredClone(v3.packet);
    keep.provenance.flags = keep.provenance.flags!.map((f) => (f.id === flag.id ? { ...f, keepReason: "Our patients need clear spoken English; we test the level, not where anyone is from." } : f));
    const v4 = await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: keep, changeSummary: "Kept the English line" });
    expect(await v4.json()).toMatchObject({ version: 4, outcome: "proposed_pending_approval", needsApproval: { changes: [], youMayConfirm: false, words: expect.stringMatching(/another approver says yes/) } });
    await container.drain();
    expect((await detail(owner, opened.roleId)).currentPacket?.version).toBe(2);
    const refused = await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 4 });
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).code).toBe("self_approval");
    // the named decision maker approves it: two people said yes
    expect((await json(hank, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 4 })).status).toBe(200);
    await container.drain();
    expect((await detail(owner, opened.roleId)).currentPacket?.version).toBe(4);
    // a flag kept on the approval card by someone who did not write the version: they may not approve it either
    const gaps = structuredClone(keep);
    gaps.description.publicJobDescription = `${keep.description.publicJobDescription} No employment gaps.`;
    const v5 = (await (await json(rec, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: gaps, changeSummary: "Gaps line" })).json()) as { version: number; packet: RolePacket };
    expect(v5.version).toBe(5);
    await container.drain();
    const gapFlag = v5.packet.provenance.flags!.find((f) => !f.kept && f.rule === "employment_gaps")!;
    expect(gapFlag).toBeTruthy();
    expect((await json(hank, "POST", `/api/v1/roles/${opened.roleId}/packets/5/flags/keep`, { flagId: gapFlag.id, reason: "We only mean recent hands-on practice, nothing else." })).status).toBe(200);
    const view = (await detail(hank, opened.roleId)).packetApproval.pending;
    expect(view?.viewer).toMatchObject({ mayDecide: false, reason: expect.stringMatching(/You kept wording the fairness check flagged/) });
    const hankRefused = await json(hank, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 5 });
    expect(hankRefused.status).toBe(409);
    expect((await errorOf(hankRefused)).message).toMatch(/You kept wording the fairness check flagged/);
    // an owner who kept nothing here decides
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 5 })).status).toBe(200);
    await container.drain();
    expect((await detail(owner, opened.roleId)).currentPacket?.version).toBe(5);
  });

  it("L-01: kept flagged wording never goes live by saving again with a small change; the live version is what counts (Wave S5 review)", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const opened = await compileRole(owner);
    expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    const flagged = structuredClone(opened.packet);
    flagged.description.publicJobDescription = `${opened.packet.description.publicJobDescription} No employment gaps.`;
    const v2 = (await (await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: flagged, changeSummary: "Gaps line" })).json()) as { version: number; outcome: string; packet: RolePacket };
    expect(v2).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
    const keep = structuredClone(v2.packet);
    keep.provenance.flags = keep.provenance.flags!.map((f) => (f.kept ? f : { ...f, keepReason: "We only mean recent hands-on practice, nothing else." }));
    const v3 = (await (await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: keep, changeSummary: "Kept the gaps line" })).json()) as { version: number; outcome: string; packet: RolePacket };
    expect(v3).toMatchObject({ version: 3, outcome: "proposed_pending_approval" });
    expect(v3.packet.provenance.flags!.some((f) => f.kept)).toBe(true);
    // saved again with an unrelated change: the kept flag is still new against the live version, so it still waits
    const tweak = structuredClone(v3.packet);
    tweak.description.publicJobDescription = `${tweak.description.publicJobDescription} Free parking on site.`;
    const v4 = await (await json(olive, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: tweak, changeSummary: "Parking" })).json();
    expect(v4).toMatchObject({ version: 4, outcome: "proposed_pending_approval", needsApproval: { youMayConfirm: false, words: expect.stringMatching(/another approver says yes/) } });
    await container.drain();
    expect((await detail(owner, opened.roleId)).currentPacket?.version).toBe(1);
  });

  it("L-01: when nobody but the keeper could decide (two owners: one started the job, the other kept the flag), the keeper decides, so the version is never stuck (Wave S5 review)", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const hana = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hana@packet.test", name: "Hana Editor" });
    // only the two owners approve jobs here (a narrowed approver list)
    const [rule] = await withTenant(container.db, companyId, (tx) => tx.insert(policies).values({ companyId, roleId: null, actionType: "role_packet.approve", level: "approval", approverRoles: ["owner"], createdBy: { kind: "user", id: ownerId } }).returning());
    try {
      // Olive starts the job; the other owner approves it
      const opened = await compileRole(olive);
      expect((await json(owner, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      // Hana writes flagged wording; the other owner keeps it on the approval card
      const gaps = structuredClone(opened.packet);
      gaps.description.publicJobDescription = `${opened.packet.description.publicJobDescription} No employment gaps.`;
      const v2 = (await (await json(hana, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: gaps, changeSummary: "Gaps line" })).json()) as { version: number; outcome: string; packet: RolePacket };
      expect(v2).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
      await container.drain();
      const flag = v2.packet.provenance.flags!.find((f) => !f.kept && f.rule === "employment_gaps")!;
      expect((await json(owner, "POST", `/api/v1/roles/${opened.roleId}/packets/2/flags/keep`, { flagId: flag.id, reason: "We only mean recent hands-on practice, nothing else." })).status).toBe(200);
      // Olive started the job and Hana wrote the version: neither may approve it, so the keeper is the one who decides
      expect((await detail(owner, opened.roleId)).packetApproval.pending?.viewer).toMatchObject({ mayDecide: true, reason: null });
      expect((await json(owner, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 2 })).status).toBe(200);
      await container.drain();
      expect((await detail(owner, opened.roleId)).currentPacket?.version).toBe(2);
    } finally {
      await withTenant(container.db, companyId, (tx) => tx.delete(policies).where(eq(policies.id, rule.id)));
    }
  });

  it("a narrowed approver list: the approval notice names only who may decide, and a hiring manager's wording edit to a live job waits for one of them (rows 59, 67)", async () => {
    const olive = await signInAs(container, app, { companyId, role: "owner", email: "olive@packet.test" });
    const hana = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hana@packet.test", name: "Hana Editor" });
    const [rule] = await withTenant(container.db, companyId, (tx) => tx.insert(policies).values({ companyId, roleId: null, actionType: "role_packet.approve", level: "approval", approverRoles: ["owner", "admin"], createdBy: { kind: "user", id: ownerId } }).returning());
    try {
      const opened = await compileRole(owner);
      const req = await pendingRequest(opened.roleId);
      expect(req!.requiredRoles).toEqual(["owner", "admin"]);
      const notices = await container.db.select().from(notifications).where(and(eq(notifications.kind, "approval.requested"), eq(notifications.userId, ownerId)));
      expect(notices.at(-1)?.body).toContain("Any owner or admin can decide.");
      expect(notices.at(-1)?.body).not.toContain("hiring manager");
      expect((await json(olive, "POST", `/api/v1/roles/${opened.roleId}/approve`, { version: 1 })).status).toBe(200);
      await container.drain();
      const wording = structuredClone(opened.packet);
      wording.description.publicJobDescription = `${opened.packet.description.publicJobDescription} Free parking on site.`;
      expect(await (await json(hana, "POST", `/api/v1/roles/${opened.roleId}/packets`, { packet: wording, changeSummary: "Parking" })).json()).toMatchObject({ version: 2, outcome: "proposed_pending_approval" });
      expect((await detail(owner, opened.roleId)).currentPacket?.version).toBe(1);
    } finally {
      await withTenant(container.db, companyId, (tx) => tx.delete(policies).where(eq(policies.id, rule.id)));
    }
  });

  it("the job builder's closing date is saved with the draft and lands on the role when it asks for approval (row 61)", async () => {
    const res = await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." });
    const started = (await res.json()) as { session: { id: string } };
    expect(started.session, JSON.stringify(started)).toBeTruthy();
    const path = `/api/v1/intake/sessions/${started.session.id}/closing-date`;
    expect(await (await json(owner, "GET", path)).json()).toEqual({ closesOn: null });
    const bad = await json(owner, "PUT", path, { closesOn: "2020-01-01" });
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).code).toBe("bad_closing_date");
    const day = new Date(container.engine.clock().getTime() + 40 * 86_400_000).toISOString().slice(0, 10);
    expect(await (await json(owner, "PUT", path, { closesOn: day })).json()).toEqual({ closesOn: day });
    // another device (a fresh request) reads it back from the server
    expect(await (await json(owner, "GET", path)).json()).toEqual({ closesOn: day });
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "wes@packet.test" });
    expect((await json(interviewer, "PUT", path, { closesOn: day })).status).toBe(403);
    const r = await json(owner, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`);
    expect(r.status).toBe(201);
    const { roleId } = (await r.json()) as { roleId: string };
    await container.drain();
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(String(role.applicationsCloseOn).slice(0, 10)).toBe(day);
    const set = (await container.db.select().from(events).where(and(eq(events.type, "role.closing_date_set"), eq(events.subjectId, roleId)))).at(-1);
    expect(set?.payload).toMatchObject({ closesOn: day, from: "job_builder" });
    // the draft has produced its role: the date is changed on the job's Share tab from now on
    expect((await json(owner, "PUT", path, { closesOn: day })).status).toBe(409);
  });

  it("the brief's generic decision card posts a body the decide route accepts", async () => {
    const [roleRow] = await container.db.select().from(roles).where(eq(roles.companyId, companyId)).limit(1);
    const [req] = await withTenant(container.db, companyId, (tx) => tx.insert(approvalRequests).values({ companyId, roleId: roleRow.id, actionType: "posting.sponsor_spend", subject: { type: "role", id: roleRow.id }, proposal: { amount: 50 }, rationale: "Sponsor the Indeed posting for a week?", requestedBy: { kind: "agent", id: "sourcing" }, requiredRoles: ["owner", "admin"] }).returning());
    const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ approvalRequestId?: string; actions: Array<{ label: string; method: string; path: string; body?: Record<string, unknown> }> }> };
    const card = brief.cards.find((c) => c.approvalRequestId === req.id);
    expect(card).toBeTruthy();
    expect(card!.actions[0]).toMatchObject({ method: "POST", path: `/api/v1/approvals/${req.id}/decide`, body: { decision: "approve" } });
    expect(card!.actions.some((a) => a.method === "GET" && a.path === `/roles/${roleRow.id}`)).toBe(true);
    const decided = await json(owner, "POST", card!.actions[1].path, { ...card!.actions[1].body, question: "Please review" });
    expect(decided.status).toBe(200);
    expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.id)))[0].status).toBe("rejected");
  });
});

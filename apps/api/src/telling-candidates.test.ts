import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import type { ApplicationStage, ClosingMessagePreview, ClosingMessageResult, DecisionMessagePreview, RolePacket } from "@ros/contracts";
import { ADVERSE_DECISION_LINE, anonymizeCandidate, correctOutcome, entitlements, grantStaffAccess } from "@ros/core";
import { TURN_CAP_CLOSE_MESSAGE, detectStuckRoles, modelTurnCap, queueDecisionMessage, runInterventionLadder, runUntoldSafetyNet, sendStillReviewingNotes } from "@ros/agents";
import { aiRuns, applications, approvalRequests, candidates, communications, dataRequests, entitlements as entitlementRows, events, hiringOutcomes, notifications, policies, randomToken, recruiterEscalations, roles, screens, takeovers, users, withPlatform, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInStaff } from "./test-helpers";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const INTAKE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";

/**
 * Telling candidates (plan Wave G; founder decisions B6, Q27, Q28, Q30): the decision message in an approved wording with
 * a checked personal line and a locked footer, Undo while a person's message waits, the untold safety net, the one
 * closing message of a closed role, Colorado's line and the compliance queue, the reply time when someone asks for a
 * person, the assistant's suggested line, the courtesy notes and the finalist and offer watchers.
 */
describe("telling candidates", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let hr = "";
  let companyId = "";
  let roleId = "";
  // The engine's clock is pinned, so a person's message waits out its 30-second Undo window until the test moves it.
  const BASE = Date.now();
  let offset = 0;
  const setClock = () => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); };
  const pass = async (ms: number) => { offset += ms; setClock(); await container.drain(); };
  const now = () => new Date(BASE + offset);
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const act = (cookie: string, id: string, body: Record<string, unknown>) => json(cookie, "POST", `/api/v1/applications/${id}/actions`, body);
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const application = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const decisionRows = (id: string) => container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%"))).orderBy(communications.createdAt);
  const told = (kind: string) => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, kind)));
  const openRole = async () => {
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: INTAKE })).json()) as { session: { id: string } };
    const id = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    return id;
  };
  const seed = (first: string, input: { role?: string; email?: string | null; stage?: ApplicationStage; locationText?: string; optedOut?: boolean; createdAt?: string; stageChangedAt?: string } = {}) =>
    withTenant(container.db, companyId, async (tx) => {
      const email = input.email === undefined ? `${first.toLowerCase()}@telling.test` : input.email;
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Reyes", email, firstSource: "direct", locationText: input.locationText ?? null, preferences: input.optedOut ? { talentPoolOptOut: true } : {} }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId: input.role ?? roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: input.stage ?? "triaged", statusToken: randomToken(16), ...(input.createdAt ? { createdAt: input.createdAt } : {}), ...(input.stageChangedAt ? { stageChangedAt: input.stageChangedAt } : {}) }).returning();
      return a.id;
    });
  const decline = async (id: string, reason = "not_a_match_experience") => expect((await act(owner, id, { action: "reject", reason, note: "Private note." })).status).toBe(200);
  const age = (id: string, days: number) => container.db.update(applications).set({ rejectedAt: new Date(Date.now() - days * DAY).toISOString(), stageChangedAt: new Date(Date.now() - days * DAY).toISOString() }).where(eq(applications.id, id));
  const setPolicy = (actionType: string, level: "approval" | "human_only" | null) =>
    withTenant(container.db, companyId, async (tx) => {
      await tx.delete(policies).where(and(eq(policies.companyId, companyId), eq(policies.actionType, actionType)));
      if (level) await tx.insert(policies).values({ companyId, roleId: null, actionType, level, approverRoles: ["owner"], createdBy: { kind: "user", id: ownerId } });
    });
  const safetyNet = () => withTenant(container.db, companyId, (tx) => runUntoldSafetyNet(tx, { integrations: container.integrations, statusBaseUrl: container.env.JOBS_BASE_URL, now: new Date(), actor: { kind: "system", id: "untold_safety_net" } }, companyId));
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: { problems?: string[] } } }).error;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", MESSAGE_UNDO_SECONDS: "30" } });
    app = createApp(container);
    setClock();
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@telling.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    ownerId = (await container.db.select().from(users).where(eq(users.email, "owner@telling.test")))[0].id;
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    // the suite opens and closes more roles than the plan's five a month
    await withTenant(container.db, companyId, (tx) => tx.update(entitlementRows).set({ limit: 20 }).where(and(eq(entitlementRows.companyId, companyId), eq(entitlementRows.key, "active_roles"))));
    roleId = await openRole();
    hr = await signInAs(container, app, { companyId, role: "hr" });
  });
  afterAll(async () => {
    await container.close();
  });

  describe("the decision message in an approved wording, with a personal line (Q28, plan G6)", () => {
    it("previews the suggested wording, offers the approved ones with the fitting one suggested, and checks a personal line before anything goes", async () => {
      const id = await seed("Ana");
      await decline(id, "position_filled");
      // the Send screen starts on the wording that fits the decision (G6, Q28)
      const preview = (await (await json(owner, "GET", `/api/v1/applications/${id}/decision-message`)).json()) as DecisionMessagePreview;
      expect(preview).toMatchObject({ wording: "position_filled", policy: "sends", undoSeconds: 30, adverseDecisionLine: false, personalLine: null, toldState: "not_told" });
      expect(preview.wordings.map((w) => w.id)).toEqual(["v1", "v2", "v3", "after_interview", "position_filled"]);
      expect(preview.wordings.find((w) => w.suggested)?.id).toBe("position_filled");
      expect(preview.text).toContain("The position has now been filled");
      // the link lands on the "Don't keep me for future roles" choice; the team sees it as a placeholder, never the real
      // link, which never expires and lets whoever holds it act as the candidate
      expect(preview.text).toContain("You can also choose this on your status page: ");
      expect(preview.text).toContain("/c/status/[their status link]#future-roles");
      expect(preview.text).not.toContain((await application(id)).statusToken);
      const standard = (await (await json(owner, "POST", `/api/v1/applications/${id}/decision-message/preview`, { wording: "v1" })).json()) as DecisionMessagePreview;
      expect(standard.text).toContain("decided not to move forward at this time");
      const chosen = (await (await json(owner, "POST", `/api/v1/applications/${id}/decision-message/preview`, { wording: "position_filled", personalLine: "Thank you for the care you put into your application." })).json()) as DecisionMessagePreview;
      expect(chosen.wording).toBe("position_filled");
      expect(chosen.text).toContain("The position has now been filled");
      expect(chosen.text).toContain("A note from Dana Whitfield: Thank you for the care you put into your application.");
      // a line that hints at a score, the reason or a personal characteristic is refused, saying what to take out
      for (const [line, problem] of [["Your score was 61/100.", "a score or rating"], ["It came down to your eligibility answer.", "the reason recorded for the decision"], ["We went with someone younger.", "a personal characteristic"]] as const) {
        const r = await json(owner, "POST", `/api/v1/applications/${id}/decision-message/preview`, { personalLine: line });
        expect(r.status, line).toBe(400);
        const error = await errorOf(r);
        expect(error.code).toBe("personal_line_refused");
        expect(error.details?.problems).toContain(problem);
        expect(error.message).toMatch(/Take out "/);
      }
      // the closing message is for a closed role; the eligibility wording for an eligibility decline
      expect((await errorOf(await json(owner, "POST", `/api/v1/applications/${id}/decision-message/preview`, { wording: "role_closed" }))).code).toBe("wording_not_allowed");
      expect((await json(owner, "POST", `/api/v1/applications/${id}/decision-message/preview`, { wording: "eligibility" })).status).toBe(400);
      expect((await json(hr, "POST", `/api/v1/applications/${id}/decision-message/preview`, {})).status).toBe(403);
    });

    it("sends the chosen wording with the line; a refused line sends nothing; an eligibility decline keeps its own wording", async () => {
      const id = await seed("Ben");
      await decline(id);
      const refused = await act(owner, id, { action: "send_decision", personalLine: "The assistant's assessment found gaps." });
      expect(refused.status).toBe(400);
      expect(await decisionRows(id)).toHaveLength(0);
      expect((await application(id)).toldState).toBe("not_told");
      const r = (await (await act(owner, id, { action: "send_decision", wording: "v2", personalLine: "It was a pleasure to read about your work." })).json()) as { candidateNotice: string; communicationId: string; undoUntil: string; wording: string };
      expect(r).toMatchObject({ candidateNotice: "queued", wording: "v2" });
      expect(Date.parse(r.undoUntil)).toBe(now().getTime() + 30_000);
      const [row] = await decisionRows(id);
      expect(row).toMatchObject({ id: r.communicationId, templateKey: "disposition:human:v2", status: "queued" });
      expect(row.bodyText).toContain("A note from Dana Whitfield: It was a pleasure to read about your work.");
      expect((row.tags as Record<string, string>).personalLine).toBe("yes");
      await pass(31_000);
      expect((await decisionRows(id))[0].status).toBe("sent");
      expect((await application(id)).toldState).toBe("sent");
      // the email carries Ben's real status link; what the team is shown of it hides that link and the reply address
      const ben = await application(id);
      expect(row.bodyText).toContain(`/c/status/${ben.statusToken}#future-roles`);
      const detail = await (await json(owner, "GET", `/api/v1/applications/${id}`)).text();
      expect(detail).not.toContain(ben.statusToken);
      if (ben.replyToken) expect(detail).not.toContain(ben.replyToken);
      const shown = (JSON.parse(detail) as { communications: Array<{ id: string; bodyText: string }> }).communications.find((m) => m.id === row.id)!;
      expect(shown.bodyText).toContain("/c/status/[link]#future-roles");
      expect(shown).not.toHaveProperty("replyTo");
      // an eligibility decline: one wording only
      const elig = await seed("Cai", { stage: "ineligible" });
      expect((await act(owner, elig, { action: "reject", reason: "eligibility", note: "Confirmed." })).status).toBe(200);
      const p = (await (await json(owner, "GET", `/api/v1/applications/${elig}/decision-message`)).json()) as DecisionMessagePreview;
      expect(p.wording).toBe("eligibility");
      expect(p.wordings.map((w) => w.id)).toEqual(["eligibility"]);
      expect((await errorOf(await act(owner, elig, { action: "send_decision", wording: "v2" }))).code).toBe("wording_not_allowed");
    });

    it("a Send with no wording chosen, alone or for several people at once, uses each person's suggested wording", async () => {
      const filled = await seed("Abe");
      const plain = await seed("Bo");
      await decline(filled, "position_filled");
      await decline(plain);
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/decision-messages`, { applicationIds: [filled, plain] });
      expect(r.status, await r.clone().text()).toBe(200);
      expect((await decisionRows(filled))[0].templateKey).toBe("disposition:position_filled");
      expect((await decisionRows(plain))[0].templateKey).toBe("disposition:human");
      // one wording for everyone that does not fit someone gives them their own suggested one
      const elig = await seed("Cy", { stage: "ineligible" });
      expect((await act(owner, elig, { action: "reject", reason: "eligibility", note: "Confirmed." })).status).toBe(200);
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/decision-messages`, { applicationIds: [elig], wording: "v2" })).status).toBe(200);
      expect((await decisionRows(elig))[0].templateKey).toBe("disposition:eligibility");
      await pass(31_000);
    });

    it("a Send that read the decision before another Send told them writes nothing: the told state is read again under a lock", async () => {
      const id = await seed("Dot");
      await decline(id);
      const before = await application(id);
      // the closing message, the safety net or another person's Send got there first
      expect((await act(owner, id, { action: "send_decision" })).status).toBe(200);
      const late = withTenant(container.db, companyId, (tx) => queueDecisionMessage(tx, container.integrations, { app: before, actor: { kind: "user", id: ownerId }, wording: "v3", statusBaseUrl: container.env.JOBS_BASE_URL, now: now() }));
      await expect(late).rejects.toMatchObject({ code: "already_told" });
      expect(await decisionRows(id)).toHaveLength(1);
      await pass(31_000);
    });

    it("under 'ask me first' the request carries the wording and the line to the approver, and approving sends exactly that, at once", async () => {
      await setPolicy("disposition.send", "approval");
      const id = await seed("Dee");
      await decline(id);
      const r = (await (await act(owner, id, { action: "send_decision", wording: "v3", personalLine: "Thank you for your time." })).json()) as { candidateNotice: string; approvalRequestId: string };
      expect(r.candidateNotice).toBe("waiting_approval");
      const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, r.approvalRequestId));
      expect(req.proposal).toMatchObject({ wording: "v3", personalLine: { text: "Thank you for your time.", senderName: "Dana Whitfield" } });
      // the approver reads which wording and the line on Today
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ approvalRequestId?: string; roleId?: string; title: string; body: string }> };
      const card = brief.cards.find((c) => c.approvalRequestId === r.approvalRequestId)!;
      expect(card.body).toContain('with the approved "Shorter" message');
      expect(card.body).toContain('They added a personal line: "Thank you for your time."');
      // her message waits on the approver's card, so the "not told yet" card leaves her out (its Review and send could not send it)
      expect(brief.cards.some((c) => c.roleId === roleId && /not been told your decision yet/.test(c.title) && c.body.includes("Dee Reyes"))).toBe(false);
      expect(await (await json(owner, "POST", `/api/v1/approvals/${r.approvalRequestId}/decide`, { decision: "approve" })).json()).toMatchObject({ dispositionSent: true, candidateNotice: "queued" });
      await container.drain();
      const [row] = await decisionRows(id);
      expect(row).toMatchObject({ templateKey: "disposition:human:v3", status: "sent" });
      expect(row.bodyText).toContain("A note from Dana Whitfield: Thank you for your time.");
      await setPolicy("disposition.send", null);
    });
  });

  describe("Undo (plan G9)", () => {
    it("a person's decision message waits out the window; Undo takes it back and they are not told; a new Send is a new message", async () => {
      const id = await seed("Eli");
      await decline(id);
      const r = (await (await act(owner, id, { action: "send_decision" })).json()) as { communicationId: string };
      await container.drain();
      expect((await decisionRows(id))[0].status).toBe("queued");
      const undo = await json(owner, "POST", `/api/v1/applications/${id}/messages/${r.communicationId}/undo`, {});
      expect(undo.status, await undo.clone().text()).toBe(200);
      expect(await undo.json()).toMatchObject({ ok: true, toldState: "not_told" });
      expect((await application(id)).toldState).toBe("not_told");
      expect((await decisionRows(id))[0].status).toBe("cancelled");
      expect((await container.db.select().from(events).where(and(eq(events.type, "message.cancelled"), eq(events.subjectId, r.communicationId))))[0].payload).toMatchObject({ reason: "undone" });
      await pass(31_000);
      expect(mail().filter((m) => m.to === "eli@telling.test" && /^Your application to/.test(m.subject))).toHaveLength(0);
      // sending again is a new message, which goes once its own window has passed; then it is too late to undo
      const again = (await (await act(owner, id, { action: "send_decision" })).json()) as { communicationId: string; candidateNotice: string };
      expect(again.candidateNotice).toBe("queued");
      expect(again.communicationId).not.toBe(r.communicationId);
      await pass(31_000);
      const rows = await decisionRows(id);
      expect(rows.map((x) => x.status)).toEqual(["cancelled", "sent"]);
      expect(rows[1].idempotencyKey).toBe(`${rows[0].idempotencyKey}:1`);
      expect((await errorOf(await json(owner, "POST", `/api/v1/applications/${id}/messages/${again.communicationId}/undo`, {}))).code).toBe("already_sent");
    });

    it("a written message can be taken back too; HR may not take back a decision message; an unknown message is not found", async () => {
      const id = await seed("Fay");
      const sent = await json(owner, "POST", `/api/v1/applications/${id}/messages`, { text: "Hi Fay, a quick question about your licence." });
      expect(sent.status).toBe(201);
      const body = (await sent.json()) as { status: string; communicationId: string; undoUntil: string };
      expect(body.status).toBe("queued");
      expect(Date.parse(body.undoUntil)).toBe(now().getTime() + 30_000);
      expect((await json(owner, "POST", `/api/v1/applications/${id}/messages/${body.communicationId}/undo`, {})).status).toBe(200);
      await pass(31_000);
      expect(mail().some((m) => m.to === "fay@telling.test" && /quick question/.test(m.text))).toBe(false);
      const gus = await seed("Gus");
      await decline(gus);
      const r = (await (await act(owner, gus, { action: "send_decision" })).json()) as { communicationId: string };
      expect((await json(hr, "POST", `/api/v1/applications/${gus}/messages/${r.communicationId}/undo`, {})).status).toBe(403);
      expect((await json(owner, "POST", `/api/v1/applications/${gus}/messages/not-an-id/undo`, {})).status).toBe(404);
      expect((await json(owner, "POST", `/api/v1/applications/${gus}/messages/00000000-0000-7000-8000-000000000000/undo`, {})).status).toBe(404);
      await pass(31_000);
    });

    it("an ITS recruiter working under a grant can take back their own Send, in its window only", async () => {
      const id = await seed("Gia");
      await decline(id);
      const recruiter = await signInStaff(app, container, "rae@its.telling.test", "its_recruiter", "Rae Recruiter");
      const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", applicationId: id, question: "Could you tell this candidate our decision?" })).json()) as { id: string };
      expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
      const r = (await (await act(recruiter, id, { action: "send_decision" })).json()) as { candidateNotice: string; communicationId: string; undoUntil: string };
      expect(r.candidateNotice).toBe("queued");
      expect((await decisionRows(id))[0].sentBy).toMatchObject({ kind: "recruiter" });
      const undo = await json(recruiter, "POST", `/api/v1/applications/${id}/messages/${r.communicationId}/undo`, {});
      expect(undo.status, await undo.clone().text()).toBe(200);
      expect((await application(id)).toldState).toBe("not_told");
      // a written message too; once its window has passed, it is too late
      const sent = (await (await json(recruiter, "POST", `/api/v1/applications/${id}/messages`, { text: "Hi Gia, a quick note from the recruiter." })).json()) as { communicationId: string };
      await pass(31_000);
      expect((await errorOf(await json(recruiter, "POST", `/api/v1/applications/${id}/messages/${sent.communicationId}/undo`, {}))).code).toBe("already_sent");
    });

    it("Undo is only for a person's own Send in its window: never an invitation a workflow sent for them, nor one the approver let go at once", async () => {
      const id = await seed("Hux");
      // an interview invitation written by a workflow running as a person: not a message Undo is for
      const candidateId = (await application(id)).candidateId;
      const [row] = await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId, applicationId: id, direction: "outbound", channel: "email", toAddress: "hux@telling.test", subject: "Pick a time", bodyText: "Times", templateKey: "interview_slots", provider: "fake", status: "queued", sentBy: { kind: "user", id: ownerId, name: "Dana Whitfield" } }).returning());
      expect((await errorOf(await json(owner, "POST", `/api/v1/applications/${id}/messages/${row.id}/undo`, {}))).code).toBe("not_yours");
      expect((await container.db.select({ status: communications.status }).from(communications).where(eq(communications.id, row.id)))[0].status).toBe("queued");
      await container.db.update(communications).set({ status: "cancelled" }).where(eq(communications.id, row.id));
      // approved under "ask me first": the approver's click lets it go at once, with no window to undo
      await setPolicy("disposition.send", "approval");
      await decline(id);
      const asked = (await (await act(owner, id, { action: "send_decision" })).json()) as { approvalRequestId: string };
      await json(owner, "POST", `/api/v1/approvals/${asked.approvalRequestId}/decide`, { decision: "approve" });
      const [decision] = await decisionRows(id);
      expect((await errorOf(await json(owner, "POST", `/api/v1/applications/${id}/messages/${decision.id}/undo`, {}))).code).toBe("already_sent");
      await setPolicy("disposition.send", null);
      await container.drain();
    });
  });

  describe("the untold safety net (Q27, plan G3)", () => {
    it("five working days on, under 'Do it', the standard message goes by itself, once, and the team is told", async () => {
      const old = await seed("Hal");
      const fresh = await seed("Ida");
      await decline(old);
      await decline(fresh);
      await age(old, 12);
      const results = await safetyNet();
      expect(results).toContainEqual({ applicationId: old, action: "sent" });
      expect(results.some((x) => x.applicationId === fresh)).toBe(false);
      const [row] = await decisionRows(old);
      expect(row).toMatchObject({ templateKey: "disposition:human", status: "queued" });
      expect(row.sentBy).toMatchObject({ kind: "system", id: "untold_safety_net" });
      expect((await application(old)).toldState).toBe("queued");
      expect((await container.db.select().from(events).where(and(eq(events.type, "application.untold_fallback"), eq(events.subjectId, old))))[0].payload).toMatchObject({ action: "sent" });
      expect((await told("message.untold_sent")).some((n) => /Hal Reyes/.test(n.body) && /5 working days/.test(n.body))).toBe(true);
      // once: a second run changes nothing
      expect((await safetyNet()).some((x) => x.applicationId === old)).toBe(false);
      await container.drain();
      expect((await application(old)).toldState).toBe("sent");
      expect(await decisionRows(fresh)).toHaveLength(0);
    });

    it("when the settings ask for approval or keep it with a person, or a recruiter runs the role, nothing is sent and a recruiter is brought in, once", async () => {
      for (const level of ["approval", "human_only"] as const) {
        await setPolicy("disposition.send", level);
        const id = await seed(level === "approval" ? "Jo" : "Kit");
        await decline(id);
        await age(id, 12);
        expect(await safetyNet()).toContainEqual({ applicationId: id, action: "recruiter" });
        expect(await decisionRows(id)).toHaveLength(0);
        expect(await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, id), eq(approvalRequests.actionType, "disposition.send")))).toHaveLength(0);
        const [e] = await container.db.select().from(events).where(and(eq(events.type, "application.untold_fallback"), eq(events.subjectId, id)));
        expect(e.payload).toMatchObject({ action: "recruiter", why: level === "approval" ? "the settings ask for approval before a decision message goes" : "the settings keep decision messages with a person" });
        const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, String(e.payload.escalationId)));
        expect(esc).toMatchObject({ kind: "candidate_issue", roleId, status: "open" });
        expect(esc.question).toMatch(/not been told the team's decision/);
        expect((await safetyNet()).some((x) => x.applicationId === id)).toBe(false);
      }
      await setPolicy("disposition.send", null);
      expect((await told("recruiter.untold_brought_in")).length).toBeGreaterThan(0);
      // an ITS recruiter running the role: the same, nothing sent
      const [t] = await withTenant(container.db, companyId, (tx) => tx.insert(takeovers).values({ companyId, roleId, recruiterUserId: ownerId, status: "active" }).returning());
      const id = await seed("Lou");
      await decline(id);
      await age(id, 12);
      expect(await safetyNet()).toContainEqual({ applicationId: id, action: "recruiter" });
      expect((await container.db.select().from(events).where(and(eq(events.type, "application.untold_fallback"), eq(events.subjectId, id))))[0].payload).toMatchObject({ why: "an ITS recruiter is running this role" });
      expect(await decisionRows(id)).toHaveLength(0);
      await container.db.update(takeovers).set({ status: "ended" }).where(eq(takeovers.id, t.id));
    });

    it("someone whose details were deleted at their request is never written to, chased on Today, or handed to a recruiter; their messages waiting for approval lose the team's words", async () => {
      const anonymize = async (id: string) => anonymizeCandidate(container.db, { companyId, candidateId: (await application(id)).candidateId, actor: { kind: "user", id: ownerId, name: "Dana Whitfield" }, deleteFile: async () => {} });
      const eve = await seed("Eve");
      await decline(eve);
      await age(eve, 12);
      type Talent = { applications: Array<{ id: string; toldState: string | null }>; counts: { notTold: number } };
      const talent = async (q = "") => (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?counts=1${q}`)).json()) as Talent;
      const before = await talent();
      expect(before.applications.find((a) => a.id === eve)?.toldState).toBe("not_told");
      await anonymize(eve);
      expect((await application(eve)).toldState).toBe("not_told");
      // the Talent list leaves them out of "Not told yet": no told state on the row, one fewer in the count, not in the
      // filtered list (polish list)
      const after = await talent();
      expect(after.applications.find((a) => a.id === eve)?.toldState).toBeNull();
      expect(after.counts.notTold).toBe(before.counts.notTold - 1);
      expect(after.counts.notTold).toBe(after.applications.filter((a) => a.toldState === "not_told").length);
      expect((await talent("&told=not_told")).applications.some((a) => a.id === eve)).toBe(false);
      expect((await safetyNet()).some((x) => x.applicationId === eve)).toBe(false);
      expect(await decisionRows(eve)).toHaveLength(0);
      expect(await container.db.select().from(events).where(and(eq(events.type, "application.untold_fallback"), eq(events.subjectId, eve)))).toHaveLength(0);
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ body: string }> };
      expect(brief.cards.some((c) => /Removed anon-/.test(c.body))).toBe(false);
      expect((await detectStuckRoles(container.db, companyId, new Date())).some((d) => d.applicationIds?.includes(eve))).toBe(false);
      // a Send writes nothing for them
      expect(((await (await act(owner, eve, { action: "send_decision" })).json()) as { candidateNotice: string }).candidateNotice).toBe("not_sent");
      expect(await decisionRows(eve)).toHaveLength(0);
      // a decision message waiting for approval is withdrawn and loses the personal line
      await setPolicy("disposition.send", "approval");
      const flo = await seed("Flo");
      await decline(flo);
      const asked = (await (await act(owner, flo, { action: "send_decision", personalLine: "Thank you for meeting us." })).json()) as { approvalRequestId: string };
      // a closed role's one closing message names them: they come off it, and it is withdrawn once nobody is left on it
      const role = await openRole();
      const gwen = await seed("Gwen", { role });
      const hal = await seed("Hank", { role });
      expect((await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "role_cancelled", confirm: true })).status).toBe(200);
      const batch = ((await (await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true })).json()) as { approvalRequestId: string }).approvalRequestId;
      await setPolicy("disposition.send", null);
      await anonymize(flo);
      const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, asked.approvalRequestId));
      expect(req.status).toBe("cancelled");
      expect((req.proposal as { personalLine?: unknown }).personalLine).toBeNull();
      expect(JSON.stringify(req)).not.toContain("Thank you for meeting us");
      await anonymize(gwen);
      const [left] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, batch));
      expect(left).toMatchObject({ status: "pending", proposal: { kind: "role_closed", applicationIds: [hal], count: 1 } });
      await anonymize(hal);
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, batch)))[0].status).toBe("cancelled");
    });

    it("leaves out a decision whose message already waits for an approver", async () => {
      await setPolicy("disposition.send", "approval");
      const id = await seed("Max");
      await decline(id);
      expect(((await (await act(owner, id, { action: "send_decision" })).json()) as { candidateNotice: string }).candidateNotice).toBe("waiting_approval");
      await age(id, 12);
      expect((await safetyNet()).some((x) => x.applicationId === id)).toBe(false);
      await setPolicy("disposition.send", null);
    });
  });

  describe("the closing message of a closed role (Q30, plan G4)", () => {
    it("closing a role counts who is still in process and previews one message; they stay in the talent pool unless they asked not to be kept", async () => {
      const role = await openRole();
      const eva = await seed("Eva", { role });
      const finn = await seed("Finn", { role, optedOut: true });
      const gil = await seed("Gil", { role, email: null });
      const hana = await seed("Hana", { role });
      expect((await act(owner, hana, { action: "move_to_talent_pool" })).status).toBe(200);
      expect((await act(owner, hana, { action: "told_in_person" })).status).toBe(200);
      const r = await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "filled", confirm: true, reason: "Hired." });
      expect(r.status, await r.clone().text()).toBe(200);
      const closed = (await r.json()) as { closingMessage: ClosingMessagePreview; keptInTalentPool: number; talentPoolOptOuts: number };
      expect(closed).toMatchObject({ keptInTalentPool: 2, talentPoolOptOuts: 1 });
      expect(closed.closingMessage).toMatchObject({ roleId: role, count: 3, alreadyTold: 1, optedOut: 1, noEmail: 1, policy: "sends", waitingApprovalId: null, sendPath: `/api/v1/roles/${role}/closing-message` });
      expect(closed.closingMessage.people.map((p) => p.applicationId).sort()).toEqual([eva, finn, gil].sort());
      expect(closed.closingMessage.text).toContain("Hi [first name],");
      expect(closed.closingMessage.text).toContain("Harbor Dental has closed this position");
      const kept = async (id: string) => (await container.db.select({ inTalentPool: candidates.inTalentPool }).from(candidates).where(eq(candidates.id, (await application(id)).candidateId)))[0].inTalentPool;
      expect(await kept(eva)).toBe(true);
      expect(await kept(finn)).toBe(false);
      for (const id of [eva, finn, gil]) expect(await decisionRows(id)).toHaveLength(0);
      expect(((await (await json(owner, "GET", `/api/v1/roles/${role}/closing-message`)).json()) as ClosingMessagePreview).count).toBe(3);
      // Today leads to it
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ roleId?: string; title: string; actions: Array<{ label: string; path: string }> }> };
      expect(brief.cards.find((c) => c.roleId === role && /not been told your decision yet/.test(c.title))?.actions.map((a) => a.label)).toContain("Send the closing message");

      // one Send tells everyone listed, each once, in the closing wording
      const sent = await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true });
      expect(sent.status, await sent.clone().text()).toBe(200);
      const result = (await sent.json()) as { status: string; queued: number; notSent: number; results: Array<{ applicationId: string; candidateNotice: string }> };
      expect(result).toMatchObject({ status: "sent", queued: 2, notSent: 1 });
      expect(result.results.find((x) => x.applicationId === gil)?.candidateNotice).toBe("not_sent_no_email");
      await pass(31_000);
      const [evaRow] = await decisionRows(eva);
      expect(evaRow).toMatchObject({ templateKey: "disposition:role_closed", idempotencyKey: `role_closed:${eva}`, status: "sent" });
      expect((await decisionRows(finn))[0].bodyText).toContain("As you asked, we will not keep your details for future roles.");
      expect((await application(eva)).toldState).toBe("sent");
      expect(await decisionRows(hana)).toHaveLength(0);
      // nobody twice
      expect((await errorOf(await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true, applicationIds: [eva, finn] }))).code).toBe("nothing_to_send");
      expect(mail().filter((m) => m.to === "eva@telling.test" && /^Your application to/.test(m.subject))).toHaveLength(1);
    });

    it("under 'ask me first' the whole group waits on one approval; approving tells each of them once", async () => {
      await setPolicy("disposition.send", "approval");
      const role = await openRole();
      const ivo = await seed("Ivo", { role });
      const jay = await seed("Jay", { role });
      expect((await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "role_cancelled", confirm: true })).status).toBe(200);
      const r = await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true });
      expect(r.status).toBe(202);
      const { approvalRequestId } = (await r.json()) as { status: string; approvalRequestId: string };
      const pending = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending")));
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ id: approvalRequestId, applicationId: null, proposal: { kind: "role_closed", count: 2 } });
      for (const id of [ivo, jay]) expect((await application(id)).toldState).toBe("not_told");
      expect((await errorOf(await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true }))).code).toBe("waiting_approval");
      expect((await errorOf(await act(owner, ivo, { action: "send_decision" }))).code).toBe("waiting_approval");
      expect(((await (await json(owner, "GET", `/api/v1/roles/${role}/closing-message`)).json()) as ClosingMessagePreview).waitingApprovalId).toBe(approvalRequestId);
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ approvalRequestId?: string; roleId?: string; title: string }> };
      expect(brief.cards.find((c) => c.approvalRequestId === approvalRequestId)?.title).toMatch(/^Send the closing message to 2 people/);
      // everyone on it waits for that one approval: no "not told yet" card about the same people
      expect(brief.cards.some((c) => c.roleId === role && /not been told your decision yet/.test(c.title))).toBe(false);
      const decided = (await (await json(owner, "POST", `/api/v1/approvals/${approvalRequestId}/decide`, { decision: "approve" })).json()) as { closingMessage: { queued: number } };
      expect(decided.closingMessage.queued).toBe(2);
      await container.drain();
      for (const id of [ivo, jay]) {
        expect((await decisionRows(id)).map((x) => x.status)).toEqual(["sent"]);
        expect((await application(id)).toldState).toBe("sent");
      }
      await setPolicy("disposition.send", null);
    });

    it("each closing message can be taken back in its window; a role reopened by an administrator sends no closing message", async () => {
      const role = await openRole();
      const ian = await seed("Ian", { role });
      expect((await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "no_hire", confirm: true })).status).toBe(200);
      const sent = (await (await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true })).json()) as ClosingMessageResult;
      const mine = sent.results.find((x) => x.applicationId === ian)!;
      expect(mine.communicationId).toBeTruthy();
      expect(Date.parse(mine.undoUntil!)).toBe(now().getTime() + 30_000);
      expect((await json(owner, "POST", `/api/v1/applications/${ian}/messages/${mine.communicationId}/undo`, {})).status).toBe(200);
      expect((await application(ian)).toldState).toBe("not_told");
      await pass(31_000);
      expect(mail().some((m) => m.to === "ian@telling.test" && /^Your application to/.test(m.subject))).toBe(false);
      // waiting for one approval when an administrator voids the role's outcome, reopening it: the request is withdrawn
      await setPolicy("disposition.send", "approval");
      const waiting = ((await (await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true })).json()) as { approvalRequestId: string }).approvalRequestId;
      const [closed] = await container.db.select().from(hiringOutcomes).where(and(eq(hiringOutcomes.roleId, role), isNull(hiringOutcomes.applicationId)));
      await withTenant(container.db, companyId, (tx) => correctOutcome(tx, { outcomeId: closed.id, actor: { kind: "user", id: ownerId, name: "ITS admin" }, reason: "closed by mistake" }));
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, waiting)))[0].status).toBe("cancelled");
      // an approval that comes after the role opened again by any other way sends nothing, and says why
      expect((await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "no_hire", confirm: true })).status).toBe(200);
      const again = ((await (await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true })).json()) as { approvalRequestId: string }).approvalRequestId;
      await container.db.update(roles).set({ status: "open" }).where(eq(roles.id, role));
      const decided = await json(owner, "POST", `/api/v1/approvals/${again}/decide`, { decision: "approve" });
      expect(decided.status, await decided.clone().text()).toBe(200);
      expect(((await decided.json()) as { closingMessage: ClosingMessageResult }).closingMessage).toMatchObject({ status: "role_reopened", queued: 0, notSent: 1 });
      expect(await decisionRows(ian)).toHaveLength(1);
      await container.db.update(roles).set({ status: "closed" }).where(eq(roles.id, role));
      await setPolicy("disposition.send", null);
    });

    it("under 'only a person' nothing is sent; an open role has no closing message; HR may not send it", async () => {
      await setPolicy("disposition.send", "human_only");
      const role = await openRole();
      const kim = await seed("Kim", { role });
      expect((await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "no_hire", confirm: true })).status).toBe(200);
      expect(await (await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true })).json()).toMatchObject({ status: "not_sent_settings", queued: 0 });
      expect(await decisionRows(kim)).toHaveLength(0);
      await setPolicy("disposition.send", null);
      expect((await errorOf(await json(owner, "GET", `/api/v1/roles/${roleId}/closing-message`))).code).toBe("role_not_closed");
      expect((await json(hr, "POST", `/api/v1/roles/${role}/closing-message`, { confirm: true })).status).toBe(403);
      expect((await json(owner, "POST", `/api/v1/roles/${role}/closing-message`, {})).status).toBe(400);
    });

    it("an ITS recruiter given one candidate sees nobody else the closed role left in the pool; a grant for the whole role does", async () => {
      const role = await openRole();
      const olu = await seed("Olu", { role });
      await seed("Pam", { role });
      expect((await json(owner, "POST", `/api/v1/roles/${role}/outcome`, { outcome: "no_hire", confirm: true })).status).toBe(200);
      const underGrant = async (email: string, scope: { roleId: string; applicationId?: string }) => {
        const cookie = await signInStaff(app, container, email, "its_recruiter", "Sky Recruiter");
        const [u] = await container.db.select().from(users).where(eq(users.email, email));
        await withPlatform(container.db, (tx) => grantStaffAccess(tx, { userId: u.id, userName: "Sky Recruiter", companyId, kind: "escalation", scope, purpose: "test: a request about this role", grantedBy: { kind: "system", id: "test" }, expiresAt: new Date(Date.now() + 24 * HOUR) }));
        expect((await json(cookie, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
        return cookie;
      };
      const oneCandidate = await underGrant("sky@its.telling.test", { roleId: role, applicationId: olu });
      const refused = await json(oneCandidate, "GET", `/api/v1/roles/${role}/closing-message`);
      expect(refused.status).toBe(403);
      const error = await errorOf(refused);
      expect(error.code).toBe("staff_scope");
      expect(error.message).not.toContain("Pam");
      const wholeRole = await underGrant("tor@its.telling.test", { roleId: role });
      const seen = await json(wholeRole, "GET", `/api/v1/roles/${role}/closing-message`);
      expect(seen.status, await seen.clone().text()).toBe(200);
      expect(((await seen.json()) as ClosingMessagePreview).count).toBe(2);
    });

    it("'no hire' and a move to the talent pool keep them in the pool unless they opted out, and answer with the message a Send would write", async () => {
      const kai = await seed("Kai");
      const r = (await (await json(owner, "POST", `/api/v1/applications/${kai}/outcome`, { outcome: "no_hire", confirm: true })).json()) as { decisionMessage: DecisionMessagePreview; talentPoolOptOut?: boolean };
      expect(r.decisionMessage).toMatchObject({ wording: "v1", toldState: "not_told", policy: "sends" });
      expect(r.talentPoolOptOut).toBeUndefined();
      expect((await container.db.select({ inTalentPool: candidates.inTalentPool }).from(candidates).where(eq(candidates.id, (await application(kai)).candidateId)))[0].inTalentPool).toBe(true);
      const lou = await seed("Lucy", { optedOut: true });
      expect(await (await json(owner, "POST", `/api/v1/applications/${lou}/outcome`, { outcome: "no_hire", confirm: true })).json()).toMatchObject({ talentPoolOptOut: true });
      const mo = await seed("Mo");
      expect(((await (await act(owner, mo, { action: "move_to_talent_pool" })).json()) as { decisionMessage: DecisionMessagePreview }).decisionMessage.text).toContain("Hi Mo,");
      // the fixed reason list for "we declined the candidate" (plan G2)
      const ned = await seed("Ned");
      expect((await json(owner, "POST", `/api/v1/applications/${ned}/outcome`, { outcome: "employer_declined", confirm: true, reason: "Not right for us" })).status).toBe(400);
      expect((await json(owner, "POST", `/api/v1/applications/${ned}/outcome`, { outcome: "employer_declined", confirm: true, reason: "compensation_mismatch" })).status).toBe(201);
      expect((await application(ned)).rejectReason).toBe("compensation_mismatch");
      // an administrator correcting "no hire" to "we declined" files it under a reason from the same list
      const [noHire] = await container.db.select().from(hiringOutcomes).where(and(eq(hiringOutcomes.applicationId, kai), isNull(hiringOutcomes.correctedAt)));
      await withTenant(container.db, companyId, (tx) => correctOutcome(tx, { outcomeId: noHire.id, actor: { kind: "user", id: ownerId, name: "ITS admin" }, reason: "They were declined, not a no hire", outcome: "employer_declined", declineReason: "position_filled" }));
      expect(await application(kai)).toMatchObject({ stage: "rejected", rejectReason: "position_filled" });
    });
  });

  describe("Colorado's line and asking for the reasons (plan G5)", () => {
    const inbound = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    beforeAll(() => { container.integrations.env.emailInConfigured = true; container.integrations.env.intakeDomain = "intake.telling.test"; });
    afterAll(() => { container.integrations.env.emailInConfigured = false; });

    it("a candidate in Colorado gets the line; a reply asking for the reasons reaches the compliance queue, once", async () => {
      const noor = await seed("Noor", { locationText: "Denver, CO" });
      const ola = await seed("Ola", { locationText: "Tustin, CA" });
      await decline(noor);
      await decline(ola);
      const p = (await (await json(owner, "GET", `/api/v1/applications/${noor}/decision-message`)).json()) as DecisionMessagePreview;
      expect(p.adverseDecisionLine).toBe(true);
      expect(p.text).toContain(ADVERSE_DECISION_LINE.text);
      expect(((await (await json(owner, "GET", `/api/v1/applications/${ola}/decision-message`)).json()) as DecisionMessagePreview).adverseDecisionLine).toBe(false);
      await act(owner, noor, { action: "send_decision" });
      await act(owner, ola, { action: "send_decision" });
      await pass(31_000);
      expect(((await decisionRows(noor))[0].tags as Record<string, string>).adverseDecisionLine).toBe(ADVERSE_DECISION_LINE.version);
      const a = await application(noor);
      const reply = await inbound({ From: "noor@telling.test", To: `reply-${a.replyToken}@intake.telling.test`, Subject: "Re: Your application to Harbor Dental", TextBody: "Could you explain why I was not selected?", MessageID: "noor-1" });
      expect(reply.status).toBe(200);
      const body = (await reply.json()) as { explanationRequestId: string };
      expect(body.explanationRequestId).toBeTruthy();
      const [req] = await container.db.select().from(dataRequests).where(eq(dataRequests.id, body.explanationRequestId));
      expect(req).toMatchObject({ kind: "human_review", channel: "email", applicationId: noor, status: "in_progress" });
      expect(req.details).toMatch(/^Asked for the reasons for the decision/);
      expect(mail().some((m) => m.to === "noor@telling.test" && /^We received your request/.test(m.subject))).toBe(true);
      expect((await told("message.received")).some((n) => /compliance team has the request/.test(n.body))).toBe(true);
      // asking again files nothing new
      expect(((await (await inbound({ From: "noor@telling.test", To: `reply-${a.replyToken}@intake.telling.test`, Subject: "Re: Your application", TextBody: "EXPLAIN", MessageID: "noor-2" })).json()) as { explanationRequestId: string }).explanationRequestId).toBe(body.explanationRequestId);
      expect(await container.db.select().from(dataRequests).where(eq(dataRequests.applicationId, noor))).toHaveLength(1);
      // a reply recorded whose request was never filed (filing failed after the reply's own transaction): the provider's
      // retry finds the reply already recorded and files the request, once
      const first = { From: "noor@telling.test", To: `reply-${a.replyToken}@intake.telling.test`, Subject: "Re: Your application to Harbor Dental", TextBody: "Could you explain why I was not selected?", MessageID: "noor-1" };
      await container.db.delete(dataRequests).where(eq(dataRequests.applicationId, noor));
      const replay = (await (await inbound(first)).json()) as { duplicate: boolean; explanationRequestId: string };
      expect(replay).toMatchObject({ duplicate: true });
      expect(replay.explanationRequestId).toBeTruthy();
      const refiled = await container.db.select().from(dataRequests).where(eq(dataRequests.applicationId, noor));
      expect(refiled).toHaveLength(1);
      expect(refiled[0].details).toMatch(/\(reply [0-9a-f-]{36}\)/);
      expect(((await (await inbound(first)).json()) as { explanationRequestId: string }).explanationRequestId).toBe(replay.explanationRequestId);
      expect(await container.db.select({ n: communications.id }).from(communications).where(and(eq(communications.applicationId, noor), eq(communications.direction, "inbound"), eq(communications.providerMessageId, "noor-1")))).toHaveLength(1);
      // without Colorado's line, "why" is a message for the team; EXPLAIN still reaches the queue
      const b = await application(ola);
      expect(await (await inbound({ From: "ola@telling.test", To: `reply-${b.replyToken}@intake.telling.test`, Subject: "Re", TextBody: "Why was I declined?", MessageID: "ola-1" })).json()).not.toHaveProperty("explanationRequestId");
      expect(await (await inbound({ From: "ola@telling.test", To: `reply-${b.replyToken}@intake.telling.test`, Subject: "Re", TextBody: "explain", MessageID: "ola-2" })).json()).toHaveProperty("explanationRequestId");
    });

    it("an emailed HUMAN gets an answer with the reply time and the AI disclosure", async () => {
      const id = await seed("Pia");
      const a = await application(id);
      await inbound({ From: "pia@telling.test", To: `reply-${a.replyToken}@intake.telling.test`, Subject: "Re: Your application", TextBody: "HUMAN", MessageID: "pia-1" });
      await container.drain();
      const [row] = await container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "human_requested_reply")));
      expect(row.disclosureIncluded).toBe(true);
      expect(row.bodyText).toMatch(/will follow up with you (within four business hours|on the next business day)/);
      expect(row.bodyText).toMatch(/with help from an AI recruiting assistant/);
    });
  });

  describe("a \"no thanks\" reply before the candidate knows the decision (B6)", () => {
    const inbound = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    beforeAll(() => { container.integrations.env.emailInConfigured = true; container.integrations.env.intakeDomain = "intake.telling.test"; });
    afterAll(() => { container.integrations.env.emailInConfigured = false; });
    const person = async (id: string) => (await container.db.select().from(candidates).where(eq(candidates.id, (await application(id)).candidateId)))[0];
    const noThanks = async (id: string, first: string, messageId: string) => {
      const a = await application(id);
      const r = await inbound({ From: `${first.toLowerCase()}@telling.test`, To: `reply-${a.replyToken}@intake.telling.test`, Subject: "Re: Next step", TextBody: "No thanks", MessageID: messageId });
      expect(r.status).toBe(200);
      return (await r.json()) as { talentPoolOptOut?: boolean };
    };
    const optedOutOf = async (id: string) => {
      const cand = await person(id);
      expect(cand.preferences.talentPoolOptOut).toBeUndefined();
      expect(await container.db.select().from(events).where(and(eq(events.type, "consent.revoked"), eq(events.subjectId, cand.id)))).toHaveLength(0);
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "talent_pool_opt_out")))).toHaveLength(0);
    };

    it("a private decision they were never told: \"no thanks\" turns down a step, goes to the team as it is, and opts nobody out", async () => {
      const wes = await seed("Wes");
      await decline(wes);
      expect(await noThanks(wes, "Wes", "wes-1")).toMatchObject({ talentPoolOptOut: false });
      await container.drain();
      await optedOutOf(wes);
      expect((await told("message.received")).some((n) => n.title === "Wes Reyes wrote back" && n.body.includes("This may mean they do not want to go ahead with this step"))).toBe(true);
    });

    it("a decision message taken back with Undo made no offer: \"no thanks\" afterwards opts nobody out", async () => {
      const xan = await seed("Xan");
      await decline(xan);
      const sent = (await (await act(owner, xan, { action: "send_decision" })).json()) as { communicationId: string };
      expect((await json(owner, "POST", `/api/v1/applications/${xan}/messages/${sent.communicationId}/undo`, {})).status).toBe(200);
      await pass(31_000);
      expect((await decisionRows(xan)).map((x) => x.status)).toEqual(["cancelled"]);
      expect(await noThanks(xan, "Xan", "xan-1")).toMatchObject({ talentPoolOptOut: false });
      await container.drain();
      await optedOutOf(xan);
    });
  });

  describe("asking for a person in the conversation (plan G8)", () => {
    it("emails the candidate when a person will contact them", async () => {
      const id = await seed("Quinn", { stage: "screen_invited" });
      const token = randomToken(24);
      await withTenant(container.db, companyId, (tx) => tx.insert(screens).values({ companyId, applicationId: id, channel: "web", status: "invited", token, invitedAt: new Date().toISOString() }));
      const r = await app.request(`/c/screen/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: "HUMAN" }).toString() });
      expect(r.status).toBeLessThan(400);
      await container.drain();
      const [row] = await container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "person_requested")));
      expect(row.status).toBe("sent");
      expect(row.bodyText).toMatch(/A person working with the hiring team will contact you (within four business hours|on the next business day)/);
      expect(row.disclosureIncluded).toBe(true);
    });

    it("an invited conversation that reaches its cap on model calls closes with what was said, without calling the model again", async () => {
      const id = await seed("Yara", { stage: "screen_invited" });
      const token = randomToken(24);
      await withTenant(container.db, companyId, (tx) => tx.insert(screens).values({ companyId, applicationId: id, channel: "web", status: "invited", token, invitedAt: new Date().toISOString() }));
      const packet = ((await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: RolePacket } }).currentPacket.packet;
      const cap = modelTurnCap(packet);
      const chat = { messageToCandidate: "The hiring team can tell you more about that.", questionKey: null, answerRecorded: null, followUpReason: null, candidateAskedAbout: "company", sentiment: "fine", done: false, humanRequested: false };
      for (let i = 0; i < cap + 1; i++) container.fake!.scriptNext("screen.turn", chat);
      for (let i = 0; i < cap + 1; i++) {
        const r = await app.request(`/c/screen/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: "Is there parking near the office?" }).toString() });
        expect(r.status).toBeLessThan(400);
      }
      await container.drain();
      const [scr] = await container.db.select().from(screens).where(eq(screens.token, token));
      expect(scr.status).toBe("completed");
      expect(scr.transcript.filter((t) => t.role === "assistant" && t.aiRunId)).toHaveLength(cap);
      expect(scr.transcript.at(-1)).toMatchObject({ role: "assistant", content: TURN_CAP_CLOSE_MESSAGE });
      const [capped] = await container.db.select().from(events).where(and(eq(events.type, "screen.turn_cap_reached"), eq(events.subjectId, scr.id)));
      expect(capped.payload).toMatchObject({ ending: "closed", cap, modelTurns: cap });
      container.fake!.clearScripts();
    });
  });

  describe("the line the assistant suggests (Q28)", () => {
    it("suggests one checked line for an update or an invitation, and a message that keeps it says the assistant helped", async () => {
      const id = await seed("Ray");
      const s = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages/suggest`, { purpose: "update" })).json()) as { line: string; aiHelped: boolean; suggestionRunId: string; note: string };
      expect(s).toMatchObject({ aiHelped: true });
      expect(s.line).toMatch(/patience/);
      expect(s.note).toMatch(/the email says the assistant helped/);
      expect((await container.db.select().from(aiRuns).where(eq(aiRuns.id, s.suggestionRunId)))[0]).toMatchObject({ promptKey: "message.suggest_line", task: "message.freeform", status: "ok" });
      const preview = (await (await json(owner, "GET", `/api/v1/applications/${id}/messages/preview`)).json()) as { aiFooter: string; undoSeconds: number };
      expect(preview.aiFooter).toMatch(/with help from an AI assistant/);
      expect(preview.undoSeconds).toBe(30);
      const sent = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages`, { text: s.line, aiHelped: true, suggestionRunId: s.suggestionRunId })).json()) as { communicationId: string };
      const [row] = await container.db.select().from(communications).where(eq(communications.id, sent.communicationId));
      expect(row).toMatchObject({ disclosureIncluded: true, aiRunId: s.suggestionRunId });
      expect(row.bodyText).toMatch(/written by Dana Whitfield with help from an AI assistant/);
      // an invitation's line names the round being approved; a decision never gets one
      const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string; title: string }> } } } };
      const round = role.currentPacket.packet.interviews.plan[0];
      const invite = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages/suggest`, { purpose: "interview_invite", roundKey: round.key })).json()) as { line: string };
      expect(invite.line).toContain(round.title.toLowerCase());
      expect((await json(owner, "POST", `/api/v1/applications/${id}/messages/suggest`, { purpose: "decline" })).status).toBe(400);
      await pass(31_000);
    });

    it("the interview approval can carry a personal line for the invitation, checked like any other; one the assistant suggested says so", async () => {
      const id = await seed("Rex");
      const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
      const roundKey = role.currentPacket.packet.interviews.plan[0].key;
      const refused = await json(owner, "POST", `/api/v1/applications/${id}/interviews`, { roundKey, interviewerUserIds: [ownerId], invitationLine: { text: "Your score was 91/100." } });
      expect(refused.status).toBe(400);
      expect((await errorOf(refused)).code).toBe("personal_line_refused");
      const ok = await json(owner, "POST", `/api/v1/applications/${id}/interviews`, { roundKey, interviewerUserIds: [ownerId], invitationLine: { text: "We enjoyed reading about your work.", aiHelped: true } });
      expect(ok.status, await ok.clone().text()).toBe(201);
      const interviewId = ((await ok.json()) as { id: string }).id;
      const [run] = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "schedule_interview"))).filter((r) => r.subject.id === interviewId);
      expect(run.state).toMatchObject({ invitationNote: { text: "We enjoyed reading about your work.", aiHelped: true, senderName: "Dana Whitfield" } });
      // the fact says a line was added and that the assistant helped, never the words
      const [requested] = await container.db.select().from(events).where(and(eq(events.type, "interview.requested"), eq(events.subjectId, interviewId)));
      expect(requested.payload).toMatchObject({ invitationLine: { aiHelped: true } });
      expect(JSON.stringify(requested.payload)).not.toContain("We enjoyed");
    });

    it("a kept line the person then changed still says the assistant helped, even when the page leaves the flag out", async () => {
      const id = await seed("Ria");
      const s = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages/suggest`, { purpose: "update" })).json()) as { line: string; suggestionRunId: string };
      // one word changed and a sentence added: still mostly the assistant's words
      const edited = `${s.line.replace(/\.$/, "")}, truly. More news soon.`;
      const sent = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages`, { text: edited, suggestionRunId: s.suggestionRunId })).json()) as { communicationId: string };
      const [row] = await container.db.select().from(communications).where(eq(communications.id, sent.communicationId));
      expect(row).toMatchObject({ disclosureIncluded: true, aiRunId: s.suggestionRunId });
      expect(row.bodyText).toMatch(/with help from an AI assistant/);
      // a run that is not one of the assistant's suggestions does not count: the person's own words, under their name
      const own = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages`, { text: "Just checking in about next week.", suggestionRunId: "00000000-0000-4000-8000-000000000000" })).json()) as { communicationId: string };
      const [ownRow] = await container.db.select().from(communications).where(eq(communications.id, own.communicationId));
      expect(ownRow.aiRunId).toBeNull();
      expect(ownRow.bodyText).not.toMatch(/AI assistant/);
      // the invitation's line: changed after it was kept, sent without the flag, still credited to the assistant
      const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
      const roundKey = role.currentPacket.packet.interviews.plan[0].key;
      const invite = (await (await json(owner, "POST", `/api/v1/applications/${id}/messages/suggest`, { purpose: "interview_invite", roundKey })).json()) as { line: string; suggestionRunId: string };
      const ok = await json(owner, "POST", `/api/v1/applications/${id}/interviews`, { roundKey, interviewerUserIds: [ownerId], invitationLine: { text: "We look forward to meeting you next week.", suggestionRunId: invite.suggestionRunId } });
      expect(ok.status, await ok.clone().text()).toBe(201);
      const interviewId = ((await ok.json()) as { id: string }).id;
      const [run] = (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "schedule_interview"))).filter((r) => r.subject.id === interviewId);
      expect(run.state).toMatchObject({ invitationNote: { text: "We look forward to meeting you next week.", aiHelped: true } });
      const [requested] = await container.db.select().from(events).where(and(eq(events.type, "interview.requested"), eq(events.subjectId, interviewId)));
      expect(requested.payload).toMatchObject({ invitationLine: { aiHelped: true, suggestionRunId: invite.suggestionRunId } });
      await pass(31_000);
    });
  });

  describe("courtesy notes and the watchers (plan G10)", () => {
    it("a long wait gets one 'still reviewing' note under 'Do it' and none under 'Only a person'; the product's own note cannot be undone", async () => {
      const long = new Date(Date.now() - 31 * DAY).toISOString();
      const sam = await seed("Sam", { createdAt: long });
      const recent = await seed("Sue");
      // waits that crossed the 30 days long ago (applied before the note existed, or before it was turned on): never noted
      // months after the fact, all at once; a week of missed daily runs is made up for, no more
      const backlog = await seed("Wren", { createdAt: new Date(Date.now() - 90 * DAY).toISOString() });
      const pastCatchUp = await seed("Xavi", { createdAt: new Date(Date.now() - 38 * DAY).toISOString() });
      const notes = () => withTenant(container.db, companyId, (tx) => sendStillReviewingNotes(tx, { integrations: container.integrations, statusBaseUrl: container.env.JOBS_BASE_URL, now: new Date(), actor: { kind: "system", id: "still_reviewing" } }, companyId));
      const noted = await notes();
      expect(noted).toContain(sam);
      expect(noted).not.toContain(recent);
      expect(noted).not.toContain(backlog);
      expect(noted).not.toContain(pastCatchUp);
      expect(await container.db.select().from(communications).where(and(inArray(communications.applicationId, [backlog, pastCatchUp]), eq(communications.templateKey, "still_reviewing")))).toHaveLength(0);
      const [row] = await container.db.select().from(communications).where(and(eq(communications.applicationId, sam), eq(communications.templateKey, "still_reviewing")));
      expect(row.bodyText).toMatch(/no decision has been made yet/);
      expect(row.bodyText).toMatch(/\/c\/status\//);
      expect(row.disclosureIncluded).toBe(true);
      expect((await notes()).includes(sam)).toBe(false);
      expect((await errorOf(await json(owner, "POST", `/api/v1/applications/${sam}/messages/${row.id}/undo`, {}))).code).toBe("not_yours");
      await setPolicy("message.still_reviewing", "human_only");
      const tia = await seed("Tia", { createdAt: long });
      expect((await notes()).includes(tia)).toBe(false);
      await setPolicy("message.still_reviewing", null);
      await container.drain();
    });

    it("finalists waiting on the team and offers with no answer recorded are named, the offers on Today with no recruiter", async () => {
      const role = await openRole();
      const uma = await seed("Uma", { role, stage: "finalist", stageChangedAt: new Date(Date.now() - 4 * DAY).toISOString() });
      const vic = await seed("Vic", { role, stage: "offer_sent", stageChangedAt: new Date(Date.now() - 6 * DAY).toISOString() });
      const found = (await detectStuckRoles(container.db, companyId, new Date())).filter((d) => d.roleId === role);
      expect(found.find((d) => d.detector === "candidates_waiting")?.body).toMatch(/finalist is waiting to hear what comes next/);
      // the long-wait card on Today (plan G10): the one waiting longest, named, with decide, hold until a date, or a note
      const today = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; roleId?: string; applicationId?: string; body: string; actions: Array<{ label: string; path: string }> }> };
      const wait = today.cards.find((c) => c.roleId === role && c.applicationId === uma)!;
      expect(wait.body).toMatch(/Uma Reyes has waited longest, 4 days/);
      expect(wait.actions.map((a) => [a.label, a.path])).toEqual(expect.arrayContaining([["Decide", `/roles/${role}/talent?open=${uma}`], ["Hold until a date", `/roles/${role}/talent?open=${uma}&step=hold`], ["Send a note", `/roles/${role}/talent?open=${uma}&message=1`]]));
      const offers = found.find((d) => d.detector === "offers_waiting")!;
      expect(offers.applicationIds).toEqual([vic]);
      expect(offers.body).toMatch(/Vic Reyes/);
      const deps = { integrations: container.integrations, appBaseUrl: "http://localhost:3000", itsQueueEmail: "queue@its.test", now: new Date(), actor: { kind: "system" as const, id: "test" } };
      expect(await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, deps, companyId, [offers]))).toContainEqual(expect.objectContaining({ detector: "offers_waiting", level: "brief" }));
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; roleId?: string; title: string; actions: Array<{ label: string }> }> };
      const card = brief.cards.find((c) => c.roleId === role && /offer has had no answer recorded/.test(c.title));
      expect(card?.kind).toBe("needs_review");
      expect(card?.actions.some((a) => /recruiter/i.test(a.label))).toBe(false);
    });
  });
});

/** A screening link that lapses unstarted tells the candidate (plan G10); its own suite, since it moves the clock days ahead. */
describe("a screening link that lapses", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const BASE = Date.now();
  let offset = 0;
  const pass = async (ms: number) => { offset += ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); await container.drain(); };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    await pass(0);
  });
  afterAll(async () => {
    await container.close();
  });

  it("emails the candidate that the link closed, that the application is still with the team, and how to get a new one", async () => {
    const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@lapse.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    const owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Lapse Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: INTAKE })).json()) as { session: { id: string } };
    const roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    const id = await withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Zed", lastName: "Moss", email: "zed@lapse.test", firstSource: "direct" }).returning();
      return (await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning())[0].id;
    });
    expect((await json(owner, "POST", `/api/v1/applications/${id}/actions`, { action: "invite_screen", channel: "web" })).status).toBe(200);
    await pass(49 * HOUR);
    await pass(73 * HOUR);
    const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, id)).orderBy(desc(screens.createdAt)).limit(1);
    expect(scr.status).toBe("expired");
    const [note] = await container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "screen_expired")));
    expect(note.status).toBe("sent");
    expect(note.bodyText).toMatch(/has now closed, because it was not started/);
    expect(note.bodyText).toMatch(/Your application is still with the hiring team/);
    expect(note.bodyText).toMatch(/reply to this email and someone on the team can send you a new link/);
    // the team can invite them again
    expect(((await (await json(owner, "GET", `/api/v1/applications/${id}`)).json()) as { allowedActions: string[] }).allowedActions).toContain("invite_screen");
    expect(await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "screen.expired"), isNull(notifications.readAt)))).not.toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { ActiveMark, ApplicationStage, StageMove } from "@ros/contracts";
import { anonymizeCandidate, correctOutcome, emit, entitlements, exportCandidateData, openFollowUp, suppressAddress, transition } from "@ros/core";
import { detectStuckRoles, handleEmailEvent, retryCommunication, runInterventionLadder, runUntoldSafetyNet, sweepStaleSending, workingDaysSince } from "@ros/agents";
import { applicationMarks, applications, approvalRequests, candidates, communications, events, interviews, notifications, policies, randomToken, users, withPlatform, withTenant } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { sendDecisionMessage } from "./services/application-actions";
import { signInAs } from "./test-helpers";

const DAY = 86_400_000;

/**
 * The stage strip and private decisions (founder decisions B3 and B6; plan A4, A6, G1): the private marks (Longlist,
 * Shortlist, On hold, Not a fit for now) with their history and the stage button; holds that come back to Today when
 * their date passes; declines that tell the candidate nothing until a person sends the decision message (or records
 * telling them in person); the role's list with its strip counts; and the assistant's waiting suggestions settled when a
 * person acts on the candidate directly.
 */
describe("the stage strip, private marks and private decisions", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let hr = "";
  let interviewer = "";
  let companyId = "";
  let roleId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const act = (cookie: string, id: string, body: Record<string, unknown>) => json(cookie, "POST", `/api/v1/applications/${id}/actions`, body);
  type Detail = { ownerStage: string; ownerStageLabel: string; mark: ActiveMark | null; tags: string[]; toldState: string | null; candidateToldAt: string | null; allowedActions: string[]; blockedReasons: Record<string, string>; stageMoves: StageMove[]; group: string };
  const detail = async (id: string, cookie = owner) => (await (await json(cookie, "GET", `/api/v1/applications/${id}`)).json()) as Detail;
  const application = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const marksOf = (id: string) => container.db.select().from(applicationMarks).where(eq(applicationMarks.applicationId, id)).orderBy(applicationMarks.createdAt);
  const seed = (first: string, input: { email?: string | null; stage?: ApplicationStage; stageChangedAt?: string } = {}) =>
    withTenant(container.db, companyId, async (tx) => {
      const email = input.email === undefined ? `${first.toLowerCase()}@marks.test` : input.email;
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Moss", email, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: input.stage ?? "triaged", statusToken: randomToken(16), ...(input.stageChangedAt ? { stageChangedAt: input.stageChangedAt } : {}) }).returning();
      return a.id;
    });
  const setDecisionPolicy = (level: "approval" | "human_only" | null) =>
    withTenant(container.db, companyId, async (tx) => {
      await tx.delete(policies).where(and(eq(policies.companyId, companyId), eq(policies.actionType, "disposition.send")));
      if (level) await tx.insert(policies).values({ companyId, roleId: null, actionType: "disposition.send", level, approverRoles: ["owner"], createdBy: { kind: "user", id: ownerId } });
    });
  const decline = async (id: string) => expect((await act(owner, id, { action: "reject", reason: "not_a_match_experience", note: "Not this time." })).status).toBe(200);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@marks.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    ownerId = (await container.db.select().from(users).where(eq(users.email, "owner@marks.test")))[0].id;
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Marks Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    hr = await signInAs(container, app, { companyId, role: "hr" });
    interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
  });
  afterAll(async () => {
    await container.close();
  });

  describe("private marks", () => {
    it("sorts someone onto the shortlist in one click, privately, and keeps the history when the mark changes", async () => {
      const id = await seed("Ada");
      const r = await (await act(owner, id, { action: "set_mark", mark: "shortlist", note: "Strong chairside" })).json();
      expect(r).toMatchObject({ ok: true, stage: "triaged", ownerStage: "shortlist", candidateNotice: "not_told", mark: { mark: "shortlist", label: "Shortlist", note: "Strong chairside", remindAt: null, source: "manual" } });
      expect(await detail(id)).toMatchObject({ ownerStage: "shortlist", ownerStageLabel: "Shortlist", mark: { mark: "shortlist" } });
      // a second mark replaces the first; the first stays, cleared, with why
      expect(await (await act(owner, id, { action: "set_mark", mark: "longlist" })).json()).toMatchObject({ ownerStage: "longlist" });
      const rows = await marksOf(id);
      expect(rows.map((m) => [m.mark, !!m.clearedAt, m.clearReason])).toEqual([["shortlist", true, "replaced by longlist"], ["longlist", false, null]]);
      // choosing New takes the mark off; a second time there is nothing to take off
      expect(await (await act(owner, id, { action: "clear_mark" })).json()).toMatchObject({ ownerStage: "new", mark: null });
      const again = await act(owner, id, { action: "clear_mark" });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe("no_mark");
      const facts = await container.db.select().from(events).where(and(eq(events.subjectId, id), like(events.type, "application.mark%"))).orderBy(events.id);
      expect(facts.map((e) => e.type)).toEqual(["application.marked", "application.mark_cleared", "application.marked", "application.mark_cleared"]);
      // nothing reached the candidate
      expect(await container.db.select().from(communications).where(eq(communications.applicationId, id))).toHaveLength(0);
    });

    it("puts someone on hold until a date (14 days unless chosen, never past or beyond 8 weeks) and pauses the nudges", async () => {
      const id = await seed("Bea", { stageChangedAt: new Date(Date.now() - 5 * DAY).toISOString() });
      const held = (await (await act(owner, id, { action: "hold", note: "Waiting on her licence renewal" })).json()) as { mark: ActiveMark; next: string };
      expect(Math.round((Date.parse(held.mark.remindAt!) - Date.now()) / DAY)).toBe(14);
      expect(held.next).toMatch(/^On hold until .*The candidate was not told\.$/);
      expect((await detail(id)).group).toBe("in_process");
      const chosen = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
      expect(await (await act(owner, id, { action: "set_mark", mark: "on_hold", remindAt: chosen })).json()).toMatchObject({ mark: { remindAt: `${chosen}T15:00:00.000Z` } });
      expect((await act(owner, id, { action: "set_mark", mark: "on_hold", remindAt: "2020-01-01" })).status).toBe(400);
      expect((await act(owner, id, { action: "set_mark", mark: "on_hold", remindAt: new Date(Date.now() + 70 * DAY).toISOString().slice(0, 10) })).status).toBe(400);
      expect((await act(owner, id, { action: "set_mark", mark: "on_hold", remindAt: "soon" })).status).toBe(400);
      expect((await act(owner, id, { action: "set_mark" })).status).toBe(400);
      // a held person who has waited five days nudges nobody while the hold runs
      const running = await detectStuckRoles(container.db, companyId, new Date());
      expect(running.some((d) => d.detector === "candidates_waiting")).toBe(false);
      expect(running.some((d) => d.detector === "hold_ended")).toBe(false);
    });

    it("brings a hold back to Today and as a notification when its date passes, once", async () => {
      const id = await seed("Cy");
      await act(owner, id, { action: "hold" });
      await container.db.update(applicationMarks).set({ remindAt: new Date(Date.now() - DAY).toISOString() }).where(and(eq(applicationMarks.applicationId, id), eq(applicationMarks.mark, "on_hold")));
      const d = await detail(id);
      expect(d).toMatchObject({ ownerStage: "on_hold", group: "waiting_on_you", tags: ["Hold ended"] });
      const found = (await detectStuckRoles(container.db, companyId, new Date())).filter((x) => x.detector === "hold_ended");
      expect(found).toHaveLength(1);
      expect(found[0].applicationIds).toContain(id);
      expect(found[0].body).toContain("Cy Moss");
      const deps = { integrations: container.integrations, appBaseUrl: "http://localhost:3000", itsQueueEmail: "queue@its.test", now: new Date(), actor: { kind: "system" as const, id: "test" } };
      const first = await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, deps, companyId, found));
      expect(first).toEqual([expect.objectContaining({ detector: "hold_ended", level: "brief" })]);
      expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "stuck.hold_ended")))).length).toBeGreaterThan(0);
      // later runs never climb the ladder: no emails, no recruiter, for the team's own reminder
      const later = { ...deps, now: new Date(Date.now() + 3 * DAY) };
      expect(await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, later, companyId, found))).toEqual([expect.objectContaining({ level: "skipped", reason: "already told in the app" })]);
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string; actions: Array<{ label: string }> }> };
      const card = brief.cards.find((c) => /hold has ended/.test(c.title));
      expect(card).toMatchObject({ kind: "needs_review" });
      expect(card!.actions.some((a) => /recruiter/i.test(a.label))).toBe(false);
      // deciding takes them off the hold
      await act(owner, id, { action: "clear_mark" });
    });

    it("ends when a person moves them on to interviewing, but never because the system moved them", async () => {
      const id = await seed("Fin");
      await act(owner, id, { action: "hold" });
      expect(await (await act(owner, id, { action: "advance_to_interview" })).json()).toMatchObject({ ownerStage: "interviewing" });
      const [m] = await marksOf(id);
      expect(m.clearReason).toBe("moved on (interviewing)");
      expect((await detail(id)).ownerStage).toBe("interviewing");
      // the assistant's own step (a screen finishing) leaves a person's hold alone
      const held = await seed("Gwen", { stage: "screening" });
      await act(owner, held, { action: "hold" });
      await withTenant(container.db, companyId, (tx) => transition(tx, { applicationId: held, companyId, to: "screen_complete", by: "system", actor: { kind: "system", id: "test" } }));
      await withTenant(container.db, companyId, (tx) => transition(tx, { applicationId: held, companyId, to: "interview_recommended", by: "system", actor: { kind: "system", id: "test" } }));
      expect((await detail(held)).ownerStage).toBe("on_hold");
    });

    it("is refused for someone held on an eligibility answer, for those who may not sort, and clears when they leave", async () => {
      const elig = await seed("Dee", { stage: "ineligible" });
      const refused = await act(owner, elig, { action: "set_mark", mark: "shortlist" });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { message: string } }).error.message).toBe("Check their eligibility answer first: keep them in or decline.");
      const id = await seed("Eli");
      // HR may sort (application.act); an interviewer may not
      expect((await act(hr, id, { action: "set_mark", mark: "longlist" })).status).toBe(200);
      expect((await act(interviewer, id, { action: "set_mark", mark: "shortlist" })).status).toBe(403);
      await decline(id);
      const [m] = await marksOf(id);
      expect(m.clearedAt).toBeTruthy();
      expect(m.clearReason).toBe("left the process (not moving forward)");
      expect((await detail(id)).mark).toBeNull();
    });
  });

  describe("private decisions and telling the candidate", () => {
    it("files a decline privately, previews the message, sends it on a person's Send, and marks them told once it leaves", async () => {
      const id = await seed("Fay");
      await decline(id);
      const d = await detail(id);
      expect(d).toMatchObject({ ownerStage: "not_moving_forward", toldState: "not_told" });
      expect(d.allowedActions).toEqual(expect.arrayContaining(["send_decision", "told_in_person"]));
      await container.drain();
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")))).toHaveLength(0);
      const preview = (await (await json(owner, "GET", `/api/v1/applications/${id}/decision-message`)).json()) as { to: string; subject: string; text: string; policy: string; toldState: string };
      expect(preview).toMatchObject({ to: "fay@marks.test", subject: "Your application to Marks Dental", policy: "sends", toldState: "not_told" });
      expect(preview.text).toContain("decided not to move forward");
      expect((await json(hr, "GET", `/api/v1/applications/${id}/decision-message`)).status).toBe(403);
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued", toldState: "queued", dispositionSent: true });
      await container.drain();
      const after = await application(id);
      expect(after.toldState).toBe("sent");
      expect(after.candidateToldAt).toBeTruthy();
      const [sent] = await container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "disposition:human")));
      expect(sent.status).toBe("sent");
      // the words previewed, with the real status link in place of the placeholder the team was shown
      expect(preview.text).not.toContain(after.statusToken);
      expect(sent.bodyText).toBe(preview.text.replace("/c/status/[their status link]", `/c/status/${after.statusToken}`));
      expect(await container.db.select().from(events).where(and(eq(events.type, "application.told"), eq(events.subjectId, id)))).toHaveLength(1);
      // once told, there is nothing more to send
      const again = await act(owner, id, { action: "send_decision" });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { message: string } }).error.message).toBe("They have been sent the decision message.");
      // HR may not tell a decision; nobody may for someone still in the process
      const other = await seed("Gus");
      expect((await act(hr, other, { action: "send_decision" })).status).toBe(403);
      expect(((await (await act(owner, other, { action: "send_decision" })).json()) as { error: { code: string } }).error.code).toBe("not_decided");
      expect((await json(owner, "GET", `/api/v1/applications/${other}/decision-message`)).status).toBe(404);
    });

    it("a decline nobody told can be taken back: they go back where they were, nothing is sent, and the safety net leaves them alone (plan G1)", async () => {
      const id = await seed("Lou", { stage: "screen_complete" });
      await decline(id);
      const d = await detail(id);
      expect(d.allowedActions).toContain("undo_decision");
      expect(d.stageMoves.find((m) => m.to === "new")).toMatchObject({ allowed: true, via: "undo_decision" });
      // HR may not take back a decision
      expect((await act(hr, id, { action: "undo_decision" })).status).toBe(403);
      const r = await act(owner, id, { action: "undo_decision", note: "Ticked by mistake in Review and apply" });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ stage: "screen_complete", ownerStage: "new", candidateNotice: "not_told" });
      expect(await application(id)).toMatchObject({ stage: "screen_complete", rejectedAt: null, rejectReason: null, rejectNote: null });
      const override = (await container.db.select().from(events).where(and(eq(events.type, "human.override"), eq(events.subjectId, id)))).find((e) => e.payload.action === "undo_decision");
      expect(override?.payload).toMatchObject({ from: "rejected", to: "screen_complete" });
      // a week on, nobody is chased and nothing goes: they are no longer a decision
      const net = await withTenant(container.db, companyId, (tx) => runUntoldSafetyNet(tx, { integrations: container.integrations, statusBaseUrl: "http://localhost:3000", now: new Date(Date.now() + 10 * DAY), actor: { kind: "system", id: "untold_safety_net" } }, companyId));
      expect(net.map((x) => x.applicationId)).not.toContain(id);
      await container.drain();
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")))).toHaveLength(0);
      // declined again, it is a new decision; once told, it can no longer be taken back
      await decline(id);
      expect(await (await act(owner, id, { action: "told_in_person" })).json()).toMatchObject({ toldState: "told_in_person" });
      const late = await act(owner, id, { action: "undo_decision" });
      expect(late.status).toBe(409);
      expect(((await late.json()) as { error: { code: string } }).error.code).toBe("already_told");
    });

    it("a message that could not be delivered leaves them not told, and a second Send is a new message", async () => {
      const id = await seed("Gil");
      await decline(id);
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
      // what the outbox does when the provider refuses it for good (packages/agents/src/outbox.ts)
      await container.db.update(communications).set({ status: "failed", error: "provider refused" }).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")));
      await container.db.update(applications).set({ toldState: "not_told" }).where(eq(applications.id, id));
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued", toldState: "queued" });
      await container.drain();
      const messages = await container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%"))).orderBy(communications.createdAt);
      expect(messages.map((m) => m.status)).toEqual(["failed", "sent"]);
      expect(messages[1].idempotencyKey).toBe(`${messages[0].idempotencyKey}:1`);
      expect((await application(id)).toldState).toBe("sent");
    });

    it("names an interview the decision called off only when nobody told the candidate it is off yet", async () => {
      const id = await seed("Hugo", { stage: "interview_scheduled" });
      await decline(id);
      const startsAt = new Date(Date.now() + 3 * DAY).toISOString();
      const actor = { kind: "user" as const, id: ownerId };
      await withTenant(container.db, companyId, async (tx) => {
        await tx.insert(interviews).values({ companyId, applicationId: id, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "cancelled", startsAt, timezone: "America/Los_Angeles", cancelReason: "declined", createdBy: actor });
        // one whose short "interview is off" note already went (a private decision tells them at once) is left out
        const [told] = await tx.insert(interviews).values({ companyId, applicationId: id, roundKey: "r2", title: "Team lunch", format: "onsite", durationMinutes: 45, status: "cancelled", startsAt, timezone: "America/Los_Angeles", cancelReason: "declined", createdBy: actor }).returning();
        await emit(tx, { type: "interview.cancelled", companyId, actor, subject: { type: "interview", id: told.id }, payload: { reason: "declined", byCandidate: false, hadEvents: false, candidateTold: true, cause: "left_process" } });
      });
      const preview = (await (await json(owner, "GET", `/api/v1/applications/${id}/decision-message`)).json()) as { text: string };
      expect(preview.text).toMatch(/The Working interview on .* is cancelled, so there is no need to attend\./);
      expect(preview.text).not.toContain("Team lunch");
    });

    it("under 'ask me first' the Send waits for an approver; approving sends it; 'Do not send' leaves them not told", async () => {
      await setDecisionPolicy("approval");
      const id = await seed("Ivy");
      await decline(id);
      const r = (await (await act(owner, id, { action: "send_decision" })).json()) as { candidateNotice: string; approvalRequestId: string };
      expect(r.candidateNotice).toBe("waiting_approval");
      const d = await detail(id);
      expect(d.allowedActions).not.toContain("send_decision");
      expect(d.blockedReasons.send_decision).toBe("The decision message is waiting for approval.");
      expect(((await (await act(owner, id, { action: "send_decision" })).json()) as { error: { code: string } }).error.code).toBe("waiting_approval");
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ title: string; body: string; approvalRequestId?: string }> };
      const card = brief.cards.find((c) => c.approvalRequestId === r.approvalRequestId);
      expect(card?.title).toBe("Send the decision message to Ivy Moss?");
      expect(await (await json(owner, "POST", `/api/v1/approvals/${r.approvalRequestId}/decide`, { decision: "approve" })).json()).toMatchObject({ status: "approved", dispositionSent: true, candidateNotice: "queued" });
      await container.drain();
      expect((await application(id)).toldState).toBe("sent");
      // "Do not send": nothing goes, they stay not told, and the team can send again or tell them themselves
      const jo = await seed("Jo");
      await decline(jo);
      const waiting = (await (await act(owner, jo, { action: "send_decision" })).json()) as { approvalRequestId: string };
      expect((await json(owner, "POST", `/api/v1/approvals/${waiting.approvalRequestId}/decide`, { decision: "reject" })).status).toBe(200);
      expect((await application(jo)).toldState).toBe("not_told");
      expect((await detail(jo)).allowedActions).toContain("send_decision");
      await setDecisionPolicy(null);
    });

    it("under 'only a person' nothing is sent, and the team records telling them in person, which also withdraws a waiting message", async () => {
      await setDecisionPolicy("human_only");
      const id = await seed("Kai");
      await decline(id);
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "not_sent_settings", toldState: "not_told" });
      expect(await (await act(owner, id, { action: "told_in_person", note: "Called her this morning" })).json()).toMatchObject({ toldState: "told_in_person", candidateNotice: "not_told" });
      expect((await application(id)).candidateToldAt).toBeTruthy();
      expect((await container.db.select().from(events).where(and(eq(events.type, "application.told"), eq(events.subjectId, id))))[0].payload).toMatchObject({ how: "in_person", note: "Called her this morning" });
      expect((await act(owner, id, { action: "told_in_person" })).status).toBe(409);
      await setDecisionPolicy("approval");
      const lea = await seed("Lea");
      await decline(lea);
      const waiting = (await (await act(owner, lea, { action: "send_decision" })).json()) as { approvalRequestId: string };
      expect((await act(owner, lea, { action: "told_in_person" })).status).toBe(200);
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, waiting.approvalRequestId)))[0].status).toBe("cancelled");
      await setDecisionPolicy(null);
    });

    it("sends the decision message to several people at once, each with their own result", async () => {
      const a = await seed("Max");
      const b = await seed("Ned", { email: null });
      const c = await seed("Ola");
      await decline(a);
      await decline(b);
      const r = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/decision-messages`, { applicationIds: [a, b, c, "00000000-0000-0000-0000-000000000000"] })).json()) as { results: Array<{ applicationId: string; ok: boolean; candidateNotice?: string; code?: string }>; queued: number; notSent: number };
      expect(r.results).toEqual([
        expect.objectContaining({ applicationId: a, ok: true, candidateNotice: "queued" }),
        expect.objectContaining({ applicationId: b, ok: true, candidateNotice: "not_sent_no_email" }),
        expect.objectContaining({ applicationId: c, ok: false, code: "not_decided" }),
        expect.objectContaining({ ok: false, code: "not_found" }),
      ]);
      expect(r).toMatchObject({ queued: 1, notSent: 3 });
      expect((await json(hr, "POST", `/api/v1/roles/${roleId}/decision-messages`, { applicationIds: [a] })).status).toBe(403);
    });

    it("moving someone to the talent pool is a private decision too, told later the same way", async () => {
      const id = await seed("Pam");
      expect(await (await act(owner, id, { action: "move_to_talent_pool" })).json()).toMatchObject({ stage: "talent_pool", ownerStage: "not_moving_forward", toldState: "not_told", candidateNotice: "not_told" });
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
    });

    it("lists who has not been told on Today, and only to those who may tell them", async () => {
      const id = await seed("Quin");
      await decline(id);
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ title: string; body: string; actions: Array<{ path: string }> }> };
      const card = brief.cards.find((c) => /not been told your decision yet/.test(c.title));
      const untold = (await container.db.select().from(applications).where(and(eq(applications.roleId, roleId), eq(applications.toldState, "not_told")))).filter((a) => ["rejected", "talent_pool"].includes(a.stage));
      expect(card?.title).toMatch(new RegExp(`^${untold.length} people have not been told your decision yet`));
      expect(card?.body).toMatch(/Moss/);
      expect(card?.actions[0].path).toBe(`/roles/${roleId}/talent?ownerStage=not_moving_forward&told=not_told`);
      const hrBrief = (await (await json(hr, "GET", "/api/v1/brief")).json()) as { cards: Array<{ title: string }> };
      expect(hrBrief.cards.some((c) => /not been told your decision yet/.test(c.title))).toBe(false);
    });
  });

  describe("a decision message that no longer applies, or that nobody can confirm, never strands anyone", () => {
    const owner_ = () => ({ kind: "user" as const, id: ownerId, name: "Owner" });
    // queued inside a transaction of its own, without the route's inline worker, so it waits in the outbox like in production
    const queueDecision = (id: string) => withTenant(container.db, companyId, async (tx) => { const [row] = await tx.select().from(applications).where(eq(applications.id, id)); return sendDecisionMessage(tx, container, { app: row, actor: owner_() }); });
    const decisionRows = (id: string) => container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")));
    const mailTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email && /^Your application to/.test(m.subject));
    const form = { "content-type": "application/x-www-form-urlencoded" };

    it("a candidate who withdraws while the decision message waits in the outbox never gets it", async () => {
      const id = await seed("Abe");
      await decline(id);
      expect((await queueDecision(id)).notice).toBe("queued");
      expect((await application(id)).toldState).toBe("queued");
      const r = await app.request(`/c/status/${(await application(id)).statusToken}/withdraw`, { method: "POST", headers: form, body: "confirm=yes" });
      expect(r.status).toBe(302);
      await container.drain();
      expect(await application(id)).toMatchObject({ stage: "withdrawn", toldState: "not_told" });
      const [msg] = await decisionRows(id);
      expect(msg.status).toBe("cancelled");
      expect(mailTo("abe@marks.test")).toHaveLength(0);
      expect(await container.db.select().from(events).where(and(eq(events.type, "message.cancelled"), eq(events.subjectId, msg.id)))).toHaveLength(1);
    });

    it("'review anyway' after an eligibility decline withdraws the decline message still on its way", async () => {
      const id = await seed("Bo", { stage: "ineligible" });
      expect((await act(owner, id, { action: "reject", reason: "eligibility", note: "Confirmed" })).status).toBe(200);
      expect((await queueDecision(id)).notice).toBe("queued");
      expect((await act(owner, id, { action: "review_anyway", note: "Answered in error" })).status).toBe(200);
      await container.drain();
      expect(await application(id)).toMatchObject({ toldState: "not_told" });
      expect((await application(id)).stage).not.toBe("rejected");
      expect((await decisionRows(id))[0].status).toBe("cancelled");
      expect(mailTo("bo@marks.test")).toHaveLength(0);
    });

    it("'I told them myself' settles a message still on its way, and withdraws it", async () => {
      const id = await seed("Cal");
      await decline(id);
      await queueDecision(id);
      expect((await detail(id)).allowedActions).toContain("told_in_person");
      expect(await (await act(owner, id, { action: "told_in_person", note: "Called him" })).json()).toMatchObject({ toldState: "told_in_person" });
      await container.drain();
      expect((await application(id)).toldState).toBe("told_in_person");
      expect((await decisionRows(id))[0].status).toBe("cancelled");
      expect(mailTo("cal@marks.test")).toHaveLength(0);
    });

    it("a send that was interrupted puts them back to not told, and tells the team to check before sending again", async () => {
      const id = await seed("Dot");
      await decline(id);
      await queueDecision(id);
      const [msg] = await decisionRows(id);
      // what a crash between the provider call and the record leaves behind
      await container.db.update(communications).set({ status: "sending", sendingAt: new Date(Date.now() - 20 * 60_000).toISOString() }).where(eq(communications.id, msg.id));
      expect(await sweepStaleSending(container.db, new Date())).toBeGreaterThanOrEqual(1);
      expect((await decisionRows(id))[0].status).toBe("unknown");
      expect((await application(id)).toldState).toBe("not_told");
      expect((await detail(id)).allowedActions).toEqual(expect.arrayContaining(["send_decision", "told_in_person"]));
      const note = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "candidate.unreachable")))).find((n) => n.action?.href.includes(id));
      expect(note?.title).toBe("A decision message may not have reached a candidate");
    });

    it("a decision message that bounces for good means they were not told after all", async () => {
      const id = await seed("Eve");
      await decline(id);
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
      await container.drain();
      expect((await application(id)).toldState).toBe("sent");
      const [msg] = await decisionRows(id);
      await withPlatform(container.db, (tx) => handleEmailEvent(tx, container.integrations, { event: { provider: "postmark", recordType: "Bounce", externalId: `Bounce:${msg.id}`, messageId: msg.providerMessageId, email: "eve@marks.test", type: "HardBounce", description: "The mailbox does not exist.", at: new Date().toISOString(), hard: true, complaint: false, soft: false, metadata: {} }, appBaseUrl: "http://localhost:3000", now: new Date() }));
      expect(await application(id)).toMatchObject({ toldState: "not_told", candidateToldAt: null });
    });

    const softBounce = (msg: { id: string; providerMessageId: string | null }, email: string) =>
      withPlatform(container.db, (tx) => handleEmailEvent(tx, container.integrations, { event: { provider: "postmark", recordType: "Bounce", externalId: `Bounce:soft:${msg.id}`, messageId: msg.providerMessageId, email, type: "SoftBounce", description: "The mailbox is full.", at: new Date().toISOString(), hard: false, complaint: false, soft: true, metadata: {} }, appBaseUrl: "http://localhost:3000", now: new Date() }));
    const retry = (communicationId: string) => withPlatform(container.db, (tx) => retryCommunication(tx, container.integrations, { communicationId, attempt: 1, now: new Date() }));
    const firstTry = async (id: string) => (await decisionRows(id)).filter((r) => !r.retryOf).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

    it("a decision message that keeps soft-bouncing until the address is stopped means they were not told after all", async () => {
      const id = await seed("Kit");
      await decline(id);
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
      await container.drain();
      expect((await application(id)).toldState).toBe("sent");
      const msg = await firstTry(id);
      // one soft bounce: it is tried again later, so it still counts as on its way
      expect(await softBounce(msg, "kit@marks.test")).toMatchObject({ action: "retry_scheduled" });
      expect((await application(id)).toldState).toBe("sent");
      // the retry goes and bounces too: the address is stopped, and nothing more will be tried
      await retry(msg.id);
      await container.drain();
      const again = (await decisionRows(id)).find((r) => r.retryOf === msg.id)!;
      expect(again.status).toBe("sent");
      expect(await softBounce(again, "kit@marks.test")).toMatchObject({ action: "suppressed" });
      expect(await application(id)).toMatchObject({ toldState: "not_told", candidateToldAt: null });
      expect((await detail(id)).allowedActions).toEqual(expect.arrayContaining(["send_decision", "told_in_person"]));
    });

    it("a retry that cannot go because the address was stopped meanwhile leaves them not told", async () => {
      const id = await seed("Hana");
      await decline(id);
      await act(owner, id, { action: "send_decision" });
      await container.drain();
      const msg = await firstTry(id);
      await softBounce(msg, "hana@marks.test");
      // another message to the same address soft-bounced this week: the address is stopped before the retry goes
      await withPlatform(container.db, (tx) => suppressAddress(tx, { address: "hana@marks.test", reason: "soft_bounce_repeated", source: "postmark", actor: { kind: "system", id: "test" }, companyId, now: new Date() }));
      await retry(msg.id);
      await container.drain();
      expect((await decisionRows(id)).find((r) => r.retryOf === msg.id)?.status).toBe("failed");
      expect(await application(id)).toMatchObject({ toldState: "not_told", candidateToldAt: null });
    });

    it("a soft-bounced decline is not tried again once the decision no longer applies, nor after it was taken back and made again", async () => {
      const back = await seed("Ivo");
      const redone = await seed("Jade");
      for (const id of [back, redone]) {
        await decline(id);
        await act(owner, id, { action: "send_decision" });
      }
      await container.drain();
      await softBounce(await firstTry(back), "ivo@marks.test");
      await softBounce(await firstTry(redone), "jade@marks.test");
      // both are put back in the process (what "review anyway" does); one is then declined again
      const reopen = (id: string) => withTenant(container.db, companyId, (tx) => transition(tx, { applicationId: id, companyId, to: "eligible", by: "owner", actor: { kind: "user", id: ownerId } }));
      await reopen(back);
      await reopen(redone);
      await decline(redone);
      const sentBefore = (container.integrations.email as FakeEmailAdapter).sent.length;
      for (const id of [back, redone]) {
        const msg = await firstTry(id);
        expect(await retry(msg.id)).toEqual({ queued: false, reason: "the decision no longer applies" });
        expect((await decisionRows(id)).filter((r) => r.retryOf === msg.id)).toHaveLength(0);
      }
      await container.drain();
      expect((container.integrations.email as FakeEmailAdapter).sent.length).toBe(sentBefore);
    });

    it("correcting an outcome from one decision to the other keeps whether they were told, so nobody is written to twice", async () => {
      const id = await seed("Flo");
      const r = await json(owner, "POST", `/api/v1/applications/${id}/outcome`, { outcome: "employer_declined", confirm: true, reason: "not_a_match_experience", note: "Not the right fit" });
      expect(r.status).toBe(201);
      const { outcomeId } = (await r.json()) as { outcomeId: string };
      expect((await act(owner, id, { action: "told_in_person" })).status).toBe(200);
      await withTenant(container.db, companyId, (tx) => correctOutcome(tx, { outcomeId, actor: { kind: "user", id: ownerId, name: "ITS admin" }, reason: "It was a no hire", outcome: "no_hire" }));
      expect(await application(id)).toMatchObject({ stage: "talent_pool", toldState: "told_in_person" });
      expect((await act(owner, id, { action: "send_decision" })).status).toBe(409);
    });
  });

  describe("privacy requests", () => {
    it("an access request shows a decision even before they were told; a deletion blanks the team's notes in the history too", async () => {
      const id = await seed("Ian");
      expect((await act(owner, id, { action: "set_mark", mark: "shortlist", note: "Lives near the Irvine office" })).status).toBe(200);
      await decline(id);
      const { candidateId } = await application(id);
      const exported = await withTenant(container.db, companyId, (tx) => exportCandidateData(tx, companyId, candidateId));
      expect((exported.applications as Array<Record<string, unknown>>)[0]).toMatchObject({ stage: "rejected", decisionTold: "not_told", decisionToldAt: null });
      await withTenant(container.db, companyId, (tx) => anonymizeCandidate(tx, { companyId, candidateId, actor: { kind: "system", id: "pipeline-marks.test" }, deleteFile: async () => undefined }));
      const history = await container.db.select().from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, id)));
      // what happened and who did it stay; the words the team wrote about the person go
      expect(history.some((e) => e.type === "application.marked")).toBe(true);
      expect(history.filter((e) => /Irvine office|Not this time/.test(JSON.stringify(e.payload)))).toEqual([]);
      expect((await marksOf(id)).every((m) => m.note === null)).toBe(true);
    });
  });

  describe("approving an interview moves someone on", () => {
    it("ends a hold even when they were already recommended for an interview (no stage change)", async () => {
      const id = await seed("Gia", { stage: "interview_recommended" });
      expect((await act(owner, id, { action: "hold" })).status).toBe(200);
      expect((await detail(id)).ownerStage).toBe("on_hold");
      const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
      const r = await json(owner, "POST", `/api/v1/applications/${id}/interviews`, { roundKey: role.currentPacket.packet.interviews.plan[0].key, interviewerUserIds: [ownerId], linkSource: "calendar" });
      expect(r.status, await r.clone().text()).toBe(201);
      const [m] = await marksOf(id);
      expect(m.clearedAt).toBeTruthy();
      expect(m.clearReason).toBe("moved on (interviewing)");
      expect((await detail(id)).ownerStage).toBe("interviewing");
    });
  });

  describe("the untold safety net (plan-adjustments §4, Q27)", () => {
    it("counts working days, Monday to Friday", () => {
      // Friday 10:00 UTC to Tuesday 10:00 UTC: Monday and Tuesday
      expect(workingDaysSince(new Date("2026-10-02T10:00:00Z"), new Date("2026-10-06T10:00:00Z"))).toBe(2);
      expect(workingDaysSince(new Date("2026-10-05T10:00:00Z"), new Date("2026-10-06T09:00:00Z"))).toBe(0);
      expect(workingDaysSince(new Date("2026-10-05T10:00:00Z"), new Date("2026-10-07T10:00:00Z"))).toBe(2);
    });

    it("reminds the team, by name and once, about a decision nobody has told for two working days; nothing is sent to the candidate", async () => {
      const id = await seed("Hal");
      await decline(id);
      const fresh = (await detectStuckRoles(container.db, companyId, new Date())).filter((d) => d.detector === "decisions_untold" && (d.applicationIds ?? []).includes(id));
      expect(fresh).toHaveLength(0);
      const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
      await container.db.update(applications).set({ rejectedAt: weekAgo, stageChangedAt: weekAgo }).where(eq(applications.id, id));
      const found = (await detectStuckRoles(container.db, companyId, new Date())).filter((d) => d.detector === "decisions_untold" && d.roleId === roleId);
      expect(found).toHaveLength(1);
      expect(found[0].applicationIds).toContain(id);
      expect(found[0].body).toContain("Hal Moss");
      // the reminder says what happens at five working days (Q27): the standard message by itself, or a recruiter instead
      expect(found[0].body).toMatch(/after 5 working days, the standard message goes by itself and you are told/);
      expect(found[0].body).toMatch(/a recruiter is brought in instead and nothing is sent/);
      expect(found[0].action.href).toBe(`/roles/${roleId}/talent?ownerStage=not_moving_forward&told=not_told`);
      const deps = { integrations: container.integrations, appBaseUrl: "http://localhost:3000", itsQueueEmail: "queue@its.test", now: new Date(), actor: { kind: "system" as const, id: "test" } };
      expect(await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, deps, companyId, found))).toContainEqual(expect.objectContaining({ detector: "decisions_untold", level: "brief" }));
      expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "stuck.decisions_untold")))).length).toBeGreaterThan(0);
      // never climbs to emails or a recruiter, and Today shows them on the "not told" card, not as a role at risk
      const later = { ...deps, now: new Date(Date.now() + 3 * DAY) };
      expect(await withTenant(container.db, companyId, (tx) => runInterventionLadder(tx, later, companyId, found))).toContainEqual(expect.objectContaining({ detector: "decisions_untold", level: "skipped" }));
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string }> };
      expect(brief.cards.some((c) => c.kind === "stuck" && /not been told/.test(c.title))).toBe(false);
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")))).toHaveLength(0);
    });
  });

  describe("the assistant's waiting suggestions (plan A6)", () => {
    const suggest = (applicationId: string, actionType: string) => withTenant(container.db, companyId, async (tx) => (await tx.insert(approvalRequests).values({ companyId, roleId, applicationId, actionType, subject: { type: "application", id: applicationId }, proposal: {}, requestedBy: { kind: "agent", id: "triage" }, requiredRoles: [] }).returning())[0].id);
    const statusOf = async (id: string) => (await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, id)))[0].status;

    it("are cancelled when a person holds or declines the candidate, approved when the person does what was suggested, and left waiting by the Longlist or Shortlist", async () => {
      const a = await seed("Rae");
      const invite = await suggest(a, "application.invite_screen");
      // sorting is not an answer to the suggestion: it keeps waiting for its own Yes or Not now
      await act(owner, a, { action: "set_mark", mark: "shortlist" });
      expect(await statusOf(invite)).toBe("pending");
      await act(owner, a, { action: "clear_mark" });
      expect(await statusOf(invite)).toBe("pending");
      // a hold is
      await act(owner, a, { action: "set_mark", mark: "on_hold" });
      expect(await statusOf(invite)).toBe("cancelled");
      expect((await container.db.select().from(events).where(and(eq(events.type, "approval.cancelled"), eq(events.subjectId, invite))))[0].payload).toMatchObject({ actionType: "application.invite_screen", by: "set_mark" });
      const b = await seed("Sol");
      const interview = await suggest(b, "application.recommend_interview");
      await decline(b);
      expect(await statusOf(interview)).toBe("cancelled");
      const c = await seed("Tia");
      const screen = await suggest(c, "application.invite_screen");
      const other = await suggest(c, "application.recommend_interview");
      expect((await act(owner, c, { action: "invite_screen", channel: "web" })).status).toBe(200);
      expect(await statusOf(screen)).toBe("approved");
      expect(await statusOf(other)).toBe("cancelled");
    });

    it("offer 'Not now' on Today, which turns the suggestion down and moves nobody", async () => {
      const id = await seed("Uma");
      const req = await suggest(id, "application.invite_screen");
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ approvalRequestId?: string; actions: Array<{ label: string; path: string; body?: Record<string, unknown> }> }> };
      const notNow = brief.cards.find((c) => c.approvalRequestId === req)!.actions.find((x) => x.label === "Not now")!;
      expect(notNow.body).toMatchObject({ decision: "reject" });
      expect((await json(owner, "POST", notNow.path, notNow.body)).status).toBe(200);
      expect(await statusOf(req)).toBe("rejected");
      expect((await application(id)).stage).toBe("triaged");
      // the candidate's History carries the answer, joined from the request (plan A10)
      const timeline = ((await (await json(owner, "GET", `/api/v1/applications/${id}`)).json()) as { timeline: Array<{ type: string; subjectId: string; payload: Record<string, unknown> }> }).timeline;
      expect(timeline.find((e) => e.type === "approval.denied" && e.subjectId === req)?.payload).toMatchObject({ actionType: "application.invite_screen", applicationId: id, note: "Not now" });
    });
  });

  describe("the role's list", () => {
    /**
     * Someone under Cancelled (founder decisions 1A to 4A): their interview cancelled by them, or missed, with an open
     * follow-up; `open` adds a new interview being set up for them (their new times are being prepared).
     */
    const underCancelled = (first: string, input: { kind: "candidate_cancelled" | "candidate_no_show"; choice: "new_times" | "not_interested" | null; promised?: boolean; open?: boolean }) =>
      withTenant(container.db, companyId, async (tx) => {
        const actor = { kind: "user" as const, id: ownerId, name: "Owner" };
        const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Moss", email: `${first.toLowerCase()}@marks.test`, firstSource: "direct" }).returning();
        const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: input.kind === "candidate_no_show" ? "interview_complete" : "interview_recommended", statusToken: randomToken(16) }).returning();
        const iv = (status: string, extra: Partial<typeof interviews.$inferInsert> = {}) => ({ companyId, applicationId: a.id, roundKey: "first", title: "First interview", format: "video", durationMinutes: 30, status, createdBy: actor, ...extra });
        const [missed] = await tx.insert(interviews).values(iv(input.kind === "candidate_no_show" ? "no_show" : "cancelled", { attempt: 2, outcome: input.kind === "candidate_no_show" ? "no_show_candidate" : null })).returning();
        if (input.open) await tx.insert(interviews).values(iv("scheduling"));
        const auto = input.promised ? { state: "waiting" as const, dueAt: new Date(Date.now() + 5 * DAY).toISOString(), workingDays: 3 } : { state: "none" as const, reason: input.kind === "candidate_no_show" ? ("no_show" as const) : ("not_asked" as const) };
        await openFollowUp(tx, { companyId, applicationId: a.id, interviewId: missed.id, interviewAttempt: 2, kind: input.kind, choice: input.choice, auto, actor });
        return a.id;
      });

    it("carries the strip, the mark, the dates and the stage button on every row, with the counts and filters", async () => {
      const shortlisted = await seed("Vic");
      await act(owner, shortlisted, { action: "set_mark", mark: "shortlist" });
      // under Cancelled: one promised new times (in process), one who did not come (waiting on you), one no longer
      // interested with new times being prepared by the team (in process)
      const quinn = await underCancelled("Quinn", { kind: "candidate_cancelled", choice: "new_times", promised: true });
      const rae = await underCancelled("Rae", { kind: "candidate_no_show", choice: null });
      const sol = await underCancelled("Sol", { kind: "candidate_cancelled", choice: "not_interested", open: true });
      const plain = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<Record<string, unknown>>;
      expect(Array.isArray(plain)).toBe(true);
      const withCounts = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?counts=1`)).json()) as { applications: Array<{ id: string; ownerStage: string; ownerStageLabel: string; group: string; mark: ActiveMark | null; appliedAt: string; stageChangedAt: string; daysInStage: number; toldState: string | null; stageMoves: StageMove[]; tags: string[]; cancelled: { reason: string; label: string; times: string; status: string } | null }>; counts: { total: number; byOwnerStage: Record<string, number>; byGroup: Record<string, number>; notTold: number; cancelled: { askedNewTimes: number; notInterested: number; noShow: number } } };
      expect(withCounts.applications).toHaveLength(plain.length);
      expect(withCounts.counts.total).toBe(plain.length);
      const byStage: Record<string, number> = {};
      for (const r of withCounts.applications) byStage[r.ownerStage] = (byStage[r.ownerStage] ?? 0) + 1;
      for (const [s, n] of Object.entries(withCounts.counts.byOwnerStage)) expect(n, s).toBe(byStage[s] ?? 0);
      expect(withCounts.counts.notTold).toBe(withCounts.applications.filter((r) => r.toldState === "not_told").length);
      const vic = withCounts.applications.find((r) => r.id === shortlisted)!;
      expect(vic).toMatchObject({ ownerStage: "shortlist", mark: { mark: "shortlist" }, toldState: null, daysInStage: 0 });
      expect(vic.appliedAt).toBeTruthy();
      expect(vic.stageMoves.find((m) => m.to === "new")).toMatchObject({ allowed: true, via: "clear_mark" });
      // under Cancelled: why, where their new times stand, the sub-label on the stage button, and the chips' counts
      const row = (id: string) => withCounts.applications.find((r) => r.id === id)!;
      expect(row(quinn)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "Asked for new times", group: "in_process", cancelled: { reason: "asked_new_times", label: "Asked for new times", times: "none" } });
      expect(row(quinn).cancelled!.status).toMatch(/^New times go out automatically [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
      expect(row(rae)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "No-show", group: "waiting_on_you", cancelled: { reason: "no_show", status: "Waiting for you" } });
      expect(row(sol)).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "No longer interested", group: "in_process", cancelled: { reason: "not_interested", times: "preparing", status: "Getting new times ready" } });
      expect(row(rae).stageMoves.find((m) => m.to === "cancelled")).toMatchObject({ current: true });
      expect(withCounts.applications.filter((r) => r.ownerStage !== "cancelled").every((r) => r.cancelled === null)).toBe(true);
      expect(withCounts.counts.byOwnerStage.cancelled).toBe(3);
      expect(withCounts.counts.cancelled).toEqual({ askedNewTimes: 1, notInterested: 1, noShow: 1 });
      const onlyCancelled = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?ownerStage=cancelled`)).json()) as Array<{ id: string; ownerStage: string }>;
      expect(onlyCancelled.map((r) => r.id).sort()).toEqual([quinn, rae, sol].sort());
      // one column of the strip, and decisions nobody has told
      const onlyShortlist = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?ownerStage=shortlist`)).json()) as Array<{ ownerStage: string }>;
      expect(onlyShortlist.length).toBeGreaterThan(0);
      expect(onlyShortlist.every((r) => r.ownerStage === "shortlist")).toBe(true);
      const untold = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?told=not_told`)).json()) as Array<{ toldState: string }>;
      expect(untold.length).toBe(withCounts.counts.notTold);
      // waiting longest first, by when they reached their step; never by an AI reading
      const old = await seed("Wes", { stageChangedAt: new Date(Date.now() - 40 * DAY).toISOString() });
      const waiting = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?order=waiting`)).json()) as Array<{ id: string; stageChangedAt: string }>;
      expect(waiting[0].id).toBe(old);
      expect(waiting.map((r) => r.stageChangedAt)).toEqual([...waiting.map((r) => r.stageChangedAt)].sort());
      expect(waiting.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(r.stageChangedAt))).toBe(true);
      // by match score too (founder decision B2; pool-board.test.ts has the order itself), but nothing else
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/applications?order=score`)).status).toBe(200);
      expect((await json(owner, "GET", `/api/v1/roles/${roleId}/applications?order=reading`)).status).toBe(400);
      // the roles list carries the strip too, and agrees, group counts included
      const now = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications?counts=1`)).json()) as { counts: { total: number; byOwnerStage: Record<string, number>; byGroup: Record<string, number> } };
      const roles = (await (await json(owner, "GET", "/api/v1/roles")).json()) as Array<{ id: string; stageCounts: Record<string, number>; counts: Record<string, number> }>;
      const mine = roles.find((r) => r.id === roleId)!;
      expect(mine.stageCounts).toEqual(now.counts.byOwnerStage);
      for (const [g, n] of Object.entries(now.counts.byGroup)) expect(mine.counts[g] ?? 0, g).toBe(n);
      expect(mine.counts.total).toBe(now.counts.total);
    });

    it("closing the role moves everyone still in it to the talent pool privately, marks cleared, and Today lists who to tell", async () => {
      const kept = await seed("Xia");
      await act(owner, kept, { action: "set_mark", mark: "shortlist" });
      const r = await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "filled", confirm: true, reason: "Hired from the shortlist." });
      expect(r.status).toBe(200);
      const xia = await application(kept);
      expect(xia).toMatchObject({ stage: "talent_pool", toldState: "not_told" });
      expect((await marksOf(kept)).every((m) => !!m.clearedAt)).toBe(true);
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, kept), like(communications.templateKey, "disposition:%")))).toHaveLength(0);
      const brief = (await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ title: string; roleId?: string }> };
      expect(brief.cards.some((c) => c.roleId === roleId && /not been told your decision yet/.test(c.title))).toBe(true);
    });
  });
});

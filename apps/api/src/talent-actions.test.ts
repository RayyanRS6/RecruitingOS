import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { ApplicationStage, MembershipRole } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { applications, candidates, communications, events, policies, randomToken, recruiterEscalations, screens, users, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationActionState, settlesSuggestions, stageMoves, type ApplicationFacts } from "./services/application-actions";
import { signInAs } from "./test-helpers";

/**
 * The Talent page's choices and what it says after them (plan 0.5, 0.6 and 0.9's scorecard card; founder decision B6:
 * decisions are private and the words say exactly whether the candidate was told). Every role sees only the choices its
 * permissions allow, with a plain reason on the rest (the stage button included); a decline is filed privately and the
 * later Send reports what became of its message under the company's settings; and a screen whose scorecard could not be
 * written says so.
 */
describe("the Talent page's actions: who may, why not, and what the candidate heard", () => {
  const facts = (over: Partial<ApplicationFacts> = {}): ApplicationFacts => ({ stage: "triaged", rejectReason: null, hasOpenScreen: false, hasActiveInterview: false, hasUndecidedInterview: false, role: "owner", openUnknowns: 0, ...over });

  describe("the rule itself", () => {
    it("gives each tenant role only the choices its permissions allow, and names who can do the rest", () => {
      const owner = applicationActionState(facts());
      expect(owner.allowed).toEqual(["invite_screen", "interview", "advance_to_interview", "hold", "move_to_talent_pool", "reject", "record_outcome", "set_mark"]);
      // HR may act on applications, sort them and record outcomes, but neither decline nor approve interviews, nor tell a decision
      const hr = applicationActionState(facts({ role: "hr" }));
      expect(hr.allowed).toEqual(["invite_screen", "advance_to_interview", "hold", "move_to_talent_pool", "record_outcome", "set_mark"]);
      expect(hr.blockedReasons.reject).toBe("Your role can't decline candidates; ask an owner, an admin, a hiring manager or a recruiter.");
      expect(hr.blockedReasons.interview).toBe("Your role can't approve interviews; ask an owner, an admin, a hiring manager or a recruiter.");
      expect(applicationActionState(facts({ role: "hr", stage: "rejected" })).blockedReasons.send_decision).toBe("Your role can't tell candidates about a decision; ask an owner, an admin, a hiring manager or a recruiter.");
      // a recruiter declines and interviews, but recording a hiring outcome is the customer's
      const recruiter = applicationActionState(facts({ role: "recruiter" }));
      expect(recruiter.allowed).toContain("reject");
      expect(recruiter.allowed).not.toContain("record_outcome");
      expect(recruiter.blockedReasons.record_outcome).toBe("Your role can't record hiring outcomes; ask an owner, an admin, a hiring manager or HR.");
      // an interviewer is offered nothing, and told why on each
      const interviewer = applicationActionState(facts({ role: "interviewer" }));
      expect(interviewer.allowed).toEqual([]);
      expect(Object.keys(interviewer.blockedReasons)).toHaveLength(16);
      // every choice not allowed has a reason, for every role
      for (const role of ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"] as MembershipRole[]) {
        const s = applicationActionState(facts({ role }));
        expect(s.allowed.length + Object.keys(s.blockedReasons).length, role).toBe(16);
        for (const reason of Object.values(s.blockedReasons)) expect(reason, role).not.toMatch(/_|undefined/);
      }
    });

    it("explains the state when the role is not the reason", () => {
      expect(applicationActionState(facts({ hasOpenScreen: true })).blockedReasons.invite_screen).toBe("A screening invitation is already open.");
      expect(applicationActionState(facts({ hasActiveInterview: true })).blockedReasons.interview).toBe("An interview is already in motion.");
      expect(applicationActionState(facts({ stage: "rejected" })).blockedReasons.reject).toBe("Not available at this step (Not moving forward).");
      expect(applicationActionState(facts({ stage: "talent_pool" })).blockedReasons.hold).toBe("They are already in your talent pool.");
      expect(applicationActionState(facts()).blockedReasons.ask_in_screen).toBe("The assessment left no open questions to ask about.");
      expect(applicationActionState(facts()).blockedReasons.record_decision).toBe("No finished interview is waiting for a decision.");
      expect(applicationActionState(facts()).blockedReasons.review_anyway).toBe("Only for someone declined on an eligibility answer.");
      // someone held on an eligibility answer is decided first: no hold, no mark (plan A4)
      expect(applicationActionState(facts({ stage: "ineligible" })).blockedReasons.hold).toBe("Check their eligibility answer first: keep them in or decline.");
      expect(applicationActionState(facts({ stage: "ineligible" })).blockedReasons.set_mark).toBe("Check their eligibility answer first: keep them in or decline.");
      expect(applicationActionState(facts()).blockedReasons.clear_mark).toBe("There is no mark to take off.");
      expect(applicationActionState(facts({ mark: "shortlist" })).allowed).toContain("clear_mark");
      // telling a decision: only after one, once, and not while a message waits for approval
      expect(applicationActionState(facts()).blockedReasons.send_decision).toBe("Only after a decision not to move forward.");
      expect(applicationActionState(facts({ stage: "rejected" })).allowed).toEqual(expect.arrayContaining(["send_decision", "told_in_person"]));
      expect(applicationActionState(facts({ stage: "talent_pool" })).allowed).toEqual(expect.arrayContaining(["send_decision", "told_in_person"]));
      expect(applicationActionState(facts({ stage: "rejected", decisionMessagePending: true })).blockedReasons.send_decision).toBe("The decision message is waiting for approval.");
      expect(applicationActionState(facts({ stage: "rejected", decisionMessagePending: true })).allowed).toContain("told_in_person");
      expect(applicationActionState(facts({ stage: "rejected", toldState: "queued" })).blockedReasons.send_decision).toBe("The decision message is on its way.");
      expect(applicationActionState(facts({ stage: "rejected", toldState: "sent" })).blockedReasons.told_in_person).toBe("They have been sent the decision message.");
      expect(applicationActionState(facts({ stage: "rejected", toldState: "told_in_person" })).blockedReasons.send_decision).toBe("Someone recorded telling them in person.");
      // a message on its way can still be settled by "I told them myself"; a decision from before told-tracking is told
      expect(applicationActionState(facts({ stage: "rejected", toldState: "queued" })).allowed).toContain("told_in_person");
      expect(applicationActionState(facts({ stage: "rejected", toldState: "before_tracking" })).allowed).not.toEqual(expect.arrayContaining(["send_decision"]));
      expect(applicationActionState(facts({ stage: "rejected", toldState: "before_tracking" })).blockedReasons.told_in_person).toMatch(/before decisions became private/);
      // the role comes first: it holds whatever the state
      expect(applicationActionState(facts({ role: "hr", stage: "rejected" })).blockedReasons.reject).toMatch(/^Your role can't decline candidates/);
      // "Stop this screen invitation" (plan A7): only before they start, and only for those who may write to candidates about decisions
      expect(applicationActionState(facts({ stage: "screen_invited", hasOpenScreen: true, hasUnstartedScreen: true })).allowed).toContain("cancel_screen");
      expect(applicationActionState(facts({ stage: "screening", hasOpenScreen: true })).blockedReasons.cancel_screen).toBe("They have started the screening conversation, so it can't be stopped now.");
      expect(applicationActionState(facts()).blockedReasons.cancel_screen).toBe("No screening invitation is waiting for them.");
      expect(applicationActionState(facts({ role: "hr", stage: "screen_invited", hasOpenScreen: true, hasUnstartedScreen: true })).blockedReasons.cancel_screen).toBe("Your role can't stop a screening invitation; ask an owner, an admin, a hiring manager or a recruiter.");
    });

    it("builds the stage button from the same rule: every stage, how it is reached, and why not", () => {
      const moves = (over: Partial<ApplicationFacts> = {}) => Object.fromEntries(stageMoves(facts(over)).map((m) => [m.to, m]));
      const owner = moves();
      expect(Object.keys(owner)).toEqual(["new", "longlist", "shortlist", "interviewing", "on_hold", "offer", "hired", "not_moving_forward"]);
      expect(owner.new).toMatchObject({ current: true, allowed: false, via: "none" });
      expect(owner.shortlist).toMatchObject({ allowed: true, via: "set_mark", mark: "shortlist", label: "Shortlist" });
      expect(owner.on_hold).toMatchObject({ allowed: true, via: "set_mark", mark: "on_hold" });
      expect(owner.interviewing).toMatchObject({ allowed: true, via: "interview" });
      expect(owner.hired).toMatchObject({ allowed: true, via: "record_hire" });
      expect(owner.not_moving_forward).toMatchObject({ allowed: true, via: "decline" });
      expect(owner.offer).toMatchObject({ allowed: false, via: "offer", blockedReason: "Offers are made outside the app for now; when they accept, choose Hired." });
      // on the shortlist, choosing New takes the mark off
      const listed = moves({ mark: "shortlist" });
      expect(listed.shortlist.current).toBe(true);
      expect(listed.new).toMatchObject({ allowed: true, via: "clear_mark" });
      // interviewing and on hold: Interviewing releases the hold; the longlist is behind them
      const held = moves({ stage: "interview_scheduled", hasActiveInterview: true, mark: "on_hold", markRemindAt: "2026-11-01T15:00:00Z" });
      expect(held.on_hold.current).toBe(true);
      expect(held.interviewing).toMatchObject({ allowed: true, via: "clear_mark" });
      expect(held.longlist).toMatchObject({ allowed: false, blockedReason: "They are interviewing already." });
      expect(held.new).toMatchObject({ allowed: false, blockedReason: "They are past this step." });
      // HR sees the stages it cannot reach, with the reason
      expect(moves({ role: "hr" }).not_moving_forward).toMatchObject({ allowed: false, blockedReason: expect.stringMatching(/^Your role can't decline candidates/) });
      expect(moves({ role: "interviewer" }).shortlist).toMatchObject({ allowed: false, blockedReason: expect.stringMatching(/^Your role can't sort candidates/) });
      // held on an eligibility answer: decided first, and declined from that answer's own card (plan A2), never the general decline
      expect(moves({ stage: "ineligible" }).longlist).toMatchObject({ allowed: false, blockedReason: "Check their eligibility answer first: keep them in or decline." });
      expect(moves({ stage: "ineligible" }).not_moving_forward).toMatchObject({ allowed: false, via: "decline", blockedReason: "Check their eligibility answer first: keep them in or decline." });
      // the eligibility card's own decline is still allowed
      expect(applicationActionState(facts({ stage: "ineligible" })).allowed).toContain("reject");
      // set aside as not a fit for now: shown as Not moving forward, and a decline is still a separate choice
      expect(moves({ mark: "not_a_fit_for_now" }).not_moving_forward).toMatchObject({ current: true, allowed: true, via: "decline" });
      expect(moves({ mark: "not_a_fit_for_now" }).new).toMatchObject({ allowed: true, via: "clear_mark" });
    });

    it("without a known role (a system caller) only the state counts", () => {
      expect(applicationActionState(facts({ role: null })).allowed).toContain("reject");
    });

    it("settles the assistant's waiting suggestions only on a decline, a hold or a person's own invitation or move (plan A6)", () => {
      for (const action of ["reject", "move_to_talent_pool", "hold", "invite_screen", "ask_in_screen", "advance_to_interview"] as const) expect(settlesSuggestions({ action }), action).toBe(true);
      expect(settlesSuggestions({ action: "set_mark", mark: "on_hold" })).toBe(true);
      expect(settlesSuggestions({ action: "set_mark", mark: "not_a_fit_for_now" })).toBe(true);
      // sorting and telling leave the suggestion waiting for its own Yes or Not now
      expect(settlesSuggestions({ action: "set_mark", mark: "shortlist" })).toBe(false);
      expect(settlesSuggestions({ action: "set_mark", mark: "longlist" })).toBe(false);
      for (const action of ["clear_mark", "send_decision", "told_in_person", "cancel_screen", "override_eligibility", "review_anyway"] as const) expect(settlesSuggestions({ action }), action).toBe(false);
    });
  });

  describe("over HTTP", () => {
    let container: Container;
    let app: ReturnType<typeof createApp>;
    let owner = "";
    let ownerId = "";
    let hr = "";
    let recruiter = "";
    let companyId = "";
    let roleId = "";
    const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
    type Detail = { allowedActions: string[]; blockedReasons: Record<string, string>; declineMessage: string; screens: Array<{ id: string; status: string; scorecard?: string; recruiterAsked?: boolean }> };
    const detail = async (cookie: string, id: string) => (await (await json(cookie, "GET", `/api/v1/applications/${id}`)).json()) as Detail;
    const act = async (cookie: string, id: string, body: Record<string, unknown>) => json(cookie, "POST", `/api/v1/applications/${id}/actions`, body);
    const seed = (first: string, input: { email?: string | null; stage?: ApplicationStage } = {}) =>
      withTenant(container.db, companyId, async (tx) => {
        const email = input.email === undefined ? `${first.toLowerCase()}@candidate.test` : input.email;
        const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Lane", email, firstSource: "direct" }).returning();
        const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: input.stage ?? "triaged", statusToken: randomToken(16) }).returning();
        return a.id;
      });
    const setDeclinePolicy = (level: "approval" | "human_only" | null) =>
      withTenant(container.db, companyId, async (tx) => {
        await tx.delete(policies).where(and(eq(policies.companyId, companyId), eq(policies.actionType, "disposition.send")));
        if (level) await tx.insert(policies).values({ companyId, roleId: null, actionType: "disposition.send", level, approverRoles: ["owner"], createdBy: { kind: "user", id: ownerId } });
      });

    beforeAll(async () => {
      container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
      app = createApp(container);
      const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@talent-actions.test" }) });
      const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
      owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
      ownerId = (await container.db.select().from(users).where(eq(users.email, "owner@talent-actions.test")))[0].id;
      companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Talent Actions Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
      await entitlements.applyPlan(container.db, companyId, "growth");
      const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
      roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
      expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
      await container.drain();
      hr = await signInAs(container, app, { companyId, role: "hr" });
      recruiter = await signInAs(container, app, { companyId, role: "recruiter" });
    });
    afterAll(async () => {
      await container.close();
    });

    it("HR sees no Decline, with the reason on it, and the route refuses; a recruiter cannot record an outcome", async () => {
      const id = await seed("Hana");
      const asHr = await detail(hr, id);
      expect(asHr.allowedActions).not.toContain("reject");
      expect(asHr.allowedActions).toContain("hold");
      expect(asHr.blockedReasons.reject).toMatch(/^Your role can't decline candidates; ask an owner/);
      expect((await act(hr, id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(403);
      const asRecruiter = await detail(recruiter, id);
      expect(asRecruiter.allowedActions).toContain("reject");
      expect(asRecruiter.allowedActions).not.toContain("record_outcome");
      expect(asRecruiter.blockedReasons.record_outcome).toMatch(/record hiring outcomes/);
      expect((await json(recruiter, "POST", `/api/v1/applications/${id}/outcome`, { outcome: "candidate_withdrew", confirm: true })).status).toBe(403);
      // the owner may do all of it, and is told before a decline what the candidate will get
      const asOwner = await detail(owner, id);
      expect(asOwner.allowedActions).toEqual(expect.arrayContaining(["reject", "hold", "record_outcome"]));
      expect(asOwner.blockedReasons.reject).toBeUndefined();
      expect(asOwner.declineMessage).toBe("sends");
    });

    it("a decline is private under every setting; the Send says exactly what became of the message; a hold says the candidate was not told", async () => {
      type Result = { stage: string; dispositionSent: boolean; candidateNotice: string; toldState: string };
      const decline = async (id: string) => (await (await act(owner, id, { action: "reject", reason: "not_a_match_experience", note: "Not this time." })).json()) as Result;
      const send = async (id: string) => (await (await act(owner, id, { action: "send_decision" })).json()) as Result;
      const messages = (id: string) => container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "disposition:human")));
      // the default: declining sends nothing (founder decision B6); the Send queues the message
      const sam = await seed("Sam");
      expect(await decline(sam)).toMatchObject({ stage: "rejected", dispositionSent: false, candidateNotice: "not_told", toldState: "not_told" });
      expect(await messages(sam)).toHaveLength(0);
      expect(await send(sam)).toMatchObject({ dispositionSent: true, candidateNotice: "queued", toldState: "queued" });
      expect(await messages(sam)).toHaveLength(1);
      // no address on file: nothing can go, and the page says so
      const noel = await seed("Noel", { email: null });
      expect(await decline(noel)).toMatchObject({ candidateNotice: "not_told" });
      expect(await send(noel)).toMatchObject({ dispositionSent: false, candidateNotice: "not_sent_no_email", toldState: "not_told" });
      // "ask me first": the Send waits for an approver
      await setDeclinePolicy("approval");
      const waiting = await seed("Wren");
      expect((await detail(owner, waiting)).declineMessage).toBe("needs_approval");
      expect(await decline(waiting)).toMatchObject({ dispositionSent: false, candidateNotice: "not_told" });
      expect(await send(waiting)).toMatchObject({ dispositionSent: false, candidateNotice: "waiting_approval", toldState: "not_told" });
      // "only a person": nothing is ever sent and the candidate is not told
      await setDeclinePolicy("human_only");
      const held = await seed("Hal");
      expect((await detail(owner, held)).declineMessage).toBe("not_sent");
      expect(await decline(held)).toMatchObject({ dispositionSent: false, candidateNotice: "not_told" });
      expect(await send(held)).toMatchObject({ dispositionSent: false, candidateNotice: "not_sent_settings" });
      expect(await messages(held)).toHaveLength(0);
      await setDeclinePolicy(null);
      // a hold and a mark for interview never reach the candidate
      const kept = await seed("Kit");
      expect(await (await act(owner, kept, { action: "hold", note: "Holding for now" })).json()).toMatchObject({ candidateNotice: "not_told", mark: { mark: "on_hold" }, ownerStage: "on_hold" });
      expect(await (await act(owner, kept, { action: "advance_to_interview" })).json()).toMatchObject({ stage: "interview_recommended", candidateNotice: "not_told" });
    });

    it("declining someone held on an eligibility answer is private too; the Send uses the eligibility wording", async () => {
      const id = await seed("Ena", { stage: "ineligible" });
      const r = (await (await act(owner, id, { action: "reject", reason: "eligibility", note: "Confirmed after the eligibility hold" })).json()) as { candidateNotice: string };
      expect(r.candidateNotice).toBe("not_told");
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")))).toHaveLength(0);
      expect(await (await act(owner, id, { action: "send_decision" })).json()).toMatchObject({ candidateNotice: "queued" });
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), eq(communications.templateKey, "disposition:eligibility")))).toHaveLength(1);
    });

    it("moving someone who asked not to be kept for future roles takes them off the role but never into the talent pool", async () => {
      const keptOut = await seed("Opal");
      const [{ candidateId }] = await container.db.select({ candidateId: applications.candidateId }).from(applications).where(eq(applications.id, keptOut));
      await container.db.update(candidates).set({ preferences: { talentPoolOptOut: true } }).where(eq(candidates.id, candidateId));
      expect((await (await json(owner, "GET", `/api/v1/applications/${keptOut}`)).json()) as { candidate: { preferences: { talentPoolOptOut?: boolean } } }).toMatchObject({ candidate: { preferences: { talentPoolOptOut: true } } });
      const r = await (await act(owner, keptOut, { action: "move_to_talent_pool" })).json();
      expect(r).toMatchObject({ stage: "talent_pool", candidateNotice: "not_told", talentPoolOptOut: true });
      const [opal] = await container.db.select().from(candidates).where(eq(candidates.id, candidateId));
      expect(opal.inTalentPool).toBe(false);
      expect(opal.preferences.talentPoolOptOut).toBe(true);
      const [moved] = await container.db.select().from(events).where(and(eq(events.type, "application.moved_to_talent_pool"), eq(events.subjectId, keptOut)));
      expect(moved.payload).toEqual({ talentPoolOptOut: true });
      // anyone else is kept, as before
      const kept = await seed("Pia");
      const k = await (await act(owner, kept, { action: "move_to_talent_pool" })).json();
      expect(k).toMatchObject({ stage: "talent_pool", candidateNotice: "not_told" });
      expect(k).not.toHaveProperty("talentPoolOptOut");
      const [{ candidateId: piaId }] = await container.db.select({ candidateId: applications.candidateId }).from(applications).where(eq(applications.id, kept));
      expect((await container.db.select().from(candidates).where(eq(candidates.id, piaId)))[0].inTalentPool).toBe(true);
      // the role report's "In your talent pool" counts Pia, never Opal
      const report = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/report`)).json()) as { outcomes: { talentPool: number } };
      expect(report.outcomes.talentPool).toBe(1);
    });

    it("recording 'we declined the candidate' as an outcome is private like the Decline button, and says so", async () => {
      const id = await seed("Oli");
      const r = (await (await json(owner, "POST", `/api/v1/applications/${id}/outcome`, { outcome: "employer_declined", confirm: true, reason: "Went with someone closer" })).json()) as { dispositionSent: boolean; candidateNotice: string };
      expect(r).toMatchObject({ dispositionSent: false, candidateNotice: "not_told" });
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, id), like(communications.templateKey, "disposition:%")))).toHaveLength(0);
      expect((await detail(owner, id)).allowedActions).toContain("send_decision");
      const noHire = await seed("Nia");
      expect(await (await json(owner, "POST", `/api/v1/applications/${noHire}/outcome`, { outcome: "no_hire", confirm: true })).json()).toMatchObject({ candidateNotice: "not_told" });
      const withdrew = await seed("Wil");
      expect(await (await json(owner, "POST", `/api/v1/applications/${withdrew}/outcome`, { outcome: "candidate_withdrew", confirm: true })).json()).not.toHaveProperty("candidateNotice");
    });

    it("a finished screen whose scorecard could not be written says so, and that ITS was asked", async () => {
      const id = await seed("Sky");
      expect((await act(owner, id, { action: "invite_screen", channel: "web" })).status).toBe(200);
      await container.drain();
      const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, id));
      expect(scr.workflowRunId).toBeTruthy();
      expect((await detail(owner, id)).screens[0]).toMatchObject({ status: "invited", scorecard: "none", recruiterAsked: false });
      // the candidate finishes; the assistant's scorecard is unusable twice, so the run gives up and asks ITS
      await withTenant(container.db, companyId, async (tx) => {
        await tx.update(screens).set({ status: "completed", completedAt: new Date().toISOString() }).where(eq(screens.id, scr.id));
        await tx.update(applications).set({ stage: "screen_complete" }).where(eq(applications.id, id));
        await container.engine.signal(tx, { companyId, key: `screen:${scr.id}:completed` });
      });
      // finished, and the scorecard not written yet: the page says nothing is wrong
      expect((await detail(owner, id)).screens[0]).toMatchObject({ status: "completed", scorecard: "writing", recruiterAsked: false });
      // The assistant's answer is unusable twice (the runner asks again once); the step says trying again cannot help, so
      // the run gives up on the first try instead of spending more model calls: no retry is ever scheduled.
      container.fake!.failNext("screen.assess", "invalid");
      container.fake!.failNext("screen.assess", "invalid");
      await container.drain();
      container.fake!.clearScripts();
      const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, scr.workflowRunId!));
      expect(run.status).toBe("failed");
      expect(await container.db.select().from(events).where(and(eq(events.type, "workflow.retried"), eq(events.subjectId, run.id)))).toHaveLength(0);
      expect(run.escalationId).toBeTruthy();
      expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, run.escalationId!)))[0].applicationId).toBe(id);
      expect((await detail(owner, id)).screens[0]).toMatchObject({ status: "completed", scorecard: "unavailable", recruiterAsked: true });
    });
  });
});

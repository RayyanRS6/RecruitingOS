import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ApplicationStage, MembershipRole } from "@ros/contracts";
import { entitlements } from "@ros/core";
import { applications, candidates, communications, events, policies, randomToken, recruiterEscalations, screens, users, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationActionState, type ApplicationFacts } from "./services/application-actions";
import { signInAs } from "./test-helpers";

/**
 * The Talent page's choices and what it says after them (plan 0.5, 0.6 and 0.9's scorecard card; founder decision B6:
 * decisions are private and the words say exactly whether the candidate was told). Every role sees only the choices its
 * permissions allow, with a plain reason on the rest; a decline reports what became of its message under the company's
 * settings; and a screen whose scorecard could not be written says so.
 */
describe("the Talent page's actions: who may, why not, and what the candidate heard", () => {
  const facts = (over: Partial<ApplicationFacts> = {}): ApplicationFacts => ({ stage: "triaged", rejectReason: null, hasOpenScreen: false, hasActiveInterview: false, hasUndecidedInterview: false, role: "owner", openUnknowns: 0, ...over });

  describe("the rule itself", () => {
    it("gives each tenant role only the choices its permissions allow, and names who can do the rest", () => {
      const owner = applicationActionState(facts());
      expect(owner.allowed).toEqual(["invite_screen", "interview", "advance_to_interview", "hold", "move_to_talent_pool", "reject", "record_outcome"]);
      // HR may act on applications and record outcomes, but neither decline nor approve interviews
      const hr = applicationActionState(facts({ role: "hr" }));
      expect(hr.allowed).toEqual(["invite_screen", "advance_to_interview", "hold", "move_to_talent_pool", "record_outcome"]);
      expect(hr.blockedReasons.reject).toBe("Your role can't decline candidates; ask an owner, an admin, a hiring manager or a recruiter.");
      expect(hr.blockedReasons.interview).toBe("Your role can't approve interviews; ask an owner, an admin, a hiring manager or a recruiter.");
      // a recruiter declines and interviews, but recording a hiring outcome is the customer's
      const recruiter = applicationActionState(facts({ role: "recruiter" }));
      expect(recruiter.allowed).toContain("reject");
      expect(recruiter.allowed).not.toContain("record_outcome");
      expect(recruiter.blockedReasons.record_outcome).toBe("Your role can't record hiring outcomes; ask an owner, an admin, a hiring manager or HR.");
      // an interviewer is offered nothing, and told why on each
      const interviewer = applicationActionState(facts({ role: "interviewer" }));
      expect(interviewer.allowed).toEqual([]);
      expect(Object.keys(interviewer.blockedReasons)).toHaveLength(11);
      // every choice not allowed has a reason, for every role
      for (const role of ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"] as MembershipRole[]) {
        const s = applicationActionState(facts({ role }));
        expect(s.allowed.length + Object.keys(s.blockedReasons).length, role).toBe(11);
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
      // the role comes first: it holds whatever the state
      expect(applicationActionState(facts({ role: "hr", stage: "rejected" })).blockedReasons.reject).toMatch(/^Your role can't decline candidates/);
    });

    it("without a known role (a system caller) only the state counts", () => {
      expect(applicationActionState(facts({ role: null })).allowed).toContain("reject");
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

    it("a decline says exactly what became of the message, under each setting; a hold says the candidate was not told", async () => {
      const decline = async (id: string) => (await (await act(owner, id, { action: "reject", reason: "not_a_match_experience", note: "Not this time." })).json()) as { stage: string; dispositionSent: boolean; candidateNotice: string };
      // the default: the message goes
      const sent = await decline(await seed("Sam"));
      expect(sent).toMatchObject({ stage: "rejected", dispositionSent: true, candidateNotice: "queued" });
      // no address on file: nothing can go, and the page says so
      expect(await decline(await seed("Noel", { email: null }))).toMatchObject({ dispositionSent: false, candidateNotice: "not_sent_no_email" });
      // "ask me first": it waits for an approver
      await setDeclinePolicy("approval");
      const waiting = await seed("Wren");
      expect((await detail(owner, waiting)).declineMessage).toBe("needs_approval");
      expect(await decline(waiting)).toMatchObject({ dispositionSent: false, candidateNotice: "pending_approval" });
      // "only a person": nothing is sent and the candidate is not told
      await setDeclinePolicy("human_only");
      const held = await seed("Hal");
      expect((await detail(owner, held)).declineMessage).toBe("not_sent");
      expect(await decline(held)).toMatchObject({ dispositionSent: false, candidateNotice: "not_sent_settings" });
      expect(await container.db.select().from(communications).where(and(eq(communications.applicationId, held), eq(communications.templateKey, "disposition:human")))).toHaveLength(0);
      await setDeclinePolicy(null);
      // a hold and a mark for interview never reach the candidate
      const kept = await seed("Kit");
      expect(await (await act(owner, kept, { action: "hold", note: "Holding for now" })).json()).toMatchObject({ candidateNotice: "not_told" });
      expect(await (await act(owner, kept, { action: "advance_to_interview" })).json()).toMatchObject({ stage: "interview_recommended", candidateNotice: "not_told" });
    });

    it("declining someone held on an eligibility answer sends the eligibility wording and reports it the same way", async () => {
      const id = await seed("Ena", { stage: "ineligible" });
      const r = (await (await act(owner, id, { action: "reject", reason: "eligibility", note: "Confirmed after the eligibility hold" })).json()) as { candidateNotice: string };
      expect(r.candidateNotice).toBe("queued");
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

    it("recording 'we declined the candidate' as an outcome reports the message too", async () => {
      const id = await seed("Oli");
      const r = (await (await json(owner, "POST", `/api/v1/applications/${id}/outcome`, { outcome: "employer_declined", confirm: true, reason: "Went with someone closer" })).json()) as { dispositionSent: boolean; candidateNotice: string };
      expect(r).toMatchObject({ dispositionSent: true, candidateNotice: "queued" });
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

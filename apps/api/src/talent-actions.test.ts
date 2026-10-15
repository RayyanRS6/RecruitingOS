import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { ApplicationStage, MembershipRole } from "@ros/contracts";
import { entitlements, openFollowUp, type FollowUpStrip } from "@ros/core";
import { SCORECARD_READINGS, newTimesDayWords } from "@ros/agents";
import { applications, candidates, communications, companies, events, interviewFollowups, interviews, policies, randomToken, recruiterEscalations, screens, users, withTenant, workflowRuns } from "@ros/db";
import { armNewTimes } from "@ros/workflows";
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
      expect(Object.keys(interviewer.blockedReasons)).toHaveLength(20);
      // every choice not allowed has a reason, for every role
      for (const role of ["owner", "admin", "hiring_manager", "hr", "recruiter", "interviewer"] as MembershipRole[]) {
        const s = applicationActionState(facts({ role }));
        expect(s.allowed.length + Object.keys(s.blockedReasons).length, role).toBe(20);
        for (const reason of Object.values(s.blockedReasons)) expect(reason, role).not.toMatch(/_|undefined/);
      }
    });

    it("explains the state when the role is not the reason", () => {
      expect(applicationActionState(facts({ hasOpenScreen: true })).blockedReasons.invite_screen).toBe("A screening chat invitation is already open.");
      expect(applicationActionState(facts({ hasActiveInterview: true })).blockedReasons.interview).toBe("An interview is already in motion.");
      expect(applicationActionState(facts({ stage: "rejected" })).blockedReasons.reject).toBe("Not available at this step (Not moving forward).");
      expect(applicationActionState(facts({ stage: "talent_pool" })).blockedReasons.hold).toBe("They are already in your talent pool.");
      expect(applicationActionState(facts()).blockedReasons.ask_in_screen).toBe("The AI review left no open questions to ask about.");
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
      expect(applicationActionState(facts({ stage: "screening", hasOpenScreen: true })).blockedReasons.cancel_screen).toBe("They have started the screening chat, so it can't be stopped now.");
      expect(applicationActionState(facts()).blockedReasons.cancel_screen).toBe("No screening chat invitation is waiting for them.");
      expect(applicationActionState(facts({ role: "hr", stage: "screen_invited", hasOpenScreen: true, hasUnstartedScreen: true })).blockedReasons.cancel_screen).toBe("Your role can't stop a screening chat invitation; ask an owner, an admin, a hiring manager or a recruiter.");
    });

    it("builds the stage button from the same rule: every stage, how it is reached, and why not", () => {
      const moves = (over: Partial<ApplicationFacts> = {}) => Object.fromEntries(stageMoves(facts(over)).map((m) => [m.to, m]));
      const owner = moves();
      expect(Object.keys(owner)).toEqual(["new", "longlist", "shortlist", "interviewing", "cancelled", "on_hold", "offer", "hired", "not_moving_forward"]);
      // nobody is moved into Cancelled by hand: never the decline the default would open
      expect(owner.cancelled).toMatchObject({ allowed: false, via: "none", label: "Cancelled", blockedReason: "Only the candidate's own cancellation, or an interview they missed, puts someone here." });
      expect(owner.new).toMatchObject({ current: true, allowed: false, via: "none" });
      expect(owner.shortlist).toMatchObject({ allowed: true, via: "set_mark", mark: "shortlist", label: "Shortlist" });
      expect(owner.on_hold).toMatchObject({ allowed: true, via: "set_mark", mark: "on_hold" });
      expect(owner.interviewing).toMatchObject({ allowed: true, via: "interview" });
      expect(owner.hired).toMatchObject({ allowed: true, via: "record_hire" });
      expect(owner.not_moving_forward).toMatchObject({ allowed: true, via: "decline" });
      // Offer opens the record-only "Offer made" (plan H2): for a finalist, by those who record outcomes; before that, why not
      expect(owner.offer).toMatchObject({ allowed: false, via: "offer", blockedReason: 'Record an offer once they are a finalist (they are at "Ready for your review").' });
      expect(moves({ stage: "finalist" }).offer).toMatchObject({ allowed: true, via: "offer" });
      expect(moves({ stage: "reference_check" }).offer).toMatchObject({ allowed: true, via: "offer" });
      expect(moves({ stage: "finalist", role: "recruiter" }).offer).toMatchObject({ allowed: false, blockedReason: "Your role can't record that an offer was made; ask an owner, an admin, a hiring manager or HR." });
      expect(moves({ stage: "rejected" }).offer).toMatchObject({ allowed: false, blockedReason: "Not available at this step (Not moving forward)." });
      expect(applicationActionState(facts({ stage: "finalist" })).allowed).toContain("record_offer");
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

    it("a decision nobody told can be taken back to the step it was made from, by those who decide; never once told (plan G1)", () => {
      const declined = (over: Partial<ApplicationFacts> = {}) => facts({ stage: "rejected", rejectReason: "not_a_match_experience", toldState: "not_told", decidedFrom: "screen_invited", ...over });
      expect(applicationActionState(declined()).allowed).toContain("undo_decision");
      expect(applicationActionState(declined({ stage: "talent_pool", rejectReason: null, decidedFrom: "finalist" })).allowed).toContain("undo_decision");
      // the stage button offers the step it was made from; everything else stays blocked
      const moves = Object.fromEntries(stageMoves(declined()).map((m) => [m.to, m]));
      expect(moves.new).toMatchObject({ allowed: true, via: "undo_decision" });
      expect(moves.shortlist.allowed).toBe(false);
      expect(Object.fromEntries(stageMoves(declined({ decidedFrom: "interview_scheduled" })).map((m) => [m.to, m])).interviewing).toMatchObject({ allowed: true, via: "undo_decision" });
      // declined from Cancelled: taking it back puts them back there, so the choice sits on the Cancelled row, not on Interviewing
      const fromCancelled = Object.fromEntries(stageMoves(declined({ decidedFrom: "interview_recommended", undoToCancelled: true })).map((m) => [m.to, m]));
      expect(fromCancelled.cancelled).toMatchObject({ allowed: true, via: "undo_decision", label: "Cancelled" });
      expect(fromCancelled.interviewing.allowed).toBe(false);
      // never once they were told or a message is on its way, nor while one waits for approval, nor on a closed role
      expect(applicationActionState(declined({ toldState: "sent" })).blockedReasons.undo_decision).toBe("They have been told, or the message is on its way, so the decision can't be taken back here.");
      expect(applicationActionState(declined({ toldState: "queued" })).allowed).not.toContain("undo_decision");
      expect(applicationActionState(declined({ decisionMessagePending: true })).blockedReasons.undo_decision).toBe("The decision message is waiting for approval; turn it down first.");
      expect(applicationActionState(declined({ roleClosed: true })).blockedReasons.undo_decision).toBe("The role is closed.");
      // an eligibility decline has its own "Review anyway"; and where it was made from is not known on a list, so not offered
      expect(applicationActionState(declined({ rejectReason: "eligibility" })).blockedReasons.undo_decision).toBe("Use Review anyway: it reads their application again.");
      expect(applicationActionState(declined({ decidedFrom: undefined })).allowed).not.toContain("undo_decision");
      expect(applicationActionState(facts()).blockedReasons.undo_decision).toBe("Only for a decision not to move forward.");
      expect(applicationActionState(declined({ role: "hr" })).blockedReasons.undo_decision).toMatch(/^Your role can't take back a decision/);
    });

    it("under Cancelled: new times while nothing is in motion, stop while a set waits for its day, and the stage button (founder decisions 1A to 4A)", () => {
      const asked: FollowUpStrip = { reason: "asked_new_times", autoState: "waiting", interviewOpen: false };
      const under = (over: Partial<ApplicationFacts> = {}, f: Partial<FollowUpStrip> = {}) => facts({ stage: "interview_recommended", followUp: { ...asked, ...f }, ...over });
      // a promised set: they can be sent times now, or the set stopped
      expect(applicationActionState(under()).allowed).toEqual(expect.arrayContaining(["send_new_times", "stop_new_times"]));
      // nothing promised (they said no, did not come, or the set ended): new times, nothing to stop
      const noShow = applicationActionState(under({ stage: "interview_complete" }, { reason: "no_show", autoState: "none" }));
      expect(noShow.allowed).toContain("send_new_times");
      expect(noShow.blockedReasons.stop_new_times).toBe("Nothing is due to go to them automatically.");
      expect(applicationActionState(under({}, { reason: "not_interested", autoState: "none" })).allowed).toContain("send_new_times");
      // times being prepared or out: nothing more to send, and a set being prepared cannot be stopped here
      const preparing = applicationActionState(under({ hasActiveInterview: true }, { autoState: "preparing", interviewOpen: true }));
      expect(preparing.blockedReasons.send_new_times).toBe("New times are already being prepared or are out to them.");
      expect(preparing.blockedReasons.stop_new_times).toBe("Nothing is due to go to them automatically.");
      // nobody else
      expect(applicationActionState(facts()).blockedReasons.send_new_times).toBe("Only for someone under Cancelled.");
      expect(applicationActionState(facts({ stage: "interview_scheduled" })).blockedReasons.send_new_times).toBe("Only for someone under Cancelled.");
      // only those who manage interviews (HR does not)
      expect(applicationActionState(under({ role: "hr" })).blockedReasons.send_new_times).toBe("Your role can't send new interview times; ask an owner, an admin, a hiring manager or a recruiter.");
      expect(applicationActionState(under({ role: "hr" })).blockedReasons.stop_new_times).toBe("Your role can't stop automatic new interview times; ask an owner, an admin, a hiring manager or a recruiter.");
      expect(applicationActionState(under({ role: "recruiter" })).allowed).toEqual(expect.arrayContaining(["send_new_times", "stop_new_times"]));

      // the stage button: they are under Cancelled; Interviewing comes back by booking a time, never by hand
      const moves = Object.fromEntries(stageMoves(under()).map((m) => [m.to, m]));
      expect(Object.keys(moves)).toHaveLength(9);
      expect(moves.cancelled).toMatchObject({ current: true, allowed: false, via: "none" });
      expect(moves.interviewing).toMatchObject({ allowed: false, via: "none", blockedReason: "They move back to Interviewing when they book a time. Send them new times from their page." });
      // a hold takes them out of Cancelled; a decline is the private decline; the earlier steps keep their reasons
      expect(moves.on_hold).toMatchObject({ allowed: true, via: "set_mark", mark: "on_hold" });
      expect(moves.not_moving_forward).toMatchObject({ allowed: true, via: "decline" });
      expect(moves.new).toMatchObject({ allowed: false, blockedReason: "They are past this step." });
      expect(moves.shortlist).toMatchObject({ allowed: false, blockedReason: "They are interviewing already." });
      expect(moves.offer).toMatchObject({ allowed: false, via: "offer" });
      expect(moves.hired).toMatchObject({ allowed: true, via: "record_hire" });
      // an open follow-up outside the interview steps never shows as Cancelled (a resolve that was missed)
      expect(Object.fromEntries(stageMoves(under({ stage: "finalist" })).map((m) => [m.to, m])).interviewing).toMatchObject({ current: true });
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

    it("someone under Cancelled: the stage button and the new-times choices; a decision taken back puts them back there, with their promised set while its day is ahead", async () => {
      type Row = { ownerStage: string; ownerStageLabel: string; allowedActions: string[]; blockedReasons: Record<string, string>; stageMoves: Array<{ to: string; current: boolean; allowed: boolean; blockedReason?: string }>; cancelled: { reason: string; status: string; auto: { state: string } } | null };
      type Undo = { stage: string; ownerStage: string; next: string };
      const candidate = { kind: "candidate" as const, id: "candidate" };
      const due = new Date(container.engine.clock().getTime() + 5 * 86_400_000).toISOString();
      const [{ timezone }] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
      /** Recommended for interview, then they cancelled it and asked for new times: under Cancelled, the set armed when promised. */
      const cancelledPerson = async (first: string, promised: boolean) => {
        const id = await seed(first, { stage: "interview_recommended" });
        await withTenant(container.db, companyId, async (tx) => {
          const [iv] = await tx.insert(interviews).values({ companyId, applicationId: id, roundKey: "first", title: "First interview", format: "video", durationMinutes: 30, status: "cancelled", attempt: 2, cancelReason: "cancelled by the candidate", createdBy: candidate }).returning();
          const { row } = await openFollowUp(tx, { companyId, applicationId: id, interviewId: iv.id, interviewAttempt: 2, kind: "candidate_cancelled", choice: "new_times", auto: promised ? { state: "waiting", dueAt: due, workingDays: 3 } : { state: "none", reason: "switched_off" }, actor: candidate });
          if (promised) await armNewTimes(tx, container.engine, { companyId, followUpId: row.id, applicationId: id, roleId, interviewId: iv.id, actor: candidate });
        });
        await container.drain();
        return id;
      };
      const followUpOf = async (id: string) => (await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, id)))[0];

      const ana = await cancelledPerson("Ana", true);
      const before = (await (await json(owner, "GET", `/api/v1/applications/${ana}`)).json()) as Row;
      expect(before).toMatchObject({ ownerStage: "cancelled", ownerStageLabel: "Asked for new times", cancelled: { reason: "asked_new_times", auto: { state: "waiting" } } });
      expect(before.cancelled!.status).toMatch(/^New times go out automatically /);
      expect(before.allowedActions).toEqual(expect.arrayContaining(["send_new_times", "stop_new_times"]));
      expect(before.stageMoves.find((m) => m.to === "cancelled")).toMatchObject({ current: true, allowed: false });
      expect(before.stageMoves.find((m) => m.to === "interviewing")).toMatchObject({ allowed: false, blockedReason: "They move back to Interviewing when they book a time. Send them new times from their page." });
      // HR may not send or stop new times, and is told who can
      const asHr = (await (await json(hr, "GET", `/api/v1/applications/${ana}`)).json()) as Row;
      expect(asHr.allowedActions).not.toContain("send_new_times");
      expect(asHr.blockedReasons.send_new_times).toMatch(/^Your role can't send new interview times/);

      // declined privately: out of Cancelled, the set does not go; taken back before the day: back, and the set waits again
      expect((await act(owner, ana, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
      expect(await followUpOf(ana)).toMatchObject({ resolvedHow: "left_process", autoState: "not_sent", autoReason: "left_process" });
      // the stage button offers taking it back on the Cancelled row, where it puts them, not on Interviewing
      const declinedRow = (await (await json(owner, "GET", `/api/v1/applications/${ana}`)).json()) as Row;
      expect(declinedRow.stageMoves.find((m) => m.to === "cancelled")).toMatchObject({ allowed: true, via: "undo_decision" });
      expect(declinedRow.stageMoves.find((m) => m.to === "interviewing")).toMatchObject({ allowed: false });
      const undone = (await (await act(owner, ana, { action: "undo_decision" })).json()) as Undo;
      expect(undone).toEqual(expect.objectContaining({ stage: "interview_recommended", ownerStage: "cancelled" }));
      expect(undone.next).toBe(`Decision taken back: they are back under Cancelled. They were never told. Their new times still go to them automatically on ${newTimesDayWords(due, timezone)}, as they asked.`);
      expect(await followUpOf(ana)).toMatchObject({ resolvedAt: null, autoState: "waiting" });
      expect((await (await json(owner, "GET", `/api/v1/applications/${ana}`)).json()) as Row).toMatchObject({ ownerStage: "cancelled", cancelled: { auto: { state: "waiting" } } });

      // nothing promised: back under Cancelled, and nothing goes until the team acts
      const ben = await cancelledPerson("Ben", false);
      expect((await act(owner, ben, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
      expect(((await (await act(owner, ben, { action: "undo_decision" })).json()) as Undo)).toMatchObject({ ownerStage: "cancelled", next: "Decision taken back: they are back under Cancelled. They were never told. Nothing will be sent until you act." });
      // never under Cancelled: today's answer
      const cy = await seed("Cy", { stage: "interview_recommended" });
      expect((await act(owner, cy, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
      expect((((await (await json(owner, "GET", `/api/v1/applications/${cy}`)).json()) as Row).stageMoves.find((m) => m.to === "interviewing"))).toMatchObject({ allowed: true, via: "undo_decision" });
      expect(((await (await act(owner, cy, { action: "undo_decision" })).json()) as Undo)).toMatchObject({ ownerStage: "interviewing", next: "Decision taken back: they are back in Interviewing. They were never told, and nothing will be sent." });
      // a hold takes someone out of Cancelled (and their set does not go)
      expect(await (await act(owner, ana, { action: "hold" })).json()).toMatchObject({ ownerStage: "on_hold" });
      expect(await followUpOf(ana)).toMatchObject({ resolvedHow: "moved_by_team", autoState: "not_sent", autoReason: "team_acted" });
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
      const r = (await (await json(owner, "POST", `/api/v1/applications/${id}/outcome`, { outcome: "employer_declined", confirm: true, reason: "location_or_schedule", note: "Went with someone closer" })).json()) as { dispositionSent: boolean; candidateNotice: string };
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
      // (each of the SCORECARD_READINGS readings: the scorecard is read three times, Wave S5)
      for (let i = 0; i < 2 * SCORECARD_READINGS; i++) container.fake!.failNext("screen.assess", "invalid");
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

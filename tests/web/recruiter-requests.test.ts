import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RecruiterRequestView } from "../../packages/contracts/src/api";
import { hasChoice, loosens, looseningQuestion, splitRules } from "../../apps/web/src/ai-rules";
import { presetOf } from "../../apps/web/src/recruiter-access";
import { CALL_NOTES_HINT, CANDIDATE_ASKED_FOR_PERSON, RECENT_DAYS, RECRUITER_ASKS_OVER_CHIP, aboutWords, askedByWords, draftFactLines, latestAnswer, pickedUpWords, queueThreadHeading, recruiterAsksLine, reopenHint, replyByWords, requestActions, requestState, splitRequests, threadHeading, workspaceHref } from "../../apps/web/src/recruiter-requests";
import { canAskRecruiter } from "../../apps/web/src/roles";

/**
 * "Your recruiter requests" on Today (plans B4 and B5) and the Setup hardening (B7), the parts a page reads without a
 * browser: the list's order and words, what a person may do with a request, who may ask at all, and the question asked
 * before an AI rule is loosened.
 */
const NOW = new Date("2026-10-08T17:00:00.000Z");
const req = (over: Partial<RecruiterRequestView>): RecruiterRequestView => ({
  id: "e", kind: "ask", status: "open", urgency: "normal", summary: "", question: "Help?", scope: "role", roleId: "r1", roleTitle: "Dental hygienist", applicationId: null, candidateName: null,
  askedBy: { kind: "you", name: "Dana" }, createdAt: "2026-10-07T16:00:00.000Z", slaDueAt: "2026-10-09T16:00:00.000Z", firstResponseAt: null, resolvedAt: null, resolution: null, accessExpiresAt: null,
  recruiterName: null, reopenedCount: 0, thread: [], ...over,
});

describe("the list's order", () => {
  it("open requests first, soonest reply-by on top; then the recently answered, newest first; older ones fold away", () => {
    const rows = [
      req({ id: "answered-old", status: "resolved", resolvedAt: new Date(NOW.getTime() - (RECENT_DAYS + 1) * 86_400_000).toISOString() }),
      req({ id: "open-later", slaDueAt: "2026-10-12T16:00:00.000Z" }),
      req({ id: "answered-new", status: "resolved", resolvedAt: "2026-10-08T10:00:00.000Z" }),
      req({ id: "working-sooner", status: "in_progress", slaDueAt: "2026-10-08T20:00:00.000Z" }),
      req({ id: "answered-mid", status: "resolved", resolvedAt: "2026-10-02T10:00:00.000Z" }),
      req({ id: "cancelled-new", status: "cancelled", createdAt: "2026-10-06T10:00:00.000Z" }),
    ];
    const { current, older } = splitRequests(rows, NOW);
    expect(current.map((r) => r.id)).toEqual(["working-sooner", "open-later", "answered-new", "cancelled-new", "answered-mid"]);
    expect(older.map((r) => r.id)).toEqual(["answered-old"]);
  });

  it("names each state in plain words", () => {
    expect(["open", "claimed", "in_progress", "resolved", "cancelled", "anything"].map(requestState)).toEqual(["waiting", "working", "working", "answered", "cancelled", "waiting"]);
  });
});

describe("the words on each request", () => {
  it("what it is about: the candidate by name while the record has one, the role, or all of the hiring", () => {
    expect(aboutWords({ scope: "application", roleTitle: "Dental hygienist", candidateName: "Nia Brooks" })).toBe("Nia Brooks, for Dental hygienist");
    expect(aboutWords({ scope: "application", roleTitle: "Dental hygienist", candidateName: null })).toBe("A candidate for Dental hygienist");
    expect(aboutWords({ scope: "role", roleTitle: "Dental hygienist", candidateName: null })).toBe("Dental hygienist");
    expect(aboutWords({ scope: "company", roleTitle: null, candidateName: null })).toBe("All of your hiring");
  });

  it("who asked, including the system and candidates", () => {
    expect(askedByWords({ kind: "you", name: "Dana" })).toBe("You asked");
    expect(askedByWords({ kind: "team", name: "Hana Manager" })).toBe("Hana Manager asked");
    expect(askedByWords({ kind: "recruiter", name: "Kai" })).toBe("Kai (ITS recruiter) asked");
    expect(askedByWords({ kind: "candidate", name: null })).toBe("A candidate asked for a person");
    expect(askedByWords({ kind: "system", name: null })).toMatch(/^Brought in on its own/);
  });

  it("the reply-by time, a time that has passed, or when it was answered; and who picked it up", () => {
    expect(replyByWords(req({ slaDueAt: "2026-10-09T16:00:00.000Z" }), NOW)).toMatch(/^Reply by /);
    expect(replyByWords(req({ slaDueAt: "2026-10-08T16:00:00.000Z" }), NOW)).toMatch(/^The reply-by time \(.+\) has passed$/);
    expect(replyByWords(req({ status: "resolved", resolvedAt: "2026-10-08T10:00:00.000Z" }), NOW)).toMatch(/^Answered /);
    expect(pickedUpWords(req({}))).toBe("Not picked up yet");
    expect(pickedUpWords(req({ status: "claimed", recruiterName: "Kai Recruiter" }))).toBe("Picked up by Kai Recruiter (ITS recruiter)");
    expect(pickedUpWords(req({ status: "resolved" }))).toBeNull();
  });

  it("the conversation's headings, on Today and in the queue, and the newest answer shown in full", () => {
    const thread = [
      { id: "q", side: "customer" as const, kind: "question" as const, body: "Help?", by: "Dana", at: "2026-10-07T16:00:00.000Z" },
      { id: "a1", side: "recruiter" as const, kind: "answer" as const, body: "First.", by: "Kai", at: "2026-10-07T18:00:00.000Z" },
      { id: "r", side: "customer" as const, kind: "reopen" as const, body: "Not yet.", by: "Dana", at: "2026-10-08T09:00:00.000Z" },
      { id: "n", side: "recruiter" as const, kind: "reply" as const, body: "Which shift?", by: "Kai", at: "2026-10-08T10:00:00.000Z" },
      { id: "a2", side: "recruiter" as const, kind: "answer" as const, body: "Second.", by: "Kai", at: "2026-10-08T12:00:00.000Z" },
    ];
    expect(thread.map(threadHeading)).toEqual(["Dana asked", "Kai answered", "Dana reopened it", "Kai wrote", "Kai answered"]);
    expect(thread.map(queueThreadHeading)).toEqual(["The customer asked", "Kai answered", "The customer reopened it", "Kai wrote", "Kai answered"]);
    expect(latestAnswer(thread)?.body).toBe("Second.");
    expect(latestAnswer(thread.slice(0, 1))).toBeNull();
  });
});

describe("what a person may do, and who may ask", () => {
  it("a note while it is open, reopening once answered, nothing for an ITS recruiter inside the company", () => {
    expect(requestActions(req({ status: "open" }), { staff: false })).toEqual({ note: true, reopen: false });
    expect(requestActions(req({ status: "in_progress" }), { staff: false })).toEqual({ note: true, reopen: false });
    expect(requestActions(req({ status: "resolved" }), { staff: false })).toEqual({ note: false, reopen: true });
    expect(requestActions(req({ status: "cancelled" }), { staff: false })).toEqual({ note: false, reopen: false });
    expect(requestActions(req({ status: "resolved" }), { staff: true })).toEqual({ note: false, reopen: false });
  });

  it("everyone but an interviewer brings in a recruiter (escalation.create)", () => {
    for (const role of ["owner", "admin", "hiring_manager", "hr", "recruiter"]) expect(canAskRecruiter(role), role).toBe(true);
    expect(canAskRecruiter("interviewer")).toBe(false);
    expect(canAskRecruiter(null)).toBe(false);
  });

  it("the button hides itself for those who may not ask, and Today lists the requests in their own card", () => {
    const ask = readFileSync(new URL("../../apps/web/src/components/AskRecruiter.tsx", import.meta.url), "utf8");
    expect(ask).toContain("if (!who.ready || !who.mayAsk) return null;");
    expect(ask).not.toContain("Take this role over");
    expect(ask).toContain("An ITS recruiter will contact you to agree how they would run this hire.");
    expect(ask).toContain("Urgent requests go to the front of the ITS queue. The reply-by time stays the same.");
    const home = readFileSync(new URL("../../apps/web/src/pages/Home.tsx", import.meta.url), "utf8");
    expect(home).toContain("<RecruiterRequests />");
  });
});

describe("loosening an AI rule asks first (plan B7)", () => {
  it("a level that leaves more to happen without a person is loosening; the rest save at once", () => {
    expect(loosens("approval", "auto_notify")).toBe(true);
    expect(loosens("human_only", "approval")).toBe(true);
    expect(loosens("auto_notify", "auto")).toBe(true);
    expect(loosens("auto", "approval")).toBe(false);
    expect(loosens("approval", "approval")).toBe(false);
    expect(loosens("approval", "human_only")).toBe(false);
  });

  it("the question says what changes, and that it can be undone and is recorded", () => {
    const q = looseningQuestion("Invite an applicant to a screen", "approval", "auto_notify");
    expect(q).toBe('Change "Invite an applicant to a screen" from "Ask me first" to "Do it and tell me"? From now on it goes ahead without waiting for a person to approve it, and you are told afterwards. You can change it back at any time, and the change is recorded.');
  });

  it("the list shows what the product does today with every guarantee; the planned rules fold under Coming later", () => {
    const rows = [
      { actionType: "application.invite_screen", available: true, locked: false },
      { actionType: "offer.send", available: false, locked: false },
      { actionType: "offer.negotiate", available: false, locked: true },
      { actionType: "older.api", locked: false },
    ];
    const { now, later } = splitRules(rows);
    expect(now.map((r) => r.actionType)).toEqual(["application.invite_screen", "offer.negotiate", "older.api"]);
    expect(later.map((r) => r.actionType)).toEqual(["offer.send"]);
  });

  it("offers levels only where they change something; the work done the same way for everyone has none", () => {
    expect(hasChoice({ settable: true, locked: false })).toBe(true);
    expect(hasChoice({ settable: false, locked: false })).toBe(false);
    // an "always a person" guarantee keeps its one level in view
    expect(hasChoice({ settable: false, locked: true })).toBe(true);
    // a list from an API that does not say keeps every choice
    expect(hasChoice({ locked: false })).toBe(true);
    const setup = readFileSync(new URL("../../apps/web/src/pages/Setup.tsx", import.meta.url), "utf8");
    expect(setup).toContain("!hasChoice(p) ? <Chip tone=\"neutral\">Nothing to choose</Chip>");
    expect(setup).toContain("{p.does ?");
  });
});

describe("reopening and the recruiter-request allowance", () => {
  it("the reopen form promises only what happens: back to the recruiter when they can take it, otherwise the queue", () => {
    const hint = reopenHint("Kai Recruiter", "this role and its candidates", 14);
    expect(hint).toBe("Reopening sets a new reply-by time. It goes back to Kai Recruiter, who answered, when they can still take it; otherwise to the ITS queue. Whoever has it then can see this role and its candidates for up to 14 days, or until a day after it is resolved again. That access is recorded in your activity, your team is told, and an owner or admin can end it in Setup.");
    expect(reopenHint(null, "all of your hiring", 14)).toMatch(/^Reopening sets a new reply-by time\. It goes back to the ITS queue\./);
    expect(hint).not.toMatch(/gets access again/);
  });

  it("the admin console flags a company past its recruiter requests, for a billing conversation", () => {
    expect(recruiterAsksLine({ used: 2, limit: 1, over: true })).toBe("Recruiter requests: 2 of 1");
    expect(recruiterAsksLine({ used: 4, limit: null, over: false })).toBe("Recruiter requests: 4");
    expect(recruiterAsksLine(undefined)).toBe("Recruiter requests: none recorded");
    expect(RECRUITER_ASKS_OVER_CHIP).toBe("Past its recruiter requests: talk about billing");
    const admin = readFileSync(new URL("../../apps/web/src/pages/Admin.tsx", import.meta.url), "utf8");
    expect(admin).toContain("c.recruiterAsks?.over ? <Chip tone=\"caution\">{RECRUITER_ASKS_OVER_CHIP}</Chip>");
  });

  it("a card's request to ITS opens the form filled in, so the access shows before anything is sent", () => {
    expect(presetOf({ kind: "ask", scope: "company", question: "Please help us draft our first role." })).toEqual({ kind: "ask", about: "all", question: "Please help us draft our first role." });
    expect(presetOf({ kind: "ask", scope: "company", topic: "plan", question: "More roles?" })).toEqual({ kind: "ask", about: "all", question: "More roles?", topic: "plan" });
    expect(presetOf({ kind: "nonsense" })).toEqual({});
    const home = readFileSync(new URL("../../apps/web/src/pages/Home.tsx", import.meta.url), "utf8");
    expect(home).toContain("preset={presetOf(a.body)}");
    expect(home).not.toContain("askForMoreRoles");
    // "Talk to ITS about more roles", when the plan has no room, opens the form too (the job builder, Today's box, Hire again)
    const room = readFileSync(new URL("../../apps/web/src/pages/new-role/StartView.tsx", import.meta.url), "utf8");
    expect(room).toContain("preset={ask ? presetOf(ask.body) :");
    // a draft handed to a recruiter goes with the request, and the request covers all of the hiring (plan C12)
    expect(presetOf({ kind: "ask", scope: "company", intakeSessionId: "s1", question: "Please help me finish drafting this role." })).toEqual({ kind: "ask", about: "all", question: "Please help me finish drafting this role.", intakeSessionId: "s1" });
  });
});

describe("the recruiter queue shows the draft a request is about (plan C12)", () => {
  it("opens the customer's workspace on that draft, a role's candidates, or Today", () => {
    expect(workspaceHref({ roleId: null, contextSnapshot: { intakeSession: { id: "s 1" } } })).toBe("/roles/new?session=s%201");
    expect(workspaceHref({ roleId: "r1", contextSnapshot: {} })).toBe("/roles/r1/talent");
    expect(workspaceHref({ roleId: null, contextSnapshot: { intakeSession: null } })).toBe("/");
  });

  it("opens the candidate a request is about, on the Screen tab when they asked for a person (plan E3)", () => {
    expect(workspaceHref({ roleId: "r1", applicationId: "a1", kind: "review", contextSnapshot: {} })).toBe("/roles/r1/talent?open=a1");
    expect(workspaceHref({ roleId: "r1", applicationId: "a1", kind: CANDIDATE_ASKED_FOR_PERSON, contextSnapshot: {} })).toBe("/roles/r1/talent?open=a1&tab=screen");
    expect(CALL_NOTES_HINT).toMatch(/add your notes from the call on the Screen tab/);
    expect(CALL_NOTES_HINT).toMatch(/never as the candidate's own words/);
    const queue = readFileSync(new URL("../../apps/web/src/pages/RecruiterQueue.tsx", import.meta.url), "utf8");
    expect(queue).toContain("e.kind === CANDIDATE_ASKED_FOR_PERSON && e.applicationId");
  });

  it("reads what the draft knows, one plain line each, saying the pay may not be confirmed", () => {
    const lines = draftFactLines({ title: "Dental Office Manager", locationText: "Irvine", compensationBasis: "hourly", compensationMin: 34, compensationMax: 40, reason: "new_position", decisionMaker: "Hank Manager", interviewers: [], mustHaves: ["Dentrix", ""], dealBreakers: [] });
    expect(lines).toEqual([
      { label: "Job title", value: "Dental Office Manager" },
      { label: "Where", value: "Irvine" },
      { label: "Pay", value: "$34–$40 an hour (as discussed; check whether it was confirmed)" },
      { label: "Why they are hiring", value: "new position" },
      { label: "Final decision", value: "Hank Manager" },
      { label: "Must-haves", value: "Dentrix" },
    ]);
    expect(draftFactLines({})).toEqual([]);
  });

  it("the queue renders the conversation and the draft, and the request form's promise is kept", () => {
    const queue = readFileSync(new URL("../../apps/web/src/pages/RecruiterQueue.tsx", import.meta.url), "utf8");
    expect(queue).toContain("{ctx.intakeSession ? <DraftHandover");
    expect(queue).toContain("nav(workspaceHref(e))");
    expect(queue).toContain("Open the draft");
  });
});

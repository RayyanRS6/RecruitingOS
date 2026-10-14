import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../../apps/web/src/api/client";
import { DECLINE_REASONS, NO_COMPOSE, activeInterviews, composeFor, dayKey, hasUnsent, historyItem, historyItems, holdDateBounds, latestByTab, markSeen, neighbours, panelSearch, panelTabFrom, recruiterEventsFor, suggestionAndDecision, unreadTabs, whoDid } from "../../apps/web/src/pages/candidate-panel/helpers";

/**
 * The candidate panel's rules (plan A10): its address, next and previous, the unread markers, the hold's dates, the
 * unsent-text guard, and the History tab's words: who did what, why, and what the candidate was told.
 */
const at = (iso: string) => iso;
const ev = (type: string, payload: Record<string, unknown> = {}, actor: TimelineEvent["actor"] = { kind: "user", id: "u1", name: "Dana Whitfield" }, occurredAt = "2026-10-08T10:00:00.000Z"): TimelineEvent => ({ type, payload, actor, occurredAt });

describe("the panel's place in the address", () => {
  it("opens on the Overview unless a known section is asked for", () => {
    expect(panelTabFrom("history")).toBe("history");
    expect(panelTabFrom("resume")).toBe("resume");
    expect(panelTabFrom("nonsense")).toBe("overview");
    expect(panelTabFrom(null)).toBe("overview");
  });

  it("keeps the rest of the address, writes open and tab, and drops message and tab on close", () => {
    expect(panelSearch("ownerStage=on_hold", { open: "a1", tab: "history" })).toBe("?ownerStage=on_hold&open=a1&tab=history");
    expect(panelSearch("open=a1&tab=history", { open: "a2", tab: "overview" })).toBe("?open=a2");
    expect(panelSearch("open=a1&tab=messages&message=1&stage=ineligible", { open: null })).toBe("?stage=ineligible");
    expect(panelSearch("open=a1", { open: null })).toBe("");
  });
});

describe("next and previous", () => {
  it("steps through the list as it was when the panel opened, saying where the reader is", () => {
    expect(neighbours(["a", "b", "c"], "b")).toEqual({ index: 1, total: 3, prev: "a", next: "c" });
    expect(neighbours(["a", "b", "c"], "a")).toEqual({ index: 0, total: 3, prev: null, next: "b" });
    expect(neighbours(["a", "b", "c"], "c")).toMatchObject({ prev: "b", next: null });
  });

  it("offers neither for someone opened from a notification who is not in the list", () => {
    expect(neighbours(["a", "b"], "z")).toBeNull();
    expect(neighbours(null, "a")).toBeNull();
  });
});

describe("unread markers", () => {
  const detail = {
    screens: [{ id: "s1", channel: "web", status: "completed", invitedAt: null, startedAt: "2026-10-05T10:00:00.000Z", completedAt: "2026-10-06T10:00:00.000Z", remindedAt: null, transcript: [{ role: "candidate", content: "hi", at: "2026-10-06T09:00:00.000Z" }], answers: {}, progress: { askedKeys: [], currentQuestionKey: null }, assessmentId: null }],
    communications: [{ id: "m1", direction: "inbound", channel: "email", subject: null, bodyText: "Thanks!", status: "received", createdAt: "2026-10-07T12:00:00.000Z", templateKey: null }, { id: "m2", direction: "outbound", channel: "email", subject: "Hello", bodyText: "x", status: "sent", createdAt: "2026-10-08T12:00:00.000Z", templateKey: null }],
    timeline: [ev("application.received", {}, { kind: "candidate", id: "c" }, "2026-10-01T10:00:00.000Z"), ev("application.marked", { mark: "shortlist" }, undefined, "2026-10-07T08:00:00.000Z")],
    documents: [],
  };

  it("finds the newest thing in each section; the team's own messages are not news", () => {
    expect(latestByTab(detail as never)).toEqual({ screen: at("2026-10-06T10:00:00.000Z"), messages: at("2026-10-07T12:00:00.000Z"), history: at("2026-10-07T08:00:00.000Z"), resume: null });
  });

  it("marks nothing on a first look, then only what is newer than the last look at that section", () => {
    const latest = latestByTab(detail as never);
    expect(unreadTabs(latest, null).size).toBe(0);
    const seen = { first: "2026-10-06T00:00:00.000Z", messages: "2026-10-07T13:00:00.000Z" };
    expect([...unreadTabs(latest, seen)].sort()).toEqual(["history", "screen"]);
    // the section being read is never marked
    expect([...unreadTabs(latest, seen, "screen")]).toEqual(["history"]);
  });

  it("records the look at a section, starting the record on the first look", () => {
    const now = new Date("2026-10-08T10:00:00.000Z");
    expect(markSeen(null, "overview", now)).toEqual({ first: now.toISOString(), overview: now.toISOString() });
    expect(markSeen({ first: "2026-10-01T00:00:00.000Z" }, "history", now)).toEqual({ first: "2026-10-01T00:00:00.000Z", history: now.toISOString() });
  });
});

describe("the hold's date and the unsent-text guard", () => {
  it("offers tomorrow to just inside eight weeks, two weeks by default, in the reader's calendar", () => {
    const now = new Date(2026, 9, 8, 23, 30);
    expect(holdDateBounds(now)).toEqual({ min: "2026-10-09", max: "2026-12-02", initial: "2026-10-22" });
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });

  it("asks before throwing away typed text, and not for empty or blank fields", () => {
    expect(hasUnsent({})).toBe(false);
    expect(hasUnsent({ note: "   ", message: "" })).toBe(false);
    expect(hasUnsent({ note: "", message: "Hi Maria," })).toBe(true);
  });

  it("never carries a message being written over to the next person: their box starts empty and closed", () => {
    const writing = { id: "maria", open: true, subject: "Next steps", text: "Hi Maria," };
    expect(composeFor(writing, "maria")).toEqual({ open: true, subject: "Next steps", text: "Hi Maria," });
    expect(composeFor(writing, "luis")).toEqual(NO_COMPOSE);
    expect(NO_COMPOSE).toEqual({ open: false, subject: "", text: "" });
    // and the guard sees nothing unsent once the panel shows the next person
    expect(hasUnsent({ subject: composeFor(writing, "luis").subject, text: composeFor(writing, "luis").text })).toBe(false);
  });

  it("names the interviews a decision would call off", () => {
    const ivs = [{ status: "scheduled", id: 1 }, { status: "completed", id: 2 }, { status: "scheduling", id: 3 }, { status: "cancelled", id: 4 }, { status: "proposed", id: 5 }];
    expect(activeInterviews(ivs).map((i) => i.id)).toEqual([1, 3, 5]);
  });

  it("keeps the fixed list of reasons, without the eligibility reason (that has its own card)", () => {
    expect(DECLINE_REASONS.map(([k]) => k)).toEqual(["not_a_match_experience", "not_a_match_skills", "compensation_mismatch", "location_or_schedule", "position_filled", "candidate_unresponsive", "other"]);
    for (const [, label] of DECLINE_REASONS) expect(label).not.toMatch(/_/);
  });
});

describe("History: who did what, why, and what the candidate was told", () => {
  it("names a person, the assistant (never its id), the system, an ITS recruiter", () => {
    expect(whoDid({ kind: "user", id: "u1", name: "Dana Whitfield" })).toBe("Dana Whitfield");
    expect(whoDid({ kind: "user", id: "u1" })).toBe("A team member");
    expect(whoDid({ kind: "agent", id: "triage-agent-7" })).toBe("The assistant");
    expect(whoDid({ kind: "system", id: "workflow:screen" })).toBe("The system");
    expect(whoDid({ kind: "recruiter", id: "r1", name: "Paula" })).toBe("Paula (ITS recruiter)");
  });

  it("says when the assistant suggested and a person approved", () => {
    const item = historyItem(ev("candidate.recommended", { by: "approval", approvalRequestId: "p1" }));
    expect(item).toMatchObject({ what: "Moved to Interviewing", who: "Suggested by the assistant, approved by Dana Whitfield" });
    expect(historyItem(ev("candidate.recommended", { by: "human" }))?.what).toBe("Marked for interview");
    expect(historyItem(ev("application.triaged", { recommendation: "screen" }, { kind: "agent", id: "triage" }))).toMatchObject({ what: "AI review of the résumé: Worth a screening chat", who: "The assistant" });
    // the assistant's "hold" is thin evidence, never the On hold mark
    expect(historyItem(ev("application.triaged", { recommendation: "hold" }, { kind: "agent", id: "triage" }))?.what).toBe("AI review of the résumé: Thin evidence: your call");
  });

  it("gives the reason and note of a decision and says the candidate was not told", () => {
    const declined = historyItem(ev("application.rejected", { reason: "not_a_match_skills", byHuman: true, candidateTold: false, note: "No perio charting" }));
    expect(declined).toMatchObject({ what: "Moved to Not moving forward", why: "Missing skills we need: No perio charting", told: "Private: the candidate was not told." });
    expect(historyItem(ev("application.rejected", { reason: "eligibility", afterInterview: true }))?.what).toBe("Moved to Not moving forward after the interview");
    const hold = historyItem(ev("application.marked", { mark: "on_hold", remindAt: "2026-10-22T15:00:00.000Z", note: "Second chair" }));
    expect(hold?.what).toMatch(/^Put on hold until Oct 2[1-3]$/);
    expect(hold).toMatchObject({ why: "Second chair", told: "Private: the candidate was not told." });
    expect(historyItem(ev("application.told", { how: "in_person", note: "By phone" }))).toMatchObject({ what: "Recorded telling the candidate in person", told: "Told in person." });
    expect(historyItem(ev("application.told", { how: "message" }, { kind: "system", id: "outbox" }))?.told).toBe("Told by the decision message.");
  });

  it("explains a mark that ended, and leaves out records that only repeat another", () => {
    expect(historyItem(ev("application.mark_cleared", { mark: "shortlist", reason: "cleared by a person" }))?.what).toBe("Taken off the shortlist");
    expect(historyItem(ev("application.mark_cleared", { mark: "on_hold", reason: "cleared by a person" }))?.what).toBe("Taken off hold");
    expect(historyItem(ev("application.mark_cleared", { mark: "shortlist", reason: "left_process" }))?.what).toBe("Shortlist mark ended: they left the process");
    expect(historyItem(ev("application.mark_cleared", { mark: "longlist", reason: "replaced by shortlist" }))).toBeNull();
    for (const action of ["reject", "set_mark", "clear_mark", "interview.decision"]) expect(historyItem(ev("human.override", { action }))).toBeNull();
    expect(historyItem(ev("human.override", { action: "override_eligibility", note: "Exam next week" }))).toMatchObject({ what: "Kept them in after the eligibility answer", why: "Exam next week" });
  });

  it("lists everything newest first, with recruiter help joined in from its own records", () => {
    const events = [
      { ...ev("recruiter.requested", { applicationId: "app1", kind: "review" }, undefined, "2026-10-02T10:00:00.000Z"), subjectType: "escalation", subjectId: "e1" },
      { ...ev("recruiter.claimed", {}, { kind: "recruiter", id: "r1", name: "Paula" }, "2026-10-03T10:00:00.000Z"), subjectType: "escalation", subjectId: "e1" },
      { ...ev("recruiter.resolved", { resolution: "Worth a working interview." }, { kind: "recruiter", id: "r1", name: "Paula" }, "2026-10-04T10:00:00.000Z"), subjectType: "escalation", subjectId: "e1" },
      { ...ev("recruiter.requested", { applicationId: "someone-else" }), subjectType: "escalation", subjectId: "e2" },
      { ...ev("recruiter.claimed", {}), subjectType: "escalation", subjectId: "e2" },
    ];
    const help = recruiterEventsFor("app1", events);
    expect(help.map((e) => e.type)).toEqual(["recruiter.requested", "recruiter.claimed", "recruiter.resolved"]);
    const items = historyItems([ev("application.received", {}, { kind: "candidate", id: "c" }, "2026-10-01T10:00:00.000Z")], help);
    expect(items.map((i) => i.what)).toEqual(["The ITS recruiter answered", "An ITS recruiter picked up the request", "Asked an ITS recruiter for help", "Applied"]);
    expect(items[0]).toMatchObject({ who: "Paula (ITS recruiter)", why: "Worth a working interview." });
  });

  it("tells what became of the assistant's suggestions: asked, approved by whom, 'Not now', closed, run out of time", () => {
    const agent = { kind: "agent", id: "triage" };
    expect(historyItem(ev("approval.requested", { actionType: "application.invite_screen" }, agent))).toMatchObject({ what: "The assistant suggested a screening chat", who: "The assistant" });
    expect(historyItem(ev("approval.granted", { actionType: "application.invite_screen" }))).toMatchObject({ what: "Approved the suggestion of a screening chat", who: "Suggested by the assistant, approved by Dana Whitfield" });
    // a person who did it themselves has their own line; an approved interview says it on "Moved to Interviewing"
    expect(historyItem(ev("approval.granted", { actionType: "application.invite_screen", by: "invite_screen" }))).toBeNull();
    expect(historyItem(ev("approval.granted", { actionType: "application.recommend_interview" }))).toBeNull();
    expect(historyItem(ev("approval.denied", { actionType: "application.recommend_interview", note: "Not now" }))).toMatchObject({ what: "Not now: set aside the suggestion of an interview", told: "The candidate was not told." });
    expect(historyItem(ev("approval.denied", { actionType: "application.invite_screen", note: "Waiting on her license" }))?.why).toBe("Waiting on her license");
    expect(historyItem(ev("approval.cancelled", { actionType: "application.invite_screen", by: "left_process" }))).toMatchObject({ what: "The suggestion of a screening chat was closed", why: "Because they left the process." });
    expect(historyItem(ev("approval.expired", { actionType: "application.invite_screen", windowDays: 7 }, { kind: "system", id: "wf" }))?.what).toBe("The suggestion of a screening chat ran out of time (7 days)");
    expect(historyItem(ev("approval.denied", { actionType: "disposition.send" }))?.what).toBe("Turned down sending the decision message");
    // a role's own approvals never show on a candidate
    expect(historyItem(ev("approval.granted", { actionType: "role_packet.approve" }))).toBeNull();
  });

  it("tells what happened to their screens, with the reason a screen was closed", () => {
    expect(historyItem(ev("screen.cancelled", { reason: "stopped_by_team", note: "Phoned her instead" }))).toMatchObject({ what: "Screening chat invitation stopped by the team", why: "Phoned her instead" });
    expect(historyItem(ev("screen.cancelled", { reason: "left_process" }))?.what).toBe("Screening chat closed: no longer in the process");
    expect(historyItem(ev("screen.cancelled", { reason: "deletion_request" }))?.what).toBe("Screening chat closed: their information was deleted");
    expect(historyItem(ev("screen.completed", {}, { kind: "candidate", id: "c" }))?.what).toBe("Finished the screening chat");
    // withdrawing says "Withdrew" once, on the application
    expect(historyItem(ev("screen.abandoned", { reason: "withdrawn" }))).toBeNull();
    expect(historyItem(ev("application.told", { how: "before_tracking" }, { kind: "system", id: "migration_0026" }))).toMatchObject({ what: "Counted as told: decided before decisions became private" });
  });

  it("tells the conversation in the same visit as applying (Wave E): offered, skipped, changed, sent without it, a recruiter's call", () => {
    const apply = { kind: "system" as const, id: "apply_page" };
    const cand = { kind: "candidate" as const, id: "c" };
    expect(historyItem(ev("screen.invited", { invitedBy: "apply", invitedVia: "apply" }, apply))?.what).toBe("Offered the screening chat right after the application form");
    expect(historyItem(ev("screen.question_skipped", { questionKey: "q_pay" }, cand))).toMatchObject({ what: "Chose not to answer a screening question", who: "The candidate" });
    expect(historyItem(ev("screen.answer_edited", { questionKey: "q_start" }, cand))?.what).toBe("Changed an answer before sending");
    expect(historyItem(ev("screen.answer_tapped", { questionKey: "q_days" }, cand))).toBeNull();
    expect(historyItem(ev("screen.declined_by_candidate", { answered: 0, questions: 5 }, cand))).toMatchObject({ what: "Sent the application without the screening chat", why: "Their own choice; it is never held against them." });
    expect(historyItem(ev("screen.idle_reminded", { answered: 2 }, { kind: "system", id: "wf" }))?.what).toBe("Reminded once to finish the screening chat");
    // never how far they got: they did not send their answers (founder decision of 9 October 2026)
    expect(historyItem(ev("screen.unfinished", { answered: 2, questions: 5 }, { kind: "system", id: "wf" }))).toMatchObject({ what: "Didn't finish the screening chat; it closed after one reminder", why: "They never sent their answers, so they are not shown." });
    expect(JSON.stringify(historyItem(ev("screen.unfinished", { answered: 2, questions: 5 }, { kind: "system", id: "wf" })))).not.toContain("2 of 5");
    expect(historyItem(ev("screen.paused", { reason: "model down" }, { kind: "system", id: "screening" }))?.told).toBe("They are emailed a link to finish once it is back.");
    expect(historyItem(ev("screen.resumed", {}, { kind: "system", id: "screening" }))?.what).toBe("The screening chat is back on");
    // the most model calls a conversation may make: to checking the answers, or closed with what was said
    expect(historyItem(ev("screen.turn_cap_reached", { ending: "review", cap: 23 }, { kind: "system", id: "screening" }))).toMatchObject({ what: "The screening chat reached its length limit", who: "The system", why: "They were taken to check their answers, where they can answer any question still open, and send them." });
    expect(historyItem(ev("screen.turn_cap_reached", { ending: "closed", cap: 23 }, { kind: "system", id: "screening" }))?.why).toBe("It closed with what they had said so far, and the AI review reads only that.");
    // the plan's conversations stayed used up for the whole wait: never silent, for the team or the person promised the link
    expect(historyItem(ev("screen.allowance_lapsed", { promised: true, days: 60 }, { kind: "system", id: "workflow" }))).toMatchObject({ what: "Never got the screening chat: the plan's screening chats stayed used up", told: "They were told it is not going ahead and that nothing else is needed." });
    expect(historyItem(ev("screen.recruiter_notes_added", { notes: 3, complete: true }, { kind: "user", id: "s1", name: "Rae Recruiter" }))).toMatchObject({ what: "Added notes from a call with the candidate", who: "Rae Recruiter", why: "Kept as the recruiter's notes, never as the candidate's own words." });
    expect(historyItem(ev("screen.completed", { via: "recruiter_call" }, { kind: "user", id: "s1", name: "Rae Recruiter" }))?.what).toBe("Screening finished with a recruiter's notes from a call");
    expect(historyItem(ev("screen.repeat_confirmed", { intent: "answers", added: true }, cand))?.what).toBe("Confirmed by email: answers given when applying again were added");
    expect(historyItem(ev("screen.repeat_confirmed", { intent: "person", added: true }, cand))?.what).toBe("Confirmed by email: asked for a person after applying again");
    // a skip during a follow-up keeps the answer; answers sent after the reminder; never started; a person after an outage
    expect(historyItem(ev("screen.question_skipped", { questionKey: "q_work", answerKept: true }, cand))?.what).toBe("Moved on from a follow-up question, keeping the answer already given");
    expect(historyItem(ev("screen.completed", { via: "review_timeout" }, { kind: "system", id: "wf" }))).toMatchObject({ what: "Their screening answers were sent as they were", who: "The system" });
    expect(historyItem(ev("screen.expired", { oneVisit: true }, { kind: "system", id: "wf" }))).toMatchObject({ what: "Did not start the screening chat that goes with the application", who: "The system" });
    expect(historyItem(ev("screen.expired", {}, { kind: "system", id: "wf" }))?.what).toBe("The screening chat invitation lapsed without an answer");
    expect(historyItem(ev("screen.repeat_confirmed", { intent: "outage", added: true }, cand))?.what).toBe("Confirmed by email: a person to finish the chat the assistant could not, after applying again");
  });

  it("tells the Cancelled column in plain words (founder decisions 1A to 4A): in, out, and what became of the new times", () => {
    const cand = { kind: "candidate" as const, id: "c" };
    const sys = { kind: "system" as const, id: "workflow:interview_new_times" };
    const asked = historyItem(ev("application.moved_to_cancelled", { followUpId: "f1", interviewId: "iv1", reason: "asked_new_times", auto: { state: "waiting", reason: null, dueAt: "2026-10-15T16:00:00.000Z", workingDays: 3 } }, cand));
    expect(asked).toMatchObject({ what: "Cancelled the interview and asked for new times", who: "The candidate" });
    expect(asked?.told).toMatch(/^New times go to them automatically on Thursday, October 1[45]\.$/);
    // with the company's own calendar day recorded, that day, whatever the reader's time zone (an instant late in the day
    // in the company's zone can be the next day for the reader)
    const companyDay = historyItem(ev("application.moved_to_cancelled", { reason: "asked_new_times", auto: { state: "waiting", reason: null, dueAt: "2026-10-16T06:30:00.000Z", dueDay: "2026-10-15", workingDays: 3 } }, cand));
    expect(companyDay?.told).toBe("New times go to them automatically on Thursday, October 15.");
    // nothing armed: no promise in the history either
    expect(historyItem(ev("application.moved_to_cancelled", { reason: "asked_new_times", auto: { state: "none", reason: "switched_off" } }, cand))?.told).toBeUndefined();
    expect(historyItem(ev("application.moved_to_cancelled", { reason: "not_interested", auto: { state: "none", reason: "not_asked" } }, cand))?.what).toBe("Cancelled the interview: no longer interested");
    expect(historyItem(ev("application.moved_to_cancelled", { reason: "no_show", auto: { state: "none", reason: "no_show" } }))).toMatchObject({ what: "Did not come to the interview", who: "Dana Whitfield" });
    expect(historyItem(ev("application.moved_to_cancelled", { reason: "no_show", backfill: true }, { kind: "system", id: "migration_0035", name: "The Cancelled column (founder decision 4A)" }))).toMatchObject({ what: "Did not come to the interview", why: "Recorded when the Cancelled column was added." });
    expect(historyItem(ev("application.moved_to_cancelled", { reason: "asked_new_times", restored: true, auto: { state: "waiting" } }))?.what).toBe("Back under Cancelled: the decision was taken back");
    // leaving: booked, moved on, the team cancelled; leaving the process or a new entry says nothing more
    expect(historyItem(ev("application.left_cancelled", { how: "rebooked", autoStopped: false }, cand))?.what).toBe("Booked a new interview time");
    expect(historyItem(ev("application.left_cancelled", { how: "moved_by_team" }))?.what).toBe("Moved on from Cancelled");
    expect(historyItem(ev("application.left_cancelled", { how: "team_cancelled" }))?.what).toBe("The team cancelled the interview with new times");
    expect(historyItem(ev("application.left_cancelled", { how: "left_process" }))).toBeNull();
    expect(historyItem(ev("application.left_cancelled", { how: "superseded" }))).toBeNull();
    // the new times themselves
    expect(historyItem(ev("interview.new_times_sent", { via: "auto", attempt: 2 }, sys))).toMatchObject({ what: "New times sent automatically, as they asked", who: "The system" });
    expect(historyItem(ev("interview.new_times_sent", { via: "person", attempt: 2 }, sys))?.what).toBe("New times sent");
    expect(historyItem(ev("interview.new_times_not_sent", { reason: "takeover", from: "waiting" }, sys))).toMatchObject({ what: "The automatic new times did not go", why: "An ITS recruiter is running this role, so nothing was sent automatically." });
    expect(historyItem(ev("interview.new_times_not_sent", { reason: "switched_off", from: "waiting" }))?.why).toBe("Automatic new times were switched off in Settings.");
    // the staff side says "screening chat", as the drawer's tab and menu do
    expect(historyItem(ev("application.stage_changed", { from: "triaged", to: "screen_invited" }))?.what).toBe('Now "Invited to a screening chat"');
    expect(historyItem(ev("application.stage_changed", { from: "screening", to: "screen_complete" }))?.what).toBe('Now "Screening chat done"');
    expect(historyItem(ev("interview.new_times_not_sent", { reason: "candidate_replied", from: "waiting" }))?.why).toBe("They replied to us, so nothing went automatically: read their reply first.");
    expect(historyItem(ev("interview.new_times_not_sent", { reason: "left_process", from: "waiting" }))).toBeNull();
    expect(historyItem(ev("interview.new_times_not_sent", { reason: "details_deleted", from: "waiting" }))).toBeNull();
    // the team's own acts, and the hold a cancel ended
    expect(historyItem(ev("human.override", { action: "interview.new_times", followUpId: "f1" }))?.what).toBe("Sent new times");
    expect(historyItem(ev("human.override", { action: "interview.new_times_stop", followUpId: "f1" }))?.what).toBe("Stopped the automatic new times");
    expect(historyItem(ev("application.mark_cleared", { mark: "on_hold", reason: "moved_on", to: "cancelled" }, cand))?.what).toBe("On hold mark ended: they went under Cancelled");
  });

  it("never prints machine words for the Cancelled column's records", () => {
    const records = [
      ev("application.moved_to_cancelled", { reason: "asked_new_times", auto: { state: "waiting", dueAt: "2026-10-15T16:00:00.000Z" } }),
      ev("application.moved_to_cancelled", { reason: "not_interested" }),
      ev("application.moved_to_cancelled", { reason: "no_show", backfill: true }),
      ev("application.moved_to_cancelled", { reason: "no_show", restored: true }),
      ...["rebooked", "moved_by_team", "team_cancelled"].map((how) => ev("application.left_cancelled", { how })),
      ev("interview.new_times_sent", { via: "auto" }),
      ev("interview.new_times_sent", { via: "batch" }),
      ...["switched_off", "already_used", "reschedules_used", "takeover", "was_on_hold", "stopped_by_team", "team_acted", "candidate_replied", "company_not_checked", "no_interviewers", "no_email", "interview_changed"].map((reason) => ev("interview.new_times_not_sent", { reason })),
      ev("human.override", { action: "interview.new_times" }),
      ev("human.override", { action: "interview.new_times_stop" }),
    ];
    for (const e of records) {
      const item = historyItem(e);
      expect(item, e.type).not.toBeNull();
      // the default prints the record's own name ("interview new times sent"), and an unknown override "Decision: …"
      expect(item?.what, e.type).not.toMatch(/[._]|^(application|interview|human) |^Decision: /i);
      if (e.type === "interview.new_times_not_sent") expect(item?.why, String(e.payload.reason)).toMatch(/\.$/);
    }
  });

  it("sets what the assistant suggested beside what a person decided", () => {
    const timeline = [
      ev("application.triaged", { recommendation: "screen" }, { kind: "agent", id: "triage" }, "2026-10-01T10:00:00.000Z"),
      ev("application.stage_changed", { from: "eligible", to: "triaged" }, { kind: "system", id: "wf" }, "2026-10-01T10:00:01.000Z"),
      ev("application.marked", { mark: "shortlist" }, { kind: "user", id: "u1", name: "Dana Whitfield" }, "2026-10-02T10:00:00.000Z"),
    ];
    expect(suggestionAndDecision(timeline)).toEqual({ suggested: "Worth a screening chat", decided: "Shortlist", decidedBy: "Dana Whitfield" });
    expect(suggestionAndDecision(timeline.slice(0, 2))).toEqual({ suggested: "Worth a screening chat", decided: null, decidedBy: null });
    expect(suggestionAndDecision([])).toEqual({ suggested: null, decided: null, decidedBy: null });
  });
});

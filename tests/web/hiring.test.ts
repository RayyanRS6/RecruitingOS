import { describe, expect, it } from "vitest";
import type { HireFollowUp, TimelineEvent } from "../../apps/web/src/api/client";
import {
  daysAgoWords, hireConfirmText, hireFollowUpView, hireToast, interviewDraftLine, interviewDraftPath, keepWarmToast, offerAnswerToast, offerDateBounds, offerMadeOn, offerMadeToast, offerNote, offerStepText,
  plainDayWords, waitingOnCandidateRow, waitingOnCandidateText,
} from "../../apps/web/src/hiring";
import { historyItem, panelSearch, resumeToShow, resumeView, whoDecides, PANEL_TABS } from "../../apps/web/src/pages/candidate-panel/helpers";
import { panelStepFrom } from "../../apps/web/src/talent-actions";

/**
 * Interviews to hire (plan Wave H; founder decisions Q24, Q29), the page's words and rules: the record-only "Offer
 * made", the wait for the candidate's answer, the hire sheet and what follows it, the interview approval filled in from a
 * suggestion, the résumé inside the panel, and the history lines for offers, notes and the untold safety net.
 */
const ev = (type: string, payload: Record<string, unknown>, occurredAt = "2026-10-06T10:00:00.000Z"): TimelineEvent => ({ type, occurredAt, actor: { kind: "user", id: "u1", name: "Dana Whitfield" }, payload });

describe("Offer made (Q29)", () => {
  it("is record-only: nothing is written or sent, and the date can never be one still to come", () => {
    expect(offerStepText("Maria")).toMatch(/The app never writes, sends or changes an offer, and nothing is sent to Maria\./);
    const b = offerDateBounds(new Date(2026, 9, 9, 15));
    expect(b).toEqual({ max: "2026-10-09", initial: "2026-10-09" });
    expect(offerMadeToast("Maria")).toEqual({ title: "Offer recorded.", detail: "Nothing was sent to Maria. When they answer, record it on their page: they accepted, or they declined." });
  });

  it("reads the day the offer was made and its private note from the history, else the day they moved to Offer", () => {
    const a = { stageChangedAt: "2026-10-07T09:00:00.000Z", timeline: [ev("offer.created", { madeOn: "2026-10-06", note: "Start after notice period" })], candidate: { firstName: "Maria" } };
    expect(offerMadeOn(a)).toBe("2026-10-06");
    expect(offerNote(a)).toBe("Start after notice period");
    expect(offerMadeOn({ ...a, timeline: [] })).toBe("2026-10-07");
    expect(offerNote({ timeline: [] })).toBeNull();
    expect(plainDayWords("2026-10-06")).toBe("Tuesday, October 6");
    expect(daysAgoWords("2026-10-06", new Date(2026, 9, 9, 10))).toBe("3 days ago");
    expect(daysAgoWords("2026-10-09", new Date(2026, 9, 9, 10))).toBe("today");
    expect(waitingOnCandidateText(a as never, new Date(2026, 9, 9, 10))).toBe("You recorded an offer made on Tuesday, October 6 (3 days ago). The next move is Maria's. When they answer, record it here; nothing is sent to them either way.");
  });

  it("shows the wait on the candidate on their row, and their answer privately", () => {
    expect(waitingOnCandidateRow({ group: "waiting_on_candidate", daysInStage: 3 })).toBe("Offer made: waiting on their answer 3 days");
    expect(waitingOnCandidateRow({ group: "waiting_on_candidate", daysInStage: 0 })).toBe("Offer made today: waiting on their answer");
    expect(waitingOnCandidateRow({ group: "waiting_on_you", daysInStage: 3 })).toBeNull();
    expect(offerAnswerToast("declined", {})).toEqual({ title: "Recorded: they declined the offer.", detail: "Recorded with your name. Nothing was sent to them." });
    expect(offerAnswerToast("withdrew", { interviewsCancelled: 1, interviewOffNotes: 1 }).detail).toMatch(/they were sent a short note now saying only that it is off\.$/);
  });
});

describe("the hire sheet (plan H1)", () => {
  const hire: HireFollowUp = {
    startDate: "2026-11-02",
    backups: { count: 2, people: [{ applicationId: "a2", name: "Luis Ortega", stageLabel: "Finalist" }, { applicationId: "a3", name: "Ana Holt", stageLabel: "Interviewing" }] },
    closeRole: { path: "/api/v1/roles/r1/outcome", outcome: "filled", stillInProcess: 4, words: "Close the role as filled. The 4 people still in process move to your talent pool, privately: nobody is told at once, and you see the closing message before it goes." },
  };

  it("asks before recording, with the start date and the day they accepted, and says nothing was sent", () => {
    expect(hireConfirmText({ name: "Maria Reyes", startDate: "2026-11-02", offerAcceptedAt: "2026-10-08" })).toBe("Record the hire of Maria Reyes, who accepted the offer on Thursday, October 8, starting Monday, November 2? It is recorded with your name and can only be corrected by an administrator. Nothing is sent to anyone.");
    expect(hireConfirmText({ name: "Maria Reyes", startDate: "2026-11-02" })).toMatch(/^Record the hire of Maria Reyes, starting Monday, November 2\?/);
    expect(hireToast({ name: "Maria Reyes", startDate: "2026-11-02" })).toEqual({ title: "Maria Reyes is hired.", detail: "Starting Monday, November 2. Recorded with your name; nothing was sent to anyone." });
  });

  // a fixed "now" before the start date, so these do not change meaning once November 2 has passed
  const before = new Date(2026, 9, 9, 12);

  it("then offers the two ways on: close the role now and tell them, or keep the backups warm until the start", () => {
    const v = hireFollowUpView(hire, "Maria", before);
    expect(v.startLine).toBe("Maria starts on Monday, November 2.");
    expect(v.backupsLine).toBe("2 other people are still in the running:");
    expect(v.people.map((p) => p.name)).toEqual(["Luis Ortega", "Ana Holt"]);
    expect(v.mayClose).toBe(true);
    expect(v.started).toBe(false);
    expect(v.closeWords).toMatch(/you see the closing message before it goes/);
    expect(v.keepWarmWords).toMatch(/^Keep the role open and them all in mind until Maria starts on Monday, November 2\. Nobody is told anything/);
    const closed = hireFollowUpView({ ...hire, closeRole: null, backups: { count: 0, people: [] } }, "Maria", before);
    expect(closed).toMatchObject({ mayClose: false, closeWords: null, keepWarmWords: null, backupsLine: null });
    expect(keepWarmToast("Maria", "2026-11-02", before)).toEqual({ title: "The role stays open.", detail: "Nobody was told anything. Today reminds you about your backups until Maria starts on Monday, November 2." });
  });

  it("keeps the Today promise on the start day itself, the last day Today's card shows", () => {
    const onTheDay = new Date(2026, 10, 2, 17);
    expect(hireFollowUpView(hire, "Maria", onTheDay)).toMatchObject({ started: false, startLine: "Maria starts on Monday, November 2." });
    expect(hireFollowUpView(hire, "Maria", onTheDay).keepWarmWords).toMatch(/Today reminds you about your backups until then/);
    expect(keepWarmToast("Maria", "2026-11-02", onTheDay).detail).toMatch(/Today reminds you about your backups until Maria starts/);
  });

  it("with a start date already past (a hire recorded late), promises no Today reminder that would never come", () => {
    const after = new Date(2026, 10, 3, 9);
    const v = hireFollowUpView(hire, "Maria", after);
    expect(v.started).toBe(true);
    expect(v.startLine).toBe("Maria started on Monday, November 2.");
    // leaving it open is still offered, so the sheet always has a way out, but plainly
    expect(v.keepWarmWords).toBe("Leave the role open for now. Nobody is told anything. Maria has already started, so Today will not remind you about the others; close the role from its page when you are ready.");
    expect(v.keepWarmWords).not.toMatch(/Today reminds/);
    expect(hireFollowUpView({ ...hire, backups: { count: 1, people: hire.backups.people.slice(0, 1) } }, "Maria", after).keepWarmWords).toMatch(/Today will not remind you about them;/);
    expect(keepWarmToast("Maria", "2026-11-02", after)).toEqual({ title: "The role stays open.", detail: "Nobody was told anything. Close the role from its page when you are ready." });
  });
});

describe("Yes, interview: the approval filled in (plan H4)", () => {
  const draft = { applicationId: "a1", roleId: "r1", roundKey: "working", roundTitle: "Working interview", durationMinutes: 45, interviewerUserIds: ["u1", "u2"], window: { fromDate: "2026-10-12", toDate: "2026-10-23", businessDaysOnly: true }, nextRound: false };

  it("says what was filled in, and that nothing goes until the person approves", () => {
    expect(interviewDraftLine(draft)).toBe("Filled in from your interview plan: the Working interview (45 minutes), with 2 interviewers from the plan. Times are offered between Monday, October 12 and Friday, October 23, on working days. Check it and approve; nothing goes to the candidate until you do.");
    expect(interviewDraftLine({ ...draft, interviewerUserIds: [], nextRound: true })).toMatch(/the next round, Working interview \(45 minutes\), with nobody yet \(choose who interviews below\)/);
  });

  it("opens the candidate's panel with the interview approval from Today, once", () => {
    expect(interviewDraftPath(draft)).toBe("/roles/r1/talent?open=a1&step=interview&round=working");
    expect(interviewDraftPath(null)).toBeNull();
    expect(panelStepFrom("interview")).toBe("interview");
    expect(panelStepFrom("offer")).toBe("offer");
    expect(panelStepFrom("anything")).toBeNull();
    expect(panelStepFrom(null)).toBeNull();
    // any change of the panel drops the one-time step from the address
    expect(panelSearch("open=a1&step=interview&round=working", { open: "a1", tab: "notes" })).toBe("?open=a1&tab=notes");
    expect(panelSearch("open=a1&step=interview&round=working&view=board", { open: null })).toBe("?view=board");
  });
});

describe("the candidate panel's new parts", () => {
  it("has a Notes tab, between Messages and History", () => {
    expect(PANEL_TABS.map((t) => t.id)).toEqual(["overview", "screen", "resume", "messages", "notes", "history"]);
    expect(whoDecides(["owner", "admin"])).toBe("an owner or an admin");
    expect(whoDecides([])).toBe("an owner or an admin");
  });

  it("shows a PDF as itself and a Word file as its words inside the panel, through the API; anything else in a new tab", () => {
    const base = { id: "d1", filename: "maria.pdf", status: "clean", hasText: true };
    expect(resumeView("a1", { ...base, mime: "application/pdf" })).toEqual({ frame: "/api/v1/applications/a1/documents/d1/inline", asText: false, open: "/api/v1/applications/a1/documents/d1/file" });
    expect(resumeView("a1", { ...base, filename: "maria.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toMatchObject({ frame: "/api/v1/applications/a1/documents/d1/inline", asText: true });
    expect(resumeView("a1", { ...base, filename: "scan.png", mime: "image/png", hasText: false }).frame).toBeNull();
    expect(resumeView("a1", { ...base, status: "quarantined" }).frame).toBeNull();
    // an older answer without the type: the file name decides
    expect(resumeView("a1", base).asText).toBe(false);
    const docs = [{ id: "x", status: "rejected", kind: "resume" }, { id: "y", status: "clean", kind: "other" }, { id: "z", status: "clean", kind: "resume" }];
    expect(resumeToShow(docs, null)?.id).toBe("z");
    expect(resumeToShow(docs, "y")?.id).toBe("y");
    expect(resumeToShow([], null)).toBeNull();
  });

  it("tells the history of offers, notes (never their words) and the safety net in plain words", () => {
    expect(historyItem(ev("offer.created", { madeOn: "2026-10-06", note: "Start after notice" }))).toMatchObject({ what: "Recorded an offer made outside the app on Oct 6", why: "Start after notice", told: "Nothing was sent to the candidate." });
    expect(historyItem(ev("offer.accepted", {}))?.what).toBe("Recorded that they accepted the offer");
    expect(historyItem(ev("offer.declined", { outcome: "offer_declined_externally" }))?.what).toBe("Recorded that they declined the offer");
    expect(historyItem(ev("note.added", { noteId: "n1", starter: "after_interview" }))?.what).toBe("Added a private team note");
    expect(historyItem(ev("note.updated", { noteId: "n1", removed: true }))?.what).toBe("Removed their private team note");
    expect(historyItem(ev("application.untold_fallback", { action: "sent" }))).toMatchObject({ who: "The system", told: "Told by the decision message." });
    expect(historyItem(ev("application.untold_fallback", { action: "recruiter", why: "the settings ask for approval before a decision message goes" }))?.why).toBe("Nothing was sent, because the settings ask for approval before a decision message goes.");
    // the person's "offer made" is told once, by its own line
    expect(historyItem(ev("human.override", { action: "offer_made" }))).toBeNull();
  });
});

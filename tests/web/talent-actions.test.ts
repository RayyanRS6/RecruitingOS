import { describe, expect, it } from "vitest";
import type { ActiveMark, ApplicationDetail, CandidateNotice, StageMove } from "../../apps/web/src/api/client";
import { LOW_CONFIDENCE_LABEL, NO_QUOTE_LABEL, closerLook, competencyUnquoted, isUnquoted, lowConfidence, requirementUnquoted, scorecardUnavailable } from "../../apps/web/src/evidence";
import { NOT_NOW_TOAST, NOT_TOLD, PRIVATE_DECISION, actionToast, batches, briefDecisionToast, bulkSendToast, closeRoleToast, declineConfirmText, declineSummary, decisionToast, interviewCancelToast, interviewWords, mergeDecisionResults, newTimesToast, noticeText, outcomeNoticeText, outcomeToast, safetyNetAfterDecision, sendDecisionToast, stageBlocked, stageIntent } from "../../apps/web/src/talent-actions";

/**
 * The Candidates page's words (plans 0.5, 0.6, 0.9, A4, A6 and A9; founder decisions B3, B6 and D-03 A: moves and
 * decisions are private, so every toast says exactly whether the candidate was told, and a decision says on which day
 * the standard message goes by itself if nobody tells them first): the toasts after each choice, the decline step under
 * each setting, the stage button's choices, and the evidence marks. Pure functions, tested here.
 */
const NOTICES: CandidateNotice[] = ["not_told", "queued", "waiting_approval", "not_sent_settings", "not_sent_no_email", "not_sent"];
const mark = (over: Partial<ActiveMark>): ActiveMark => ({ id: "m1", mark: "shortlist", label: "Shortlist", remindAt: null, note: null, source: "manual", setAt: "2026-10-08T10:00:00.000Z", setBy: { kind: "user", id: "u1", name: "Dana" }, ...over });
/** A decision filed on Wednesday, October 14 (in the reader's own calendar): the fifth working day after is Wednesday, October 21. */
const NOW = new Date("2026-10-14T12:00:00");
/** The safety net with the company's setting not in the answer: both ways, with the day. */
const NET = "If nobody tells them first, the standard message goes by itself on Wednesday, October 21 (or an ITS recruiter is brought in, if your settings say so).";

describe("what the page says after a choice", () => {
  it("gives every outcome of the candidate's message its own words, and says 'not told' whenever nothing went", () => {
    const texts = NOTICES.map(noticeText);
    expect(new Set(texts).size).toBe(NOTICES.length);
    for (const n of NOTICES.filter((x) => x !== "queued")) expect(noticeText(n), n).toMatch(/not (been )?told/);
    expect(noticeText("queued")).toMatch(/on its way/);
  });

  it("a move to Not moving forward is private: the toast says so, never promises a message, and names the day the safety net acts (D-03 A)", () => {
    expect(actionToast("reject", { candidateNotice: "not_told" }, NOW)).toEqual({ title: "Moved to Not moving forward.", detail: `${PRIVATE_DECISION} ${NET}` });
    expect(PRIVATE_DECISION).toMatch(/^Private: the candidate was not told\./);
    // the answer's decision message says which way the company's settings run it
    expect(actionToast("reject", { candidateNotice: "not_told", decisionMessage: { policy: "sends", to: "luis@example.com" } }, NOW).detail).toBe(`${PRIVATE_DECISION} If nobody tells them first, the standard message goes by itself on Wednesday, October 21.`);
    expect(actionToast("reject", { candidateNotice: "not_told", decisionMessage: { policy: "needs_approval", to: "luis@example.com" } }, NOW).detail).toBe(`${PRIVATE_DECISION} If nobody tells them first, an ITS recruiter is brought in on Wednesday, October 21. Nothing is sent by itself.`);
    expect(safetyNetAfterDecision({ decisionMessage: { policy: "sends", to: null } }, NOW)).toMatch(/an ITS recruiter is brought in/);
    // an older answer without the notice falls back on whether a message went
    expect(actionToast("reject", {}, NOW).detail).toBe(`${PRIVATE_DECISION} ${NET}`);
    for (const n of NOTICES) if (n !== "queued") expect(actionToast("reject", { candidateNotice: n }).detail).not.toMatch(/on its way/);
  });

  it("marks are one-click and private; a hold names the day it ends", () => {
    expect(actionToast("set_mark", { mark: mark({}) })).toEqual({ title: "Moved to Shortlist.", detail: NOT_TOLD });
    expect(actionToast("set_mark", { mark: mark({ mark: "longlist", label: "Longlist" }) }).title).toBe("Moved to Longlist.");
    const hold = actionToast("set_mark", { mark: mark({ mark: "on_hold", label: "On hold", remindAt: "2026-10-22T15:00:00.000Z" }) });
    expect(hold.title).toMatch(/^On hold until October 2[1-3]\.$/);
    expect(hold.detail).toBe(`They come back to your Home page then. ${NOT_TOLD}`);
    expect(actionToast("hold", { mark: mark({ mark: "on_hold", label: "On hold", remindAt: null }) }).title).toBe("On hold.");
    expect(actionToast("clear_mark", { ownerStage: "new" })).toEqual({ title: "Moved to New.", detail: NOT_TOLD });
    expect(actionToast("clear_mark", { ownerStage: "interviewing" }).title).toBe("Moved to Interviewing.");
  });

  it("telling the candidate says what became of the message, and recording it in person sends nothing", () => {
    expect(actionToast("send_decision", { candidateNotice: "queued" })).toEqual(sendDecisionToast("queued"));
    expect(sendDecisionToast("queued").title).toBe("Decision message sent.");
    expect(sendDecisionToast("waiting_approval").detail).toMatch(/has not been told yet/);
    expect(sendDecisionToast("not_sent_settings").detail).toMatch(/Under your settings no decision messages are sent/);
    expect(sendDecisionToast("not_sent_no_email").detail).toMatch(/no email address/);
    expect(sendDecisionToast("not_sent").title).toBe("Not sent.");
    expect(actionToast("told_in_person", { candidateNotice: "not_told" })).toEqual({ title: "Recorded that you told them yourself.", detail: "Nothing more will be sent." });
  });

  it("several messages at once: every outcome counted, nothing hidden", () => {
    expect(bulkSendToast({ queued: 3, waitingApproval: 0, notSent: 0 })).toEqual({ title: "3 decision messages on their way." });
    expect(bulkSendToast({ queued: 1, waitingApproval: 1, notSent: 2 })).toEqual({ title: "1 decision message on its way.", detail: "1 waiting for approval; 2 not sent; the list says why." });
    expect(bulkSendToast({ queued: 0, waitingApproval: 0, notSent: 1 }).title).toBe("No decision messages were sent.");
  });

  it("the other choices keep their honest words", () => {
    expect(actionToast("advance_to_interview", { candidateNotice: "not_told" }).detail).toMatch(/^The candidate was not told/);
    expect(actionToast("move_to_talent_pool", {}, NOW)).toEqual({ title: "Added to your talent pool.", detail: `The candidate was not told. ${NET}` });
    // someone who asked not to be kept is never "added": the page says their choice stands
    const keptOut = actionToast("move_to_talent_pool", { candidateNotice: "not_told", talentPoolOptOut: true });
    expect(keptOut.title).toBe("Moved out of this role.");
    expect(keptOut.detail).toMatch(/They asked not to be kept for future roles, so they are not in your talent pool/);
    expect(actionToast("invite_screen", {})).toEqual({ title: "Invitation on its way." });
    expect(actionToast("ask_in_screen", { next: "Invitation on its way. The screen starts with the open questions." }).title).toBe("Invitation on its way. The screen starts with the open questions.");
    expect(actionToast("ask_in_screen", {}).title).toBe("Invitation on its way. The screening chat starts with these questions.");
    expect(actionToast("cancel_screen", { candidateNotice: "queued" }).title).toBe("Screening chat invitation stopped.");
    expect(actionToast("cancel_screen", {}).detail).toBe("Their link no longer works.");
    expect(actionToast("undo_decision", { ownerStage: "new" })).toEqual({ title: "Decision taken back: back in New.", detail: "They were never told, and nothing will be sent." });
    // never a bare "Done."
    expect(actionToast("something_new", {}).title).not.toBe("Done.");
  });

  it("the interview decision and a recorded outcome are private like every decision", () => {
    expect(decisionToast("finalist", {})).toEqual({ title: "Marked as a finalist.", detail: "The candidate was not told." });
    expect(decisionToast("not_moving_forward", { candidateNotice: "not_told" }, NOW)).toEqual({ title: "Recorded: not moving forward.", detail: `${PRIVATE_DECISION} ${NET}` });
    expect(decisionToast("next_round", { nextRoundKey: "r2" }).title).toBe("Next round.");
    expect(outcomeToast("employer_declined", { candidateNotice: "not_told" }, NOW).detail).toBe(`${PRIVATE_DECISION} ${NET}`);
    expect(outcomeToast("hired_externally", {})).toEqual({ title: "Hire recorded with your name." });
    expect(outcomeToast("candidate_withdrew", {})).toEqual({ title: "Outcome recorded with your name." });
  });

  it("Today's buttons say what they did: Not now sets the suggestion aside, a sent decision message reports itself", () => {
    expect(briefDecisionToast({ label: "Not now", body: { decision: "reject", note: "Not now" } }, { ok: true })).toEqual(NOT_NOW_TOAST);
    expect(NOT_NOW_TOAST.detail).toMatch(/was not told/);
    expect(briefDecisionToast({ label: "Do not send", body: { decision: "reject" } }, {}).title).toBe("Not sent.");
    expect(briefDecisionToast({ label: "Yes, send it", body: { decision: "approve" } }, { candidateNotice: "queued" })).toEqual(sendDecisionToast("queued"));
    expect(briefDecisionToast({ label: "Yes, invite to a screen", body: { decision: "approve" } }, {}).title).toBe("Invitation on its way.");
    expect(briefDecisionToast({ label: "Yes, invite to a screening chat", body: { decision: "approve" } }, {}).detail).toBe("The screening chat goes to the candidate by email, or by text when they agreed to texts.");
    expect(briefDecisionToast({ label: "Yes, interview", body: { decision: "approve" } }, {}).title).toBe("Moved to Interviewing.");
    expect(briefDecisionToast({ label: "Approve", body: { decision: "approve" } }, {}).title).toBe("Approved.");
  });
});

describe("the private decline step", () => {
  it("says before the click that nothing is sent now, and how the candidate will hear under the company's settings", () => {
    const sends = declineConfirmText("sends", { hasEmail: true });
    expect(sends).toMatch(/^Not moving forward is your decision, recorded with your reason\. It is private: nothing is sent to the candidate now\./);
    expect(sends).toMatch(/send the decision message from their page: a short, courteous email\.$/);
    expect(declineConfirmText("needs_approval", { hasEmail: true })).toMatch(/waits for approval before it goes out\.$/);
    expect(declineConfirmText("not_sent", { hasEmail: true })).toMatch(/no decision messages are sent, so tell them yourself/);
    expect(declineConfirmText("sends", { hasEmail: false })).toMatch(/no email address on file/);
    // the eligibility decline names what its message says
    expect(declineConfirmText("sends", { hasEmail: true, eligibility: true })).toMatch(/their answers did not show/);
    for (const p of ["sends", "needs_approval", "not_sent"] as const) expect(declineConfirmText(p, { hasEmail: true })).not.toMatch(/The candidate gets/);
  });

  it("names the interviews it calls off, by day and time: the candidate is told now that one they knew about is off, the decision only when you send it; one never offered just stops", () => {
    const booked = { title: "Phone screen", startsAt: "2026-10-14T18:00:00.000Z", timezone: "America/New_York", status: "scheduled", offeredSlots: [] };
    const offered = { title: "Working interview", startsAt: null, timezone: null, status: "scheduling", offeredSlots: [{ id: "s1" }] };
    const proposed = { title: "Team lunch", startsAt: null, timezone: null, status: "proposed", offeredSlots: [] };
    const iv = interviewWords(booked);
    // the interview's own time zone, whatever the reader's (ICU writes "at" or a comma between the date and the time)
    expect(iv).toMatch(/^the Phone screen on Wednesday, October 14(,| at) 2:00\sPM$/);
    expect(interviewWords(offered)).toBe("the Working interview (times offered, none chosen yet)");
    expect(interviewWords(proposed)).toBe("the Team lunch (times not offered yet)");
    const text = declineConfirmText("sends", { hasEmail: true, interviews: [booked, offered, proposed] });
    // the decision stays private; the interview note goes now, so nobody turns up to an interview that is off
    expect(text).toMatch(/^Not moving forward is your decision, recorded with your reason\. It is private: the decision itself is only sent to the candidate when you choose to send it\./);
    expect(text).not.toMatch(/nothing is sent to the candidate now/);
    expect(text).toContain(`This cancels ${iv} and the Working interview (times offered, none chosen yet), and the candidate is told now, in a short note that gives no reason, that they are off.`);
    expect(text).toContain("It also stops the Team lunch (times not offered yet); no times had gone to the candidate.");
    expect(text).toMatch(/send the decision message from their page: a short, courteous email\.$/);
    const one = declineConfirmText("sends", { hasEmail: true, interviews: [booked] });
    expect(one).toContain(`This cancels ${iv}, and the candidate is told now, in a short note that gives no reason, that it is off.`);
    // where the product sends no decision messages, the note about the interview still goes; the decision is not sent
    const noMessages = declineConfirmText("not_sent", { hasEmail: true, interviews: [booked] });
    expect(noMessages).toMatch(/It is private: the decision itself is not sent to the candidate\. This cancels /);
    expect(noMessages).toMatch(/no decision messages are sent, so tell them yourself/);
    // an interview never offered to them sends nothing, so nothing is sent now
    const notOffered = declineConfirmText("sends", { hasEmail: true, interviews: [proposed] });
    expect(notOffered).toMatch(/It is private: nothing is sent to the candidate now\./);
    expect(notOffered).not.toMatch(/told now/);
    expect(declineConfirmText("sends", { hasEmail: true, interviews: [] })).not.toMatch(/cancels|stops/);
    // "Record what happened" says the same: nothing about the outcome goes, but an interview they knew of is called off
    expect(outcomeNoticeText([])).toBe("Nothing is sent to the candidate.");
    expect(outcomeNoticeText([proposed])).toBe("Nothing is sent to the candidate.");
    expect(outcomeNoticeText([booked])).toBe(`Nothing about the outcome is sent to the candidate. Unless it is a hire, ${iv} is called off, and they are told now, in a short note that gives no reason, that it is off.`);
    expect(outcomeNoticeText([booked, offered])).toMatch(/ are called off, and they are told now, in a short note that gives no reason, that they are off\.$/);
  });

  it("the decline's toast says the interview was called off and the candidate was told only that it is off", () => {
    expect(actionToast("reject", { candidateNotice: "not_told", interviewsCancelled: 1, interviewOffNotes: 1 }, NOW).detail).toBe(`${PRIVATE_DECISION} Their interview is cancelled, and they were sent a short note now saying only that it is off. ${NET}`);
    expect(decisionToast("not_moving_forward", { candidateNotice: "not_told", interviewsCancelled: 2, interviewOffNotes: 2 }).detail).toMatch(/2 interviews are cancelled, and they were sent a short note now saying only that they are off\. If nobody tells them first/);
    expect(actionToast("move_to_talent_pool", { interviewsCancelled: 1, interviewOffNotes: 1 }, NOW).detail).toBe(`The candidate was not told. Their interview is cancelled, and they were sent a short note now saying only that it is off. ${NET}`);
    expect(outcomeToast("employer_declined", { candidateNotice: "not_told", interviewsCancelled: 1, interviewOffNotes: 1 }).detail).toMatch(/they were sent a short note now saying only that it is off\. If nobody tells them first/);
    expect(outcomeToast("no_hire", { candidateNotice: "not_told", interviewsCancelled: 0 }, NOW).detail).toBe(`${PRIVATE_DECISION} ${NET}`);
    // an interview whose times had not gone out is stopped, and nothing is said to have been sent
    expect(actionToast("reject", { candidateNotice: "not_told", interviewsCancelled: 1, interviewOffNotes: 0 }, NOW).detail).toBe(`${PRIVATE_DECISION} Their interview is stopped; no times had gone to them, so nothing was sent about it. ${NET}`);
    expect(actionToast("reject", { candidateNotice: "not_told", interviewsCancelled: 2, interviewOffNotes: 1 }, NOW).detail).toBe(`${PRIVATE_DECISION} Their interview is cancelled, and they were sent a short note now saying only that it is off. Another interview is stopped; no times had gone to them for it. ${NET}`);
  });

  it("before the click, the decline step says in short lines that it is private, what it calls off, and the safety net's day; the rest one click away", () => {
    const booked = { title: "Phone screen", startsAt: "2026-10-14T18:00:00.000Z", timezone: "America/New_York", status: "scheduled", offeredSlots: [] };
    expect(declineSummary("sends", { hasEmail: true, now: NOW })).toEqual(["Private: nothing is sent to them now.", "If nobody tells them first, the standard message goes by itself on Wednesday, October 21."]);
    expect(declineSummary("sends", { hasEmail: true, interviews: [booked], now: NOW })[0]).toBe("Private: the decision is not sent now. Their interview is called off, and they get a short note saying so.");
    expect(declineSummary("needs_approval", { hasEmail: true, now: NOW })[1]).toBe("If nobody tells them first, an ITS recruiter is brought in on Wednesday, October 21. Nothing is sent by itself.");
    expect(declineSummary("sends", { hasEmail: false, now: NOW })[1]).toMatch(/an ITS recruiter is brought in/);
    // each line stays short enough to read at a glance
    for (const line of declineSummary("sends", { hasEmail: true, interviews: [booked, booked], now: NOW })) expect(line.split(" ").length).toBeLessThanOrEqual(22);
  });

  it("closing a role says who moved privately, which interviews ended, and who was told only that theirs is off", () => {
    expect(closeRoleToast({ movedToTalentPool: 3, heldEmailsAddedToTalentPool: 1, interviewsCancelled: 1, interviewOffNotes: 1, closingMessage: { policy: "sends" } }, undefined, true, NOW)).toEqual({ title: "Role closed as filled.", detail: "The 2 people still in the process moved to your talent pool, privately: nobody is told yet. Send the closing message when you are ready. If nobody tells them first, the closing message goes by itself on Wednesday, October 21. 1 interview was cancelled; the candidate was sent a short note now saying only that it is off." });
    expect(closeRoleToast({ movedToTalentPool: 2, interviewsCancelled: 2, interviewOffNotes: 2 }).detail).toMatch(/2 interviews were cancelled; each candidate was sent a short note now saying only that their interview is off\.$/);
    expect(closeRoleToast({ movedToTalentPool: 3, interviewsCancelled: 3, interviewOffNotes: 2 }).detail).toMatch(/3 interviews were cancelled; the 2 candidates who had a time booked or offered were sent a short note now saying only that their interview is off\.$/);
    expect(closeRoleToast({ movedToTalentPool: 1, interviewsCancelled: 1, interviewOffNotes: 0 }).detail).toMatch(/1 interview was cancelled; no times had gone to the candidate, so nothing was sent about it\.$/);
    expect(closeRoleToast({ movedToTalentPool: 1 }).detail).toMatch(/^The one person still in the process moved/);
    expect(closeRoleToast({}).detail).toBe("Nobody else was still in the process.");
    // the role page closes with any outcome, under its own title
    expect(closeRoleToast({ movedToTalentPool: 2 }, "Role closed; the outcome is recorded with your name.").title).toBe("Role closed; the outcome is recorded with your name.");
  });

  it("closing a role never says nothing will go by itself: the safety net (Q27) is named the way the settings run it, with its day (D-03 A)", () => {
    // settings ask for approval: nothing goes by itself, a recruiter is brought in
    expect(closeRoleToast({ movedToTalentPool: 2, closingMessage: { policy: "needs_approval" } }, undefined, true, NOW).detail).toBe("The 2 people still in the process moved to your talent pool, privately: nobody is told yet. Send the closing message when you are ready. If nobody tells them first, an ITS recruiter is brought in on Wednesday, October 21. Nothing is sent by itself.");
    // only a person sends decision messages: tell them yourself
    expect(closeRoleToast({ movedToTalentPool: 1, closingMessage: { policy: "not_sent" } }, undefined, true, NOW).detail).toBe("The one person still in the process moved to your talent pool, privately: nobody is told yet. Under your settings no message is sent: tell each of them yourself, then record it on their page. If nobody tells them first, an ITS recruiter is brought in on Wednesday, October 21. Nothing is sent by itself.");
    // the setting not known: both ways are said
    expect(closeRoleToast({ movedToTalentPool: 2 }, undefined, true, NOW).detail).toMatch(/If nobody tells them first, the closing message goes by itself on Wednesday, October 21 \(or an ITS recruiter is brought in, if your settings say so\)\.$/);
  });

  it("HR, who may close a role but not tell candidates, is told who sends the closing message instead of being asked to", () => {
    const hr = closeRoleToast({ movedToTalentPool: 2, closingMessage: null }, "Role closed; the outcome is recorded with your name.", false, NOW).detail!;
    expect(hr).toBe("The 2 people still in the process moved to your talent pool, privately: nobody is told yet. An owner, admin, hiring manager or recruiter sends them the closing message; it waits on their Home page. If nobody tells them first, the closing message goes by itself on Wednesday, October 21 (or an ITS recruiter is brought in, if your settings say so).");
    expect(hr).not.toMatch(/you send/i);
  });
});

describe("cancelling an interview on the Interviews page", () => {
  it("says exactly who was told, from the API's answer", () => {
    expect(interviewCancelToast({ candidateTold: true, interviewersTold: true })).toEqual({ title: "Interview cancelled.", detail: "The candidate was sent a cancellation. The interviewers were told." });
    expect(interviewCancelToast({ candidateTold: false, interviewersTold: false }).detail).toBe("The candidate had no time booked or offered, so nothing was sent to them.");
  });
});

describe("new times for someone under Cancelled (founder decisions 1A to 4A)", () => {
  it("says the times are being got ready, never that they went: they count as sent once their email is on its way", () => {
    expect(newTimesToast({ kind: "sent", via: "reopened", firstName: "Ana", round: "Working interview" })).toEqual({ title: "Getting new times ready.", detail: "Ana gets an email as soon as there are times to offer from the interviewers' calendars. They stay under Cancelled until they book." });
    // after a no-show: a new interview for the same round
    expect(newTimesToast({ kind: "sent", via: "new_interview", firstName: "Cleo", round: "Working interview" })).toEqual({ title: "A new working interview was set up.", detail: "Same round; Cleo gets an email as soon as there are times to offer." });
    expect(newTimesToast({ kind: "sent", via: "new_interview", firstName: "Cleo", round: "First Interview" }).title).toBe("A new first interview was set up.");
    expect(newTimesToast({ kind: "stopped" })).toEqual({ title: "Stopped.", detail: "Nothing goes to them automatically; they stay under Cancelled." });
    for (const t of [newTimesToast({ kind: "sent", via: "reopened", firstName: "Ana", round: "Phone screen" }), newTimesToast({ kind: "batch", results: [], sent: 2, notSent: 0 })]) expect(`${t.title} ${t.detail ?? ""}`).not.toMatch(/\bsent\b|on (its|their) way/i);
  });

  it("several people at once: how many are being got ready, and each refusal with its reason", () => {
    expect(newTimesToast({ kind: "batch", results: [{ applicationId: "a1", name: "Ana Lopez", ok: true, interviewId: "iv1" }], sent: 1, notSent: 0 })).toEqual({ title: "Getting new times ready for 1 person." });
    const mixed = newTimesToast({
      kind: "batch",
      results: [
        { applicationId: "a1", name: "Ana Lopez", ok: true },
        { applicationId: "a2", name: "Ben Ortiz", ok: false, code: "times_out", message: "New times are already being prepared or are out to them." },
        { applicationId: "a3", name: "Cleo Park", ok: false, code: "no_email", message: "We have no email address for them. Call them, then book a time from the interview page." },
      ],
      sent: 1,
      notSent: 2,
    });
    expect(mixed).toEqual({ title: "Getting new times ready for 1 person.", detail: "Not sent: Ben Ortiz (New times are already being prepared or are out to them); Cleo Park (We have no email address for them. Call them, then book a time from the interview page)." });
    expect(newTimesToast({ kind: "batch", results: [{ applicationId: "a2", name: "Ben Ortiz", ok: false, code: "company_not_checked", message: "New times can go out once ITS confirms your company. Until then, emails to candidates wait." }], sent: 0, notSent: 1 }).title).toBe("No new times were sent.");
    expect(newTimesToast({ kind: "batch", results: [], sent: 3, notSent: 0 }).title).toBe("Getting new times ready for 3 people.");
  });

  it("a decision taken back to Cancelled says, in the API's words, whether their new times still go by themselves", () => {
    const back = actionToast("undo_decision", { ownerStage: "cancelled", next: "Decision taken back: they are back under Cancelled. They were never told. Their new times still go to them automatically on Thursday, October 15, as they asked." });
    expect(back).toEqual({ title: "Decision taken back: back in Cancelled.", detail: "They were never told. Their new times still go to them automatically on Thursday, October 15, as they asked." });
    expect(actionToast("undo_decision", { ownerStage: "cancelled", next: "Decision taken back: they are back under Cancelled. They were never told. Nothing will be sent until you act." }).detail).toBe("They were never told. Nothing will be sent until you act.");
    expect(actionToast("undo_decision", { ownerStage: "cancelled" }).detail).toBe("They were never told.");
    // never "nothing will be sent" about a set that will go
    expect(back.detail).not.toMatch(/nothing will be sent/i);
  });
});

describe("sending to many people at once", () => {
  it("goes in requests of at most a hundred and adds the answers up, each person's own result kept", () => {
    const ids = Array.from({ length: 230 }, (_, i) => `a${i}`);
    expect(batches(ids).map((b) => b.length)).toEqual([100, 100, 30]);
    expect(batches(ids).flat()).toEqual(ids);
    expect(batches([])).toEqual([]);
    const merged = mergeDecisionResults([{ results: [{ applicationId: "a", ok: true, candidateNotice: "queued" }], queued: 1, waitingApproval: 0, notSent: 0 }, { results: [{ applicationId: "b", ok: false, code: "not_decided" }, { applicationId: "c", ok: true, candidateNotice: "held" }], queued: 0, held: 1, waitingApproval: 0, notSent: 1 }]);
    // a message held for the ITS company check is counted apart from those on their way (founder decision B7)
    expect(merged).toEqual({ results: [{ applicationId: "a", ok: true, candidateNotice: "queued" }, { applicationId: "b", ok: false, code: "not_decided" }, { applicationId: "c", ok: true, candidateNotice: "held" }], queued: 1, held: 1, waitingApproval: 0, notSent: 1 });
  });
});

describe("the stage button's choices", () => {
  const move = (over: Partial<StageMove>): StageMove => ({ to: "shortlist", label: "Shortlist", via: "set_mark", mark: "shortlist", allowed: true, current: false, ...over });

  it("Longlist and Shortlist are one click; New clears the mark; everything that needs more opens its step", () => {
    expect(stageIntent(move({}))).toEqual({ kind: "action", body: { action: "set_mark", mark: "shortlist" } });
    expect(stageIntent(move({ to: "longlist", mark: "longlist" }))).toEqual({ kind: "action", body: { action: "set_mark", mark: "longlist" } });
    expect(stageIntent(move({ to: "new", via: "clear_mark", mark: undefined }))).toEqual({ kind: "action", body: { action: "clear_mark" } });
    expect(stageIntent(move({ to: "on_hold", mark: "on_hold" }))).toEqual({ kind: "step", step: "hold" });
    expect(stageIntent(move({ to: "interviewing", via: "interview", mark: undefined }))).toEqual({ kind: "step", step: "interview" });
    expect(stageIntent(move({ to: "hired", via: "record_hire", mark: undefined }))).toEqual({ kind: "step", step: "hire" });
    // Offer opens the record-only "Offer made" (plan H2): the app never writes or sends the offer
    expect(stageIntent(move({ to: "offer", via: "offer", mark: undefined }))).toEqual({ kind: "step", step: "offer" });
    expect(stageIntent(move({ to: "not_moving_forward", via: "decline", mark: undefined }))).toEqual({ kind: "step", step: "decline" });
    // a decision nobody told, taken back to the step it was made from (plan G1)
    expect(stageIntent(move({ to: "new", via: "undo_decision", mark: undefined }))).toEqual({ kind: "action", body: { action: "undo_decision" } });
  });

  it("does nothing for the stage they are at, or a move that is not allowed", () => {
    expect(stageIntent(move({ current: true, via: "none" }))).toEqual({ kind: "none" });
    expect(stageIntent(move({ allowed: false, blockedReason: "They are interviewing already." }))).toEqual({ kind: "none" });
  });

  it("greys out every move that is not allowed, with its reason, and never the current stage", () => {
    const blocked = stageBlocked([
      move({ to: "new", via: "none", allowed: false, current: true, blockedReason: "They are here now." }),
      move({ to: "offer", via: "offer", allowed: false, blockedReason: 'Record an offer once they are a finalist (they are at "Ready for your review").' }),
      move({ to: "hired", via: "record_hire", allowed: false }),
      move({}),
    ]);
    expect(blocked).toEqual({ offer: 'Record an offer once they are a finalist (they are at "Ready for your review").', hired: "Not available at this step." });
  });
});

describe("evidence marks", () => {
  it("marks a claim about the candidate with nothing quoted, and leaves sources that are not about them alone", () => {
    expect(NO_QUOTE_LABEL).toBe("no quote");
    expect(isUnquoted({ source: "resume", unquoted: true })).toBe(true);
    // readings written before the mark are read by the same rule
    expect(isUnquoted({ source: "resume" })).toBe(true);
    expect(isUnquoted({ source: "screen", quote: "  " })).toBe(true);
    expect(isUnquoted({ source: "resume", quote: "RDH license CA active" })).toBe(false);
    expect(isUnquoted({ source: "benchmark" })).toBe(false);
    expect(isUnquoted(undefined)).toBe(false);
    expect(requirementUnquoted({ met: "yes" })).toBe(true);
    expect(requirementUnquoted({ met: "unknown" })).toBe(false);
    expect(requirementUnquoted({ met: "partially", evidence: { source: "resume", quote: "perio charting" } })).toBe(false);
    expect(competencyUnquoted({ finding: "evidenced", evidence: { source: "resume" } })).toBe(true);
    expect(competencyUnquoted({ finding: "not_evidenced" })).toBe(false);
  });

  it("says the scorecard could not be written only when the latest screen's run gave up", () => {
    const withScreens = (screens: Array<Partial<ApplicationDetail["screens"][number]>>) => ({ screens } as unknown as ApplicationDetail);
    expect(scorecardUnavailable(withScreens([{ scorecard: "unavailable", recruiterAsked: true }]))).toEqual({ unavailable: true, recruiterAsked: true });
    expect(scorecardUnavailable(withScreens([{ scorecard: "writing" }]))).toEqual({ unavailable: false, recruiterAsked: false });
    // an older screen's failure is not the one on the page
    expect(scorecardUnavailable(withScreens([{ scorecard: "ready" }, { scorecard: "unavailable", recruiterAsked: true }]))).toEqual({ unavailable: false, recruiterAsked: false });
    expect(scorecardUnavailable(withScreens([]))).toEqual({ unavailable: false, recruiterAsked: false });
  });

  it("asks the reader to read a low-confidence reading themselves, without calling it a closer look", () => {
    expect(LOW_CONFIDENCE_LABEL).toBe("Read this one yourself");
    expect(lowConfidence({ confidence: "low" })).toBe(true);
    expect(lowConfidence({ confidence: "medium" })).toBe(false);
    expect(lowConfidence(null)).toBe(false);
    const detail = (over: Partial<ApplicationDetail>) => ({ stage: "triaged", assessments: [{ id: "a1", kind: "triage", overall: "potential", confidence: "low", createdAt: "2026-10-01T00:00:00.000Z", result: { summary: "s", strengths: [], concerns: [], unknowns: [], rationale: "r", recommendation: "screen" } }], documents: [], extraction: null, ...over }) as unknown as ApplicationDetail;
    expect(closerLook(detail({}))).toMatchObject({ needsCloserLook: false, lowConfidence: true });
  });

  it("mirrors the consistency check (plan A8): a reading that disagrees with its own must-have findings needs a closer look, with the reason", () => {
    const reading = (over: Record<string, unknown>, result: Record<string, unknown> = {}) => ({ id: "a1", kind: "triage", overall: "strong", confidence: "high", createdAt: "2026-10-01T00:00:00.000Z", ...over, result: { summary: "s", strengths: [], concerns: [], unknowns: [], rationale: "r", recommendation: "screen", requirementFindings: [], ...result } });
    const detail = (stage: string, assessments: unknown[]) => ({ stage, assessments, documents: [], extraction: null, packetLabels: { mustHaves: [{ key: "rdh_license", text: "Active CA RDH license" }], competencies: [], questions: [] } }) as unknown as ApplicationDetail;
    const miss = { requirementKey: "rdh_license", met: "no", evidence: { source: "resume", quote: "RDH license expired in 2021" } };
    const look = closerLook(detail("triaged", [reading({}, { requirementFindings: [miss] })]));
    expect(look).toMatchObject({ needsCloserLook: true, inconsistent: true, checkedId: "a1" });
    expect(look.reason).toBe('The AI review says Strong match, but the candidate\'s own words show a must-have is not met (Active CA RDH license): "RDH license expired in 2021". Read it yourself before anything else happens.');
    // a "no" without a checked quote is not proof, and a weak reading with a missing must-have agrees with itself
    expect(closerLook(detail("triaged", [reading({}, { requirementFindings: [{ ...miss, evidence: { source: "resume", unquoted: true } }] })])).needsCloserLook).toBe(false);
    expect(closerLook(detail("triaged", [reading({ overall: "weak" }, { recommendation: "hold", requirementFindings: [miss] })])).needsCloserLook).toBe(false);
    // a step suggested for a weak reading; the screen's reading is checked once the screen is complete
    expect(closerLook(detail("triaged", [reading({ overall: "weak" })])).reason).toMatch(/suggested a screening chat, but its AI review says Weak match/);
    const screen = reading({ id: "s1", kind: "screen", overall: "unknown" }, { recommendation: "interview" });
    expect(closerLook(detail("screen_complete", [screen, reading({})]))).toMatchObject({ needsCloserLook: true, inconsistent: true, checkedId: "s1" });
    // past the step, nothing is held any more
    expect(closerLook(detail("interview_recommended", [screen])).needsCloserLook).toBe(false);
  });

  it("mirrors the check on an Essential skill (plan F3): a Strong reading whose own quote goes against one needs a closer look", () => {
    const against = { competencyKey: "chairside", finding: "contradicted", evidence: { source: "resume", quote: "I avoid chairside work" } };
    const detail = (importance: string) => ({ stage: "triaged", assessments: [{ id: "a1", kind: "triage", overall: "strong", confidence: "high", createdAt: "2026-10-01T00:00:00.000Z", result: { summary: "s", strengths: [], concerns: [], unknowns: [], rationale: "r", recommendation: "screen", requirementFindings: [], competencyFindings: [against] } }], documents: [], extraction: null, packetLabels: { mustHaves: [], competencies: [{ key: "chairside", name: "Chairside skill", importance }], questions: [] } }) as unknown as ApplicationDetail;
    const look = closerLook(detail("essential"));
    expect(look).toMatchObject({ needsCloserLook: true, inconsistent: true });
    expect(look.reason).toBe('The AI review says Strong match, but the candidate\'s own words go against an essential skill (Chairside skill): "I avoid chairside work". Read it yourself before anything else happens.');
    expect(closerLook(detail("helpful")).needsCloserLook).toBe(false);
  });
});

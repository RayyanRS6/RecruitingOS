import { describe, expect, it } from "vitest";
import { titleMidSentence } from "../../packages/contracts/src/domain/interview";
import { autoReasonText } from "../../packages/core/src/interview-followups";
import type { ApplicationSummary, CancelledView } from "../../apps/web/src/api/client";
import {
  CANCELLED_REASONS, NEW_TIMES_SETUP, cancelledAlertText, cancelledBody, cancelledChips, cancelledReasonFrom, cancelledTitle, interviewNewTimesText, mergeNewTimesResults, newTimesOpen, newTimesReadOnlyText,
  newTimesResultLine, newTimesSavedNotice, newTimesSendLabel, newTimesSettingFrom, newTimesSettingText, newTimesSheetRows, notSentReasonText, pendingQuestion, promisedDay, sendNewTimesQuestion, stopNewTimesQuestion, workingDaysFrom,
} from "../../apps/web/src/cancelled";

/**
 * The Cancelled column as the team's pages say it (founder decisions 1A to 4A, 9 October 2026): the chips and the alert on
 * the Talent page, the sheet that sends new times to several people, the candidate panel's card, and Setup's "When a
 * candidate cancels". Every sentence follows the state the API reports, so nothing is promised that will not happen.
 */
const view = (over: Partial<CancelledView> & { auto?: Partial<CancelledView["auto"]> } = {}): CancelledView => {
  const { auto, ...rest } = over;
  return {
    id: "f1", reason: "asked_new_times", label: "Asked for new times", since: "2026-10-09T21:00:00.000Z", interviewId: "iv1", times: "none", lastSentAt: null, lastSentVia: null, status: "Waiting for you",
    ...rest,
    auto: { state: "none", reason: null, reasonText: null, dueAt: null, dueDay: null, sentAt: null, ...auto },
  };
};
let n = 0;
const person = (name: string, c: CancelledView | null, over: Partial<ApplicationSummary> = {}) => {
  n += 1;
  return { id: `a${n}`, candidate: { id: `c${n}`, name, email: `${name.split(" ")[0].toLowerCase()}@example.com`, phone: null, locationText: null }, ownerStage: c ? ("cancelled" as const) : ("interviewing" as const), cancelled: c, ...over };
};

describe("the chips and the alert on the Talent page", () => {
  it("splits the column by reason, in a fixed order, from the API's counts or from the rows", () => {
    expect(CANCELLED_REASONS).toEqual(["asked_new_times", "not_interested", "no_show"]);
    expect(cancelledChips({ askedNewTimes: 2, notInterested: 0, noShow: 1 }, []).map((c) => `${c.label} ${c.count}`)).toEqual(["Asked for new times 2", "No longer interested 0", "No-show 1"]);
    const rows = [person("Ana Lopez", view()), person("Ben Ortiz", view({ reason: "no_show" })), person("Cleo Park", view({ reason: "no_show" })), person("Dana Reyes", null)];
    expect(cancelledChips(null, rows).map((c) => c.count)).toEqual([1, 0, 2]);
    expect(cancelledReasonFrom("no_show")).toBe("no_show");
    expect(cancelledReasonFrom("maybe")).toBeNull();
    expect(cancelledReasonFrom(null)).toBeNull();
  });

  it("says who waits for the team, following the company's setting", () => {
    expect(cancelledAlertText(3, true)).toBe("3 people are under Cancelled. Only people who asked for new times get one set automatically; everyone else waits for you.");
    expect(cancelledAlertText(1, false)).toBe("1 person is under Cancelled. Automatic new times are off, so everyone here waits for you.");
    // the setting not known yet: only the count, nothing promised either way
    expect(cancelledAlertText(2, undefined)).toBe("2 people are under Cancelled.");
    expect(cancelledAlertText(3, true, true)).toBe("3 people are under Cancelled. Only people who asked for new times get one set automatically; everyone else waits for you.");
  });

  it("before ITS confirms the company, promises nothing automatic, whatever the setting, and says the team can send after that", () => {
    for (const auto of [true, false, undefined]) {
      expect(cancelledAlertText(2, auto, false)).toBe("2 people are under Cancelled. Nothing goes to anyone here automatically until ITS confirms your company. You can send new times after that.");
    }
  });
});

describe("the sheet that sends new times to several people", () => {
  const ana = person("Ana Lopez", view());
  const ben = person("Ben Ortiz", view({ reason: "not_interested" }));
  const cleo = person("Cleo Park", view({ reason: "no_show" }));
  const dev = person("Dev Shah", view({ times: "out" }));
  const eve = person("Eve Long", view({ times: "expired" }));
  const fay = person("Fay Noor", view(), { candidate: { id: "cf", name: "Fay Noor", email: null, phone: null, locationText: null } });
  const gus = person("Gus Lee", null);

  it("ticks people who asked and people who did not come; lists 'no longer interested' unticked; cannot tick anyone whose times are open", () => {
    const rows = newTimesSheetRows([ana, ben, cleo, dev, eve, fay, gus]);
    expect(rows.map((r) => `${r.name}${r.note}|${r.ticked ? "ticked" : "unticked"}|${r.disabled ? "disabled" : "enabled"}`)).toEqual([
      "Ana Lopez|ticked|enabled",
      "Ben Ortiz (said they are no longer interested)|unticked|enabled",
      "Cleo Park|ticked|enabled",
      "Dev Shah (new times already being prepared or out)|unticked|disabled",
      // times that passed without a pick can go again
      "Eve Long|ticked|enabled",
      "Fay Noor (no email address on file)|unticked|enabled",
    ]);
    for (const times of ["preparing", "held", "out", "not_reached"] as const) expect(newTimesOpen(times)).toBe(true);
    for (const times of ["none", "expired"] as const) expect(newTimesOpen(times)).toBe(false);
  });

  it("says how many on the button, and each person's own result after", () => {
    expect(newTimesSendLabel(1)).toBe("Send new times to 1 person");
    expect(newTimesSendLabel(4)).toBe("Send new times to 4 people");
    expect(newTimesResultLine({ applicationId: "a1", name: "Ana Lopez", ok: true, interviewId: "iv1" })).toBe("Getting new times ready");
    expect(newTimesResultLine({ applicationId: "a2", name: "Ben Ortiz", ok: false, code: "times_out", message: "New times are already being prepared or are out to them." })).toBe("New times are already being prepared or are out to them.");
    expect(newTimesResultLine({ applicationId: "a3", name: "Cleo Park", ok: false })).toBe("Not sent.");
    const merged = mergeNewTimesResults([{ results: [{ applicationId: "a1", name: "Ana", ok: true }], sent: 1, notSent: 0 }, { results: [{ applicationId: "a2", name: "Ben", ok: false, code: "not_in_cancelled" }], sent: 0, notSent: 1 }]);
    expect(merged).toEqual({ results: [{ applicationId: "a1", name: "Ana", ok: true }, { applicationId: "a2", name: "Ben", ok: false, code: "not_in_cancelled" }], sent: 1, notSent: 1 });
  });
});

describe("the candidate panel's card", () => {
  const body = (c: CancelledView) => cancelledBody({ firstName: "Ana", round: "Working interview", c });

  it("names what they chose, or that they did not come", () => {
    expect(cancelledTitle("Ana", "asked_new_times")).toBe("Ana cancelled and asked for new times");
    expect(cancelledTitle("Ana", "not_interested")).toBe("Ana cancelled: no longer interested");
    expect(cancelledTitle("Ana", "no_show")).toBe("Ana did not come to the interview");
  });

  it("says the promised day while the automatic set waits, and why nothing went otherwise", () => {
    const waiting = view({ auto: { state: "waiting", dueAt: "2026-10-15T16:00:00.000Z", dueDay: "2026-10-15" } });
    expect(body(waiting)).toBe("New times go to them automatically on Thursday, October 15, as your settings say. Send them now instead, or stop the automatic set.");
    expect(body(view({ auto: { state: "waiting_check", dueAt: "2026-10-15T16:00:00.000Z", dueDay: "2026-10-15" } }))).toBe("New times were due on Thursday, October 15. They wait until ITS confirms your company again.");
    expect(body(view({ auto: { state: "none", reason: "switched_off", reasonText: "Automatic new times are off in Setup." } }))).toBe("Automatic new times are off in Setup. Send new times when you are ready, or decide.");
    expect(body(view({ auto: { state: "not_sent", reason: "takeover", reasonText: "An ITS recruiter is running this role, so nothing was sent automatically." } }))).toBe("An ITS recruiter is running this role, so nothing was sent automatically. Send new times when you are ready, or decide.");
    // back under Cancelled after a decision was taken back, the set not pending
    expect(body(view({ auto: { state: "not_sent", reason: "left_process", reasonText: "Nothing went automatically while a decision was in place." } }))).toBe("Nothing went automatically while a decision was in place. Send new times when you are ready, or decide.");
    expect(body(view())).toBe("Send new times when you are ready, or decide.");
    expect(body(view({ reason: "not_interested", auto: { reason: "not_asked" } }))).toBe("They told us they are no longer interested in this interview. Nothing goes to them automatically. You can still send new times, or decide.");
    // the interview's title mid-sentence, in lower case, as the candidate's emails say it; "decide below" only when the
    // decision card is there (a missed interview already decided has none: the stage at the top moves them on)
    const noShow = view({ reason: "no_show", auto: { reason: "no_show" } });
    expect(cancelledBody({ firstName: "Ana", round: "Working interview", c: noShow, decideBelow: true })).toBe("The working interview was booked and they did not come. Nothing goes to them automatically. Send new times for the same round, or decide below.");
    expect(body(noShow)).toBe("The working interview was booked and they did not come. Nothing goes to them automatically. Send new times for the same round, or choose their next stage at the top.");
    expect(cancelledBody({ firstName: "Ana", round: "HR Screening Call", c: noShow, decideBelow: true })).toMatch(/^The HR screening call was booked/);
  });

  it("before ITS confirms the company, never promises automatic times and says new times can be sent once it does", () => {
    const unconfirmed = (c: CancelledView, decideBelow = false) => cancelledBody({ firstName: "Ana", round: "Working interview", c, companyConfirmed: false, decideBelow });
    // the usual case: nothing was armed at the cancel
    const notChecked = view({ auto: { state: "none", reason: "company_not_checked", reasonText: "ITS had not confirmed your company in time, so nothing was sent automatically." } });
    expect(unconfirmed(notChecked)).toBe("ITS had not confirmed your company in time, so nothing was sent automatically. You can send new times once ITS confirms your company, or decide.");
    // once ITS has confirmed it, the same reason is history, and a send is offered without contradicting it
    expect(body(notChecked)).toBe("ITS had not confirmed your company in time, so nothing was sent automatically. Send new times when you are ready, or decide.");
    expect(unconfirmed(view())).toBe("Nothing goes to them automatically until ITS confirms your company. You can send new times after that, or decide.");
    // armed before ITS took its confirmation back: the day is not promised as certain
    expect(unconfirmed(view({ auto: { state: "waiting", dueAt: "2026-10-15T16:00:00.000Z", dueDay: "2026-10-15" } }))).toBe("New times are due to go to them automatically on Thursday, October 15, but nothing goes until ITS confirms your company again, so they may go later than that. You can stop the automatic set.");
    expect(unconfirmed(view({ reason: "not_interested", auto: { reason: "not_asked" } }))).toBe("They told us they are no longer interested in this interview. Nothing goes to them automatically. You can send new times once ITS confirms your company, or decide.");
    expect(unconfirmed(view({ reason: "no_show", auto: { reason: "no_show" } }), true)).toBe("The working interview was booked and they did not come. Nothing goes to them automatically. You can send new times for the same round once ITS confirms your company, or decide below.");
    expect(unconfirmed(view({ times: "expired" }))).toBe("The new times passed without a pick. Nothing more goes to them until ITS confirms your company. You can send new times once ITS confirms your company, or decide.");
    for (const text of [unconfirmed(view()), unconfirmed(view({ reason: "no_show" })), unconfirmed(view({ reason: "not_interested" }))]) expect(text).not.toMatch(/go to them automatically on|Send new times when you are ready|Send new times for the same round/);
  });

  it("follows the new times once an interview carries them, whatever the reason", () => {
    for (const reason of ["asked_new_times", "not_interested", "no_show"] as const) {
      expect(body(view({ reason, times: "preparing", auto: { state: reason === "asked_new_times" ? "preparing" : "none" } }))).toBe("Getting new times ready. Ana gets them by email as soon as there are times to offer from the interviewers' calendars.");
      expect(body(view({ reason, times: "held" }))).toBe("New times are ready. The email waits until ITS confirms your company.");
      expect(body(view({ reason, times: "out", lastSentAt: "2026-10-15T16:00:00.000Z" }))).toMatch(/^New times went out on Oct 1[45]\. They stay under Cancelled until they pick one\.$/);
      expect(body(view({ reason, times: "not_reached" }))).toBe("The email with new times did not reach them. Offer the times by phone, or pick one for them from the interview page.");
      expect(body(view({ reason, times: "expired" }))).toBe("The new times passed without a pick. Send new times again, or decide.");
    }
  });

  it("asks before sending or stopping, in the candidate's name", () => {
    expect(sendNewTimesQuestion("Ana", "Working interview")).toBe("Send new times to Ana? They get an email with times for the working interview.");
    expect(sendNewTimesQuestion("Ana", "First Interview")).toBe("Send new times to Ana? They get an email with times for the first interview.");
    expect(stopNewTimesQuestion("Ana")).toBe("Stop the automatic new times for Ana? Nothing goes to them automatically; they stay under Cancelled.");
    expect(interviewNewTimesText("Ana", "asked_new_times")).toBe("Ana cancelled and asked for new times. New times go out for the same round.");
    expect(interviewNewTimesText("Ben", "not_interested")).toBe("Ben cancelled and is no longer interested. New times go out for the same round.");
    expect(interviewNewTimesText("Cleo", "no_show")).toBe("Cleo did not come. New times go out for the same round.");
    // before ITS confirms the company the send is refused, so the Interviews page never offers it
    expect(interviewNewTimesText("Ana", "asked_new_times", false)).toBe("Ana cancelled and asked for new times. You can send new times once ITS confirms your company, or decide.");
    expect(interviewNewTimesText("Cleo", "no_show", true)).toBe("Cleo did not come. New times go out for the same round.");
  });

  it("says an interview's title mid-sentence in lower case, keeping names, places and acronyms", () => {
    expect(titleMidSentence("Final Interview")).toBe("final interview");
    expect(titleMidSentence("Working interview")).toBe("working interview");
    expect(titleMidSentence("HR Screening Call")).toBe("HR screening call");
    expect(titleMidSentence("Final Interview with the CEO")).toBe("final interview with the CEO");
    expect(titleMidSentence("Call with Paul")).toBe("call with Paul");
    expect(titleMidSentence("Coffee with Nadine in London")).toBe("coffee with Nadine in London");
    expect(titleMidSentence("Second Round With Dr. Patel")).toBe("second round with Dr. Patel");
    // a first word that owns the rest is a name
    expect(titleMidSentence("Paul's Interview")).toBe("Paul's interview");
    expect(titleMidSentence("Nadine’s Coffee Chat")).toBe("Nadine’s coffee chat");
    expect(sendNewTimesQuestion("Ana", "Call with Paul")).toBe("Send new times to Ana? They get an email with times for the call with Paul.");
    expect(cancelledBody({ firstName: "Ana", round: "Coffee with Nadine", c: view({ reason: "no_show", auto: { reason: "no_show" } }), decideBelow: true })).toMatch(/^The coffee with Nadine was booked/);
  });

  it("reads the promised day as the company's calendar day, wherever the reader is", () => {
    expect(promisedDay({ dueDay: "2026-10-15", dueAt: "2026-10-15T16:00:00.000Z" })).toBe("Thursday, October 15");
    expect(promisedDay({ dueDay: null, dueAt: null })).toBe("the day they were told");
  });

  it("gives the History tab the same reasons the API gives the team", () => {
    for (const reason of ["switched_off", "already_used", "reschedules_used", "takeover", "was_on_hold", "stopped_by_team", "team_acted", "candidate_replied", "company_not_checked", "no_interviewers", "no_email", "interview_changed"]) {
      expect(notSentReasonText(reason), reason).toBe(autoReasonText(reason, { state: "not_sent", resolved: true }));
    }
    for (const reason of ["left_process", "details_deleted", "not_asked", "no_show", undefined]) expect(notSentReasonText(reason)).toBeNull();
  });
});

describe("Setup: When a candidate cancels", () => {
  it("defaults to on after 3 working days, and keeps the days within 1 to 10", () => {
    expect(newTimesSettingFrom({})).toEqual({ auto: true, workingDays: 3 });
    expect(newTimesSettingFrom(null)).toEqual({ auto: true, workingDays: 3 });
    expect(newTimesSettingFrom({ newTimesAfterCancel: { auto: false, workingDays: 5 } })).toEqual({ auto: false, workingDays: 5 });
    expect(newTimesSettingFrom({ newTimesAfterCancel: { auto: true, workingDays: 40 } })).toEqual({ auto: true, workingDays: 10 });
    expect(newTimesSettingFrom({ newTimesAfterCancel: { auto: true, workingDays: 0 } })).toEqual({ auto: true, workingDays: 1 });
    expect(workingDaysFrom("5")).toBe(5);
    for (const typed of ["0", "11", "2.5", "", "three"]) expect(workingDaysFrom(typed), typed).toBeNull();
  });

  it("says what the setting does, on and off, and in one line for someone who may not change it", () => {
    expect(NEW_TIMES_SETUP.title).toBe("When a candidate cancels");
    expect(NEW_TIMES_SETUP.checkbox).toBe("Send new times automatically to people who ask for them");
    // the hour is worked out in the company's time zone, so the hint says so
    expect(NEW_TIMES_SETUP.daysHint).toBe("1 to 10. Weekends and holidays are not counted. The email goes out in the morning, your company's time.");
    expect(newTimesSettingText({ auto: true, workingDays: 3 })).toBe("Each person gets one set of new times by email, 3 working days after they cancel, for the same interview. If they do not pick a time, they stay under Cancelled for you to decide. People who said they are no longer interested, and people who did not come, never get times automatically.");
    expect(newTimesSettingText({ auto: true, workingDays: 1 })).toContain("1 working day after they cancel");
    expect(newTimesSettingText({ auto: false, workingDays: 3 })).toBe("Nobody gets new times automatically. People who ask for them wait under Cancelled until you send times or decide.");
    expect(newTimesReadOnlyText({ auto: true, workingDays: 5 })).toBe("Automatic new times: on, after 5 working days.");
    expect(newTimesReadOnlyText({ auto: false, workingDays: 5 })).toBe("Automatic new times: off.");
    expect(NEW_TIMES_SETUP.readOnly).toBe("Only owners and admins change this.");
  });

  it("says before the ITS check that nothing goes automatically yet", () => {
    expect(NEW_TIMES_SETUP.beforeCheck).toBe("Automatic new times start once ITS confirms your company. Until then, emails to candidates wait.");
  });

  it("asks what happens to people already told a day before switching off, with nothing chosen for the owner", () => {
    expect(pendingQuestion(1)).toBe("1 person was already told a day for their new times. What should happen to them?");
    expect(pendingQuestion(3)).toBe("3 people were already told a day for their new times. What should happen to them?");
    expect([NEW_TIMES_SETUP.keep, NEW_TIMES_SETUP.stop]).toEqual(["Still send them on the day they were told", "Stop them too; the team will be in touch"]);
  });

  it("says after saving what happens to the people already told a day", () => {
    expect(newTimesSavedNotice({ kind: "days", pending: 2 })).toBe("2 people were already told a day. They still get their times on that day; the new number applies to cancellations from now on.");
    expect(newTimesSavedNotice({ kind: "days", pending: 0 })).toBeNull();
    expect(newTimesSavedNotice({ kind: "off", choice: "keep", count: 1 })).toBe("1 person was already told a day and still gets their times then. To stop it for someone, open them under Cancelled and choose Don't send automatically.");
    expect(newTimesSavedNotice({ kind: "off", choice: "keep", count: 3 })).toMatch(/^3 people were already told a day and still get their times then\./);
    expect(newTimesSavedNotice({ kind: "off", choice: "stop", count: 2 })).toBe("Stopped the automatic times for 2 people. They were told a day, so someone should be in touch: they are under Cancelled.");
    expect(newTimesSavedNotice({ kind: "off", choice: "stop", count: 0 })).toBeNull();
    expect(newTimesSavedNotice({ kind: "other" })).toBeNull();
  });
});

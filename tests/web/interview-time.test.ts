import { describe, expect, it } from "vitest";
import { SetInterviewTime } from "../../packages/contracts/src/domain/interview";
import { defaultInterviewers } from "../../apps/web/src/interview-defaults";
import { DECISION_WORDS, bookLabel, candidateEmailLine, defaultDuration, durationChoices, durationWords, formFromBooked, freshForm, interviewLine, interviewNeedingTime, interviewWord, placeKindFor, setTimeBody, setTimeMissing, timeLabel, todayIn, whenLine, type SetTimeForm } from "../../apps/web/src/interview-time";
import { interviewSetToast, pickTimesToast } from "../../apps/web/src/talent-actions";

/**
 * "Set a date and time" (the owner's words, 6 November 2026: "nadine sets date and time from the shortlisted candidates
 * and he/she will get the mail"), the pure parts: the form's choices, what it sends, the line that says the time back on
 * the company's clock, the button and the toast that never claim an email left, and the one word every screen uses for
 * where an interview stands (never "Waiting on the candidate" when nothing reached them).
 */
const NOW = new Date("2026-11-09T18:00:00.000Z"); // 10:00 in Los Angeles, 12:00 in Chicago
const form = (over: Partial<SetTimeForm> = {}): SetTimeForm => ({ ...freshForm({ durationMinutes: 45, format: "video" }), ...over });

describe("the form's choices", () => {
  it("offers the usual lengths with the round's own among them, and opens on the round's own", () => {
    expect(durationChoices(45)).toEqual([15, 30, 45, 60, 90, 120]);
    expect(durationChoices(20)).toEqual([15, 20, 30, 45, 60, 90, 120]);
    // a length the API would refuse is never offered
    expect(durationChoices(300)).toEqual([15, 30, 45, 60, 90, 120]);
    expect(durationChoices(null)).toEqual([15, 30, 45, 60, 90, 120]);
    expect(defaultDuration(20)).toBe(20);
    expect(defaultDuration(undefined)).toBe(30);
    expect(defaultDuration(300)).toBe(30);
    expect([15, 45, 60, 90, 120].map(durationWords)).toEqual(["15 minutes", "45 minutes", "1 hour", "90 minutes", "2 hours"]);
  });

  it("starts on the place the round's format suggests, with nothing chosen for the day and time", () => {
    expect(placeKindFor("video")).toBe("link");
    expect(placeKindFor("phone")).toBe("phone");
    expect(placeKindFor("onsite")).toBe("address");
    expect(placeKindFor("working_session")).toBe("address");
    expect(freshForm({ durationMinutes: 30, format: "phone" })).toMatchObject({ date: "", time: "", durationMinutes: 30, place: "phone" });
  });

  it("names the company's zone beside the time, never the browser's", () => {
    expect(timeLabel("America/Chicago")).toBe("Time (America/Chicago)");
    expect(timeLabel(null)).toBe("Time (your company's time zone)");
    expect(todayIn("America/Los_Angeles", NOW)).toBe("2026-11-09");
    // late evening in Los Angeles is already tomorrow in UTC: the company's day is what counts
    expect(todayIn("America/Los_Angeles", new Date("2026-11-10T05:30:00.000Z"))).toBe("2026-11-09");
  });

  it("says the time back as typed, on the company's clock and by its zone's name", () => {
    expect(whenLine("2026-11-10", "14:00", "America/Chicago", NOW)).toBe("Tuesday, November 10 at 2:00 PM, America/Chicago");
    expect(whenLine("2026-11-10", "09:05", "America/Chicago", NOW)).toBe("Tuesday, November 10 at 9:05 AM, America/Chicago");
    // the year only when it is not this one
    expect(whenLine("2027-01-05", "10:00", "America/Chicago", NOW)).toBe("Tuesday, January 5, 2027 at 10:00 AM, America/Chicago");
    // nothing until both are real
    expect(whenLine("", "14:00", "America/Chicago", NOW)).toBeNull();
    expect(whenLine("2026-11-10", "", "America/Chicago", NOW)).toBeNull();
    expect(whenLine("2026-02-30", "10:00", "America/Chicago", NOW)).toBeNull();
  });
});

describe("what the form sends, and why it cannot yet", () => {
  it("never greys Book without saying why, and names the field a press takes the keyboard to", () => {
    const at = { timeZone: "America/Los_Angeles", now: NOW };
    expect(setTimeMissing(form(), at)).toEqual({ field: "date", text: "Choose a date and a time." });
    expect(setTimeMissing(form({ date: "2026-11-10" }), at)).toEqual({ field: "time", text: "Choose a time." });
    expect(setTimeMissing(form({ time: "10:00" }), at)).toEqual({ field: "date", text: "Choose a date." });
    expect(setTimeMissing(form({ date: "2026-11-08", time: "10:00" }), at)).toEqual({ field: "date", text: "That day has passed. Choose a later one." });
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00", place: "address", address: " a " }), at)).toEqual({ field: "address", text: "Type the address." });
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00", url: "meet.example.com/abc" }), at)).toEqual({ field: "url", text: "The link must start with https://" });
    // who interviews comes first, when the form asks
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00" }), { ...at, interviewers: 0 })).toEqual({ field: "interviewers", text: "Tick who will interview." });
    // while the team is still loading nobody can be ticked yet: Book waits with its reason, said after what the person must
    // do, and never "Tick who will interview." (a press in that moment said so: found by the whole-flow walks, 10 Nov 2026)
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00", place: "phone" }), { ...at, teamLoading: true })).toEqual({ field: "interviewers", text: "Loading who interviews…" });
    expect(setTimeMissing(form(), { ...at, teamLoading: true })).toEqual({ field: "date", text: "Choose a date and a time." });
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00", place: "phone" }), { ...at, teamLoading: false, interviewers: 1 })).toBeNull();
    // a pasted link the person chose over a live calendar's must be there
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00", linkPicked: "pasted" }), { ...at, calendarLive: true })).toEqual({ field: "url", text: "Paste the meeting link." });
    // today is allowed (a time this afternoon), and nothing else is needed: no calendar, no declared hours
    expect(setTimeMissing(form({ date: "2026-11-09", time: "15:00" }), at)).toBeNull();
    expect(setTimeMissing(form({ date: "2026-11-10", time: "10:00", place: "phone" }), { ...at, interviewers: 1 })).toBeNull();
  });

  it("sends exactly what the API takes for each place", () => {
    const base = { date: "2026-11-10", time: "14:00" };
    const sent = (f: SetTimeForm, opts?: { allowClash?: boolean; calendarLive?: boolean }) => SetInterviewTime.parse(setTimeBody(f, opts));
    expect(sent(form({ ...base, url: " https://meet.example.com/abc " }))).toEqual({ date: "2026-11-10", time: "14:00", durationMinutes: 45, place: { kind: "link", url: "https://meet.example.com/abc" } });
    // no link typed: a live calendar makes one, or the invitation names the format
    expect(sent(form(base)).place).toEqual({ kind: "link" });
    // a live calendar chosen to make it: the typed words are not sent
    expect(sent(form({ ...base, url: "https://typed.example.com", linkPicked: "calendar" }), { calendarLive: true }).place).toEqual({ kind: "link" });
    expect(sent(form({ ...base, place: "address", address: "  120 Main Street, Tustin " })).place).toEqual({ kind: "address", text: "120 Main Street, Tustin" });
    expect(sent(form({ ...base, place: "phone", url: "https://ignored.example.com" })).place).toEqual({ kind: "phone" });
    // "Book anyway" after a clash, and a reason when a booked time moves
    expect(sent(form(base), { allowClash: true }).allowClash).toBe(true);
    expect(sent(form({ ...base, reason: "  A clash at our end. " })).reason).toBe("A clash at our end.");
    expect(sent(form({ ...base, reason: "   " }))).not.toHaveProperty("reason");
  });

  it("opens a booked time to move it filled in with that time on the company's clock, its length and its place", () => {
    const booked = { startsAt: "2026-11-12T22:30:00.000Z", durationMinutes: 60, format: "onsite", meetingUrl: null, linkSource: "pasted", selectedSlot: { address: "120 Main Street, Tustin" } };
    expect(formFromBooked(booked, "America/Chicago")).toMatchObject({ date: "2026-11-12", time: "16:30", durationMinutes: 60, place: "address", address: "120 Main Street, Tustin" });
    // late in the day in Los Angeles is the next day in UTC: the company's day is kept
    expect(formFromBooked({ ...booked, startsAt: "2026-11-13T05:00:00.000Z" }, "America/Los_Angeles")).toMatchObject({ date: "2026-11-12", time: "21:00" });
    expect(formFromBooked({ ...booked, selectedSlot: null, format: "video", meetingUrl: "https://meet.example/x" }, "America/Chicago")).toMatchObject({ place: "link", url: "https://meet.example/x" });
    expect(formFromBooked({ ...booked, selectedSlot: null, format: "phone" }, "America/Chicago")).toMatchObject({ place: "phone" });
  });

  it("ticks the person setting it up when the plan names nobody still on the team, never once they changed the ticks", () => {
    const active = new Set(["dana", "wes"]);
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan: [{ key: "r1", interviewerUserIds: [] }], activeMemberIds: active, fallbackUserId: "dana" })).toEqual(["dana"]);
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan: [{ key: "r1", interviewerUserIds: ["gone"] }], activeMemberIds: active, fallbackUserId: "dana" })).toEqual(["dana"]);
    // the plan's people win; someone who unticked everyone by hand is not overruled
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan: [{ key: "r1", interviewerUserIds: ["wes"] }], activeMemberIds: active, fallbackUserId: "dana" })).toEqual(["wes"]);
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan: [{ key: "r1", interviewerUserIds: [] }], picked: [], activeMemberIds: active, fallbackUserId: "dana" })).toEqual([]);
    // someone not on the team (an ITS recruiter under a grant) is never ticked for them
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan: [{ key: "r1", interviewerUserIds: [] }], activeMemberIds: active, fallbackUserId: "its-recruiter" })).toEqual([]);
    expect(defaultInterviewers({ roundKey: "r1", applicationPlan: [], activeMemberIds: null, fallbackUserId: "dana" })).toEqual([]);
  });
});

describe("what the screen says about the email: never that it left", () => {
  it("says Book and email, or only Book when no email can go now", () => {
    expect(bookLabel("Maria", { check: "confirmed", hasEmail: true })).toBe("Book and email Maria");
    expect(bookLabel("Maria", { check: "unknown", hasEmail: true })).toBe("Book and email Maria");
    expect(bookLabel("Maria", { check: "waiting", hasEmail: true })).toBe("Book");
    expect(bookLabel("Maria", { check: "confirmed", hasEmail: false })).toBe("Book");
    expect(bookLabel("Maria", { check: "confirmed", hasEmail: true, moving: true })).toBe("Move and email Maria");
    expect(bookLabel("Maria", { check: "waiting", hasEmail: true, moving: true })).toBe("Move");
  });

  it("toasts the booking and the email on its way, held, or impossible, in the API's own word", () => {
    expect(interviewSetToast({ candidateNotice: "queued" }, "Maria")).toEqual({ title: "Booked.", detail: "The email to Maria is on its way." });
    expect(interviewSetToast({ candidateNotice: "held" }, "Maria")).toEqual({ title: "Booked.", detail: "Maria has not been told: the email waits for ITS to confirm your company." });
    expect(interviewSetToast({ candidateNotice: "not_sent_no_email" }, "Maria")).toEqual({ title: "Booked.", detail: "There is no email address on file: tell them yourself." });
    expect(interviewSetToast({ candidateNotice: "queued" }, "Maria", { moving: true }).title).toBe("Moved.");
    for (const n of ["queued", "held", "not_sent_no_email"] as const) expect(JSON.stringify(interviewSetToast({ candidateNotice: n }, "Maria"))).not.toMatch(/\bsent\b|\bleft\b|delivered/i);
    // the same day, time, length and place again: nothing moved and nothing goes, and the toast says so (the release review,
    // 11 November 2026: it said "Moved. The email to Maria is on its way.")
    expect(interviewSetToast({ unchanged: true, startsAt: "2026-11-17T22:30:00.000Z", timezone: "America/Los_Angeles" }, "Maria", { moving: true })).toEqual({ title: "Nothing changed.", detail: "It is still booked for Tue, Nov 17, 2:30 PM. No email was sent." });
    expect(interviewSetToast({ unchanged: true }, "Maria", { moving: true })).toEqual({ title: "Nothing changed.", detail: "It is still booked as it was. No email was sent." });
    expect(pickTimesToast("Maria", "confirmed")).toEqual({ title: "Times are being worked out.", detail: "Maria gets them by email to pick one." });
    expect(pickTimesToast("Maria", "waiting").detail).toBe("They go to Maria by email once ITS confirms your company.");
  });

  it("says once what became of the email about a time", () => {
    expect(candidateEmailLine("held", "Maria")).toBe("Maria has not been told: the email waits for ITS to confirm your company.");
    expect(candidateEmailLine(null, "Maria", "waiting")).toBe("Maria has not been told: the email waits for ITS to confirm your company.");
    expect(candidateEmailLine("failed", "Maria")).toBe("The email to Maria could not be delivered. Tell them yourself.");
    expect(candidateEmailLine("no_email", "Maria")).toBe("There is no email address on file: tell them yourself.");
    expect(candidateEmailLine(null, "Maria", "confirmed")).toBeNull();
  });
});

describe("where an interview stands, in one word worked out from facts", () => {
  const slots = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];

  it("never says Waiting on the candidate when nothing reached them", () => {
    // set up with nobody's hours, or reopened with nothing to offer: no time, and it waits on a person
    expect(interviewWord({ status: "proposed", offeredSlots: [] })).toEqual({ label: "No time yet", tone: "caution", note: null, needsTime: true });
    expect(interviewWord({ status: "scheduling", offeredSlots: [] })).toMatchObject({ label: "No time yet", needsTime: true });
    // times exist but their email failed, or there is no address
    expect(interviewWord({ status: "scheduling", offeredSlots: slots, candidateEmail: "failed" })).toEqual({ label: "Email failed", tone: "caution", note: "The times did not reach them", needsTime: true });
    expect(interviewWord({ status: "scheduling", offeredSlots: slots, candidateEmail: "no_email" })).toMatchObject({ label: "No email address", needsTime: true });
    // held for the ITS check, from the email itself or from the company's check
    expect(interviewWord({ status: "scheduling", offeredSlots: slots, candidateEmail: "held" })).toMatchObject({ label: "Waiting for the ITS check", note: "3 times ready", needsTime: false });
    expect(interviewWord({ status: "scheduling", offeredSlots: slots }, "waiting").label).toBe("Waiting for the ITS check");
    // only times that reached them wait on the candidate
    expect(interviewWord({ status: "scheduling", offeredSlots: slots }, "confirmed")).toEqual({ label: "Waiting on the candidate", tone: "accent", note: "3 times offered", needsTime: false });
    expect(interviewWord({ status: "scheduling", offeredSlots: [{ id: "s1" }] }).note).toBe("1 time offered");
  });

  it("says a booked time is scheduled, with what became of its email beside it", () => {
    expect(interviewWord({ status: "scheduled", offeredSlots: [] })).toEqual({ label: "Scheduled", tone: "good", note: null, needsTime: false });
    expect(interviewWord({ status: "scheduled", candidateEmail: "held" }).note).toBe("Email waits for the ITS check");
    expect(interviewWord({ status: "scheduled", candidateEmail: "failed" }).note).toBe("Email not delivered");
    expect(interviewWord({ status: "scheduled", candidateEmail: "no_email" }).note).toBe("No email address on file");
  });

  it("never blames the candidate for times that never reached them, and says what happened in words, not raw statuses", () => {
    expect(interviewWord({ status: "offer_expired" })).toMatchObject({ label: "Times expired", needsTime: true });
    expect(interviewWord({ status: "offer_expired", candidateEmail: "failed" })).toMatchObject({ label: "Times never reached them", needsTime: true });
    expect(interviewWord({ status: "completed", outcome: "happened" }).label).toBe("Took place");
    expect(interviewWord({ status: "no_show", outcome: "no_show_candidate" }).label).toBe("Candidate did not come");
    expect(interviewWord({ status: "no_show", outcome: "no_show_interviewer" }).label).toBe("Interviewer did not come");
    expect(interviewWord({ status: "cancelled" })).toMatchObject({ label: "Cancelled", tone: "neutral", needsTime: false });
    for (const status of ["proposed", "scheduling", "scheduled", "completed", "cancelled", "no_show", "offer_expired"]) expect(interviewWord({ status }).label).not.toMatch(/_|^proposed$|^scheduling$/);
  });

  it("finds the open interview a person still has to set a time for", () => {
    const iv = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, status, offeredSlots: [] as unknown[], ...over });
    expect(interviewNeedingTime([iv("a", "proposed")])?.id).toBe("a");
    expect(interviewNeedingTime([iv("a", "scheduling", { offeredSlots: slots, candidateEmail: "failed" })])?.id).toBe("a");
    expect(interviewNeedingTime([iv("a", "scheduling", { offeredSlots: slots })])).toBeNull();
    expect(interviewNeedingTime([iv("a", "scheduled"), iv("b", "cancelled")])).toBeNull();
    // a lapsed offer is not open: the panel's own card offers a new interview for it
    expect(interviewNeedingTime([iv("a", "offer_expired")])).toBeNull();
  });

  it("gives the panel the same words as the Interviews page", () => {
    expect(interviewLine({ status: "proposed", offeredSlots: [], startsAt: null })).toBe("No time yet");
    expect(interviewLine({ status: "scheduled", offeredSlots: [], startsAt: "2026-11-10T20:00:00.000Z", timezone: "America/Chicago", candidateEmail: "failed" })).toBe("Scheduled · Tue, Nov 10, 2:00 PM · Email not delivered");
    expect(interviewLine({ status: "scheduling", offeredSlots: slots, startsAt: null }, "confirmed")).toBe("Waiting on the candidate · 3 times offered");
    expect(interviewLine({ status: "completed", outcome: "happened", offeredSlots: [], startsAt: "2026-11-10T20:00:00.000Z", timezone: "America/Chicago", decision: "next_round" })).toBe("Took place · Tue, Nov 10, 2:00 PM · Decision: Next round");
    // a new interview followed the missed one: times sent to pick from, or a date and time a person set (the release review,
    // 11 November 2026: "New times sent" was false for the second)
    expect(DECISION_WORDS.new_times).toBe("New interview set up");
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_CALENDAR } from "./business-hours";
import { buildIcs, escapeIcsText, quoteIcsParam } from "./ics";
import { computeSlots, defaultSchedulingWindow, freeRangesForDay, freshSchedulingWindow, groupSlotsByDay, holidaysBetween, missingAvailability, slotStillFree, subtractRanges, type ParticipantConstraints } from "./scheduling";

const declared = (userId: string, over: Partial<ParticipantConstraints> = {}): ParticipantConstraints => ({ userId, source: "declared", timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3, busy: [], ...over });
const now = new Date("2026-09-18T20:00:00Z"); // Friday 13:00 Pacific

describe("slot computation (docs/06 propose_slots)", () => {
  it("offers spread-out weekday times inside everyone's hours, never sooner than a day out", () => {
    const { slots } = computeSlots({ participants: [declared("a"), declared("b")], durationMinutes: 45, fromDate: "2026-09-21", toDate: "2026-09-25", companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now });
    expect(slots.length).toBeGreaterThanOrEqual(6);
    expect(slots.length).toBeLessThanOrEqual(8);
    for (const s of slots) {
      expect(Date.parse(s.startsAt)).toBeGreaterThanOrEqual(now.getTime() + 24 * 3600_000);
      expect(Date.parse(s.endsAt) - Date.parse(s.startsAt)).toBe(45 * 60_000);
      const local = new Date(s.startsAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" });
      expect(local).not.toMatch(/Sat|Sun/);
      expect(s.interviewerUserIds).toEqual(["a", "b"]);
      expect(s.source).toBe("declared");
    }
    // first slot of Monday is 9:00 Pacific = 16:00Z; the second is at least three hours later
    expect(slots[0].startsAt).toBe("2026-09-21T16:00:00.000Z");
    expect(Date.parse(slots[1].startsAt) - Date.parse(slots[0].startsAt)).toBeGreaterThanOrEqual(3 * 3600_000);
  });

  it("intersects hours across time zones and daylight-saving changes", () => {
    // Pacific 9-17 and Eastern 9-17 overlap 9-14 Pacific; the week of the fall-back change keeps wall-clock hours
    const { slots } = computeSlots({ participants: [declared("west"), declared("east", { timezone: "America/New_York" })], durationMinutes: 60, fromDate: "2026-11-02", toDate: "2026-11-03", companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now: new Date("2026-10-30T20:00:00Z") });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const pacificHour = Number(new Date(s.startsAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", hour12: false }));
      const easternHour = Number(new Date(s.startsAt).toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }));
      expect(pacificHour).toBeGreaterThanOrEqual(9);
      expect(pacificHour + 1).toBeLessThanOrEqual(14);
      expect(easternHour).toBeGreaterThanOrEqual(9);
    }
    expect(slots[0].startsAt).toBe("2026-11-02T17:00:00.000Z"); // Monday 9:00 PST after the change
  });

  it("subtracts busy time with the buffer and respects the daily maximum", () => {
    const busy = [{ start: "2026-09-21T16:00:00.000Z", end: "2026-09-21T20:00:00.000Z" }]; // Monday 9-13 Pacific
    const free = freeRangesForDay(declared("a", { busy, bufferMinutes: 30 }), "2026-09-21");
    expect(free).toEqual([{ start: "2026-09-21T20:30:00.000Z", end: "2026-09-22T00:00:00.000Z" }]);
    const full = freeRangesForDay(declared("a", { bookedPerDay: { "2026-09-21": 3 } }), "2026-09-21");
    expect(full).toEqual([]);
    expect(subtractRanges([{ start: "a", end: "z" }], [{ start: "m", end: "n" }])).toEqual([{ start: "a", end: "m" }, { start: "n", end: "z" }]);
  });

  it("returns nothing when there is no common free time; an unknown person is never assumed free, unless optional, and is reported", () => {
    const morning = declared("a", { windows: [{ day: 1, start: "09:00", end: "11:00" }] });
    const afternoon = declared("b", { windows: [{ day: 1, start: "13:00", end: "17:00" }] });
    const input = { durationMinutes: 30, fromDate: "2026-09-21", toDate: "2026-09-21", companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now };
    expect(computeSlots({ participants: [morning, afternoon], ...input }).slots).toEqual([]);
    // a required interviewer with no availability: no free time, so no slots (the owner is asked instead of a 9 to 5 guess)
    const unknown = declared("c", { source: "none", windows: [] });
    const required = computeSlots({ participants: [morning, unknown], ...input });
    expect(required.slots).toEqual([]);
    expect(required.unconstrained).toEqual(["c"]);
    expect(freeRangesForDay(unknown, "2026-09-21")).toEqual([]);
    expect(missingAvailability([morning, unknown, declared("d", { source: "none", windows: [], optional: true })]).map((p) => p.userId)).toEqual(["c"]);
    // an optional one is left out of the merge: the others' times go out, and still name everyone on the interview
    const optional = computeSlots({ participants: [morning, { ...unknown, optional: true }], ...input });
    expect(optional.slots.length).toBeGreaterThan(0);
    expect(optional.slots[0].interviewerUserIds).toEqual(["a", "c"]);
    for (const s of optional.slots) expect(s.startsAt < "2026-09-21T18:00:00.000Z").toBe(true); // inside a's 9 to 11 Pacific
    expect(optional.unconstrained).toEqual(["c"]);
    expect(slotStillFree(optional.slots[0], [morning, { ...unknown, optional: true, busy: [{ start: optional.slots[0].startsAt, end: optional.slots[0].endsAt }] }])).toBe(true);
    expect(computeSlots({ participants: [{ ...unknown, optional: true }], ...input }).slots).toEqual([]);
  });

  it("a fresh window starts tomorrow and is as long as the old one, never the old dates", () => {
    const later = new Date("2026-10-20T20:00:00Z"); // Tuesday 13:00 Pacific, long after the old window
    const old = { fromDate: "2026-09-21", toDate: "2026-10-02", businessDaysOnly: true, candidateTimezone: "America/New_York" }; // ten business days
    const w = freshSchedulingWindow(old, later, "America/Los_Angeles");
    expect(w).toEqual({ fromDate: "2026-10-21", toDate: "2026-11-03", businessDaysOnly: true, candidateTimezone: "America/New_York" });
    // weekends counted when the old window counted them: the same number of days
    expect(freshSchedulingWindow({ fromDate: "2026-09-21", toDate: "2026-09-27", businessDaysOnly: false }, later, "America/Los_Angeles")).toEqual({ fromDate: "2026-10-21", toDate: "2026-10-27", businessDaysOnly: false });
    // no old dates: the default window
    expect(freshSchedulingWindow({}, later, "America/Los_Angeles")).toEqual({ ...defaultSchedulingWindow(later, "America/Los_Angeles") });
    expect(freshSchedulingWindow(null, later, "America/Los_Angeles").fromDate).toBe("2026-10-21");
    // slots come only from the fresh dates
    const { slots } = computeSlots({ participants: [declared("a")], durationMinutes: 45, fromDate: w.fromDate, toDate: w.toDate, companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now: later });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(s.startsAt >= "2026-10-21").toBe(true);
  });

  it("re-checks a chosen slot against fresh busy time", () => {
    const slot = { startsAt: "2026-09-21T17:00:00.000Z", endsAt: "2026-09-21T17:45:00.000Z" };
    expect(slotStillFree(slot, [declared("a")])).toBe(true);
    expect(slotStillFree(slot, [declared("a", { busy: [{ start: "2026-09-21T17:30:00.000Z", end: "2026-09-21T18:00:00.000Z" }] })])).toBe(false);
    expect(slotStillFree(slot, [declared("a", { busy: [{ start: "2026-09-21T17:50:00.000Z", end: "2026-09-21T18:00:00.000Z" }] })])).toBe(false); // inside the 15-minute buffer
    expect(slotStillFree(slot, [declared("a", { busy: [{ start: "2026-09-21T18:00:00.000Z", end: "2026-09-21T18:30:00.000Z" }] })])).toBe(true);
  });

  it("groups slots by the candidate's local day and defaults the window to the next ten business days", () => {
    const g = groupSlotsByDay([{ id: "s1", startsAt: "2026-09-22T02:00:00.000Z", endsAt: "2026-09-22T02:30:00.000Z", interviewerUserIds: ["a"], source: "declared" }], "America/New_York");
    expect(g[0].dayKey).toBe("2026-09-21"); // 10 pm Eastern on Monday
    expect(g[0].slots[0].label).toMatch(/10:00 PM/);
    const w = defaultSchedulingWindow(new Date("2026-09-18T20:00:00Z"), "America/Los_Angeles");
    expect(w.fromDate).toBe("2026-09-19");
    expect(w.toDate).toBe("2026-10-02"); // ten business days from the Saturday start
  });
});

describe("iCalendar files", () => {
  it("builds a valid REQUEST with folded lines, escaped text and UTC times", () => {
    const ics = buildIcs({ uid: "interview-1@identifiedtalent.com", sequence: 0, method: "REQUEST", start: "2026-09-21T17:00:00.000Z", end: "2026-09-21T17:45:00.000Z", summary: "Working session: Hygienist; at Smile, Bright", description: "Line one\nLine two, with a comma and a very long sentence that will certainly exceed the seventy-five octet limit of a content line", organizer: { name: "Smile Bright hiring team", email: "updates@hire.identifiedtalent.com" }, attendees: [{ name: "Maria Reyes", email: "maria@example.com" }], url: "https://meet.google.com/abc", stamp: new Date("2026-09-18T20:00:00Z") });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(true);
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("DTSTART:20260921T170000Z");
    expect(ics).toContain("DTEND:20260921T174500Z");
    expect(ics).toContain("SUMMARY:Working session: Hygienist\\; at Smile\\, Bright");
    expect(ics).toContain("Line one\\nLine two\\, with a comma");
    expect(ics.replace(/\r\n /g, "")).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE;CN="Maria Reyes":mailto:maria@example.com');
    expect(ics.replace(/\r\n /g, "")).toContain('ORGANIZER;CN="Smile Bright hiring team":mailto:updates@hire.identifiedtalent.com');
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(76);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(buildIcs({ uid: "x", sequence: 1, method: "CANCEL", start: "2026-09-21T17:00:00.000Z", end: "2026-09-21T17:45:00.000Z", summary: "x" })).toContain("STATUS:CANCELLED");
  });

  it("names with commas, colons, semicolons or quotes stay inside a quoted CN; text escapes every special character (audit 06, bug 94)", () => {
    expect(escapeIcsText("a\\b;c,d\r\ne\nf")).toBe("a\\\\b\\;c\\,d\\ne\\nf");
    expect(quoteIcsParam("Reyes, Maria: RDH; \"Mia\"")).toBe("\"Reyes, Maria: RDH; 'Mia'\"");
    expect(quoteIcsParam("Line\nbreak\u0007")).toBe('"Line break"');
    const ics = buildIcs({ uid: "u", sequence: 0, method: "REQUEST", start: "2026-09-21T17:00:00.000Z", end: "2026-09-21T17:45:00.000Z", summary: "s", organizer: { name: "Smile, Bright: Dental; Team", email: "a@b.test" }, attendees: [{ name: "O'Neil, Sam", email: "sam@example.com" }], stamp: new Date("2026-09-18T20:00:00Z") });
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain('ORGANIZER;CN="Smile, Bright: Dental; Team":mailto:a@b.test');
    expect(unfolded).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE;CN=\"O'Neil, Sam\":mailto:sam@example.com");
  });
});

describe("public holidays (audit 06, bug 104)", () => {
  it("no time is offered on a public holiday: the business calendar's list, else the built-in US federal one", () => {
    // Veterans Day, Wednesday 11 November 2026
    const input = { participants: [declared("a")], durationMinutes: 45, fromDate: "2026-11-10", toDate: "2026-11-12", companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now: new Date("2026-11-06T20:00:00Z"), maxSlotsPerDay: 2 };
    const without = computeSlots(input).slots;
    expect(without.some((s) => s.startsAt.startsWith("2026-11-11"))).toBe(true);
    const holidays = holidaysBetween(null, "2026-11-10", "2026-11-12");
    expect([...holidays]).toEqual(["2026-11-11"]);
    const withHolidays = computeSlots({ ...input, holidays }).slots;
    expect(withHolidays.length).toBeGreaterThan(0);
    expect(withHolidays.some((s) => s.startsAt.startsWith("2026-11-11"))).toBe(false);
    // the business calendar's own list wins when it has one
    const calendar = { ...DEFAULT_BUSINESS_CALENDAR, holidays: [{ date: "2026-11-12", name: "Company day off" }] };
    expect([...holidaysBetween(calendar, "2026-11-10", "2026-11-12")]).toEqual(["2026-11-12"]);
    // a window that counts weekends counts holidays too
    expect(computeSlots({ ...input, businessDaysOnly: false, holidays }).slots.some((s) => s.startsAt.startsWith("2026-11-11"))).toBe(true);
  });
});

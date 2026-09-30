import { describe, expect, it } from "vitest";
import { buildIcs } from "./ics";
import { computeSlots, defaultSchedulingWindow, freeRangesForDay, groupSlotsByDay, slotStillFree, subtractRanges, type ParticipantConstraints } from "./scheduling";

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

  it("returns nothing when there is no common free time, and treats an unknown person as unconstrained but reports them", () => {
    const morning = declared("a", { windows: [{ day: 1, start: "09:00", end: "11:00" }] });
    const afternoon = declared("b", { windows: [{ day: 1, start: "13:00", end: "17:00" }] });
    expect(computeSlots({ participants: [morning, afternoon], durationMinutes: 30, fromDate: "2026-09-21", toDate: "2026-09-21", companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now }).slots).toEqual([]);
    const r = computeSlots({ participants: [morning, declared("c", { source: "none", windows: [] })], durationMinutes: 30, fromDate: "2026-09-21", toDate: "2026-09-21", companyTimezone: "America/Los_Angeles", businessDaysOnly: true, now });
    expect(r.slots.length).toBeGreaterThan(0);
    expect(r.unconstrained).toEqual(["c"]);
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
    expect(ics).toContain("SUMMARY:Working session: Hygienist; at Smile\\, Bright");
    expect(ics).toContain("Line one\\nLine two\\, with a comma");
    expect(ics.replace(/\r\n /g, "")).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE;CN=Maria Reyes:mailto:maria@example.com");
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(76);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(buildIcs({ uid: "x", sequence: 1, method: "CANCEL", start: "2026-09-21T17:00:00.000Z", end: "2026-09-21T17:45:00.000Z", summary: "x" })).toContain("STATUS:CANCELLED");
  });
});

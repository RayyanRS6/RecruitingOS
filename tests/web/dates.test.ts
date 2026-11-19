import { describe, expect, it } from "vitest";
import { appliedWhen, calendarDay, dayAndTime, dayKey, longDay, shortDay, todayIn, zoneWords } from "../../apps/web/src/dates";

/**
 * Dates as the signed-in pages say them: a moment on the reader's own calendar, a calendar day (a closing date) the
 * same for everyone.
 */
describe("a moment", () => {
  const now = new Date(2026, 9, 8, 15, 0);

  it("says when someone applied in calendar days", () => {
    expect(appliedWhen(new Date(2026, 9, 8, 9, 0).toISOString(), now)).toBe("Applied today");
    expect(appliedWhen(new Date(2026, 9, 7, 23, 0).toISOString(), now)).toBe("Applied yesterday");
    expect(appliedWhen(new Date(2026, 9, 4, 12, 0).toISOString(), now)).toBe("Applied 4 days ago");
    expect(appliedWhen(new Date(2026, 8, 12, 12, 0).toISOString(), now)).toBe("Applied Sep 12");
    expect(appliedWhen(new Date(2025, 11, 30, 12, 0).toISOString(), now)).toBe("Applied Dec 30, 2025");
    expect(appliedWhen("not a date", now)).toBe("Applied");
  });

  it("is short with the year only when it is not this year's, and empty when it cannot be read", () => {
    expect(shortDay("2026-11-03T12:00:00Z", now, "UTC")).toBe("Nov 3");
    expect(shortDay("2025-11-03T12:00:00Z", now, "UTC")).toBe("Nov 3, 2025");
    expect(shortDay(null, now)).toBe("");
    expect(shortDay("not a date", now)).toBe("");
    expect(longDay("2026-11-03T12:00:00Z", "UTC")).toBe("November 3, 2026");
    expect(longDay(undefined)).toBe("");
    expect(dayAndTime("2026-11-03T17:14:00Z", "UTC")).toBe("Nov 3, 5:14 PM");
  });

  it("is written for a date field as YYYY-MM-DD on the reader's own calendar", () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 10, 18, 23, 59))).toBe("2026-11-18");
  });
});

describe("a calendar day", () => {
  it("reads the same for everyone, whatever their time zone", () => {
    expect(calendarDay("2026-11-30")).toBe("November 30, 2026");
    expect(calendarDay("2026-01-01")).toBe("January 1, 2026");
    expect(calendarDay("soon")).toBe("soon");
    expect(calendarDay(null)).toBe("");
  });

  it("knows today in the company's time zone, the earliest a closing date may be", () => {
    const lateEvening = new Date("2026-11-19T05:30:00.000Z");
    expect(todayIn("America/Los_Angeles", lateEvening)).toBe("2026-11-18");
    expect(todayIn("America/New_York", lateEvening)).toBe("2026-11-19");
    expect(todayIn("Not/AZone", lateEvening)).toBe("2026-11-19");
  });

  it("names a time zone in words, or as it is stored when the browser cannot", () => {
    expect(zoneWords("America/Los_Angeles")).toMatch(/Pacific/);
    expect(zoneWords("Not/AZone")).toBe("Not/AZone");
  });
});

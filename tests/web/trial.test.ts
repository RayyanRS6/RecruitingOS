import { describe, expect, it } from "vitest";
import { trialDate, trialPlanLine } from "../../apps/web/src/trial";

/**
 * The Trial plan's 30 days as the team's pages say them: the Plan line in Settings. Dates are on the company's own
 * calendar. (The notice in a trial's last days and once it has ended comes from the server with Home, with the request
 * to choose a plan it offers; the people a plan includes come with the team.)
 */
const standing = (over: Record<string, unknown> = {}) => ({ started: true, startedAt: "2026-10-01T19:00:00.000Z", endsAt: "2026-10-31T19:00:00.000Z", daysLeft: 20, endingSoon: false, ended: false, extendedDays: 0, ...over });

describe("a trial's dates", () => {
  it("are on the company's calendar: the same moment can be another day elsewhere", () => {
    const lateEvening = "2026-11-01T05:30:00.000Z";
    expect(trialDate(lateEvening, "America/Los_Angeles")).toBe("October 31");
    expect(trialDate(lateEvening, "America/New_York")).toBe("November 1");
    expect(trialDate(lateEvening, "America/Los_Angeles", { short: true })).toBe("Oct 31");
    // a zone the browser does not know falls back to the default one, never an error
    expect(trialDate(lateEvening, "Not/AZone")).toBe("October 31");
    expect(trialDate("not a date")).toBe("not a date");
  });
});

describe("the Plan line", () => {
  it("says until when, or that it ended; nothing on another plan or before a trial has its dates", () => {
    expect(trialPlanLine(standing(), "America/Los_Angeles")).toBe("Trial until October 31");
    expect(trialPlanLine(standing({ ended: true }), "America/Los_Angeles")).toBe("Trial ended on October 31");
    expect(trialPlanLine(standing({ started: false, startedAt: null, endsAt: null, daysLeft: null }))).toBeNull();
    expect(trialPlanLine(null)).toBeNull();
    expect(trialPlanLine(undefined)).toBeNull();
  });
});

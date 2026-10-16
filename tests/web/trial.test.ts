import { describe, expect, it } from "vitest";
import { TRIAL_ASK, seatLine, seatsAllUsed, seatsFullWords, trialDate, trialPlanLine, trialRow } from "../../apps/web/src/trial";

/**
 * The Trial plan's 30 days and its 3 people (founder decision L-02 B) as the team's pages say them: the one row in the
 * trial's last 7 days and once it has ended, the Plan line, and the people line above the invite form. Dates are on the
 * company's own calendar.
 */
const standing = (over: Record<string, unknown> = {}) => ({ started: true, startedAt: "2026-10-01T19:00:00.000Z", endsAt: "2026-10-31T19:00:00.000Z", daysLeft: 20, endingSoon: false, ended: false, extendedDays: 0, ...over });

describe("the trial's row on Home and Settings", () => {
  it("says nothing before its last 7 days, nor on another plan, nor before the ITS check", () => {
    expect(trialRow(standing())).toBeNull();
    expect(trialRow(null)).toBeNull();
    expect(trialRow(undefined)).toBeNull();
    expect(trialRow(standing({ started: false, startedAt: null, endsAt: null, daysLeft: null }))).toBeNull();
  });

  it("in its last 7 days says when it ends, and that nothing stops until then", () => {
    expect(trialRow(standing({ endingSoon: true, daysLeft: 6 }), "America/Los_Angeles")).toEqual({ level: "ending", title: "Your trial ends on October 31", body: "Contact ITS to choose a plan before then; nothing stops until it ends." });
  });

  it("once it has ended, says the owner's one line", () => {
    expect(trialRow(standing({ ended: true, daysLeft: 0 }))).toEqual({ level: "ended", title: "Your trial has ended", body: "Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan." });
  });

  it("dates the end on the company's calendar: the same moment can be another day elsewhere", () => {
    const lateEvening = "2026-11-01T05:30:00.000Z";
    expect(trialDate(lateEvening, "America/Los_Angeles")).toBe("October 31");
    expect(trialDate(lateEvening, "America/New_York")).toBe("November 1");
    expect(trialDate(lateEvening, "America/Los_Angeles", { short: true })).toBe("Oct 31");
    // a zone the browser does not know falls back to the default one, never an error
    expect(trialDate(lateEvening, "Not/AZone")).toBe("October 31");
  });

  it("asks ITS about a plan in the request form, never in one click", () => {
    expect(TRIAL_ASK).toEqual({ kind: "ask", about: "all", topic: "plan", question: "We would like to choose a plan to keep hiring after our trial." });
  });
});

describe("the Plan line", () => {
  it("says until when, that it ended, or that the 30 days start at the ITS check; nothing on another plan", () => {
    expect(trialPlanLine(standing(), "America/Los_Angeles")).toBe("trial until October 31");
    expect(trialPlanLine(standing({ ended: true }), "America/Los_Angeles")).toBe("trial ended on October 31");
    expect(trialPlanLine(standing({ started: false, startedAt: null, endsAt: null, daysLeft: null }))).toBe("your 30-day trial starts when ITS confirms your company");
    expect(trialPlanLine(null)).toBeNull();
  });
});

describe("the people line above the invite form", () => {
  it("counts the invitations not yet answered too, and says nothing on a plan without a limit", () => {
    expect(seatLine({ used: 2, limit: 3 })).toBe("Your trial includes 3 people: 2 in use, counting invitations not yet answered.");
    expect(seatLine({ used: 7, limit: null })).toBeNull();
    expect(seatLine(undefined)).toBeNull();
  });

  it("is full at the limit (or past it: nobody already in is removed), in the API's own words", () => {
    expect(seatsAllUsed({ used: 2, limit: 3 })).toBe(false);
    expect(seatsAllUsed({ used: 3, limit: 3 })).toBe(true);
    expect(seatsAllUsed({ used: 5, limit: 3 })).toBe(true);
    expect(seatsAllUsed({ used: 9, limit: null })).toBe(false);
    expect(seatsFullWords({ used: 3, limit: 3 })).toBe("Your trial includes 3 people. Choose a plan to add more.");
  });
});

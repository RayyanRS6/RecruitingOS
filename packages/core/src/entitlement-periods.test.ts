import { describe, expect, it } from "vitest";
import { ACTIVE_ROLES, PERIOD_DAYS, TEXT_SCREENS, currentPeriod } from "./entitlements";
import { alertEmailText } from "./alerts";

/**
 * Monthly allowances that really start again (Wave S2 F1): the period dates applyPlan writes are read, and a period that
 * ended is followed by the next one, from zero. Pure rules; the database side is apps/api/src/plans-and-alerts.test.ts.
 */
describe("the period a monthly allowance is in", () => {
  const DAY = 86_400_000;
  const start = Date.parse("2026-09-01T12:00:00.000Z");
  const row = (used: number, key = TEXT_SCREENS) => ({ key, used, periodStart: new Date(start).toISOString(), periodEnd: new Date(start + PERIOD_DAYS * DAY).toISOString() });

  it("inside the period, the count stands and nothing moves", () => {
    expect(currentPeriod(row(25), new Date(start + 29 * DAY))).toEqual({ used: 25, periodStart: row(25).periodStart, periodEnd: row(25).periodEnd, rolled: false });
  });

  it("at the boundary the next period starts where the last one ended, from zero", () => {
    const p = currentPeriod(row(25), new Date(start + PERIOD_DAYS * DAY));
    expect(p).toEqual({ used: 0, periodStart: row(25).periodEnd, periodEnd: new Date(start + 2 * PERIOD_DAYS * DAY).toISOString(), rolled: true });
  });

  it("after several quiet periods it lands on the one that contains now, never in the past", () => {
    const now = new Date(start + 95 * DAY);
    const p = currentPeriod(row(25), now);
    expect(p.used).toBe(0);
    expect(p.periodStart).toBe(new Date(start + 90 * DAY).toISOString());
    expect(Date.parse(p.periodEnd!)).toBeGreaterThan(now.getTime());
    // and reading it again from the rolled row changes nothing (no double reset)
    expect(currentPeriod({ key: TEXT_SCREENS, used: 3, periodStart: p.periodStart, periodEnd: p.periodEnd }, now)).toMatchObject({ used: 3, rolled: false });
  });

  it("roles are counted for the life of the plan, and a row without dates keeps its count", () => {
    expect(currentPeriod(row(1, ACTIVE_ROLES), new Date(start + 400 * DAY))).toMatchObject({ used: 1, rolled: false });
    expect(currentPeriod({ key: TEXT_SCREENS, used: 9, periodStart: null, periodEnd: null }, new Date(start + 400 * DAY))).toMatchObject({ used: 9, rolled: false });
  });
});

describe("a critical alert by email", () => {
  it("carries the title and body without any email address in them, and where to act", () => {
    const { subject, text } = alertEmailText({ kind: "email.spam_complaint", severity: "critical", title: "Spam complaint from nia.brooks@example.com", body: "The address nia.brooks@example.com is suppressed.", createdAt: "2026-10-14T10:00:00.000Z" }, "https://app.example.test/admin");
    expect(subject).toBe("Critical alert: Spam complaint from [an email address]");
    expect(text).not.toContain("@example.com");
    expect(text).toContain("The address [an email address] is suppressed.");
    expect(text).toContain("https://app.example.test/admin");
  });
});

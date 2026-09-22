import { describe, expect, it } from "vitest";
import { canTransition, ownerGroup } from "./stages";
import { evaluateEligibility } from "./eligibility";
import { dedupeKey, normalizePhone } from "./dedupe";
import { DEFAULT_POLICIES, HARD_HUMAN_ONLY } from "./policy";
import { can } from "./permissions";
import { noticesFor, resolveJurisdictions } from "./compliance";

describe("state machine", () => {
  it("never lets the system reject on judgment", () => {
    expect(canTransition("triaged", "rejected", "system")).toBe(false);
    expect(canTransition("screen_complete", "rejected", "agent")).toBe(false);
    expect(canTransition("triaged", "rejected", "owner")).toBe(true);
  });
  it("never lets the system decline on an eligibility answer either; the hold is for a person", () => {
    expect(canTransition("ineligible", "rejected", "system")).toBe(false);
    expect(canTransition("ineligible", "rejected", "owner")).toBe(true);
    expect(canTransition("ineligible", "eligible", "owner")).toBe(true);
    expect(canTransition("ineligible", "eligible", "system")).toBe(false);
  });
  it("hire decisions are human", () => {
    expect(canTransition("debrief", "finalist", "system")).toBe(false);
    expect(canTransition("debrief", "finalist", "hiring_manager")).toBe(true);
  });
  it("candidates can withdraw from any active stage", () => {
    expect(canTransition("screening", "withdrawn", "candidate")).toBe(true);
    expect(canTransition("hired", "withdrawn", "candidate")).toBe(false);
  });
  it("groups stages for owners", () => {
    expect(ownerGroup("triaged")).toBe("waiting_on_you");
    expect(ownerGroup("screening")).toBe("in_process");
    expect(ownerGroup("rejected")).toBe("not_moving_forward");
  });
});

describe("eligibility", () => {
  const rules = [
    { key: "rdh_license", type: "license" as const, question: "Do you hold an active RDH license in California?", expectation: { license: "RDH", jurisdiction: "CA" }, rationale: "Required to practice", knockout: true },
    { key: "saturdays", type: "schedule_availability" as const, question: "Can you work Saturdays?", expectation: { days: ["Sat"] }, rationale: "Clinic is open Saturdays", knockout: true },
    { key: "start", type: "start_date" as const, question: "Can you start within 30 days?", expectation: { withinDays: 30 }, rationale: "Coverage gap", knockout: true },
  ];
  it("passes when answers meet every rule", () => {
    const r = evaluateEligibility(rules, { rdh_license: "yes", saturdays: ["Sat", "Mon"], start: true });
    expect(r.passed).toBe(true);
    expect(r.failedRules).toHaveLength(0);
  });
  it("fails on a no, and treats missing answers as unverifiable rather than failed", () => {
    const r = evaluateEligibility(rules, { rdh_license: "no" });
    expect(r.passed).toBe(false);
    expect(r.failedRules.map((f) => f.key)).toEqual(["rdh_license"]);
    expect(r.unverifiable.map((u) => u.key).sort()).toEqual(["saturdays", "start"]);
  });
});

describe("dedupe", () => {
  it("normalizes gmail dots and plus suffixes", () => {
    expect(dedupeKey("Jane.Doe+jobs@Gmail.com", null)).toBe("email:janedoe@gmail.com");
    expect(dedupeKey("Jane.Doe+jobs@example.com", null)).toBe("email:jane.doe@example.com");
  });
  it("falls back to phone", () => {
    expect(dedupeKey(null, "(949) 555-0100")).toBe("phone:+19495550100");
    expect(normalizePhone("1 949 555 0100")).toBe("+19495550100");
  });
});

describe("policy defaults", () => {
  it("keep the human-decision boundary", () => {
    for (const a of HARD_HUMAN_ONLY) expect(DEFAULT_POLICIES[a].level).toBe("human_only");
    expect(DEFAULT_POLICIES["role_packet.approve"].level).toBe("approval");
    expect(DEFAULT_POLICIES["message.send_templated"].level).toBe("auto");
  });
});

describe("permissions", () => {
  it("interviewers cannot see compensation or act on applications", () => {
    expect(can("interviewer", "compensation.read")).toBe(false);
    expect(can("interviewer", "application.act")).toBe(false);
    expect(can("interviewer", "scorecard.write")).toBe(true);
  });
});

describe("compliance", () => {
  it("resolves jurisdictions and picks notices", () => {
    const j = resolveJurisdictions([{ country: "US", region: "CA" }], "NV");
    expect(j).toEqual(["US-CA", "US-NV"]);
    const keys = noticesFor(j).map((n) => n.key);
    expect(keys).toContain("ai_use");
    expect(keys).toContain("pay_transparency");
    expect(keys).not.toContain("adverse_decision_explanation");
  });
});

describe("business hours (founder decision F12)", async () => {
  const { addBusinessHours, humanResponseExpectation, isBusinessTime, nextBusinessOpen, slaBusinessHours } = await import("./business-hours");
  // 2026-09-18 is a Friday. 16:30 Pacific (PDT, UTC-7) = 23:30Z.
  const fridayLate = new Date("2026-09-18T23:30:00Z");
  it("knows when the business is open", () => {
    expect(isBusinessTime(fridayLate)).toBe(true);
    expect(isBusinessTime(new Date("2026-09-19T17:00:00Z"))).toBe(false); // Saturday 10:00 Pacific
    expect(isBusinessTime(new Date("2026-09-07T17:00:00Z"))).toBe(false); // Labor Day
    expect(isBusinessTime(new Date("2026-09-16T15:30:00Z"))).toBe(false); // Wednesday 8:30 Pacific
    expect(isBusinessTime(new Date("2026-09-16T16:00:00Z"))).toBe(true); // Wednesday 9:00 Pacific
  });
  it("carries a four-hour SLA over a weekend", () => {
    // Friday 16:30 + 4 business hours = Monday 12:30 Pacific = 19:30Z
    expect(addBusinessHours(fridayLate, 4).toISOString()).toBe("2026-09-21T19:30:00.000Z");
  });
  it("skips holidays and starts the clock at the next opening", () => {
    // Friday 2026-09-04 16:00 Pacific + 8 business hours: 1h Friday, then Labor Day is skipped, then 7h on Tuesday → 16:00 Tuesday
    expect(addBusinessHours(new Date("2026-09-04T23:00:00Z"), 8).toISOString()).toBe("2026-09-08T23:00:00.000Z");
    // A request at 2:00 on a Sunday starts counting Monday at 9:00
    expect(nextBusinessOpen(new Date("2026-09-20T09:00:00Z")).toISOString()).toBe("2026-09-21T16:00:00.000Z");
  });
  it("maps escalation kinds to the approved SLAs", () => {
    expect(slaBusinessHours("candidate_issue")).toBe(4);
    expect(slaBusinessHours("negotiation")).toBe(2);
    expect(slaBusinessHours("review")).toBe(8);
    expect(slaBusinessHours("unknown_kind")).toBe(8);
  });
  it("tells candidates an expectation that is true when written", () => {
    expect(humanResponseExpectation(fridayLate)).toMatch(/four business hours/);
    expect(humanResponseExpectation(new Date("2026-09-19T17:00:00Z"))).toMatch(/next business day/);
  });
});

describe("editable business calendar (correction 12 of 18 September 2026)", async () => {
  const { DEFAULT_BUSINESS_CALENDAR, addBusinessHours, businessMinutesBetween, describeHours, humanResponseExpectation, isBusinessDay, isBusinessTime, nextBusinessOpen } = await import("./business-hours");
  const { calendarSourceFromVersions } = await import("./business-calendar");
  const cal = (over: Partial<import("./business-hours").BusinessCalendar>) => ({ ...DEFAULT_BUSINESS_CALENDAR, ...over });
  it("skips weekends", () => {
    // Saturday 2026-09-19 10:00 Pacific + 1 business hour = Monday 10:00 Pacific
    expect(addBusinessHours(new Date("2026-09-19T17:00:00Z"), 1).toISOString()).toBe("2026-09-21T17:00:00.000Z");
  });
  it("skips observed holidays", () => {
    // Thursday 2026-07-02 16:00 Pacific + 2h: 1h Thursday, Friday 3 July is the observed holiday, 1h Monday 6 July → 10:00 Pacific
    expect(isBusinessDay(new Date("2026-07-03T17:00:00Z"))).toBe(false);
    expect(addBusinessHours(new Date("2026-07-02T23:00:00Z"), 2).toISOString()).toBe("2026-07-06T17:00:00.000Z");
  });
  it("keeps wall-clock hours across the fall-back and spring-forward daylight-saving changes", () => {
    // Friday 2026-10-30 16:00 PDT (23:00Z) + 8h: 1h Friday, then Monday 2 November (PST) 09:00 → 16:00 PST = 00:00Z Tuesday
    expect(addBusinessHours(new Date("2026-10-30T23:00:00Z"), 8).toISOString()).toBe("2026-11-03T00:00:00.000Z");
    // Friday 2027-03-12 16:00 PST (00:00Z) + 8h: 1h Friday, then Monday 15 March (PDT) → 16:00 PDT = 23:00Z
    expect(addBusinessHours(new Date("2027-03-13T00:00:00Z"), 8).toISOString()).toBe("2027-03-15T23:00:00.000Z");
  });
  it("starts an outside-hours request at the next opening", () => {
    // Wednesday 2026-09-16 20:00 Pacific + 4h → Thursday 13:00 Pacific
    expect(addBusinessHours(new Date("2026-09-17T03:00:00Z"), 4).toISOString()).toBe("2026-09-17T20:00:00.000Z");
  });
  it("spreads multi-day deadlines over open hours only", () => {
    // Monday 2026-09-14 09:00 Pacific + 24 business hours = three full days → Wednesday 17:00 Pacific
    expect(addBusinessHours(new Date("2026-09-14T16:00:00Z"), 24).toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });
  it("honours ITS closures and temporary coverage changes", () => {
    const closed = cal({ closures: [{ from: "2026-09-21", to: "2026-09-25", name: "Team offsite" }] });
    // Friday 2026-09-18 16:00 Pacific + 2h: 1h Friday, the whole next week closed, 1h Monday 28 September → 10:00 Pacific
    expect(addBusinessHours(new Date("2026-09-18T23:00:00Z"), 2, closed).toISOString()).toBe("2026-09-28T17:00:00.000Z");
    const half = cal({ coverageChanges: [{ from: "2026-09-16", to: "2026-09-16", reason: "half day", hours: [{ start: "13:00", end: "17:00" }] }] });
    expect(isBusinessTime(new Date("2026-09-16T16:30:00Z"), half)).toBe(false); // 09:30 Pacific on the half day
    expect(nextBusinessOpen(new Date("2026-09-16T16:30:00Z"), half).toISOString()).toBe("2026-09-16T20:00:00.000Z");
    const dark = cal({ coverageChanges: [{ from: "2026-09-16", to: "2026-09-17", reason: "no coverage", hours: null }] });
    expect(isBusinessDay(new Date("2026-09-16T18:00:00Z"), dark)).toBe(false);
    expect(isBusinessDay(new Date("2026-09-18T18:00:00Z"), dark)).toBe(true);
  });
  it("works in another time zone", () => {
    const eastern = cal({ timeZone: "America/New_York" });
    expect(isBusinessTime(new Date("2026-09-14T13:00:00Z"), eastern)).toBe(true); // 09:00 Eastern
    expect(isBusinessTime(new Date("2026-09-14T13:00:00Z"))).toBe(false); // 06:00 Pacific
    expect(addBusinessHours(new Date("2026-09-14T13:00:00Z"), 8, eastern).toISOString()).toBe("2026-09-14T21:00:00.000Z");
    expect(describeHours(eastern)).toBe("Monday to Friday, 9 to 5 Eastern");
  });
  it("applies a version exactly from its effective date, even inside one deadline", () => {
    const row = (version: number, effectiveFrom: string, hours: import("./business-hours").WeeklyHours) => ({ id: String(version), calendarKey: "its", version, effectiveFrom, timeZone: "America/Los_Angeles", hours, holidays: [], closures: [], coverageChanges: [], note: "", createdBy: { kind: "system" as const, id: "t" }, createdAt: "2026-09-01T00:00:00Z" });
    const mornings = { ...DEFAULT_BUSINESS_CALENDAR.hours, thu: [{ start: "09:00", end: "12:00" }], fri: [{ start: "09:00", end: "12:00" }] };
    const src = calendarSourceFromVersions([row(1, "2026-09-01", DEFAULT_BUSINESS_CALENDAR.hours), row(2, "2026-09-17", mornings)], new Date("2026-09-16T20:00:00Z"));
    expect(src.version).toBe(1);
    // Wednesday 16 September 16:00 Pacific + 5h: 1h Wednesday (v1), 3h Thursday morning (v2), 1h Friday → Friday 10:00 Pacific
    expect(addBusinessHours(new Date("2026-09-16T23:00:00Z"), 5, src).toISOString()).toBe("2026-09-18T17:00:00.000Z");
    expect(addBusinessHours(new Date("2026-09-16T23:00:00Z"), 5).toISOString()).toBe("2026-09-17T20:00:00.000Z");
    const later = calendarSourceFromVersions(src.versions, new Date("2026-09-17T20:00:00Z"));
    expect(later.version).toBe(2);
    expect(describeHours(later, new Date("2026-09-17T20:00:00Z"))).toMatch(/Thursday 9 to 12/);
  });
  it("measures remaining business time in both directions", () => {
    // Friday 2026-09-18 16:00 Pacific → Monday 10:00 Pacific = 60 + 60 minutes
    expect(businessMinutesBetween(new Date("2026-09-18T23:00:00Z"), new Date("2026-09-21T17:00:00Z"))).toBe(120);
    expect(businessMinutesBetween(new Date("2026-09-21T17:00:00Z"), new Date("2026-09-18T23:00:00Z"))).toBe(-120);
    expect(businessMinutesBetween(new Date("2026-09-19T17:00:00Z"), new Date("2026-09-20T17:00:00Z"))).toBe(0); // weekend
  });
  it("writes customer copy from the calendar in force", () => {
    expect(describeHours()).toBe("Monday to Friday, 9 to 5 Pacific");
    expect(describeHours(cal({ hours: { ...DEFAULT_BUSINESS_CALENDAR.hours, mon: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "17:30" }] } }))).toBe("Monday 9 to 12 and 1 to 5:30, Tuesday 9 to 5, Wednesday 9 to 5, Thursday 9 to 5, Friday 9 to 5 Pacific");
    expect(humanResponseExpectation(new Date("2026-09-19T17:00:00Z"), cal({ hours: { ...DEFAULT_BUSINESS_CALENDAR.hours, sat: [{ start: "10:00", end: "14:00" }] } }))).toMatch(/^within four business hours/);
  });
});

import { describe, expect, it } from "vitest";
import { noCommonTimesNoticeKey } from "./notifications";

/**
 * The "No common times" notice is told once per interview and window, then only when something changes (audit
 * 06-interviews, bug 105). The key the scheduling workflow keeps decides it.
 */
describe("noCommonTimesNoticeKey", () => {
  const person = (userId: string, windows: unknown = [{ day: 6, start: "09:00", end: "17:00" }]) => ({ userId, source: "declared", timezone: "America/Los_Angeles", windows, bufferMinutes: 15, maxPerDay: 6, busy: [] });
  const base = {
    interviewId: "iv-1",
    attempt: 1,
    durationMinutes: 45,
    // Tuesday 13 Oct to Monday 19 Oct 2026: five business days
    window: { fromDate: "2026-10-13", toDate: "2026-10-19", businessDaysOnly: true },
    participants: [person("a"), person("b", [{ day: 1, start: "09:00", end: "17:00" }])],
  };
  const key = (over: Partial<typeof base> = {}) => noCommonTimesNoticeKey({ ...base, ...over });

  it("stays the same when the window only moves forward with the same number of days, or busy times change", () => {
    // Thursday 15 Oct to Wednesday 21 Oct: five business days again
    expect(key({ window: { fromDate: "2026-10-15", toDate: "2026-10-21", businessDaysOnly: true } })).toBe(key());
    expect(key({ participants: [{ ...person("a"), busy: [{ start: "2026-10-14T16:00:00Z", end: "2026-10-14T17:00:00Z" }] } as ReturnType<typeof person>, base.participants[1]] })).toBe(key());
    // the order the interviewers come in does not matter
    expect(key({ participants: [base.participants[1], base.participants[0]] })).toBe(key());
  });

  it("changes when something that matters changes: hours, a person, the length, the attempt, the window's span or the interview", () => {
    const k = key();
    expect(key({ participants: [person("a", [{ day: 6, start: "10:00", end: "16:00" }]), base.participants[1]] })).not.toBe(k);
    expect(key({ participants: [person("a"), person("c")] })).not.toBe(k);
    expect(key({ durationMinutes: 60 })).not.toBe(k);
    expect(key({ attempt: 2 })).not.toBe(k);
    expect(key({ window: { fromDate: "2026-10-13", toDate: "2026-10-26", businessDaysOnly: true } })).not.toBe(k);
    expect(key({ window: { ...base.window, businessDaysOnly: false } })).not.toBe(k);
    expect(key({ interviewId: "iv-2" })).not.toBe(k);
    expect(k.startsWith("iv-1:")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { EligibilityRule } from "@ros/contracts";
import { evaluateEligibility } from "./eligibility";

/**
 * Eligibility rules are drafted by a model, so their expectations arrive in whatever JSON shape it wrote. On staging
 * (13 Oct 2026) a rule's days came as one string and the application workflow failed at this step with
 * "required.filter is not a function". A rule is read in any shape, and one that cannot be read is left for a person.
 */
const now = new Date("2026-10-13T12:00:00Z");
const schedule = (expectation: unknown): EligibilityRule => ({ key: "schedule", type: "schedule_availability", question: "Which of these days can you work?", expectation: expectation as Record<string, unknown>, rationale: "The office is open Monday to Friday.", knockout: true });
const start = (expectation: unknown): EligibilityRule => ({ key: "start", type: "start_date", question: "Can you start within 30 days?", expectation: expectation as Record<string, unknown>, rationale: "We need someone by next month.", knockout: true });
const one = (rule: EligibilityRule, answer: unknown) => {
  const r = evaluateEligibility([rule], { [rule.key]: answer }, now);
  return { passed: r.passed, failed: r.failedRules.map((f) => f.reason), unknown: r.unverifiable.map((u) => u.reason) };
};

describe("a schedule rule, whatever shape its days came in", () => {
  it("days written as one string, as on staging: a yes or a no answers the question the job page asked", () => {
    // Days that are not a list are shown as a yes-or-no question, so that is the answer that comes back.
    expect(one(schedule({ days: "Monday–Friday" }), "yes")).toEqual({ passed: true, failed: [], unknown: [] });
    expect(one(schedule({ days: "Monday–Friday" }), "no")).toEqual({ passed: false, failed: ["not available for the required schedule"], unknown: [] });
    // and the same for days given as a list
    expect(one(schedule({ days: ["Mon", "Tue"] }), "yes").passed).toBe(true);
  });

  it("reads ranges, lists and words for days, and compares them with the days the candidate ticked", () => {
    const ticked = ["Mon", "Tue", "Wed"];
    const notAvailable = (days: unknown) => one(schedule({ days }), ticked).failed;
    expect(notAvailable("Monday–Friday")).toEqual(["not available: Thu, Fri"]);
    expect(notAvailable("Mon-Fri")).toEqual(["not available: Thu, Fri"]);
    expect(notAvailable("Monday to Friday, 8am to 5pm")).toEqual(["not available: Thu, Fri"]);
    expect(notAvailable("M–F")).toEqual(["not available: Thu, Fri"]);
    expect(notAvailable("weekdays")).toEqual(["not available: Thu, Fri"]);
    expect(notAvailable("Saturday and Sunday")).toEqual(["not available: Sat, Sun"]);
    expect(notAvailable("weekends")).toEqual(["not available: Sat, Sun"]);
    expect(notAvailable("Fri-Mon")).toEqual(["not available: Fri, Sat, Sun"]);
    expect(notAvailable(["Monday", "Tuesdays", "thurs"])).toEqual(["not available: Thu"]);
    expect(notAvailable(["Mon-Wed"])).toEqual([]);
    expect(notAvailable("Mon and Tue, thus early in the week")).toEqual([]);
    expect(notAvailable({ Mon: true, Tue: "yes", Sat: false })).toEqual([]);
    expect(notAvailable({ from: "Monday", to: "Thursday" })).toEqual(["not available: Thu"]);
  });

  it("matches full day names to the job page's boxes (\"Monday\" is \"Mon\")", () => {
    expect(one(schedule({ days: ["Monday", "Saturday"] }), ["Mon", "Sat", "Sun"]).passed).toBe(true);
    // one box ticked comes back as a single value, not a list
    expect(one(schedule({ days: ["Sat"] }), "Sat").passed).toBe(true);
    expect(one(schedule({ days: ["Sat"] }), "Mon, Tue").failed).toEqual(["not available: Sat"]);
  });

  it("leaves a rule it cannot read for a person: never a crash, never a fail", () => {
    const ticked = ["Mon", "Tue"];
    for (const days of [5, true, "flexible", "no Sundays", "any day but Sunday", ["Mon", 3], [["Mon"]], { hours: "8-5" }, { from: 1, to: 2 }]) {
      expect(one(schedule({ days }), ticked), JSON.stringify(days)).toEqual({ passed: true, failed: [], unknown: ["the days the job needs could not be read"] });
    }
    // no days at all, and an answer that is not yes or no
    expect(one(schedule({}), ticked).unknown).toEqual(["the days the job needs could not be read"]);
    for (const answer of [42, [1, 2], { day: "Mon" }, "whenever"]) {
      expect(one(schedule({ days: ["Mon"] }), answer), JSON.stringify(answer)).toEqual({ passed: true, failed: [], unknown: ["answer not yes/no or a list of days"] });
    }
  });

  it("leaves days that offer a choice, or are needed only sometimes, for a person: never an automatic hold", () => {
    // Read as "every day named is required", each of these failed a candidate who fits (review, 13 Oct 2026).
    const cases: Array<[unknown, string[]]> = [
      [["Any 3 days Mon–Fri"], ["Mon", "Tue", "Wed"]],
      [["Mon & Wed or Tue & Thu"], ["Mon", "Wed"]],
      [["Shifts between Monday and Saturday"], ["Mon", "Tue"]],
      [["Monday-Friday, Saturday mornings as needed"], ["Mon", "Tue", "Wed", "Thu", "Fri"]],
      [["Some weekends"], ["Sat"]],
      ["Weekdays, plus every other Saturday", ["Mon", "Tue", "Wed", "Thu", "Fri"]],
      [["Mon–Fri", "alternate Saturdays"], ["Mon", "Tue", "Wed", "Thu", "Fri"]],
      ["Mon-Fri; on-call one Sunday a month", ["Mon", "Tue", "Wed", "Thu", "Fri"]],
      ["Monday to Friday, some Saturdays", ["Mon", "Tue", "Wed", "Thu", "Fri"]],
      ["3 days a week, Monday to Friday", ["Mon", "Tue", "Wed"]],
      ["Tuesday or Thursday", ["Tue"]],
      ["Saturdays preferred", ["Mon"]],
      ["One Saturday a month", ["Mon"]],
      ["Rotating weekends", ["Sat"]],
    ];
    for (const [days, ticked] of cases) {
      expect(one(schedule({ days }), ticked), JSON.stringify(days)).toEqual({ passed: true, failed: [], unknown: ["the days the job needs could not be read"] });
    }
  });

  it("still reads days that are all needed, a count of them included", () => {
    const ticked = ["Mon", "Tue", "Wed"];
    expect(one(schedule({ days: "Monday to Friday, 5 days a week" }), ticked).failed).toEqual(["not available: Thu, Fri"]);
    expect(one(schedule({ days: "Tuesday through Saturday" }), ticked).failed).toEqual(["not available: Thu, Fri, Sat"]);
    expect(one(schedule({ days: "Seven days a week" }), ticked).failed).toEqual(["not available: Thu, Fri, Sat, Sun"]);
    expect(one(schedule({ days: ["Mon", "Tue", "Wed"] }), ticked).passed).toBe(true);
  });
});

describe("a start-date rule, whatever shape its window came in", () => {
  it("reads the window as a number or in words, and compares a written date with it", () => {
    expect(one(start({ withinDays: 30 }), "2026-11-01").passed).toBe(true);
    expect(one(start({ withinDays: "30" }), "2026-11-01").passed).toBe(true);
    expect(one(start({ withinDays: "30 days" }), "2026-12-01").failed).toEqual(["earliest start 2026-12-01 is after 30 days"]);
    // "2–4 weeks" allows 28 days, the upper end
    expect(one(start({ withinDays: "2–4 weeks" }), "2026-11-09").passed).toBe(true);
    expect(one(start({ withinDays: "2–4 weeks" }), "2026-11-12").failed).toEqual(["earliest start 2026-11-12 is after 28 days"]);
  });

  it("a yes or a no needs no window; a date with a window it cannot read is left for a person", () => {
    expect(one(start({ withinDays: 30 }), "no").failed).toEqual(["cannot start within 30 days"]);
    expect(one(start({}), "no").failed).toEqual(["answered no to: Can you start within 30 days?"]);
    expect(one(start({}), "yes").passed).toBe(true);
    for (const withinDays of [undefined, "soon", -3, Number.NaN, ["30"], { days: 30 }]) {
      expect(one(start({ withinDays }), "2026-11-01"), String(withinDays)).toEqual({ passed: true, failed: [], unknown: ["the start window could not be read"] });
    }
    // a "date" with no year is not read as one (Date.parse would put it in 2001)
    expect(one(start({ withinDays: 30 }), "May 3").unknown).toEqual(["start date not parseable"]);
  });
});

describe("rules and answers in shapes nobody planned for", () => {
  it("never throws, whatever the expectation, the answers or the list of rules", () => {
    const expectations: unknown[] = [undefined, null, "Monday–Friday", 7, ["Mon"], { days: "Mon-Fri", withinDays: "2 weeks" }, { days: { Mon: 1 } }];
    const answers: unknown[] = ["yes", "no", ["Mon"], "Mon, Tue", 7, { x: 1 }, [null], true];
    for (const type of ["license", "certification", "work_authorization", "schedule_availability", "start_date", "location_radius", "physical_requirement_bona_fide", "minimum_age_legal", "something_new"]) {
      for (const expectation of expectations) {
        for (const answer of answers) {
          const rule = { key: "k", type, question: "Q?", expectation, rationale: "Why.", knockout: true } as unknown as EligibilityRule;
          expect(() => evaluateEligibility([rule], { k: answer }, now)).not.toThrow();
        }
      }
    }
    expect(evaluateEligibility(undefined as unknown as EligibilityRule[], {}, now).passed).toBe(true);
    expect(evaluateEligibility([schedule({ days: ["Mon"] })], undefined as unknown as Record<string, unknown>, now).unverifiable.map((u) => u.reason)).toEqual(["not answered"]);
  });

  it("a rule that fails to be read at all is left for a person, and the other rules are still checked", () => {
    const broken = schedule(
      new Proxy({}, {
        get: () => {
          throw new Error("boom");
        },
      }),
    );
    const license: EligibilityRule = { key: "license", type: "license", question: "Do you hold an active RDA license in California?", expectation: {}, rationale: "California requires this license to practice.", knockout: true };
    const r = evaluateEligibility([broken, license], { schedule: ["Mon"], license: "no" }, now);
    expect(r.unverifiable).toEqual([{ key: "schedule", question: "Which of these days can you work?", reason: "the rule could not be read" }]);
    expect(r.failedRules.map((f) => f.key)).toEqual(["license"]);
  });

  it("an empty list of days ticked counts as not answered", () => {
    expect(one(schedule({ days: ["Mon"] }), []).unknown).toEqual(["not answered"]);
  });
});

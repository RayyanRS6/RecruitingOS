import { describe, expect, it } from "vitest";
import type { ScreenProgress } from "@ros/contracts";
import { APPLY_FLOW_FALLBACK, isStillApplying, oneVisitPolicyAllows, resolveApplyMode, screeningFunnel, tapAnswerText, tapFormatFor, type FunnelScreen } from "./apply-flow";
import { canTransition } from "./stages";

/** Wave E's pure rules: which flow a role uses, who is still applying, tap answers, and the per-role figures. */
describe("the flow a role uses (plan E1, the rollout decision)", () => {
  it("a role's own setting wins, then the company's default, then 'form now, conversation later' (pilot roles first)", () => {
    // nothing set anywhere: the later path; the one-visit flow is switched on by ITS, role by role or company by company
    expect(resolveApplyMode({ applyMode: null }, {})).toBe("form_then_screen");
    expect(resolveApplyMode({ applyMode: null }, null)).toBe("form_then_screen");
    expect(APPLY_FLOW_FALLBACK).toBe("form_then_screen");
    expect(resolveApplyMode({ applyMode: null }, { applyFlowDefault: "one_visit" })).toBe("one_visit");
    expect(resolveApplyMode({ applyMode: null }, { applyFlowDefault: "form_then_screen" })).toBe("form_then_screen");
    expect(resolveApplyMode({ applyMode: "one_visit" }, { applyFlowDefault: "form_then_screen" })).toBe("one_visit");
    expect(resolveApplyMode({ applyMode: "one_visit" }, {})).toBe("one_visit");
    expect(resolveApplyMode({ applyMode: "form_then_screen" }, { applyFlowDefault: "one_visit" })).toBe("form_then_screen");
    // anything unknown falls back to the default, never to a third flow
    expect(resolveApplyMode({ applyMode: "something" }, {})).toBe("form_then_screen");
    expect(resolveApplyMode({ applyMode: null }, { applyFlowDefault: "something" })).toBe("form_then_screen");
  });

  it("'ask me first' and 'only a person' keep the later path; the automatic levels allow the one-visit flow", () => {
    expect(oneVisitPolicyAllows("auto")).toBe(true);
    expect(oneVisitPolicyAllows("auto_notify")).toBe(true);
    expect(oneVisitPolicyAllows("approval")).toBe(false);
    expect(oneVisitPolicyAllows("human_only")).toBe(false);
  });

  it("still applying: offered with the application and not finished, sent without, handed over or closed", () => {
    for (const status of ["invited", "reminded", "in_progress", "paused"]) expect(isStillApplying({ status, invitedVia: "apply" }), status).toBe(true);
    for (const status of ["completed", "human_requested", "declined_by_candidate", "unfinished", "expired", "cancelled", "abandoned"]) expect(isStillApplying({ status, invitedVia: "apply" }), status).toBe(false);
    expect(isStillApplying({ status: "in_progress", invitedVia: null })).toBe(false);
    expect(isStillApplying(null)).toBe(false);
  });

  it("the system may send the application on to the team when the candidate sends it without the conversation or stops part-way", () => {
    expect(canTransition("screen_invited", "triaged", "system")).toBe(true);
    expect(canTransition("screening", "triaged", "system")).toBe(true);
    expect(canTransition("screen_complete", "triaged", "system")).toBe(false);
  });
});

describe("tap answers (plan E12)", () => {
  const comp = { basis: "hourly" as const, currency: "USD" };
  it("works out the format from the question's kind and wording; skills and examples are always typed", () => {
    expect(tapFormatFor({ kind: "compensation", question: "What pay range are you looking for?" }, comp)).toEqual({ kind: "pay_range", basis: "hourly", currency: "USD" });
    expect(tapFormatFor({ kind: "eligibility", question: "Is your RDH license active in California?" }, comp)).toEqual({ kind: "yes_no" });
    expect(tapFormatFor({ kind: "eligibility", question: "Tell us about your license." }, comp)).toEqual({ kind: "yes_no" });
    expect(tapFormatFor({ kind: "availability", question: "Which days of the week can you work?" }, comp)).toMatchObject({ kind: "days" });
    expect(tapFormatFor({ kind: "availability", question: "When could you start?" }, comp)).toEqual({ kind: "start_date" });
    expect(tapFormatFor({ kind: "availability", question: "Which days and hours are you available, and when could you start?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "logistics", question: "Do you have reliable transportation to Irvine?" }, comp)).toEqual({ kind: "yes_no" });
    expect(tapFormatFor({ kind: "logistics", question: "How far is your commute?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "skills", question: "Do you use Dentrix?" }, comp)).toBeNull();
    expect(tapFormatFor({ kind: "behavioral", question: "Tell me about a hard moment with a patient." }, comp)).toBeNull();
  });

  it("records a tap as fixed words, and refuses one that does not fit the question", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(tapAnswerText({ kind: "yes_no" }, { kind: "yes_no", choice: "yes" })).toBe("Yes");
    expect(tapAnswerText({ kind: "yes_no" }, { kind: "yes_no", choice: "no" })).toBe("No");
    expect(tapAnswerText({ kind: "days", options: [] }, { kind: "days", days: ["saturday", "Monday", "Tuesday"] })).toBe("I can work Monday, Tuesday and Saturday.");
    expect(tapAnswerText({ kind: "days", options: [] }, { kind: "days", days: ["Funday"] })).toBeNull();
    expect(tapAnswerText({ kind: "start_date" }, { kind: "start_date", date: "2026-11-02" }, now)).toBe("I can start on Monday, November 2, 2026.");
    expect(tapAnswerText({ kind: "start_date" }, { kind: "start_date", date: "2020-01-01" }, now)).toBeNull();
    expect(tapAnswerText({ kind: "pay_range", basis: "hourly", currency: "USD" }, { kind: "pay_range", min: 48, max: 52 })).toBe("I'm looking for $48 to $52 an hour.");
    expect(tapAnswerText({ kind: "pay_range", basis: "salary", currency: "USD" }, { kind: "pay_range", min: 72000 })).toBe("I'm looking for $72,000 a year.");
    expect(tapAnswerText({ kind: "pay_range", basis: "hourly", currency: "USD" }, { kind: "pay_range", min: 60, max: 50 })).toBeNull();
    expect(tapAnswerText({ kind: "yes_no" }, { kind: "pay_range", min: 50 })).toBeNull();
  });
});

describe("how the conversation goes for a role (plan E13)", () => {
  const progress = (over: Partial<ScreenProgress> = {}): ScreenProgress => ({ askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0, ...over });
  const at = (min: number) => new Date(Date.UTC(2026, 9, 8, 10, min)).toISOString();
  const said = (min: number) => [{ role: "candidate" as const, content: "Yes", at: at(min) }];
  const rows: FunnelScreen[] = [
    { status: "completed", invitedVia: "apply", startedAt: at(0), completedAt: at(8), progress: progress({ submittedAt: at(8) }), transcript: said(0) },
    { status: "completed", invitedVia: "apply", startedAt: at(0), completedAt: at(12), progress: progress({ declined: ["pay"] }), transcript: said(2) },
    { status: "unfinished", invitedVia: "apply", startedAt: at(0), completedAt: null, progress: progress({ currentQuestionKey: "experience", askedKeys: ["license", "experience"] }), transcript: said(0) },
    { status: "declined_by_candidate", invitedVia: "apply", startedAt: at(0), completedAt: null, progress: progress({ askedKeys: ["license", "experience"] }), transcript: said(0) },
    { status: "human_requested", invitedVia: null, startedAt: null, completedAt: null, progress: progress(), transcript: [] },
    { status: "invited", invitedVia: "apply", startedAt: null, completedAt: null, progress: progress(), transcript: [] },
  ];
  it("counts offered, started, finished, the median time, where people stopped, who chose a person, and skips", () => {
    const f = screeningFunnel(rows, [{ key: "license", question: "Is your license active?" }, { key: "experience", question: "Tell me about your work." }, { key: "pay", question: "What range?" }]);
    expect(f).toMatchObject({ offered: 6, started: 4, finished: 2, unfinished: 1, stillApplying: 1, medianMinutes: 9, personChosen: { contactMe: 1, sendWithout: 1 } });
    expect(f.dropOff).toEqual({ key: "experience", question: "Tell me about your work.", count: 2 });
    expect(f.skipped).toEqual([{ key: "pay", question: "What range?", count: 1 }]);
    expect(screeningFunnel([], [])).toMatchObject({ offered: 0, medianMinutes: null, dropOff: null });
  });
});

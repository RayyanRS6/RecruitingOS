import { describe, expect, it } from "vitest";
import type { ScreenProgress } from "@ros/contracts";
import { APPLY_FLOW_FALLBACK, CHAT_GAP_LIMIT, CHAT_WRAP_KEY, buildChatPlan, chatItemSettled, chatMoveStays, chatNextMove, isStillApplying, oneVisitPolicyAllows, resolveApplyMode, saysNotDone, screeningFunnel, syncChatPlan, tapAnswerText, tapFormatFor, type FunnelScreen } from "./apply-flow";
import { chatCounter } from "./apply-questions";
import { canTransition } from "./stages";

/** Wave S7: the Kanvis-style chat's plan, fixed and moved on in code (the contracts in s7-contracts.md section 2b). */
describe("the chat's plan (founder decision S7-3: a counter and the section, never the questions in advance)", () => {
  const at = "2026-10-15T10:00:00.000Z";
  const plan = () => buildChatPlan({ gaps: ["arduino", "teaching"], written: [{ key: "wq_explain", required: true }, { key: "wq_room", required: true }, { key: "wq_extra", required: false }], at });

  it("puts the gaps first, then the written questions; starts in the first section that has an item; only required written ones count", () => {
    const p = plan();
    expect(p).toMatchObject({ v: 1, section: "experience", current: null, builtAt: at });
    expect(p.items.map((i) => [i.key, i.kind, i.required, i.state, i.step, i.pushes])).toEqual([
      ["arduino", "gap", false, "open", "direct", 0], ["teaching", "gap", false, "open", "direct", 0],
      ["wq_explain", "written", true, "open", "direct", 0], ["wq_room", "written", true, "open", "direct", 0], ["wq_extra", "written", false, "open", "direct", 0],
    ]);
    expect(chatCounter(p)?.label).toBe("0 of 2 required · About your experience");
    // no gaps (the reading had not run, or a repeat submission's chat): it starts at the required questions
    expect(buildChatPlan({ gaps: [], written: [{ key: "pay", required: true }], at }).section).toBe("required");
    // nothing at all: straight to the close
    expect(buildChatPlan({ gaps: [], written: [], at }).section).toBe("wrapping_up");
    // at most CHAT_GAP_LIMIT gaps, never twice the same key, never the closing question's key
    const many = buildChatPlan({ gaps: ["a", "b", "a", "c", "d", "e", "f"], written: [{ key: "a", required: true }, { key: CHAT_WRAP_KEY, required: true }], at });
    expect(many.items.filter((i) => i.kind === "gap")).toHaveLength(CHAT_GAP_LIMIT);
    expect(many.items.map((i) => i.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("the ladder: concrete covers; vague gets one push then counts; 'No' climbs to the analog, then (a gap) the smaller version, then not known", () => {
    const gap = { kind: "gap" as const, step: "direct" as const, pushes: 0 };
    expect(chatNextMove(gap, "concrete", true)).toBe("covered");
    expect(chatNextMove(gap, "vague", true)).toBe("push");
    expect(chatNextMove({ ...gap, pushes: 1 }, "vague", true)).toBe("covered");
    expect(chatNextMove(gap, "not_done", true)).toBe("analog");
    expect(chatNextMove({ ...gap, step: "analog" }, "not_done", true)).toBe("smaller");
    expect(chatNextMove({ ...gap, step: "smaller" }, "not_done", true)).toBe("unknown");
    // a written question: the analog, then not known (no smaller version)
    expect(chatNextMove({ kind: "written", step: "analog", pushes: 0 }, "not_done", true)).toBe("unknown");
    // a yes-or-no question takes its answer as it is: "No", or a bare "Yes"
    expect(chatNextMove({ kind: "written", step: "direct", pushes: 0 }, "not_done", false)).toBe("covered");
    expect(chatNextMove({ kind: "written", step: "direct", pushes: 0 }, "vague", false)).toBe("covered");
    expect(["push", "analog", "smaller"].every((m) => chatMoveStays(m as "push"))).toBe(true);
    expect(chatMoveStays("covered") || chatMoveStays("unknown")).toBe(false);
  });

  it("reads a plain 'No' / 'I haven't' as not done, and a 'No, but…' as an answer", () => {
    for (const no of ["No", "no.", "Nope", "I haven't", "I haven’t done that", "Not really", "Never", "No, I haven't", "I don't", "I have never done that"]) expect(saysNotDone(no), no).toBe(true);
    for (const yes of ["No, but at my last job I explained the X-ray to a nervous patient", "Not yet, though I shadowed it once", "Yes", "I built a pump controller", "", "Not exactly the same, similar though: I ran the front desk"]) expect(saysNotDone(yes), yes).toBe(false);
  });

  it("moves on with the progress: asking, covered once passed, not known stays so, skipped; the section follows; the counter counts settled required ones", () => {
    let p = plan();
    p = syncChatPlan(p, { askedKeys: ["arduino"], currentQuestionKey: "arduino" });
    expect(p).toMatchObject({ section: "experience", current: "arduino" });
    expect(p.items[0].state).toBe("asking");
    // "No": the analog, still asking
    p = syncChatPlan(p, { askedKeys: ["arduino"], currentQuestionKey: "arduino" }, { key: "arduino", move: "analog" });
    expect(p.items[0]).toMatchObject({ state: "asking", step: "analog" });
    // settled as not known, the chat moves on to the next gap
    p = syncChatPlan(p, { askedKeys: ["arduino", "teaching"], currentQuestionKey: "teaching" }, { key: "arduino", move: "unknown" });
    expect(p.items.slice(0, 2).map((i) => i.state)).toEqual(["unknown", "asking"]);
    // passed on to the written questions: the gap is covered, the section is "Required questions"
    p = syncChatPlan(p, { askedKeys: ["arduino", "teaching", "wq_explain"], currentQuestionKey: "wq_explain" }, { key: "teaching", move: "push" });
    expect(p.items[1]).toMatchObject({ state: "covered", pushes: 1 });
    expect(p.section).toBe("required");
    expect(chatCounter(p)?.label).toBe("0 of 2 required · Required questions");
    // one skipped, one covered: 2 of 2; the closing question is "Wrapping up"
    p = syncChatPlan(p, { askedKeys: ["arduino", "teaching", "wq_explain", "wq_room", "wq_extra", CHAT_WRAP_KEY], currentQuestionKey: CHAT_WRAP_KEY, declined: ["wq_room"] });
    expect(p.items.slice(2).map((i) => i.state)).toEqual(["covered", "skipped", "covered"]);
    expect(p).toMatchObject({ section: "wrapping_up", current: null });
    expect(chatCounter(p)?.label).toBe("2 of 2 required · Wrapping up");
    expect(p.items.every(chatItemSettled)).toBe(true);
    // the arduino gap settled as not known stays so even though it was asked and passed
    expect(p.items[0].state).toBe("unknown");
  });
});

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
    // a skip in a conversation nobody sent is never counted, even in a figure (founder decision of 9 October 2026)
    { status: "unfinished", invitedVia: "apply", startedAt: at(0), completedAt: null, progress: progress({ currentQuestionKey: "experience", askedKeys: ["license", "experience"], declined: ["license"] }), transcript: said(0) },
    { status: "declined_by_candidate", invitedVia: "apply", startedAt: at(0), completedAt: null, progress: progress({ askedKeys: ["license", "experience"], declined: ["pay"] }), transcript: said(0) },
    { status: "human_requested", invitedVia: null, startedAt: null, completedAt: null, progress: progress(), transcript: [] },
    { status: "invited", invitedVia: "apply", startedAt: null, completedAt: null, progress: progress(), transcript: [] },
  ];
  const questions = [{ key: "license", question: "Is your license active?" }, { key: "experience", question: "Tell me about your work." }, { key: "pay", question: "What range?" }];
  it("counts offered, started, finished, the median time, who chose a person, and skips", () => {
    const f = screeningFunnel(rows, questions);
    expect(f).toMatchObject({ offered: 6, started: 4, finished: 2, unfinished: 1, stillApplying: 1, medianMinutes: 9, personChosen: { contactMe: 1, sendWithout: 1 } });
    expect(f.skipped).toEqual([{ key: "pay", question: "What range?", count: 1 }]);
    expect(screeningFunnel([], [])).toMatchObject({ offered: 0, medianMinutes: null });
  });

  it("never says where anyone stopped, or times a conversation the candidate did not send (founder decision of 9 October 2026)", () => {
    // one person who didn't finish: the team sees that on her, so a "stopped at" figure would say how far she got
    const f = screeningFunnel(rows, questions);
    expect(f).not.toHaveProperty("dropOff");
    expect(JSON.stringify(f)).not.toContain("Tell me about your work.");
    // finished on a recruiter's call: the candidate never sent anything, so it is not timed
    const byCall = screeningFunnel([...rows, { status: "completed", invitedVia: "apply", startedAt: at(0), completedAt: at(50), progress: progress({ completedBy: "recruiter_call" }), transcript: said(0) }], questions);
    expect(byCall).toMatchObject({ finished: 3, medianMinutes: 9 });
  });
});

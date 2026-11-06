import { describe, expect, it } from "vitest";
import { CANDIDATE_SCORE_OTHER_LABEL, ChatPlan, CompanyQuestions, DraftRolePacket, RolePacket, ScreenProgress, ScreenWriteup, candidateScoreShown, packetVisibility, type EligibilityRule, type MatchScore, type ScreeningQuestion } from "@ros/contracts";
import { answerSentence, applicationAnswerSentences } from "./answer-sentences";
import { chatCounter, quickQuestionsOf, writtenQuestionsOf } from "./apply-questions";
import { candidateScoreView } from "./candidate-score";
import { matchScore } from "./match-score";
import { teamScreenView, withoutCandidateWords } from "./screen-answers";

/**
 * Wave S7, S7-0: the contracts the seven slices build to (scratchpad kanvis-2/s7-contracts.md), read back. Nothing
 * here changes what any page does today; these pin the shapes and the readers every slice shares.
 */
const licence: EligibilityRule = { key: "rdh_license", type: "license", question: "Do you hold an active CA RDH license?", expectation: { license: "RDH" }, rationale: "Required by law.", knockout: true };
const days: EligibilityRule = { key: "schedule", type: "schedule_availability", question: "Which days can you work?", expectation: { days: ["Sat"] }, rationale: "Saturday cover.", knockout: true };
const screening: ScreeningQuestion[] = [
  { key: "hard_moment", question: "Tell me about a hard moment with a patient.", kind: "behavioral" },
  { key: "pay", question: "What pay range are you looking for?", kind: "compensation" },
];
const questions = CompanyQuestions.parse({
  quick: [
    { kind: "choice", key: "cq_transport", question: "How will you get to work?", options: ["Own car", "Public transport", "Other"] },
    { kind: "number", key: "cq_years", question: "How many years have you worked as a hygienist?", unit: "years", required: false, min: 0 },
  ],
  written: [{ key: "wq_explain", question: "How do you explain a treatment plan to a nervous patient?", lookFor: "PRIVATE: plain words, checks understanding" }],
});

describe("the company's questions on the packet", () => {
  it("are optional on a saved job, never part of the draft the model writes, and keyed apart from every other key", () => {
    expect(RolePacket.shape.companyQuestions.safeParse(undefined).success).toBe(true);
    expect("companyQuestions" in DraftRolePacket.shape).toBe(false);
    expect(questions.quick.map((q) => q.required)).toEqual([true, false]);
    expect(questions.written[0].required).toBe(true);
    expect(CompanyQuestions.parse({})).toEqual({ quick: [], written: [] });
    expect(CompanyQuestions.safeParse({ quick: [{ kind: "choice", key: "transport", question: "How will you get here?", options: ["Car", "Bus"] }] }).success).toBe(false);
    expect(CompanyQuestions.safeParse({ written: [{ key: "cq_wrong_kind", question: "Tell us about it." }] }).success).toBe(false);
    expect(CompanyQuestions.safeParse({ quick: [{ kind: "choice", key: "cq_one", question: "Only one way?", options: ["Yes"] }] }).success).toBe(false);
  });

  it("are asked of candidates, and what a good written answer shows stays with the team", () => {
    expect(packetVisibility("companyQuestions.quick[0].question")).toBe("asked");
    expect(packetVisibility("companyQuestions.written[0].question")).toBe("asked");
    expect(packetVisibility("companyQuestions.written[0].lookFor")).toBe("reviewed");
  });

  it("'Questions from <Company>': the eligibility questions first, as the form asks them today, then the quick ones", () => {
    const view = quickQuestionsOf({ requirements: { eligibility: [licence, days] }, companyQuestions: questions });
    expect(view.map((q) => [q.source, q.key, q.field, q.kind, q.required])).toEqual([
      ["eligibility", "rdh_license", "elig_rdh_license", "yes_no", true],
      ["eligibility", "schedule", "elig_schedule", "days", false],
      ["company", "cq_transport", "q_cq_transport", "choice", true],
      ["company", "cq_years", "q_cq_years", "number", false],
    ]);
    expect(view[0].options).toEqual(["Yes", "No"]);
    expect(view[1].options).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(view[2].options).toEqual(["Own car", "Public transport", "Other"]);
    expect(view[3]).toMatchObject({ unit: "years", min: 0, max: null });
    // a job from before Wave S7 asks only its eligibility questions
    expect(quickQuestionsOf({ requirements: { eligibility: [licence] } }).map((q) => q.key)).toEqual(["rdh_license"]);
  });

  it("the written questions: the company's own when it set any, never with what it looks for; otherwise the screening questions under their keys", () => {
    const own = writtenQuestionsOf({ screening: { questions: screening }, companyQuestions: questions });
    expect(own).toEqual([{ key: "wq_explain", question: "How do you explain a treatment plan to a nervous patient?", required: true, source: "company" }]);
    expect(JSON.stringify(own)).not.toContain("PRIVATE");
    expect(writtenQuestionsOf({ screening: { questions: screening } })).toEqual([
      { key: "hard_moment", question: "Tell me about a hard moment with a patient.", required: true, source: "screening" },
      { key: "pay", question: "What pay range are you looking for?", required: true, source: "screening" },
    ]);
    expect(writtenQuestionsOf({ screening: { questions: screening }, companyQuestions: { quick: [], written: [] } }).map((q) => q.source)).toEqual(["screening", "screening"]);
  });
});

describe("the form's answers as plain sentences", () => {
  it("the question as asked and the answer given, for every answered question in the form's order; nothing for one left empty", () => {
    const packet = { requirements: { eligibility: [licence, days] }, companyQuestions: questions };
    expect(applicationAnswerSentences(packet, { eligibility: { rdh_license: "yes", schedule: ["Sat", "Sun"] }, quick: { cq_transport: "Own car", cq_years: "6" } })).toEqual([
      { key: "rdh_license", source: "eligibility", sentence: "Do you hold an active CA RDH license? Yes." },
      { key: "schedule", source: "eligibility", sentence: "Which days can you work? Sat, Sun." },
      { key: "cq_transport", source: "company", sentence: "How will you get to work? Own car." },
      { key: "cq_years", source: "company", sentence: "How many years have you worked as a hygienist? 6 years." },
    ]);
    expect(applicationAnswerSentences(packet, { eligibility: { rdh_license: "no", schedule: [] } })).toEqual([{ key: "rdh_license", source: "eligibility", sentence: "Do you hold an active CA RDH license? No." }]);
    expect(applicationAnswerSentences(packet, null)).toEqual([]);
    expect(answerSentence("Licence number", "RDH 12345")).toBe("Licence number: RDH 12345.");
  });
});

describe("the chat's counter", () => {
  const plan = (states: Array<["gap" | "written", boolean, "open" | "asking" | "covered" | "unknown" | "skipped"]>, section: "experience" | "required" | "wrapping_up" = "required") =>
    ChatPlan.parse({ v: 1, section, builtAt: "2026-10-15T10:00:00.000Z", items: states.map(([kind, required, state], i) => ({ key: `k${i}`, kind, required, state })) });

  it("counts the required written questions closed, never the gaps, and names the section", () => {
    expect(chatCounter(null)).toBeNull();
    expect(chatCounter(undefined)).toBeNull();
    const p = plan([["gap", false, "covered"], ["written", true, "covered"], ["written", true, "unknown"], ["written", true, "asking"], ["written", true, "open"], ["written", false, "covered"]]);
    expect(chatCounter(p)).toEqual({ done: 2, required: 4, section: "required", label: "2 of 4 required · Required questions" });
    expect(chatCounter(plan([["gap", false, "asking"]], "experience"))?.label).toBe("About your experience");
    expect(chatCounter(plan([["written", true, "skipped"]], "wrapping_up"))?.label).toBe("1 of 1 required · Wrapping up");
  });
});

describe("the write-up is the candidate's words: hidden until Send, erased with them", () => {
  const writeup = ScreenWriteup.parse({ v: 1, writtenAt: "2026-10-15T10:00:00.000Z", aiRunId: null, promptVersion: 1, answers: [{ questionKey: "wq_explain", answer: "I explain each step in plain words.", status: "answered", quotes: ["I explain each step"] }] });
  const progress = ScreenProgress.parse({ flow: "one_visit", chat: { v: 1, section: "wrapping_up", builtAt: "2026-10-15T10:00:00.000Z", items: [{ key: "wq_explain", kind: "written", required: true, state: "covered" }] }, writeup, focusQuestions: [{ key: "unknown_1", question: "Is your licence active?", answer: "Yes since 2019" }] });

  it("keeps the note apart from the answer and says who wrote it", () => {
    expect(writeup.answers[0]).toMatchObject({ note: null, by: "writeup" });
  });

  it("the team sees none of it before Send; an erasure removes it and the open questions' answers, and keeps the plan's keys", () => {
    const unsent = teamScreenView({ status: "in_progress", transcript: [], answers: {}, progress });
    expect(unsent.progress.writeup).toBeUndefined();
    expect(unsent.progress.chat).toBeUndefined();
    expect(teamScreenView({ status: "completed", transcript: [], answers: {}, progress }).progress.writeup).toEqual(writeup);
    const erased = withoutCandidateWords(progress);
    expect(erased.writeup).toBeUndefined();
    expect(erased.focusQuestions).toEqual([{ key: "unknown_1", question: "Is your licence active?" }]);
    expect(erased.chat).toEqual(progress.chat);
    // What was typed in the visit for the chat to name goes with the rest of their words.
    const typed = withoutCandidateWords(ScreenProgress.parse({ typedFacts: { cv: ["Hygienist at Smile Dental"], formAnswers: ["Licensed: yes."] } }));
    expect(typed.typedFacts).toBeUndefined();
    const plain = ScreenProgress.parse({});
    expect(withoutCandidateWords(plain)).toBe(plain);
  });
});

describe("the score a candidate sees", () => {
  const packet = { requirements: { mustHaves: [{ key: "licence", text: "An active CA RDH license", rationale: "PRIVATE-RATIONALE", evidencedBy: ["resume" as const] }, { key: "perio", text: "Periodontal charting", rationale: "r", evidencedBy: ["resume" as const] }, { key: "dentrix", text: "Dentrix", rationale: "r", evidencedBy: ["resume" as const] }], niceToHaves: [], eligibility: [] } };
  const score: MatchScore = {
    score: 72, band: "high", bandLabel: "High", fit: "potential", openPoints: 30,
    coverage: { known: 4, total: 5, words: "Based on 4 of 5 requirements" },
    breakdown: [
      { key: "perio", label: "Periodontal charting", mustHave: true, importance: null, weightPct: 31, pctMet: 50, pointsLost: 15, finding: "Partly shown", source: "resume", quote: "perio", unquoted: false },
      { key: "chairside", label: "PRIVATE SKILL NAME", mustHave: false, importance: "essential", weightPct: 23, pctMet: 50, pointsLost: 12, finding: "Partly shown", source: "screen", quote: "x", unquoted: false },
      { key: "licence", label: "An active CA RDH license", mustHave: true, importance: null, weightPct: 31, pctMet: 100, pointsLost: 0, finding: "Shown", source: "resume", quote: "RDH", unquoted: false },
      { key: "infection", label: "ANOTHER PRIVATE SKILL", mustHave: false, importance: "helpful", weightPct: 15, pctMet: 100, pointsLost: 0, finding: "Shown", source: "resume", quote: "y", unquoted: false },
    ],
    unknown: [{ key: "dentrix", label: "Dentrix", mustHave: true, importance: null, weightPct: 20, pointsLost: 20 }, { key: "teamwork", label: "PRIVATE UNKNOWN", mustHave: false, importance: "important", weightPct: 10, pointsLost: 10 }],
    fullMarks: 2, missingMustHave: [], capped: false, confidence: "medium", basedOn: "resume_and_screen", interview: "done", basis: "From the résumé and the AI interview", packetVersion: 1,
  };

  it("names only the job page's must-haves, in its order; folds every other requirement into one line; lists the must-haves not shown yet", () => {
    const view = candidateScoreView(score, packet)!;
    expect(view).toMatchObject({ score: 72, band: "high", bandLabel: "High", coverage: "Based on 4 of 5 requirements", basis: "From your résumé and your AI interview", capped: false, notYetShown: ["Dentrix"] });
    expect(view.rows).toEqual([
      { key: "licence", label: "An active CA RDH license", pctMet: 100, tone: "strong", words: "Shown" },
      { key: "perio", label: "Periodontal charting", pctMet: 50, tone: "partial", words: "Partly shown" },
    ]);
    // weighted as the score weighs them, what nothing showed at nothing: (50 x 23 + 100 x 15 + 0 x 10) / 48
    expect(view.other).toEqual({ key: "other", label: CANDIDATE_SCORE_OTHER_LABEL, pctMet: 55, tone: "partial", words: "55% shown" });
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE/);
  });

  it("is nothing without a number, and the folded line is left out only when the job has no other requirement", () => {
    expect(candidateScoreView(null, packet)).toBeNull();
    expect(candidateScoreView({ ...score, score: null, band: null, bandLabel: null }, packet)).toBeNull();
    const publicOnly = score.breakdown.filter((c) => c.mustHave);
    expect(candidateScoreView({ ...score, breakdown: publicOnly, unknown: score.unknown.filter((u) => u.mustHave) }, packet)?.other).toBeNull();
    // nothing shown of the rest yet: the line says so, rather than leaving the number unexplained
    expect(candidateScoreView({ ...score, breakdown: publicOnly }, packet)?.other).toEqual({ key: "other", label: CANDIDATE_SCORE_OTHER_LABEL, pctMet: 0, tone: "short", words: "0% shown" });
    expect(candidateScoreView({ ...score, breakdown: [{ ...score.breakdown[0], pctMet: 0, finding: "Not met" }] }, packet)?.rows[0].tone).toBe("short");
  });

  it("says whether their AI interview is in the number, in their words (R20-9); the number is the same either way", () => {
    for (const interview of ["being_scored", "not_done_yet", "not_done", "none"] as const) {
      const view = candidateScoreView({ ...score, interview }, packet)!;
      expect(view.basis, interview).toBe("From your résumé only");
      expect(view.score).toBe(72);
    }
  });

  it("counts what nothing showed at nothing in the folded line too, so the bars and the number agree (6 November 2026)", () => {
    const role = { ...packet, competencies: [["chairside", 5], ["infection", 1], ["teamwork", 3]].map(([key, weight]) => ({ key, name: `PRIVATE ${key}`, definition: "d", weight, evaluatedIn: "both", indicators: ["x"] })) } as never;
    const quoted = (quote: string) => ({ source: "resume" as const, quote });
    const m = matchScore({ resume: { kind: "triage", result: { requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: quoted("RDH") }, { requirementKey: "perio", met: "partially", evidence: quoted("some") }], competencyFindings: [{ competencyKey: "chairside", finding: "partially_evidenced", evidence: quoted("assisted") }, { competencyKey: "infection", finding: "evidenced", evidence: quoted("sterile") }] } }, screen: null }, role)!;
    // licence 4, perio 2 of 4, dentrix 0 of 4, chairside 1.5 of 3, teamwork 0 of 2, infection 1: 8.5 of 18
    expect(m.score).toBe(47);
    const view = candidateScoreView(m, role)!;
    expect(view.rows).toEqual([
      { key: "licence", label: "An active CA RDH license", pctMet: 100, tone: "strong", words: "Shown" },
      { key: "perio", label: "Periodontal charting", pctMet: 50, tone: "partial", words: "Partly shown" },
    ]);
    expect(view.notYetShown).toEqual(["Dentrix"]);
    // (50 x 17 + 100 x 6 + 0 x 11) / 34: never 100% beside a low number
    expect(view.other).toMatchObject({ pctMet: 43, tone: "partial" });
    // every bar weighted as the score weighs it, the must-have not shown at nothing, adds up to the number
    const shareOf = (key: string) => m.breakdown.find((c) => c.key === key)?.weightPct ?? 0;
    const fromBars = (view.rows.reduce((n, r) => n + r.pctMet * shareOf(r.key), 0) + view.other!.pctMet * 34) / 100;
    expect(Math.abs(fromBars - m.score!)).toBeLessThan(2);
  });

  it("is shown unless ITS turned it off for the company", () => {
    expect(candidateScoreShown({})).toBe(true);
    expect(candidateScoreShown(null)).toBe(true);
    expect(candidateScoreShown({ candidateScoreShown: true })).toBe(true);
    expect(candidateScoreShown({ candidateScoreShown: false })).toBe(false);
  });
});

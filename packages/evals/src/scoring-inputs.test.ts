import { describe, expect, it } from "vitest";
import { SCORING_PLACEHOLDER } from "@ros/agents";
import type { ScreenContext } from "@ros/ai";
// The packet tool tests' complete, valid packet (not exported by @ros/agents): read by path, as suites.ts reads core.
import { samplePacket } from "../../agents/src/fixtures/sample-packet";
import { leakedDetails, lostEvidence, modelInputDifference, scorecardModelInput, triageModelInput, type EvalApplication } from "./scoring-inputs";
import { EARLIER_REJECTION, SCREEN_CANDIDATE, biasPairs, redactionCases, screenRedactionCases } from "./suites";

/**
 * What the evals send the scoring readings (founder decision D-04 = C), checked without any model: the inputs are built
 * by the app's own `scoringInput` and `scorecardInput`, so these hold for every provider, the real models included.
 */
const packet = samplePacket();
const application = (over: Partial<EvalApplication>): EvalApplication => ({
  packet,
  extraction: null,
  resumeText: null,
  applicationAnswers: { eligibility: { rdh_license: "yes", schedule: "yes" } },
  eligibility: { evaluatedAt: "2026-10-14T09:00:00.000Z", passed: true, failedRules: [], unverifiable: [] },
  identity: {},
  ...over,
});
const pair = (id: string) => biasPairs.find((p) => p.id === id)!;

describe("triage.redaction: the CV reading is sent none of the personal details", () => {
  for (const c of redactionCases) {
    it(c.id, () => {
      const { text, messages } = triageModelInput(application({ resumeText: c.resumeText, applicationAnswers: { eligibility: { rdh_license: "yes", schedule: "yes" }, ...(c.noResumeSummary ? { noResumeSummary: c.noResumeSummary } : {}) }, identity: c.candidate, earlierApplications: c.earlier ?? [] }));
      expect(leakedDetails(text, c.personal)).toEqual([]);
      expect(lostEvidence(messages, c.kept)).toEqual([]);
      expect(text).toContain(SCORING_PLACEHOLDER.name);
    });
  }
});

describe("triage.bias_pairs: a cue the reading never sees gives the very same input", () => {
  it("an earlier rejection at the same company is never sent, so both sides send the same input", () => {
    const p = pair("earlier_rejection");
    expect(p.a).toBe(p.b);
    expect(p.earlier?.[1]).toContain(EARLIER_REJECTION);
    const a = triageModelInput(application({ resumeText: p.a, identity: p.candidates[0], earlierApplications: p.earlier?.[0] }));
    const b = triageModelInput(application({ resumeText: p.b, identity: p.candidates[1], earlierApplications: p.earlier?.[1] }));
    expect(modelInputDifference(a.text, b.text)).toEqual([]);
    expect(b.promptInput).not.toHaveProperty("earlierApplications");
    expect(b.promptInput).not.toHaveProperty("priorApplications");
    expect(leakedDetails(b.text, ["March 2025", EARLIER_REJECTION.note!, "not_moving_forward"])).toEqual([]);
  });

  it("two names are hidden alike, so the candidate's texts read the same", () => {
    const p = pair("name");
    expect(p.sameModelInput).toBe(true);
    const a = triageModelInput(application({ resumeText: p.a, identity: p.candidates[0] }));
    const b = triageModelInput(application({ resumeText: p.b, identity: p.candidates[1] }));
    expect(modelInputDifference(a.text, b.text)).toEqual([]);
    expect(leakedDetails(a.text + b.text, ["Emily", "Walsh", "Lakisha"])).toEqual([]);
  });

  it("a cue the job may be read on (a graduation year) still reaches the model, and the difference is named", () => {
    const p = pair("graduation_year");
    const a = triageModelInput(application({ resumeText: p.a, identity: p.candidates[0] }));
    const b = triageModelInput(application({ resumeText: p.b, identity: p.candidates[1] }));
    const diff = modelInputDifference(a.text, b.text);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatch(/^the model was sent different inputs: ".*1988.*" vs ".*2013.*"$/);
  });
});

describe("screen.redaction: the scorecard is sent none of the personal details", () => {
  for (const c of screenRedactionCases) {
    it(c.id, () => {
      const input = c.build(packet);
      const ctx: ScreenContext = { company: { name: "Eval Dental" }, packet, candidate: { firstName: c.candidate.firstName ?? "there" }, channel: "web", progress: input.progress, answers: input.answers, transcript: input.transcript, focusUnknowns: [], latestCandidateMessage: null, incomplete: null };
      const { ctx: seen, text, messages } = scorecardModelInput(ctx, c.candidate);
      expect(seen.candidate.firstName).toBe(SCORING_PLACEHOLDER.name);
      expect(leakedDetails(text, c.personal)).toEqual([]);
      expect(lostEvidence(messages, c.kept)).toEqual([]);
    });
  }

  it("the screen.assess cases are sent no first name either", () => {
    const ctx: ScreenContext = { company: { name: "Eval Dental" }, packet, candidate: { firstName: SCREEN_CANDIDATE.firstName! }, channel: "web", progress: { askedKeys: [], currentQuestionKey: null, followUps: {}, confusedTurns: 0, failures: 0 }, answers: {}, transcript: [], focusUnknowns: [], latestCandidateMessage: null, incomplete: null };
    expect(leakedDetails(scorecardModelInput(ctx, SCREEN_CANDIDATE).text, [SCREEN_CANDIDATE.firstName!])).toEqual([]);
  });
});

describe("the checks themselves", () => {
  it("find a phone number whatever its separators, and a name only as a whole word", () => {
    expect(leakedDetails("call 949.555.0142 today", ["(949) 555-0142"])).toEqual(['the model was sent "(949) 555-0142"']);
    expect(leakedDetails("Marisolino and [name]", ["Marisol"])).toEqual([]);
    expect(leakedDetails("Hi MARISOL", ["Marisol"])).toHaveLength(1);
  });

  it("name the evidence that went missing", () => {
    expect(lostEvidence("RDH license CA   active", ["RDH license CA active", "Harbor Dental"])).toEqual(['the model was not sent "Harbor Dental", which the job is judged on']);
  });
});

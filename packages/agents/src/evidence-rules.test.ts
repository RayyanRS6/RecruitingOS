import { describe, expect, it } from "vitest";
import { FakeProvider, callPrompt, screenAssessPrompt, triageAssessPrompt } from "@ros/ai";
import type { EvidenceAssessment, ScreenAssessment } from "@ros/contracts";
import { registerFakeHandlers } from "./fake-handlers";
import { verifyScreenQuotes } from "./screening";
import { applyEvidenceRules, stepDownConfidence, verifyAssessmentQuotes } from "./triage";

/**
 * Evidence honesty (plan 0.9): what the owner sees has passed the code-side rules, whatever the model said. A quote not
 * in the source is dropped or stripped, a must-have "no" stands only on a verified quote, a claim about the candidate
 * with nothing quoted is marked "no quote", and the confidence steps down one level when any of that happens.
 */
const RESUME = "Dana Kim, RDH\nRegistered Dental Hygienist at Harbor Dental 2021 - present\nRDH license CA expired 2019\nPeriodontal charting, scaling and root planing, Dentrix";

const reading = (over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
  overall: "potential",
  confidence: "high",
  summary: "Two years of hygiene work; the license needs checking.",
  strengths: [],
  concerns: [],
  unknowns: [],
  competencyFindings: [],
  requirementFindings: [],
  anomalies: [],
  recommendation: "screen",
  rationale: "Relevant work; a screen will settle the license.",
  ...over,
});

describe("the evidence rules on a résumé reading", () => {
  it("drops a strength that quotes text not in the résumé and steps the confidence down, saying why", () => {
    const out = verifyAssessmentQuotes(reading({ strengths: [{ claim: "Ten years of perio", evidence: { source: "resume", quote: "ten years of periodontal therapy" } }, { claim: "Charts in Dentrix", evidence: { source: "resume", quote: "Periodontal charting, scaling and root planing, Dentrix" } }] }), { resume: RESUME });
    expect(out.strengths.map((s) => s.claim)).toEqual(["Charts in Dentrix"]);
    expect(out.confidence).toBe("medium");
    expect(out.anomalies.map((a) => a.kind)).toEqual(["unverified_quote"]);
    expect(out.confidenceReasons?.at(-1)).toMatch(/one claim quoted text that is not in the source and was dropped/);
  });

  it("keeps a claim about the candidate with nothing quoted, marked as such, and leaves the confidence alone", () => {
    const out = verifyAssessmentQuotes(reading({ concerns: [{ claim: "No evidence of a current license", evidence: { source: "resume" } }], strengths: [{ claim: "Market rate for the area", evidence: { source: "benchmark" } }] }), { resume: RESUME });
    expect(out.concerns[0].evidence).toMatchObject({ source: "resume", unquoted: true });
    // a benchmark is not about the candidate: nothing to quote, nothing to mark
    expect(out.strengths[0].evidence.unquoted).toBeUndefined();
    expect(out.confidence).toBe("high");
    expect(out.anomalies).toEqual([]);
  });

  it("never trusts the model's own 'unquoted' mark: a verified quote clears it", () => {
    const out = verifyAssessmentQuotes(reading({ strengths: [{ claim: "Works at Harbor Dental", evidence: { source: "resume", quote: "Registered Dental Hygienist at Harbor Dental", unquoted: true } }] }), { resume: RESUME });
    expect(out.strengths[0].evidence.unquoted).toBeUndefined();
    expect(out.strengths[0].evidence.quote).toBe("Registered Dental Hygienist at Harbor Dental");
  });

  it("turns a must-have 'no' with nothing quoted into 'unknown', and steps the confidence down", () => {
    const out = verifyAssessmentQuotes(reading({ requirementFindings: [{ requirementKey: "mh_1_license", met: "no" }, { requirementKey: "mh_2_perio", met: "no", evidence: { source: "resume" } }] }), { resume: RESUME });
    expect(out.requirementFindings.map((r) => r.met)).toEqual(["unknown", "unknown"]);
    expect(out.requirementFindings[1].evidence).toMatchObject({ source: "resume", unquoted: true });
    expect(out.confidence).toBe("medium");
    expect(out.confidenceReasons?.at(-1)).toMatch(/2 must-haves were marked not met with nothing quoted to show it/);
    // nothing was discarded, so no anomaly is recorded
    expect(out.anomalies).toEqual([]);
  });

  it("keeps a must-have 'no' that a verified quote shows", () => {
    const out = verifyAssessmentQuotes(reading({ requirementFindings: [{ requirementKey: "mh_1_license", met: "no", evidence: { source: "resume", quote: "RDH license CA expired 2019" } }] }), { resume: RESUME });
    expect(out.requirementFindings[0]).toMatchObject({ met: "no", evidence: { quote: "RDH license CA expired 2019" } });
    expect(out.confidence).toBe("high");
  });

  it("strips a must-have quote that is not in the résumé: 'yes' becomes 'partially', 'no' becomes 'unknown', each marked 'no quote'", () => {
    const out = verifyAssessmentQuotes(reading({
      requirementFindings: [
        { requirementKey: "mh_1_license", met: "yes", evidence: { source: "resume", quote: "RDH license CA active" } },
        { requirementKey: "mh_2_perio", met: "no", evidence: { source: "resume", quote: "never did perio" } },
        { requirementKey: "mh_3_xray", met: "partially", evidence: { source: "resume", quote: "radiography certificate" } },
      ],
    }), { resume: RESUME });
    expect(out.requirementFindings.map((r) => r.met)).toEqual(["partially", "unknown", "partially"]);
    for (const r of out.requirementFindings) expect(r.evidence).toEqual({ source: "resume", unquoted: true });
    expect(out.confidence).toBe("medium");
    expect(out.anomalies[0].detail).toMatch(/3 claims cited text that is not in the source/);
  });

  it("downgrades a competency whose quote is not in the résumé and notes why", () => {
    const out = verifyAssessmentQuotes(reading({ competencyFindings: [{ competencyKey: "patient_care", finding: "evidenced", evidence: { source: "resume", quote: "calmed anxious patients daily" } }] }), { resume: RESUME });
    expect(out.competencyFindings[0]).toMatchObject({ finding: "partially_evidenced", evidence: { source: "resume", unquoted: true } });
    expect(out.competencyFindings[0].note).toMatch(/could not be verified/);
  });

  it("treats a quote from a screen or an interview in a résumé reading as unverified: there is no such text to check it against", () => {
    const out = verifyAssessmentQuotes(reading({ strengths: [{ claim: "Said she loves perio", evidence: { source: "screen", quote: "I love perio" } }] }), { resume: RESUME });
    expect(out.strengths).toEqual([]);
  });

  it("steps down one level at a time and never below low", () => {
    expect(stepDownConfidence("high")).toBe("medium");
    expect(stepDownConfidence("medium")).toBe("low");
    expect(stepDownConfidence("low")).toBe("low");
    const out = applyEvidenceRules(reading({ confidence: "low", requirementFindings: [{ requirementKey: "mh_1_license", met: "no" }] }), () => true);
    expect(out.confidence).toBe("low");
  });

  it("keeps at most six confidence reasons, the newest last", () => {
    const out = applyEvidenceRules(reading({ confidenceReasons: ["a", "b", "c", "d", "e", "f"], requirementFindings: [{ requirementKey: "mh_1_license", met: "no" }] }), () => true);
    expect(out.confidenceReasons).toHaveLength(6);
    expect(out.confidenceReasons?.at(-1)).toMatch(/treated as unknown/);
  });
});

describe("the evidence rules on a screen scorecard", () => {
  const TRANSCRIPT = "Yes, my RDH license is active in California.\nI see nine patients a day and chart in Dentrix.";
  const scorecard = (over: Partial<ScreenAssessment> = {}): ScreenAssessment => ({
    overall: "potential",
    confidence: "high",
    summary: "Answered everything.",
    strengths: [],
    concerns: [],
    unknowns: [],
    competencyFindings: [],
    requirementFindings: [],
    anomalies: [],
    questionFindings: [],
    compensationExpectation: { withinRange: "unknown" },
    availability: { matchesSchedule: "unknown" },
    eligibilityConfirmations: [],
    recommendation: "interview",
    rationale: "Good answers.",
    ...over,
  });

  it("checks must-have findings against the candidate's own words", () => {
    const out = verifyScreenQuotes(scorecard({
      requirementFindings: [
        { requirementKey: "mh_1_license", met: "yes", evidence: { source: "screen", quote: "my RDH license is active in California" } },
        { requirementKey: "mh_2_perio", met: "no", evidence: { source: "screen", quote: "I have never done perio" } },
      ],
    }), TRANSCRIPT);
    expect(out.requirementFindings.map((r) => r.met)).toEqual(["yes", "unknown"]);
    expect(out.requirementFindings[1].evidence).toEqual({ source: "screen", unquoted: true });
    expect(out.confidence).toBe("medium");
  });

  it("strips an answer quote that is not in the transcript and records it, without touching the answer itself", () => {
    const out = verifyScreenQuotes(scorecard({ questionFindings: [{ questionKey: "q1", answered: true, finding: "Sees nine patients a day", evidence: { source: "screen", quote: "I see twelve patients" }, meetsModelAnswer: "yes" }] }), TRANSCRIPT);
    expect(out.questionFindings[0]).toMatchObject({ answered: true, finding: "Sees nine patients a day", evidence: undefined });
    expect(out.anomalies.map((a) => a.detail)).toEqual(["1 answer quote not found in the transcript; discarded"]);
  });
});

describe("no number from the model", () => {
  it("the triage and screen prompts ask for none, and a number the model adds anyway is not kept", async () => {
    const fake = new FakeProvider();
    registerFakeHandlers(fake);
    const rt = { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" } };
    expect(triageAssessPrompt.version).toBe(2);
    expect(screenAssessPrompt.version).toBe(2);
    const packet = { identity: { title: "Registered Dental Hygienist", employmentType: "full_time", locations: [{ city: "Irvine", region: "CA" }] }, requirements: { mustHaves: [], niceToHaves: [] }, competencies: [], evaluation: { criteria: [], redFlags: [] }, compensation: { basis: "hourly", min: 45, max: 55, currency: "USD" } };
    const input = { packet: packet as never, extraction: null, resumeText: RESUME, applicationAnswers: { eligibility: {} }, eligibility: null, priorApplications: [] };
    expect(triageAssessPrompt.system(input).map((b) => b.text).join("\n")).not.toMatch(/secondaryScore|0 to 100/);
    fake.scriptNext("triage.assess", { ...reading(), secondaryScore: 87 });
    const scripted = await callPrompt(rt, triageAssessPrompt, input, { companyId: null });
    expect(scripted.result.kind).toBe("ok");
    if (scripted.result.kind === "ok") expect(scripted.result.output).not.toHaveProperty("secondaryScore");
    // the fake stand-in gives none either
    const own = await callPrompt(rt, triageAssessPrompt, input, { companyId: null });
    if (own.result.kind !== "ok") throw new Error(`expected a reading: ${own.result.kind}`);
    expect(own.result.output).not.toHaveProperty("secondaryScore");
  });
});

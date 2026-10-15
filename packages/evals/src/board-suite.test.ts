import { describe, expect, it } from "vitest";
import type { EvidenceAssessment } from "@ros/contracts";
import { BOARD_PACKET, CONSISTENCY_READS, KEPT_IN_ANSWER, biasPairDifferences, biasPairs, boardCaseFailures, boardCases, consistencyCases, consistencyDifferences, credentialCases, credentialFailures, interviewSkillFailures, keptInInputFailures, withInterviewSkill } from "./suites";

/**
 * The parts of the eval suites that call no model (docs/11): the board's determinism cases, the bias-pair check reading
 * the match score, and the consistency check over repeated readings. They run with the unit tests; the model suites run
 * with `pnpm eval`.
 */
describe("board.determinism", () => {
  for (const c of boardCases) {
    it(c.id, () => {
      expect(boardCaseFailures(c)).toEqual([]);
    });
  }
});

describe("triage.bias_pairs reads the match score", () => {
  const reading = (licence: "yes" | "partially"): EvidenceAssessment => ({
    overall: "strong", confidence: "high", summary: "Experienced hygienist.", strengths: [], concerns: [], unknowns: [],
    competencyFindings: [{ competencyKey: "chairside", finding: "evidenced", evidence: { source: "resume", quote: "Chairside assisting" } }],
    requirementFindings: [{ requirementKey: "rdh_license", met: licence, evidence: { source: "resume", quote: "RDH license CA active" } }, { requirementKey: "perio", met: "yes", evidence: { source: "resume", quote: "Periodontal charting" } }],
    anomalies: [], recommendation: "screen", rationale: "r",
  });
  const pair = biasPairs[0];

  it("passes a pair that reads and scores the same", () => {
    expect(biasPairDifferences(pair, reading("yes"), reading("yes"), BOARD_PACKET)).toEqual([]);
  });

  it("names a pair whose score moved with the cue, as well as the finding behind it", () => {
    const f = biasPairDifferences(pair, reading("yes"), reading("partially"), BOARD_PACKET);
    expect(f).toContain("must-have findings differ: perio:yes, rdh_license:yes vs perio:yes, rdh_license:partially");
    expect(f.some((x) => /^match score differs: 100 vs \d+$/.test(x))).toBe(true);
  });

  it("still compares the readings alone when no packet is given", () => {
    expect(biasPairDifferences(pair, reading("yes"), reading("partially")).some((x) => x.startsWith("match score"))).toBe(false);
  });
});

describe("triage.consistency compares repeated readings of one résumé", () => {
  const reading = (licence: "yes" | "partially", overall: EvidenceAssessment["overall"] = "strong"): EvidenceAssessment => ({
    overall, confidence: "high", summary: "Experienced hygienist.", strengths: [], concerns: [], unknowns: [],
    competencyFindings: [{ competencyKey: "chairside", finding: "evidenced", evidence: { source: "resume", quote: "Chairside assisting" } }],
    requirementFindings: [{ requirementKey: "rdh_license", met: licence, evidence: { source: "resume", quote: "RDH license CA active" } }, { requirementKey: "perio", met: "yes", evidence: { source: "resume", quote: "Periodontal charting" } }],
    anomalies: [], recommendation: "screen", rationale: "r",
  });

  it("passes readings that agree every time", () => {
    expect(consistencyDifferences([reading("yes"), reading("yes"), reading("yes")], BOARD_PACKET)).toEqual([]);
    expect(CONSISTENCY_READS).toBeGreaterThanOrEqual(3);
    expect(consistencyCases.length).toBeGreaterThanOrEqual(3);
  });

  it("names a reading whose findings, score or column moved, against the first", () => {
    const f = consistencyDifferences([reading("yes"), reading("yes"), reading("partially", "potential")], BOARD_PACKET);
    expect(f).toContain("reading 3: overall potential, reading 1: strong");
    expect(f).toContain("reading 3: must-have findings perio:yes, rdh_license:partially, reading 1: perio:yes, rdh_license:yes");
    expect(f.some((x) => x.startsWith("reading 3: match score"))).toBe(true);
    expect(consistencyDifferences([], BOARD_PACKET)).toEqual(["no reading"]);
  });
});

describe("the Wave S5 checks, with no model", () => {
  const reading = (licence: EvidenceAssessment["requirementFindings"][number]["met"], skills: string[] = ["chairside"]): EvidenceAssessment => ({
    overall: "potential", confidence: "medium", summary: "s", strengths: [], concerns: [], unknowns: [],
    competencyFindings: skills.map((competencyKey) => ({ competencyKey, finding: "evidenced" as const, evidence: { source: "resume" as const, quote: "Chairside assisting daily" } })),
    requirementFindings: [{ requirementKey: "rdh_license", met: licence }], anomalies: [], recommendation: "screen", rationale: "r",
  });

  it("triage.credentials names a licence read other than the founder's rule says, and expects every kind of case", () => {
    const keys = new Set(["rdh_license"]);
    expect(credentialFailures(reading("unknown"), keys, "unknown")).toEqual([]);
    expect(credentialFailures(reading("no"), keys, "unknown")).toEqual(['rdh_license: read "no", expected "unknown"']);
    expect(credentialFailures(reading("no"), new Set(), "no")).toEqual(["the role has no licence must-have to read"]);
    expect(new Set(credentialCases.map((c) => c.expect))).toEqual(new Set(["unknown", "no", "yes"]));
    expect(credentialCases.find((c) => c.id === "lapsed")?.resume).toContain("RDH license CA expired in 2021; renewal not started");
  });

  it("triage.interview_skills names a skill for the interviews that was asked, read or scored", () => {
    const moved = withInterviewSkill(BOARD_PACKET as never);
    expect(moved.key).toBe("chairside");
    expect(interviewSkillFailures(moved.key, "Competencies: [patients] Patient care", reading("yes", ["patients"]), moved.packet)).toEqual([]);
    const f = interviewSkillFailures(moved.key, "Competencies: [chairside] Chairside skill", reading("yes", ["chairside"]), moved.packet);
    expect(f).toContain('the reading was asked about "chairside", a skill for the interviews');
    expect(f).toContain('the reading the team sees has a finding on "chairside"');
    expect(f.some((x) => x.startsWith("the match score"))).toBe(false);
  });

  it("triage.kept_in names an input that still holds the answer set aside, or never says a person kept them in", () => {
    expect(keptInInputFailures(`Eligibility answers: {"schedule":"yes"}\nEligibility result: passed (a person on the hiring team checked the eligibility answers and kept the candidate in; ...)`)).toEqual([]);
    expect(keptInInputFailures(`Eligibility answers: {"${KEPT_IN_ANSWER.key}":"${KEPT_IN_ANSWER.answer}"}\nEligibility result: failed ${KEPT_IN_ANSWER.key}`)).toEqual(["the model was sent the eligibility answer a person set aside", "the model was not told a person kept the candidate in", "the model was told the candidate failed eligibility"]);
  });
});

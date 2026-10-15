import { describe, expect, it } from "vitest";
import type { EvidenceAssessment } from "@ros/contracts";
import { BOARD_PACKET, CONSISTENCY_READS, KEPT_IN_ANSWER, biasPairDifferences, biasPairs, boardCaseFailures, boardCases, consistencyCases, consistencyDifferences, credentialCases, credentialFailures, fairnessRuleCases, formAnswers, interviewSkillFailures, keptInInputFailures, withInterviewSkill } from "./suites";

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
  const reading = (licence: "yes" | "partially" | "no"): EvidenceAssessment => ({
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
    const f = biasPairDifferences(pair, reading("yes"), reading("no"), BOARD_PACKET);
    expect(f).toContain("must-have findings differ: perio:yes, rdh_license:yes vs perio:yes, rdh_license:no");
    expect(f).toContain("match score differs: 100 vs 54");
    expect(f).toContain("missing must-haves differ: none vs rdh_license");
    // partly shown with everything else met costs nothing (Wave S7): the finding differs, the score does not
    const partly = biasPairDifferences(pair, reading("yes"), reading("partially"), BOARD_PACKET);
    expect(partly).toContain("must-have findings differ: perio:yes, rdh_license:yes vs perio:yes, rdh_license:partially");
    expect(partly.some((x) => x.startsWith("match score"))).toBe(false);
  });

  it("still compares the readings alone when no packet is given", () => {
    expect(biasPairDifferences(pair, reading("yes"), reading("partially")).some((x) => x.startsWith("match score"))).toBe(false);
  });
});

describe("triage.consistency compares repeated readings of one résumé", () => {
  const reading = (licence: "yes" | "partially" | "no", overall: EvidenceAssessment["overall"] = "strong"): EvidenceAssessment => ({
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
    const f = consistencyDifferences([reading("yes"), reading("yes"), reading("no", "weak")], BOARD_PACKET);
    expect(f).toContain("reading 3: overall weak, reading 1: strong");
    expect(f).toContain("reading 3: must-have findings perio:yes, rdh_license:no, reading 1: perio:yes, rdh_license:yes");
    expect(f.some((x) => x.startsWith("reading 3: match score"))).toBe(true);
    // a must-have partly shown moves the finding and the column (the board asks for more), never the score
    const partly = consistencyDifferences([reading("yes"), reading("partially")], BOARD_PACKET);
    expect(partly).toContain("reading 2: must-have findings perio:yes, rdh_license:partially, reading 1: perio:yes, rdh_license:yes");
    expect(partly.some((x) => x.startsWith("reading 2: match score"))).toBe(false);
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
    // Wave S7: the answers go as sentences, so the question of the answer set aside must not be there either
    const question = "Do you hold an active California RDH license?";
    const kept = "Their answers to the company's questions (their own words, one per line):\nAre you available for the posted schedule? Yes.\nEligibility result: passed (a person on the hiring team checked the eligibility answers and kept the candidate in)";
    expect(keptInInputFailures(kept, question)).toEqual([]);
    expect(keptInInputFailures(`${kept}\n${question} No.`, question)).toEqual(["the model was sent the eligibility answer a person set aside"]);
  });

  it("answers the role's own questions on the form, the licence one 'no' when a person kept them in", () => {
    const role = { requirements: { mustHaves: [], niceToHaves: [], eligibility: [{ key: "lic", type: "license", question: "Do you hold a CA RDH license?", expectation: {}, rationale: "law", knockout: true }, { key: "days", type: "schedule_availability", question: "Which days can you work?", expectation: { days: ["Sat"] }, rationale: "cover", knockout: true }] } } as never;
    expect(formAnswers(role, false)).toEqual({ answered: { lic: "yes", days: ["Sat"] }, setAside: { key: "lic", question: "Do you hold a CA RDH license?" } });
    expect(formAnswers(role, true).answered).toEqual({ lic: "no", days: ["Sat"] });
    expect(formAnswers({ requirements: { mustHaves: [], niceToHaves: [], eligibility: [] } } as never, true).answered).toEqual({ rdh_license: "no", schedule: "yes" });
  });
});

describe("triage.fairness_rules (Wave S7), with no model", () => {
  for (const c of fairnessRuleCases) {
    it(c.id, () => {
      expect(c.failures()).toEqual([]);
    });
  }
});

import { describe, expect, it } from "vitest";
import type { EvidenceAssessment } from "@ros/contracts";
import { BOARD_PACKET, CONSISTENCY_READS, biasPairDifferences, biasPairs, boardCaseFailures, boardCases, consistencyCases, consistencyDifferences } from "./suites";

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

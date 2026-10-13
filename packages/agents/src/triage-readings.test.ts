import { describe, expect, it } from "vitest";
import type { RunOutcome } from "@ros/ai";
import type { EvidenceAssessment } from "@ros/contracts";
import { applyEvidenceRules, combineOutcomes, combineReadings, shownNotHeld } from "./triage";

/**
 * The fairness run on Haiku 5.5 (14 Oct 2026): one résumé read three times scored 83, 71 and 67, and an expired licence
 * was "unknown" in two readings of three although each quoted "expired". Three readings and their middle answer, and the
 * licence rule in code, make the same application read and score the same each time.
 */
const RESUME = "Casey Morgan, RDH\nRegistered Dental Hygienist at Bayside Dental 2016 - 2021\nRDH license CA expired in 2021; renewal not started\nScaling and root planing, patient education";

type Met = EvidenceAssessment["requirementFindings"][number]["met"];
type Found = EvidenceAssessment["competencyFindings"][number]["finding"];

const reading = (licence: Met, perio: Met, chairside: Found, over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
  overall: "potential",
  confidence: "medium",
  summary: `licence ${licence}, perio ${perio}, chairside ${chairside}`,
  strengths: [],
  concerns: [],
  unknowns: [],
  competencyFindings: [{ competencyKey: "chairside", finding: chairside, evidence: { source: "resume", quote: "Scaling and root planing" } }],
  requirementFindings: [
    { requirementKey: "licence", met: licence, evidence: licence === "unknown" ? undefined : { source: "resume", quote: "RDH license CA expired in 2021" } },
    { requirementKey: "perio", met: perio, evidence: { source: "resume", quote: "Scaling and root planing" } },
  ],
  anomalies: [],
  recommendation: "screen",
  rationale: "r",
  ...over,
});

const metOf = (a: EvidenceAssessment, key: string) => a.requirementFindings.find((f) => f.requirementKey === key)?.met;

describe("three readings of the same application", () => {
  it("keep the middle answer of each finding, with the evidence of a reading that gave it", () => {
    const out = combineReadings([reading("no", "yes", "evidenced"), reading("no", "partially", "partially_evidenced"), reading("no", "yes", "evidenced")]);
    expect(metOf(out, "perio")).toBe("yes");
    expect(out.competencyFindings).toEqual([{ competencyKey: "chairside", finding: "evidenced", evidence: { source: "resume", quote: "Scaling and root planing" } }]);
    // all three different: the middle on the order no, unknown, partially, yes
    expect(metOf(combineReadings([reading("no", "yes", "evidenced"), reading("no", "unknown", "evidenced"), reading("no", "partially", "evidenced")]), "perio")).toBe("partially");
  });

  it("take the overall reading, recommendation and confidence most readings gave, and the words of the closest reading", () => {
    const out = combineReadings([
      reading("no", "yes", "evidenced", { overall: "strong", confidence: "high" }),
      reading("no", "partially", "partially_evidenced", { overall: "potential", recommendation: "hold" }),
      reading("no", "partially", "evidenced", { overall: "potential" }),
    ]);
    expect(out).toMatchObject({ overall: "potential", recommendation: "screen", confidence: "medium" });
    expect(metOf(out, "perio")).toBe("partially");
    expect(out.summary).toBe("licence no, perio partially, chairside evidenced");
  });

  it("read the same whatever order the readings come back in", () => {
    const a = reading("no", "yes", "evidenced");
    const b = reading("unknown", "partially", "partially_evidenced");
    const c = reading("no", "yes", "partially_evidenced");
    const finds = (x: EvidenceAssessment) => [x.requirementFindings.map((f) => f.met), x.competencyFindings.map((f) => f.finding)];
    expect(finds(combineReadings([a, b, c]))).toEqual(finds(combineReadings([c, a, b])));
    expect(finds(combineReadings([b, c, a]))).toEqual([["no", "yes"], ["partially_evidenced"]]);
  });

  it("use the first reading as it is when fewer than three came back, and the first failure when none did", () => {
    const sources = { resume: RESUME };
    const ok = (out: EvidenceAssessment, runId: string): RunOutcome<EvidenceAssessment> => ({ ok: true, output: out, runId, model: "m" });
    const failed: RunOutcome<EvidenceAssessment> = { ok: false, runId: "r9", model: "m", reason: "error", error: "provider error: 529" };
    const two = combineOutcomes([failed, ok(reading("no", "yes", "evidenced"), "r2"), ok(reading("no", "partially", "evidenced"), "r3")], sources);
    expect(two).toMatchObject({ ok: true, runId: "r2" });
    if (two.ok) expect(metOf(two.output, "perio")).toBe("yes");
    expect(combineOutcomes([failed, failed, failed], sources)).toBe(failed);
  });
});

describe("a licence the candidate's own words show is not held", () => {
  it("is recognised in expired, lapsed, inactive, revoked, suspended or not renewed, unless it is held again", () => {
    for (const q of ["RDH license CA expired in 2021; renewal not started", "License lapsed 2019", "RDH (inactive)", "License revoked", "BLS not renewed"]) expect(shownNotHeld(q), q).toBe(true);
    for (const q of ["RDH license CA active", "License lapsed in 2019, renewed in 2020", "Current RDH license", "RDH license valid through 2027", "Licence reinstated after it lapsed"]) expect(shownNotHeld(q), q).toBe(false);
  });

  it("is a must-have 'no' on a verified quote, whatever the reading wrote, but never on a recruiter's note", () => {
    const inResume = (e: { quote?: string; source: string }) => (e.source === "resume" ? RESUME.includes(e.quote ?? "") : null);
    const out = applyEvidenceRules(reading("unknown", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met: "unknown", evidence: { source: "resume", quote: "RDH license CA expired in 2021" } }] }), inResume);
    expect(metOf(out, "licence")).toBe("no");
    const fromNote = applyEvidenceRules(reading("unknown", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met: "partially", evidence: { source: "recruiter_note", quote: "said the licence expired" } }] }), () => true);
    expect(metOf(fromNote, "licence")).toBe("partially");
    // a quote that is not in the résumé proves nothing
    const invented = applyEvidenceRules(reading("unknown", "yes", "evidenced", { requirementFindings: [{ requirementKey: "licence", met: "yes", evidence: { source: "resume", quote: "license expired in 2010" } }] }), inResume);
    expect(metOf(invented, "licence")).toBe("partially");
  });
});

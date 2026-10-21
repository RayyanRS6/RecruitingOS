import { describe, expect, it } from "vitest";
import type { EvidenceAssessment, RolePacket, ScreenAssessment } from "@ros/contracts";
import { evidenceView, insufficientEvidence, lowConfidence, readingConsistency, type AssessmentLike } from "./evidence";

/**
 * The software check before any automatic step (plan A8) and the low-confidence flag. Pure functions over a stored
 * reading, so the workflows, the list and the candidate page always agree.
 */
const reading = (over: Partial<EvidenceAssessment> = {}): EvidenceAssessment => ({
  overall: "potential",
  confidence: "medium",
  confidenceReasons: [],
  summary: "Relevant hygiene work.",
  strengths: [],
  concerns: [],
  unknowns: [],
  competencyFindings: [],
  requirementFindings: [],
  anomalies: [],
  recommendation: "screen",
  rationale: "test",
  ...over,
});
const triage = (over: Partial<EvidenceAssessment> = {}): AssessmentLike => {
  const result = reading(over);
  return { kind: "triage", overall: result.overall, confidence: result.confidence, result };
};
const scorecard = (over: Partial<ScreenAssessment> = {}): AssessmentLike => {
  const { recommendation: _r, ...base } = reading();
  const result: ScreenAssessment = { ...base, questionFindings: [], compensationExpectation: { withinRange: "unknown" }, availability: { matchesSchedule: "unknown" }, eligibilityConfirmations: [], recommendation: "interview", ...over };
  return { kind: "screen", overall: result.overall, confidence: result.confidence, result };
};
const packet = { requirements: { mustHaves: [{ key: "rdh_license", text: "Active CA RDH license", rationale: "law", evidencedBy: ["resume"] }, { key: "perio", text: "Perio experience", rationale: "the work", evidencedBy: ["resume"] }] } } as unknown as Pick<RolePacket, "requirements">;
const provenMiss = { requirementKey: "rdh_license", met: "no" as const, evidence: { source: "resume" as const, quote: "RDH license expired in 2021" } };

describe("readingConsistency", () => {
  it("passes a reading that agrees with its own findings", () => {
    expect(readingConsistency(triage(), packet)).toEqual({ consistent: true, reason: null });
    expect(readingConsistency(triage({ overall: "strong", requirementFindings: [{ requirementKey: "rdh_license", met: "yes", evidence: { source: "resume", quote: "RDH license active" } }] }), packet).consistent).toBe(true);
    // a Weak reading with no step suggested is honest
    expect(readingConsistency(triage({ overall: "weak", recommendation: "hold" }), packet).consistent).toBe(true);
  });

  it("fails a Strong or Potential reading when a must-have is shown not met by a verified quote, and names it", () => {
    const r = readingConsistency(triage({ requirementFindings: [provenMiss] }), packet);
    expect(r.consistent).toBe(false);
    expect(r.reason).toBe('The AI review says Potential match, but the candidate\'s own words show a must-have is not met (Active CA RDH license): "RDH license expired in 2021". Read it yourself before anything else happens.');
    expect(readingConsistency(triage({ overall: "strong", requirementFindings: [provenMiss] })).reason).toContain('a must-have is not met: "RDH license expired in 2021"');
  });

  it("never counts a 'no' without a verified quote, nor a finding outside the role's must-haves", () => {
    expect(readingConsistency(triage({ requirementFindings: [{ requirementKey: "rdh_license", met: "no", evidence: { source: "resume", unquoted: true } }] }), packet).consistent).toBe(true);
    expect(readingConsistency(triage({ requirementFindings: [{ requirementKey: "rdh_license", met: "no" }] }), packet).consistent).toBe(true);
    expect(readingConsistency(triage({ requirementFindings: [{ ...provenMiss, requirementKey: "weekend_shifts" }] }), packet).consistent).toBe(true);
    expect(readingConsistency(triage({ requirementFindings: [{ ...provenMiss, met: "unknown" }] }), packet).consistent).toBe(true);
  });

  it("fails a step suggested for a Weak or Insufficient reading, after the résumé and after the screen", () => {
    expect(readingConsistency(triage({ overall: "weak", recommendation: "screen" }), packet).reason).toBe("The assistant suggested an AI interview, but its AI review says Weak match. Read it yourself before anything else happens.");
    expect(readingConsistency(triage({ overall: "unknown", recommendation: "screen" }), packet).reason).toContain("its AI review says Insufficient evidence");
    expect(readingConsistency(scorecard({ overall: "weak", recommendation: "strong_interview" }), packet).reason).toContain("suggested an interview, but its AI review says Weak match");
    expect(readingConsistency(scorecard({ overall: "potential", recommendation: "interview" }), packet).consistent).toBe(true);
    expect(readingConsistency(scorecard({ overall: "weak", recommendation: "hold" }), packet).consistent).toBe(true);
  });

  it("fails a Strong reading whose own words go against an Essential skill, with the role's skills only (plan F3)", () => {
    const skills = { ...packet, competencies: [{ key: "chairside", name: "Chairside skill", definition: "d", weight: 5, evaluatedIn: "both", indicators: ["x"] }, { key: "software", name: "Dental software", definition: "d", weight: 2, evaluatedIn: "both", indicators: ["x"] }] } as unknown as Pick<RolePacket, "requirements" | "competencies">;
    const against = (key: string, quote?: string) => triage({ overall: "strong", competencyFindings: [{ competencyKey: key, finding: "contradicted", ...(quote ? { evidence: { source: "resume" as const, quote } } : {}) }] });
    const r = readingConsistency(against("chairside", "I avoid chairside work"), skills);
    expect(r).toEqual({ consistent: false, reason: 'The AI review says Strong match, but the candidate\'s own words go against an essential skill (Chairside skill): "I avoid chairside work". Read it yourself before anything else happens.' });
    // a Helpful skill, nothing quoted, a Potential reading, or no skills given: consistent
    expect(readingConsistency(against("software", "I never used Dentrix"), skills).consistent).toBe(true);
    expect(readingConsistency(against("chairside"), skills).consistent).toBe(true);
    expect(readingConsistency({ ...against("chairside", "I avoid chairside work"), overall: "potential" }, skills).consistent).toBe(true);
    expect(readingConsistency(against("chairside", "I avoid chairside work"), packet).consistent).toBe(true);
    // the list's own check, given the packet the reading was made against, agrees with the workflow's
    expect(evidenceView({ stage: "triaged", latest: against("chairside", "I avoid chairside work"), resumeUnreadable: false, packet: skills })).toMatchObject({ needsCloserLook: true, inconsistent: true });
  });
});

describe("insufficientEvidence", () => {
  it("reads a résumé reading or a scorecard that says too little, each in its own words", () => {
    expect(insufficientEvidence(triage({ recommendation: "review_manually" }))).toBe(true);
    expect(insufficientEvidence(triage({ overall: "unknown" }))).toBe(true);
    expect(insufficientEvidence(triage())).toBe(false);
    expect(insufficientEvidence(scorecard({ overall: "unknown" }))).toBe(true);
    expect(insufficientEvidence(scorecard({ recommendation: "hold" }))).toBe(true);
    expect(insufficientEvidence(scorecard({ overall: "potential", recommendation: "interview" }))).toBe(false);
    expect(insufficientEvidence(null)).toBe(false);
  });
});

describe("evidenceView with the check and the low-confidence flag", () => {
  it("marks a held reading 'needs a closer look' with the reason, where the owner is waited on", () => {
    const view = evidenceView({ stage: "triaged", latest: triage({ requirementFindings: [provenMiss] }), resumeUnreadable: false });
    expect(view).toMatchObject({ needsCloserLook: true, inconsistent: true, lowConfidence: false });
    expect(view.reason).toContain('"RDH license expired in 2021"');
    // the scorecard is checked where it waits: at "screen complete"
    expect(evidenceView({ stage: "screen_complete", latest: scorecard({ overall: "weak", recommendation: "interview" }), resumeUnreadable: false })).toMatchObject({ needsCloserLook: true, inconsistent: true });
    // once someone moved on, the old reading no longer holds anything
    expect(evidenceView({ stage: "interview_recommended", latest: scorecard({ overall: "weak", recommendation: "interview" }), resumeUnreadable: false })).toMatchObject({ needsCloserLook: false, inconsistent: false });
  });

  it("keeps low confidence separate: it asks the reader to read it themselves and holds nothing", () => {
    const low = triage({ confidence: "low" });
    expect(lowConfidence(low)).toBe(true);
    expect(evidenceView({ stage: "triaged", latest: low, resumeUnreadable: false })).toMatchObject({ lowConfidence: true, needsCloserLook: false, inconsistent: false, reason: null });
    expect(evidenceView({ stage: "screen_invited", latest: low, resumeUnreadable: false }).lowConfidence).toBe(true);
    expect(lowConfidence(triage())).toBe(false);
    expect(lowConfidence(null)).toBe(false);
  });

  it("says when the latest reading proves a must-have missing (the list's 'Missing a must-have', plan A3), at any step, on a checked quote only", () => {
    expect(evidenceView({ stage: "triaged", latest: triage({ requirementFindings: [provenMiss] }), resumeUnreadable: false }).hasProvenMiss).toBe(true);
    // a Weak reading with a proven miss agrees with itself, so nothing is held, but the filter still catches it
    expect(evidenceView({ stage: "screen_invited", latest: triage({ overall: "weak", recommendation: "hold", requirementFindings: [provenMiss] }), resumeUnreadable: false })).toMatchObject({ hasProvenMiss: true, needsCloserLook: false });
    expect(evidenceView({ stage: "triaged", latest: triage({ requirementFindings: [{ requirementKey: "rdh_license", met: "no", evidence: { source: "resume", unquoted: true } }] }), resumeUnreadable: false }).hasProvenMiss).toBe(false);
    expect(evidenceView({ stage: "triaged", latest: triage(), resumeUnreadable: false }).hasProvenMiss).toBe(false);
    expect(evidenceView({ stage: "triaged", latest: null, resumeUnreadable: false }).hasProvenMiss).toBe(false);
  });
});

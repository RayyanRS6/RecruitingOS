import type { EvidenceAssessment, ScreenAssessment } from "@ros/contracts";

/**
 * "Insufficient evidence" as an explicit state (docs/spec/21 section 7, P1; docs/FOUNDER-CONTEXT.md, "What should count
 * as Insufficient Evidence?"). Nothing is stored for it: the state is read off the latest assessment wherever the owner
 * meets the application (the Talent list, the candidate page, the notification), so the three can never disagree.
 * An application needs a closer look while it waits for the owner ("Ready for your review") and the assistant could not
 * say enough: the recommendation is `review_manually`, the overall reading is "unknown", or there is no assessment at
 * all because the model's output was unusable twice.
 */
export const CLOSER_LOOK_LABEL = "Needs a closer look";
export const RESUME_UNREADABLE_TEXT = "The résumé could not be read; the written answers were used.";
export const ASSESSMENT_UNAVAILABLE_TEXT = "We could not assess this application automatically; please review it yourself.";

export type AssessmentLike = { kind: string; overall: string; result: EvidenceAssessment | ScreenAssessment };
export type EvidenceFinding = { claim: string; evidence: { source: string; quote?: string } };

export type EvidenceView = {
  needsCloserLook: boolean;
  /** Plain words for the owner: what is missing. Null when nothing needs a closer look. */
  reason: string | null;
  /** The assistant produced no usable assessment (invalid or refused twice); the owner reviews without one. */
  assessmentUnavailable: boolean;
  /** The résumé file was clean but had no text to read (a scan without a text layer); the written answers were used. */
  resumeUnreadable: boolean;
  /** The open questions from the latest assessment, in the words a screen would ask them. */
  unknowns: string[];
  unknownCount: number;
  topStrength: EvidenceFinding | null;
  topConcern: EvidenceFinding | null;
  /** What drives the confidence level, from the assessment (older assessments have none). */
  confidenceReasons: string[];
};

/** True when the assessment itself says the evidence was insufficient. Only the résumé assessment counts; a screen scorecard has its own vocabulary. */
export function insufficientEvidence(latest: AssessmentLike | null | undefined): boolean {
  if (!latest || latest.kind !== "triage") return false;
  const rec = (latest.result as { recommendation?: string }).recommendation;
  return rec === "review_manually" || latest.overall === "unknown";
}

export function evidenceView(input: { stage: string; latest: AssessmentLike | null | undefined; resumeUnreadable: boolean }): EvidenceView {
  const latest = input.latest ?? null;
  const waiting = input.stage === "triaged";
  // An application only reaches "triaged" through the assessment step: with an assessment, or by the branch that gave up on one.
  const assessmentUnavailable = waiting && !latest;
  const unknowns = latest?.result.unknowns.map((u) => u.question) ?? [];
  const needsCloserLook = waiting && (assessmentUnavailable || insufficientEvidence(latest));
  const parts: string[] = [];
  if (assessmentUnavailable) parts.push(ASSESSMENT_UNAVAILABLE_TEXT);
  if (needsCloserLook && input.resumeUnreadable) parts.push(RESUME_UNREADABLE_TEXT);
  if (needsCloserLook && latest) parts.push(unknowns.length ? `Open questions: ${unknowns.join(" ")}` : latest.result.summary);
  return {
    needsCloserLook,
    reason: parts.length ? parts.join(" ") : null,
    assessmentUnavailable,
    resumeUnreadable: input.resumeUnreadable,
    unknowns,
    unknownCount: unknowns.length,
    topStrength: latest?.result.strengths[0] ?? null,
    topConcern: latest?.result.concerns[0] ?? null,
    confidenceReasons: latest?.result.confidenceReasons ?? [],
  };
}

import { importanceOf, type EvidenceAssessment, type RolePacket, type ScreenAssessment } from "@ros/contracts";

/**
 * "Insufficient evidence" as an explicit state (docs/spec/21 section 7, P1; docs/FOUNDER-CONTEXT.md, "What should count
 * as Insufficient Evidence?"). Nothing is stored for it: the state is read off the latest assessment wherever the owner
 * meets the application (the Talent list, the candidate page, the notification), so the three can never disagree.
 * An application needs a closer look while it waits for the owner ("Ready for your review") and the assistant could not
 * say enough: the recommendation is `review_manually`, the overall reading is "unknown", or there is no assessment at
 * all because the model's output was unusable twice. It also needs one when the reading does not agree with its own
 * must-have findings (`readingConsistency`, plan A8): the assistant's step was held for a person.
 */
export const CLOSER_LOOK_LABEL = "Needs a closer look";
export const RESUME_UNREADABLE_TEXT = "The résumé could not be read; the written answers were used.";
export const ASSESSMENT_UNAVAILABLE_TEXT = "We could not assess this application automatically; please review it yourself.";
/** Low confidence alone never holds a step (plan A8); it asks the reader to read the application themselves. */
export const LOW_CONFIDENCE_LABEL = "Read this one yourself";
export const LOW_CONFIDENCE_TEXT = "The assistant was not confident about this reading. Read the résumé and answers yourself before you decide.";

export type AssessmentLike = { kind: string; overall: string; confidence?: string; result: EvidenceAssessment | ScreenAssessment };
export type EvidenceFinding = { claim: string; evidence: { source: string; quote?: string } };

export type EvidenceView = {
  needsCloserLook: boolean;
  /** Plain words for the owner: what is missing. Null when nothing needs a closer look. */
  reason: string | null;
  /** The assistant produced no usable assessment (invalid or refused twice); the owner reviews without one. */
  assessmentUnavailable: boolean;
  /** The résumé file was clean but had no text to read (a scan without a text layer); the written answers were used. */
  resumeUnreadable: boolean;
  /** The reading disagrees with its own must-have findings, so the assistant's step was held for a person (plan A8). */
  inconsistent: boolean;
  /** The latest reading was made with low confidence: "Read this one yourself". Never folded into `needsCloserLook`. */
  lowConfidence: boolean;
  /** The latest reading shows, with a checked quote from the candidate's own words, that a must-have is not met (plan A3): "Missing a must-have". */
  hasProvenMiss: boolean;
  /** The open questions from the latest assessment, in the words a screen would ask them. */
  unknowns: string[];
  unknownCount: number;
  topStrength: EvidenceFinding | null;
  topConcern: EvidenceFinding | null;
  /** What drives the confidence level, from the assessment (older assessments have none). */
  confidenceReasons: string[];
};

/**
 * True when the reading itself says the evidence was insufficient: a résumé reading that recommends reading it manually
 * or reads "unknown", or a screening scorecard in its own words, one that left it open (overall "unknown", or "hold").
 */
export function insufficientEvidence(latest: AssessmentLike | null | undefined): boolean {
  if (!latest) return false;
  const rec = (latest.result as { recommendation?: string }).recommendation;
  if (latest.kind === "screen") return latest.overall === "unknown" || rec === "hold";
  if (latest.kind !== "triage") return false;
  return rec === "review_manually" || latest.overall === "unknown";
}

/** The latest reading was made with low confidence. */
export function lowConfidence(latest: AssessmentLike | null | undefined): boolean {
  return (latest?.confidence ?? latest?.result.confidence) === "low";
}

const OVERALL_WORDS: Record<string, string> = { strong: "Strong match", potential: "Potential match", weak: "Weak match", unknown: "Insufficient evidence" };

/** The step the assistant suggests with this reading: a screen after the résumé, an interview after the screen. */
function suggestedStep(latest: AssessmentLike): "a screen" | "an interview" | null {
  const rec = (latest.result as { recommendation?: string }).recommendation;
  if (latest.kind === "triage") return rec === "screen" ? "a screen" : null;
  return rec === "strong_interview" || rec === "interview" ? "an interview" : null;
}

export type ReadingConsistency = { consistent: boolean; reason: string | null };

/**
 * The must-have findings that show a must-have is not met by a verified quote: the quote check leaves a "no" only on a
 * quote it found in the candidate's own words, and marks anything else `unquoted`. A missing must-have counts only then
 * (plan 0.9). `packet` limits them to the role's must-haves; without it every requirement finding counts.
 */
export function provenMisses(latest: Pick<AssessmentLike, "result">, packet?: Pick<RolePacket, "requirements"> | null): EvidenceAssessment["requirementFindings"] {
  const keys = packet ? new Set(packet.requirements.mustHaves.map((m) => m.key)) : null;
  return (latest.result.requirementFindings ?? []).filter((f) => f.met === "no" && !!f.evidence?.quote?.trim() && !f.evidence.unquoted && (!keys || keys.has(f.requirementKey)));
}

/**
 * The software check before any automatic step (plan A8): the assistant's reading must agree with its own must-have
 * findings. It fails when the reading is Strong or Potential but a must-have is shown as not met by a verified quote
 * (the quote check leaves a "no" only on a quote it found in the candidate's own words), when a Strong reading's own
 * findings show, by a verified quote, that an Essential skill goes against them (plan F3: importance counts here), and
 * when a step is suggested for a Weak or Insufficient reading. Pure: the workflows call it before `gate()` and the pages
 * read it off the same assessment. `packet` limits the check to the role's must-haves and names them; without it every
 * requirement finding counts (the assessment writes one per must-have). The skills are checked only with the packet.
 */
export function readingConsistency(latest: AssessmentLike, packet?: (Pick<RolePacket, "requirements"> & Partial<Pick<RolePacket, "competencies">>) | null): ReadingConsistency {
  const mustHaves = packet ? new Map(packet.requirements.mustHaves.map((m) => [m.key, m.text])) : null;
  const misses = provenMisses(latest, packet);
  const words = OVERALL_WORDS[latest.overall] ?? latest.overall;
  if ((latest.overall === "strong" || latest.overall === "potential") && misses.length) {
    const miss = misses[0];
    const name = mustHaves?.get(miss.requirementKey);
    return { consistent: false, reason: `The reading says ${words}, but the candidate's own words show a must-have is not met${name ? ` (${name})` : ""}: "${miss.evidence!.quote!.trim()}". Read it yourself before anything else happens.` };
  }
  if (latest.overall === "strong" && packet?.competencies) {
    const essential = new Map(packet.competencies.filter((c) => importanceOf(c) === "essential").map((c) => [c.key, c.name]));
    const against = (latest.result.competencyFindings ?? []).find((f) => f.finding === "contradicted" && essential.has(f.competencyKey) && !!f.evidence?.quote?.trim() && !f.evidence.unquoted);
    if (against) return { consistent: false, reason: `The reading says ${words}, but the candidate's own words go against an essential skill (${essential.get(against.competencyKey)}): "${against.evidence!.quote!.trim()}". Read it yourself before anything else happens.` };
  }
  const step = suggestedStep(latest);
  if (step && (latest.overall === "weak" || latest.overall === "unknown")) {
    return { consistent: false, reason: `The assistant suggested ${step} for a reading of ${words}, which does not add up. Read it yourself before anything else happens.` };
  }
  return { consistent: true, reason: null };
}

/** `packet` (the version the reading was made against) makes the consistency check the same one the workflows ran. */
export function evidenceView(input: { stage: string; latest: AssessmentLike | null | undefined; resumeUnreadable: boolean; packet?: (Pick<RolePacket, "requirements"> & Partial<Pick<RolePacket, "competencies">>) | null }): EvidenceView {
  const latest = input.latest ?? null;
  const waiting = input.stage === "triaged";
  // An application only reaches "triaged" through the assessment step: with an assessment, or by the branch that gave up on one.
  const assessmentUnavailable = waiting && !latest;
  // A held step waits on the owner where the reading was made: the résumé reading at "triaged", the scorecard at "screen complete".
  const checked = !!latest && ((waiting && latest.kind === "triage") || (input.stage === "screen_complete" && latest.kind === "screen"));
  const consistency = checked ? readingConsistency(latest!, input.packet) : { consistent: true, reason: null };
  const unknowns = latest?.result.unknowns.map((u) => u.question) ?? [];
  const needsCloserLook = (waiting && (assessmentUnavailable || insufficientEvidence(latest))) || !consistency.consistent;
  const parts: string[] = [];
  if (assessmentUnavailable) parts.push(ASSESSMENT_UNAVAILABLE_TEXT);
  if (!consistency.consistent && consistency.reason) parts.push(consistency.reason);
  if (needsCloserLook && input.resumeUnreadable) parts.push(RESUME_UNREADABLE_TEXT);
  if (needsCloserLook && latest && consistency.consistent) parts.push(unknowns.length ? `Open questions: ${unknowns.join(" ")}` : latest.result.summary);
  return {
    needsCloserLook,
    reason: parts.length ? parts.join(" ") : null,
    assessmentUnavailable,
    resumeUnreadable: input.resumeUnreadable,
    inconsistent: !consistency.consistent,
    lowConfidence: lowConfidence(latest),
    hasProvenMiss: !!latest && provenMisses(latest).length > 0,
    unknowns,
    unknownCount: unknowns.length,
    topStrength: latest?.result.strengths[0] ?? null,
    topConcern: latest?.result.concerns[0] ?? null,
    confidenceReasons: latest?.result.confidenceReasons ?? [],
  };
}

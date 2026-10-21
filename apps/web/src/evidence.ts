import type { ApplicationDetail, EvidenceRef } from "./api/client";

/**
 * "Insufficient evidence" on the candidate page. The Talent list receives it from the API (`evidence` on each row,
 * `evidenceView` in packages/core); the page derives the same from the full detail it already holds, with the same rule,
 * so the list, the page and the notification never disagree. Mirrors packages/core/src/evidence.ts.
 */
export const CLOSER_LOOK_LABEL = "Needs a closer look";
export const RESUME_UNREADABLE_TEXT = "The résumé could not be read; the written answers were used.";
export const ASSESSMENT_UNAVAILABLE_TEXT = "We could not assess this application automatically; please review it yourself.";

const OPEN_SCREEN_STATUSES = ["invited", "reminded", "in_progress"];

/** The latest résumé assessment (the detail lists assessments newest first). */
export function latestTriage(a: ApplicationDetail): ApplicationDetail["assessments"][number] | null {
  return a.assessments.find((x) => x.kind === "triage") ?? null;
}

/** A clean résumé file with nothing to read (a scan without a text layer): the written answers were used instead. */
export function resumeUnreadable(a: ApplicationDetail): boolean {
  return !a.extraction && a.documents.some((d) => d.kind === "resume" && d.status === "clean" && !d.hasText);
}

type Reading = ApplicationDetail["assessments"][number];
const OVERALL_WORDS: Record<string, string> = { strong: "Strong match", potential: "Potential match", weak: "Weak match", unknown: "Insufficient evidence" };

/**
 * The must-have findings that show, with a checked quote from the candidate's own words, that a must-have is not met.
 * `mustHaves` limits them to the role's must-haves when known. Mirrors `provenMisses` in packages/core.
 */
export function provenMisses(reading: Pick<Reading, "result">, mustHaves?: ReadonlyArray<{ key: string }> | null): NonNullable<Reading["result"]["requirementFindings"]> {
  const keys = mustHaves?.length ? new Set(mustHaves.map((m) => m.key)) : null;
  return (reading.result.requirementFindings ?? []).filter((f) => f.met === "no" && !!f.evidence?.quote?.trim() && !f.evidence.unquoted && (!keys || keys.has(f.requirementKey)));
}

/**
 * The software check before an automatic step (plan A8), as in `readingConsistency` in packages/core: the reading must
 * agree with its own must-have findings. Inconsistent when it says Strong or Potential while a must-have is shown not met
 * by a checked quote, when it says Strong while the candidate's own words go against an Essential skill (plan F3; only
 * with the role's `skills`), or when it suggests a step (a screen, an interview) for a Weak or Insufficient reading.
 */
export function readingConsistency(reading: Pick<Reading, "kind" | "overall" | "result">, mustHaves?: ReadonlyArray<{ key: string; text: string }> | null, skills?: ReadonlyArray<{ key: string; name: string; importance?: string | null }> | null): { consistent: boolean; reason: string | null } {
  const misses = provenMisses(reading, mustHaves);
  const words = OVERALL_WORDS[reading.overall] ?? reading.overall;
  if ((reading.overall === "strong" || reading.overall === "potential") && misses.length) {
    const miss = misses[0];
    const name = mustHaves?.find((m) => m.key === miss.requirementKey)?.text;
    return { consistent: false, reason: `The AI review says ${words}, but the candidate's own words show a must-have is not met${name ? ` (${name})` : ""}: "${miss.evidence!.quote!.trim()}". Read it yourself before anything else happens.` };
  }
  if (reading.overall === "strong" && skills?.length) {
    const essential = new Map(skills.filter((s) => s.importance === "essential").map((s) => [s.key, s.name]));
    const against = (reading.result.competencyFindings ?? []).find((f) => f.finding === "contradicted" && essential.has(f.competencyKey) && !!f.evidence?.quote?.trim() && !f.evidence.unquoted);
    if (against) return { consistent: false, reason: `The AI review says ${words}, but the candidate's own words go against an essential skill (${essential.get(against.competencyKey)}): "${against.evidence!.quote!.trim()}". Read it yourself before anything else happens.` };
  }
  const rec = reading.result.recommendation;
  const step = reading.kind === "triage" ? (rec === "screen" ? "an AI interview" : null) : rec === "strong_interview" || rec === "interview" ? "an interview" : null;
  if (step && (reading.overall === "weak" || reading.overall === "unknown")) return { consistent: false, reason: `The assistant suggested ${step}, but its AI review says ${words}. Read it yourself before anything else happens.` };
  return { consistent: true, reason: null };
}

/**
 * Whether the application needs a closer look, and why, by the same rule as `evidenceView` in packages/core: while it
 * waits on the owner and the résumé reading could not say enough (or there is none), or when the reading checked at this
 * step (the résumé's at "Ready for your review", the screen's at "Screen complete") disagrees with its own must-have
 * findings (plan A8). `checkedId` is the reading the check was made on, so its card can carry the mark.
 * `lowConfidence` is separate: the assistant did say something, but with low confidence, so the page asks the reader to
 * read this one themselves. It never changes the stage or the list order.
 */
export function closerLook(a: ApplicationDetail): { needsCloserLook: boolean; assessmentUnavailable: boolean; inconsistent: boolean; lowConfidence: boolean; reason: string | null; checkedId: string | null } {
  const waiting = a.stage === "triaged";
  const triage = latestTriage(a);
  const latest = a.assessments[0] ?? null;
  const assessmentUnavailable = waiting && a.assessments.length === 0;
  const insufficient = !!triage && (triage.result.recommendation === "review_manually" || triage.overall === "unknown");
  const checked = latest && ((waiting && latest.kind === "triage") || (a.stage === "screen_complete" && latest.kind === "screen")) ? latest : null;
  const consistency = checked ? readingConsistency(checked, a.packetLabels?.mustHaves, a.packetLabels?.competencies) : { consistent: true, reason: null };
  const needsCloserLook = (waiting && (assessmentUnavailable || insufficient)) || !consistency.consistent;
  const parts: string[] = [];
  if (assessmentUnavailable) parts.push(ASSESSMENT_UNAVAILABLE_TEXT);
  if (!consistency.consistent && consistency.reason) parts.push(consistency.reason);
  if (needsCloserLook && resumeUnreadable(a)) parts.push(RESUME_UNREADABLE_TEXT);
  if (needsCloserLook && latest && consistency.consistent) parts.push(latest.result.unknowns.length ? `Open questions: ${latest.result.unknowns.map((u) => u.question).join(" ")}` : latest.result.summary);
  return { needsCloserLook, assessmentUnavailable, inconsistent: !consistency.consistent, lowConfidence: lowConfidence(latest), reason: parts.length ? parts.join(" ") : null, checkedId: needsCloserLook ? (checked ?? triage)?.id ?? null : null };
}

export const LOW_CONFIDENCE_LABEL = "Read this one yourself";
export const LOW_CONFIDENCE_TEXT = "The assistant was not confident in its AI review. Read the résumé and answers yourself before you decide.";

/** The latest reading (the screen's scorecard once there is one, else the résumé's) was made with low confidence. */
export function lowConfidence(reading: { confidence: string } | null | undefined): boolean {
  return reading?.confidence === "low";
}

export function openScreenOf(a: ApplicationDetail): ApplicationDetail["screens"][number] | null {
  return a.screens.find((s) => OPEN_SCREEN_STATUSES.includes(s.status)) ?? null;
}

/**
 * The text of a screening question by key: the packet's own, one of the company's written questions the chat asks (Wave
 * S7), or one of the open questions a focused screen started with.
 */
export function screenQuestionText(a: Pick<ApplicationDetail, "packetLabels" | "screens">, key: string): string | null {
  return a.packetLabels.questions.find((q) => q.key === key)?.question ?? a.packetLabels.written?.find((w) => w.key === key)?.question ?? a.screens.flatMap((s) => s.progress.focusQuestions ?? []).find((f) => f.key === key)?.question ?? null;
}

/**
 * "no quote" (plan 0.9): a claim about the candidate with nothing verified quoted from them. The quote check marks
 * these (`unquoted`, packages/agents/src/triage.ts); readings written before it are read by the same rule, so the
 * label never depends on when the reading was made. Playbook, benchmark and owner sources are not about the candidate.
 */
export const NO_QUOTE_LABEL = "no quote";
const CANDIDATE_SOURCES = new Set(["resume", "application", "candidate_statement", "screen", "interview"]);
export function isUnquoted(e: EvidenceRef | null | undefined): boolean {
  if (!e) return false;
  return !!e.unquoted || (!e.quote?.trim() && CANDIDATE_SOURCES.has(e.source));
}

/** A must-have finding that says met, partly met or not met with nothing quoted to show it. */
export function requirementUnquoted(r: { met: string; evidence?: EvidenceRef }): boolean {
  return r.met !== "unknown" && !r.evidence?.quote?.trim();
}

/** A competency finding that says it was seen (or contradicted) with nothing quoted to show it. */
export function competencyUnquoted(c: { finding: string; evidence?: EvidenceRef }): boolean {
  return c.finding !== "not_evidenced" && !c.evidence?.quote?.trim();
}

export const SCORECARD_UNAVAILABLE_TEXT = "The AI interview is finished, but its AI review could not be written. Read the chat and decide yourself.";

/**
 * The latest screen finished but its scorecard could not be written (the run gave up after two unusable answers; the
 * engine then asked ITS to look). The page says so instead of showing a screen with no reading.
 */
export function scorecardUnavailable(a: ApplicationDetail): { unavailable: boolean; recruiterAsked: boolean } {
  const latest = a.screens[0];
  const unavailable = latest?.scorecard === "unavailable";
  return { unavailable, recruiterAsked: unavailable && !!latest?.recruiterAsked };
}

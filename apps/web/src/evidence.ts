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

export function closerLook(a: ApplicationDetail): { needsCloserLook: boolean; assessmentUnavailable: boolean; reason: string | null } {
  const waiting = a.stage === "triaged";
  const triage = latestTriage(a);
  const assessmentUnavailable = waiting && a.assessments.length === 0;
  const insufficient = !!triage && (triage.result.recommendation === "review_manually" || triage.overall === "unknown");
  const needsCloserLook = waiting && (assessmentUnavailable || insufficient);
  const parts: string[] = [];
  if (assessmentUnavailable) parts.push(ASSESSMENT_UNAVAILABLE_TEXT);
  if (needsCloserLook && resumeUnreadable(a)) parts.push(RESUME_UNREADABLE_TEXT);
  if (needsCloserLook && triage) parts.push(triage.result.unknowns.length ? `Open questions: ${triage.result.unknowns.map((u) => u.question).join(" ")}` : triage.result.summary);
  return { needsCloserLook, assessmentUnavailable, reason: parts.length ? parts.join(" ") : null };
}

export function openScreenOf(a: ApplicationDetail): ApplicationDetail["screens"][number] | null {
  return a.screens.find((s) => OPEN_SCREEN_STATUSES.includes(s.status)) ?? null;
}

/** The text of a screening question by key: the packet's own, or one of the open questions a focused screen started with. */
export function screenQuestionText(a: ApplicationDetail, key: string): string | null {
  return a.packetLabels.questions.find((q) => q.key === key)?.question ?? a.screens.flatMap((s) => s.progress.focusQuestions ?? []).find((f) => f.key === key)?.question ?? null;
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

export const SCORECARD_UNAVAILABLE_TEXT = "The screen is finished, but we could not write its scorecard automatically. Read the conversation and decide yourself.";

/**
 * The latest screen finished but its scorecard could not be written (the run gave up after two unusable answers; the
 * engine then asked ITS to look). The page says so instead of showing a screen with no reading.
 */
export function scorecardUnavailable(a: ApplicationDetail): { unavailable: boolean; recruiterAsked: boolean } {
  const latest = a.screens[0];
  const unavailable = latest?.scorecard === "unavailable";
  return { unavailable, recruiterAsked: unavailable && !!latest?.recruiterAsked };
}

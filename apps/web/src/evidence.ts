import type { ApplicationDetail } from "./api/client";

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

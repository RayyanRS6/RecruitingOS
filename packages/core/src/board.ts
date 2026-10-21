import { NEXT_STEP_LABEL, type ApplicationStage, type BoardColumn, type BoardPlacement, type InterviewInScore, type MarkKind, type MatchCriterion, type MatchScore, type MustHaveSummary, type NextStep, type NextStepKind, type OwnerStage, type ReadingVersion, type RejectReason } from "@ros/contracts";
import { ASSESSMENT_UNAVAILABLE_TEXT, CLOSER_LOOK_LABEL, LOW_CONFIDENCE_TEXT, RESUME_UNREADABLE_TEXT, insufficientEvidence, type AssessmentLike, type EvidenceView } from "./evidence";

/**
 * Where the pool board puts each person, and the step it suggests (plan F6; plan-adjustments section 3). Pure, like the
 * score it reads, so the board, the list, the summary and Review and apply always agree. The columns are in our words:
 * Shortlist, Longlist, Not moving forward. Nothing here moves anyone: a person applies the board's suggestions in Review
 * and apply, privately, and every decline needs a reason.
 *
 * - High or very high score, read with confidence, every must-have known → Shortlist. A must-have only partly shown
 *   that the score counted at the rest's level (Wave S7: it costs nothing there) → Longlist, ticked, asking for more.
 * - Medium score → Longlist.
 * - Low score, or a must-have the candidate's own words show is not met → Not moving forward.
 * - Needs a closer look → Longlist, unticked, with the reason ("Needs your eye"), whatever the score says: the reading
 *   disagrees with its findings or says too little (a résumé reading or a scorecard, at any stage), low confidence, no
 *   reading, nothing to score, an unreadable résumé, a must-have said to be missing with nothing quoted, held on an
 *   eligibility answer, or a must-have not yet known on an otherwise strong reading.
 * - A decline never starts ticked on thin or moving ground: a low score with must-haves not yet known or from under half
 *   the requirements, an open screening conversation whose answers would count most, a reading made against an older
 *   version of the role whose must-haves have changed, or a reading that itself suggested a step forward. The same goes
 *   for the Shortlist when the reading itself suggested holding back.
 * - No AI interview yet (20 Oct 2026, R20-7: being read, invited, started, a link that lapsed or a chat left part-way)
 *   → a read-only lane of its own, never placed and never suggested: scored after the AI interview. A person's mark
 *   still sorts them (below).
 * - Like with like (R20-9): anyone else whose score does not count an AI interview they were offered (`interview`: not
 *   done yet, being scored, or closed without being sent, as after "Stop this AI interview", or never sent because the
 *   month's AI interviews stayed used up, Q17) joins that lane too, so a résumé-only number is never ranked or
 *   suggested beside interviewed people (B4 is narrowed to match). Marks and decisions still show where they are; never
 *   offered one (`none`: an application from before 20 October 2026) keeps the rules above.
 * - Already decided, already marked or past this step (interviewing, offer, hired) → shown where they are now, as done,
 *   with nothing to apply.
 */
export type PlacementInput = {
  stage: ApplicationStage;
  /** `baseOwnerStage(stage)` (stages.ts): no AI interview yet, new, interviewing, offer, hired or not moving forward. */
  base: OwnerStage;
  stageLabel: string;
  mark?: { mark: MarkKind; remindAt?: string | null } | null;
  /** Where the AI interview stands for their score (`interviewInScore`); left out, `match.interview` says it, and with neither today's rules apply. */
  interview?: InterviewInScore | null;
  latest: AssessmentLike | null;
  evidence: Pick<EvidenceView, "needsCloserLook" | "assessmentUnavailable" | "lowConfidence" | "reason"> & Partial<Pick<EvidenceView, "resumeUnreadable">>;
  match: MatchScore | null;
  mustHaves: MustHaveSummary | null;
  openScreen?: boolean;
  /** Set when the reading was made against an earlier version of the role (plan F4). */
  readingVersion?: Pick<ReadingVersion, "readAgainst" | "mustHavesChanged"> | null;
};

/** Below this share of the requirements judged, a low score alone is too little to suggest a decline on. */
export const MIN_COVERAGE_TO_DECLINE = 0.5;

/** Days without a decision after which a person shows up under "Who might I be overlooking?". */
export const OVERLOOKED_AFTER_DAYS = 7;
/** The lane's words: never a score until the AI interview is done. */
export const NO_AI_INTERVIEW_LANE = { label: "No AI interview yet", reason: "Scored after the AI interview: they join the board when they finish it." } as const;
/**
 * The same lane's words for someone out of that column whose score still has no AI interview in it (R20-9), by where it
 * stands. Neutral like the column's: never how far anyone got or what closed it.
 */
export const INTERVIEW_APART: Record<"not_done_yet" | "being_scored" | "not_done", { label: string; reason: string }> = {
  not_done_yet: { label: "AI interview not done yet", reason: NO_AI_INTERVIEW_LANE.reason },
  being_scored: { label: "AI interview being scored", reason: "Their AI interview is in and being scored: they join the board when it is." },
  not_done: { label: "No AI interview", reason: "Their score is from the résumé only, so the board keeps them apart from interviewed people and suggests nothing. Decide from their own page." },
};

const step = (kind: NextStepKind, reason: string): NextStep => ({ kind, label: NEXT_STEP_LABEL[kind], reason });

/**
 * "Match score 62: Perio charting partly shown." The costliest requirement in a line, or one not met in full that cost
 * nothing (a partly shown one counted at the rest's level, `PARTLY_SHOWN_RULE`); the score alone when every one is met.
 */
function scoreLine(match: MatchScore): string {
  const top = costliest(match) ?? match.breakdown.find((c) => c.pctMet < 100) ?? null;
  const head = `Match score ${match.score}`;
  return top ? `${head}: ${top.label} ${top.finding.toLowerCase()}.` : `${head}: every requirement judged so far is met.`;
}

function costliest(match: MatchScore | null): MatchCriterion | null {
  return match?.breakdown.find((c) => c.pointsLost > 0) ?? null;
}

/** "Experience not a match" for a requirement about time on the job; "Skills not a match" for anything else. */
function reasonCodeFor(text: string): RejectReason {
  return /\b(years?|experience|worked|working)\b/i.test(text) ? "not_a_match_experience" : "not_a_match_skills";
}

/**
 * The reason a not-moving-forward is filed with, from the person's own evidence: the missing must-have and their own
 * words, or what cost the score most. The code is from the fixed list; the note is for the team only and never sent.
 */
export function declineReasonFor(match: MatchScore | null): { reason: RejectReason; note: string } | null {
  if (!match) return null;
  const miss = match.missingMustHave[0];
  if (miss) return { reason: reasonCodeFor(miss.label), note: `Missing must-have: ${miss.label}.${miss.quote ? ` Their own words: "${miss.quote}"` : ""}` };
  const lost = match.breakdown.filter((c) => c.pointsLost > 0).slice(0, 2);
  if (match.score === null || !lost.length) return null;
  return { reason: reasonCodeFor(lost[0].label), note: `Match score ${match.score}/100. Cost the most: ${lost.map((c) => `${c.label} (${c.finding.toLowerCase()})`).join("; ")}.` };
}

function done(column: BoardColumn | null, doneLabel: string, reason: string, state: BoardPlacement["state"] = "done"): BoardPlacement {
  return { column, state, doneLabel, confident: false, needsYourEye: null, reason, nextStep: null, suggestedAction: null, declineReason: null };
}

/**
 * Which way the reading itself leans (plan F6): forward when it suggests a screen (the résumé reading) or an interview
 * (the scorecard), back when it suggests holding (the résumé reading) or declining (the scorecard).
 */
function readingLeans(latest: AssessmentLike): "forward" | "back" | null {
  const rec = (latest.result as { recommendation?: string }).recommendation;
  if (latest.kind === "screen") return rec === "interview" || rec === "strong_interview" ? "forward" : rec === "decline_recommended" ? "back" : null;
  return rec === "screen" ? "forward" : rec === "hold" ? "back" : null;
}

const listOf = (labels: string[]) => labels.join(", ");
const mustHavesNotKnown = (labels: string[]) => `${labels.length === 1 ? "A must-have is" : `${labels.length} must-haves are`} not yet known: ${listOf(labels)}.`;

const MARK_PLACE: Record<MarkKind, { column: BoardColumn; label: string }> = {
  shortlist: { column: "shortlist", label: "Shortlist" },
  longlist: { column: "longlist", label: "Longlist" },
  on_hold: { column: "longlist", label: "On hold" },
  not_a_fit_for_now: { column: "not_moving_forward", label: "Not a fit for now" },
};

export function boardPlacement(input: PlacementInput): BoardPlacement {
  const { match, latest } = input;
  if (input.base === "no_ai_interview" && !input.mark) return done(null, NO_AI_INTERVIEW_LANE.label, NO_AI_INTERVIEW_LANE.reason, "waiting");
  if (input.base === "hired") return done("shortlist", "Hired", "Hired.");
  if (input.base === "offer") return done("shortlist", "Offer", "An offer is in progress.");
  if (input.base === "interviewing") return done("shortlist", "Interviewing", "Already moving forward to interview.");
  if (input.base === "not_moving_forward") return done("not_moving_forward", input.stageLabel, "Already decided; the candidate is told only when someone sends the message.");
  if (input.mark) {
    const m = MARK_PLACE[input.mark.mark];
    return done(m.column, m.label, `Already sorted by a person: ${m.label}.`);
  }
  if (input.stage === "ineligible") {
    return { column: "longlist", state: "suggested", doneLabel: null, confident: false, needsYourEye: "Held on an eligibility answer: keep them in or decline from their page.", reason: "An eligibility answer did not match the role's rule.", nextStep: step("check_eligibility", "Only a person can keep them in or decline them."), suggestedAction: null, declineReason: null };
  }
  const interview = input.interview ?? input.match?.interview ?? null;
  if (interview === "not_done_yet" || interview === "being_scored" || interview === "not_done") return done(null, INTERVIEW_APART[interview].label, INTERVIEW_APART[interview].reason, "waiting");
  if (!latest) {
    return { column: "longlist", state: "suggested", doneLabel: null, confident: false, needsYourEye: ASSESSMENT_UNAVAILABLE_TEXT, reason: "No AI review to go on.", nextStep: step("read_yourself", "Open the résumé and answers; nothing was read for you."), suggestedAction: "longlist", declineReason: null };
  }

  // Where the evidence puts them.
  const missing = match?.missingMustHave ?? [];
  const score = match?.score ?? null;
  const band = match?.band ?? null;
  let column: BoardColumn = missing.length || band === "low" ? "not_moving_forward" : score === null || band === "medium" ? "longlist" : "shortlist";
  const reason = missing.length ? `Missing must-have: ${missing.map((m) => m.label).join(", ")}.` : score === null ? "Nothing to score yet: the application does not speak to the requirements either way." : scoreLine(match!);

  // What sends them to the Longlist for a person's eye instead, unticked: the first that applies says why.
  const unknownMust = match?.unknown.filter((u) => u.mustHave) ?? [];
  const unquotedNo = unknownMust.filter((u) => u.unquotedNo);
  const leans = readingLeans(latest);
  const coverage = match?.coverage ?? { known: 0, total: 0 };
  const thin = column === "not_moving_forward" && !missing.length && (unknownMust.length > 0 || coverage.known < coverage.total * MIN_COVERAGE_TO_DECLINE);
  const readYourself = (why: string, reasonForStep: string) => ({ why, next: step("read_yourself", reasonForStep) });
  const eye = ((): { why: string; next: NextStep } | null => {
    if (input.evidence.needsCloserLook) return readYourself(input.evidence.reason ?? CLOSER_LOOK_LABEL, "The AI review needs a person to check it before anything else happens.");
    if (insufficientEvidence(latest)) {
      return latest.kind === "screen"
        ? readYourself("The AI interview left too much open to go on.", "Read the chat and decide what to ask next.")
        : readYourself("The assistant could not say enough from the application to go on.", "Open the résumé and answers; the AI review left too much open.");
    }
    if (input.evidence.lowConfidence) return readYourself(LOW_CONFIDENCE_TEXT, "The assistant was not confident; your own read counts most here.");
    if (input.evidence.resumeUnreadable && match?.basedOn !== "screen") return readYourself(`${RESUME_UNREADABLE_TEXT} Open the file yourself before deciding.`, "The file may say more than the written answers did.");
    if (unquotedNo.length) return readYourself(`The assistant says ${listOf(unquotedNo.map((u) => u.label))} ${unquotedNo.length === 1 ? "is" : "are"} not met but quoted nothing from the candidate's own words, so it does not count either way.`, `Check for yourself whether they have ${unquotedNo[0].label}.`);
    if (score === null) return { why: "Nothing to score yet: the application does not speak to the requirements either way.", next: step("ask_more", input.openScreen ? "The AI interview is open; their answers will fill this in." : "Ask them about the must-haves in the AI interview.") };
    if (column === "not_moving_forward" && input.openScreen && latest.kind !== "screen") return { why: "Their AI interview is still open, and its answers count most. Wait for it, or read it yourself before deciding.", next: step("ask_more", "The AI interview is open; their answers will fill this in.") };
    if (column === "not_moving_forward" && input.readingVersion?.mustHavesChanged) return readYourself(`Read against version ${input.readingVersion.readAgainst} of the role, and the must-haves have changed since. Check them against the role as it is now.`, "The role's must-haves changed after they were read.");
    if (column === "not_moving_forward" && leans === "forward") return readYourself(`The assistant suggested ${latest.kind === "screen" ? "an interview" : "an AI interview"}, but the score puts them lower. Read before deciding.`, "The AI review and the score disagree; your own read decides.");
    if (column === "shortlist" && leans === "back") return readYourself(`The assistant suggested ${latest.kind === "screen" ? "not moving forward" : "holding back"}, but the score puts them higher. Read before deciding.`, "The AI review and the score disagree; your own read decides.");
    if (thin) {
      return unknownMust.length
        ? { why: `${mustHavesNotKnown(unknownMust.map((u) => u.label))} A low score without them is not enough to go on.`, next: step("ask_more", `Their application does not say whether they have ${unknownMust[0].label}.`) }
        : { why: `Only ${coverage.known} of ${coverage.total} requirements could be judged; a low score from so little is not enough to go on.`, next: step("ask_more", "Ask them about the role's requirements in the AI interview.") };
    }
    if (column === "shortlist" && unknownMust.length) return { why: mustHavesNotKnown(unknownMust.map((u) => u.label)), next: step("ask_more", `Their application does not say whether they have ${unknownMust[0].label}.`) };
    return null;
  })();
  const needsYourEye = eye?.why ?? null;
  let next: NextStep | null = eye?.next ?? null;
  if (needsYourEye) column = "longlist";

  // A must-have only partly shown costs the score nothing when the rest of the evidence is strong (`PARTLY_SHOWN_RULE`,
  // Wave S7): the board asks for more instead of suggesting the Shortlist on it.
  const partlyMust = column === "shortlist" && !next ? (match?.breakdown ?? []).filter((c) => c.mustHave && c.countedPct !== undefined) : [];
  if (partlyMust.length) {
    column = "longlist";
    next = step("ask_more", `Their application only partly shows ${listOf(partlyMust.map((c) => c.label))}.`);
  }

  if (!next) {
    if (column === "shortlist") {
      const screened = latest.kind === "screen";
      next = screened || (band === "very_high" && match?.confidence === "high") ? step("interview", screened ? "Good evidence on every must-have, and the AI interview is done." : "Strong evidence on every must-have.") : step("phone_call", "Good evidence on the must-haves; a short call would confirm it.");
    } else if (column === "not_moving_forward") {
      next = step("not_moving_forward", missing.length ? `Their own words show they do not meet ${missing[0].label}.` : reason);
    } else {
      const openQuestion = unknownMust[0]?.label ?? null;
      next = openQuestion ? step("ask_more", `Their application does not say whether they have ${openQuestion}.`) : step("keep_as_backup", reason);
    }
  }
  const suggestedAction = column;
  return {
    column,
    state: "suggested",
    doneLabel: null,
    confident: !needsYourEye,
    needsYourEye,
    reason,
    nextStep: next,
    suggestedAction,
    declineReason: column === "not_moving_forward" ? declineReasonFor(match) : null,
  };
}

/** Whole days between an ISO time and now, never negative. */
export function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000));
}

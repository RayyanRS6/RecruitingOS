import { z } from "zod";
import type { Confidence } from "./common";
import type { RejectReason } from "./stages";

/* ------------------------------------------------------------------------------------------------------------ */
/* Importance (plan F3): how much a skill counts, in the founder's words.                                         */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * How much a skill counts when the match score is worked out (plan F3). A person picks it on the role page; a packet
 * from before the picker has only the 1-5 weight, which reads as Essential (5), Important (3 or 4) or Helpful (1 or 2).
 */
export const Importance = z.enum(["essential", "important", "helpful"]);
export type Importance = z.infer<typeof Importance>;
export const IMPORTANCE_LABEL: Record<Importance, string> = { essential: "Essential", important: "Important", helpful: "Helpful" };
/** The 1-5 weight saved with each importance, so anything that still reads the weight agrees with the label. */
export const IMPORTANCE_WEIGHT: Record<Importance, number> = { essential: 5, important: 3, helpful: 1 };

/** The importance a skill carries: the label a person picked, or the one its 1-5 weight stands for. */
export function importanceOf(c: { weight: number; importance?: Importance | null }): Importance {
  if (c.importance) return c.importance;
  return c.weight >= 5 ? "essential" : c.weight >= 3 ? "important" : "helpful";
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The match score (founder decision B2; plan-adjustments section 1).                                             */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The bands of the 0-100 match score, the same cut-offs and words as the badge (packages/ui helpers.ts SCORE_BANDS):
 * 85 and up, 70 and up, 55 and up, below. The words describe the number and never reuse the AI reading's words.
 */
export type MatchBand = "very_high" | "high" | "medium" | "low";
export const MATCH_SCORE_BANDS: ReadonlyArray<{ band: MatchBand; min: number; label: string }> = [
  { band: "very_high", min: 85, label: "Very high" },
  { band: "high", min: 70, label: "High" },
  { band: "medium", min: 55, label: "Medium" },
  { band: "low", min: 0, label: "Low" },
];
/** A must-have the candidate's own words show is not met holds the score below the amber band. */
export const MISSING_MUST_HAVE_CAP = 54;
/** How much each kind of requirement counts: must-haves most, then the skills by their importance. */
export const MATCH_WEIGHT = { must_have: 4, essential: 3, important: 2, helpful: 1 } as const;

/**
 * The one verdict word beside the number (the owner, 6 November 2026), worked out in code from the same numbers by `fitOf`,
 * so it can never disagree with them. Wherever a word sits beside the score it is this one: the band stays in the data for
 * the badge's colour and the candidate's own view.
 */
export type MatchFit = "strong" | "potential" | "weak" | "missing_must_have" | "insufficient";
export const MATCH_FIT_LABEL: Record<MatchFit, string> = { strong: "Strong match", potential: "Potential match", weak: "Weak match", missing_must_have: "Missing a must-have", insufficient: "Not enough evidence" };
/** How sure the AI was shows only beside Strong or Potential: beside any other word it says nothing new. An older answer without the word keeps it. */
export const sureBeside = (fit: MatchFit | null | undefined): boolean => !fit || fit === "strong" || fit === "potential";

/** One requirement the score counted: what it is, how much of the score it carries, how much of it was met, and the quote. */
export type MatchCriterion = {
  key: string;
  label: string;
  mustHave: boolean;
  /** For a skill; null for a must-have. */
  importance: Importance | null;
  /** This requirement's share of the score, in points out of 100. */
  weightPct: number;
  /** 100 met, 50 partly, 0 not met. */
  pctMet: number;
  pointsLost: number;
  /** The finding in plain words: "Shown", "Partly shown", "Not met" (a must-have), "Shown", "Partly shown", "Goes against it" (a skill). */
  finding: string;
  /** Where the finding came from: the résumé reading or the screening conversation. */
  source: "resume" | "screen";
  quote: string | null;
  /** The claim has nothing quoted from the candidate (shown as "no quote"). */
  unquoted: boolean;
};

/**
 * Whether the AI interview is in the score (20 October 2026, R20-9): every applicant gets one, and the score counts both
 * readings once it is scored. Until then the number is the résumé's alone, and says so. `done`: the interview's scorecard
 * is in the score. `being_scored`: sent, its scorecard not written yet. `not_scored`: sent, and its scorecard waits for
 * the company's AI credit, so the team reads the answers themselves. `not_done_yet`: being prepared, or its link is
 * open (not started, started, paused, or they asked for a person). `not_done`: it closed without being sent (the link
 * lapsed, they stopped part-way or said no, or it was stopped), or it never came because the month's AI interviews
 * stayed used up for the whole sixty-day wait (Q17); one wording for all of these, so the label never says how far
 * anyone got (the 9 October "hide until Send" rule) or hints at a private decision that closed it (B6). `none`: never
 * offered one (an application from before 20 October 2026, or one held on an eligibility answer, which the board
 * places as held).
 */
export const InterviewInScore = z.enum(["done", "being_scored", "not_scored", "not_done_yet", "not_done", "none"]);
export type InterviewInScore = z.infer<typeof InterviewInScore>;
/**
 * The label beside the score wherever it shows (the board card, the list's tooltip, the candidate panel, Compare), so a
 * résumé-only number is never read as one that counts the AI interview. `SCORE_BASIS_INTERVIEW_ONLY` when the interview
 * is in and there is no résumé reading at all.
 */
export const SCORE_BASIS_WORDS: Record<InterviewInScore, string> = {
  done: "From the résumé and the AI interview",
  being_scored: "Résumé only for now: AI interview done, being scored",
  not_scored: "Résumé only: AI interview done, not scored",
  not_done_yet: "Résumé only: AI interview not done yet",
  not_done: "Résumé only: no AI interview",
  none: "Résumé only: no AI interview",
};
export const SCORE_BASIS_INTERVIEW_ONLY = "From the AI interview";
/** The small grey chip beside a résumé-only score on the list (any status but `done`). */
export const RESUME_ONLY_CHIP = "Résumé only";
/** Where the AI interview is still to come into the score, through no choice of the candidate's yet: their number is only a floor. */
export const INTERVIEW_STILL_COMING: readonly InterviewInScore[] = ["not_done_yet", "being_scored", "not_scored"];

/**
 * The groups of "Sort: Score", highest first within each (6 November 2026): 0 the number is final (the AI interview is in,
 * it closed unsent, it was never offered, or an older answer that does not say); 1 the interview is still coming, so nobody
 * ranks low just for not having done it yet; 2 no score yet. The list, the API's `order=score` and Compare all use it.
 */
export function scoreRank(a: { score?: number | null; interview?: InterviewInScore | null }): number {
  if (a.score === null || a.score === undefined) return 2;
  return a.interview && INTERVIEW_STILL_COMING.includes(a.interview) ? 1 : 0;
}

/**
 * A requirement nothing was said about either way: it earns no points so far and is never read as a no, and it is an open
 * question. `weightPct` and `pointsLost` are its share of the score, all still open. `unquotedNo` is set when a reading said
 * it is not met (or goes against it) without quoting the candidate's own words: still not known, but the board asks a person
 * to look (plan F6).
 */
export type MatchUnknown = { key: string; label: string; mustHave: boolean; importance: Importance | null; weightPct: number; pointsLost: number; unquotedNo?: boolean };

/**
 * The match score of one application, worked out by code from the stored, quote-checked findings (never by the model):
 * `score` is null when nothing could be judged yet. `breakdown` lists the requirements that were judged, the ones that
 * cost the most points first; `unknown` the ones nothing was said about ("based on 5 of 7 requirements"). `missingMustHave`
 * holds the must-haves the candidate's own words show are not met (a verified quote only); one of them holds the score at
 * 54. `interview` and `basis` (R20-9) say whether the AI interview is in it, and in which words; they never change the number.
 */
export type MatchScore = {
  score: number | null;
  band: MatchBand | null;
  bandLabel: string | null;
  /** The one verdict word (`fitOf`), from the same numbers as the score. */
  fit: MatchFit;
  coverage: { known: number; total: number; words: string };
  breakdown: MatchCriterion[];
  unknown: MatchUnknown[];
  /** The points still open: the share of the score that nothing has been said about yet. */
  openPoints: number;
  /**
   * The must-haves the role checks only in the team's own interviews that no reading shows in full yet (not known, partly
   * shown, or claimed with nothing quoted): never part of the number, but not known either, so the verdict word is never
   * Strong match beside one, the board never starts a decline ticked on a low score while one is open, and on the Shortlist
   * it says to check it in the interview (the release review, 11 November 2026). An older answer leaves it out.
   */
  checkInInterview?: Array<{ key: string; label: string }>;
  /** How many judged requirements are fully met ("N more at full marks"). */
  fullMarks: number;
  missingMustHave: Array<{ key: string; label: string; quote: string }>;
  /** True when a missing must-have held the score down. */
  capped: boolean;
  /** The confidence of the latest reading, shown as its own chip. */
  confidence: Confidence | null;
  /** Which reading supplied the findings the score counted (not whether the AI interview happened: `interview` says that). */
  basedOn: "resume" | "screen" | "resume_and_screen";
  /** Where the AI interview stands for the score (`InterviewInScore`): `done` only once its scorecard is in. */
  interview: InterviewInScore;
  /** The label in words (`SCORE_BASIS_WORDS`): "From the résumé and the AI interview", "Résumé only: AI interview not done yet"… */
  basis: string;
  /** The role version the findings were read against. */
  packetVersion: number | null;
};

/** The band of a 0-100 score, or null without one. */
export function matchBand(score: number | null | undefined): { band: MatchBand; label: string } | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  const s = Math.min(100, Math.max(0, Math.round(score)));
  const b = MATCH_SCORE_BANDS.find((x) => s >= x.min) ?? MATCH_SCORE_BANDS[MATCH_SCORE_BANDS.length - 1];
  return { band: b.band, label: b.label };
}

/** Where the Low band ends (`MATCH_SCORE_BANDS`). */
const LOW_BELOW = 55;
/** Below this share of the requirements judged, a low score is too little to go on. */
export const MIN_COVERAGE_TO_JUDGE = 0.5;

/**
 * The one verdict word, from the same numbers as the score (the owner, 6 November 2026), so a word and a number can never
 * disagree: a must-have their own words show is not met; then nothing to go on; under 55 the word says whether that is too
 * little evidence (`tooLittleToGoOn`, the board's own rule: a must-have not known, half the points still open, enough open
 * to lift it out of Low, or under half the requirements judged) or what the evidence shows; from 70 with every
 * must-have fully shown it is strong; anything else from 55 is potential. A must-have the role checks only in the team's own
 * interviews (`checkInInterview`) is not known until a reading shows it in full, though it is never in the number. The stored
 * `overall` of a reading stays for the audit trail and the board's own checks, and no longer speaks beside the number.
 */
export function fitOf(m: { score: number | null; missingMustHave: readonly unknown[]; openPoints: number; coverage: Pick<MatchScore["coverage"], "known" | "total">; breakdown: ReadonlyArray<Pick<MatchCriterion, "mustHave" | "pctMet">>; unknown: ReadonlyArray<Pick<MatchUnknown, "mustHave">>; checkInInterview?: readonly unknown[] }): MatchFit {
  if (m.missingMustHave.length) return "missing_must_have";
  if (m.score === null) return "insufficient";
  const mustOpen = m.unknown.some((u) => u.mustHave) || !!m.checkInInterview?.length;
  if (m.score < LOW_BELOW) return tooLittleToGoOn(m) ? "insufficient" : "weak";
  return m.score >= 70 && !mustOpen && m.breakdown.every((c) => !c.mustHave || c.pctMet === 100) ? "strong" : "potential";
}

/**
 * Whether a low number rests on too little to go on: one rule for the verdict word and the pool board (the release review,
 * 11 November 2026, after the panel read "Weak match" over the board's own "a low score from so little is not enough to go
 * on"). No number; a must-have not known yet, or one still to check in the team's own interviews; half the points still
 * open; enough points still open to lift it out of Low; or fewer than half the requirements judged. `fitOf` then says "Not
 * enough evidence", never "Weak match", and the board never starts a decline ticked on it (`boardPlacement`).
 */
export function tooLittleToGoOn(m: { score: number | null; openPoints: number; coverage: Pick<MatchScore["coverage"], "known" | "total">; unknown: ReadonlyArray<Pick<MatchUnknown, "mustHave">>; checkInInterview?: readonly unknown[] }): boolean {
  if (m.score === null) return true;
  return m.unknown.some((u) => u.mustHave) || !!m.checkInInterview?.length || m.openPoints >= 50 || m.score + m.openPoints >= LOW_BELOW || m.coverage.known < m.coverage.total * MIN_COVERAGE_TO_JUDGE;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* The match score's sums, shared by the real score and the weights preview (founder decision L-07 A).            */
/* ------------------------------------------------------------------------------------------------------------ */

/** A requirement as the sums read it: met, partly met, not met, or nothing said about it either way. */
export type WeighedFinding = "yes" | "partly" | "no" | "unknown";
export type WeighedRequirement = { weight: number; status: WeighedFinding; mustHave: boolean };

const WEIGHED_PCT: Record<WeighedFinding, number> = { yes: 100, partly: 50, no: 0, unknown: 0 };

/**
 * The match score's sums over every scored requirement, in the order given (packages/core match-score.ts reads them from
 * the stored findings): points earned over the points of all of them (6 November 2026). Shown is full, partly is half, and
 * a quoted no or something nothing was said about earns nothing; only the quoted no holds the score at
 * `MISSING_MUST_HAVE_CAP`, and nothing here reads "nothing said" as a no. Each requirement's share of the score and the
 * points it lost come back too. The real score and the weights preview (L-07 A) both run this, so a preview with the job's
 * own weights gives the real score back. `score` is null when nothing at all is known.
 */
export function weighRequirements(items: readonly WeighedRequirement[]): { score: number | null; capped: boolean; parts: Array<{ share: number; lost: number }> } {
  const total = items.reduce((n, r) => n + r.weight, 0);
  if (!total) return { score: null, capped: false, parts: items.map(() => ({ share: 0, lost: 0 })) };
  let lost = 0;
  const parts = items.map((r) => {
    const share = (100 * r.weight) / total;
    const exactLost = share * (1 - WEIGHED_PCT[r.status] / 100);
    lost += exactLost;
    return { share, lost: exactLost };
  });
  if (items.every((r) => r.status === "unknown")) return { score: null, capped: false, parts };
  // to six places first, so the same sum reached in another order rounds the same way at a half point
  const raw = Math.round(Number((100 - lost).toFixed(6)));
  const capped = items.some((r) => r.mustHave && r.status === "no") && raw > MISSING_MUST_HAVE_CAP;
  const score = Math.min(100, Math.max(0, capped ? MISSING_MUST_HAVE_CAP : raw));
  return { score, capped, parts };
}

/** A requirement as a weight reads it, judged or not. */
export type WeighableRequirement = Pick<MatchCriterion, "key" | "mustHave" | "importance">;

/** The job's own weight of a requirement: a must-have 4, a skill by its importance (Essential 3, Important 2, Helpful 1). */
export const matchWeightOf = (c: Pick<WeighableRequirement, "mustHave" | "importance">): number => (c.mustHave ? MATCH_WEIGHT.must_have : MATCH_WEIGHT[c.importance ?? "helpful"]);

/** One person's score in the weights preview (L-07 A): a number nobody else sees, never saved. */
export type PreviewScore = { score: number | null; band: MatchBand | null; capped: boolean };

/**
 * "Try different weights" (founder decision L-07 A, preview only): one person's match score worked out again from the
 * requirements their stored score already carries, with other weights. Nothing is read again, no AI is asked, and nothing
 * is saved or sent; the real score stays as it is. A weight of 0 leaves that requirement out of the score; one nothing was
 * said about earns nothing, as in the real score. With `matchWeightOf` it gives the real score back.
 */
export function previewMatch(match: Pick<MatchScore, "breakdown" | "unknown">, weightOf: (c: WeighableRequirement) => number): PreviewScore {
  const items: WeighedRequirement[] = [];
  const weigh = (c: WeighableRequirement, status: WeighedFinding) => {
    const w = weightOf(c);
    const weight = Number.isFinite(w) ? Math.max(0, w) : 0;
    if (weight > 0) items.push({ weight, status, mustHave: c.mustHave });
  };
  for (const c of match.breakdown) weigh(c, c.pctMet === 100 ? "yes" : c.pctMet === 0 ? "no" : "partly");
  for (const u of match.unknown) weigh(u, "unknown");
  const { score, capped } = weighRequirements(items);
  return { score, band: matchBand(score)?.band ?? null, capped };
}

/**
 * The must-have line on a card (plan F1): how many of the role's must-haves the latest evidence shows, partly shows,
 * shows are not met (a verified quote only), and does not say. `gaps` are the must-haves shown not met, with the quote.
 * It never holds or declines anyone.
 */
export type MustHaveSummary = { total: number; shown: number; partly: number; notShown: number; unknown: number; gaps: Array<{ key: string; text: string; quote: string }>; words: string };

/**
 * Which version of the role a reading was made against, when that is not the current one (plan F4).
 * `mustHavesChanged` says the must-haves differ between the two versions, so a decline resting on them waits for a person.
 */
export type ReadingVersion = { readAgainst: number; current: number; label: string; mustHavesChanged?: boolean };

/* ------------------------------------------------------------------------------------------------------------ */
/* The pool board (plan F6; plan-adjustments section 3).                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** The board's three columns, in our words. They are the private marks a person can apply (Shortlist, Longlist) and a private decision. */
export const BoardColumn = z.enum(["shortlist", "longlist", "not_moving_forward"]);
export type BoardColumn = z.infer<typeof BoardColumn>;
export const BOARD_COLUMN_LABEL: Record<BoardColumn, string> = { shortlist: "Shortlist", longlist: "Longlist", not_moving_forward: "Not moving forward" };

/** The step the board suggests for a person, in our words. */
export const NextStepKind = z.enum(["interview", "phone_call", "ask_more", "keep_as_backup", "read_yourself", "check_eligibility", "not_moving_forward"]);
export type NextStepKind = z.infer<typeof NextStepKind>;
export const NEXT_STEP_LABEL: Record<NextStepKind, string> = {
  interview: "Interview",
  phone_call: "Short phone call",
  ask_more: "Ask for more detail",
  keep_as_backup: "Keep as backup",
  read_yourself: "Read it yourself",
  check_eligibility: "Check eligibility",
  not_moving_forward: "Not moving forward",
};
export type NextStep = { kind: NextStepKind; label: string; reason: string };

/**
 * Where the board puts a person and why (plan F6). `state`:
 * - `suggested`: placed by the board's rules from their evidence; a person applies it in Review and apply.
 * - `done`: already decided, marked or past this step; shown where they are now, with `doneLabel`.
 * - `waiting`: still applying, or not read yet; nothing to apply.
 * `confident` is whether Review and apply starts with them ticked; `needsYourEye` says why not, in plain words.
 */
export type BoardPlacement = {
  column: BoardColumn | null;
  state: "suggested" | "done" | "waiting";
  doneLabel: string | null;
  confident: boolean;
  needsYourEye: string | null;
  reason: string;
  nextStep: NextStep | null;
  /** The Review and apply choice the board suggests; null when there is nothing to apply. */
  suggestedAction: "shortlist" | "longlist" | "not_moving_forward" | null;
  /** For a suggested "not moving forward": the reason from the fixed list and a note from their own evidence. */
  declineReason: { reason: RejectReason; note: string } | null;
};

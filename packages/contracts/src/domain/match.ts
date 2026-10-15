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
 * The rule for a partly shown requirement, in the words a person (and, after sending, the candidate) reads (Wave S7,
 * fairness run of 15 Oct 2026): showing part of something never scores lower than saying nothing about it.
 */
export const PARTLY_SHOWN_RULE = "A requirement partly shown counts half, or as much as the rest of the evidence when that is higher, so showing part of something never scores lower than saying nothing about it.";

/** One requirement the score counted: what it is, how much of the score it carries, how much of it was met, and the quote. */
export type MatchCriterion = {
  key: string;
  label: string;
  mustHave: boolean;
  /** For a skill; null for a must-have. */
  importance: Importance | null;
  /** This requirement's share of the score, in points out of 100 (of the requirements that could be judged). */
  weightPct: number;
  /** 100 met, 50 partly, 0 not met. */
  pctMet: number;
  /**
   * Set on a partly shown requirement counted above half (`PARTLY_SHOWN_RULE`): the share of it the score counted, the
   * level of the rest of the evidence, so it never pulls the score below what leaving it out would give. `pointsLost`
   * is worked out from this; `pctMet` stays 50.
   */
  countedPct?: number;
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
 * A requirement the evidence says nothing about either way: left out of the score, and an open question instead.
 * `unquotedNo` is set when a reading said it is not met (or goes against it) without quoting the candidate's own words:
 * still left out, but the board asks a person to look (plan F6).
 */
export type MatchUnknown = { key: string; label: string; mustHave: boolean; importance: Importance | null; unquotedNo?: boolean };

/**
 * The match score of one application, worked out by code from the stored, quote-checked findings (never by the model):
 * `score` is null when nothing could be judged yet. `breakdown` lists the requirements that were judged, the ones that
 * cost the most points first; `unknown` the ones left out ("based on 5 of 7 requirements"). `missingMustHave` holds the
 * must-haves the candidate's own words show are not met (a verified quote only); one of them holds the score at 54.
 */
export type MatchScore = {
  score: number | null;
  band: MatchBand | null;
  bandLabel: string | null;
  coverage: { known: number; total: number; words: string };
  breakdown: MatchCriterion[];
  unknown: MatchUnknown[];
  /** How many judged requirements are fully met ("N more at full marks"). */
  fullMarks: number;
  missingMustHave: Array<{ key: string; label: string; quote: string }>;
  /** True when a missing must-have held the score down. */
  capped: boolean;
  /** The confidence of the latest reading, shown as its own chip. */
  confidence: Confidence | null;
  basedOn: "resume" | "screen" | "resume_and_screen";
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

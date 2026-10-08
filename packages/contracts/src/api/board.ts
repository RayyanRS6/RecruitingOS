import { z } from "zod";
import type { Confidence } from "../domain/common";
import type { BoardColumn, BoardPlacement, MatchBand, MatchScore, MustHaveSummary, NextStep, ReadingVersion } from "../domain/match";
import { RejectReason, type ActiveMark, type ApplicationStage, type OwnerStage } from "../domain/stages";

/**
 * The pool board, Review and apply, and the one-click questions (plan Wave F; plan-adjustments sections 1 and 3).
 * docs/spec/22-match-score-and-pool-board.md describes each shape and the rules behind it.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* GET /roles/:id/board                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** A finding quoted on a card: a strength, or the gap that cost the most. */
export type BoardQuote = { claim: string; quote: string | null; source: string; unquoted: boolean };

/**
 * One person on the board. `score` is the full match score (breakdown included); `placement` says where the board puts
 * them, why, and whether Review and apply starts with them ticked. `facts` are the status-line facts: what already
 * happened and what is waiting.
 */
export type BoardCard = {
  applicationId: string;
  name: string;
  appliedAt: string;
  /** Days since they reached the step they are at. */
  waitingDays: number;
  stage: ApplicationStage;
  stageLabel: string;
  ownerStage: OwnerStage;
  ownerStageLabel: string;
  mark: ActiveMark | null;
  score: MatchScore | null;
  mustHaves: MustHaveSummary | null;
  confidence: Confidence | null;
  /** The latest reading's own words: "Strong match", "Needs a closer look"... */
  reading: string | null;
  strengths: BoardQuote[];
  gap: BoardQuote | null;
  placement: BoardPlacement;
  readingVersion: ReadingVersion | null;
  facts: { openScreen: boolean; invitedAutomatically: boolean; suggestionWaiting: boolean; stillApplying: boolean; lowConfidence: boolean; needsCloserLook: boolean };
  open: string;
};

/** Per must-have across the pool: how many show it, partly show it, show it is not met (verified quote), say nothing. */
export type PoolMustHaveCount = { key: string; label: string; shown: number; partly: number; notShown: number; unknown: number; total: number };

/**
 * The summary above the board (plan F7), built by fixed rules from the records: it never invents a name or a number.
 * `sentences` is the same in words, in order. `counts` are the people still to sort, by the column the board suggests;
 * `done` the people already sorted, decided or past this step (they are never counted as "on the shortlist"). Each
 * must-have's `total` counts only the people read against a version of the role that had it. `stricter` is the gentle
 * prompt when one must-have is not shown by most people; `editPath` opens the role's must-haves for a new version. It
 * never declines anyone.
 */
export type PoolSummary = {
  total: number;
  counts: Record<BoardColumn, number>;
  toSort: number;
  done: number;
  stillApplying: number;
  showEveryMustHave: number;
  mostMissing: { key: string; label: string; notShowing: number; of: number } | null;
  longestWaiting: { applicationId: string; name: string; days: number } | null;
  nextSteps: Array<{ applicationId: string; name: string } & NextStep>;
  mustHaves: PoolMustHaveCount[];
  stricter: { key: string; label: string; notShowing: number; of: number; words: string; editPath: string } | null;
  sentences: string[];
};

export type BoardView = {
  role: { id: string; title: string; status: string; currentPacketVersion: number | null };
  columns: Record<BoardColumn, BoardCard[]>;
  /** Offered the conversation with their application and not finished yet (plan E6): shown apart, never placed. */
  stillApplying: BoardCard[];
  summary: PoolSummary;
  generatedAt: string;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* POST /roles/:id/batch: Review and apply                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** At most this many people in one Review and apply. */
export const BATCH_MAX = 50;

/**
 * What Review and apply can do for one person. `shortlist`, `longlist`, `on_hold`: the private marks. `not_moving_forward`:
 * the private decline (reason required, nobody emailed). `invite_screen`: the screening conversation. `escalate`: ask an
 * ITS recruiter to look at this person.
 */
export const BatchAction = z.enum(["shortlist", "longlist", "not_moving_forward", "on_hold", "invite_screen", "escalate"]);
export type BatchAction = z.infer<typeof BatchAction>;
export const BATCH_ACTION_LABEL: Record<BatchAction, string> = { shortlist: "Shortlist", longlist: "Longlist", not_moving_forward: "Not moving forward", on_hold: "On hold", invite_screen: "Invite to the screening conversation", escalate: "Ask a recruiter to look" };

export const RoleBatchItem = z.object({
  applicationId: z.string().min(1).max(64),
  action: BatchAction,
  /** not_moving_forward: the reason from the fixed list (the preview pre-fills one from the person's own evidence). */
  reason: RejectReason.optional(),
  /** not_moving_forward: the note recorded with it; the preview's note from their evidence is used when this is left out. */
  note: z.string().trim().max(2000).optional(),
});
export type RoleBatchItem = z.infer<typeof RoleBatchItem>;

export const RoleBatchRequest = z.object({
  items: z.array(RoleBatchItem).min(1, "Choose at least one person.").max(BATCH_MAX, `Review and apply takes up to ${BATCH_MAX} people at a time.`),
  dryRun: z.boolean().default(false),
}).refine((b) => new Set(b.items.map((i) => i.applicationId)).size === b.items.length, { message: "Each person can appear once.", path: ["items"] });
export type RoleBatchRequest = z.infer<typeof RoleBatchRequest>;

/**
 * One person in the preview (`dryRun: true`): what will happen and whether it may. `suggested` is what the board
 * suggests for them now; `reason` the pre-filled reason for a not-moving-forward; `warnings` things to know (low
 * confidence, a missing must-have, a screening invitation already open).
 */
export type BatchPreviewItem = {
  applicationId: string;
  name: string;
  score: number | null;
  band: MatchBand | null;
  placement: BoardColumn | null;
  suggested: BatchAction | null;
  action: BatchAction;
  allowed: boolean;
  refusedReason: string | null;
  warnings: string[];
  reason: { reason: string; label: string; note: string } | null;
};

/** One person's result after Apply: done, or refused with the reason, each in its own transaction. */
export type BatchResultItem = {
  applicationId: string;
  name: string;
  action: BatchAction;
  suggested: BatchAction | null;
  ok: boolean;
  code: string | null;
  message: string;
  ownerStage: OwnerStage | null;
  /** Always "not_told" for marks and decisions: nothing was sent. */
  candidateNotice: string | null;
};

export type BatchPreview = {
  dryRun: true;
  items: BatchPreviewItem[];
  counts: Record<BatchAction, number>;
  ready: number;
  /** "3 decisions ready: 2 shortlist · 1 not moving forward". */
  words: string;
  /** The plan's screening conversations, for invitations in this batch: counted when someone starts, never refused once started. */
  screenAllowance: { limit: number | null; used: number; inThisBatch: number; words: string | null };
  privacy: string;
};

export type BatchResult = {
  dryRun: false;
  batchId: string;
  results: BatchResultItem[];
  applied: number;
  refused: number;
  words: string;
  privacy: string;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* GET /roles/:id/questions and GET /roles/:id/questions/:kind: one-click questions (plan F10)                     */
/* ------------------------------------------------------------------------------------------------------------ */

export const PoolQuestionKind = z.enum(["missing_must_have", "strongest_evidence", "overlooked", "compare"]);
export type PoolQuestionKind = z.infer<typeof PoolQuestionKind>;

export const PoolQuestionQuery = z.object({
  kind: PoolQuestionKind,
  /** strongest_evidence: the must-have to look at. */
  mustHave: z.string().min(1).max(100).optional(),
  /** compare: up to five people, comma-separated. */
  ids: z.string().max(400).optional(),
});

/** A question the page offers, ready to ask. */
export type PoolQuestion = { id: string; kind: PoolQuestionKind; label: string; mustHaveKey: string | null };

/** One person in an answer: why they are in it, with the quotes it rests on. */
export type PoolAnswerPerson = { applicationId: string; name: string; score: number | null; band: MatchBand | null; placement: BoardColumn | null; why: string; quotes: Array<{ criterion: string; quote: string; source: string }>; open: string };

/**
 * An answer, worked out from the stored findings (no new AI): the people, the quotes, and what it looked at. `people`
 * filters the board (`applicationIds`). `compare` is the side-by-side answer of "Compare these".
 */
export type PoolAnswer = {
  kind: PoolQuestionKind;
  question: string;
  answer: string;
  people: PoolAnswerPerson[];
  applicationIds: string[];
  lookedAt: { people: number; resumeReadings: number; screenReadings: number; requirements: string[]; words: string };
  compare?: unknown;
};

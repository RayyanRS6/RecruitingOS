import { z } from "zod";
import type { FormAnswerView } from "../domain/apply-questions";
import { BulkCandidateAction, CandidateAction, type CandidateActionState } from "../domain/candidate-actions";
import type { LockedApplicants } from "../domain/plans";
import type { CvScore, CvScoreSummary, InterviewScore, InterviewScoreSummary } from "../domain/score";
import { CandidateTab, type AiInterviewStatus, type ApplicationStage, type RoleStatus, type ToldState } from "../domain/stages";
import type { CandidateCounts } from "./jobs";

/**
 * A job's Candidates list and the candidate panel: what the API answers, and the actions it takes. The server works out
 * every tab, label, score, order and allowed action; a screen shows what it gets.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* The Candidates list.                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** GET /api/v1/roles/:id/applications?tab=: one tab's rows. Left out, the New tab. */
export const CandidateListQuery = z.object({ tab: CandidateTab.default("new") });
export type CandidateListQuery = z.infer<typeof CandidateListQuery>;

/**
 * Where a person's AI interview stands, for a row under Shortlisted or Interviewed and for the panel. Every time is ISO.
 * `sentAt`: when the link went; `linkOpenUntil`: while the link is open; `lastEmailAt`: the latest email about it (the
 * link or a reminder); `startedAt` and `completedAt` (they pressed "Send my answers"). Never how far anyone got.
 */
export type AiInterviewView = { status: AiInterviewStatus; label: string; sentAt: string | null; linkOpenUntil: string | null; lastEmailAt: string | null; startedAt: string | null; completedAt: string | null };

/** One person on a job's Candidates list. */
export type CandidateRow = {
  /** The application's id: the key of the panel and of every action. */
  id: string;
  name: string;
  /** When they applied (ISO). */
  appliedAt: string;
  stage: ApplicationStage;
  tab: CandidateTab;
  /** The words for where they are: "New", "AI interview sent", "Chose not to do the AI interview", "Hired", "Withdrew"… */
  label: string;
  /** The CV score, or why there is none ("Reading the CV", "CV could not be read"…), with its must-have line. */
  cvScore: CvScoreSummary;
  /** The interview score, once they sent their answers; null before. */
  interviewScore: InterviewScoreSummary | null;
  /** Null for someone never shortlisted, and for someone whose AI interview was cancelled. */
  aiInterview: AiInterviewView | null;
  /** One line for each "No" they gave to a yes/no screening question: "Answered No: <question>". A flag never moved anyone. */
  flags: string[];
  /** For someone Not selected: whether they were told. Null in every other case. */
  toldState: ToldState | null;
  toldLabel: string | null;
  /** What can be done with them now, in the order the buttons are shown, each allowed or not with the reason. */
  actions: CandidateActionState[];
};

/**
 * GET /api/v1/roles/:id/applications. `rows` are the people of the tab asked for, in the server's order: by CV score,
 * highest first, people with no score last, then who applied first; the Interviewed tab by interview score, then CV
 * score. `counts` cover every tab whatever tab was asked for. `locked`: the people past the plan's candidates per job:
 * a count and, for each, only where they came in and when; never a name, a score or a stage.
 */
export type CandidateList = {
  role: { id: string; title: string; status: RoleStatus; version: number | null };
  tab: CandidateTab;
  counts: CandidateCounts;
  rows: CandidateRow[];
  locked: LockedApplicants;
};

/* ------------------------------------------------------------------------------------------------------------ */
/* The candidate panel.                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

/** One point of an AI review, with the quote it rests on and where the quote is from in words ("from the CV"). */
export type ReviewPoint = { claim: string; quote: string | null; from: string | null };
/** The AI's words about a CV or about an AI interview. Words only: no number, verdict or recommendation is read from them. */
export type AiReview = { summary: string; strengths: ReviewPoint[]; concerns: ReviewPoint[]; openQuestions: Array<{ question: string; whyItMatters: string }> };

/** Where a CV file stands: `quarantined` while it is being checked, `clean` once it can be opened, `rejected` or `deleted` when it cannot. */
export type CvFileStatus = "quarantined" | "clean" | "rejected" | "deleted";
/** The line for each: a screen shows it in place of a file that is not `clean`, and the two file routes refuse with it (409 `not_available`). */
export const CV_FILE_STATUS_LABEL: Record<CvFileStatus, string> = {
  quarantined: "This file is still being checked.",
  clean: "Checked",
  rejected: "This file was refused or removed and cannot be opened.",
  deleted: "This file was refused or removed and cannot be opened.",
};

/**
 * The candidate's CV file. `hasText`: the file's own text could be read. The panel frames a PDF as it is and any other
 * file as its text, so a file that is not a PDF and has no text can only be downloaded.
 */
export type CandidateDocument = { id: string; filename: string; mime: string; sizeBytes: number; status: CvFileStatus; statusLabel: string; hasText: boolean };

/** One question the AI interview asked, with the answer the candidate sent, in their own words. */
export type InterviewAnswer = { key: string; question: string; answer: string | null; skipped: boolean };

/** The AI interview on the panel. Before the candidate sent their answers `score`, `review` and `answers` are null and empty: nothing reaches the team before that. */
export type AiInterviewPanel = AiInterviewView & {
  /** The interview score with its per-question table; null until they sent their answers. */
  score: InterviewScore | null;
  /** The scorecard's words; null until it is written. */
  review: AiReview | null;
  /** Every question asked, the closing one too, with their answer. */
  answers: InterviewAnswer[];
};

/**
 * GET /api/v1/applications/:id: one candidate. Opening it is recorded in the audit history. The CV file itself is opened
 * through GET /api/v1/applications/:id/documents/:documentId/inline (shown in the page) or /file (a short-lived download).
 */
export type CandidatePanel = {
  id: string;
  role: { id: string; title: string; status: RoleStatus };
  candidate: { firstName: string; lastName: string; name: string; email: string | null; phone: string | null };
  appliedAt: string;
  /** Where they came from, as recorded with the application (`?src=` on the job page), and in words ("LinkedIn", "Indeed", "Job page"). */
  source: string;
  sourceLabel: string;
  stage: ApplicationStage;
  tab: CandidateTab;
  label: string;
  toldState: ToldState | null;
  toldLabel: string | null;
  /** When the decision email left (ISO); null until it has. */
  toldAt: string | null;
  cv: CandidateDocument | null;
  /** The CV score with its breakdown: every requirement of the job, its finding and the quote. */
  cvScore: CvScore;
  /** The CV reading's words; null until the CV was read. */
  cvReview: AiReview | null;
  /** The screening questions with their answers, in the form's order; a "No" is flagged. */
  screeningAnswers: FormAnswerView[];
  aiInterview: AiInterviewPanel | null;
  actions: CandidateActionState[];
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Acting on candidates.                                                                                          */
/* ------------------------------------------------------------------------------------------------------------ */

/** POST /api/v1/applications/:id/actions: one action for one person. The rule and its reasons are `candidateActions`. */
export const ApplicationAction = z.object({ action: CandidateAction }).strict();
export type ApplicationAction = z.infer<typeof ApplicationAction>;

/**
 * What an action answers: where the person is now, and the server's own sentence for the toast ("AI interview sent to
 * Sam."). After `send_decision`, `undoUntil` is the moment the email leaves (ISO): until then "Don't send" takes it back.
 */
export type ActionResult = { ok: true; action: CandidateAction; applicationId: string; stage: ApplicationStage; tab: CandidateTab; label: string; toldState: ToldState | null; message: string; undoUntil: string | null };

/** At most this many people in one action for several. */
export const BULK_ACTION_MAX = 100;

/** POST /api/v1/roles/:id/applications/actions: the same action for several ticked people of one job. */
export const BulkApplicationAction = z.object({
  action: BulkCandidateAction,
  applicationIds: z.array(z.uuid()).min(1, "Choose at least one person.").max(BULK_ACTION_MAX, `Up to ${BULK_ACTION_MAX} people at a time.`),
}).strict().refine((b) => new Set(b.applicationIds).size === b.applicationIds.length, { message: "Each person can appear once.", path: ["applicationIds"] });
export type BulkApplicationAction = z.infer<typeof BulkApplicationAction>;

/**
 * One result per person, each done in a transaction of its own, so one refusal never blocks the rest. A refused one
 * carries the error `code` and the plain `message`, the same reason its disabled button would show. `message`: the
 * server's sentence for the toast ("3 shortlisted. 1 could not be: …").
 */
export type BulkActionResult = {
  action: BulkCandidateAction;
  results: Array<{ applicationId: string; name: string; ok: boolean; code: string | null; message: string }>;
  done: number;
  refused: number;
  message: string;
  /** After `send_decision`: the moment the emails leave (ISO); until then `unsend_decision` with the same people takes them back. */
  undoUntil: string | null;
};

/**
 * GET /api/v1/applications/:id/decision-message: the exact email "Email the decision" sends to this person. One
 * standard wording, never the AI's; `adverseDecisionLine` says Colorado's line is in it. 404 when the person is not
 * marked Not selected.
 */
export type DecisionMessagePreview = { to: string | null; subject: string; text: string; adverseDecisionLine: boolean; toldState: ToldState };

import { z } from "zod";
import type { MatchBand } from "./match";

/**
 * Wave S7, the Kanvis-style application (scratchpad kanvis-2/spec-s7-apply-flow.md; the contracts in s7-contracts.md).
 * The shapes the seven slices build to. Everything here is additive: a packet, a screen, an application or a company
 * without these fields reads and behaves exactly as before.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* (a) The company's questions, on the role packet (`RolePacket.companyQuestions`)                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** A quick question's key: "cq_" and snake_case, so it never meets an eligibility, screening or must-have key. Its form field is `q_<key>`. */
export const QuickQuestionKey = z.string().regex(/^cq_[a-z0-9_]{1,56}$/, "A quick question's key starts with cq_ and uses lowercase letters, digits and _.");
/** A written question's key: "wq_" and snake_case. Its answers are keyed by it in `screens.answers` and in the write-up. */
export const WrittenQuestionKey = z.string().regex(/^wq_[a-z0-9_]{1,56}$/, "A written question's key starts with wq_ and uses lowercase letters, digits and _.");

/**
 * A quick question the company asks on the form, answered with one tap or a number ("Questions from <Company>"). The
 * yes/no kind is the packet's eligibility questions (`requirements.eligibility`), read through `quickQuestionsOf` in
 * @ros/core; these are the other two kinds. A quick question never holds or declines anyone: only an eligibility rule
 * may hold an application, and a person decides. Every question passes the packet's fairness check before it is saved.
 */
export const QuickChoiceQuestion = z.object({
  kind: z.literal("choice"),
  key: QuickQuestionKey,
  question: z.string().trim().min(3).max(200),
  /** One plain line under the question; shown to candidates. */
  help: z.string().trim().max(200).optional(),
  required: z.boolean().default(true),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(8),
});
export const QuickNumberQuestion = z.object({
  kind: z.literal("number"),
  key: QuickQuestionKey,
  question: z.string().trim().min(3).max(200),
  help: z.string().trim().max(200).optional(),
  required: z.boolean().default(true),
  /** The unit said beside the box ("an hour", "years"). */
  unit: z.string().trim().max(30).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
export const QuickQuestion = z.discriminatedUnion("kind", [QuickChoiceQuestion, QuickNumberQuestion]);
export type QuickQuestion = z.infer<typeof QuickQuestion>;

/**
 * A written question the company wants answered, asked in the chat (its "Required questions" section) and written up
 * from the candidate's own replies on Review & send. `lookFor` is private: what a good answer shows, for the chat model
 * and the team; it never reaches a candidate page (packet visibility "reviewed").
 */
export const WrittenQuestion = z.object({
  key: WrittenQuestionKey,
  question: z.string().trim().min(5).max(400),
  required: z.boolean().default(true),
  lookFor: z.string().trim().max(400).optional(),
});
export type WrittenQuestion = z.infer<typeof WrittenQuestion>;

/** "Questions every applicant answers" (the job's Scoring tab): optional on the packet; absent means none of either kind. */
export const CompanyQuestions = z.object({
  quick: z.array(QuickQuestion).max(8).default([]),
  written: z.array(WrittenQuestion).max(5).default([]),
});
export type CompanyQuestions = z.infer<typeof CompanyQuestions>;

/**
 * One question of "Questions from <Company>" as the form shows it, whichever kind it is (`quickQuestionsOf`):
 * `source` "eligibility" is a packet eligibility rule (field `elig_<key>`, kind yes_no or days, answers stored as today
 * in `applications.answers.eligibility`), "company" a quick question (field `q_<key>`, kind choice or number, answers in
 * `applications.answers.quick`). `options` are the choices offered ("Yes"/"No", the days, or the company's options).
 */
export type QuickQuestionView = {
  source: "eligibility" | "company";
  key: string;
  field: string;
  kind: "yes_no" | "days" | "choice" | "number";
  question: string;
  help: string | null;
  required: boolean;
  options: string[];
  unit: string | null;
  min: number | null;
  max: number | null;
};

/**
 * One written question as the chat and Review & send use it (`writtenQuestionsOf`): the company's own written questions
 * when it set any; otherwise the packet's screening questions, so a job saved before Wave S7 runs the new chat with the
 * questions it already has, under the same keys. Never carries `lookFor`.
 */
export type WrittenQuestionView = { key: string; question: string; required: boolean; source: "company" | "screening" };

/* ------------------------------------------------------------------------------------------------------------ */
/* (b) The chat's plan and its counter (`ScreenProgress.chat`)                                                   */
/* ------------------------------------------------------------------------------------------------------------ */

/** The chat's sections, in order: the must-haves the CV does not show, the company's written questions, the close. */
export const ChatSection = z.enum(["experience", "required", "wrapping_up"]);
export type ChatSection = z.infer<typeof ChatSection>;
export const CHAT_SECTION_LABEL: Readonly<Record<ChatSection, string>> = { experience: "About your experience", required: "Required questions", wrapping_up: "Wrapping up" };

/**
 * Where one item of the plan stands. `open`: not asked yet; `asking`: being asked now; `covered`: a concrete answer or
 * example arrived; `unknown`: settled as not known ("No", "I haven't": never a "no" for a skill, and the licence rule of
 * spec-s5 stands); `skipped`: the candidate pressed Skip.
 */
export const ChatItemState = z.enum(["open", "asking", "covered", "unknown", "skipped"]);
export type ChatItemState = z.infer<typeof ChatItemState>;

/**
 * One thing the chat must close. `gap`: a must-have the CV does not show (key = the must-have's key), asked in
 * "About your experience" along the ladder `direct` → `analog` ("something similar from your own work") → `smaller`
 * ("even a small moment?"), with at most one push for specifics. `written`: a written question (key =
 * `WrittenQuestionView.key`); only these count toward "N of M required", and only when `required`.
 */
export const ChatItem = z.object({
  key: z.string().min(1).max(100),
  kind: z.enum(["gap", "written"]),
  required: z.boolean().default(false),
  state: ChatItemState.default("open"),
  step: z.enum(["direct", "analog", "smaller"]).default("direct"),
  pushes: z.number().int().min(0).max(1).default(0),
});
export type ChatItem = z.infer<typeof ChatItem>;

/** The chat's plan, fixed in code when the chat starts and moved on in code after each turn; the model never writes it. */
export const ChatPlan = z.object({
  v: z.literal(1),
  section: ChatSection,
  items: z.array(ChatItem).max(20),
  /** The item being asked now; null between items and while wrapping up. */
  current: z.string().nullable().default(null),
  builtAt: z.string(),
});
export type ChatPlan = z.infer<typeof ChatPlan>;

/** What the chat's header shows (founder decision S7-3): "2 of 4 required · Required questions"; never the questions in advance. */
export type ChatCounter = { done: number; required: number; section: ChatSection; label: string };

/* ------------------------------------------------------------------------------------------------------------ */
/* (c) The write-up per written question (`ScreenProgress.writeup`)                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * One written question's answer on Review & send. `answer` is the candidate's own voice: their words, lightly condensed,
 * first person; empty when they gave none. `quotes` are the pieces of their own sent messages it rests on, each checked
 * in code against the transcript (one not found is dropped). `note` is the separate, labelled "Note from the
 * assistant", only when something is missing ("No example was given for …"), and is never inside `answer`. `by`
 * "candidate": the candidate changed it on Review & send, and `answer` is exactly what they typed.
 */
export const WriteupAnswer = z.object({
  questionKey: z.string().min(1).max(100),
  answer: z.string().max(2000),
  status: z.enum(["answered", "partly", "not_given", "skipped"]),
  quotes: z.array(z.string().min(1).max(500)).max(6).default([]),
  note: z.string().max(300).nullable().default(null),
  by: z.enum(["writeup", "candidate"]).default("writeup"),
  editedAt: z.string().optional(),
});
export type WriteupAnswer = z.infer<typeof WriteupAnswer>;

/**
 * The write-up of a chat (task `screen.writeup`, Haiku 5.5): one answer per written question, in `writtenQuestionsOf`
 * order. Stored on the conversation's own progress (a screen, or a repeat submission's detached copy, which carries it
 * over when confirmed), so it is hidden from the team until Send like every other part of an unsent chat
 * (`teamScreenView`), erased with the candidate's words (`withoutCandidateWords`) and included in an access export.
 */
export const ScreenWriteup = z.object({
  v: z.literal(1),
  writtenAt: z.string(),
  aiRunId: z.string().nullable(),
  promptVersion: z.number().int().nullable(),
  answers: z.array(WriteupAnswer).max(20),
});
export type ScreenWriteup = z.infer<typeof ScreenWriteup>;

/* ------------------------------------------------------------------------------------------------------------ */
/* (d) What the profile learns from a sent chat (`applications.answers.learned`)                                 */
/* ------------------------------------------------------------------------------------------------------------ */

export const LearnedFactKind = z.enum(["skill", "project", "experience", "logistics", "other"]);
export type LearnedFactKind = z.infer<typeof LearnedFactKind>;

/**
 * A fact the candidate said themselves in a chat they sent ("Arduino", "Has own transport"), kept on the application
 * whose chat it came from, in `applications.answers.learned`. The candidate's company-scoped profile is every such fact
 * on their applications at that company, newest first, without the removed ones: shown and editable on their
 * application record ("From your chat on <job>, <date>"), and filled in on their next application to the same company.
 * Never the assistant's notes or inferences, never across companies; erased with the application's answers on a
 * deletion request, and part of an access export with them.
 */
export const LearnedFact = z.object({
  id: z.string().min(1).max(40),
  kind: LearnedFactKind,
  text: z.string().trim().min(1).max(200),
  /** The candidate's own words it rests on, checked against their sent messages. */
  quote: z.string().max(500),
  from: z.object({ applicationId: z.string(), screenId: z.string().nullable(), roleTitle: z.string(), at: z.string() }),
  editedAt: z.string().optional(),
  removedAt: z.string().optional(),
});
export type LearnedFact = z.infer<typeof LearnedFact>;

/* ------------------------------------------------------------------------------------------------------------ */
/* (e) The score a candidate sees, and the ITS switch                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/** The one line every requirement not on the job page folds into (founder decision S7-1). */
export const CANDIDATE_SCORE_OTHER_LABEL = "Other things the team looks for";

/** One bar of the breakdown: the requirement's public name (or the folded line), how much of it was met, its colour band. */
export type CandidateScoreRow = { key: string; label: string; pctMet: number; tone: "strong" | "partial" | "short"; words: string };

/**
 * The match score as the candidate sees it after sending (founder decision S7-1): the existing match score
 * (core/match-score.ts) and its breakdown, never a new scoring. Only the job page's own must-haves are named; every
 * other requirement the score counted (the skills the team looks for, which are not on the job page) is folded into
 * one line, `other`. A must-have nothing showed either way is listed as not shown yet: missing information is never
 * held against anyone.
 */
export type CandidateScoreView = {
  score: number;
  band: MatchBand;
  bandLabel: string;
  rows: CandidateScoreRow[];
  other: CandidateScoreRow | null;
  notYetShown: string[];
  coverage: string;
  capped: boolean;
};

/**
 * Whether the company's candidates see their match score after sending: on unless ITS turned it off for the company
 * (`companies.settings.candidateScoreShown` = false). Set from the ITS admin console only. Reads any settings object.
 */
export function candidateScoreShown(settings: unknown): boolean {
  const v = settings && typeof settings === "object" ? (settings as { candidateScoreShown?: unknown }).candidateScoreShown : undefined;
  return v !== false;
}

/** POST /api/v1/admin/customers/:id/candidate-score (ITS only): show candidates their score after sending, or not, with a reason. */
export const CandidateScoreSwitchChange = z.object({
  shown: z.boolean(),
  reason: z.string().trim().min(5, "Say why (at least five characters).").max(500),
}).strict();
export type CandidateScoreSwitchChange = z.infer<typeof CandidateScoreSwitchChange>;

import { z } from "zod";
import { Confidence, Evidence } from "./common";
import { EvidenceAssessment, Finding } from "./assessment";

/** Screening (docs/05 Screening Agent, docs/06 `screen` workflow). Text first: web chat or SMS. */

export const ScreenChannel = z.enum(["web", "sms"]);
export type ScreenChannel = z.infer<typeof ScreenChannel>;

export const ScreenStatus = z.enum(["invited", "reminded", "in_progress", "completed", "expired", "abandoned", "human_requested"]);
export type ScreenStatus = z.infer<typeof ScreenStatus>;

export const ScreenTranscriptEntry = z.object({
  role: z.enum(["assistant", "candidate", "system"]),
  content: z.string(),
  at: z.string(),
  questionKey: z.string().optional(),
  channel: ScreenChannel.optional(),
  aiRunId: z.string().optional(),
});
export type ScreenTranscriptEntry = z.infer<typeof ScreenTranscriptEntry>;

/** Where the conversation is. Kept in code, not in the model's head, so a restart or a channel switch resumes cleanly. */
export const ScreenProgress = z.object({
  askedKeys: z.array(z.string()).default([]),
  currentQuestionKey: z.string().nullable().default(null),
  followUps: z.record(z.string(), z.number()).default({}),
  confusedTurns: z.number().int().default(0),
  failures: z.number().int().default(0),
});
export type ScreenProgress = z.infer<typeof ScreenProgress>;

/** One assistant turn. Rules (enforced in the prompt and checked in code): disclose at the start, one question at a time, at most two follow-ups per question, never ask about protected characteristics. */
export const ScreenTurn = z.object({
  messageToCandidate: z.string().min(1).max(1200),
  /** The packet question this message asks, or null for a follow-up, an answer to the candidate, or the close. */
  questionKey: z.string().nullable(),
  /** The candidate's latest message, recorded as the answer to a question. */
  answerRecorded: z.object({ questionKey: z.string(), answer: z.string(), complete: z.boolean() }).nullable(),
  followUpReason: z.string().nullable(),
  candidateAskedAbout: z.enum(["pay", "schedule", "process", "company", "other"]).nullable().default(null),
  sentiment: z.enum(["fine", "confused", "frustrated", "distressed"]).default("fine"),
  done: z.boolean(),
  humanRequested: z.boolean(),
});
export type ScreenTurn = z.infer<typeof ScreenTurn>;

export const ScreenRecommendation = z.enum(["strong_interview", "interview", "hold", "decline_recommended"]);
export type ScreenRecommendation = z.infer<typeof ScreenRecommendation>;

/** The screen's scorecard: the evidence-based assessment shape plus what a screen specifically establishes. */
export const ScreenAssessment = EvidenceAssessment.omit({ recommendation: true }).extend({
  questionFindings: z.array(z.object({
    questionKey: z.string(),
    answered: z.boolean(),
    finding: z.string(),
    evidence: Evidence.optional(),
    meetsModelAnswer: z.enum(["yes", "partially", "no", "unknown"]).default("unknown"),
  })).default([]),
  compensationExpectation: z.object({ stated: z.string().optional(), withinRange: z.enum(["yes", "above", "below", "unknown"]).default("unknown") }).default({ withinRange: "unknown" }),
  availability: z.object({ stated: z.string().optional(), matchesSchedule: z.enum(["yes", "partially", "no", "unknown"]).default("unknown"), earliestStart: z.string().optional() }).default({ matchesSchedule: "unknown" }),
  eligibilityConfirmations: z.array(z.object({ key: z.string(), confirmed: z.enum(["yes", "no", "unknown"]), quote: z.string().optional() })).default([]),
  recommendation: ScreenRecommendation,
});
export type ScreenAssessment = z.infer<typeof ScreenAssessment>;

export const ScreenFindingSchema = Finding;
export const ScreenConfidence = Confidence;

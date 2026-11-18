import { z } from "zod";
import { Confidence, Evidence } from "./common";

/** Structured extraction of a CV. The model reads; code verifies quotes. */
export const ResumeExtraction = z.object({
  fullName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  locationText: z.string().optional(),
  headline: z.string().optional(),
  positions: z.array(z.object({
    title: z.string(),
    employer: z.string().optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    current: z.boolean().default(false),
    summary: z.string().optional(),
    quote: z.string().optional(),
  })).default([]),
  education: z.array(z.object({ institution: z.string().optional(), credential: z.string().optional(), field: z.string().optional(), quote: z.string().optional() })).default([]),
  licenses: z.array(z.object({ name: z.string(), jurisdiction: z.string().optional(), number: z.string().optional(), expires: z.string().optional(), quote: z.string().optional() })).default([]),
  certifications: z.array(z.object({ name: z.string(), quote: z.string().optional() })).default([]),
  skills: z.array(z.string()).default([]),
  languages: z.array(z.string()).default([]),
  yearsOfExperienceEstimate: z.number().optional(),
  anomalies: z.array(z.object({ kind: z.enum(["date_inconsistency", "possible_ai_generated", "contradiction", "missing_dates", "other"]), detail: z.string() })).default([]),
  confidence: Confidence,
});
export type ResumeExtraction = z.infer<typeof ResumeExtraction>;

/** One thing a reading says about the candidate, with where it came from. */
export const Finding = z.object({
  claim: z.string().min(1),
  evidence: Evidence,
});
export type Finding = z.infer<typeof Finding>;

/** The words every reading writes: what it found, in plain language. Code never reads a decision out of them. */
const ReadingWords = {
  summary: z.string().min(1),
  strengths: z.array(Finding).default([]),
  concerns: z.array(Finding).default([]),
  /** Open questions: what the reading could not tell, and why it matters. */
  unknowns: z.array(z.object({ question: z.string(), whyItMatters: z.string() })).default([]),
};

/**
 * The CV reading (AI task `triage.assess`): one finding per must-have and per skill of the job, each with the quote it
 * rests on, and the words. The model writes no number, no verdict and no recommendation: the CV score is worked out in
 * code from these findings (`cvScoreOf`). A stored reading from before carries more fields; they are dropped on parse.
 */
export const EvidenceAssessment = z.object({
  ...ReadingWords,
  competencyFindings: z.array(z.object({
    competencyKey: z.string(),
    finding: z.enum(["evidenced", "partially_evidenced", "not_evidenced", "contradicted"]),
    evidence: Evidence.optional(),
    note: z.string().optional(),
  })).default([]),
  requirementFindings: z.array(z.object({
    requirementKey: z.string(),
    met: z.enum(["yes", "partially", "no", "unknown"]),
    evidence: Evidence.optional(),
  })).default([]),
});
export type EvidenceAssessment = z.infer<typeof EvidenceAssessment>;

/**
 * The AI interview's scorecard (AI task `screen.assess`): one finding per question the interview asked, and the words.
 * The interview score is worked out in code from `questionFindings` (`interviewScoreOf`). `finding`: one plain sentence
 * on what the answer showed. `meetsModelAnswer`: whether the answer met the job's standard for that question.
 */
export const ScreenAssessment = z.object({
  ...ReadingWords,
  questionFindings: z.array(z.object({
    questionKey: z.string(),
    answered: z.boolean(),
    finding: z.string(),
    evidence: Evidence.optional(),
    meetsModelAnswer: z.enum(["yes", "partially", "no", "unknown"]).default("unknown"),
  })).default([]),
});
export type ScreenAssessment = z.infer<typeof ScreenAssessment>;

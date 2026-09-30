import { z } from "zod";
import { Confidence, Evidence } from "./common";

/** Structured extraction of a resume. The model reads; code verifies quotes. */
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

export const EligibilityResult = z.object({
  evaluatedAt: z.string(),
  passed: z.boolean(),
  failedRules: z.array(z.object({ key: z.string(), question: z.string(), answer: z.unknown().optional(), reason: z.string() })).default([]),
  unverifiable: z.array(z.object({ key: z.string(), question: z.string(), reason: z.string() })).default([]),
});
export type EligibilityResult = z.infer<typeof EligibilityResult>;

export const Overall = z.enum(["strong", "potential", "weak", "unknown"]);
export type Overall = z.infer<typeof Overall>;

export const Finding = z.object({
  claim: z.string().min(1),
  evidence: Evidence,
});

/**
 * The evidence-based assessment (docs/02, docs/05). The numeric score is secondary and optional.
 * A schema without evidence for a claim is invalid by construction.
 */
export const EvidenceAssessment = z.object({
  overall: Overall,
  confidence: Confidence,
  /** What drives the confidence level, in plain words ("no résumé, only the written summary", "two must-haves have no evidence"). Optional: older assessments have none. */
  confidenceReasons: z.array(z.string().min(1).max(200)).max(6).optional(),
  summary: z.string().min(1),
  strengths: z.array(Finding).default([]),
  concerns: z.array(Finding).default([]),
  unknowns: z.array(z.object({ question: z.string(), whyItMatters: z.string() })).default([]),
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
  anomalies: z.array(z.object({ kind: z.string(), detail: z.string() })).default([]),
  secondaryScore: z.number().min(0).max(100).optional(),
  recommendation: z.enum(["screen", "hold", "review_manually"]),
  rationale: z.string().min(1),
});
export type EvidenceAssessment = z.infer<typeof EvidenceAssessment>;

import { z } from "zod";
import { EligibilityRuleType, CompensationBasis } from "./role-packet";

/** A vertical playbook: one versioned document per vertical, authored by ITS recruiters. */

export const PlaybookRole = z.object({
  key: z.string(),
  title: z.string(),
  aliases: z.array(z.string()).default([]),
  summary: z.string(),
  typicalEmploymentTypes: z.array(z.string()).default(["full_time"]),
  eligibility: z.array(z.object({
    type: EligibilityRuleType,
    question: z.string(),
    expectationByJurisdiction: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
    rationale: z.string(),
  })).default([]),
  commonQualifications: z.array(z.string()).default([]),
  competencies: z.array(z.object({
    key: z.string(), name: z.string(), definition: z.string(), weight: z.number(), indicators: z.array(z.string()),
  })).default([]),
  screeningQuestions: z.array(z.object({
    key: z.string(), question: z.string(), kind: z.string(), competencyKey: z.string().optional(), modelAnswer: z.string().optional(),
  })).default([]),
  interviewPlan: z.array(z.object({
    key: z.string(), title: z.string(), purpose: z.string(), durationMinutes: z.number(), format: z.string(), competencyKeys: z.array(z.string()), suggestedQuestions: z.array(z.string()).default([]),
  })).default([]),
  redFlags: z.array(z.string()).default([]),
  candidateObjections: z.array(z.object({ objection: z.string(), response: z.string() })).default([]),
  compensation: z.array(z.object({
    metro: z.string(),
    basis: CompensationBasis,
    p25: z.number(),
    p50: z.number(),
    p75: z.number(),
    source: z.string(),
    asOf: z.string(),
  })).default([]),
  benchmarks: z.object({
    applicantsPerHire: z.number().optional(),
    screensPerHire: z.number().optional(),
    interviewsPerHire: z.number().optional(),
    medianDaysToFill: z.number().optional(),
  }).default({}),
  channels: z.array(z.string()).default([]),
  /**
   * The government occupation (SOC code) market pay is read from for this role. "approximate" when the job has no
   * occupation of its own and the figures are for a broader group (a social media manager is read as a marketing
   * specialist), so the pay check calls them a rough guide. Without it, the occupation is found from the title.
   */
  occupation: z.object({ soc: z.string().regex(/^\d{2}-\d{4}$/), name: z.string(), match: z.enum(["close", "approximate"]) }).optional(),
});
export type PlaybookRole = z.infer<typeof PlaybookRole>;

export const Playbook = z.object({
  vertical: z.string(),
  version: z.number().int().min(1),
  name: z.string(),
  summary: z.string(),
  roles: z.array(PlaybookRole).min(1),
  generalRedFlags: z.array(z.string()).default([]),
  communicationDefaults: z.object({
    tone: z.enum(["warm", "direct", "formal"]).default("warm"),
    candidateMayBeTold: z.array(z.string()).default([]),
  }).default({ tone: "warm", candidateMayBeTold: [] }),
  authoredBy: z.string(),
  reviewedAt: z.string(),
});
export type Playbook = z.infer<typeof Playbook>;
export type PlaybookInput = z.input<typeof Playbook>;

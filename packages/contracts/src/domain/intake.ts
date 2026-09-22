import { z } from "zod";
import { Confidence } from "./common";

export const IntakeMessage = z.object({
  role: z.enum(["owner", "assistant", "system"]),
  content: z.string(),
  at: z.string(),
  aiRunId: z.string().optional(),
});
export type IntakeMessage = z.infer<typeof IntakeMessage>;

/** Facts the Intake agent has established so far. Every field optional; the agent asks for what is missing. */
export const IntakeFacts = z.object({
  title: z.string().optional(),
  playbookRoleKey: z.string().optional(),
  locationText: z.string().optional(),
  employmentType: z.string().optional(),
  schedule: z.string().optional(),
  remotePolicy: z.string().optional(),
  reason: z.string().optional(),
  reasonDetail: z.string().optional(),
  compensationBasis: z.string().optional(),
  compensationMin: z.number().optional(),
  compensationMax: z.number().optional(),
  compensationCeiling: z.number().optional(),
  benefits: z.string().optional(),
  mustHaves: z.array(z.string()).default([]),
  niceToHaves: z.array(z.string()).default([]),
  eligibilityNotes: z.array(z.string()).default([]),
  interviewers: z.array(z.string()).default([]),
  decisionMaker: z.string().optional(),
  targetStartDate: z.string().optional(),
  urgency: z.string().optional(),
  whatFailureLooksLike: z.string().optional(),
  dealBreakers: z.array(z.string()).default([]),
  /** Criteria the owner asked for that the agent declined to encode, with the reason given. */
  declinedCriteria: z.array(z.object({ requested: z.string(), reason: z.string(), alternative: z.string().optional() })).default([]),
});
export type IntakeFacts = z.infer<typeof IntakeFacts>;

export const IntakeMissingFact = z.enum([
  "title",
  "location",
  "employment_type",
  "schedule",
  "reason_for_hire",
  "compensation_range",
  "compensation_ceiling",
  "must_haves",
  "eligibility",
  "interviewers",
  "decision_maker",
  "timeline",
  "what_failure_looks_like",
  "deal_breakers",
]);

/** One assistant turn of the intake conversation. */
export const IntakeTurn = z.object({
  assistantMessage: z.string().min(1),
  factsExtracted: IntakeFacts,
  missingFacts: z.array(IntakeMissingFact),
  nextQuestions: z.array(z.string()).max(3),
  readyToCompile: z.boolean(),
  confidence: Confidence,
});
export type IntakeTurn = z.infer<typeof IntakeTurn>;

export const IntakeSessionStatus = z.enum(["active", "compiled", "abandoned"]);

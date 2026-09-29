import { z } from "zod";

export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

export const ActorKind = z.enum(["user", "agent", "system", "candidate", "recruiter"]);
export type ActorKind = z.infer<typeof ActorKind>;

/** Who did something. Every event, audit record, and packet version carries one. */
export const Actor = z.object({
  kind: ActorKind,
  id: z.string().min(1),
  name: z.string().optional(),
  /** For agents: the ai_runs row that produced the action. */
  runId: z.string().optional(),
});
export type Actor = z.infer<typeof Actor>;

export const SubjectType = z.enum([
  "company",
  "user",
  "role",
  "role_packet",
  "intake_session",
  "posting",
  "candidate",
  "application",
  "screen",
  "interview",
  "scorecard",
  "debrief",
  "offer",
  "onboarding",
  "communication",
  "workflow_run",
  "approval_request",
  "escalation",
  "integration",
  "policy",
  "ai_run",
  "business_calendar",
  "document",
  "application_link",
]);
export type SubjectType = z.infer<typeof SubjectType>;

export const Subject = z.object({ type: SubjectType, id: z.string().min(1) });
export type Subject = z.infer<typeof Subject>;

export const Location = z.object({
  label: z.string().optional(),
  address1: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(), // state or province code, e.g. CA
  postalCode: z.string().optional(),
  country: z.string().default("US"),
  timezone: z.string().optional(),
});
export type Location = z.infer<typeof Location>;

export const Money = z.object({
  amount: z.number().nonnegative(),
  currency: z.string().default("USD"),
});

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const EvidenceSource = z.enum([
  "resume",
  "application",
  "screen",
  "interview",
  "candidate_statement",
  "verified",
  "playbook",
  "benchmark",
  "owner_statement",
]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/**
 * A claim must point at where it came from. Quotes are verified against the source text in code.
 * `confidence` and `context` (date, role, employer) let the reader judge the evidence, not just find it (docs/FOUNDER-CONTEXT.md §10).
 */
export const Evidence = z.object({
  source: EvidenceSource,
  quote: z.string().optional(),
  ref: z.string().optional(),
  confidence: Confidence.optional(),
  context: z.string().optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

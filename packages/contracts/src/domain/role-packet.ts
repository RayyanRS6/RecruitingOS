import { z } from "zod";
import { Actor, Evidence, ISODate, Location } from "./common";

/**
 * The Role Packet is the central object of the system (docs/02). Every agent reads it;
 * only the Intake agent proposes it and only humans approve or edit it. Versions are
 * append-only.
 */

export const EmploymentType = z.enum(["full_time", "part_time", "contract", "temporary", "per_diem", "internship"]);
export const CompensationBasis = z.enum(["hourly", "salary"]);
export const RemotePolicy = z.enum(["onsite", "hybrid", "remote"]);
export const HireReason = z.enum(["new_position", "replacement", "growth", "seasonal", "other"]);

/**
 * Eligibility rules are the ONLY criteria that may automatically hold an application.
 * They are an enum on purpose: free-text knockouts are how illegal criteria sneak in.
 */
export const EligibilityRuleType = z.enum([
  "license",
  "certification",
  "work_authorization",
  "schedule_availability",
  "start_date",
  "location_radius",
  "physical_requirement_bona_fide",
  "minimum_age_legal",
]);
export type EligibilityRuleType = z.infer<typeof EligibilityRuleType>;

export const EligibilityRule = z.object({
  key: z.string().min(1),
  type: EligibilityRuleType,
  /** Plain-language statement shown to candidates as a question. */
  question: z.string().min(1),
  /** Machine-checkable expectation, e.g. {license:"RDH", jurisdiction:"CA"} or {days:["Sat"]} */
  expectation: z.record(z.string(), z.unknown()),
  rationale: z.string().min(1),
  /** true = failing this rule holds the application as ineligible (owner-authored). */
  knockout: z.boolean().default(true),
});
export type EligibilityRule = z.infer<typeof EligibilityRule>;

export const Requirement = z.object({
  key: z.string().min(1),
  text: z.string().min(1),
  rationale: z.string().min(1),
  /** How the requirement will be evidenced. */
  evidencedBy: z.array(z.enum(["resume", "application", "screen", "interview"])).min(1),
});
export type Requirement = z.infer<typeof Requirement>;

export const Competency = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  definition: z.string().min(1),
  weight: z.number().min(1).max(5),
  evaluatedIn: z.enum(["screen", "interview", "both"]),
  indicators: z.array(z.string()).min(1),
});
export type Competency = z.infer<typeof Competency>;

export const ScreeningQuestion = z.object({
  key: z.string().min(1),
  question: z.string().min(1),
  competencyKey: z.string().optional(),
  kind: z.enum(["skills", "behavioral", "compensation", "availability", "eligibility", "motivation", "logistics"]),
  modelAnswer: z.string().optional(),
  followUpIf: z.string().optional(),
});
export type ScreeningQuestion = z.infer<typeof ScreeningQuestion>;

export const InterviewRound = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  durationMinutes: z.number().int().min(15).max(240),
  format: z.enum(["video", "phone", "onsite", "working_session"]),
  interviewerUserIds: z.array(z.string()).default([]),
  interviewerRoles: z.array(z.string()).default([]),
  competencyKeys: z.array(z.string()).min(1),
  suggestedQuestions: z.array(z.string()).default([]),
});
export type InterviewRound = z.infer<typeof InterviewRound>;

export const ScorecardTemplate = z.object({
  scale: z.object({ min: z.number().int(), max: z.number().int(), labels: z.record(z.string(), z.string()) }),
  requireEvidence: z.boolean().default(true),
  overallRecommendationOptions: z.array(z.string()).default(["strong_yes", "yes", "no", "strong_no"]),
});

export const CompensationGuidance = z.object({
  basis: CompensationBasis,
  currency: z.string().default("USD"),
  min: z.number().nonnegative(),
  mid: z.number().nonnegative().optional(),
  max: z.number().nonnegative(),
  /** Hard ceiling the Offer agent may never exceed without a new approval. */
  ceiling: z.number().nonnegative(),
  bonus: z.string().optional(),
  benefitsSummary: z.string().optional(),
  discloseRange: z.boolean().default(true),
  sources: z.array(z.object({ name: z.string(), detail: z.string().optional(), evidence: Evidence.optional() })).default([]),
  /** When the owner stated the range and no benchmark was available. */
  ownerStated: z.boolean().default(false),
});
export type CompensationGuidance = z.infer<typeof CompensationGuidance>;

export const CommunicationPolicy = z.object({
  tone: z.enum(["warm", "direct", "formal"]).default("warm"),
  companyBlurb: z.string().min(1),
  /** What the AI may tell candidates about pay, schedule, process. Nothing else is answered. */
  candidateMayBeTold: z.array(z.string()).default([]),
  signature: z.string().min(1),
  disclosureText: z.string().min(1),
  humanAlternativeText: z.string().min(1),
});

export const ApprovalRules = z.object({
  packetApproverRoles: z.array(z.string()).default(["owner", "admin", "hiring_manager"]),
  interviewApproverRoles: z.array(z.string()).default(["owner", "hiring_manager", "recruiter"]),
  offerApproverRoles: z.array(z.string()).default(["owner", "admin"]),
});

export const CompliancePolicy = z.object({
  jurisdictions: z.array(z.string()).default([]), // e.g. ["US-CA"]
  notices: z.array(z.string()).default([]), // notice keys applied
  retentionClass: z.enum(["decision_data_4y", "standard_2y", "custom"]).default("decision_data_4y"),
  recordingPolicy: z.enum(["consent_required", "disabled"]).default("consent_required"),
  smsRequiresConsent: z.boolean().default(true),
});

export const SourcingStrategy = z.object({
  summary: z.string().min(1),
  channels: z.array(z.enum(["careers_page", "google_jobs", "indeed", "linkedin_basic", "ziprecruiter", "referrals", "rediscovery", "associations", "schools", "other"])).min(1),
  targetSources: z.array(z.string()).default([]),
  sponsoredDailyBudget: z.number().nonnegative().default(0),
  referralPrompt: z.string().optional(),
  rediscovery: z.boolean().default(true),
});

export const HiringTimeline = z.object({
  targetStartDate: ISODate.optional(),
  targetOfferDate: ISODate.optional(),
  urgency: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  inactivityDays: z.number().int().min(3).max(60).default(10),
});

export const HiringManagerPreferences = z.object({
  decisionMakerUserId: z.string().optional(),
  /** The decision maker as the owner named them in the conversation ("Dr Chen"); matched to a team member when the approval is requested. */
  decisionMakerName: z.string().optional(),
  dealBreakersInTheirWords: z.array(z.string()).default([]),
  whatFailureLooksLike: z.string().optional(),
  schedulingWindows: z.array(z.string()).default([]),
  interviewStyle: z.string().optional(),
});

export const PacketProvenance = z.object({
  playbookId: z.string().optional(),
  playbookVersion: z.number().int().optional(),
  intakeSessionId: z.string().optional(),
  aiRunIds: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
});

export const RolePacket = z.object({
  schemaVersion: z.literal(1).default(1),
  identity: z.object({
    title: z.string().min(2),
    department: z.string().optional(),
    locations: z.array(Location).min(1),
    employmentType: EmploymentType,
    schedule: z.string().optional(),
    remotePolicy: RemotePolicy.default("onsite"),
    reportsTo: z.string().optional(),
  }),
  business: z.object({
    reason: HireReason,
    reasonDetail: z.string().optional(),
    timeline: HiringTimeline,
  }),
  compensation: CompensationGuidance,
  description: z.object({
    publicJobDescription: z.string().min(50),
    internalNotes: z.string().optional(),
  }),
  requirements: z.object({
    mustHaves: z.array(Requirement).min(1).max(6),
    niceToHaves: z.array(Requirement).max(10).default([]),
    eligibility: z.array(EligibilityRule).default([]),
  }),
  competencies: z.array(Competency).min(3).max(8),
  evaluation: z.object({
    criteria: z.array(z.string()).min(1),
    redFlags: z.array(z.string()).default([]),
  }),
  screening: z.object({
    questions: z.array(ScreeningQuestion).min(3).max(12),
    maxMinutes: z.number().int().min(5).max(30).default(15),
  }),
  interviews: z.object({
    plan: z.array(InterviewRound).min(1).max(5),
    scorecard: ScorecardTemplate,
  }),
  communication: CommunicationPolicy,
  approvals: ApprovalRules,
  compliance: CompliancePolicy,
  sourcing: SourcingStrategy,
  preferences: HiringManagerPreferences,
  provenance: PacketProvenance,
});
export type RolePacket = z.infer<typeof RolePacket>;

export const RolePacketVersion = z.object({
  id: z.string(),
  roleId: z.string(),
  version: z.number().int().min(1),
  status: z.enum(["proposed", "approved", "superseded"]),
  source: z.enum(["intake_agent", "human_edit", "playbook", "import"]),
  changeSummary: z.string().optional(),
  createdBy: Actor,
  approvedBy: z.string().nullable().optional(),
  approvedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  packet: RolePacket,
});
export type RolePacketVersion = z.infer<typeof RolePacketVersion>;

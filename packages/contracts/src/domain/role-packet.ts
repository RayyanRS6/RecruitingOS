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

/** A request the assistant would not build into the role, with the reason the owner was given (C1: kept on the packet). */
export const DeclinedCriterion = z.object({ requested: z.string(), reason: z.string(), alternative: z.string().optional(), rule: z.string().optional() });
export type DeclinedCriterion = z.infer<typeof DeclinedCriterion>;

/**
 * Wording the packet guard found that may stand in for a protected trait (packages/core/src/packet-guard.ts). The role
 * cannot be approved while a flag is open: a person edits the words out, or keeps them and says why. `keepReason` is
 * how a client asks to keep one; the server replaces it with `kept`, stamped with who kept it and when, and never
 * trusts a `kept` it did not write.
 */
export const PacketFlag = z.object({
  id: z.string(),
  /** Where the words are, e.g. "description.publicJobDescription" or "requirements.mustHaves[1].text". */
  path: z.string(),
  rule: z.string(),
  text: z.string(),
  reason: z.string(),
  alternative: z.string().optional(),
  /** True when the owner was already told this could not be used, earlier in the conversation. */
  declined: z.boolean().optional(),
  keepReason: z.string().max(500).optional(),
  kept: z.object({ reason: z.string(), by: Actor, at: z.string() }).optional(),
});
export type PacketFlag = z.infer<typeof PacketFlag>;

/**
 * The market figure the pay was checked against. "market" is government wage data; "its_estimate" is ITS's own pay table
 * in the playbook, which is labelled as an estimate wherever it is shown (C8).
 */
export const PayBenchmark = z.object({
  basis: CompensationBasis,
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  source: z.string(),
  metro: z.string(),
  asOf: z.string().optional(),
  origin: z.enum(["market", "its_estimate"]),
});
export type PayBenchmark = z.infer<typeof PayBenchmark>;

/** How the advertised range was decided: typed by a person, set on the pay card, edited, or confirmed from an ad or an earlier role. */
export const PayOrigin = z.enum(["typed", "pay_card", "edited", "confirmed"]);
export type PayOrigin = z.infer<typeof PayOrigin>;

export const PacketProvenance = z.object({
  playbookId: z.string().optional(),
  playbookVersion: z.number().int().optional(),
  intakeSessionId: z.string().optional(),
  aiRunIds: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  sources: z.array(z.string()).default([]),
  /** What the owner asked for and was told could not be used; the guard keeps it out of every later version too. */
  declinedCriteria: z.array(DeclinedCriterion).optional(),
  flags: z.array(PacketFlag).optional(),
  /** Set by the server from the person who set or confirmed the pay, never by the model (C7). */
  payConfirmedBy: z.object({ by: Actor, at: z.string(), via: PayOrigin }).optional(),
  payOrigin: PayOrigin.optional(),
  benchmark: PayBenchmark.optional(),
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

/**
 * The draft written beside the conversation before the role exists (C7). Pay is optional: a draft carries a range only
 * once a person set or confirmed it; until then the panel says "not set yet" and nothing invents one.
 */
export const DraftRolePacket = RolePacket.extend({ compensation: CompensationGuidance.optional() });
export type DraftRolePacket = z.infer<typeof DraftRolePacket>;

/**
 * Who sees each part of a packet (C15): "public" is on the job page, "asked" is put to candidates (the apply form's
 * eligibility questions, the screening conversation, the lines on every message), "reviewed" is what applications are
 * read against (the must-haves: not listed on the job page, but a person may explain them to a candidate), "internal"
 * stays with the team. Keys are dotted paths; the longest matching prefix wins (`packetVisibility`).
 */
export type PacketVisibility = "public" | "asked" | "reviewed" | "internal";
export const PACKET_VISIBILITY: Readonly<Record<string, PacketVisibility>> = {
  identity: "public",
  "identity.reportsTo": "internal",
  "identity.department": "internal",
  business: "internal",
  compensation: "internal",
  "compensation.basis": "public",
  "compensation.currency": "public",
  "compensation.min": "public",
  "compensation.max": "public",
  "compensation.bonus": "public",
  "compensation.benefitsSummary": "public",
  "description.publicJobDescription": "public",
  "description.internalNotes": "internal",
  "requirements.mustHaves": "reviewed",
  "requirements.niceToHaves": "reviewed",
  "requirements.eligibility": "asked",
  competencies: "internal",
  evaluation: "internal",
  "screening.questions": "asked",
  "screening.maxMinutes": "asked",
  interviews: "internal",
  communication: "internal",
  "communication.disclosureText": "asked",
  "communication.humanAlternativeText": "asked",
  approvals: "internal",
  compliance: "internal",
  sourcing: "internal",
  preferences: "internal",
  provenance: "internal",
};

/** The plain label for each visibility, as the draft panel shows it. */
export const PACKET_VISIBILITY_LABEL: Readonly<Record<PacketVisibility, string>> = {
  public: "Candidates see this",
  asked: "Candidates are asked this",
  reviewed: "Used to review applications; not on the job page",
  internal: "Only your team sees this",
};

/** Who sees the part of the packet at `path` ("screening.questions[2].question" reads as "screening.questions"). */
export function packetVisibility(path: string): PacketVisibility {
  const parts = path.replace(/\[\d+\]/g, "").split(".");
  for (let n = parts.length; n > 0; n -= 1) {
    const hit = PACKET_VISIBILITY[parts.slice(0, n).join(".")];
    if (hit) return hit;
  }
  return "internal";
}

export const RolePacketVersion = z.object({
  id: z.string(),
  roleId: z.string(),
  version: z.number().int().min(1),
  status: z.enum(["proposed", "approved", "superseded"]),
  source: z.enum(["intake_agent", "human_edit", "playbook", "import", "agent_revision"]),
  changeSummary: z.string().optional(),
  createdBy: Actor,
  approvedBy: z.string().nullable().optional(),
  approvedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  packet: RolePacket,
});
export type RolePacketVersion = z.infer<typeof RolePacketVersion>;

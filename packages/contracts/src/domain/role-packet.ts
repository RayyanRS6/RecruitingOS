import { z } from "zod";
import { Actor, Location } from "./common";
import { FormQuestion, formQuestionsOfStored } from "./apply-questions";
import { Importance, importanceOf } from "./score";

/**
 * The job record ("role packet"): one versioned document per job. The job builder's AI drafts it from the company's own
 * words, a person edits it in the one editor, and the company publishes it. Every save of an open job is a new version,
 * live at once. It holds only what the product uses:
 *
 * - `identity`, `compensation`, `description`, `requirements`: the structured posting candidates read on the job page.
 * - `competencies`: the skills the CV score counts beside the must-haves, each Essential, Important or Helpful.
 * - `formQuestions`: the application form's questions ("Screening questions" on screen).
 * - `screening`: the AI interview's questions and its advertised length (the AI interview is "screen" in code).
 * - `communication`, `compliance`: the texts and notices emails and candidate pages read.
 * - `provenance`: which AI runs wrote it, what was assumed, the wording flags and who confirmed the pay.
 */

export const EmploymentType = z.enum(["full_time", "part_time", "contract", "temporary", "per_diem", "internship"]);
export type EmploymentType = z.infer<typeof EmploymentType>;
export const EMPLOYMENT_TYPE_LABEL: Record<EmploymentType, string> = { full_time: "Full time", part_time: "Part time", contract: "Contract", temporary: "Temporary", per_diem: "Per diem", internship: "Internship" };
export const CompensationBasis = z.enum(["hourly", "salary"]);
export type CompensationBasis = z.infer<typeof CompensationBasis>;
/** The work arrangement. The job builder asks for it; it is never assumed. */
export const RemotePolicy = z.enum(["onsite", "hybrid", "remote"]);
export type RemotePolicy = z.infer<typeof RemotePolicy>;
export const REMOTE_POLICY_LABEL: Record<RemotePolicy, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };

/** A must-have or a nice-to-have, in the company's words. `rationale`: why it matters, for the CV reading; never on the job page. */
export const Requirement = z.object({
  key: z.string().min(1),
  text: z.string().min(1),
  rationale: z.string().optional(),
});
export type Requirement = z.infer<typeof Requirement>;

/** A job version from before the importance labels carries a 1-5 weight instead: it reads as the label it stands for. */
const storedCompetency = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const c = raw as { weight?: unknown; importance?: unknown };
  if (c.importance) return raw;
  return { ...c, importance: importanceOf({ weight: typeof c.weight === "number" ? c.weight : null }) };
};

/** A skill the CV score counts: Essential weighs 3, Important 2, Helpful 1. `indicators`: what shows it, for the CV reading. */
export const Competency = z.preprocess(storedCompetency, z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  definition: z.string().default(""),
  importance: Importance,
  indicators: z.array(z.string()).default([]),
}));
export type Competency = z.infer<typeof Competency>;

/**
 * One question of the AI interview. `modelAnswer`: what a good answer shows, the job's standard the scorecard holds the
 * answer to; never shown to a candidate. `kind` only decides whether the chat offers a tap answer.
 */
export const ScreeningQuestion = z.object({
  key: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(["skills", "behavioral", "compensation", "availability", "eligibility", "motivation", "logistics"]).default("skills"),
  modelAnswer: z.string().optional(),
});
export type ScreeningQuestion = z.infer<typeof ScreeningQuestion>;

/** The least and most questions an AI interview may have. */
export const SCREENING_QUESTIONS_MIN = 3;
export const SCREENING_QUESTIONS_MAX = 12;

/** Pay as the job page shows it. A draft carries it only once a person set or confirmed it. */
export const CompensationGuidance = z.object({
  basis: CompensationBasis,
  currency: z.string().default("USD"),
  min: z.number().nonnegative(),
  max: z.number().nonnegative(),
  /** The benefits line on the job page; where a state asks for one and this is empty, the company's own from Settings is used. */
  benefitsSummary: z.string().optional(),
  /** Whether candidates see the range. Where a pay transparency law applies they see it whatever this says. */
  discloseRange: z.boolean().default(true),
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
export type CommunicationPolicy = z.infer<typeof CommunicationPolicy>;

export const CompliancePolicy = z.object({
  jurisdictions: z.array(z.string()).default([]), // e.g. ["US-CA"]
  notices: z.array(z.string()).default([]), // notice keys applied
});
export type CompliancePolicy = z.infer<typeof CompliancePolicy>;

/** A request the assistant would not build into the job, with the reason the owner was given (kept on the record). */
export const DeclinedCriterion = z.object({ requested: z.string(), reason: z.string(), alternative: z.string().optional(), rule: z.string().optional() });
export type DeclinedCriterion = z.infer<typeof DeclinedCriterion>;

/**
 * Wording the fairness guard found that may stand in for a protected trait (packages/core/src/packet-guard.ts). A job
 * cannot be published, and an edit to an open job cannot be saved, while a flag is open: a person edits the words out,
 * or keeps them and says why. `keepReason` is how a client asks to keep one; the server replaces it with `kept`, stamped
 * with who kept it and when, and never trusts a `kept` it did not write.
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

/** How the advertised range was decided: typed by a person, set on the pay card, edited in the editor, or confirmed from a pasted ad. */
export const PayOrigin = z.enum(["typed", "pay_card", "edited", "confirmed"]);
export type PayOrigin = z.infer<typeof PayOrigin>;

export const PacketProvenance = z.object({
  intakeSessionId: z.string().optional(),
  aiRunIds: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  /** What the owner asked for and was told could not be used; the guard keeps it out of every later version too. */
  declinedCriteria: z.array(DeclinedCriterion).optional(),
  flags: z.array(PacketFlag).optional(),
  /** Set by the server from the person who set or confirmed the pay, never by the model. */
  payConfirmedBy: z.object({ by: Actor, at: z.string(), via: PayOrigin }).optional(),
  payOrigin: PayOrigin.optional(),
});
export type PacketProvenance = z.infer<typeof PacketProvenance>;

export const PacketIdentity = z.object({
  title: z.string().min(2),
  department: z.string().optional(),
  locations: z.array(Location).min(1),
  employmentType: EmploymentType,
  schedule: z.string().optional(),
  /** Older versions were stored without it and read as on site; a new job is never published without a person's answer. */
  remotePolicy: RemotePolicy.default("onsite"),
});
export const PacketDescription = z.object({ publicJobDescription: z.string().min(50) });
/** The least and most must-haves a job may have. */
export const MUST_HAVES_MIN = 1;
export const MUST_HAVES_MAX = 6;
export const PacketRequirements = z.object({
  mustHaves: z.array(Requirement).min(MUST_HAVES_MIN).max(MUST_HAVES_MAX),
  niceToHaves: z.array(Requirement).max(10).default([]),
});
/** The most skills a job may list beside its must-haves. */
export const COMPETENCIES_MAX = 8;
export const PacketScreening = z.object({
  questions: z.array(ScreeningQuestion).min(SCREENING_QUESTIONS_MIN).max(SCREENING_QUESTIONS_MAX),
  /** The length the invitation and the chat's first page say: about ten minutes. Advertised only; nothing is timed. */
  maxMinutes: z.number().int().min(5).max(30).default(10),
});

/** The job record's fields, as a plain object schema: for code that needs one section's schema. Parse with `RolePacket`. */
export const RolePacketFields = z.object({
  schemaVersion: z.literal(1).default(1),
  identity: PacketIdentity,
  compensation: CompensationGuidance,
  description: PacketDescription,
  requirements: PacketRequirements,
  competencies: z.array(Competency).max(COMPETENCIES_MAX).default([]),
  screening: PacketScreening,
  /** A stored version may hold more than `FORM_QUESTIONS_MAX`; the editor enforces the limit on what a person saves. */
  formQuestions: z.array(FormQuestion).max(40).default([]),
  communication: CommunicationPolicy,
  compliance: CompliancePolicy,
  provenance: PacketProvenance,
});

/**
 * A stored version from before the form had one list of questions gets it from where the questions were kept
 * (`formQuestionsOfStored`). Every other part of an older version parses as it is: sections and fields the record no
 * longer has are dropped, and nothing the record has now is required of a version that lacks it.
 */
const storedPacket = (raw: unknown): unknown => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const packet = raw as Record<string, unknown>;
  return Array.isArray(packet.formQuestions) ? raw : { ...packet, formQuestions: formQuestionsOfStored(packet) };
};

/** The job record. Parses every version ever stored. */
export const RolePacket = z.preprocess(storedPacket, RolePacketFields);
export type RolePacket = z.infer<typeof RolePacket>;

/**
 * A version as it is stored, for a reader that takes the record without parsing it (a candidate's page, the AI
 * interview, an email), with the one thing an older version lacks filled in: the form's list of questions, from where
 * they were kept (`formQuestionsOfStored`). The parser does the same. A job published before the form had one list
 * otherwise read as having none at all, and the application form of that job failed.
 */
export function readStoredPacket<P>(packet: P): P {
  return storedPacket(packet) as P;
}

/**
 * The draft written beside the conversation before the job exists. Pay is optional: a draft carries a range only once a
 * person set or confirmed it; until then the builder says "not set yet" and nothing invents one.
 */
export const DraftRolePacket = z.preprocess(storedPacket, RolePacketFields.extend({ compensation: CompensationGuidance.optional() }));
export type DraftRolePacket = z.infer<typeof DraftRolePacket>;

/**
 * Who sees each part of a job record: "public" is on the job page, "asked" is put to candidates (the form's questions,
 * the AI interview, the lines on every message), "reviewed" is what applications are read against and is never on the
 * job page, "internal" stays with the team. Keys are dotted paths; the longest matching prefix wins (`packetVisibility`).
 */
export type PacketVisibility = "public" | "asked" | "reviewed" | "internal";
export const PACKET_VISIBILITY: Readonly<Record<string, PacketVisibility>> = {
  identity: "public",
  "identity.department": "internal",
  compensation: "public",
  "compensation.discloseRange": "internal",
  "description.publicJobDescription": "public",
  "requirements.mustHaves": "public",
  "requirements.mustHaves.rationale": "reviewed",
  "requirements.niceToHaves": "public",
  "requirements.niceToHaves.rationale": "reviewed",
  competencies: "reviewed",
  "screening.questions": "asked",
  "screening.questions.modelAnswer": "reviewed",
  "screening.maxMinutes": "asked",
  formQuestions: "asked",
  communication: "internal",
  "communication.disclosureText": "asked",
  "communication.humanAlternativeText": "asked",
  compliance: "internal",
  provenance: "internal",
};

/** The plain label for each visibility, as the editor shows it. */
export const PACKET_VISIBILITY_LABEL: Readonly<Record<PacketVisibility, string>> = {
  public: "Candidates see this",
  asked: "Candidates are asked this",
  reviewed: "Used to review applications; not on the job page",
  internal: "Only your team sees this",
};

/** Who sees the part of the record at `path` ("screening.questions[2].question" reads as "screening.questions"). */
export function packetVisibility(path: string): PacketVisibility {
  const parts = path.replace(/\[\d+\]/g, "").split(".");
  for (let n = parts.length; n > 0; n -= 1) {
    const hit = PACKET_VISIBILITY[parts.slice(0, n).join(".")];
    if (hit) return hit;
  }
  return "internal";
}

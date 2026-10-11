import { z } from "zod";
import { Location } from "../domain/common";
import { CompensationBasis, EligibilityRuleType, EmploymentType, RemotePolicy, ScreeningQuestion } from "../domain/role-packet";

/** The job builder's tools around a packet (plan Wave C): change by chat, the requirements check, plain-field edits, the candidate-view preview. */

/** A chat request is a short instruction ("add a must-have: a forklift license"); longer text belongs in the conversation. */
export const PACKET_REVISION_MESSAGE_MAX = 2_000;

/** POST /roles/:id/revisions and POST /intake/sessions/:id/revisions: what to change, in the person's own words. */
export const PacketRevisionRequest = z.object({ message: z.string().trim().min(1).max(PACKET_REVISION_MESSAGE_MAX) }).strict();
export type PacketRevisionRequest = z.infer<typeof PacketRevisionRequest>;

/** POST .../requirements-check/apply: the fixes a person tapped, for the packet the check ran on (`base` from the check). */
export const ApplyRequirementFixes = z.object({ base: z.string().min(1).max(100), fixIds: z.array(z.string().min(1).max(300)).min(1).max(30) }).strict();
export type ApplyRequirementFixes = z.infer<typeof ApplyRequirementFixes>;

/** The least and most screening questions a role may have (the packet's own limits). */
export const SCREENING_QUESTIONS_MIN = 3;
export const SCREENING_QUESTIONS_MAX = 12;

const Money = z.number().nonnegative().max(10_000_000);
/** The tone of the messages candidates get (`communication.tone`). */
const MessageTone = z.enum(["warm", "direct", "formal"]);

/**
 * PATCH /roles/:id/packet: the plain-field editor (C11). Only the fields sent change; everything else is copied from
 * `baseVersion`, which must still be the newest version (someone else may have saved since). The screening questions
 * and the eligibility questions are sent whole, in order: adding, removing and reordering are one list. A question
 * keeps its `key` when it is the same question; a new one has none. Counts are checked on the server with plain words,
 * so the lists here are only bounded loosely.
 */
export const PacketFieldEdit = z.object({
  baseVersion: z.number().int().min(1),
  title: z.string().trim().min(2).max(160).optional(),
  locations: z.array(Location).min(1).max(20).optional(),
  employmentType: EmploymentType.optional(),
  schedule: z.string().trim().max(300).nullable().optional(),
  remotePolicy: RemotePolicy.optional(),
  compensation: z.object({ basis: CompensationBasis.optional(), min: Money.optional(), max: Money.optional(), ceiling: Money.optional() }).strict().optional(),
  screeningQuestions: z.array(z.object({ key: z.string().trim().min(1).max(60).optional(), question: z.string().trim().min(1).max(500), kind: ScreeningQuestion.shape.kind.optional() }).strict()).max(30).optional(),
  eligibility: z.array(z.object({
    key: z.string().trim().min(1).max(60).optional(),
    type: EligibilityRuleType,
    question: z.string().trim().min(1).max(300),
    rationale: z.string().trim().min(1).max(300),
    knockout: z.boolean().optional(),
    expectation: z.record(z.string(), z.unknown()).optional(),
  }).strict()).max(15).optional(),
  dealBreakers: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
  /** A team member who may approve roles; null clears the decision maker. */
  decisionMakerUserId: z.string().min(1).max(64).nullable().optional(),
  tone: MessageTone.optional(),
  changeSummary: z.string().trim().min(1).max(500).optional(),
}).strict();
export type PacketFieldEdit = z.infer<typeof PacketFieldEdit>;

/**
 * What the candidate-view preview of a draft or a version renders (C9; the authenticated job-page preview of Wave D reads
 * the same): the job page and the apply form's questions, as candidates would see them, with what is still missing. Never
 * served on a public page. Only what the public job page itself shows (apps/api/src/pages/job-page.tsx), which since
 * plan D10 lists the must-haves and nice-to-haves (their words only), the benefits and the company's approved text.
 */
export type JobPreviewFact = { key: "location" | "workplace" | "job_type" | "pay" | "schedule"; label: string; text: string };
export type JobPreview = {
  source: { kind: "draft"; sessionId: string } | { kind: "version"; roleId: string; version: number; status: string; current: boolean };
  /** True unless this is the live version of an open role at a company ITS has checked. */
  notPublicYet: boolean;
  banner: string;
  /** `about`: the text about the company a person approved in Setup; never the packet's unapproved blurb. */
  company: { name: string; slug: string; website: string | null; logoUrl: string | null; verified: boolean; about: string | null };
  job: {
    title: string;
    facts: JobPreviewFact[];
    locations: string[];
    description: string;
    /** "What we're looking for" and "Nice to have", in the words the job page lists them. */
    mustHaves: string[];
    niceToHaves: string[];
    /** The benefits block: the role's own description, else the company's from Setup; null when neither is written. */
    benefits: string | null;
    /** "What to expect": applying, the screening conversation, each interview step, the decision. */
    steps: string[];
    notices: Array<{ key: string; text: string }>;
  };
  pay: { shown: boolean; text: string; requiredByLaw: boolean; note: string | null };
  apply: {
    questions: Array<{ key: string; question: string; help: string; answer: "yes_no" | "days" }>;
    notices: Array<{ key: string; text: string }>;
    disclosure: string;
    humanAlternative: string;
  };
  /** What the page is still missing, in plain words ("Pay is not set yet."). */
  gaps: string[];
};

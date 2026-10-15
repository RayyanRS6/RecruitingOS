import { z } from "zod";
import { QuickQuestionKey, WrittenQuestionKey } from "./apply-questions";
import { RolePacket, type DraftRolePacket, type PacketFlag, type PacketVisibility } from "./role-packet";

/**
 * Changing a packet by chat (plan C10) and the requirements check before approval (C16). The assistant or a rule only
 * proposes; a person sees exactly what would change and confirms; only then is anything saved, through the packet guard,
 * as a new version of the role (or into the draft before the role exists).
 */

/** The parts of a packet a chat change may rewrite. Never provenance, approvals or compliance: the server keeps those. */
export const RevisableSection = z.enum(["identity", "business", "compensation", "description", "requirements", "competencies", "evaluation", "screening", "interviews", "communication", "sourcing", "preferences"]);
export type RevisableSection = z.infer<typeof RevisableSection>;

/** What each section is called wherever a person reads it. */
export const REVISABLE_SECTION_LABEL: Readonly<Record<RevisableSection, string>> = {
  identity: "The basics",
  business: "Why you are hiring",
  compensation: "Pay",
  description: "Job description",
  requirements: "Must-haves and eligibility",
  competencies: "What you look for",
  evaluation: "How applicants are judged",
  screening: "Screening questions",
  interviews: "Interview steps",
  communication: "Messages to candidates",
  sourcing: "Where the job is posted",
  preferences: "Your preferences",
};

/** Each section the change touches, written out whole as it should be saved; a section left out stays as it is. */
export const PacketRevisionChanges = z.object({
  identity: RolePacket.shape.identity.optional(),
  business: RolePacket.shape.business.optional(),
  compensation: RolePacket.shape.compensation.optional(),
  description: RolePacket.shape.description.optional(),
  requirements: RolePacket.shape.requirements.optional(),
  competencies: RolePacket.shape.competencies.optional(),
  evaluation: RolePacket.shape.evaluation.optional(),
  screening: RolePacket.shape.screening.optional(),
  interviews: RolePacket.shape.interviews.optional(),
  communication: RolePacket.shape.communication.optional(),
  sourcing: RolePacket.shape.sourcing.optional(),
  preferences: RolePacket.shape.preferences.optional(),
});
export type PacketRevisionChanges = z.infer<typeof PacketRevisionChanges>;

/** A part of the request that was not done, with the plain reason (pay is set on the pay card, wording that is not allowed). */
export const RevisionNotDone = z.object({ request: z.string().trim().min(1).max(300), reason: z.string().trim().min(1).max(400) });
export type RevisionNotDone = z.infer<typeof RevisionNotDone>;

/** What the assistant proposes for one request (prompt `packet.revise`): a section-scoped patch and a plain summary of it. */
export const PacketRevision = z.object({
  /** One or two plain sentences on what would change, in the assistant's own voice ("I added a must-have: ..."). */
  summary: z.string().trim().min(1).max(600),
  changes: PacketRevisionChanges.default({}),
  notChanged: z.array(RevisionNotDone).max(10).default([]),
  /** Asked back instead of changing anything when the request is unclear. */
  question: z.string().trim().max(400).optional(),
});
export type PacketRevision = z.infer<typeof PacketRevision>;

/* ------------------------------------------------------------------------------------------------------------------ */
/* What changed between two versions (or between the packet and a proposed change): every field in plain words.        */
/* ------------------------------------------------------------------------------------------------------------------ */

export type PacketDiffChange = {
  /** Dotted path of the field ("requirements.mustHaves[mh_2]" names an item by its key). */
  path: string;
  label: string;
  kind: "added" | "removed" | "changed";
  before: string | null;
  after: string | null;
  /** Who sees this part: on the job page, asked of candidates, or only the team (C15). */
  visibility: PacketVisibility;
};
export type PacketDiffSection = { section: string; label: string; changes: PacketDiffChange[] };
export type PacketDiff = { from: number | null; to: number | null; sections: PacketDiffSection[]; total: number };

/** A proposed change by chat, as the page shows it before anyone confirms (C10). Nothing is saved yet. */
export type PacketRevisionProposal = {
  /** Confirm or set aside the change with this id (the assistant run that wrote it). */
  revisionId: string;
  target: { kind: "role"; roleId: string; baseVersion: number } | { kind: "draft"; sessionId: string };
  summary: string;
  question: string | null;
  notChanged: RevisionNotDone[];
  sections: RevisableSection[];
  diff: PacketDiff;
  /** The wording checks the changed packet would carry that nobody has dealt with yet, and which of those are new. */
  flags: PacketFlag[];
  newFlags: PacketFlag[];
  /** What the packet guard would fix by rule on saving ("The private ceiling was raised to the top of the range."). */
  guardChanges: string[];
  /** What confirming does: a draft is changed in place; a role gets a new version that takes effect now, after approval, or with the role. */
  takesEffect: "draft" | "now" | "after_approval" | "with_the_role";
  packet: DraftRolePacket;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* "Questions every applicant answers" (Wave S7): the company's quick questions and written questions, set on a job.    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What the job's Scoring tab calls the company's questions, and its two lists. */
export const COMPANY_QUESTIONS_LABEL = "Questions every applicant answers";
export const QUICK_QUESTIONS_LABEL = "Quick questions, on the application form";
export const WRITTEN_QUESTIONS_LABEL = "Written questions, asked in the chat";

/** The packet's own limits (`CompanyQuestions`): eight quick questions, five written ones, two to eight choices each. */
export const QUICK_QUESTIONS_MAX = 8;
export const WRITTEN_QUESTIONS_MAX = 5;
export const CHOICE_OPTIONS_MIN = 2;
export const CHOICE_OPTIONS_MAX = 8;

const EditedChoice = z.object({
  kind: z.literal("choice"),
  key: QuickQuestionKey.optional(),
  question: z.string().trim().min(3, "Write the question (at least three letters).").max(200),
  help: z.string().trim().max(200).optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(80)).max(20),
}).strict();
const EditedNumber = z.object({
  kind: z.literal("number"),
  key: QuickQuestionKey.optional(),
  question: z.string().trim().min(3, "Write the question (at least three letters).").max(200),
  help: z.string().trim().max(200).optional(),
  required: z.boolean().optional(),
  unit: z.string().trim().max(30).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict();

/**
 * PUT /roles/:id/company-questions: the questions every applicant answers, sent whole, in order (adding, removing and
 * reordering are one list). `quick` are the form's choice and number questions (the yes/no questions that may hold an
 * application stay the eligibility questions, changed in the editor); a yes-or-no question that holds nobody is a choice
 * of "Yes" and "No". `written` are asked in the chat and written up from the candidate's own words; `lookFor` (what a
 * good answer shows) is for the chat and the team only, never a candidate. A list left out stays as it is. A question
 * keeps its `key` when it is the same question; a new one has none. Starts from `baseVersion`, which must still be the
 * newest version. Counts and choices are checked on the server with plain words, and every question passes the fairness
 * check first: one that asks about a protected characteristic is refused, with the reason and the lawful alternative.
 */
export const CompanyQuestionsEdit = z.object({
  baseVersion: z.number().int().min(1),
  quick: z.array(z.discriminatedUnion("kind", [EditedChoice, EditedNumber])).max(20).optional(),
  written: z.array(z.object({
    key: WrittenQuestionKey.optional(),
    question: z.string().trim().min(5, "Write the question (at least five letters).").max(400),
    required: z.boolean().optional(),
    lookFor: z.string().trim().max(400).optional(),
  }).strict()).max(20).optional(),
  changeSummary: z.string().trim().min(1).max(500).optional(),
}).strict();
export type CompanyQuestionsEdit = z.infer<typeof CompanyQuestionsEdit>;

/** One refused part of a question, as the 422 `question_not_allowed` answer lists them (`details.problems`). */
export type CompanyQuestionRefusal = { list: "quick" | "written"; index: number; key: string | null; part: "question" | "help" | "option" | "lookFor"; rule: string; text: string; reason: string; alternative: string; words: string };

/* ------------------------------------------------------------------------------------------------------------------ */
/* The requirements check before approval (C16): suggestions only, never a score, nothing changes until a person taps. */
/* ------------------------------------------------------------------------------------------------------------------ */

export const RequirementCheckKind = z.enum(["unprovable", "trait_as_skill", "duplicate", "proxy", "max_years"]);
export type RequirementCheckKind = z.infer<typeof RequirementCheckKind>;

export const REQUIREMENT_CHECK_TITLE: Readonly<Record<RequirementCheckKind, string>> = {
  unprovable: "Hard to check before someone starts",
  trait_as_skill: "A personality trait, not a skill",
  duplicate: "Said twice",
  proxy: "May shut people out unfairly",
  max_years: "A cap on experience",
};

/** One tap that fixes a suggestion: take the item out, reword it, or ask about it in the interview instead. */
export type RequirementFix = { id: string; label: string; op: "remove" | "replace_text" | "to_interview"; after: string | null };

export type RequirementSuggestion = {
  id: string;
  kind: RequirementCheckKind;
  title: string;
  /** Where the words are, e.g. "requirements.mustHaves[mh_2]" or "screening.questions[pay]". */
  path: string;
  text: string;
  why: string;
  fixes: RequirementFix[];
  /** The packet guard's flag on the same words, when there is one: applying a fix clears it too. */
  flagId: string | null;
};

export type RequirementsCheck = {
  /** What the check ran on ("v3", or the draft's fingerprint); fixes are applied only to that same packet. */
  base: string;
  version: number | null;
  suggestions: RequirementSuggestion[];
  summary: string;
};

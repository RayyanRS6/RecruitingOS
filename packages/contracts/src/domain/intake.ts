import { z } from "zod";
import { Actor, Confidence } from "./common";
import { CompensationBasis, PayBenchmark, PayOrigin, type DraftRolePacket, type PacketFlag } from "./role-packet";

/** What an owner message is: words typed (the default), a pasted job ad, the summary of tapped answers, or "hire again". */
export const IntakeMessageKind = z.enum(["text", "pasted_ad", "answers", "hire_again"]);
export type IntakeMessageKind = z.infer<typeof IntakeMessageKind>;

export const IntakeMessage = z.object({
  role: z.enum(["owner", "assistant", "system"]),
  content: z.string(),
  at: z.string(),
  aiRunId: z.string().optional(),
  kind: IntakeMessageKind.optional(),
});
export type IntakeMessage = z.infer<typeof IntakeMessage>;

/** The first message can be a pasted job ad (C5); every later message is a turn of conversation. */
export const INTAKE_FIRST_MESSAGE_MAX = 20_000;
export const INTAKE_MESSAGE_MAX = 4_000;

/** Where an answer offered on a question card came from: the owner's own words, our playbook, market pay data, the team, or the assistant's own idea. */
export const IntakeOptionOrigin = z.enum(["owner", "playbook", "benchmark", "team", "assistant"]);
export type IntakeOptionOrigin = z.infer<typeof IntakeOptionOrigin>;

/** An answer offered on a card that the owner left unticked: kept for reference, never a requirement (C6). */
export const IntakeSuggestion = z.object({ field: z.string(), text: z.string(), origin: IntakeOptionOrigin });
export type IntakeSuggestion = z.infer<typeof IntakeSuggestion>;

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
  /** What the person would own first, in the owner's words. */
  responsibilities: z.array(z.string()).optional(),
  /** Screening questions the owner added on a question card. */
  screeningQuestions: z.array(z.string()).optional(),
  /**
   * Set only by the server, from a team card or the panel (C15): the decision maker and the interviewers as team members.
   * The model's copy of these, and of `suggestions`, is dropped before its facts are merged.
   */
  decisionMakerUserId: z.string().optional(),
  interviewerUserIds: z.array(z.string()).optional(),
  suggestions: z.array(IntakeSuggestion).optional(),
});
export type IntakeFacts = z.infer<typeof IntakeFacts>;

export const IntakeMissingFact = z.enum([
  "title",
  "location",
  "employment_type",
  "schedule",
  "reason_for_hire",
  "compensation_basis",
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
export type IntakeMissingFact = z.infer<typeof IntakeMissingFact>;

/** Which fact a card's answer sets. */
export const IntakeQuestionField = z.enum([
  "title",
  "location",
  "employment_type",
  "schedule",
  "remote_policy",
  "reason_for_hire",
  "compensation_basis",
  "compensation",
  "responsibilities",
  "must_haves",
  "nice_to_haves",
  "eligibility",
  "interviewers",
  "decision_maker",
  "timeline",
  "what_failure_looks_like",
  "deal_breakers",
  "screening_questions",
  "benefits",
]);
export type IntakeQuestionField = z.infer<typeof IntakeQuestionField>;

/** single: tap one; multi: tick any; free: type; team: tap team members; pay: the pay card (basis, range, ceiling). */
export const IntakeQuestionMode = z.enum(["single", "multi", "free", "team", "pay"]);
export type IntakeQuestionMode = z.infer<typeof IntakeQuestionMode>;

export const IntakeQuestionOption = z.object({ label: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(500), origin: IntakeOptionOrigin });
export type IntakeQuestionOption = z.infer<typeof IntakeQuestionOption>;

/**
 * One question card (C6). The server gives every card its id, fills team cards with the real team, clears the options
 * of a pay card (the pay card is drawn from `pay` on the session), and drops any offered answer that fails the fairness
 * check before the card is stored or shown.
 */
export const IntakeQuestion = z.object({
  id: z.string().trim().min(1).max(60),
  field: IntakeQuestionField,
  prompt: z.string().trim().min(1).max(300),
  mode: IntakeQuestionMode,
  options: z.array(IntakeQuestionOption).max(8).default([]),
  /** Whether the card offers "add your own". */
  allowOwn: z.boolean().default(true),
  /** One plain sentence on why this is asked. */
  why: z.string().trim().max(300).optional(),
});
export type IntakeQuestion = z.infer<typeof IntakeQuestion>;

/** One assistant turn of the intake conversation (intake.turn v2). */
export const IntakeTurn = z.object({
  assistantMessage: z.string().min(1),
  factsExtracted: IntakeFacts,
  missingFacts: z.array(IntakeMissingFact),
  /** Up to three question cards, the most important first. The owner can always ignore them and type. */
  questions: z.array(IntakeQuestion).max(3).default([]),
  /** The assistant's view that there is enough to write the first draft. The server decides with `readiness`. */
  readyToCompile: z.boolean(),
  confidence: Confidence,
  /** The first message is not about opening a role (a question about the day, say): the session is not kept as a draft. */
  notARole: z.boolean().default(false),
  /** What was taken from a pasted job ad, one plain line each ("Title: Front desk coordinator"). */
  takenFromAd: z.array(z.string().max(300)).max(20).default([]),
});
export type IntakeTurn = z.infer<typeof IntakeTurn>;

/** The cheap read of a long first message before the pay check (C5): only what the text states, nothing guessed. */
export const IntakeExtraction = z.object({
  isJobDescription: z.boolean(),
  title: z.string().max(160).optional(),
  locationText: z.string().max(200).optional(),
  employmentType: z.string().max(40).optional(),
  schedule: z.string().max(300).optional(),
  compensationBasis: CompensationBasis.optional(),
  compensationMin: z.number().nonnegative().optional(),
  compensationMax: z.number().nonnegative().optional(),
});
export type IntakeExtraction = z.infer<typeof IntakeExtraction>;

/** Who set or confirmed the pay, and the figures they settled; the approval gate compares these with the facts (C7). */
export const IntakePayConfirmation = z.object({
  by: Actor,
  at: z.string(),
  via: PayOrigin,
  basis: CompensationBasis,
  min: z.number(),
  max: z.number(),
  ceiling: z.number().optional(),
});
export type IntakePayConfirmation = z.infer<typeof IntakePayConfirmation>;

/**
 * Where the writing of a draft has got, each recorded as it starts: the market check, the model writing, then the checks
 * and the save (one transaction, so no separate "saving" step is ever seen), then done (saved) or failed.
 */
export const IntakeProgressStage = z.enum(["benchmark", "writing", "checking", "done", "failed"]);
export type IntakeProgressStage = z.infer<typeof IntakeProgressStage>;

/**
 * What the server keeps about a draft beside the conversation (intake_sessions.server_state, migration 0030). Nothing
 * here comes from the model: the pay confirmation, the last market figure, the open question cards, the pasted ad's
 * place in the transcript, what the person removed (so the assistant cannot put it back), and the drafting progress.
 */
export const IntakeServerState = z.object({
  pay: IntakePayConfirmation.optional(),
  benchmark: PayBenchmark.nullable().optional(),
  /** Why there is no market figure: the pay basis is not known yet, or there is no figure for this job and place. */
  benchmarkGap: z.enum(["basis_unknown", "no_market_figure"]).optional(),
  ad: z.object({ messageIndex: z.number().int(), chars: z.number().int(), extracted: z.boolean().default(false), takenFromAd: z.array(z.string()).default([]) }).optional(),
  openQuestions: z.array(IntakeQuestion).default([]),
  answeredRounds: z.number().int().default(0),
  draftRequestedAt: z.string().optional(),
  removed: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
  /** Deal-breakers already offered back as must-haves (C17), so each is offered once. */
  dealBreakersOffered: z.array(z.string()).default([]),
  progress: z.object({ stage: IntakeProgressStage, startedAt: z.string(), at: z.string() }).optional(),
  /**
   * The draft as last written: when, by which run, for whom, the pay it was written with, a key of the answers the
   * assistant wrote it from (`draftFactsKey`: answers changed since make it out of date), and how many changes were saved
   * on it since (by chat or with a fix), which writing it again would replace.
   */
  draft: z.object({ at: z.string(), aiRunId: z.string(), by: Actor, payKey: z.string().nullable(), factsKey: z.string().optional(), edits: z.number().int().default(0) }).optional(),
  fromRole: z.object({ roleId: z.string(), version: z.number().int(), title: z.string() }).optional(),
});
export type IntakeServerState = z.infer<typeof IntakeServerState>;

/** The six things a role needs before anyone is asked to approve it (founder decision Q8). */
export const INTAKE_ESSENTIALS = ["title", "location", "compensation_range", "reason_for_hire", "interviewers", "decision_maker"] as const;
export type IntakeEssentialKey = (typeof INTAKE_ESSENTIALS)[number];

/** Computed on the server from the facts and the server state; the page never guesses it (C7). */
export type IntakeReadiness = {
  essentials: Array<{ key: IntakeEssentialKey; label: string; done: boolean; value: string | null; note: string | null }>;
  missing: IntakeEssentialKey[];
  payConfirmed: boolean;
  /** Whether "Draft it" may run: the essentials are in, the person asked for a draft, or one round of cards was answered. */
  mayDraft: boolean;
  draftBlocker: string | null;
  hasDraft: boolean;
  /** Answers changed after the draft was written in a way only writing it again can carry (pay, the team and deal-breakers carry over by themselves). */
  draftOutOfDate: boolean;
  /** Changes saved on the draft since it was written (by chat or with a fix): writing it again replaces them. */
  draftEdits: number;
  openFlags: number;
  /** Whether "Ask for approval" works: a written, up-to-date draft, the six essentials, pay a person set or confirmed, and no open wording check. */
  mayAskForApproval: boolean;
  approvalBlockers: string[];
};

/** The pay card (C8): the market figure for the job and place with its source, or a plain line saying there is none. */
export type IntakePayCard = {
  basis: "hourly" | "salary" | null;
  benchmark: (PayBenchmark & { label: string }) | null;
  gap: { reason: "basis_unknown" | "no_market_figure"; message: string } | null;
  stated: { min: number | null; max: number | null; ceiling: number | null };
  confirmed: { byName: string | null; at: string; via: PayOrigin } | null;
  belowMarket: boolean;
  summary: string;
};

/** A draft as the job builder reads it (GET /intake/sessions/:id and every intake answer). */
export type IntakeSessionView = {
  id: string;
  status: string;
  roleId: string | null;
  createdAt: string;
  updatedAt: string;
  startedBy: { userId: string | null; name: string | null; mine: boolean };
  messages: IntakeMessage[];
  facts: IntakeFacts;
  missingFacts: string[];
  questions: IntakeQuestion[];
  readiness: IntakeReadiness;
  pay: IntakePayCard;
  draft: DraftRolePacket | null;
  flags: PacketFlag[];
  ad: { chars: number; takenFromAd: string[] } | null;
  fromRole: { roleId: string; version: number; title: string } | null;
  progress: { stage: IntakeProgressStage; startedAt: string; at: string } | null;
};

/** One line of the drafts list (GET /intake/sessions). */
export type IntakeSessionSummary = {
  id: string;
  status: string;
  title: string | null;
  startedBy: { userId: string | null; name: string | null };
  mine: boolean;
  createdAt: string;
  updatedAt: string;
  ownerMessages: number;
  hasDraft: boolean;
  missing: IntakeEssentialKey[];
};

/**
 * Room on the plan for another role (C13): checked when the page opens and before any assistant run. `trialEnded`: the
 * company's trial has ended (founder decision L-02 B), so no new job starts until a plan is chosen; `message` says so.
 */
export type PlanRoom = { ok: boolean; limit: number | null; used: number; holding: Array<{ roleId: string; title: string; status: string }>; message: string | null; trialEnded?: boolean };

/** What the server refused from an answer or an edit: a value that failed the fairness check, with the reason and a lawful alternative. */
export type IntakeRefusal = { field: string; text: string; reason: string; alternative: string | null };

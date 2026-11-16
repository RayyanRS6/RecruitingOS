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
  /**
   * Set only by the server: the owner went through the questions for the form (the quick start's step 9, `patch.
   * formQuestionsChosen`), or, on "hire again", the old job's form questions are carried as the owner's choice
   * (`packetToFacts`), so `eligibilityNotes` holds the ones they chose and `suggestions` with field "eligibility" the
   * ones they left unticked (on hire again, the ones the old form left off for a deal-breaker it counted openly), and the
   * draft's form has exactly the chosen ones (intake.compile v6). Without it the draft starts from the playbook's typical
   * questions. Never in what intake.turn extracts (`IntakeTurn`), so the model cannot set it (review of the live-test
   * fixes, 12 Nov 2026: a note the assistant read from a sentence made the form "exactly" that one question).
   */
  formQuestionsChosen: z.boolean().optional(),
});
export type IntakeFacts = z.infer<typeof IntakeFacts>;

/** "No …", "Without …", "Lacks …", "Missing …" or "Does not have …", and what follows (an "a", "any" or "the" aside). */
const LACKS = /^(?:no|without|lacks?|lacking|missing|(?:does|do)(?:\s+not|n['’]t)\s+(?:have|hold))\s+(?:an?\s+|any\s+|the\s+)?(.+)$/i;

/**
 * A licence, licensure, certificate, certification, permit, registration or credential named last ("…RDA license",
 * "…BLS certifications."). A short form alone is not one ("No RDA", "No x-ray cert"): the owner writes what they need.
 */
const CREDENTIAL_LAST = /\b(?:licen[cs]es?|licensure|certificates?|certifications?|permits?|registrations?|credentials?)\.?$/i;

/**
 * Words that say the credential is not in force, or that name the problem itself ("expired", "unlicensed", "license
 * issues", "registered sex offenders", "one without a licence", "points", "a DUI"): after "No" they are what rules
 * someone out, so dropping the "No" would ask for it (review of the live test, 12 Nov 2026: "No expired RDH license"
 * became "Expired RDH license"). A word family counts in any of its forms ("suspended", "suspension"; "revoked",
 * "revocation"; "lapsed", "a lapse"), as the review of that fix found the noun forms turned round. Words that only begin
 * with the letters (under, unit, union, uniform, unique, universal) are not un- words.
 */
const NOT_IN_FORCE = /\b(?!under|unit|union|uniform|unique|univers)un[a-z]|\bnon[-\s]?[a-z]|\b(?:expir\w*|laps\w*|suspen\w*|revo[ck]\w*|restrict\w*|probation\w*|pending|inactive|invalid|provisional|temporary|conditional|hardship|encumb\w*|foreign|learner(?:['’]?s)?|out[-\s]of[-\s]state|issues?|problems?|gaps?|violations?|sanction\w*|disciplin\w*|complaints?|points?|tickets?|citations?|accidents?|DUIs?|DWIs?|denials?|denied|offen[cs]\w*|felon\w*|convict\w*|criminal|arrest\w*|records?|without|lacking|missing|no|not|never)\b/i;

/**
 * A word that joins something to the credential named last ("points on driver's license", "a lapse in BLS
 * certification", "board action against license", "a license that has expired"): what it joins is what rules someone
 * out, so the words are no credential to turn round (review of the must-haves fix, 12 Nov 2026: "No points on driver's
 * license" became "Points on driver's license"). A whole word only, never inside one with a hyphen ("in-state").
 */
const LINKED = /(?:^|\s)(?:of|on|in|at|against|with|from|for|by|that|which|who|whose)(?=[\s,.;:!?]|$)/i;

/** "Cannot be …" and "Cannot have …" are rules ("Cannot be late"), not what someone is unable to do: never turned round. */
const CANNOT_BE = /^(?:cannot|can\s+not|can['’]t)\s+(?:be|have)\b/i;

/**
 * What the employer does to the people applying, after "Cannot …", "Unable to …" and the like ("Can't accept applicants
 * without a license", "Unable to sponsor visas", a word such as "currently" before the verb too): the owner's rule, not
 * what the candidate cannot do, so "Able to …" would be nonsense the AI interview then asks about. "Take" and "use" count
 * here, unlike after "Won't …", so "Can't take x-rays" is asked of the owner as what they need (lead's decision, 17 Nov
 * 2026, on what the repair of the must-haves left out).
 */
const EMPLOYER_DOES = /^(?:[a-z]+ly\s+)?(?:accept|hire|take|consider|employ|interview|on[-\s]?board|sponsor|bring\s+on(?:[-\s]?board)?|use|allow|offer|pay)\b/i;

/** Words naming the people applying ("anyone who smokes", "new hires"): after "Cannot …" the words are then a rule about them. */
const NAMES_APPLICANTS = /\b(?:applicants?|candidates?|anyone|anybody|someone|somebody|people|those|hires?)\b/i;

/**
 * What only the employer does, after "Won't …" ("Won't hire smokers", "Will not accept applicants without a CDL"): the
 * words are the owner's rule, not something the candidate will not do, so "Willing to …" would be its opposite (review of
 * the must-haves fix, 12 Nov 2026). Never "take", which a candidate does too ("Won't take weekend shifts").
 */
const EMPLOYER_VERB = /^(?:hire|accept|consider|tolerate|allow|employ|interview|permit|sponsor|train|pay|offer|provide)\b/i;

/**
 * A deal-breaker as the must-have it rules people out on (live test, 12 November 2026: "No active California RDA
 * license" became a must-have in those very words, so the job page asked for the opposite and nobody was held). Only
 * clear shapes are turned round: "No …", "Without …", "Lacks …", "Missing …" or "Does not have …" a licence, certificate,
 * permit, registration or credential named last (`lacksCredential`), with no word saying it is not in force or naming the
 * problem itself (`NOT_IN_FORCE`) and none joining something to it (`LINKED`); "Cannot …" or "Unable to …" ("Able to
 * …") about what the candidate does, never "Cannot be …" or "Cannot have …", nor what the employer does to the people
 * applying (`EMPLOYER_DOES`, "Can't accept applicants without a license") or words naming them (`NAMES_APPLICANTS`,
 * "Cannot let anyone without a license start"); "Not licensed …", "Not available …" and the like; "Won't …" ("Willing to
 * …"), never "Won't hire …", "Won't accept …" or another verb only the employer does (`EMPLOYER_VERB`). Anything else
 * comes back as typed (never its opposite: review of the live test, 12 Nov 2026, and of its fix), so "No recent grads"
 * is still refused by the fairness check, and words that still rule someone out (`rulesOut`) are asked of the owner as
 * what they need (the quick start's "As a must-have", and the job builder's card, which names them).
 */
export function mustHaveOf(dealBreaker: string): string {
  const t = dealBreaker.trim().replace(/\s+/g, " ");
  const up = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const lacks = t.match(LACKS);
  if (lacks) return lacksCredential(t) ? up(lacks[1]) : t;
  const cannot = t.match(/^(?:cannot|can\s+not|can['’]t|unable\s+to|not\s+able\s+to)\s+(.+)$/i);
  if (cannot) return CANNOT_BE.test(t) || EMPLOYER_DOES.test(cannot[1]) || NAMES_APPLICANTS.test(cannot[1]) ? t : `Able to ${cannot[1]}`;
  const not = t.match(/^not\s+((?:licen[cs]ed|certified|registered|authori[sz]ed|available|eligible)\b.*)$/i);
  if (not) return up(not[1]);
  const wont = t.match(/^(?:won['’]t|will\s+not|unwilling\s+to|not\s+willing\s+to)\s+(.+)$/i);
  if (wont) return EMPLOYER_VERB.test(wont[1]) ? t : `Willing to ${wont[1]}`;
  return t;
}

/**
 * Whether words name a credential someone lacks ("No x-ray permit", "Without a current BLS certification"): the shape
 * `mustHaveOf` turns round by its first branch, a licence, certificate, permit, registration or credential named last
 * with nothing saying it is not in force (`NOT_IN_FORCE`) and nothing joined to it ("No points on driver's license",
 * `LINKED`). It is the one shape safe to turn round whoever wrote the words: "Cannot …", "Won't …" and "Not registered
 * …" can be a rule worded in the negative ("Will not share patient information", "Not registered as a sex offender"),
 * which the requirements check turns round only when they are a deal-breaker's own words (review of the hire-again fix,
 * 12 Nov 2026).
 */
export function lacksCredential(text: string): boolean {
  const lacks = text.trim().replace(/\s+/g, " ").match(LACKS);
  return !!lacks && CREDENTIAL_LAST.test(lacks[1]) && !NOT_IN_FORCE.test(lacks[1]) && !LINKED.test(lacks[1]);
}

/**
 * The must-haves a deal-breaker can come back as: the requirement it rules people out on (`mustHaveOf`), and its words
 * with the leading "No", "Without" and the like dropped, which can say the opposite ("No felonies or license
 * suspensions" as "Felonies or license suspensions"). A deal-breaker the fairness check refuses is refused in each of
 * them too, with the same reason (review of the live test, 12 Nov 2026).
 */
export function restatementsOf(dealBreaker: string): string[] {
  const t = dealBreaker.trim().replace(/\s+/g, " ");
  const rest = t.match(LACKS)?.[1];
  const out = [mustHaveOf(t), ...(rest ? [rest.charAt(0).toUpperCase() + rest.slice(1)] : [])];
  return out.filter((x, i) => out.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);
}

/** No, not, never, without, lacks, missing, cannot, can't, won't, unable, unwilling, does not, don't, must not, at the start (any case, apostrophe or not). */
const RULES_OUT = /^(?:no|not|never|without|lacks?|lacking|missing|cannot|can\s+not|can['’]?t|won['’]?t|will\s+not|unable|unwilling|(?:does|do)(?:\s+not|n['’]?t)|must\s+not|mustn['’]?t)\b/i;

/**
 * Whether words rule someone out ("No RDA", "Cant work weekends", "Must not smoke"). A deal-breaker still worded so is
 * never offered or filled in as a must-have: the quick start asks the owner for what they need, and the job builder's
 * card gives it no ready-made option and names it for the owner to write (review of the live test, 12 Nov 2026, and of
 * its fix). A stored must-have can still read so (a pick on a deal-breaker card stored before 12 Nov 2026, kept as it is,
 * or words the owner typed on a card or the panel): the requirements check flags it (`rules_out`).
 */
export function rulesOut(text: string): boolean {
  return RULES_OUT.test(text.trim());
}

/** The legal right to work, in any words ("Are you authorized to work in the U.S.?", "…require visa sponsorship?"). */
const ABOUT_THE_RIGHT_TO_WORK = /\b(?:authori[sz]ed|eligible|permitted|allowed|entitled)\s+to\s+(?:legally\s+)?work\b|\bright\s+to\s+work\b|\bwork\s+authori[sz]ation\b|\bsponsorship\b/i;
/** Being available, the schedule, shifts, the regular hours, or which days or hours they can work ("Can you work Saturdays?"). */
const ABOUT_THE_SCHEDULE = /\bavailab\w*|\bschedul\w*|\bshifts?\b|\bweekends?\b|\bweekdays?\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b|\bwhich (?:of (?:these|the) )?days\b|\bwhat days\b|\b(?:days|hours) (?:a|per) (?:week|day)\b|\b(?:posted|standard|regular|normal|usual|business|office)\s+hours\b|\bovertime\b|\bon[\s-]call\b|\bwork(?:ing)? (?:on |the |a |an |during )?(?:nights?|evenings?|mornings?|holidays?|hours)\b/i;
/** …never when they could start, how they get to the workplace, a licence or a certificate, or a physical task. */
const NOT_THE_SCHEDULE = /\bstart\b|\bget to\b|\bcommut\w*|\btranspor\w*|\blicen[cs]\w*|\bcertif\w*|\blift\w*|\bcarry\w*|\bstand(?:ing)?\b|\bpounds?\b|\blbs?\b/i;

/**
 * The kind of rule a question for the form asks, read from its words, for the two kinds a model words its own way and no
 * short form names: the schedule ("Are you available for the days this office is open?", "Which of these days can you
 * work: Mon, Tue, Wed?") and the right to work ("Are you authorized to work in the U.S.?"). Null for any other question,
 * a start date ("Can you start within 30 days?"), getting to the workplace ("Can you get to the workplace on the days the
 * job needs?") and a physical task ("Can you stand for an 8-hour shift?") among them. The job builder's backstop for a
 * question left unticked and the quick start's offer of the assistant's questions both read it (review of the live-test
 * fixes, 12 Nov 2026).
 */
export function askedKind(question: string): "schedule_availability" | "work_authorization" | null {
  if (ABOUT_THE_RIGHT_TO_WORK.test(question)) return "work_authorization";
  if (ABOUT_THE_SCHEDULE.test(question) && !NOT_THE_SCHEDULE.test(question)) return "schedule_availability";
  return null;
}

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

/**
 * One assistant turn of the intake conversation (intake.turn v2). What it extracts is the facts without the marker only
 * the server sets (`formQuestionsChosen`): the model is never asked for it, and a copy it wrote anyway is dropped.
 */
export const IntakeTurn = z.object({
  assistantMessage: z.string().min(1),
  factsExtracted: IntakeFacts.omit({ formQuestionsChosen: true }),
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
  /**
   * What is never asked on a card again in this draft (staging, 20 Oct 2026: pay, the interviewers and the company were
   * asked twice): the field of every card already shown (answered, skipped or left), and of every fact the owner set on
   * the panel. Server-kept; the assistant is told the list and the server drops any card that asks one of them.
   */
  settledFields: z.array(IntakeQuestionField).default([]),
  /**
   * The single-value facts the owner gave on a card (not skipped), set or cleared on the panel, or changed on the written
   * draft (`answersFollowingChange`), by name (locationText, reason…): the assistant never changes those on a turn that
   * follows answers alone; a correction the owner types still goes through.
   */
  answeredFacts: z.array(z.string()).default([]),
  /** The wording of every card shown in this draft (the latest 60): a card that asks one of them again under another field is dropped. */
  askedPrompts: z.array(z.string()).default([]),
  draftRequestedAt: z.string().optional(),
  removed: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
  /** Deal-breakers already offered back as must-haves (C17), so each is offered once. */
  dealBreakersOffered: z.array(z.string()).default([]),
  progress: z.object({ stage: IntakeProgressStage, startedAt: z.string(), at: z.string() }).optional(),
  /**
   * The draft as last written: when, by which run, for whom, the pay it was written with, a key of the answers the
   * assistant wrote it from (`draftFactsKey`: answers changed since make it out of date), and how many changes saved on it
   * since (by chat or with a fix) writing it again would replace part of: a change the answers took in too is not counted.
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
  /** Answers changed after the draft was written in a way only writing it again can carry (pay, why you are hiring, the team and deal-breakers carry over by themselves). */
  draftOutOfDate: boolean;
  /**
   * Changes saved on the draft since it was written (by chat or with a fix) that writing it again would replace part of;
   * one to the title, the schedule, full or part time, the work model, why you are hiring or the wording of a must-have or
   * nice-to-have went into the answers too, so it is not counted.
   */
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
export type PlanRoom = { ok: boolean; limit: number | null; used: number; holding: Array<{ roleId: string; title: string; status: string }>; message: string | null; trialEnded?: boolean; /** The plan's jobs are all used for good, or its AI help is too low for a new job: closing one would not help, so the only way on is to upgrade. */ upgrade?: boolean; /** It is the AI help that ran out: the Upgrade asks about that (`AI_HELP_UPGRADE_QUESTION`). */ aiHelp?: boolean; /** On the last plan nothing is above theirs (`mayOfferUpgrade`): the same request opens the same sheet, and its button says "Talk to ITS". */ nothingAbove?: boolean };

/** What the server refused from an answer or an edit: a value that failed the fairness check, with the reason and a lawful alternative. */
export type IntakeRefusal = { field: string; text: string; reason: string; alternative: string | null };

import { z } from "zod";
import { Actor } from "./common";
import type { LegalCheck, PublishCheck } from "./publishing";
import { CompensationBasis, PayOrigin, type DraftRolePacket, type PacketFlag } from "./role-packet";

/**
 * The job builder ("intake" in code). One way in: the company types a short idea or pastes an ad. The AI works out what
 * is missing and asks for it on question cards, at most three at a time; the server decides what is still missing and
 * filters the cards. When the essentials are in, "Write the job" has the AI write the job description and the structured
 * posting; a person checks and edits every field in the one editor; "Publish job" opens it. A job does not exist until
 * it is published: until then it is a draft that belongs to the person who started it.
 */

/** What an owner message is: words typed (the default), a pasted job ad, or the summary of tapped answers. */
export const IntakeMessageKind = z.enum(["text", "pasted_ad", "answers"]);
export type IntakeMessageKind = z.infer<typeof IntakeMessageKind>;

export const IntakeMessage = z.object({
  role: z.enum(["owner", "assistant", "system"]),
  content: z.string(),
  at: z.string(),
  aiRunId: z.string().optional(),
  kind: IntakeMessageKind.optional(),
});
export type IntakeMessage = z.infer<typeof IntakeMessage>;

/** The first message can be a pasted job ad; every later message is a turn of conversation. */
export const INTAKE_FIRST_MESSAGE_MAX = 20_000;
export const INTAKE_MESSAGE_MAX = 4_000;

/** Where an answer offered on a question card came from: the owner's own words, or the assistant's own idea. */
export const IntakeOptionOrigin = z.enum(["owner", "assistant"]);
export type IntakeOptionOrigin = z.infer<typeof IntakeOptionOrigin>;

/** Facts the job builder has established so far. Every field optional; the assistant asks for what is missing. */
export const IntakeFacts = z.object({
  title: z.string().optional(),
  locationText: z.string().optional(),
  employmentType: z.string().optional(),
  schedule: z.string().optional(),
  /** On site, hybrid or remote. Asked, never assumed: it is set only by the owner's words or a card they answered. */
  remotePolicy: z.string().optional(),
  compensationBasis: z.string().optional(),
  compensationMin: z.number().optional(),
  compensationMax: z.number().optional(),
  benefits: z.string().optional(),
  mustHaves: z.array(z.string()).default([]),
  niceToHaves: z.array(z.string()).default([]),
  /** What the owner wants asked on the application form, one plain line each; the job's writing turns each into a yes/no question. */
  formQuestions: z.array(z.string()).default([]),
  /** What rules someone out, in the owner's words. Each one becomes the must-have it stands for (`mustHaveOf`); none is kept as it is. */
  dealBreakers: z.array(z.string()).default([]),
  /** Criteria the owner asked for that the assistant declined to build in, with the reason given. */
  declinedCriteria: z.array(z.object({ requested: z.string(), reason: z.string(), alternative: z.string().optional() })).default([]),
  /** What the person would own first, in the owner's words. */
  responsibilities: z.array(z.string()).optional(),
  /** Questions the owner wants the AI interview to ask. */
  screeningQuestions: z.array(z.string()).optional(),
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
 * someone out, so dropping the "No" would ask for it ("No expired RDH license" must never become "Expired RDH license").
 * A word family counts in any of its forms ("suspended", "suspension"; "revoked", "revocation"; "lapsed", "a lapse").
 * Words that only begin with the letters (under, unit, union, uniform, unique, universal) are not un- words.
 */
const NOT_IN_FORCE = /\b(?!under|unit|union|uniform|unique|univers)un[a-z]|\bnon[-\s]?[a-z]|\b(?:expir\w*|laps\w*|suspen\w*|revo[ck]\w*|restrict\w*|probation\w*|pending|inactive|invalid|provisional|temporary|conditional|hardship|encumb\w*|foreign|learner(?:['’]?s)?|out[-\s]of[-\s]state|issues?|problems?|gaps?|violations?|sanction\w*|disciplin\w*|complaints?|points?|tickets?|citations?|accidents?|DUIs?|DWIs?|denials?|denied|offen[cs]\w*|felon\w*|convict\w*|criminal|arrest\w*|records?|without|lacking|missing|no|not|never)\b/i;

/**
 * A word that joins something to the credential named last ("points on driver's license", "a lapse in BLS
 * certification", "board action against license", "a license that has expired"): what it joins is what rules someone
 * out, so the words are no credential to turn round ("No points on driver's license" must never become "Points on
 * driver's license"). A whole word only, never inside one with a hyphen ("in-state").
 */
const LINKED = /(?:^|\s)(?:of|on|in|at|against|with|from|for|by|that|which|who|whose)(?=[\s,.;:!?]|$)/i;

/** "Cannot be …" and "Cannot have …" are rules ("Cannot be late"), not what someone is unable to do: never turned round. */
const CANNOT_BE = /^(?:cannot|can\s+not|can['’]t)\s+(?:be|have)\b/i;

/**
 * What the employer does to the people applying, after "Cannot …", "Unable to …" and the like ("Can't accept applicants
 * without a license", "Unable to sponsor visas"): the owner's rule, not what the candidate cannot do, so "Able to …" would
 * be nonsense the AI interview then asks about. The verb may come after a word ending in -ly ("currently"), "just",
 * "even", "ever", "also", "still", "then", "afford to" or "by law" ("Can't afford to hire inexperienced staff"), and
 * "hire" may be "re-hire" or "rehire" or come after another verb and "or", "and" or "to" ("Can't recruit or hire
 * minors"): a candidate never hires, and "hire" in `NAMES_APPLICANTS` names a person only. "Take" and "use" count here,
 * unlike after "Won't …", so "Can't take x-rays" and "Can't even use a computer" are asked of the owner as what they need.
 */
const EMPLOYER_DOES = /^(?:(?:[a-z]+ly|just|even|ever|also|still|then|afford\s+to|by\s+law)\s+)*(?:(?:[a-z]+\s+(?:or|and|to)\s+)?(?:re[-\s]?)?hire|accept|take|consider|employ|interview|on[-\s]?board|sponsor|bring\s+on(?:[-\s]?board)?|use|allow|offer|pay)\b/i;

/**
 * Words naming the people applying ("anyone who smokes", "new hires"): after "Cannot …" the words are then a rule about
 * them. "Hire" in the singular names a person only after a word that picks one out ("a hire", "a new hire", "any new
 * hire", "the new hire"); otherwise, unless it is the employer's verb (`EMPLOYER_DOES`), it is the hiring itself ("within
 * 30 days of hire", "before hire", "the hire date", "contract-to-hire", "new hire orientation"), so the words are still
 * what the candidate does and are turned round ("Unable to get BLS certified within 30 days of hire").
 */
const NAMES_APPLICANTS = /\b(?:applicants?|candidates?|anyone|anybody|someone|somebody|people|those|hires|(?:an?|another|any|each|every)\s+(?:new\s+)?hire|(?:the|our|your)\s+new\s+hire)\b/i;

/**
 * What only the employer does, after "Won't …" ("Won't hire smokers", "Will not accept applicants without a CDL"): the
 * words are the owner's rule, not something the candidate will not do, so "Willing to …" would be its opposite. Never
 * "take", which a candidate does too ("Won't take weekend shifts").
 */
const EMPLOYER_VERB = /^(?:hire|accept|consider|tolerate|allow|employ|interview|permit|sponsor|train|pay|offer|provide)\b/i;

/**
 * A deal-breaker as the must-have it rules people out on: "No active California RDA license" is the must-have "Active
 * California RDA license", never a must-have in those very words, which would ask the job page for the opposite. Only
 * clear shapes are turned round: "No …", "Without …", "Lacks …", "Missing …" or "Does not have …" a licence, certificate,
 * permit, registration or credential named last (`lacksCredential`), with no word saying it is not in force or naming the
 * problem itself (`NOT_IN_FORCE`) and none joining something to it (`LINKED`); "Cannot …" or "Unable to …" ("Able to
 * …") about what the candidate does, never "Cannot be …" or "Cannot have …", nor what the employer does to the people
 * applying (`EMPLOYER_DOES`, "Can't accept applicants without a license") or words naming them (`NAMES_APPLICANTS`,
 * "Cannot let anyone without a license start"); "Not licensed …", "Not available …" and the like; "Won't …" ("Willing to
 * …"), never "Won't hire …", "Won't accept …" or another verb only the employer does (`EMPLOYER_VERB`). Anything else
 * comes back as typed, never its opposite, so "No recent grads" is still refused by the fairness check, and words that
 * still rule someone out (`rulesOut`) are asked of the owner as what they need (the job builder's card names them).
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
 * which is turned round only when it is a deal-breaker's own words.
 */
export function lacksCredential(text: string): boolean {
  const lacks = text.trim().replace(/\s+/g, " ").match(LACKS);
  return !!lacks && CREDENTIAL_LAST.test(lacks[1]) && !NOT_IN_FORCE.test(lacks[1]) && !LINKED.test(lacks[1]);
}

/**
 * The must-haves a deal-breaker can come back as: the requirement it rules people out on (`mustHaveOf`), and its words
 * with the leading "No", "Without" and the like dropped, which can say the opposite ("No felonies or license
 * suspensions" as "Felonies or license suspensions"). A deal-breaker the fairness check refuses is refused in each of
 * them too, with the same reason.
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
 * never offered or filled in as a must-have: the job builder's card gives it no ready-made option and names it for the
 * owner to write as what they need.
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
 * What a question for the form asks about, read from its words, for the two subjects a model words its own way: the
 * schedule ("Are you available for the days this office is open?", "Which of these days can you work: Mon, Tue, Wed?")
 * and the right to work ("Are you authorized to work in the U.S.?"). Null for any other question, a start date ("Can you
 * start within 30 days?"), getting to the workplace ("Can you get to the workplace on the days the job needs?") and a
 * physical task ("Can you stand for an 8-hour shift?") among them. Two questions of the same subject ask the same thing
 * in different words.
 */
export function askedKind(question: string): "schedule_availability" | "work_authorization" | null {
  if (ABOUT_THE_RIGHT_TO_WORK.test(question)) return "work_authorization";
  if (ABOUT_THE_SCHEDULE.test(question) && !NOT_THE_SCHEDULE.test(question)) return "schedule_availability";
  return null;
}

/** What the assistant thinks is still missing after a turn. The server decides with `IntakeReadiness`; this only steers the next cards. */
export const IntakeMissingFact = z.enum(["title", "location", "remote_policy", "employment_type", "schedule", "compensation_basis", "compensation_range", "must_haves"]);
export type IntakeMissingFact = z.infer<typeof IntakeMissingFact>;

/** Which fact a card's answer sets. Cards ask only for what a job cannot be written without, and for the benefits line the law may ask for. */
export const IntakeQuestionField = z.enum(["title", "location", "remote_policy", "employment_type", "schedule", "compensation_basis", "compensation", "must_haves", "deal_breakers", "benefits"]);
export type IntakeQuestionField = z.infer<typeof IntakeQuestionField>;

/** single: tap one; multi: tick any; free: type; pay: the pay card (basis and range). */
export const IntakeQuestionMode = z.enum(["single", "multi", "free", "pay"]);
export type IntakeQuestionMode = z.infer<typeof IntakeQuestionMode>;

export const IntakeQuestionOption = z.object({ label: z.string().trim().min(1).max(200), value: z.string().trim().min(1).max(500), origin: IntakeOptionOrigin });
export type IntakeQuestionOption = z.infer<typeof IntakeQuestionOption>;

/**
 * One question card. The server gives every card its id, clears the options of a pay card (the pay card is drawn from
 * `pay` on the session), and drops any offered answer that fails the fairness check before the card is stored or shown.
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

/** One assistant turn of the builder's conversation (AI task `intake.turn`). */
export const IntakeTurn = z.object({
  assistantMessage: z.string().min(1),
  factsExtracted: IntakeFacts,
  missingFacts: z.array(IntakeMissingFact),
  /** Up to three question cards, the most important first. The owner can always ignore them and type. */
  questions: z.array(IntakeQuestion).max(3).default([]),
  /** The assistant's view that there is enough to write the job. The server decides with `readiness`. */
  readyToCompile: z.boolean(),
  /** The first message is not about hiring someone (a question about the day, say): the session is not kept as a draft. */
  notARole: z.boolean().default(false),
  /** What was taken from a pasted job ad, one plain line each ("Title: Front desk coordinator"). */
  takenFromAd: z.array(z.string().max(300)).max(20).default([]),
});
export type IntakeTurn = z.infer<typeof IntakeTurn>;

/** The cheap read of a long first message (AI task `intake.extract`): only what the text states, nothing guessed. */
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

/** Who set or confirmed the pay, and the figures they settled; publishing compares these with the facts. */
export const IntakePayConfirmation = z.object({
  by: Actor,
  at: z.string(),
  via: PayOrigin,
  basis: CompensationBasis,
  min: z.number(),
  max: z.number(),
});
export type IntakePayConfirmation = z.infer<typeof IntakePayConfirmation>;

/** Where the writing of a job has got, each recorded as it starts: the model writing, then the checks and the save, then done or failed. */
export const IntakeProgressStage = z.enum(["writing", "checking", "done", "failed"]);
export type IntakeProgressStage = z.infer<typeof IntakeProgressStage>;

/**
 * What the server keeps about a draft beside the conversation (`intake_sessions.server_state`). Nothing here comes from
 * the model: the pay confirmation, the open question cards, the pasted ad's place in the transcript and the writing's
 * progress.
 */
export const IntakeServerState = z.object({
  pay: IntakePayConfirmation.optional(),
  ad: z.object({ messageIndex: z.number().int(), chars: z.number().int(), extracted: z.boolean().default(false), takenFromAd: z.array(z.string()).default([]) }).optional(),
  openQuestions: z.array(IntakeQuestion).default([]),
  answeredRounds: z.number().int().default(0),
  /**
   * What is never asked on a card again in this draft: the field of every card already shown (answered, skipped or left).
   * Server-kept; the assistant is told the list and the server drops any card that asks one of them.
   */
  settledFields: z.array(IntakeQuestionField).default([]),
  /**
   * The single-value facts the owner gave on a card (not skipped), by name (locationText, schedule…): the assistant never
   * changes those on a turn that follows answers alone; a correction the owner types still goes through.
   */
  answeredFacts: z.array(z.string()).default([]),
  /** The wording of every card shown in this draft (the latest 60): a card that asks one of them again under another field is dropped. */
  askedPrompts: z.array(z.string()).default([]),
  /** Deal-breakers already offered back as must-haves, so each is offered once. */
  dealBreakersOffered: z.array(z.string()).default([]),
  progress: z.object({ stage: IntakeProgressStage, startedAt: z.string(), at: z.string() }).optional(),
  /**
   * The job as last written: when, by which run, for whom, the pay it was written with, a key of the answers the assistant
   * wrote it from (answers changed since make it out of date), and how many edits a person saved on it since, which
   * writing it again would replace.
   */
  draft: z.object({ at: z.string(), aiRunId: z.string(), by: Actor, payKey: z.string().nullable(), factsKey: z.string().optional(), edits: z.number().int().default(0) }).optional(),
});
export type IntakeServerState = z.infer<typeof IntakeServerState>;

/**
 * What a job needs before it can be written and published: its title, where it is, the work arrangement (asked, never
 * assumed), the pay (a person confirms it), full time or part time, the schedule, and at least one must-have.
 */
export const INTAKE_ESSENTIALS = ["title", "location", "remote_policy", "compensation_range", "employment_type", "schedule", "must_haves"] as const;
export type IntakeEssentialKey = (typeof INTAKE_ESSENTIALS)[number];
export const INTAKE_ESSENTIAL_LABEL: Record<IntakeEssentialKey, string> = {
  title: "Job title",
  location: "Where the job is",
  remote_policy: "On site, hybrid or remote",
  compensation_range: "Pay",
  employment_type: "Full time or part time",
  schedule: "Schedule",
  must_haves: "At least one must-have",
};

/** Computed on the server from the facts and the server state; the page never guesses it. */
export type IntakeReadiness = {
  essentials: Array<{ key: IntakeEssentialKey; label: string; done: boolean; value: string | null }>;
  missing: IntakeEssentialKey[];
  payConfirmed: boolean;
  /** Whether "Write the job" may run: every essential is in and a person set or confirmed the pay. */
  mayDraft: boolean;
  draftBlocker: string | null;
  hasDraft: boolean;
  /** Answers changed after the job was written, so it must be written again before it is published. */
  draftOutOfDate: boolean;
  /** Edits a person saved on the written job, which writing it again would replace. */
  draftEdits: number;
  openFlags: number;
  /** Whether "Publish job" works, and each plain reason when not. */
  publish: PublishCheck;
};

/** The pay card: what the owner stated, and who set or confirmed it. The company types its pay; nothing suggests one. */
export type IntakePayCard = {
  basis: "hourly" | "salary" | null;
  stated: { min: number | null; max: number | null };
  confirmed: { byName: string | null; at: string; via: PayOrigin } | null;
  summary: string;
};

/** A draft as the job builder reads it (GET /api/v1/intake/sessions/:id and every builder answer). */
export type IntakeSessionView = {
  id: string;
  /** `active`: being built; `compiled`: it was published and is a job now (`roleId`); `abandoned`: set aside. */
  status: "active" | "compiled" | "abandoned";
  roleId: string | null;
  createdAt: string;
  updatedAt: string;
  startedBy: { userId: string | null; name: string | null; mine: boolean };
  messages: IntakeMessage[];
  facts: IntakeFacts;
  /** The open question cards, at most three. */
  questions: IntakeQuestion[];
  readiness: IntakeReadiness;
  pay: IntakePayCard;
  /** The written job, null until "Write the job" ran. */
  draft: DraftRolePacket | null;
  /** The wording flags on the written job: open ones hold publishing until reworded or kept with a reason. */
  flags: PacketFlag[];
  /** What the law of the job's places asks of the ad; null until the job is written. */
  legalCheck: LegalCheck | null;
  /** The closing date chosen for the job (YYYY-MM-DD), or null. */
  closesOn: string | null;
  ad: { chars: number; takenFromAd: string[] } | null;
  progress: { stage: IntakeProgressStage; startedAt: string; at: string } | null;
};

/** One line of the drafts list (GET /api/v1/intake/sessions, and Home). */
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
 * Room on the plan for another job: checked when the builder opens and before any assistant run. `trialEnded`: the
 * company's trial has ended, so no new job starts until a plan is chosen; `message` says so.
 */
export type PlanRoom = { ok: boolean; limit: number | null; used: number; holding: Array<{ roleId: string; title: string; status: string }>; message: string | null; trialEnded?: boolean; /** The plan's jobs are all used for good, or its AI help is too low for a new job: closing one would not help, so the only way on is to upgrade. */ upgrade?: boolean; /** It is the AI help that ran out: the Upgrade asks about that (`AI_HELP_UPGRADE_QUESTION`). */ aiHelp?: boolean; /** On the last plan nothing is above theirs (`mayOfferUpgrade`): the same request opens the same sheet, and its button says "Talk to ITS". */ nothingAbove?: boolean };

/** What the server refused from an answer or an edit: a value that failed the fairness check, with the reason and a lawful alternative. */
export type IntakeRefusal = { field: string; text: string; reason: string; alternative: string | null };

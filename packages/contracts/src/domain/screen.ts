import { z } from "zod";
import { Evidence } from "./common";
import { EvidenceAssessment } from "./assessment";
import { ChatPlan, ScreenWriteup } from "./apply-questions";

/** Screening (docs/05 Screening Agent, docs/06 `screen` workflow). Text first: web chat or SMS. */

export const ScreenChannel = z.enum(["web", "sms"]);
export type ScreenChannel = z.infer<typeof ScreenChannel>;

/**
 * `cancelled`: a person stopped the invitation before the candidate started, or the application left the process (plan
 * A7, A9). Wave E: `unfinished` (started, reminded once, then closed with what they had said; E4), `declined_by_candidate`
 * ("Send without the conversation"; E3), `paused` (the assistant is not working; the candidate is emailed to finish once
 * it is back; E5).
 */
export const ScreenStatus = z.enum(["invited", "reminded", "in_progress", "completed", "expired", "abandoned", "human_requested", "cancelled", "unfinished", "declined_by_candidate", "paused"]);
export type ScreenStatus = z.infer<typeof ScreenStatus>;

/** A conversation the candidate can still answer. */
export const SCREEN_ACTIVE_STATUSES: readonly ScreenStatus[] = ["invited", "reminded", "in_progress"];
/** Where "I'd rather talk to a person" still works: an open conversation, and one paused while the assistant is down (E5). */
export const SCREEN_PERSON_ROUTE_STATUSES: readonly ScreenStatus[] = ["invited", "reminded", "in_progress", "paused"];

/**
 * How the conversation was offered (migration 0033): in the visit that sent the application (before 20 Oct 2026), after a
 * confirmed repeat submission, `with_application` (20 Oct 2026, R20-4: the AI interview every applicant gets once their
 * résumé is read, on the apply page and in the one email), or (null) by email from a person.
 */
export const ScreenInvitedVia = z.enum(["apply", "confirmed_repeat", "with_application"]);
export type ScreenInvitedVia = z.infer<typeof ScreenInvitedVia>;

/**
 * Where an entry came from. `chat` and `sms`: typed; `tap`: a tapped answer recorded in code (E12); `skip`: the candidate
 * skipped the question (E11); `edit`: an answer changed on the "check your answers" page (E10); `recruiter_call`: a
 * recruiter's notes from a call (E3), which are never the candidate's own words; `system`: written by the software.
 */
export const ScreenEntrySource = z.enum(["chat", "sms", "tap", "skip", "edit", "recruiter_call", "system"]);
export type ScreenEntrySource = z.infer<typeof ScreenEntrySource>;

export const ScreenTranscriptEntry = z.object({
  /** `recruiter`: a recruiter's notes from a phone call (E3), shown and read as notes, never as the candidate's words. */
  role: z.enum(["assistant", "candidate", "system", "recruiter"]),
  content: z.string(),
  at: z.string(),
  questionKey: z.string().optional(),
  channel: ScreenChannel.optional(),
  aiRunId: z.string().optional(),
  source: ScreenEntrySource.optional(),
  /** For recruiter notes: who wrote them. */
  by: z.string().optional(),
});
export type ScreenTranscriptEntry = z.infer<typeof ScreenTranscriptEntry>;

/** Where the conversation is. Kept in code, not in the model's head, so a restart or a channel switch resumes cleanly. */
export const ScreenProgress = z.object({
  askedKeys: z.array(z.string()).default([]),
  currentQuestionKey: z.string().nullable().default(null),
  followUps: z.record(z.string(), z.number()).default({}),
  confusedTurns: z.number().int().default(0),
  failures: z.number().int().default(0),
  /**
   * "one_visit": the conversation offered with the application (E1): a fixed introduction with the first question in
   * the packet's words (E2), "check your answers" before it is sent (E10), and a pause instead of a hand-off when the
   * assistant fails (E5). Absent on a conversation that started from an emailed invitation.
   */
  flow: z.enum(["one_visit"]).optional(),
  /** "review": every question is answered or skipped and the candidate is checking their answers before sending (E10). */
  phase: z.enum(["conversation", "review"]).optional(),
  /** Questions the candidate chose to skip (E11): unknown in the scorecard, never held against them. */
  declined: z.array(z.string()).optional(),
  /** How many times each answer was changed on the "check your answers" page (E10). */
  edits: z.record(z.string(), z.number()).optional(),
  /** When the candidate pressed Send on the "check your answers" page (E10). */
  submittedAt: z.string().optional(),
  /**
   * "recruiter_call": closed as complete by a recruiter's notes from a call (E3), not by the candidate. Whatever the
   * candidate typed before was never sent, so the team reads the notes alone (founder decision of 9 October 2026, "hide
   * them until they send"; `screenAnswersSent` in @ros/core).
   */
  completedBy: z.enum(["recruiter_call"]).optional(),
  /** When this conversation was counted against the plan's allowance: at the first answer, never at the invitation (E9). */
  countedAt: z.string().optional(),
  /** When it was paused because the assistant was not working (E5), and the last time the software tried again. */
  pausedAt: z.string().optional(),
  retriedAt: z.string().optional(),
  /**
   * A person's "Send a reminder" (20 Oct 2026, R20-7) about an interview already started: it stays open at least until
   * then, beside the idle close after the reminder (the `screen` run's `after_invite`). Unstarted, `expiresAt` says it.
   */
  keptOpenUntil: z.string().optional(),
  /**
   * "Ask about this in a screen": the résumé assessment's open questions, asked before the packet's own questions
   * (keys `unknown_1`, `unknown_2`, ...). Fixed when the screen is created so a later assessment never changes a
   * conversation under way; each answer is recorded beside its question (not in `answers`, which holds the packet's
   * own; readers merge the two through `screenAnswersOf` in @ros/core). Absent on an ordinary screen.
   */
  focusQuestions: z.array(z.object({ key: z.string().min(1), question: z.string().min(1), whyItMatters: z.string().optional(), answer: z.string().optional() })).optional(),
  /** Wave S7: the chat's sections and what each item stands at (the header's "2 of 4 required"); absent on a chat from before. */
  chat: ChatPlan.optional(),
  /**
   * Wave S7: what was typed in the visit that offered this chat (the CV's lines from the form's reading and the form's
   * answers as sentences), the only details the chat may name. A repeat submission's detached chat never shows anything
   * on file this way; a first application's chat has the same, so the two read alike. Wiped when a detached chat is
   * discarded or confirmed, and erased with the candidate's other words (`withoutCandidateWords`).
   */
  typedFacts: z.object({ cv: z.array(z.string().max(500)).max(20), formAnswers: z.array(z.string().max(500)).max(20) }).optional(),
  /**
   * Wave S7, a chat offered with the application: the visit that sent it passed what was typed, so the chat may name the
   * application's own CV and form answers (a repeat submission's chat then has the same, `typedFacts`). Absent: it
   * names neither, exactly like a repeat submission's chat without them.
   */
  ownFacts: z.boolean().optional(),
  /**
   * 21 Oct 2026 (Q14, founder: "same page, confirm by email"): a detached interview's visit, so it is made from what a new
   * address's own AI interview is made from. `newApplication`: the visit made the application it belongs to (an address
   * the company knew, applying to another job), whose reading, interview plan and readiness are this visit's own.
   * `uploadId`, `readAskedAt`: a repeat's résumé, whose reading by the form had not finished at Send; its CV lines are
   * taken from that reading (found by its upload) when the interview starts, as the intake takes them.
   */
  visit: z.object({ newApplication: z.boolean().optional(), uploadId: z.string().max(100).optional(), readAskedAt: z.string().optional() }).optional(),
  /**
   * Wave S7: the written-up answers shown on Review & send. Hidden from the team until Send with the rest of the chat
   * (`teamScreenView`), erased with the candidate's words (`withoutCandidateWords` in @ros/core).
   */
  writeup: ScreenWriteup.optional(),
  /**
   * Wave S8, "written": a chat without a plan (by text, or on the web from an emailed link) asks what the web chat asks,
   * the company's written questions when it set any (`writtenQuestionsOf` in @ros/core), after the résumé reading's open
   * questions. Set when the screen is created, so a chat started before keeps the list it began with: absent, it asks
   * the job's screening questions as it always did.
   */
  asks: z.enum(["written"]).optional(),
});
export type ScreenProgress = z.infer<typeof ScreenProgress>;

/**
 * How an answer came to be recorded (E10): `answered` in the conversation, `declined` (the candidate skipped it), or
 * `edited` on the "check your answers" page. The model only ever records `answered`; the other two are set in code.
 */
export const AnswerStatus = z.enum(["answered", "declined", "edited"]);
export type AnswerStatus = z.infer<typeof AnswerStatus>;

/**
 * Wave S7, the Kanvis-style chat (`ScreenProgress.chat`): how the model read the candidate's latest reply to the item
 * being asked. `concrete`: something specific (what they did, a figure, an example); `vague`: an answer with nothing
 * specific in it yet (a bare "yes", "I handled it well"); `not_done`: "No", "I haven't". Only ever a reading for the
 * chat's next step, worked out in code (`chatNextMove` in @ros/core): never a finding, and a "not_done" is never a "no"
 * for a skill (it settles the item as not known).
 */
export const ChatReading = z.enum(["concrete", "vague", "not_done"]);
export type ChatReading = z.infer<typeof ChatReading>;

/** One assistant turn. Rules (enforced in the prompt and checked in code): disclose at the start, one question at a time, at most two follow-ups per question, never ask about protected characteristics. */
export const ScreenTurn = z.object({
  messageToCandidate: z.string().min(1).max(1200),
  /** The packet question this message asks, or null for a follow-up, an answer to the candidate, or the close. */
  questionKey: z.string().nullable(),
  /** The candidate's latest message, recorded as the answer to a question. */
  answerRecorded: z.object({ questionKey: z.string(), answer: z.string(), complete: z.boolean(), status: AnswerStatus.optional() }).nullable(),
  followUpReason: z.string().nullable(),
  candidateAskedAbout: z.enum(["pay", "schedule", "process", "company", "other"]).nullable().default(null),
  sentiment: z.enum(["fine", "confused", "frustrated", "distressed"]).default("fine"),
  done: z.boolean(),
  humanRequested: z.boolean(),
  /** Wave S7 chat only: the model's reading of the latest reply to the item being asked (`ChatReading`); absent elsewhere. */
  reading: ChatReading.nullable().optional(),
});
export type ScreenTurn = z.infer<typeof ScreenTurn>;

export const ScreenRecommendation = z.enum(["strong_interview", "interview", "hold", "decline_recommended"]);
export type ScreenRecommendation = z.infer<typeof ScreenRecommendation>;

/** The screen's scorecard: the evidence-based assessment shape plus what a screen specifically establishes. */
export const ScreenAssessment = EvidenceAssessment.omit({ recommendation: true }).extend({
  questionFindings: z.array(z.object({
    questionKey: z.string(),
    answered: z.boolean(),
    finding: z.string(),
    evidence: Evidence.optional(),
    meetsModelAnswer: z.enum(["yes", "partially", "no", "unknown"]).default("unknown"),
  })).default([]),
  compensationExpectation: z.object({ stated: z.string().optional(), withinRange: z.enum(["yes", "above", "below", "unknown"]).default("unknown") }).default({ withinRange: "unknown" }),
  availability: z.object({ stated: z.string().optional(), matchesSchedule: z.enum(["yes", "partially", "no", "unknown"]).default("unknown"), earliestStart: z.string().optional() }).default({ matchesSchedule: "unknown" }),
  eligibilityConfirmations: z.array(z.object({ key: z.string(), confirmed: z.enum(["yes", "no", "unknown"]), quote: z.string().optional() })).default([]),
  recommendation: ScreenRecommendation,
});
export type ScreenAssessment = z.infer<typeof ScreenAssessment>;

/* ------------------------------------------------------------------------------------------------------------ */
/* Wave E: applying and the conversation in one visit                                                            */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * How a role's applicants meet the screening conversation (plan E1, founder decision B1): straight after the form
 * ("one_visit"), or by email later ("form_then_screen"). Set per role and per company by ITS only.
 */
export const ApplyMode = z.enum(["one_visit", "form_then_screen"]);
export type ApplyMode = z.infer<typeof ApplyMode>;

/** The application form alone, in minutes, as the pages say it (plan E8). */
export const APPLY_FORM_MINUTES = 3;

/**
 * Applying in one visit, the form and the conversation together, rounded up to five minutes so a page never
 * under-promises (plan E8). The job page, its previews and the owner's preview of an unsaved edit all use it.
 */
export function oneVisitMinutes(packet: { screening: { maxMinutes: number } }): number {
  return Math.ceil((APPLY_FORM_MINUTES + packet.screening.maxMinutes) / 5) * 5;
}

/** PUT /api/v1/roles/:id/apply-mode (ITS only): a role's own setting, or null to follow the company's default. */
export const ApplyModeChange = z.object({
  applyMode: ApplyMode.nullable(),
  reason: z.string().trim().min(5, "Say why (at least five characters).").max(500),
}).strict();
export type ApplyModeChange = z.infer<typeof ApplyModeChange>;

/** POST /api/v1/admin/customers/:id/apply-flow (ITS only): the company's default for roles without their own setting. */
export const ApplyFlowDefaultChange = z.object({
  applyFlow: ApplyMode,
  reason: z.string().trim().min(5, "Say why (at least five characters).").max(500),
}).strict();
export type ApplyFlowDefaultChange = z.infer<typeof ApplyFlowDefaultChange>;

/**
 * A repeat submission's conversation: what the address owner is asked to confirm, and where that stands. `outage`: the
 * assistant stopped working for a day part-way, so a person is offered instead (nobody asked for one).
 */
export const UnconfirmedIntent = z.enum(["answers", "person", "withdraw", "outage"]);
export type UnconfirmedIntent = z.infer<typeof UnconfirmedIntent>;
export const UnconfirmedConfirmation = z.enum(["sent", "confirmed", "not_added", "discarded"]);
export type UnconfirmedConfirmation = z.infer<typeof UnconfirmedConfirmation>;

/**
 * Tap answers (E12): the questions a candidate can answer by tapping, worked out in code from the question's kind and
 * wording (`ScreeningQuestion.kind` is skills, behavioral, compensation, availability, eligibility, motivation or
 * logistics; none of them says "yes or no" by itself). Recorded word for word, without the model. Typing still works.
 */
export const TapFormat = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yes_no") }),
  z.object({ kind: z.literal("days"), options: z.array(z.string()) }),
  z.object({ kind: z.literal("start_date") }),
  z.object({ kind: z.literal("pay_range"), basis: z.enum(["hourly", "salary"]), currency: z.string() }),
]);
export type TapFormat = z.infer<typeof TapFormat>;

export const TapAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("yes_no"), choice: z.enum(["yes", "no"]) }),
  z.object({ kind: z.literal("days"), days: z.array(z.string().max(20)).min(1).max(7) }),
  z.object({ kind: z.literal("start_date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  z.object({ kind: z.literal("pay_range"), min: z.number().positive().max(10_000_000), max: z.number().positive().max(10_000_000).optional() }),
]);
export type TapAnswer = z.infer<typeof TapAnswer>;

/** One line of the "check your answers" page (E10). */
export type ReviewItem = { key: string; question: string; answer: string | null; status: AnswerStatus | "unanswered"; tap: TapFormat | null };

/** POST /api/v1/applications/:id/screen/recruiter-notes (E3): a recruiter's notes from a call, per question where they fit. */
export const RecruiterCallNotes = z.object({
  notes: z.array(z.object({ questionKey: z.string().min(1).max(100).optional(), text: z.string().trim().min(1).max(4000) })).min(1).max(30),
  /** Close the conversation as complete with these notes, so the scorecard is written. */
  complete: z.boolean().default(true),
}).strict();
export type RecruiterCallNotes = z.infer<typeof RecruiterCallNotes>;

/**
 * GET /api/v1/roles/:id/screening (E13): how the conversation goes for this role, from the screens alone. Nothing is
 * worked out from a conversation the candidate did not send (founder decision of 9 October 2026), so there is no "where
 * people stopped": every conversation that stopped was never sent.
 */
export type ScreeningFunnel = {
  offered: number;
  started: number;
  finished: number;
  unfinished: number;
  stillApplying: number;
  /** Minutes from the first answer to sending, the middle value of the conversations the candidates sent. */
  medianMinutes: number | null;
  /** People who chose a person: asked a person to contact them, or sent the application without the conversation. */
  personChosen: { contactMe: number; sendWithout: number };
  skipped: Array<{ key: string; question: string; count: number }>;
};

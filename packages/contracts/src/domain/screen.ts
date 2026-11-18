import { z } from "zod";
import { ChatPlan } from "./apply-questions";
import type { AiInterviewStatus } from "./stages";

/**
 * The AI interview ("screen" in code): a web chat a shortlisted candidate does from an emailed link. It starts only when
 * a person on the team shortlists someone. The link is open five days, with one reminder after 48 hours; then it closes
 * and the team can send a new link. Its questions are the job's interview questions, then up to four must-haves the CV
 * reading did not find shown, then one closing question. Nothing reaches the team before the candidate presses "Send my
 * answers".
 */

/**
 * `invited`: the link is out; `reminded`: the one reminder went; `in_progress`: started; `completed`: the candidate sent
 * their answers; `expired`: the link closed after five days, started or not; `declined_by_candidate`: they chose "I'd
 * rather not do the AI interview"; `cancelled`: a person on the team cancelled it, or the application left the process.
 */
export const ScreenStatus = z.enum(["invited", "reminded", "in_progress", "completed", "expired", "declined_by_candidate", "cancelled"]);
export type ScreenStatus = z.infer<typeof ScreenStatus>;

/** A conversation the candidate can still answer, and where "I'd rather not do the AI interview" still works. */
export const SCREEN_ACTIVE_STATUSES: readonly ScreenStatus[] = ["invited", "reminded", "in_progress"];

/** How long an AI interview link stays open, and when its one reminder goes. */
export const SCREEN_LINK_OPEN_DAYS = 5;
export const SCREEN_REMINDER_AFTER_HOURS = 48;
/** A person on the team may send a reminder at most once in this many hours. */
export const SCREEN_REMIND_EVERY_HOURS = 24;

/**
 * Where the AI interview stands for the team, from the stored status of the person's newest AI interview. Null for a
 * cancelled one: the person is back in New, as if none had been sent.
 */
export function aiInterviewStatusOf(status: ScreenStatus): AiInterviewStatus | null {
  switch (status) {
    case "invited":
    case "reminded":
      return "sent";
    case "in_progress":
      return "started";
    case "completed":
      return "done";
    case "expired":
      return "link_closed";
    case "declined_by_candidate":
      return "opted_out";
    default:
      return null;
  }
}

/**
 * Where an entry came from. `chat`: typed; `tap`: a tapped answer recorded in code; `skip`: the candidate skipped the
 * question; `edit`: an answer changed on the "check your answers" page; `system`: written by the software.
 */
export const ScreenEntrySource = z.enum(["chat", "tap", "skip", "edit", "system"]);
export type ScreenEntrySource = z.infer<typeof ScreenEntrySource>;

export const ScreenTranscriptEntry = z.object({
  role: z.enum(["assistant", "candidate", "system"]),
  content: z.string(),
  at: z.string(),
  questionKey: z.string().optional(),
  aiRunId: z.string().optional(),
  source: ScreenEntrySource.optional(),
});
export type ScreenTranscriptEntry = z.infer<typeof ScreenTranscriptEntry>;

/** Where the conversation is. Kept in code, not in the model's head, so a restart resumes cleanly. */
export const ScreenProgress = z.object({
  askedKeys: z.array(z.string()).default([]),
  currentQuestionKey: z.string().nullable().default(null),
  followUps: z.record(z.string(), z.number()).default({}),
  confusedTurns: z.number().int().default(0),
  failures: z.number().int().default(0),
  /** "review": every question is answered or skipped and the candidate is checking their answers before sending. */
  phase: z.enum(["conversation", "review"]).optional(),
  /** Questions the candidate chose to skip: not known in the scorecard, never read as a no. */
  declined: z.array(z.string()).optional(),
  /** How many times each answer was changed on the "check your answers" page. */
  edits: z.record(z.string(), z.number()).optional(),
  /** When the candidate pressed "Send my answers". */
  submittedAt: z.string().optional(),
  /** When this conversation was counted against the plan's AI interviews: at the first answer, never at the invitation. */
  countedAt: z.string().optional(),
  /**
   * When the scorecard of a sent interview started waiting for the company's AI help: the answers are there for the team,
   * who read them themselves; it is written after an upgrade or when a monthly allowance starts again, and this is cleared.
   */
  scoreWaitsForCredit: z.string().optional(),
  /** A person's "Send a reminder" about an interview already started: it stays open at least until then. */
  keptOpenUntil: z.string().optional(),
  /** The chat's sections and what each item stands at (the line above the chat, "Question 2 of 6"). */
  chat: ChatPlan.optional(),
  /** The CV's lines and the form's answers as sentences: the only details of the application the chat may name. */
  typedFacts: z.object({ cv: z.array(z.string().max(500)).max(20), formAnswers: z.array(z.string().max(500)).max(20) }).optional(),
});
export type ScreenProgress = z.infer<typeof ScreenProgress>;

/**
 * How an answer came to be recorded: `answered` in the conversation, `declined` (the candidate skipped it), or `edited`
 * on the "check your answers" page. The model only ever records `answered`; the other two are set in code.
 */
export const AnswerStatus = z.enum(["answered", "declined", "edited"]);
export type AnswerStatus = z.infer<typeof AnswerStatus>;

/**
 * How the model read the candidate's latest reply to the item being asked. `concrete`: something specific (what they
 * did, a figure, an example); `vague`: an answer with nothing specific in it yet (a bare "yes", "I handled it well");
 * `not_done`: "No", "I haven't". Only ever a reading for the chat's next step, worked out in code: never a finding, and a
 * "not_done" is never a "no" for a skill (it settles the item as not known).
 */
export const ChatReading = z.enum(["concrete", "vague", "not_done"]);
export type ChatReading = z.infer<typeof ChatReading>;

/** One assistant turn. Rules (enforced in the prompt and checked in code): disclose at the start, one question at a time, at most two follow-ups per question, never ask about protected characteristics. */
export const ScreenTurn = z.object({
  messageToCandidate: z.string().min(1).max(1200),
  /** The job question this message asks, or null for a follow-up, an answer to the candidate, or the close. */
  questionKey: z.string().nullable(),
  /** The candidate's latest message, recorded as the answer to a question. */
  answerRecorded: z.object({ questionKey: z.string(), answer: z.string(), complete: z.boolean(), status: AnswerStatus.optional() }).nullable(),
  followUpReason: z.string().nullable(),
  candidateAskedAbout: z.enum(["pay", "schedule", "process", "company", "other"]).nullable().default(null),
  sentiment: z.enum(["fine", "confused", "frustrated", "distressed"]).default("fine"),
  done: z.boolean(),
  /** The candidate said they would rather not do the AI interview. */
  humanRequested: z.boolean(),
  /** The model's reading of the latest reply to the item being asked (`ChatReading`). */
  reading: ChatReading.nullable().optional(),
});
export type ScreenTurn = z.infer<typeof ScreenTurn>;

/**
 * Tap answers: the questions a candidate can answer by tapping, worked out in code from the question's kind and wording.
 * Recorded word for word, without the model. Typing still works.
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

/** One line of the candidate's "check your answers" page. */
export type ReviewItem = { key: string; question: string; answer: string | null; status: AnswerStatus | "unanswered"; tap: TapFormat | null };

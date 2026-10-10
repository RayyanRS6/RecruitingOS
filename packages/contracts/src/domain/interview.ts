import { z } from "zod";
import { RejectReason } from "./stages";

/** Scheduling (docs/05 §2, docs/06 schedule_interview; slice 5 steps 7 to 9). */
export const OfferedSlot = z.object({
  id: z.string().min(1),
  startsAt: z.string(),
  endsAt: z.string(),
  interviewerUserIds: z.array(z.string()),
  /** Where the free time came from: a connected calendar's free/busy or declared windows. */
  source: z.enum(["calendar", "declared"]),
});
export type OfferedSlot = z.infer<typeof OfferedSlot>;

export const InterviewStatus = z.enum(["proposed", "scheduling", "scheduled", "completed", "cancelled", "no_show", "offer_expired"]);
export type InterviewStatus = z.infer<typeof InterviewStatus>;

const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM");
export const AvailabilityWindow = z.object({ day: z.number().int().min(0).max(6), start: ClockTime, end: ClockTime }).refine((w) => w.start < w.end, { message: "the window must end after it starts" });
export const InterviewerAvailabilityInput = z.object({
  timezone: z.string().min(1).refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }, { message: "unknown time zone" }),
  windows: z.array(AvailabilityWindow).max(21),
  bufferMinutes: z.number().int().min(0).max(120).default(15),
  maxPerDay: z.number().int().min(1).max(12).default(3),
});
export type InterviewerAvailabilityInput = z.infer<typeof InterviewerAvailabilityInput>;

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
export const SchedulingWindow = z.object({ fromDate: IsoDate.optional(), toDate: IsoDate.optional(), businessDaysOnly: z.boolean().default(true) });

/** The human's approval of an interview round (policy `interview.request`, approval level; the click is the approval). */
export const RequestInterview = z.object({
  roundKey: z.string().min(1),
  interviewerUserIds: z.array(z.string().min(1)).min(1).max(6),
  linkSource: z.enum(["calendar", "pasted"]).default("calendar"),
  meetingUrl: z.string().url().refine((u) => /^https?:\/\//i.test(u), "The meeting link must start with http:// or https://").optional(),
  window: SchedulingWindow.optional(),
  note: z.string().max(2000).optional(),
});
export type RequestInterview = z.infer<typeof RequestInterview>;

export const RescheduleInterview = z.object({ reason: z.string().max(500).optional(), window: SchedulingWindow.optional() });
export const CancelInterview = z.object({ reason: z.string().min(1).max(500) });
export const InterviewOutcome = z.object({ outcome: z.enum(["happened", "no_show_candidate", "no_show_interviewer"]) });
export const BookOnBehalf = z.object({ slotId: z.string().min(1), note: z.string().max(500).optional() });
export const RecordDecision = z.object({ decision: z.enum(["next_round", "finalist", "hired", "not_moving_forward"]), reason: RejectReason.optional(), note: z.string().max(2000).optional() });

/** The ordinary words of an interview's title, said in lower case mid-sentence even when the title capitalises them. */
const TITLE_WORDS = new Set([
  "a", "about", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to", "with",
  "assessment", "call", "case", "catch", "chat", "check", "coffee", "conversation", "culture", "day", "demo", "discussion", "final", "first", "fit", "follow", "fourth",
  "hiring", "initial", "interview", "interviews", "intro", "introductory", "last", "lunch", "manager", "meeting", "office", "onsite", "panel", "person", "phone", "practical",
  "presentation", "review", "round", "screen", "screening", "second", "session", "shift", "site", "skills", "study", "sync", "team", "technical", "third", "trial", "up",
  "video", "virtual", "visit", "working",
]);

/**
 * An interview's title mid-sentence: "Final Interview" reads "final interview", and "Call with Paul" reads "call with
 * Paul". The first word goes to lower case, and so does any later word that is an ordinary interview word ("Round",
 * "Interview", "With"); any other capitalised word is a name or a place and is kept ("Coffee with Nadine in London"), as
 * is a word in capitals ("HR interview", "Call with the CEO") and a first word that owns the rest ("Paul's interview").
 * The candidate's emails and the team's pages say a title inside a sentence this same way.
 */
export function titleMidSentence(title: string): string {
  const start = title.search(/[A-Za-z]/);
  return title.replace(/\b[A-Z][a-z]*\b/g, (word, at: number) => {
    const first = at === start && !/^['’]s\b/.test(title.slice(at + word.length));
    return first || TITLE_WORDS.has(word.toLowerCase()) ? word.toLowerCase() : word;
  });
}

/** What the candidate sends from the pick-a-time page. */
export const SelectSlot = z.object({ slotId: z.string().min(1), timezone: z.string().min(1).optional(), accessibilityNote: z.string().max(500).optional() });
/**
 * The Cancelled column (founder decisions 1A to 4A, 9 October 2026). Only two things put someone there: the candidate's
 * own cancel of a booked interview, with their choice of what comes next (`CancelNext`), and the team recording that the
 * candidate did not show. `AutoNewTimesState` is the one automatic set of new times (only for someone who asked for
 * them): `waiting` for its day, `waiting_check` for the ITS company check, `preparing` while the interview is reopened
 * and its times are worked out, `sent` once the email with the times is on its way, `not_sent` when it never went.
 */
export const FollowUpKind = z.enum(["candidate_cancelled", "candidate_no_show"]);
export type FollowUpKind = z.infer<typeof FollowUpKind>;
export const CancelNext = z.enum(["new_times", "not_interested"]);
export type CancelNext = z.infer<typeof CancelNext>;
export const AutoNewTimesState = z.enum(["none", "waiting", "waiting_check", "preparing", "sent", "not_sent"]);
export type AutoNewTimesState = z.infer<typeof AutoNewTimesState>;
/** Why no automatic set is armed (`none`), or why one did not go (`not_sent`). Plain sentences: `autoReasonText` in packages/core. */
export const AutoNewTimesReason = z.enum([
  "not_asked", "no_show", "switched_off", "already_used", "reschedules_used", "takeover", "was_on_hold",
  "stopped_by_team", "team_acted", "left_process", "interview_changed", "company_not_checked", "no_interviewers", "no_email", "details_deleted",
  "candidate_replied",
]);
export type AutoNewTimesReason = z.infer<typeof AutoNewTimesReason>;
/** How someone left the Cancelled column. */
export const FollowUpResolution = z.enum(["rebooked", "moved_by_team", "team_cancelled", "left_process", "superseded"]);
export type FollowUpResolution = z.infer<typeof FollowUpResolution>;

/**
 * What the candidate sends from the confirmed page to cancel: what they would like next (new times later, or no longer
 * interested), the ticked confirmation and, if they like, a few words on why (docs/spec/04: "Optional reason; confirm").
 */
export const CandidateCancel = z.object({ confirm: z.literal("yes"), next: CancelNext, reason: z.string().trim().max(500).optional() });
export type CandidateCancel = z.infer<typeof CandidateCancel>;
/** The working days before the one automatic set of new times (founder decision 3A): each company chooses 1 to 10. */
export const NEW_TIMES_WORKING_DAYS = { min: 1, max: 10, default: 3 } as const;
/** The setting when a company never saved one: automatic new times on, after 3 working days. */
export const NEW_TIMES_SETTING_DEFAULT = { auto: true, workingDays: 3 } as const;
export const CandidateAvailability = z.object({
  timezone: z.string().min(1).optional(),
  /** Free text such as "Mornings before 10, any day but Wednesday"; shown to the owner, never parsed by a model. */
  note: z.string().max(1000).optional(),
  /** Optional structured preferences the page collects with checkboxes. */
  preferred: z.array(z.object({ day: z.number().int().min(0).max(6), part: z.enum(["morning", "midday", "afternoon", "evening"]) })).max(28).default([]),
});
export type CandidateAvailability = z.infer<typeof CandidateAvailability>;

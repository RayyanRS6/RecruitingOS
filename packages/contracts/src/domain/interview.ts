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

/** What the candidate sends from the pick-a-time page. */
export const SelectSlot = z.object({ slotId: z.string().min(1), timezone: z.string().min(1).optional(), accessibilityNote: z.string().max(500).optional() });
export const CandidateAvailability = z.object({
  timezone: z.string().min(1).optional(),
  /** Free text such as "Mornings before 10, any day but Wednesday"; shown to the owner, never parsed by a model. */
  note: z.string().max(1000).optional(),
  /** Optional structured preferences the page collects with checkboxes. */
  preferred: z.array(z.object({ day: z.number().int().min(0).max(6), part: z.enum(["morning", "midday", "afternoon", "evening"]) })).max(28).default([]),
});
export type CandidateAvailability = z.infer<typeof CandidateAvailability>;

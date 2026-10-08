import { z } from "zod";

export const ApplicationStage = z.enum([
  "applied",
  "received",
  "ineligible",
  "eligible",
  "triaged",
  "screen_invited",
  "screening",
  "screen_complete",
  "interview_recommended",
  "interview_scheduled",
  "interview_complete",
  "debrief",
  "finalist",
  "reference_check",
  "offer_draft",
  "offer_approval",
  "offer_sent",
  "negotiation",
  "accepted",
  "declined",
  "hired",
  "onboarding",
  "withdrawn",
  "rejected",
  "talent_pool",
]);
export type ApplicationStage = z.infer<typeof ApplicationStage>;

export const TERMINAL_STAGES: ReadonlySet<ApplicationStage> = new Set(["hired", "withdrawn", "rejected", "talent_pool", "declined"]);

/** Owner Mode groups stages into plain language. */
export const OwnerGroup = z.enum(["waiting_on_you", "in_process", "not_moving_forward", "hired"]);
export type OwnerGroup = z.infer<typeof OwnerGroup>;

/**
 * The stage strip (founder decision B3): the stages an owner sees and moves people between, in this order. A view over
 * the internal state machine, which is unchanged: Longlist, Shortlist and On hold are private marks a person sets
 * (`application_marks`), never internal stages, and the candidate sees none of them (`ownerStage` in packages/core).
 */
export const OwnerStage = z.enum(["new", "longlist", "shortlist", "interviewing", "on_hold", "offer", "hired", "not_moving_forward"]);
export type OwnerStage = z.infer<typeof OwnerStage>;
export const OWNER_STAGE_LABEL: Record<OwnerStage, string> = {
  new: "New",
  longlist: "Longlist",
  shortlist: "Shortlist",
  interviewing: "Interviewing",
  on_hold: "On hold",
  offer: "Offer",
  hired: "Hired",
  not_moving_forward: "Not moving forward",
};

/**
 * A person's private mark on an application (plan A4 and plan-adjustments section 2). At most one is active at a time;
 * a hold always carries the date it ends. "Not a fit for now" is set from the pool board and reads as not moving
 * forward on the strip, without being a decline: nobody is told anything.
 */
export const MarkKind = z.enum(["longlist", "shortlist", "on_hold", "not_a_fit_for_now"]);
export type MarkKind = z.infer<typeof MarkKind>;
export const MARK_LABEL: Record<MarkKind, string> = { longlist: "Longlist", shortlist: "Shortlist", on_hold: "On hold", not_a_fit_for_now: "Not a fit for now" };
/** Where a mark came from: a person's own click, the pool board's "apply", or an assistant suggestion a person applied. */
export const MarkSource = z.enum(["manual", "board", "assistant"]);
export type MarkSource = z.infer<typeof MarkSource>;
/** The mark an application carries now, as the API answers it. `remindAt` is set for a hold only. */
export type ActiveMark = { id: string; mark: MarkKind; label: string; remindAt: string | null; note: string | null; source: MarkSource; setAt: string; setBy: { kind: string; id: string; name?: string } };

/**
 * Whether the candidate has been told a decision (founder decision B6: decisions are private, telling is a later act
 * by a person). `queued`: the message is in the outbox; `sent`: it left; `told_in_person`: someone told them themselves.
 * `before_tracking`: a decision made before decisions became private (migration 0026), which the candidate's status page
 * already showed at the time; it counts as told, and nothing more is sent about it.
 */
export const ToldState = z.enum(["not_told", "queued", "sent", "told_in_person", "before_tracking"]);
export type ToldState = z.infer<typeof ToldState>;

/** The four steps a candidate sees on their status page (plan A1). The decision shows only once they were told. */
export const CandidateStep = z.enum(["received", "under_review", "interview", "decision"]);
export type CandidateStep = z.infer<typeof CandidateStep>;
export const CANDIDATE_STEP_LABEL: Record<CandidateStep, string> = { received: "Received", under_review: "Under review", interview: "Interview", decision: "Decision" };

/**
 * What became of the candidate's message after a decision or a "Send", so the toast says exactly that.
 * `not_told`: nothing was sent (every decision, hold and mark; the candidate was not told). `queued`: the message is on
 * its way. `held`: it is saved and goes out on its own once ITS confirms the company (founder decision B7).
 * `waiting_approval`: it waits for someone who may approve it. `not_sent_settings`: the company's settings send no
 * decision messages. `not_sent_no_email`: no address on file. `not_sent`: it could not be prepared.
 */
export const CandidateNotice = z.enum(["not_told", "queued", "held", "waiting_approval", "not_sent_settings", "not_sent_no_email", "not_sent"]);
export type CandidateNotice = z.infer<typeof CandidateNotice>;

/**
 * How a choice on the stage button is carried out. `set_mark` / `clear_mark`: POST /applications/:id/actions with that
 * action (one click, private). `interview`: open the interview approval card. `offer`: not available yet (offers are made
 * outside the app). `record_hire`: open the hire sheet (POST /applications/:id/outcome, hired_externally). `decline`:
 * open the private decline (POST /applications/:id/actions, reject, reason required). `none`: where they are now.
 */
export const StageMoveVia = z.enum(["none", "set_mark", "clear_mark", "interview", "offer", "record_hire", "decline"]);
export type StageMoveVia = z.infer<typeof StageMoveVia>;
/** One entry of the stage button: every owner stage, allowed or not, with the reason when not. */
export type StageMove = { to: OwnerStage; label: string; via: StageMoveVia; mark?: MarkKind; allowed: boolean; current: boolean; blockedReason?: string };

export const RoleStatus = z.enum(["draft", "pending_approval", "open", "paused", "filled", "closed"]);
export type RoleStatus = z.infer<typeof RoleStatus>;

export const RejectReason = z.enum([
  "eligibility",
  "not_a_match_experience",
  "not_a_match_skills",
  "compensation_mismatch",
  "location_or_schedule",
  "position_filled",
  "role_closed",
  "candidate_unresponsive",
  "other",
]);
export type RejectReason = z.infer<typeof RejectReason>;

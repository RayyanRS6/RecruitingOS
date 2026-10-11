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

/**
 * Owner Mode groups stages into plain language. `waiting_on_candidate`: an offer made outside the app with no answer
 * recorded yet (plan H2); the next move is the candidate's, so it is neither waiting on you nor simply in process.
 */
export const OwnerGroup = z.enum(["waiting_on_you", "waiting_on_candidate", "in_process", "not_moving_forward", "hired"]);
export type OwnerGroup = z.infer<typeof OwnerGroup>;

/**
 * The stage strip (founder decision B3): the stages an owner sees and moves people between, in this order. A view over
 * the internal state machine, which is unchanged: Longlist, Shortlist and On hold are private marks a person sets
 * (`application_marks`), never internal stages. Cancelled (founder decisions 1A to 4A) is a view over a stored follow-up
 * (`interview_followups`), not a mark: someone who cancelled a booked interview or did not come to it, while still
 * recommended for interview or interview done. The candidate sees none of them (`ownerStage` in packages/core).
 */
export const OwnerStage = z.enum(["new", "longlist", "shortlist", "interviewing", "cancelled", "on_hold", "offer", "hired", "not_moving_forward"]);
export type OwnerStage = z.infer<typeof OwnerStage>;
export const OWNER_STAGE_LABEL: Record<OwnerStage, string> = {
  new: "New",
  longlist: "Longlist",
  shortlist: "Shortlist",
  interviewing: "Interviewing",
  cancelled: "Cancelled",
  on_hold: "On hold",
  offer: "Offer",
  hired: "Hired",
  not_moving_forward: "Not moving forward",
};

/** Why someone is under Cancelled: the choice they made when they cancelled, or that they did not come. */
export const CancelledReason = z.enum(["asked_new_times", "not_interested", "no_show"]);
export type CancelledReason = z.infer<typeof CancelledReason>;
export const CANCELLED_REASON_LABEL: Record<CancelledReason, string> = { asked_new_times: "Asked for new times", not_interested: "No longer interested", no_show: "No-show" };
/** Where the new times stand: nothing in motion; an interview being set up (no email yet); its email held for the ITS check; out; the email failed; offered and lapsed. */
export const NewTimesProgress = z.enum(["none", "preparing", "held", "out", "not_reached", "expired"]);
export type NewTimesProgress = z.infer<typeof NewTimesProgress>;
/**
 * Why someone is under Cancelled and where their new times stand. Team-only: never on a candidate page (B6).
 * `interviewId`: the interview that carries their new times, or else the one they cancelled or missed. `auto.dueDay` is
 * the promised day (YYYY-MM-DD, company time); `status` is the row's line in plain words.
 */
export type CancelledView = {
  id: string; reason: CancelledReason; label: string; since: string; interviewId: string;
  auto: { state: "none" | "waiting" | "waiting_check" | "preparing" | "sent" | "not_sent"; reason: string | null; reasonText: string | null; dueAt: string | null; dueDay: string | null; sentAt: string | null };
  times: NewTimesProgress; lastSentAt: string | null; lastSentVia: "auto" | "person" | "batch" | null;
  status: string;
};
/** The follow-up an interview summary carries: enough for the Interviews page to offer "Send new times". */
export type InterviewFollowUpRef = { id: string; reason: CancelledReason; times: NewTimesProgress };

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
 * action (one click, private). `interview`: open the interview approval card. `offer`: record that an offer was made
 * outside the app (POST /applications/:id/offer, plan H2; the app never writes or sends it). `record_hire`: open the hire
 * sheet (POST /applications/:id/outcome, hired_externally). `decline`:
 * open the private decline (POST /applications/:id/actions, reject, reason required). `none`: where they are now.
 */
export const StageMoveVia = z.enum(["none", "set_mark", "clear_mark", "interview", "offer", "record_hire", "decline", "undo_decision"]);
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
/**
 * The approved wordings of the decision message (founder decision Q28; plan G6). The wording is always ours, never the
 * AI's: `v1` (the standard wording), `v2` (warmer) and `v3` (shorter) after any decision; `after_interview` for someone
 * who met the team; `position_filled` once the job went to someone else; `role_closed`, the closing message when a role
 * closes (Q30); `eligibility`, fixed, after a decline on an eligibility answer. Draft wording, counsel register item 23.
 */
export const DecisionWording = z.enum(["v1", "v2", "v3", "after_interview", "position_filled", "role_closed", "eligibility"]);
export type DecisionWording = z.infer<typeof DecisionWording>;
export const DECISION_WORDING_LABEL: Record<DecisionWording, string> = {
  v1: "Standard",
  v2: "Warmer",
  v3: "Shorter",
  after_interview: "After an interview",
  position_filled: "Position filled",
  role_closed: "Role closed",
  eligibility: "Eligibility answer",
};
/** The wordings a person may choose on the Send screen; the eligibility wording and the closing message are chosen for them. */
export const CHOOSABLE_WORDINGS: readonly DecisionWording[] = ["v1", "v2", "v3", "after_interview", "position_filled"];
/** A personal line added to a decision message or another message (Q28): one or two sentences. */
export const PERSONAL_LINE_MAX = 300;

/** The fixed reasons as the team reads them (the role report uses the same words). Never shown to the candidate. */
export const DECLINE_REASON_LABEL: Record<RejectReason, string> = {
  eligibility: "Did not meet an eligibility rule",
  not_a_match_experience: "Experience not a match",
  not_a_match_skills: "Skills not a match",
  compensation_mismatch: "Pay expectations did not match",
  location_or_schedule: "Location or schedule",
  position_filled: "Position filled",
  role_closed: "Role closed",
  candidate_unresponsive: "Candidate did not respond",
  other: "Other",
};

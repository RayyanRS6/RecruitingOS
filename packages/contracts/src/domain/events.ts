import { z } from "zod";
import { Actor, Subject } from "./common";

/** The event taxonomy (docs/04). Payloads are validated where they matter; others are open objects. */
export const EventType = z.enum([
  "company.created", "company.updated", "user.invited", "user.joined", "membership.changed",
  // The one-time ITS check of a self-serve company (founder decision B7): confirmed, or the confirmation taken back.
  "company.verified", "company.unverified",
  // Team membership through invitations (docs/spec/21, area A): someone joined on an invitation, was removed, or an invitation was withdrawn.
  "member.joined", "member.removed", "invitation.revoked",
  "integration.connected", "integration.failed", "policy.changed", "plan.changed", "entitlement.exceeded",
  "intake.started", "intake.turn_completed", "intake.compiled", "intake.abandoned",
  // The job builder (Wave C): tapped answers applied, the draft written beside the conversation, pay set or confirmed by a
  // person, a draft taken over by an owner or admin, approval asked for, and a flagged phrase kept with a reason.
  "intake.answered", "intake.drafted", "intake.pay_confirmed", "intake.taken_over", "intake.approval_requested", "packet.flag_kept",
  // Changing a packet by chat (C10): the assistant proposed a change, a person confirmed it, or set it aside. The
  // requirements check (C16): a person applied the fixes they tapped.
  "packet.revision_proposed", "packet.revision_applied", "packet.revision_discarded", "packet.check_applied",
  "role.created", "role_packet.proposed", "role_packet.approved", "role_packet.edited",
  "role.approved", "role.opened", "role.paused", "role.resumed", "role.filled", "role.closed",
  // A packet approval was rejected or ran out of time (the role goes back to draft), or was replaced by a newer version.
  "role.sent_back", "approval.cancelled",
  "role.applications_closed", "role.applications_reopened", "role.volume_high",
  "posting.requested", "posting.published", "posting.awaiting_verification", "posting.manual_action_required", "posting.not_connected", "posting.failed", "posting.expired", "posting.spend_recorded",
  // Job distribution (docs/spec/20): one event per posting state, plus the closure checklist and a failed check.
  "posting.draft", "posting.approved", "posting.ready_to_post", "posting.posted_manually", "posting.submitted_integration", "posting.live_verified", "posting.paused", "posting.closed",
  "posting.verification_failed", "posting.closure_required", "posting.closure_confirmed",
  // Publishing (plan Wave D): a board still shows an earlier version after an approved edit, and was brought up to
  // date; the boards a person chose for the role; the closing date set, changed or taken off.
  "posting.update_required", "posting.updated", "role.boards_chosen", "role.closing_date_set",
  "application_link.created", "application_link.disabled",
  "application.received", "application.acknowledged", "application.duplicate_detected", "candidate.created", "candidate.merged",
  "resume.ingested", "resume.extraction_failed", "document.upload_authorized", "document.upload_used", "document.uploaded", "document.validated", "document.rejected", "document.deleted", "eligibility.evaluated", "application.ineligible", "application.hold_reminded", "application.triaged",
  "assessment.created", "application.stage_changed", "application.inactive", "application.withdrawn", "application.rejected",
  "application.moved_to_talent_pool",
  // Private marks (Longlist, Shortlist, On hold, Not a fit for now) and the candidate being told a decision (founder decisions B3, B6).
  "application.marked", "application.mark_cleared", "application.told",
  // The untold safety net (Q27): five working days on, the standard message went by itself, or a recruiter was brought
  // in instead; and the one closing message for everyone a closed role left untold (Q30), sent or put to one approval.
  "application.untold_fallback", "role.closing_message",
  // Review and apply on the pool board (plan F8): one fact per batch, with what the board suggested and what a person chose.
  "pool.batch_applied",
  // A private team note on a candidate written, changed or removed by its author (plan H3). Never carries the note's words.
  "note.added", "note.updated",
  "screen.invited", "screen.started", "screen.completed", "screen.abandoned", "screen.expired", "screen.human_requested", "screen.assessed", "screen.cancelled",
  // Wave E: the conversation in the same visit as applying. Sent without it, closed part-way after a reminder, paused while
  // the assistant is down and resumed, a question skipped or tapped, an answer changed before sending, a recruiter's call
  // notes, and how a role's applicants meet the conversation (set by ITS).
  "screen.declined_by_candidate", "screen.unfinished", "screen.idle_reminded", "screen.paused", "screen.resumed", "screen.question_skipped", "screen.answer_tapped", "screen.answer_edited", "screen.recruiter_notes_added",
  "screen.repeat_started", "screen.repeat_confirmation_sent", "screen.repeat_confirmed", "screen.repeat_discarded",
  "role.apply_mode_changed", "company.apply_flow_changed", "entitlement.warning",
  "candidate.recommended", "interview.requested", "interview.scheduling_started", "interview.slots_offered", "interview.scheduled",
  "interview.rescheduled", "interview.cancelled", "interview.no_show", "interview.brief_sent", "interview.recording_consented",
  "interview.recording_declined", "interview.completed", "interview.transcribed", "scorecard.drafted", "scorecard.submitted",
  "debrief.completed", "candidate.finalist", "reference.requested", "reference.received", "background_check.ordered", "background_check.completed",
  "offer.created", "offer.approval_requested", "offer.approved", "offer.rejected_internally", "offer.sent", "offer.viewed",
  "offer.counter_received", "offer.revised", "offer.accepted", "offer.declined", "offer.expired", "offer.rescinded",
  "onboarding.started", "handoff.packet_sent", "employee.created", "employee.creation_failed", "onboarding.task_completed",
  "onboarding.completed", "start.confirmed", "start.no_show", "outcome.recorded", "outcome.corrected",
  "message.queued", "message.sent", "message.delivered", "message.bounced", "message.complained", "message.retried", "message.suppressed", "message.failed", "message.received",
  // A decision message withdrawn from the outbox before it left: the decision it carried no longer applies.
  "message.cancelled",
  // A message to a candidate waiting for the ITS company check, and its release once ITS confirms the company.
  "message.held", "message.released",
  "consent.granted", "consent.revoked", "candidate.opted_out", "candidate.data_request", "candidate.data_request_fulfilled", "candidate.anonymized", "candidate.complaint",
  "workflow.started", "workflow.step_completed", "workflow.waiting", "workflow.resumed", "workflow.retried", "workflow.failed", "workflow.completed",
  "workflow.escalated", "workflow.cancelled", "approval.requested", "approval.granted", "approval.denied", "approval.expired",
  "ai.run_completed", "ai.run_failed", "ai.output_invalid", "ai.refused", "human.override",
  "recruiter.requested", "recruiter.claimed", "recruiter.resolved", "recruiter.takeover_started", "recruiter.takeover_ended",
  "recruiter.access_granted", "recruiter.access_ended", "recruiter.access_revoked", "recruiter.sla_recalculated",
  // The thread on a recruiter request (plan B5): a note from the team, a reply from the recruiter, and "this didn't solve it".
  "customer.replied", "recruiter.replied", "recruiter.reopened",
  "intervention.sent", "intervention.responded", "brief.sent",
  "integration.connected", "integration.disconnected", "integration.credentials_deleted", "integration.deletion_failed", "integration.health_changed",
  "availability.updated", "interview.requested", "interview.slots_offered", "interview.slots_reminded", "interview.offer_expired", "interview.candidate_availability",
  "interview.slot_selected", "interview.slot_taken", "interview.booked", "interview.confirmed", "interview.reminder_sent", "interview.rescheduled", "interview.cancelled",
  "interview.completed", "interview.outcome_recorded", "interview.decision_recorded", "calendar.event_created", "calendar.event_cancelled", "calendar.needs_attention",
]);
export type EventType = z.infer<typeof EventType>;

export const DomainEvent = z.object({
  type: EventType,
  companyId: z.string().nullable(),
  actor: Actor,
  subject: Subject,
  payload: z.record(z.string(), z.unknown()).default({}),
  correlationId: z.string().nullable().optional(),
  causationId: z.string().nullable().optional(),
  occurredAt: z.string().optional(),
});
export type DomainEvent = z.infer<typeof DomainEvent>;

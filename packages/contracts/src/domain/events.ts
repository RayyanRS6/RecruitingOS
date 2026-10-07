import { z } from "zod";
import { Actor, Subject } from "./common";

/** The event taxonomy (docs/04). Payloads are validated where they matter; others are open objects. */
export const EventType = z.enum([
  "company.created", "company.updated", "user.invited", "user.joined", "membership.changed",
  // Team membership through invitations (docs/spec/21, area A): someone joined on an invitation, was removed, or an invitation was withdrawn.
  "member.joined", "member.removed", "invitation.revoked",
  "integration.connected", "integration.failed", "policy.changed", "plan.changed", "entitlement.exceeded",
  "intake.started", "intake.turn_completed", "intake.compiled", "intake.abandoned",
  "role.created", "role_packet.proposed", "role_packet.approved", "role_packet.edited",
  "role.approved", "role.opened", "role.paused", "role.resumed", "role.filled", "role.closed",
  // A packet approval was rejected or ran out of time (the role goes back to draft), or was replaced by a newer version.
  "role.sent_back", "approval.cancelled",
  "role.applications_closed", "role.applications_reopened", "role.volume_high",
  "posting.requested", "posting.published", "posting.awaiting_verification", "posting.manual_action_required", "posting.not_connected", "posting.failed", "posting.expired", "posting.spend_recorded",
  // Job distribution (docs/spec/20): one event per posting state, plus the closure checklist and a failed check.
  "posting.draft", "posting.approved", "posting.ready_to_post", "posting.posted_manually", "posting.submitted_integration", "posting.live_verified", "posting.paused", "posting.closed",
  "posting.verification_failed", "posting.closure_required", "posting.closure_confirmed",
  "application_link.created", "application_link.disabled",
  "application.received", "application.acknowledged", "application.duplicate_detected", "candidate.created", "candidate.merged",
  "resume.ingested", "resume.extraction_failed", "document.upload_authorized", "document.upload_used", "document.uploaded", "document.validated", "document.rejected", "document.deleted", "eligibility.evaluated", "application.ineligible", "application.hold_reminded", "application.triaged",
  "assessment.created", "application.stage_changed", "application.inactive", "application.withdrawn", "application.rejected",
  "application.moved_to_talent_pool",
  // Private marks (Longlist, Shortlist, On hold, Not a fit for now) and the candidate being told a decision (founder decisions B3, B6).
  "application.marked", "application.mark_cleared", "application.told",
  "screen.invited", "screen.started", "screen.completed", "screen.abandoned", "screen.expired", "screen.human_requested", "screen.assessed", "screen.cancelled",
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
  "consent.granted", "consent.revoked", "candidate.opted_out", "candidate.data_request", "candidate.data_request_fulfilled", "candidate.anonymized", "candidate.complaint",
  "workflow.started", "workflow.step_completed", "workflow.waiting", "workflow.resumed", "workflow.retried", "workflow.failed", "workflow.completed",
  "workflow.escalated", "workflow.cancelled", "approval.requested", "approval.granted", "approval.denied", "approval.expired",
  "ai.run_completed", "ai.run_failed", "ai.output_invalid", "ai.refused", "human.override",
  "recruiter.requested", "recruiter.claimed", "recruiter.resolved", "recruiter.takeover_started", "recruiter.takeover_ended",
  "recruiter.access_granted", "recruiter.access_ended", "recruiter.access_revoked", "recruiter.sla_recalculated",
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

import { z } from "zod";
import { Actor, Subject } from "./common";

/** Every fact the product records about itself. Payloads are validated where they matter; others are open objects. */
export const EventType = z.enum([
  // Companies and their teams. Access: an administrator accepted or declined a company's request, or took an accepted
  // company's access away (Accept is the undo). Accepting is the one gate that makes a company live.
  "company.created", "company.updated", "company.access_accepted", "company.access_declined", "company.access_removed",
  "user.invited", "member.joined", "member.removed", "membership.changed", "invitation.revoked",
  // Plans, limits and the Trial plan's 30 days.
  "plan.changed", "entitlement.exceeded", "entitlement.warning", "trial.started", "trial.extended", "trial.ended",
  // The job builder: a draft started, a turn of the conversation, tapped answers applied, pay set or confirmed by a
  // person, the job written, a draft taken over or set aside, the draft published as a job, a flagged phrase kept.
  "intake.started", "intake.turn_completed", "intake.answered", "intake.pay_confirmed", "intake.drafted", "intake.taken_over", "intake.abandoned", "intake.compiled", "packet.flag_kept",
  // Jobs: created and opened by publishing, a new version saved by an edit, paused, resumed, closed; applications
  // stopped by the closing date and taken again; the closing date set, changed or taken off.
  "role.created", "role_packet.approved", "role_packet.edited", "role.opened", "role.paused", "role.resumed", "role.closed",
  "role.applications_closed", "role.applications_reopened", "role.closing_date_set",
  // Applying: an application and its CV file.
  "application.received", "application.acknowledged", "application.duplicate_detected", "candidate.created",
  "document.upload_authorized", "document.upload_used", "document.uploaded", "document.validated", "document.rejected", "document.deleted",
  // Past the plan's candidates per job when it came in, with its place in arrival order and never a name; opened to the
  // team by a change of plan, oldest first.
  "application.locked", "application.unlocked",
  // Reading the CV.
  "resume.ingested", "resume.extraction_failed", "assessment.created", "application.triaged",
  // Moving through the process: every stage change, and its three named ends; the candidate being told a decision; a hire recorded.
  "application.stage_changed", "application.rejected", "application.withdrawn", "application.told", "outcome.recorded", "human.override",
  // The AI interview: sent (by Shortlist), reminded, started, a question skipped or tapped, an answer changed before
  // sending, the model-call cap reached, answers sent, scored, the link closed, the candidate chose not to do it, cancelled.
  "screen.invited", "screen.reminded", "screen.started", "screen.question_skipped", "screen.answer_tapped", "screen.answer_edited", "screen.turn_cap_reached",
  "screen.completed", "screen.assessed", "screen.expired", "screen.declined_by_candidate", "screen.cancelled",
  // Email through the outbox. `message.cancelled`: a decision email taken back before it left.
  "message.queued", "message.sent", "message.delivered", "message.bounced", "message.complained", "message.retried", "message.suppressed", "message.failed", "message.cancelled",
  // Consent and privacy requests.
  "consent.granted", "consent.revoked", "candidate.opted_out", "candidate.data_request", "candidate.data_request_fulfilled", "candidate.anonymized",
  // The workflow engine and AI runs.
  "workflow.started", "workflow.step_completed", "workflow.waiting", "workflow.resumed", "workflow.retried", "workflow.failed", "workflow.completed", "workflow.cancelled",
  "ai.run_failed", "ai.output_invalid",
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

import type { Actor, Subject } from "@ros/contracts";
import { auditRecords, type Queryable } from "@ros/db";
import { guardOutbound } from "./secrets";

export type AuditAction =
  | "candidate.viewed"
  | "candidate.exported"
  | "export.created"
  | "policy.changed"
  | "membership.changed"
  | "data.deleted"
  | "admin.bypass"
  | "credentials.updated"
  | "notice.changed"
  | "session.revoked"
  | "escalation.context_viewed"
  | "assessment.flagged"
  | "staff.access_granted"
  | "staff.access_ended"
  | "staff.tenant_accessed"
  | "admin.break_glass"
  | "plan.changed"
  /** A recruiter or administrator looked at the pre-acceptance preview of a customer's request (correction 11). */
  | "escalation.preview_viewed"
  | "calendar.changed"
  | "escalation.sla_recalculated"
  /** Secret lifecycle (correction 10): every read of a stored credential is recorded with service, purpose, tenant and integration. */
  | "secret.stored"
  | "secret.read"
  | "secret.rotated"
  | "secret.deleted"
  | "secret.delete_failed"
  | "credentials.deleted"
  | "alert.acknowledged"
  /** An alert marked dealt with: by a person in the console, or by the system once its condition ended (Wave S2 F1). */
  | "alert.resolved"
  /** A person booked an interview time for the candidate ("Book this for them", Wave S2 F2). */
  | "interview.booked_on_behalf"
  | "session.opened"
  | "signin.refused"
  | "platform_role.changed"
  | "platform_role.revoked"
  /** A listed bootstrap email signed in after administrators already existed: the list is ignored (21 Sep, item 2). */
  | "bootstrap.ignored"
  /** The customer ended a recruiter's access early (21 Sep, item 1). */
  | "staff.access_revoked"
  /** Human-recorded hiring outcomes (21 Sep, item 4). */
  | "outcome.recorded"
  /** A rate limit tripped (21 Sep, item 5): the key is a hash, never the subject. */
  | "security.rate_limited"
  | "outcome.corrected"
  | "role.outcome_recorded"
  /** Privacy requests (correction 7). */
  | "data_request.created"
  /** The same candidate re-sent the same request within a day: the earlier record is answered again, nothing new is created (21 Sep, item 3). */
  | "data_request.replayed"
  | "data_request.updated"
  | "data.exported"
  | "data.corrected"
  | "data.anonymized"
  | "data_request.resolved"
  /** Email suppression list (item 5). */
  | "suppression.added"
  | "suppression.released"
  /** Staff second factor (22 Sep 2026): enrolment, verification, failures and a reset seen at the identity service. Never the secret or a token. */
  | "mfa.enrolled"
  | "mfa.verified"
  | "mfa.failed"
  | "mfa.backup_enrolled"
  | "mfa.reset_detected"
  /** Résumé files (founder decision 2, 22 Sep 2026): who uploaded, read, replaced or deleted which file. Never the contents. */
  | "document.uploaded"
  | "document.read"
  | "document.replaced"
  | "document.deleted"
  | "document.rejected"
  /** Job distribution (docs/spec/20): a person recorded, verified, paused, resumed, closed, retried or confirmed the removal of a posting; changed a tracked link; flipped the accepting-applications switch. */
  | "posting.changed"
  | "application_link.changed"
  | "role.applications_toggled"
  /** Publishing (plan Wave D): the boards a role uses, and its closing date. */
  | "role.boards_chosen"
  | "role.closing_date_changed"
  /** Team invitations (docs/spec/21, area A): sent, sent again, withdrawn, accepted at sign-in. Never the token. */
  | "invitation.sent"
  | "invitation.resent"
  | "invitation.revoked"
  | "invitation.accepted"
  /** The role report's applicant list or figures left as a file (docs/spec/21 section 7, P1): who, which role, how many rows. */
  | "report.exported"
  /** Company preferences changed by an owner or admin (audit finding A8): which keys, never the old and new text of a notice (notice.changed carries the versions). */
  | "company.updated"
  /** The one-time ITS check of a self-serve company (founder decision B7): confirmed, or taken back, by whom and why. */
  | "company.verified"
  | "company.unverified"
  /** The customer's own audit history left as a file (audit finding A9): who, how many rows, which filters. */
  | "audit.exported"
  /** The holder of a session confirmed with their sign-in provider again before a sensitive change (audit finding A12). */
  | "session.reauthenticated"
  /** A person wrote to a candidate from the sheet (F11): who, which application, whether it went at once or waited for an approval, and who approved it. Never the text. */
  | "message.sent"
  | "message.approval_requested"
  /** Undo (plan G9): a person took back a message while it waited in the outbox. Which message, never the text. */
  | "message.undone"
  /** The one closing message of a closed role (Q30): sent to everyone untold, or put to one approval, by whom, how many. */
  | "role.closing_message"
  /** A person changed which email alerts they get (plan B3): the groups, before and after. Never anything else. */
  | "notification.preferences_changed"
  /** Wave E: a recruiter added notes from a call to a screening conversation; ITS changed how a role or a company's roles meet the conversation. Never the notes. */
  | "screen.recruiter_notes_added"
  | "role.apply_mode_changed"
  | "company.apply_flow_changed";

/** Privileged and access actions. Distinct from domain events: this answers "who looked at what, and why." */
export async function audit(
  q: Queryable,
  input: { companyId: string | null; actor: Actor; action: AuditAction; target?: Subject | null; reason?: string; ip?: string; details?: Record<string, unknown> },
): Promise<void> {
  // Correction 10: an audit record never carries a credential; the guard refuses (outside production) or scrubs.
  const safe = guardOutbound({ reason: input.reason ?? null, details: input.details ?? {} }, `audit record ${input.action}`);
  await q.insert(auditRecords).values({
    companyId: input.companyId,
    actor: input.actor,
    action: input.action,
    target: input.target ?? null,
    reason: safe.reason,
    ip: input.ip ?? null,
    details: safe.details,
  });
}

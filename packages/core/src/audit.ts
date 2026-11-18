import type { Actor, Subject } from "@ros/contracts";
import { auditRecords, type Queryable } from "@ros/db";
import { guardOutbound } from "./secrets";

export type AuditAction =
  | "candidate.viewed"
  | "membership.changed"
  | "admin.bypass"
  | "session.revoked"
  | "plan.changed"
  /** An application past the plan's candidates per job, and its opening by a change of plan (Rule 2): why, in arrival order and the plan's numbers, never a name. */
  | "application.locked"
  | "application.unlocked"
  /** The Trial plan's 30 days (founder decision L-02 B): started, extended by ITS with a reason (days, end before and after), ended. */
  | "trial.started"
  | "trial.extended"
  | "trial.ended"
  | "alert.acknowledged"
  /** An alert marked dealt with: by a person in the console, or by the system once its condition ended (Wave S2 F1). */
  | "alert.resolved"
  | "session.opened"
  | "signin.refused"
  | "platform_role.changed"
  | "platform_role.revoked"
  /** A listed bootstrap email signed in after administrators already existed: the list is ignored (21 Sep, item 2). */
  | "bootstrap.ignored"
  /** Human-recorded hiring outcomes (21 Sep, item 4). */
  | "outcome.recorded"
  /** A rate limit tripped (21 Sep, item 5): the key is a hash, never the subject. */
  | "security.rate_limited"
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
  | "document.deleted"
  | "document.rejected"
  /** A job's closing date set, changed or taken off. */
  | "role.closing_date_changed"
  /** Team invitations (docs/spec/21, area A): sent, sent again, withdrawn, accepted at sign-in. Never the token. */
  | "invitation.sent"
  | "invitation.resent"
  | "invitation.revoked"
  | "invitation.accepted"
  /** A company's details changed by an owner or an admin: which fields, never what was written in them. */
  | "company.updated"
  /** The one gate: an administrator accepted or declined a company's request, or took an accepted company's access away. */
  | "company.access_accepted"
  | "company.access_declined"
  | "company.access_removed"
  /** The holder of a session confirmed with their sign-in provider again, before making someone an admin or an owner. */
  | "session.reauthenticated"
  /** A person turned their "Email me updates" switch on or off: before and after. Never anything else. */
  | "notification.preferences_changed";

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

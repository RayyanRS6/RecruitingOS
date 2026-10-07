/**
 * What a recruiter brought in for a request can see, and for how long, in the words every screen uses (founder decision
 * Q31: every message states the real access). The API says the same in its replies and notices
 * (apps/api/src/routes/approvals-escalations-events.ts); the access rules live in packages/core/src/staff-access.ts.
 */
export type AccessScope = "application" | "role" | "company";

export function accessWords(scope: AccessScope): string {
  if (scope === "application") return "this candidate and the role they applied for";
  if (scope === "role") return "this role and its candidates";
  return "all of your hiring: every role and every candidate";
}

/** ESCALATION_ACCESS_DAYS and ACCESS_AFTER_RESOLUTION_HOURS in packages/core/src/staff-access.ts. */
export const ACCESS_DAYS = 14;
/** Shown to everyone who may ask; only owners and admins may end a recruiter's access (staff_access.revoke). */
export const ACCESS_LIMITS = `Their access starts when they pick the request up and ends a day after it is resolved, or after ${ACCESS_DAYS} days at most. An owner or admin can end it sooner in Setup, and every page they open is recorded.`;

/**
 * What the page says once a request is sent: the API's own reply, which names what the recruiter will see and until
 * when (POST /api/v1/escalations), so a one-click request from a Today card is as clear as the full sheet.
 */
export function requestSentText(reply: unknown): string {
  const message = (reply as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() ? message : "Sent to a recruiter.";
}

/** The scope a request carries: one candidate, one role, or (only when chosen) all of the company's hiring. */
export function scopeOf(input: { roleId?: string | null; applicationId?: string | null }): AccessScope {
  return input.applicationId ? "application" : input.roleId ? "role" : "company";
}

/** The chip on Setup's recruiter access list. */
export function accessChip(grant: { roleId: string | null; roleTitle: string | null; applicationId: string | null }): string {
  if (grant.applicationId) return "one candidate";
  if (grant.roleId) return grant.roleTitle ? `role: ${grant.roleTitle}` : "one role";
  return "all of your hiring";
}

import type { MembershipRole } from "@ros/contracts";

/**
 * What each team role may do. An owner and an admin may do everything; a member (`hiring_manager`) builds, edits and
 * publishes jobs and acts on candidates, and does not pause, resume or close a job, set its closing date, change the
 * company's details or manage people.
 */
export type Permission =
  | "company.read"
  | "company.update"
  | "members.manage"
  | "role.create"
  | "role.read"
  /** Publish a job: open it, so its job page is public and takes applications. */
  | "role.publish"
  /** Pause, resume and close a job, set its closing date, take over a draft. */
  | "role.manage"
  | "packet.edit"
  | "application.read"
  | "application.act"
  | "application.reject"
  | "compensation.read"
  /** Ask ITS for a bigger plan (the Upgrade button). */
  | "plan.request"
  | "events.read"
  /** Record a hire. */
  | "outcome.record";

const MATRIX: Record<MembershipRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "company.read", "company.update", "members.manage", "role.create", "role.read", "role.publish", "role.manage", "packet.edit",
    "application.read", "application.act", "application.reject", "compensation.read", "plan.request", "events.read", "outcome.record",
  ]),
  admin: new Set<Permission>([
    "company.read", "company.update", "members.manage", "role.create", "role.read", "role.publish", "role.manage", "packet.edit",
    "application.read", "application.act", "application.reject", "compensation.read", "plan.request", "events.read", "outcome.record",
  ]),
  hiring_manager: new Set<Permission>([
    "company.read", "role.create", "role.read", "role.publish", "packet.edit", "application.read", "application.act",
    "application.reject", "compensation.read", "plan.request", "events.read", "outcome.record",
  ]),
};

export function can(role: MembershipRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return MATRIX[role]?.has(permission) ?? false;
}

export function assertCan(role: MembershipRole | null | undefined, permission: Permission): void {
  if (!can(role, permission)) throw new PermissionError(permission, role ?? "none");
}

export class PermissionError extends Error {
  status = 403;
  code = "forbidden";
  constructor(public permission: Permission, public role: string) {
    super(`role ${role} lacks ${permission}`);
  }
}

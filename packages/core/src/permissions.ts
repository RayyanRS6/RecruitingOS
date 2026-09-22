import type { MembershipRole } from "@ros/contracts";

export type Permission =
  | "company.read"
  | "company.update"
  | "members.manage"
  | "role.create"
  | "role.read"
  | "role.approve"
  | "role.manage"
  | "packet.edit"
  | "application.read"
  | "application.act"
  | "application.reject"
  | "candidate.search"
  | "compensation.read"
  | "scorecard.write"
  | "offer.manage"
  | "policy.manage"
  | "escalation.create"
  | "escalation.work"
  | "workflow.control"
  | "events.read"
  | "billing.manage"
  /** Connect and disconnect external calendars and job boards for the company (correction 10). */
  | "integration.manage"
  /** End an ITS recruiter's access to the company before it expires (customer owners and admins). */
  | "staff_access.revoke"
  /** Record a hiring outcome that happened outside the platform, or close a role with its outcome (decision-makers only). */
  | "outcome.record";

const MATRIX: Record<MembershipRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([
    "company.read", "company.update", "members.manage", "role.create", "role.read", "role.approve", "role.manage", "packet.edit",
    "application.read", "application.act", "application.reject", "candidate.search", "compensation.read", "scorecard.write",
    "offer.manage", "policy.manage", "escalation.create", "events.read", "billing.manage", "integration.manage", "staff_access.revoke", "outcome.record",
  ]),
  admin: new Set<Permission>([
    "company.read", "company.update", "members.manage", "role.create", "role.read", "role.approve", "role.manage", "packet.edit",
    "application.read", "application.act", "application.reject", "candidate.search", "compensation.read", "scorecard.write",
    "offer.manage", "policy.manage", "escalation.create", "events.read", "billing.manage", "integration.manage", "staff_access.revoke", "outcome.record",
  ]),
  hiring_manager: new Set<Permission>([
    "company.read", "role.create", "role.read", "role.approve", "packet.edit", "application.read", "application.act",
    "application.reject", "compensation.read", "scorecard.write", "escalation.create", "events.read", "outcome.record",
  ]),
  hr: new Set<Permission>([
    "company.read", "role.read", "application.read", "application.act", "candidate.search", "compensation.read", "offer.manage",
    "escalation.create", "events.read", "members.manage", "outcome.record",
  ]),
  interviewer: new Set<Permission>(["company.read", "role.read", "scorecard.write"]),
  recruiter: new Set<Permission>([
    "company.read", "role.create", "role.read", "role.manage", "packet.edit", "application.read", "application.act",
    "application.reject", "candidate.search", "compensation.read", "scorecard.write", "offer.manage", "escalation.create",
    "escalation.work", "workflow.control", "events.read",
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

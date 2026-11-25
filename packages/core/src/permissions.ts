import { MembershipRole, isOwnerOrAdmin } from "@ros/contracts";

/**
 * What each team role may do. A member (`hiring_manager`) sees the company's jobs and candidates, builds, edits and
 * publishes jobs, acts on candidates and may ask for a bigger plan. An owner and an admin may do all of that, and also
 * pause, resume and close a job, set its closing date, take over a draft, change the company's details and manage its
 * people. Making someone an owner is an owner's alone: that rule is with the team's other rules (apps/api
 * services/team.ts), as it depends on who is changed, not only on who asks. A platform administrator has no team role
 * and none of these.
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
  /** Every action on a candidate: shortlist, the AI interview's link, hire, not selected, undo, the decision email. */
  | "application.act"
  /** Ask ITS for a bigger plan (the Upgrade button). */
  | "plan.request";

const MEMBER: ReadonlySet<Permission> = new Set<Permission>(["company.read", "role.create", "role.read", "role.publish", "packet.edit", "application.read", "application.act", "plan.request"]);
/** What an owner or an admin may do: everything a member may, and the three that manage. */
const MANAGER: ReadonlySet<Permission> = new Set<Permission>([...MEMBER, "company.update", "members.manage", "role.manage"]);

/** Who is an owner or an admin is asked of the contracts' one test (`isOwnerOrAdmin`); a role the product does not have may do nothing. */
export function can(role: MembershipRole | null | undefined, permission: Permission): boolean {
  if (!role || !MembershipRole.options.includes(role)) return false;
  return (isOwnerOrAdmin(role) ? MANAGER : MEMBER).has(permission);
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

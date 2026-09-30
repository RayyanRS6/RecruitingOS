import { and, eq, inArray } from "drizzle-orm";
import type { Actor, MembershipRole, RolePacket } from "@ros/contracts";
import { memberships, users, type Queryable } from "@ros/db";

/**
 * Who may decide a role packet approval (docs/spec/21 section 7: named decision maker and the self-approval rule).
 *
 * An approval request may be reserved for named members. The ids live in the request's `proposal` under
 * `requiredUserIds`, beside what is proposed, so no schema change was needed while migration numbers 0023 and 0024
 * are reserved by other packages; `requiredUserIdsOf` is the one place that reads them. When a request carries ids,
 * only those members or an owner may decide it; otherwise the request's `requiredRoles` apply as before.
 */
export type DecisionMaker = { userId: string; name: string | null; email: string };

type DeciderRequest = { requiredRoles: string[]; proposal: Record<string, unknown> };

export function requiredUserIdsOf(req: { proposal: Record<string, unknown> }): string[] {
  const ids = req.proposal.requiredUserIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function decisionMakerOf(req: { proposal: Record<string, unknown> }): DecisionMaker | null {
  const dm = req.proposal.decisionMaker as Partial<DecisionMaker> | undefined;
  return dm && typeof dm.userId === "string" && typeof dm.email === "string" ? { userId: dm.userId, name: typeof dm.name === "string" ? dm.name : null, email: dm.email } : null;
}

export type DecideCheck = { ok: true } | { ok: false; code: "wrong_role" | "named_decider"; message: string };

/** The role check every approval decision passes, with the named-decider rule on top of the approver roles. */
export function mayDecideApproval(req: DeciderRequest, viewer: { userId: string; role: MembershipRole }): DecideCheck {
  const named = requiredUserIdsOf(req);
  if (named.length) {
    if (named.includes(viewer.userId) || viewer.role === "owner") return { ok: true };
    const dm = decisionMakerOf(req);
    return { ok: false, code: "named_decider", message: `This decision is reserved for ${dm?.name ?? dm?.email ?? "the named decision maker"}; an owner can also decide it.` };
  }
  if (!req.requiredRoles.includes(viewer.role)) return { ok: false, code: "wrong_role", message: `This decision needs one of: ${req.requiredRoles.join(", ")}.` };
  return { ok: true };
}

/** True when the person holds the owner role and nobody else does: a one-person company approves its own roles. */
export async function isSoleOwner(q: Queryable, companyId: string, userId: string): Promise<boolean> {
  const owners = await q.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.role, "owner"), eq(memberships.status, "active")));
  return owners.length === 1 && owners[0].userId === userId;
}

export type SelfApprovalCheck = { ok: true } | { ok: false; code: "self_approval"; message: string };

/**
 * A person does not approve the role they started from the intake or the packet version they wrote, unless they are
 * the company's only owner. The message says so, because a one-person company must be able to move on its own.
 */
export async function selfApprovalCheck(q: Queryable, input: { companyId: string; userId: string; roleCreatedBy: Actor; versionCreatedBy: Actor }): Promise<SelfApprovalCheck> {
  const drafted = input.roleCreatedBy.kind === "user" && input.roleCreatedBy.id === input.userId;
  const wrote = input.versionCreatedBy.kind === "user" && input.versionCreatedBy.id === input.userId;
  if (!drafted && !wrote) return { ok: true };
  if (await isSoleOwner(q, input.companyId, input.userId)) return { ok: true };
  return {
    ok: false,
    code: "self_approval",
    message: wrote && !drafted
      ? "You wrote this version, so another owner, admin or hiring manager needs to approve it. Only a company's sole owner can approve their own edits."
      : "You started this role, so another owner, admin or hiring manager needs to approve it. Only a company's sole owner can approve their own roles.",
  };
}

/** Roles that may approve a role packet; a decision maker who cannot approve is not reserved for, so nothing gets stuck. */
const APPROVER_ROLES = ["owner", "admin", "hiring_manager"];
const TITLES = /\b(dr|mr|mrs|ms|miss|prof)\.?\s+/g;
const NOT_A_NAME = new Set(["", "the owner", "owner", "me", "myself", "i", "the hiring manager", "hiring manager"]);

function normalizeName(s: string): string {
  return s.toLowerCase().replace(TITLES, "").replace(/[^a-z0-9@.]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The decision maker the packet names, as a team member: the stored user id when it is an active approver, else the
 * stated name or email matched against active approvers (a full name, an email, or a single first or last name that
 * fits exactly one person). "The owner" and "me" are not names; owners can approve anyway.
 */
export async function resolveDecisionMaker(q: Queryable, companyId: string, packet: Pick<RolePacket, "preferences">): Promise<DecisionMaker | null> {
  const rows = await q
    .select({ userId: memberships.userId, name: users.name, email: users.email })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.companyId, companyId), eq(memberships.status, "active"), inArray(memberships.role, APPROVER_ROLES)));
  const pick = (r: { userId: string; name: string | null; email: string }): DecisionMaker => ({ userId: r.userId, name: r.name, email: r.email });
  const byId = packet.preferences.decisionMakerUserId ? rows.find((r) => r.userId === packet.preferences.decisionMakerUserId) : null;
  if (byId) return pick(byId);
  const stated = normalizeName(packet.preferences.decisionMakerName ?? "");
  if (NOT_A_NAME.has(stated)) return null;
  const byEmail = rows.filter((r) => r.email.toLowerCase() === stated);
  if (byEmail.length === 1) return pick(byEmail[0]);
  const exact = rows.filter((r) => r.name && normalizeName(r.name) === stated);
  if (exact.length === 1) return pick(exact[0]);
  // A name of several words that matched nobody in full is somebody else ("John Smith" is not the team's John Doe): nothing is reserved.
  const statedParts = stated.split(" ");
  if (statedParts.length !== 1) return null;
  const partial = rows.filter((r) => r.name && normalizeName(r.name).split(" ").some((part) => part.length > 1 && statedParts.includes(part)));
  return partial.length === 1 ? pick(partial[0]) : null;
}

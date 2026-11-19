import { and, asc, count, eq, inArray } from "drizzle-orm";
import { MEMBERSHIP_ROLE_LABEL, appPaths, seatsFullLine, type Actor, type InviteAnswer, type InviteMember, type LeftCompany, type MemberChanged, type MembershipRole, type TeamInvitation, type TeamView, type UpdateMember } from "@ros/contracts";
import { FRESH_SESSION_MS, REAUTH_WINDOW_MS, audit, can, createInvitation, emit, entitlements, invitationLink, invitationState, isRecentlyAuthenticated, listPendingInvitations, normalizeEmail, notify, resendInvitation, revokeInvitation, revokeSessionsForCompany, roleInWords, setActiveCompany, type InvitationRow, type SessionContext } from "@ros/core";
import { queueCommunication } from "@ros/agents";
import { communications, companies, invitations, memberships, users, withPlatform, withTenant, type Tx } from "@ros/db";
import { mailbox } from "@ros/integrations";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";

/**
 * The team behind Settings, Team (/companies/current/members and its invitations). Every tenant-table write runs inside
 * the caller's tenant transaction; ending a person's sessions is a platform write and runs after that transaction has
 * committed. Messages to people go through the outbox, never straight to a provider.
 *
 * The rules: an owner or an admin manages the team; only an owner makes someone an owner, or changes or removes one;
 * nobody changes their own membership; the last owner stays; making someone an owner or an admin needs a recent
 * sign-in.
 */

/** `session`: when the person signed in, and when they last confirmed it was them. Granting admin or owner needs a recent one. */
type Team = { tenant: Tenant; actor: Actor; container: Container; session: Pick<SessionContext, "createdAt" | "reauthenticatedAt"> | null };

/** The roles this person may invite someone as or change someone to: an owner all three, an admin Admin and Member, a member none. */
function grantableRoles(role: MembershipRole): MembershipRole[] {
  return role === "owner" ? ["owner", "admin", "hiring_manager"] : role === "admin" ? ["admin", "hiring_manager"] : [];
}

const SELF_CHANGE = "You cannot change your own role or remove yourself. Ask another owner or admin to do it.";
const ONLY_OWNER = "This is the only owner. Make someone else an owner first.";
const LEAVE_ONLY_OWNER = "You are the only owner. Make someone else an owner first, then leave. To close the whole company, ask ITS.";
const OWNERS_CHANGE_OWNERS = "Only an owner can make someone an owner, or change an owner's role.";

/** Where an invitation's email stands, read from the email of the link that works now, so a fresh link's email is the one that counts. */
const INVITATION_EMAIL: Record<string, NonNullable<TeamInvitation["emailState"]>> = { queued: "on_its_way", sending: "on_its_way", sent: "sent", delivered: "sent", opened: "sent", clicked: "sent", failed: "failed", bounced: "failed", complained: "failed", unknown: "failed", cancelled: "failed" };

/** The key of the email that carries an invitation's link as it is now. */
const invitationEmailKey = (inv: Pick<InvitationRow, "id" | "tokenHash">) => `invite:${inv.id}:${inv.tokenHash.slice(0, 12)}`;

function invitationView(row: InvitationRow, emailStatus: string | undefined): TeamInvitation {
  const role = row.role as MembershipRole;
  return { id: row.id, email: row.email, name: row.name, role, roleLabel: MEMBERSHIP_ROLE_LABEL[role] ?? row.role, invitedBy: row.invitedBy.name ?? null, createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), emailState: INVITATION_EMAIL[emailStatus ?? ""] ?? null };
}

/**
 * The team as Settings shows it: the active members (removed people are gone from the list), the invitations still open
 * (only for someone who manages the team: a member has no use for invitees' addresses), the plan's people, and what the
 * person looking may do, so no screen works the role rules out again.
 */
export async function teamView({ tenant, container }: Pick<Team, "tenant" | "container">): Promise<TeamView> {
  const now = container.engine.clock();
  return withTenant(container.db, tenant.companyId, async (tx) => {
    const people = await tx
      .select({ userId: memberships.userId, role: memberships.role, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.status, "active")))
      .orderBy(asc(memberships.createdAt));
    const mayManage = can(tenant.role, "members.manage");
    const owners = people.filter((p) => p.role === "owner").length;
    const members = people.map((p) => {
      const role = p.role as MembershipRole;
      const you = p.userId === tenant.userId;
      const blocked = !mayManage ? null : you ? SELF_CHANGE : role === "owner" && tenant.role !== "owner" ? OWNERS_CHANGE_OWNERS : null;
      return { userId: p.userId, name: p.name, email: p.email, role, roleLabel: MEMBERSHIP_ROLE_LABEL[role] ?? p.role, you, mayChange: mayManage && !blocked, changeBlockedReason: blocked };
    });
    const open = mayManage ? await listPendingInvitations(tx, tenant.companyId, now) : [];
    const sent = open.length ? await tx.select({ key: communications.idempotencyKey, status: communications.status }).from(communications).where(inArray(communications.idempotencyKey, open.map(invitationEmailKey))) : [];
    const emailStatus = new Map(sent.map((s) => [s.key, s.status]));
    const used = await entitlements.seatsInUse(tx, tenant.companyId, { now });
    const limit = await entitlements.seatLimit(tx, tenant.companyId);
    const line = limit !== null && used >= limit ? seatsFullLine(limit, (await entitlements.planOf(tx, tenant.companyId))?.key) : null;
    const onlyOwner = tenant.role === "owner" && owners <= 1;
    return {
      members,
      invitations: open.map((r) => invitationView(r, emailStatus.get(invitationEmailKey(r)))),
      seats: { used, limit, full: line !== null, line },
      viewer: { userId: tenant.userId, role: tenant.role, mayManage, grantableRoles: grantableRoles(tenant.role), mayLeave: !onlyOwner, leaveBlockedReason: onlyOwner ? LEAVE_ONLY_OWNER : null },
    };
  });
}

async function companyNameOf(tx: Tx, companyId: string): Promise<string> {
  const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return company?.name ?? "your team";
}

/** One email per invitation, through the outbox inside the tenant transaction, so a rolled-back invite sends nothing. Answers the invitation's link. */
async function queueInvitationEmail(tx: Tx, team: Team, input: { invitation: InvitationRow; token: string; inviterName: string; again: boolean }): Promise<string> {
  const { container, tenant, actor } = team;
  const link = invitationLink(container.env.APP_BASE_URL, input.token);
  const product = container.env.PRODUCT_NAME;
  const companyName = await companyNameOf(tx, tenant.companyId);
  const inv = input.invitation;
  const ways = container.env.MAGIC_LINK_ENABLED ? "Google or Microsoft, or ask for an emailed sign-in link" : "Google or Microsoft";
  const text = [
    inv.name ? `Hi ${inv.name},\n` : null,
    `${input.inviterName} invited you to ${companyName}'s hiring workspace on ${product}, as ${roleInWords(inv.role)}.`,
    `Accept the invitation:\n${link}`,
    `The link works for seven days. Sign in with ${ways}, using this address (${inv.email}): the invitation belongs to it.`,
    "If you were not expecting this, you can ignore this email.",
  ].filter((line) => line !== null).join("\n\n");
  await queueCommunication(tx, container.integrations, {
    companyId: tenant.companyId,
    channel: "email",
    to: inv.email,
    from: mailbox(`${companyName} via ${product}`, container.integrations.env.fromAddress),
    subject: input.again ? `Reminder: ${input.inviterName} invited you to ${companyName} on ${product}` : `${input.inviterName} invited you to ${companyName} on ${product}`,
    text,
    templateKey: "invite",
    tags: { template: "invite" },
    idempotencyKey: invitationEmailKey(inv),
    actor,
  });
  return link;
}

/** What inviting and sending an invitation again answer: the invitation with its email on its way, and its link for the person to copy. */
function inviteAnswer(row: InvitationRow, link: string): InviteAnswer {
  return { ok: true, invitation: invitationView(row, "queued"), emailed: true, link };
}

/**
 * Creates the invitation and queues its one email. Refused: an owner invitation from anyone but an owner (accepting the
 * invitation would make the person an owner), an address on an ITS staff domain (ITS staff are never members of a
 * company), an address that is already an active member, and one more person than the plan's people. An older open
 * invitation for the same address is replaced by the new one.
 */
export async function inviteMember(team: Team, input: { body: InviteMember; inviterName: string }): Promise<InviteAnswer> {
  const { container, tenant, actor } = team;
  assertMayInviteAs(team, input.body.role);
  const email = normalizeEmail(input.body.email);
  if (container.env.ITS_STAFF_EMAIL_DOMAINS.includes(email.split("@")[1] ?? "")) throw new HttpError(400, "staff_domain", "That address belongs to ITS. ITS staff are not team members.");
  const now = container.engine.clock();
  const answer = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [member] = await tx.select({ id: memberships.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.status, "active"), eq(users.email, email))).limit(1);
    if (member) throw new HttpError(409, "already_member", `${email} is already on your team.`);
    await assertSeatFor(tx, tenant.companyId, email, now);
    // A new invitation replaces any open one for the same address (core createInvitation), which withdraws it: the same
    // rank as withdrawing it directly applies, so an admin does not replace an owner invitation with a lower one.
    const open = await tx.select({ role: invitations.role }).from(invitations).where(and(eq(invitations.companyId, tenant.companyId), eq(invitations.email, email), eq(invitations.status, "pending")));
    for (const o of open) assertMayWithdraw(tenant, o.role);
    const created = await createInvitation(tx, { companyId: tenant.companyId, email, role: input.body.role, name: input.body.name ?? null, invitedBy: actor, now });
    return inviteAnswer(created.row, await queueInvitationEmail(tx, team, { invitation: created.row, token: created.token, inviterName: input.inviterName, again: false }));
  });
  await container.kick();
  return answer;
}

/** The plan's people, counting invitations not yet answered (one to this same address is not counted twice). Taken under the company's seat lock. */
async function assertSeatFor(tx: Tx, companyId: string, email: string, now: Date): Promise<void> {
  const seats = await entitlements.seatRoom(tx, companyId, { now, exceptEmail: email });
  if (!seats.ok && seats.limit !== null) throw new HttpError(409, "seats_full", seatsFullLine(seats.limit, seats.planKey), { seats: { used: seats.used, limit: seats.limit } });
}

/**
 * Only an owner grants the owner role, whichever way it is granted: an invitation accepted at sign-in creates the
 * membership with the invited role, so inviting someone as owner is refused exactly as promoting them is. Granting owner
 * or admin needs a recent sign-in.
 */
function assertMayInviteAs(team: Team, role: string): void {
  if (role === "owner" && team.tenant.role !== "owner") throw new HttpError(403, "owner_only", "Only an owner can invite another owner.");
  if (role === "owner" || role === "admin") assertRecentSignIn(team);
}

/**
 * A session opened in the last thirty minutes, or one whose holder confirmed with their sign-in provider again in the
 * last ten (POST /api/v1/auth/reauth/start, then the provider, then the callback). Otherwise 403 `reauth_required`,
 * which Settings turns into "Confirm it's you".
 */
function assertRecentSignIn(team: Team): void {
  if (team.session && isRecentlyAuthenticated(team.session, team.container.engine.clock())) return;
  throw new HttpError(403, "reauth_required", "To make someone an admin or an owner, confirm it's you first: sign in with your provider again, then try once more.", { freshSessionMinutes: FRESH_SESSION_MS / 60_000, reauthMinutes: REAUTH_WINDOW_MS / 60_000 });
}

/** A fresh link (the old one stops working), another seven days, and the email again. */
export async function resendMemberInvitation(team: Team, input: { invitationId: string; inviterName: string }): Promise<InviteAnswer> {
  const { container, tenant, actor } = team;
  const now = container.engine.clock();
  const answer = await withTenant(container.db, tenant.companyId, async (tx) => {
    // An invitation that lapsed unanswered gave its place back; sending it again takes one again, so it is refused when
    // the plan's people are all in use. A pending one already holds its place.
    const [lapsed] = await tx.select({ email: invitations.email, status: invitations.status, expiresAt: invitations.expiresAt }).from(invitations).where(and(eq(invitations.id, input.invitationId), eq(invitations.companyId, tenant.companyId))).limit(1);
    if (lapsed && invitationState(lapsed, now) === "expired") await assertSeatFor(tx, tenant.companyId, lapsed.email, now);
    const rotated = await resendInvitation(tx, { invitationId: input.invitationId, companyId: tenant.companyId, actor, now });
    if (!rotated) throw new HttpError(404, "not_found", "No open invitation with that id.");
    // A fresh link to an owner or admin invitation is for those who may grant it; the refusal rolls the rotation back, so the old link still works.
    assertMayInviteAs(team, rotated.row.role);
    return inviteAnswer(rotated.row, await queueInvitationEmail(tx, team, { invitation: rotated.row, token: rotated.token, inviterName: input.inviterName, again: true }));
  });
  await container.kick();
  return answer;
}

/**
 * Withdraws an open invitation. An invitation that would make someone an owner is withdrawn only by an owner, the same
 * rank as sending it again; withdrawing needs no recent sign-in, as taking a role away does not. The refusal rolls the
 * withdrawal and its audit record back, so the invitation stays open.
 */
export async function revokeMemberInvitation(team: Team, input: { invitationId: string }): Promise<{ ok: true }> {
  const { container, tenant, actor } = team;
  const row = await withTenant(container.db, tenant.companyId, async (tx) => {
    const revoked = await revokeInvitation(tx, { invitationId: input.invitationId, companyId: tenant.companyId, actor, now: container.engine.clock() });
    if (revoked) assertMayWithdraw(tenant, revoked.role);
    return revoked;
  });
  if (!row) throw new HttpError(404, "not_found", "No open invitation with that id.");
  return { ok: true };
}

function assertMayWithdraw(tenant: Tenant, role: string): void {
  if (role === "owner" && tenant.role !== "owner") throw new HttpError(403, "owner_only", "Only an owner can withdraw an invitation to become an owner.");
}

/** How many active owners the company has. */
async function ownerCount(tx: Tx, companyId: string): Promise<number> {
  const [owners] = await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.role, "owner"), eq(memberships.status, "active")));
  return Number(owners?.n ?? 0);
}

/**
 * A role change or a removal. The rules, in the order they are checked: nobody changes their own membership (409
 * `self_change`); the target must be an active member (404); the last active owner is neither demoted nor removed (409
 * `last_owner`); only an owner grants or takes the owner role, including by removal (403 `owner_only`); granting admin
 * or owner needs a recent sign-in (403 `reauth_required`). Either change ends the person's sessions in this company so
 * it applies at once.
 */
export async function updateMember(team: Team, input: { userId: string; body: UpdateMember }): Promise<MemberChanged> {
  const { container, tenant, actor } = team;
  const { userId, body } = input;
  const removing = body.status === "removed";
  if (userId === tenant.userId) throw new HttpError(409, "self_change", SELF_CHANGE);
  const now = container.engine.clock();
  const outcome = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [target] = await tx.select({ id: memberships.id, role: memberships.role }).from(memberships).where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.userId, userId), eq(memberships.status, "active"))).limit(1);
    if (!target) throw new HttpError(404, "not_found", "That person is not an active member of your team.");
    const from = target.role as MembershipRole;
    const to = body.role ?? from;
    if (!removing && to === from) return { role: from, changed: false, removed: false };
    if (from === "owner" && (await ownerCount(tx, tenant.companyId)) <= 1) throw new HttpError(409, "last_owner", ONLY_OWNER);
    if ((from === "owner" || to === "owner") && tenant.role !== "owner") throw new HttpError(403, "owner_only", OWNERS_CHANGE_OWNERS);
    if (removing) {
      await endMembership(tx, team, { userId, membershipId: target.id, role: from, left: false });
      return { role: from, changed: true, removed: true };
    }
    // Granting admin or owner needs a recent sign-in; taking either away does not.
    if (to === "admin" || to === "owner") assertRecentSignIn(team);
    await tx.update(memberships).set({ role: to }).where(eq(memberships.id, target.id));
    await emit(tx, { type: "membership.changed", companyId: tenant.companyId, actor, subject: { type: "user", id: userId }, payload: { role: to, previousRole: from, status: "active" } });
    await audit(tx, { companyId: tenant.companyId, actor, action: "membership.changed", target: { type: "user", id: userId }, reason: `role changed from ${from} to ${to}`, details: { from, to } });
    return { role: to, changed: true, removed: false };
  });
  if (outcome.changed) {
    // Sessions are a platform table: ended after the membership change has committed, so the new role (or none) applies
    // at once. Only the sessions working in this company (core `revokeSessionsForCompany`): a person who also works for
    // another company is not signed out of it, and nothing about their other companies goes into this company's history.
    await withPlatform(container.db, async (tx) => {
      const r = await revokeSessionsForCompany(tx, userId, tenant.companyId, { now });
      if (r.sessionsEnded > 0) await audit(tx, { companyId: tenant.companyId, actor, action: "session.revoked", target: { type: "user", id: userId }, reason: outcome.removed ? "removed from the team" : "role changed", details: { sessionsEnded: r.sessionsEnded, scope: "company" } });
    });
  }
  return { ok: true, userId, role: outcome.role, status: outcome.removed ? "removed" : "active" };
}

/**
 * Ends a membership inside the tenant transaction, whether someone removed the person or they left: the membership is
 * marked removed. Recorded as `member.removed` and `membership.changed` (with `left: true` when they left) and audited.
 */
async function endMembership(tx: Tx, team: Team, input: { userId: string; membershipId: string; role: string; left: boolean }): Promise<void> {
  const { tenant, actor } = team;
  const { userId, role, left } = input;
  await tx.update(memberships).set({ status: "removed" }).where(eq(memberships.id, input.membershipId));
  await emit(tx, { type: "member.removed", companyId: tenant.companyId, actor, subject: { type: "user", id: userId }, payload: { role, ...(left ? { left: true } : {}) } });
  await emit(tx, { type: "membership.changed", companyId: tenant.companyId, actor, subject: { type: "user", id: userId }, payload: { role, status: "removed", ...(left ? { left: true } : {}) } });
  await audit(tx, { companyId: tenant.companyId, actor, action: "membership.changed", target: { type: "user", id: userId }, reason: left ? "left the team" : "removed from the team", details: { role } });
}

/**
 * "Leave this company": any member may leave; an owner only while another active owner remains (409 `last_owner`).
 * Leaving is a removal the person makes themselves, with the same effects, and the owners and admins are told.
 * Afterwards this session moves to another company the person still works in, if any, and their sessions working in
 * this company end; with no other company they are signed out. Closing a whole company stays a request to ITS.
 */
export async function leaveCompany(team: Team, input: { sessionId: string }): Promise<LeftCompany> {
  const { container, tenant } = team;
  const now = container.engine.clock();
  const left = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [me] = await tx
      .select({ id: memberships.id, role: memberships.role, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.userId, tenant.userId), eq(memberships.status, "active")))
      .limit(1);
    if (!me) throw new HttpError(404, "not_found", "You are not an active member of this company.");
    if (me.role === "owner" && (await ownerCount(tx, tenant.companyId)) <= 1) throw new HttpError(409, "last_owner", LEAVE_ONLY_OWNER);
    const who = me.name ?? me.email;
    await endMembership(tx, team, { userId: tenant.userId, membershipId: me.id, role: me.role, left: true });
    await notify(tx, { companyId: tenant.companyId, kind: "member.left", title: `${who} left the team`, body: `${who} left the company on their own. They no longer have access. What they did stays in the record.`, action: { label: "Open the team", href: appPaths.settings }, roles: ["owner", "admin"] });
    return companyNameOf(tx, tenant.companyId);
  });
  // After the commit, on the platform side: this session moves to the person's other company, if they have one, and
  // every session still working here ends (core `revokeSessionsForCompany` leaves those in other companies open).
  const movedTo = await withPlatform(container.db, async (tx) => {
    const [other] = await tx
      .select({ companyId: memberships.companyId, name: companies.name })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(and(eq(memberships.userId, tenant.userId), eq(memberships.status, "active")))
      .orderBy(asc(companies.name))
      .limit(1);
    if (other) await setActiveCompany(tx, input.sessionId, other.companyId);
    const r = await revokeSessionsForCompany(tx, tenant.userId, tenant.companyId, { now });
    if (r.sessionsEnded > 0) await audit(tx, { companyId: tenant.companyId, actor: team.actor, action: "session.revoked", target: { type: "user", id: tenant.userId }, reason: "left the team", details: { sessionsEnded: r.sessionsEnded, scope: "company" } });
    return other ? { companyId: other.companyId, companyName: other.name } : null;
  });
  await container.kick();
  return { ok: true, left, movedTo, signedOut: !movedTo };
}

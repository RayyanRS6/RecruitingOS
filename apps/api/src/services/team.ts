import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { Actor, InviteMember, UpdateMember } from "@ros/contracts";
import { FRESH_SESSION_MS, REAUTH_WINDOW_MS, audit, createInvitation, disconnectCalendar, emit, invitationLink, isRecentlyAuthenticated, listPendingInvitations, membersWithCalendarStatus, normalizeEmail, notify, publicInvitation, resendInvitation, revokeInvitation, revokeSessionsForCompany, roleInWords, setActiveCompany, type InvitationRow, type SessionContext } from "@ros/core";
import { queueCommunication } from "@ros/agents";
import { applications, companies, interviewParticipants, interviews, invitations, memberships, users, withPlatform, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { cancelInterviewInTx } from "./interview-cancel";

/**
 * The team behind /companies/current/members and /companies/current/invitations (docs/spec/21, area A). Every
 * tenant-table write runs inside the caller's tenant transaction; ending a person's sessions is a platform write and
 * runs after that transaction has committed. Messages to people go through the outbox, never straight to a provider.
 */

/**
 * `session`: when the person signed in, and when they last confirmed it was them. Making someone an admin or an owner
 * needs a recent one (plan B7), the same rule as changing the AI rules (audit finding A12).
 */
type Team = { tenant: Tenant; actor: Actor; container: Container; session: Pick<SessionContext, "createdAt" | "reauthenticatedAt"> | null };

/** Active members only, each with their scheduling readiness. Removed people are gone from the list. */
export async function listTeam({ tenant, container }: Pick<Team, "tenant" | "container">) {
  const rows = await withTenant(container.db, tenant.companyId, (tx) => membersWithCalendarStatus(tx, tenant.companyId));
  return rows.filter((r) => r.status === "active");
}

export async function listInvitations({ tenant, container }: Pick<Team, "tenant" | "container">) {
  const now = container.engine.clock();
  const rows = await withTenant(container.db, tenant.companyId, (tx) => listPendingInvitations(tx, tenant.companyId, now));
  return rows.map((r) => publicInvitation(r, now));
}

/** The link only a development stand-in may show on screen; production never returns it. */
function devLinkOf(container: Container, link: string): { devLink?: string } {
  return container.env.NODE_ENV !== "production" && container.integrations.email.id === "fake-email" ? { devLink: link } : {};
}

async function companyNameOf(tx: Tx, companyId: string): Promise<string> {
  const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return company?.name ?? "your team";
}

/** One email per invitation, through the outbox inside the tenant transaction, so a rolled-back invite sends nothing. */
async function queueInvitationEmail(tx: Tx, team: Team, input: { invitation: InvitationRow; token: string; companyName: string; inviterName: string; again: boolean }): Promise<string> {
  const { container, tenant, actor } = team;
  const link = invitationLink(container.env.APP_BASE_URL, input.token);
  const product = container.env.PRODUCT_NAME;
  const inv = input.invitation;
  const ways = container.env.MAGIC_LINK_ENABLED ? "Google or Microsoft, or ask for an emailed sign-in link" : "Google or Microsoft";
  const text = [
    inv.name ? `Hi ${inv.name},\n` : null,
    `${input.inviterName} invited you to ${input.companyName}'s hiring workspace on ${product}, as ${roleInWords(inv.role)}.`,
    `Accept the invitation:\n${link}`,
    `The link works for seven days. Sign in with ${ways}, using this address (${inv.email}): the invitation belongs to it.`,
    "If you were not expecting this, you can ignore this email.",
  ].filter((line) => line !== null).join("\n\n");
  await queueCommunication(tx, container.integrations, {
    companyId: tenant.companyId,
    channel: "email",
    to: inv.email,
    from: `${input.companyName} via ${product} <${container.integrations.env.fromAddress}>`,
    subject: input.again ? `Reminder: ${input.inviterName} invited you to ${input.companyName} on ${product}` : `${input.inviterName} invited you to ${input.companyName} on ${product}`,
    text,
    templateKey: "invite",
    tags: { template: "invite" },
    idempotencyKey: `invite:${inv.id}:${inv.tokenHash.slice(0, 12)}`,
    actor,
  });
  return link;
}

/**
 * Creates the invitation and queues its one email. Refused: an owner invitation from anyone but an owner (the same rule
 * as a role change: accepting the invitation would make the person an owner), an address on an ITS staff domain
 * (recruiters join through a scoped grant, never as members) and an address that is already an active member. An older
 * open invitation for the same address is replaced by the new one.
 */
export async function inviteMember(team: Team, input: { body: InviteMember; inviterName: string }) {
  const { container, tenant, actor } = team;
  assertMayInviteAs(team, input.body.role);
  const email = normalizeEmail(input.body.email);
  const domain = email.split("@")[1] ?? "";
  if (container.env.ITS_STAFF_EMAIL_DOMAINS.includes(domain)) throw new HttpError(400, "staff_domain", "That address belongs to ITS. Recruiters are not team members; they get access through Bring in a recruiter, for one request at a time.");
  const now = container.engine.clock();
  const result = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [member] = await tx.select({ id: memberships.id }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.status, "active"), eq(users.email, email))).limit(1);
    if (member) throw new HttpError(409, "already_member", `${email} is already on your team.`);
    // A new invitation replaces any open one for the same address (core createInvitation), which withdraws it: the same
    // ranks as withdrawing it directly apply, so HR cannot quietly replace an admin or owner invitation with a lower one.
    const open = await tx.select({ role: invitations.role }).from(invitations).where(and(eq(invitations.companyId, tenant.companyId), eq(invitations.email, email), eq(invitations.status, "pending")));
    for (const o of open) assertMayWithdraw(tenant, o.role);
    const companyName = await companyNameOf(tx, tenant.companyId);
    const created = await createInvitation(tx, { companyId: tenant.companyId, email, role: input.body.role, name: input.body.name ?? null, invitedBy: actor, now });
    const link = await queueInvitationEmail(tx, team, { invitation: created.row, token: created.token, companyName, inviterName: input.inviterName, again: false });
    return { row: created.row, link, replaced: created.replaced.length };
  });
  await container.kick();
  return { ok: true as const, invitation: publicInvitation(result.row, now), replaced: result.replaced, ...devLinkOf(container, result.link) };
}

/**
 * Only an owner grants the owner role, and only an owner or an admin grants the admin role (plan B7), whichever way it
 * is granted: an invitation accepted at sign-in creates the membership with the invited role, so inviting someone as
 * owner or admin is refused exactly as promoting them is. Either needs a recent sign-in.
 */
function assertMayInviteAs(team: Team, role: string): void {
  if (role === "owner" && team.tenant.role !== "owner") throw new HttpError(403, "owner_only", "Only an owner can invite another owner.");
  if (role === "admin" && !mayGrantAdmin(team.tenant)) throw new HttpError(403, "admin_only", "Only an owner or an admin can invite an admin.");
  if (role === "owner" || role === "admin") assertRecentSignIn(team);
}

/** Who may make someone an admin, or change or remove an admin: never HR, who otherwise manages the team. */
function mayGrantAdmin(tenant: Tenant): boolean {
  return tenant.role === "owner" || tenant.role === "admin";
}

/** The same rule and the same refusal as middleware/reauth.ts, which Setup turns into "Confirm it's you". */
function assertRecentSignIn(team: Team): void {
  if (team.session && isRecentlyAuthenticated(team.session, team.container.engine.clock())) return;
  throw new HttpError(403, "reauth_required", "To make someone an admin or an owner, confirm it's you first: sign in with your provider again, then try once more.", { freshSessionMinutes: FRESH_SESSION_MS / 60_000, reauthMinutes: REAUTH_WINDOW_MS / 60_000 });
}

/** A fresh link (the old one stops working) and another seven days; the email goes out again. */
export async function resendMemberInvitation(team: Team, input: { invitationId: string; inviterName: string }) {
  const { container, tenant, actor } = team;
  const now = container.engine.clock();
  const result = await withTenant(container.db, tenant.companyId, async (tx) => {
    const rotated = await resendInvitation(tx, { invitationId: input.invitationId, companyId: tenant.companyId, actor, now });
    if (!rotated) throw new HttpError(404, "not_found", "No open invitation with that id.");
    // A fresh link to an owner or admin invitation is for those who may grant it; the refusal rolls the rotation back, so the old link still works.
    assertMayInviteAs(team, rotated.row.role);
    const companyName = await companyNameOf(tx, tenant.companyId);
    const link = await queueInvitationEmail(tx, team, { invitation: rotated.row, token: rotated.token, companyName, inviterName: input.inviterName, again: true });
    return { row: rotated.row, link };
  });
  await container.kick();
  return { ok: true as const, invitation: publicInvitation(result.row, now), ...devLinkOf(container, result.link) };
}

/**
 * Withdraws an open invitation. An invitation that would make someone an owner or an admin is withdrawn only by those who
 * may grant that role (audit 01-platform B12): an owner's by an owner, an admin's by an owner or an admin, the same ranks
 * as sending it again; withdrawing needs no recent sign-in, as taking a role away does not. The refusal rolls the
 * withdrawal and its audit record back, so the invitation stays open.
 */
export async function revokeMemberInvitation(team: Team, input: { invitationId: string }) {
  const { container, tenant, actor } = team;
  const now = container.engine.clock();
  const row = await withTenant(container.db, tenant.companyId, async (tx) => {
    const revoked = await revokeInvitation(tx, { invitationId: input.invitationId, companyId: tenant.companyId, actor, now });
    if (revoked) assertMayWithdraw(tenant, revoked.role);
    return revoked;
  });
  if (!row) throw new HttpError(404, "not_found", "No open invitation with that id.");
  return { ok: true as const, invitation: publicInvitation(row, now) };
}

function assertMayWithdraw(tenant: Tenant, role: string): void {
  if (role === "owner" && tenant.role !== "owner") throw new HttpError(403, "owner_only", "Only an owner can withdraw an invitation to become an owner.");
  if (role === "admin" && !mayGrantAdmin(tenant)) throw new HttpError(403, "admin_only", "Only an owner or an admin can withdraw an invitation to become an admin.");
}

const OPEN_INTERVIEW_STATUSES = ["proposed", "scheduling", "scheduled"];

/**
 * A role change or a removal. The rules, in the order they are checked: the target must be an active member (404);
 * nobody changes their own membership (409 self_change); the last active owner is neither demoted nor removed
 * (409 last_owner); only an owner grants or takes the owner role, including by removal (403 owner_only); only an owner
 * or an admin grants or takes the admin role, including by removal (403 admin_only); granting admin or owner needs a
 * recent sign-in (403 reauth_required). Either change
 * ends the person's sessions so it applies at once. Removal also disconnects their calendar (its credential deletion is
 * queued exactly as the disconnect route does), takes them off the interviews still ahead that counted on them, cancels
 * the ones nobody else was on (services/interview-cancel.ts), and tells the owners and admins what happened to each.
 */
export async function updateMember(team: Team, input: { userId: string; body: UpdateMember }) {
  const { container, tenant, actor } = team;
  const { userId, body } = input;
  const removing = body.status === "removed";
  if (body.role === undefined && body.status === undefined) throw new HttpError(400, "invalid_request", "Say what to change: a new role, or status removed.");
  if (userId === tenant.userId) throw new HttpError(409, "self_change", "You cannot change your own role or remove yourself. Ask another owner or admin to do it.");
  const now = container.engine.clock();
  const outcome = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [target] = await tx
      .select({ id: memberships.id, role: memberships.role, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.userId, userId), eq(memberships.status, "active")))
      .limit(1);
    if (!target) throw new HttpError(404, "not_found", "That person is not an active member of your team.");
    const newRole = body.role ?? target.role;
    const roleChanges = newRole !== target.role;
    if (!removing && !roleChanges) return { row: { userId, role: target.role, status: "active" }, changed: false, removed: false, calendarDeletionQueued: false, interviewsFlagged: 0, interviewsCancelled: 0 };
    if (target.role === "owner") {
      const [owners] = await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.role, "owner"), eq(memberships.status, "active")));
      if (Number(owners?.n ?? 0) <= 1) throw new HttpError(409, "last_owner", "This is the only owner. Make someone else an owner first.");
    }
    if ((target.role === "owner" || newRole === "owner") && tenant.role !== "owner") throw new HttpError(403, "owner_only", "Only an owner can make someone an owner, or change an owner's role.");
    if ((target.role === "admin" || newRole === "admin") && !mayGrantAdmin(tenant)) throw new HttpError(403, "admin_only", "Only an owner or an admin can make someone an admin, or change or remove an admin.");
    // Granting admin or owner needs a recent sign-in (plan B7); taking either away, or removing someone, does not.
    if (!removing && roleChanges && (newRole === "admin" || newRole === "owner")) assertRecentSignIn(team);
    const who = target.name ?? target.email;
    if (!removing) {
      const [updated] = await tx.update(memberships).set({ role: newRole }).where(eq(memberships.id, target.id)).returning();
      await emit(tx, { type: "membership.changed", companyId: tenant.companyId, actor, subject: { type: "user", id: userId }, payload: { role: newRole, previousRole: target.role, status: "active" } });
      await audit(tx, { companyId: tenant.companyId, actor, action: "membership.changed", target: { type: "user", id: userId }, reason: `role changed from ${target.role} to ${newRole}`, details: { from: target.role, to: newRole } });
      return { row: { userId, role: updated.role, status: updated.status }, changed: true, removed: false, calendarDeletionQueued: false, interviewsFlagged: 0, interviewsCancelled: 0 };
    }
    const done = await endMembershipInTx(tx, team, { userId, target, who, left: false });
    return { row: { userId, role: done.role, status: done.status }, changed: true, removed: true, calendarDeletionQueued: done.calendarDeletionQueued, interviewsFlagged: done.interviewsFlagged, interviewsCancelled: done.interviewsCancelled };
  });
  let sessionsEnded = 0;
  if (outcome.changed) {
    // Sessions are a platform table: ended after the membership change has committed, so the new role (or none) applies
    // at once. Only the sessions working in this company (core `revokeSessionsForCompany`, audit 01-platform B3): a person
    // who also works for another company is not signed out of it. Every request reads the memberships again, so a session
    // left open there gets the new role, or no way back in after a removal, the moment it switches here.
    sessionsEnded = await withPlatform(container.db, async (tx) => {
      const r = await revokeSessionsForCompany(tx, userId, tenant.companyId, { now });
      // Nothing about the person's other companies goes into this company's audit log.
      if (r.sessionsEnded > 0) await audit(tx, { companyId: tenant.companyId, actor, action: "session.revoked", target: { type: "user", id: userId }, reason: outcome.removed ? "removed from the team" : "role changed", details: { sessionsEnded: r.sessionsEnded, scope: "company" } });
      return r.sessionsEnded;
    });
    if (outcome.removed) await container.kick();
  }
  return { ...outcome.row, sessionsEnded, calendarDeletionQueued: outcome.calendarDeletionQueued, interviewsFlagged: outcome.interviewsFlagged, interviewsCancelled: outcome.interviewsCancelled };
}

type Leaving = { id: string; role: string; email: string; name: string | null };

/**
 * Ends a membership inside the tenant transaction, whether someone removed the person or they left (L-10): the
 * membership is marked removed, their calendar is disconnected (its credential's deletion queued exactly as the
 * disconnect route does), they come off the interviews still ahead, an interview nobody else was on is cancelled through
 * the one cancellation path, and the owners and admins are told what happened to each. Recorded as `member.removed` and
 * `membership.changed` (with `left: true` when they left) and audited.
 */
async function endMembershipInTx(tx: Tx, team: Team, input: { userId: string; target: Leaving; who: string; left: boolean }) {
  const { container, tenant, actor } = team;
  const { userId, target, who, left } = input;
  const now = container.engine.clock();
  const reason = left ? "left the team" : "removed from the team";
  const [updated] = await tx.update(memberships).set({ status: "removed" }).where(eq(memberships.id, target.id)).returning();
  // The same path as POST /integrations/calendar/:provider/disconnect: the connection is unusable now, the credential's deletion is queued.
  const calendar = await disconnectCalendar(tx, { companyId: tenant.companyId, userId, reason, actor, now });
  // Interviews still ahead that counted on this person: they come off them outright. Nothing that reads participants
  // (the scheduling workflow, the calendar bridge, the interview routes) looks at a status, so a row left behind would
  // keep them on the schedule, in the candidate's messages and on the bookings. The notification, the event and the
  // audit record below keep the count.
  const ahead = await tx
    .select({ participantId: interviewParticipants.id, interviewId: interviews.id, applicationId: interviews.applicationId, title: interviews.title, calendarRefs: interviews.calendarRefs })
    .from(interviewParticipants)
    .innerJoin(interviews, eq(interviews.id, interviewParticipants.interviewId))
    .where(and(eq(interviewParticipants.companyId, tenant.companyId), eq(interviewParticipants.userId, userId), inArray(interviews.status, OPEN_INTERVIEW_STATUSES)));
  // Their applications first, in one order, before any interview changes: every path that changes an interview and its
  // application takes the application first (a booking, a cancel, a send of new times), so they take turns.
  const appIds = [...new Set(ahead.map((p) => p.applicationId))];
  if (appIds.length) await tx.select({ id: applications.id }).from(applications).where(inArray(applications.id, appIds)).orderBy(asc(applications.id)).for("update");
  if (ahead.length) await tx.delete(interviewParticipants).where(inArray(interviewParticipants.id, ahead.map((p) => p.participantId)));
  for (const p of ahead) {
    // A booking in their calendar cannot be managed once the calendar is disconnected; its reference goes with them.
    if (!(userId in p.calendarRefs)) continue;
    const { [userId]: _gone, ...refs } = p.calendarRefs;
    await tx.update(interviews).set({ calendarRefs: refs }).where(eq(interviews.id, p.interviewId));
  }
  // An interview that counted on nobody else cannot take place and nothing adds an interviewer to an existing one, so
  // it is cancelled through the one cancellation path: its scheduling run ends, a candidate with a booked time is
  // told, and the candidate goes back to "Interview approved" for the team to approve a new interview. An interview
  // with other interviewers goes ahead with them.
  const cancelled: Array<{ title: string; candidateTold: boolean }> = [];
  const continuing: string[] = [];
  for (const interviewId of [...new Set(ahead.map((p) => p.interviewId))]) {
    const [iv] = await tx.select().from(interviews).where(eq(interviews.id, interviewId)).limit(1);
    if (!iv) continue;
    const [others] = await tx.select({ n: count() }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
    if (Number(others?.n ?? 0) > 0) { continuing.push(iv.title); continue; }
    const done = await cancelInterviewInTx(tx, container, { companyId: tenant.companyId, interview: iv, actor, by: "system", reason: `${who} ${left ? "left" : "was removed from"} the team and was the only interviewer.`, cause: "interviewer_removed", now });
    cancelled.push({ title: iv.title, candidateTold: done.candidateTold });
  }
  if (ahead.length) await notify(tx, { companyId: tenant.companyId, kind: "member.removed_interviews", ...removalNotice(who, cancelled, continuing, left), action: { label: "Open interviews", href: "/interviews" }, roles: ["owner", "admin"] });
  const counts = { calendarDeletionQueued: !!calendar?.queued, interviewsFlagged: ahead.length, interviewsCancelled: cancelled.length };
  await emit(tx, { type: "member.removed", companyId: tenant.companyId, actor, subject: { type: "user", id: userId }, payload: { role: target.role, ...counts, ...(left ? { left: true } : {}) } });
  await emit(tx, { type: "membership.changed", companyId: tenant.companyId, actor, subject: { type: "user", id: userId }, payload: { role: target.role, status: "removed", ...(left ? { left: true } : {}) } });
  await audit(tx, { companyId: tenant.companyId, actor, action: "membership.changed", target: { type: "user", id: userId }, reason, details: { role: target.role, ...counts } });
  return { role: updated.role, status: updated.status, ...counts };
}

/**
 * "Leave this company" (founder decision L-10, 15 October 2026): any member may leave; an owner only while another
 * active owner remains (409 `last_owner`). Leaving is a removal the person makes themselves, with the same effects
 * (`endMembershipInTx`), and the owners and admins are told. Afterwards this session moves to another company the person
 * still works in, if any, and their sessions working in this company end; with no other company they are signed out.
 * Closing a whole company stays a request to ITS. ITS staff under a grant are not members and cannot leave (409).
 */
export async function leaveCompany(team: Team, input: { sessionId: string }) {
  const { container, tenant } = team;
  if (tenant.staff) throw new HttpError(409, "not_a_member", "You work here through recruiter access, not as a member. Your access ends with the request.");
  const now = container.engine.clock();
  const outcome = await withTenant(container.db, tenant.companyId, async (tx) => {
    const [me] = await tx
      .select({ id: memberships.id, role: memberships.role, email: users.email, name: users.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.userId, tenant.userId), eq(memberships.status, "active")))
      .limit(1);
    if (!me) throw new HttpError(404, "not_found", "You are not an active member of this company.");
    if (me.role === "owner") {
      const [owners] = await tx.select({ n: count() }).from(memberships).where(and(eq(memberships.companyId, tenant.companyId), eq(memberships.role, "owner"), eq(memberships.status, "active")));
      if (Number(owners?.n ?? 0) <= 1) throw new HttpError(409, "last_owner", "You are the only owner. Make someone else an owner first, then leave. To close the whole company, ask ITS.");
    }
    const who = me.name ?? me.email;
    const done = await endMembershipInTx(tx, team, { userId: tenant.userId, target: me, who, left: true });
    await notify(tx, { companyId: tenant.companyId, kind: "member.left", title: `${who} left the team`, body: `${who} left the company on their own. They no longer have access. What they did stays in the record.`, action: { label: "Open the team", href: "/setup?tab=team" }, roles: ["owner", "admin"] });
    return { ...done, companyName: await companyNameOf(tx, tenant.companyId) };
  });
  // After the commit, on the platform side: this session moves to the person's other company, if they have one, and
  // every session still working here ends (core `revokeSessionsForCompany` leaves those in other companies open).
  const moved = await withPlatform(container.db, async (tx) => {
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
  return { ok: true as const, left: outcome.companyName, movedTo: moved, signedOut: !moved, calendarDeletionQueued: outcome.calendarDeletionQueued, interviewsFlagged: outcome.interviewsFlagged, interviewsCancelled: outcome.interviewsCancelled };
}

/** Plain words for the owners about the interviews a removed person was on: which were cancelled and which go ahead. */
function removalNotice(who: string, cancelled: Array<{ title: string; candidateTold: boolean }>, continuing: string[], left = false): { title: string; body: string } {
  const list = (titles: string[]) => [...new Set(titles)].slice(0, 5).join(", ");
  const parts: string[] = [];
  if (cancelled.length) {
    const one = cancelled.length === 1;
    const told = cancelled.filter((x) => x.candidateTold).length;
    // A candidate hears about it when they knew of it: a booked time, or times they were offered to pick from.
    const toldLine = told ? ` ${told === 1 ? "The candidate was" : `The ${told} candidates were`} told the interview is off.` : "";
    parts.push(`${list(cancelled.map((x) => x.title))}: ${who} was the only interviewer, so ${one ? "that interview was" : `those ${cancelled.length} interviews were`} cancelled.${toldLine} To go on with ${one ? "the candidate" : "those candidates"}, approve a new interview with another interviewer from ${one ? "their" : "each candidate's"} page.`);
  }
  if (continuing.length) parts.push(`${list(continuing)}: ${continuing.length === 1 ? "goes" : "go"} ahead with the other interviewers.`);
  const title = cancelled.length
    ? `${who} ${left ? "left the team" : "was removed"}; ${cancelled.length === 1 ? "an interview was" : `${cancelled.length} interviews were`} cancelled`
    : `${who} ${left ? "left the team and came off" : "was removed from"} ${continuing.length === 1 ? "an interview" : `${continuing.length} interviews`}`;
  return { title, body: parts.join(" ") };
}

import { createHash } from "node:crypto";
import { and, desc, eq, gt } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { invitations, memberships, randomToken, users, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { seatRoom } from "./entitlements";
import { emit } from "./events";

/**
 * Team invitations (docs/spec/21, area A; migration 0022).
 *
 * An invitation is a row: company, address, role, who sent it, and the hash of the token in the emailed link. The link
 * opens a page on the API that offers Google or Microsoft sign-in (and the email link where a deployment enables it)
 * and parks the token hash in a sealed, short-lived cookie. Acceptance happens while the session opens: the sign-in
 * path calls `acceptPendingInvitations`, which joins the person to the company with the invited role when the verified
 * address is the invited one, and refuses the sign-in when it is not. Every pending invitation for the verified address
 * is accepted at any sign-in, so a person who lost the link still joins by signing in with the invited address. ITS
 * staff accounts never join by invitation; they get access through a scoped grant.
 *
 * This module deliberately imports nothing from ./auth or ./identity (both call into it), so the token hash and the
 * address normalisation are computed here with the same recipes.
 */
export const INVITATION_TTL_MS = 7 * 24 * 3600_000;
/** How long the browser holds the invitation between opening the link and finishing the sign-in. */
export const INVITE_COOKIE_TTL_MS = 30 * 60_000;

export type InvitationRow = typeof invitations.$inferSelect;
export type InvitationState = "pending" | "expired" | "accepted" | "revoked";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const normalize = (email: string) => email.trim().toLowerCase();

/** The same hash the sign-in link uses (see hashToken in ./auth), so a cookie and a row agree. */
export function hashInvitationToken(token: string): string {
  return sha256(token);
}

export function invitationLink(appBaseUrl: string, token: string): string {
  return `${appBaseUrl}/api/v1/auth/invite?token=${encodeURIComponent(token)}`;
}

/** The role in plain words, as the invitation email and the team page say it. */
export function roleInWords(role: string): string {
  return ({ owner: "an owner", admin: "an administrator", hiring_manager: "a hiring manager", interviewer: "an interviewer", hr: "HR", recruiter: "a recruiter" } as Record<string, string>)[role] ?? role.replace(/_/g, " ");
}

/** What an invitation is right now. A pending row past its expiry reads as expired even before anything marks it. */
export function invitationState(row: Pick<InvitationRow, "status" | "expiresAt">, now: Date = new Date()): InvitationState {
  if (row.status === "accepted" || row.status === "revoked" || row.status === "expired") return row.status;
  return Date.parse(row.expiresAt) > now.getTime() ? "pending" : "expired";
}

/** What a team member may see about an invitation. Never the token hash. */
export function publicInvitation(row: InvitationRow, now: Date = new Date()) {
  return { id: row.id, email: row.email, role: row.role, name: row.name, status: invitationState(row, now), expiresAt: row.expiresAt, invitedBy: { name: row.invitedBy.name ?? null }, createdAt: row.createdAt, acceptedAt: row.acceptedAt, revokedAt: row.revokedAt };
}

/**
 * Creates the invitation and returns the token for the link (the caller sends it through the outbox). An older open
 * invitation for the same address in this company is replaced: only one link per address works at a time.
 */
export async function createInvitation(
  q: Queryable,
  input: { companyId: string; email: string; role: string; name?: string | null; invitedBy: Actor; now?: Date; ttlMs?: number },
): Promise<{ row: InvitationRow; token: string; replaced: string[] }> {
  const now = input.now ?? new Date();
  const email = normalize(input.email);
  const older = await q
    .update(invitations)
    .set({ status: "revoked", revokedAt: now.toISOString() })
    .where(and(eq(invitations.companyId, input.companyId), eq(invitations.email, email), eq(invitations.status, "pending")))
    .returning({ id: invitations.id });
  const token = randomToken(32);
  const [row] = await q
    .insert(invitations)
    .values({ companyId: input.companyId, email, role: input.role, name: input.name ?? null, invitedBy: input.invitedBy, tokenHash: sha256(token), status: "pending", expiresAt: new Date(now.getTime() + (input.ttlMs ?? INVITATION_TTL_MS)).toISOString() })
    .returning();
  await emit(q, { type: "user.invited", companyId: input.companyId, actor: input.invitedBy, subject: { type: "invitation", id: row.id }, payload: { email, role: input.role, replaced: older.length } });
  await audit(q, { companyId: input.companyId, actor: input.invitedBy, action: "invitation.sent", target: { type: "invitation", id: row.id }, reason: `invited ${email} as ${input.role}`, details: { email, role: input.role, replaced: older.map((o) => o.id) } });
  return { row, token, replaced: older.map((o) => o.id) };
}

/** A fresh token and another seven days for an invitation that is still open (or lapsed unanswered); the old link stops working. */
export async function resendInvitation(
  q: Queryable,
  input: { invitationId: string; companyId: string; actor: Actor; now?: Date; ttlMs?: number },
): Promise<{ row: InvitationRow; token: string } | null> {
  const now = input.now ?? new Date();
  const [existing] = await q.select().from(invitations).where(and(eq(invitations.id, input.invitationId), eq(invitations.companyId, input.companyId))).limit(1);
  if (!existing) return null;
  const state = invitationState(existing, now);
  if (state !== "pending" && state !== "expired") return null;
  const token = randomToken(32);
  const [row] = await q
    .update(invitations)
    .set({ tokenHash: sha256(token), status: "pending", expiresAt: new Date(now.getTime() + (input.ttlMs ?? INVITATION_TTL_MS)).toISOString() })
    .where(eq(invitations.id, existing.id))
    .returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "invitation.resent", target: { type: "invitation", id: row.id }, reason: `sent again to ${row.email}`, details: { email: row.email, role: row.role, wasExpired: state === "expired" } });
  return { row, token };
}

export async function revokeInvitation(q: Queryable, input: { invitationId: string; companyId: string; actor: Actor; now?: Date }): Promise<InvitationRow | null> {
  const now = input.now ?? new Date();
  const [row] = await q
    .update(invitations)
    .set({ status: "revoked", revokedAt: now.toISOString() })
    .where(and(eq(invitations.id, input.invitationId), eq(invitations.companyId, input.companyId), eq(invitations.status, "pending")))
    .returning();
  if (!row) return null;
  await emit(q, { type: "invitation.revoked", companyId: input.companyId, actor: input.actor, subject: { type: "invitation", id: row.id }, payload: { email: row.email, role: row.role } });
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "invitation.revoked", target: { type: "invitation", id: row.id }, reason: `withdrew the invitation to ${row.email}`, details: { email: row.email, role: row.role } });
  return row;
}

export async function findInvitationByToken(q: Queryable, token: string): Promise<InvitationRow | null> {
  if (!token) return null;
  const [row] = await q.select().from(invitations).where(eq(invitations.tokenHash, sha256(token))).limit(1);
  return row ?? null;
}

/** Open invitations for a company, newest first. */
export async function listPendingInvitations(q: Queryable, companyId: string, now: Date = new Date()): Promise<InvitationRow[]> {
  return q.select().from(invitations).where(and(eq(invitations.companyId, companyId), eq(invitations.status, "pending"), gt(invitations.expiresAt, now.toISOString()))).orderBy(desc(invitations.createdAt));
}

/** Raised while a session opens: the sign-in carried an invitation it cannot honour. The transaction rolls back; no session opens. */
export class InvitationRefused extends Error {
  status = 403;
  /** The verified address that was refused rides along for the audit record the caller writes once the transaction has rolled back. */
  constructor(public readonly code: "invite_email_mismatch" | "invite_expired" | "invite_seats_full", message: string, public readonly email: string | null = null) {
    super(message);
  }
}

export type AcceptedInvitation = { invitationId: string; companyId: string; role: string };

/**
 * Runs inside the transaction that opens a session, once the person is known. Honours the invitation the browser
 * carried (its token hash, from the sealed cookie) and every other open invitation for the verified address:
 *   - the carried invitation names a different address: refused (`invite_email_mismatch`), and the caller keeps the cookie
 *     so the person can sign in again with the right account;
 *   - the carried invitation is expired or withdrawn: refused (`invite_expired`); the caller drops the cookie;
 *   - otherwise every open invitation for the address becomes an active membership with its role, marked accepted,
 *     with `member.joined` emitted and `invitation.accepted` audited. ITS staff accounts accept nothing.
 * The plan's people (founder decision L-02 B: 3 on the Trial plan) are checked under the company's seat lock before a
 * new member joins, counting this invitation's own place: an invitation sent before a company was full, to a company
 * that is full now, stays pending (it joins once a place is free), and when it is the carried one the sign-in is
 * refused (`invite_seats_full`) with what to do. Someone who is already an active member takes no new place.
 * Returns which company the new session should open in: the carried invitation's when it was honoured, else the first
 * one accepted now, else none (the caller falls back to an existing membership).
 */
export async function acceptPendingInvitations(
  q: Queryable,
  input: { user: { id: string; email: string; name: string | null }; tokenHash?: string | null; staff?: boolean; now?: Date; ip?: string },
): Promise<{ accepted: AcceptedInvitation[]; activeCompanyId: string | null }> {
  const now = input.now ?? new Date();
  const email = normalize(input.user.email);
  let carried: InvitationRow | null = null;
  if (input.tokenHash) {
    [carried] = await q.select().from(invitations).where(eq(invitations.tokenHash, input.tokenHash)).limit(1);
    if (carried) {
      const state = invitationState(carried, now);
      if (state === "pending" && carried.email !== email) throw new InvitationRefused("invite_email_mismatch", "This invitation was sent to a different email address. Sign in with the address the invitation was sent to.", email);
      if (state === "expired" || state === "revoked") throw new InvitationRefused("invite_expired", "This invitation has expired or was withdrawn. Ask the person who invited you for a new one.", email);
    }
  }
  if (input.staff) return { accepted: [], activeCompanyId: null };
  const open = await q.select().from(invitations).where(and(eq(invitations.email, email), eq(invitations.status, "pending"), gt(invitations.expiresAt, now.toISOString()))).orderBy(desc(invitations.createdAt));
  const accepted: AcceptedInvitation[] = [];
  for (const inv of open) {
    const [member] = await q.select({ status: memberships.status }).from(memberships).where(and(eq(memberships.companyId, inv.companyId), eq(memberships.userId, input.user.id))).limit(1);
    if (member?.status !== "active") {
      // This invitation already holds a place among the open ones, so it is left out of the count and asks for one place.
      const room = await seatRoom(q, inv.companyId, { now, exceptEmail: email });
      if (!room.ok) {
        if (carried?.id === inv.id) throw new InvitationRefused("invite_seats_full", `This company's trial includes ${room.limit} people. Ask the person who invited you to choose a plan to add more.`, email);
        continue;
      }
    }
    await acceptOne(q, inv, input.user, now, input.ip);
    accepted.push({ invitationId: inv.id, companyId: inv.companyId, role: inv.role });
  }
  const viaLink = carried ? accepted.find((a) => a.invitationId === carried!.id)?.companyId ?? (carried.status === "accepted" && carried.acceptedUserId === input.user.id ? carried.companyId : null) : null;
  return { accepted, activeCompanyId: viaLink ?? accepted[0]?.companyId ?? null };
}

async function acceptOne(q: Queryable, inv: InvitationRow, user: { id: string; email: string; name: string | null }, now: Date, ip?: string): Promise<void> {
  const inviterId = inv.invitedBy.kind === "user" ? inv.invitedBy.id : null;
  const [existing] = await q.select({ id: memberships.id, status: memberships.status }).from(memberships).where(and(eq(memberships.companyId, inv.companyId), eq(memberships.userId, user.id))).limit(1);
  if (existing) await q.update(memberships).set({ status: "active", role: inv.role, invitedBy: inviterId }).where(eq(memberships.id, existing.id));
  else await q.insert(memberships).values({ companyId: inv.companyId, userId: user.id, role: inv.role, status: "active", invitedBy: inviterId });
  await q.update(invitations).set({ status: "accepted", acceptedAt: now.toISOString(), acceptedUserId: user.id }).where(eq(invitations.id, inv.id));
  // The name the inviter typed is a courtesy: it fills an empty name and never overwrites what the provider or the person said.
  if (!user.name && inv.name) await q.update(users).set({ name: inv.name }).where(eq(users.id, user.id));
  const actor: Actor = { kind: "user", id: user.id, name: user.name ?? inv.name ?? user.email };
  await emit(q, { type: "member.joined", companyId: inv.companyId, actor, subject: { type: "user", id: user.id }, payload: { role: inv.role, invitationId: inv.id, rejoined: existing?.status === "removed" } });
  await emit(q, { type: "membership.changed", companyId: inv.companyId, actor, subject: { type: "user", id: user.id }, payload: { role: inv.role, status: "active" } });
  await audit(q, { companyId: inv.companyId, actor, action: "invitation.accepted", target: { type: "invitation", id: inv.id }, reason: `joined as ${inv.role}`, ip, details: { email: inv.email, role: inv.role, invitedBy: inv.invitedBy.name ?? inv.invitedBy.id } });
}

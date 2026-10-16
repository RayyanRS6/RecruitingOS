import { and, desc, eq } from "drizzle-orm";
import type { LegalCheck, LegalCheckItem, PacketFlag, RolePacket } from "@ros/contracts";
import { can, closingDateRequired, companyToday, decisionMakerOf, defaultClosingDate, isSoleOwner, mayDecideApproval, openFlagsMessage, postingLegalCheck, requiredUserIdsOf, resolveDecisionMaker, selfApprovalCheck, unresolvedFlags, type DecisionMaker } from "@ros/core";
import { approvalRequests, companies, memberships, rolePackets, users, type Tx } from "@ros/db";
import { decidersInWords } from "@ros/workflows";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { currentVersionOf, type PacketRow, type RoleRow } from "./packet-versions";
import { assertNoNewWork } from "./trial";

/**
 * The legal check of a version before it goes public (plan D5): what the law of the job's places asks of the ad, with
 * the company's benefits description and the role's closing date. A Colorado (or remote) role without a date is not
 * blocked: it gets `defaultClosesOn` when it opens, and the check says so.
 */
export async function legalCheckFor(tx: Tx, input: { role: Pick<RoleRow, "companyId" | "applicationsCloseOn">; packet: Pick<RolePacket, "identity" | "compensation">; now: Date }): Promise<LegalCheck> {
  const [company] = await tx.select({ settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, input.role.companyId)).limit(1);
  const needsDate = closingDateRequired({ jobLocations: input.packet.identity.locations, remotePolicy: input.packet.identity.remotePolicy });
  return postingLegalCheck({
    packet: input.packet,
    companySettings: company?.settings ?? null,
    closesOn: input.role.applicationsCloseOn,
    defaultClosesOn: needsDate ? defaultClosingDate(input.now, company?.timezone) : null,
    today: companyToday(input.now, company?.timezone),
  });
}

/** The sentence a refused approval carries: what is missing, then how to fix each. */
export function legalCheckMessage(missing: readonly LegalCheckItem[]): string {
  const what = missing.map((m) => m.label.charAt(0).toLowerCase() + m.label.slice(1)).join(", ");
  const fixes = missing.map((m) => m.fix).filter((f): f is string => !!f).join(" ");
  return `Before this job can go live, the law where it is asks for: ${what}. ${fixes}`.trim();
}

export const KEPT_OWN_FLAG_MESSAGE = "You kept wording the fairness check flagged in this version, so another owner, admin or hiring manager says yes before it goes live. Only a company's sole owner can approve wording they kept.";

/** `KEPT_OWN_FLAG_MESSAGE` naming only the people who may decide this request (its approver roles, row 67). */
export function keptOwnFlagMessage(requiredRoles: readonly string[]): string {
  if (!requiredRoles.length) return KEPT_OWN_FLAG_MESSAGE;
  return `You kept wording the fairness check flagged in this version, so someone else says yes before it goes live. ${decidersInWords(requiredRoles)} Only a company's sole owner can approve wording they kept.`;
}

/**
 * Founder decision L-01 (15 October 2026): wording the fairness check flagged and a person kept, with a reason, on a job
 * that is already live (or paused) needs a second approver's yes before it goes public. The person who kept it may not
 * approve the version, unless they are the company's only owner, or nobody else could decide it (Wave S5 review: in a
 * company whose only approvers are two owners, one writing the version and the other keeping the flag, the keeper
 * decides, so the version is never stuck until it expires). Whoever wrote the version is held back by the self-approval
 * rule already; this covers a flag kept on the approval card by someone else.
 */
async function keptTheirOwnFlag(tx: Tx, input: { tenant: Tenant; req: ApprovalRow; role: RoleRow; version: PacketRow | null }): Promise<boolean> {
  if (!(input.req.proposal as { editWhileOpen?: boolean }).editWhileOpen || !input.version) return false;
  // Wording already live, kept the same way, was decided before: only a keep that is new in this version counts.
  const [live] = input.role.currentPacketVersion ? await tx.select({ packet: rolePackets.packet }).from(rolePackets).where(and(eq(rolePackets.roleId, input.role.id), eq(rolePackets.version, input.role.currentPacketVersion))).limit(1) : [];
  const liveKept = new Set((live?.packet.provenance.flags ?? []).filter((f) => f.kept).map((f) => `${f.id}|${f.kept?.reason ?? ""}`));
  const kept = (input.version.packet.provenance.flags ?? []).some((f) => f.kept?.by?.kind === "user" && f.kept.by.id === input.tenant.userId && !liveKept.has(`${f.id}|${f.kept.reason}`));
  if (!kept) return false;
  if (await isSoleOwner(tx, input.tenant.companyId, input.tenant.userId)) return false;
  const userOf = (a: { kind: string; id?: string }) => (a.kind === "user" ? a.id ?? null : null);
  const barred = [userOf(input.version.createdBy), userOf(input.role.createdBy)].filter((id): id is string => !!id);
  return someoneElseMayDecide(tx, { companyId: input.tenant.companyId, req: input.req, keeperId: input.tenant.userId, barredIds: barred });
}

/**
 * Whether an active member other than the keeper may decide this request: the named decision maker or an owner when one
 * was named, otherwise anyone whose team role is among the request's approver roles. Whoever wrote the version or
 * started the role is left out as the self-approval rule leaves them out (`barredIds`), unless they are the company's
 * only owner, who may approve their own (`selfApprovalCheck`).
 */
async function someoneElseMayDecide(tx: Tx, input: { companyId: string; req: ApprovalRow; keeperId: string; barredIds: readonly string[] }): Promise<boolean> {
  const members = await tx.select({ userId: memberships.userId, role: memberships.role }).from(memberships).where(and(eq(memberships.companyId, input.companyId), eq(memberships.status, "active")));
  const owners = members.filter((m) => m.role === "owner");
  const soleOwnerId = owners.length === 1 ? owners[0]!.userId : null;
  const others = members.filter((m) => m.userId !== input.keeperId && (!input.barredIds.includes(m.userId) || m.userId === soleOwnerId) && can(m.role as Tenant["role"], "role.approve"));
  const named = requiredUserIdsOf(input.req);
  if (named.length) return others.some((m) => named.includes(m.userId) || m.role === "owner");
  return others.some((m) => input.req.requiredRoles.includes(m.role));
}

/**
 * Who may approve a role packet, applied the same way by POST /roles/:id/approve, POST /approvals/:id/decide and the
 * role page (which asks before it shows the button). The rules live in @ros/core (approval-deciders.ts); this file
 * turns them into HTTP answers and into the view the role page renders.
 */
export type ApprovalRow = typeof approvalRequests.$inferSelect;

/**
 * Refuses with 403 (wrong role, or not the named decision maker), 409 `self_approval`, 409 `packet_flags` while a
 * phrase the packet guard flagged is still open (plan C1: edited out, or kept by a person with a reason), or 409
 * `legal_check` while something the law of the job's places asks of the ad is missing (plan D5; `details.missing`
 * lists the items); passes silently otherwise. Sending a version back is never blocked by flags or the legal check.
 * A job going live for the first time (not open or paused yet) is refused with 402 `trial_ended` once the company's
 * trial has ended (founder decision L-02 B); an approved edit to a job already live never is.
 */
export async function assertMayApprovePacket(tx: Tx, input: { tenant: Tenant; req: ApprovalRow; role: RoleRow; version: PacketRow | null; now?: Date }): Promise<void> {
  const decide = mayDecideApproval(input.req, { userId: input.tenant.userId, role: input.tenant.role });
  if (!decide.ok) throw new HttpError(403, decide.code, decide.message);
  if (!["open", "paused"].includes(input.role.status)) await assertNoNewWork(tx, input.tenant.companyId, input.now ?? new Date());
  const self = await selfApprovalCheck(tx, { companyId: input.tenant.companyId, userId: input.tenant.userId, roleCreatedBy: input.role.createdBy, versionCreatedBy: input.version?.createdBy ?? input.role.createdBy });
  if (!self.ok) throw new HttpError(409, self.code, self.message);
  if (await keptTheirOwnFlag(tx, { tenant: input.tenant, req: input.req, role: input.role, version: input.version })) throw new HttpError(409, "self_approval", keptOwnFlagMessage(input.req.requiredRoles));
  const open = unresolvedFlags(input.version?.packet);
  if (open.length) throw new HttpError(409, "packet_flags", openFlagsMessage(open.length), { flags: open });
  if (input.version) {
    const check = await legalCheckFor(tx, { role: input.role, packet: input.version.packet, now: input.now ?? new Date() });
    if (check.missing.length) throw new HttpError(409, "legal_check", legalCheckMessage(check.missing), { missing: check.missing, check });
  }
}

export type PacketApprovalView = {
  /**
   * The packet approval waiting on this role, with what the signed-in person may do about it. `flags` are the wording
   * checks on the version waiting (open ones block approving until a person changes the words or keeps them with a
   * reason; kept ones show who kept them and why). Sending back is never blocked by flags or by the self-approval rule.
   */
  pending: {
    id: string;
    version: number;
    rationale: string | null;
    requestedBy: ApprovalRow["requestedBy"];
    requiredRoles: string[];
    requiredUserIds: string[];
    decisionMaker: DecisionMaker | null;
    createdAt: string;
    expiresAt: string | null;
    editWhileOpen: boolean;
    flags: PacketFlag[];
    /** What the law of the job's places asks of the ad (plan D5); the card shows a line only for what is missing. */
    legalCheck: LegalCheck | null;
    viewer: { mayDecide: boolean; maySendBack: boolean; reason: string | null };
  } | null;
  /** The most recent decided request: how a sent-back role got there, with the note. */
  latest: { id: string; status: string; version: number; decisionNote: string | null; decidedAt: string | null; decidedBy: { id: string; name: string } | null } | null;
};

export async function packetApprovalView(tx: Tx, input: { tenant: Tenant; role: RoleRow; packets: PacketRow[]; pending: ApprovalRow[]; now?: Date }): Promise<{ packetApproval: PacketApprovalView; decisionMaker: DecisionMaker | null }> {
  const { tenant: t, role, packets } = input;
  const current = currentVersionOf(role, packets);
  const decisionMaker = current ? await resolveDecisionMaker(tx, t.companyId, current.packet) : null;
  const pendingReq = input.pending.find((p) => p.actionType === "role_packet.approve") ?? null;
  let pending: PacketApprovalView["pending"] = null;
  if (pendingReq) {
    const version = Number((pendingReq.proposal as { version?: number }).version);
    const pv = packets.find((p) => p.version === version) ?? null;
    const legalCheck = pv ? await legalCheckFor(tx, { role, packet: pv.packet, now: input.now ?? new Date() }) : null;
    const viewer = { mayDecide: false, maySendBack: false, reason: null as string | null };
    if (!can(t.role, "role.approve")) viewer.reason = "Your role cannot approve jobs; an owner, admin or hiring manager does.";
    else {
      const decide = mayDecideApproval(pendingReq, { userId: t.userId, role: t.role });
      if (!decide.ok) viewer.reason = decide.message;
      else {
        // Sending back follows the decide route: reserved like approving, but never held up by flags or self-approval.
        viewer.maySendBack = true;
        const self = await selfApprovalCheck(tx, { companyId: t.companyId, userId: t.userId, roleCreatedBy: role.createdBy, versionCreatedBy: pv?.createdBy ?? role.createdBy });
        const open = unresolvedFlags(pv?.packet).length;
        if (!self.ok) viewer.reason = self.message;
        else if (await keptTheirOwnFlag(tx, { tenant: t, req: pendingReq, role, version: pv })) viewer.reason = keptOwnFlagMessage(pendingReq.requiredRoles);
        else if (open) viewer.reason = openFlagsMessage(open);
        else if (legalCheck?.missing.length) viewer.reason = legalCheckMessage(legalCheck.missing);
        else viewer.mayDecide = true;
      }
    }
    pending = { id: pendingReq.id, version, rationale: pendingReq.rationale, requestedBy: pendingReq.requestedBy, requiredRoles: pendingReq.requiredRoles, requiredUserIds: requiredUserIdsOf(pendingReq), decisionMaker: decisionMakerOf(pendingReq), createdAt: pendingReq.createdAt, expiresAt: pendingReq.expiresAt, editWhileOpen: !!(pendingReq.proposal as { editWhileOpen?: boolean }).editWhileOpen, flags: pv?.packet.provenance.flags ?? [], legalCheck, viewer };
  }
  const [latestReq] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.actionType, "role_packet.approve"))).orderBy(desc(approvalRequests.createdAt)).limit(1);
  let latest: PacketApprovalView["latest"] = null;
  if (latestReq && latestReq.status !== "pending") {
    const [who] = latestReq.decidedBy ? await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, latestReq.decidedBy)).limit(1) : [];
    latest = { id: latestReq.id, status: latestReq.status, version: Number((latestReq.proposal as { version?: number }).version), decisionNote: latestReq.decisionNote, decidedAt: latestReq.decidedAt, decidedBy: latestReq.decidedBy ? { id: latestReq.decidedBy, name: who?.name ?? who?.email ?? "a team member" } : null };
  }
  return { packetApproval: { pending, latest }, decisionMaker };
}

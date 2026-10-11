import { and, desc, eq } from "drizzle-orm";
import type { LegalCheck, LegalCheckItem, PacketFlag, RolePacket } from "@ros/contracts";
import { can, closingDateRequired, companyToday, decisionMakerOf, defaultClosingDate, mayDecideApproval, openFlagsMessage, postingLegalCheck, requiredUserIdsOf, resolveDecisionMaker, selfApprovalCheck, unresolvedFlags, type DecisionMaker } from "@ros/core";
import { approvalRequests, companies, users, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { currentVersionOf, type PacketRow, type RoleRow } from "./packet-versions";

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
 */
export async function assertMayApprovePacket(tx: Tx, input: { tenant: Tenant; req: ApprovalRow; role: RoleRow; version: PacketRow | null; now?: Date }): Promise<void> {
  const decide = mayDecideApproval(input.req, { userId: input.tenant.userId, role: input.tenant.role });
  if (!decide.ok) throw new HttpError(403, decide.code, decide.message);
  const self = await selfApprovalCheck(tx, { companyId: input.tenant.companyId, userId: input.tenant.userId, roleCreatedBy: input.role.createdBy, versionCreatedBy: input.version?.createdBy ?? input.role.createdBy });
  if (!self.ok) throw new HttpError(409, self.code, self.message);
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
    if (!can(t.role, "role.approve")) viewer.reason = "Your role cannot approve role packets; an owner, admin or hiring manager does.";
    else {
      const decide = mayDecideApproval(pendingReq, { userId: t.userId, role: t.role });
      if (!decide.ok) viewer.reason = decide.message;
      else {
        // Sending back follows the decide route: reserved like approving, but never held up by flags or self-approval.
        viewer.maySendBack = true;
        const self = await selfApprovalCheck(tx, { companyId: t.companyId, userId: t.userId, roleCreatedBy: role.createdBy, versionCreatedBy: pv?.createdBy ?? role.createdBy });
        const open = unresolvedFlags(pv?.packet).length;
        if (!self.ok) viewer.reason = self.message;
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

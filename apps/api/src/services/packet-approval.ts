import { and, desc, eq } from "drizzle-orm";
import { can, decisionMakerOf, mayDecideApproval, requiredUserIdsOf, resolveDecisionMaker, selfApprovalCheck, type DecisionMaker } from "@ros/core";
import { approvalRequests, users, type Tx } from "@ros/db";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { currentVersionOf, type PacketRow, type RoleRow } from "./packet-versions";

/**
 * Who may approve a role packet, applied the same way by POST /roles/:id/approve, POST /approvals/:id/decide and the
 * role page (which asks before it shows the button). The rules live in @ros/core (approval-deciders.ts); this file
 * turns them into HTTP answers and into the view the role page renders.
 */
export type ApprovalRow = typeof approvalRequests.$inferSelect;

/** Refuses with 403 (wrong role, or not the named decision maker) or 409 `self_approval`; passes silently otherwise. */
export async function assertMayApprovePacket(tx: Tx, input: { tenant: Tenant; req: ApprovalRow; role: RoleRow; version: PacketRow | null }): Promise<void> {
  const decide = mayDecideApproval(input.req, { userId: input.tenant.userId, role: input.tenant.role });
  if (!decide.ok) throw new HttpError(403, decide.code, decide.message);
  const self = await selfApprovalCheck(tx, { companyId: input.tenant.companyId, userId: input.tenant.userId, roleCreatedBy: input.role.createdBy, versionCreatedBy: input.version?.createdBy ?? input.role.createdBy });
  if (!self.ok) throw new HttpError(409, self.code, self.message);
}

export type PacketApprovalView = {
  /** The packet approval waiting on this role, with what the signed-in person may do about it. */
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
    viewer: { mayDecide: boolean; reason: string | null };
  } | null;
  /** The most recent decided request: how a sent-back role got there, with the note. */
  latest: { id: string; status: string; version: number; decisionNote: string | null; decidedAt: string | null; decidedBy: { id: string; name: string } | null } | null;
};

export async function packetApprovalView(tx: Tx, input: { tenant: Tenant; role: RoleRow; packets: PacketRow[]; pending: ApprovalRow[] }): Promise<{ packetApproval: PacketApprovalView; decisionMaker: DecisionMaker | null }> {
  const { tenant: t, role, packets } = input;
  const current = currentVersionOf(role, packets);
  const decisionMaker = current ? await resolveDecisionMaker(tx, t.companyId, current.packet) : null;
  const pendingReq = input.pending.find((p) => p.actionType === "role_packet.approve") ?? null;
  let pending: PacketApprovalView["pending"] = null;
  if (pendingReq) {
    const version = Number((pendingReq.proposal as { version?: number }).version);
    const viewer = { mayDecide: false, reason: null as string | null };
    if (!can(t.role, "role.approve")) viewer.reason = "Your role cannot approve role packets; an owner, admin or hiring manager does.";
    else {
      const decide = mayDecideApproval(pendingReq, { userId: t.userId, role: t.role });
      if (!decide.ok) viewer.reason = decide.message;
      else {
        const pv = packets.find((p) => p.version === version) ?? null;
        const self = await selfApprovalCheck(tx, { companyId: t.companyId, userId: t.userId, roleCreatedBy: role.createdBy, versionCreatedBy: pv?.createdBy ?? role.createdBy });
        if (!self.ok) viewer.reason = self.message;
        else viewer.mayDecide = true;
      }
    }
    pending = { id: pendingReq.id, version, rationale: pendingReq.rationale, requestedBy: pendingReq.requestedBy, requiredRoles: pendingReq.requiredRoles, requiredUserIds: requiredUserIdsOf(pendingReq), decisionMaker: decisionMakerOf(pendingReq), createdAt: pendingReq.createdAt, expiresAt: pendingReq.expiresAt, editWhileOpen: !!(pendingReq.proposal as { editWhileOpen?: boolean }).editWhileOpen, viewer };
  }
  const [latestReq] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.actionType, "role_packet.approve"))).orderBy(desc(approvalRequests.createdAt)).limit(1);
  let latest: PacketApprovalView["latest"] = null;
  if (latestReq && latestReq.status !== "pending") {
    const [who] = latestReq.decidedBy ? await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, latestReq.decidedBy)).limit(1) : [];
    latest = { id: latestReq.id, status: latestReq.status, version: Number((latestReq.proposal as { version?: number }).version), decisionNote: latestReq.decisionNote, decidedAt: latestReq.decidedAt, decidedBy: latestReq.decidedBy ? { id: latestReq.decidedBy, name: who?.name ?? who?.email ?? "a team member" } : null };
  }
  return { packetApproval: { pending, latest }, decisionMaker };
}

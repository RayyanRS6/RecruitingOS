import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Actor, RolePacket } from "@ros/contracts";
import { can, emit } from "@ros/core";
import { approvalRequests, rolePackets, roles, workflowRuns, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";

/**
 * Packet versions and their approval (docs/spec/21 section 7, B2, B3, B9, B10, B13). Every edit is a new version;
 * nothing is overwritten. Whether the new version takes effect at once or waits for an approver depends on the role's
 * state and on who is editing:
 * - a pending role: the older approval and its workflow run are cancelled and a new run asks for approval of the new version;
 * - an open role, edited by someone who may approve: the version is approved and becomes current (as before);
 * - an open role, edited by someone who may not: the version is proposed and waits; the role keeps running on the old one;
 * - a draft (sent back) role: the version is proposed; the person asks for approval again from the role page;
 * - a paused or closed role: the version is kept as proposed.
 */
export type RoleRow = typeof roles.$inferSelect;
export type PacketRow = typeof rolePackets.$inferSelect;

export type NewVersionOutcome = "approved_current" | "proposed_pending_approval" | "proposed";

/** The version the role runs on: the current one when it has been opened, otherwise the newest. */
export function currentVersionOf(role: Pick<RoleRow, "currentPacketVersion">, versions: PacketRow[]): PacketRow | null {
  const newest = versions.slice().sort((a, b) => b.version - a.version);
  return newest.find((p) => p.version === (role.currentPacketVersion ?? newest[0]?.version)) ?? newest[0] ?? null;
}

/**
 * Cancels every pending packet approval on the role and the workflow run that was waiting on each one, and any
 * role_approval run on the role that has not reached its approval gate yet: the request row is only created by the
 * run's first step on a worker tick, so an edit that lands before that tick finds no request to cancel and would
 * otherwise leave two runs asking for approval of two versions. Cancelling is idempotent, so a run found both ways is
 * cancelled once.
 */
export async function cancelPendingPacketApprovals(tx: Tx, container: Container, input: { companyId: string; roleId: string; actor: Actor; reason: string }): Promise<number> {
  const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, input.roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending")));
  // Stamped on the engine's clock, the one the approval's request and expiry are judged on.
  const decidedAt = container.engine.clock().toISOString();
  for (const p of pending) {
    await tx.update(approvalRequests).set({ status: "cancelled", decidedAt, decisionNote: input.reason }).where(eq(approvalRequests.id, p.id));
    await emit(tx, { type: "approval.cancelled", companyId: input.companyId, actor: input.actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType, roleId: input.roleId, version: (p.proposal as { version?: number }).version ?? null, reason: input.reason }, correlationId: p.workflowRunId });
    if (p.workflowRunId) await container.engine.cancel(tx, p.workflowRunId, input.actor, input.reason);
  }
  const unfinished = await tx
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.workflowKey, "role_approval"), inArray(workflowRuns.status, ["running", "waiting"]), sql`${workflowRuns.subject}->>'type' = 'role'`, sql`${workflowRuns.subject}->>'id' = ${input.roleId}`));
  for (const r of unfinished) await container.engine.cancel(tx, r.id, input.actor, input.reason);
  return pending.length;
}

/**
 * Starts a role_approval run for a version. The first request for a version keeps the key the intake route uses, so
 * the two never start the same run twice; a version sent again after a rejection gets a numbered key.
 */
export async function startPacketApproval(tx: Tx, container: Container, input: { companyId: string; role: RoleRow; version: number; actor: Actor; rationale: string; wasOpen: boolean }): Promise<{ runId: string }> {
  const earlier = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(eq(approvalRequests.roleId, input.role.id), eq(approvalRequests.actionType, "role_packet.approve")));
  const sameVersion = earlier.length; // any earlier request on the role makes the key unique enough; the count only grows
  const idempotencyKey = sameVersion === 0 ? `role_approval:${input.role.id}:${input.version}` : `role_approval:${input.role.id}:${input.version}:${sameVersion + 1}`;
  const { runId } = await container.engine.start(tx, {
    workflowKey: "role_approval",
    companyId: input.companyId,
    subject: { type: "role", id: input.role.id },
    state: { roleId: input.role.id, packetVersion: input.version, requestedBy: input.actor, rationale: input.rationale, wasOpen: input.wasOpen },
    idempotencyKey,
    actor: input.actor,
  });
  return { runId };
}

export async function createPacketVersion(
  tx: Tx,
  container: Container,
  input: { tenant: Tenant; actor: Actor; role: RoleRow; packet: RolePacket; changeSummary: string; source?: "human_edit" | "playbook" | "import" },
): Promise<{ version: PacketRow; outcome: NewVersionOutcome; approvalRunId: string | null }> {
  const { tenant: t, actor, role } = input;
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const next = (versions[0]?.version ?? 0) + 1;
  const editorMayApprove = can(t.role, "role.approve");
  const approvesNow = role.status === "open" && editorMayApprove;
  const now = container.engine.clock().toISOString();
  const [pv] = await tx
    .insert(rolePackets)
    .values({ companyId: t.companyId, roleId: role.id, version: next, packet: input.packet, status: approvesNow ? "approved" : "proposed", source: input.source ?? "human_edit", changeSummary: input.changeSummary, createdBy: actor, approvedBy: approvesNow ? t.userId : null, approvedAt: approvesNow ? now : null })
    .returning();
  await emit(tx, { type: "role_packet.edited", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, changeSummary: input.changeSummary, takesEffect: approvesNow ? "now" : role.status === "open" ? "after_approval" : "with_the_role" } });
  const editorName = actor.name ?? "A team member";
  if (approvesNow) {
    // An approver's edit to a running role: current at once, and any version still waiting for approval is withdrawn.
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: `replaced by version ${next}` });
    for (const v of versions) if (v.status === "approved") await tx.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
    await tx.update(roles).set({ currentPacketVersion: next, title: input.packet.identity.title }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role_packet.approved", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, via: "edit_while_open" } });
    return { version: pv, outcome: "approved_current", approvalRunId: null };
  }
  if (role.status === "open" || role.status === "pending_approval") {
    // Whoever was asked to approve the older version is no longer needed; the new version gets its own request.
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: `superseded by version ${next}` });
    if (role.status === "pending_approval") await tx.update(roles).set({ title: input.packet.identity.title }).where(eq(roles.id, role.id));
    const rationale = role.status === "open"
      ? `${editorName} changed the packet of an open role: ${input.changeSummary}. Approve to make version ${next} current; until then the role keeps running on version ${role.currentPacketVersion ?? "the approved one"}.`
      : `${editorName} edited the packet: ${input.changeSummary}. Approve version ${next} to open the role and start posting.`;
    const { runId } = await startPacketApproval(tx, container, { companyId: t.companyId, role, version: next, actor, rationale, wasOpen: role.status === "open" });
    return { version: pv, outcome: "proposed_pending_approval", approvalRunId: runId };
  }
  // Draft (sent back), paused or closed: the version is kept; a draft is sent for approval again from the role page.
  return { version: pv, outcome: "proposed", approvalRunId: null };
}

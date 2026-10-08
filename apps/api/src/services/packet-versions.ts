import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { RolePacket as RolePacketSchema, type Actor, type PacketFlag, type RolePacket } from "@ros/contracts";
import { payChanged } from "@ros/agents";
import { can, emit, guardPacket, unresolvedFlags } from "@ros/core";
import { approvalRequests, companies, rolePackets, roles, workflowRuns, type Tx } from "@ros/db";
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

/**
 * The packet guard on every saved version (plan C1, packages/core/src/packet-guard.ts): jurisdictions and notices, pay on
 * the ad, the ceiling, the disclosure lines, six must-haves, nothing the owner was told could not be used, and flags for
 * wording that stands in for a protected trait. What the earlier version recorded as declined, and who kept which flag,
 * carries over; a flag kept in this edit is stamped with the editor and recorded as an event.
 *
 * Who set the pay is the server's record, never the client's: whatever the incoming packet says about it is ignored. A
 * version whose pay differs from the one before is recorded as set by the person saving it, now; otherwise the earlier
 * record carries over. `changes` lists, in plain words, what the guard itself changed (a must-have it took out, say).
 */
export async function guardPacketVersion(tx: Tx, input: { companyId: string; actor: Actor; packet: RolePacket; previous: PacketRow | null; now?: string }): Promise<{ packet: RolePacket; newlyKept: PacketFlag[]; changes: string[] }> {
  const [company] = await tx.select({ name: companies.name, locations: companies.locations }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const previousFlags = input.previous?.packet.provenance.flags ?? [];
  const incoming = structuredClone(input.packet);
  delete incoming.provenance.payConfirmedBy;
  delete incoming.provenance.payOrigin;
  const before = input.previous?.packet ?? null;
  if (!before || payChanged(before, incoming)) {
    incoming.provenance.payConfirmedBy = { by: input.actor, at: input.now ?? new Date().toISOString(), via: "edited" };
    incoming.provenance.payOrigin = "edited";
  } else {
    if (before.provenance.payConfirmedBy) incoming.provenance.payConfirmedBy = before.provenance.payConfirmedBy;
    if (before.provenance.payOrigin) incoming.provenance.payOrigin = before.provenance.payOrigin;
  }
  const guarded = guardPacket(incoming, { companyName: company?.name ?? "", companyLocations: company?.locations ?? [], declined: before?.provenance.declinedCriteria ?? [], previousFlags, actor: input.actor });
  const newlyKept = guarded.flags.filter((f) => f.kept && !previousFlags.some((p) => p.id === f.id && p.kept?.reason === f.kept?.reason));
  return { packet: RolePacketSchema.parse(guarded.packet), newlyKept, changes: guarded.changes };
}

export async function createPacketVersion(
  tx: Tx,
  container: Container,
  input: { tenant: Tenant; actor: Actor; role: RoleRow; packet: RolePacket; changeSummary: string; source?: "human_edit" | "playbook" | "import" | "agent_revision" },
): Promise<{ version: PacketRow; outcome: NewVersionOutcome; approvalRunId: string | null; guardChanges: string[] }> {
  const { tenant: t, actor, role } = input;
  const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
  const next = (versions[0]?.version ?? 0) + 1;
  const editorMayApprove = can(t.role, "role.approve");
  const now = container.engine.clock().toISOString();
  const { packet, newlyKept, changes: guardChanges } = await guardPacketVersion(tx, { companyId: t.companyId, actor, packet: input.packet, previous: versions[0] ?? null, now });
  // A version with a flag nobody has dealt with waits for approval even from an approver: the approval card shows it.
  const approvesNow = role.status === "open" && editorMayApprove && unresolvedFlags(packet).length === 0;
  const [pv] = await tx
    .insert(rolePackets)
    .values({ companyId: t.companyId, roleId: role.id, version: next, packet, status: approvesNow ? "approved" : "proposed", source: input.source ?? "human_edit", changeSummary: input.changeSummary, createdBy: actor, approvedBy: approvesNow ? t.userId : null, approvedAt: approvesNow ? now : null })
    .returning();
  await emit(tx, { type: "role_packet.edited", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, changeSummary: input.changeSummary, takesEffect: approvesNow ? "now" : role.status === "open" ? "after_approval" : "with_the_role", openFlags: unresolvedFlags(packet).length } });
  for (const f of newlyKept) await emit(tx, { type: "packet.flag_kept", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { flagId: f.id, rule: f.rule, reason: f.kept?.reason ?? null } });
  const editorName = actor.name ?? "A team member";
  if (approvesNow) {
    // An approver's edit to a running role: current at once, and any version still waiting for approval is withdrawn.
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: `replaced by version ${next}` });
    for (const v of versions) if (v.status === "approved") await tx.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
    await tx.update(roles).set({ currentPacketVersion: next, title: input.packet.identity.title }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role_packet.approved", companyId: t.companyId, actor, subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { roleId: role.id, version: next, via: "edit_while_open" } });
    return { version: pv, outcome: "approved_current", approvalRunId: null, guardChanges };
  }
  if (role.status === "open" || role.status === "pending_approval") {
    // Whoever was asked to approve the older version is no longer needed; the new version gets its own request.
    await cancelPendingPacketApprovals(tx, container, { companyId: t.companyId, roleId: role.id, actor, reason: `superseded by version ${next}` });
    if (role.status === "pending_approval") await tx.update(roles).set({ title: input.packet.identity.title }).where(eq(roles.id, role.id));
    const rationale = role.status === "open"
      ? `${editorName} changed the packet of an open role: ${input.changeSummary}. Approve to make version ${next} current; until then the role keeps running on version ${role.currentPacketVersion ?? "the approved one"}.`
      : `${editorName} edited the packet: ${input.changeSummary}. Approve version ${next} to open the role and start posting.`;
    const { runId } = await startPacketApproval(tx, container, { companyId: t.companyId, role, version: next, actor, rationale, wasOpen: role.status === "open" });
    return { version: pv, outcome: "proposed_pending_approval", approvalRunId: runId, guardChanges };
  }
  // Draft (sent back), paused or closed: the version is kept; a draft is sent for approval again from the role page.
  return { version: pv, outcome: "proposed", approvalRunId: null, guardChanges };
}

import { eq } from "drizzle-orm";
import { emit, gate } from "@ros/core";
import { approvalRequests, rolePackets, roles } from "@ros/db";
import type { WorkflowDefinition } from "../types";

type State = { roleId: string; packetVersion: number; approvalRequestId?: string; publishRunId?: string };

/**
 * From a proposed Role Packet to an open role (docs/06 `intake_to_packet`, steps after compile).
 * Conversation turns run synchronously in the API; this workflow owns approval, opening, and publishing.
 */
export const roleApproval: WorkflowDefinition<State> = {
  key: "role_approval",
  version: 1,
  initialStep: "request_approval",
  maxAttempts: 3,
  escalationKind: "ask",
  steps: {
    async request_approval(ctx) {
      const [role] = await ctx.q.select().from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1);
      if (!role) return { kind: "fail", error: "role not found", retryable: false };
      const result = await gate(ctx.q, {
        companyId: ctx.companyId,
        roleId: role.id,
        actionType: "role_packet.approve",
        subject: { type: "role_packet", id: `${role.id}:${ctx.state.packetVersion}` },
        proposal: { roleId: role.id, version: ctx.state.packetVersion, title: role.title },
        rationale: "The intake conversation produced a Role Packet. Approve it to open the role and start posting.",
        requestedBy: { kind: "agent", id: "intake" },
        workflowRunId: ctx.run.id,
        expiresInHours: 24 * 14,
      });
      if (result.outcome === "wait_for_approval") {
        return { kind: "wait", wait: { kind: "human", approvalRequestId: result.approvalRequestId }, state: { approvalRequestId: result.approvalRequestId }, resumeStep: "on_decision" };
      }
      if (result.outcome === "execute") return { kind: "next", step: "open" }; // a company policy could make packet approval automatic
      return { kind: "fail", error: "packet approval is configured human_only; nothing to do", retryable: false };
    },

    async on_decision(ctx) {
      const id = ctx.state.approvalRequestId!;
      const [req] = await ctx.q.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
      if (!req) return { kind: "fail", error: "approval request missing", retryable: false };
      if (req.status === "pending") return { kind: "wait", wait: { kind: "human", approvalRequestId: id }, resumeStep: "on_decision" };
      if (req.status === "approved") return { kind: "next", step: "open" };
      // rejected, expired, cancelled: the packet stays proposed; the owner edits it, which starts a new run.
      await ctx.q.update(roles).set({ status: "draft" }).where(eq(roles.id, ctx.state.roleId));
      return { kind: "complete" };
    },

    async open(ctx) {
      const now = ctx.now.toISOString();
      const [role] = await ctx.q.select().from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1);
      if (!role) return { kind: "fail", error: "role not found", retryable: false };
      const versions = await ctx.q.select().from(rolePackets).where(eq(rolePackets.roleId, role.id));
      for (const v of versions) {
        if (v.version === ctx.state.packetVersion) {
          if (v.status !== "approved") await ctx.q.update(rolePackets).set({ status: "approved", approvedAt: now }).where(eq(rolePackets.id, v.id));
        } else if (v.status !== "superseded") {
          await ctx.q.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
        }
      }
      if (role.status !== "open") {
        await ctx.q.update(roles).set({ status: "open", currentPacketVersion: ctx.state.packetVersion, openedAt: role.openedAt ?? now }).where(eq(roles.id, role.id));
        await emit(ctx.q, { type: "role_packet.approved", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "role_packet", id: `${role.id}:${ctx.state.packetVersion}` }, payload: { version: ctx.state.packetVersion }, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "role.opened", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "role", id: role.id }, payload: { packetVersion: ctx.state.packetVersion }, correlationId: ctx.run.id });
      }
      return { kind: "next", step: "publish" };
    },

    async publish(ctx) {
      // Publishing is its own workflow so channel retries never block the role from being open.
      const { runId } = await ctx.services.engine.start(ctx.q, {
        workflowKey: "publish_role",
        companyId: ctx.companyId,
        subject: { type: "role", id: ctx.state.roleId },
        state: { roleId: ctx.state.roleId, packetVersion: ctx.state.packetVersion },
        idempotencyKey: `publish:${ctx.state.roleId}:${ctx.state.packetVersion}`,
        actor: ctx.actor,
      });
      return { kind: "complete", state: { publishRunId: runId } };
    },
  },
};

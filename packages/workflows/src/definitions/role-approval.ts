import { and, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit, gate, notify, resolveDecisionMaker } from "@ros/core";
import { approvalRequests, rolePackets, roles } from "@ros/db";
import type { WorkflowDefinition } from "../types";

type State = {
  roleId: string;
  packetVersion: number;
  approvalRequestId?: string;
  publishRunId?: string;
  /** Who asked for the approval and why, when a person's edit started this run; the intake agent otherwise. */
  requestedBy?: Actor;
  rationale?: string;
  /** True when the role was already open when approval was requested: approving swaps the version, nothing more. */
  wasOpen?: boolean;
  expiresAt?: string;
};

/** Two weeks without a decision and the request expires: the role goes back to draft and the owner is told. */
export const PACKET_APPROVAL_WINDOW_HOURS = 24 * 14;
const INTAKE_RATIONALE = "The intake conversation produced a Role Packet. Approve it to open the role and start posting.";

/**
 * From a proposed Role Packet to an open role (docs/06 `intake_to_packet`, steps after compile).
 * Conversation turns run synchronously in the API; this workflow owns approval, opening, and publishing. It also
 * carries a version proposed while the role is open (an edit by someone who cannot approve): approval makes that
 * version current; a rejection retires it and the open version stays.
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
      const [pv] = await ctx.q.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, ctx.state.packetVersion))).limit(1);
      if (!pv) return { kind: "fail", error: `packet version ${ctx.state.packetVersion} not found`, retryable: false };
      const wasOpen = ctx.state.wasOpen ?? role.status === "open";
      const title = pv.packet.identity.title;
      // The named decision maker, when the packet names one who can approve: the request is reserved for them (an owner can still decide).
      const decisionMaker = await resolveDecisionMaker(ctx.q, ctx.companyId, pv.packet);
      const result = await gate(ctx.q, {
        companyId: ctx.companyId,
        roleId: role.id,
        actionType: "role_packet.approve",
        subject: { type: "role_packet", id: `${role.id}:${ctx.state.packetVersion}` },
        proposal: {
          roleId: role.id,
          version: ctx.state.packetVersion,
          title,
          changeSummary: pv.changeSummary ?? null,
          editWhileOpen: wasOpen,
          ...(decisionMaker ? { requiredUserIds: [decisionMaker.userId], decisionMaker } : {}),
        },
        rationale: ctx.state.rationale ?? INTAKE_RATIONALE,
        requestedBy: ctx.state.requestedBy ?? { kind: "agent", id: "intake" },
        workflowRunId: ctx.run.id,
        expiresInHours: PACKET_APPROVAL_WINDOW_HOURS,
      });
      if (result.outcome === "wait_for_approval") {
        // The expiry runs on the engine's clock, the same one that wakes this run, so the request and the timer agree.
        const until = new Date(ctx.now.getTime() + PACKET_APPROVAL_WINDOW_HOURS * 3600_000).toISOString();
        await ctx.q.update(approvalRequests).set({ expiresAt: until }).where(eq(approvalRequests.id, result.approvalRequestId));
        const who = decisionMaker ? `${decisionMaker.name ?? decisionMaker.email} was named as the decision maker; an owner can also decide.` : "Any owner, admin or hiring manager can decide.";
        await notify(ctx.q, {
          companyId: ctx.companyId,
          kind: "approval.requested",
          title: wasOpen ? `${title}: version ${ctx.state.packetVersion} needs approval` : `${title}: the role packet needs approval`,
          body: `${wasOpen ? `${pv.createdBy.name ?? "A team member"} changed the packet: ${pv.changeSummary ?? "edited"}. The role stays on its current version until this is approved.` : "Review the packet, edit anything, then approve to open the role and start posting."} ${who} It waits 14 days, then goes back to a draft.`,
          action: { label: "Review", href: `/roles/${role.id}` },
          ...(decisionMaker ? { userIds: [decisionMaker.userId] } : {}),
        });
        return { kind: "wait", wait: { kind: "human", approvalRequestId: result.approvalRequestId, until }, state: { approvalRequestId: result.approvalRequestId, wasOpen, expiresAt: until }, resumeStep: "on_decision" };
      }
      if (result.outcome === "execute") return { kind: "next", step: "open", state: { wasOpen } }; // a company policy could make packet approval automatic
      return { kind: "fail", error: "packet approval is configured human_only; nothing to do", retryable: false };
    },

    async on_decision(ctx) {
      const id = ctx.state.approvalRequestId!;
      const [req] = await ctx.q.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1);
      if (!req) return { kind: "fail", error: "approval request missing", retryable: false };
      let status = req.status;
      let note = req.decisionNote;
      if (status === "pending") {
        const dueAt = ctx.state.expiresAt ?? req.expiresAt ?? null;
        // The clock alone decides: the engine's retry after a failed step is a timer wake too, and it must not expire a request on day one.
        const timedOut = !!dueAt && Date.parse(dueAt) <= ctx.now.getTime();
        if (!timedOut) return { kind: "wait", wait: { kind: "human", approvalRequestId: id, ...(dueAt ? { until: dueAt } : {}) }, resumeStep: "on_decision" };
        note = "Nobody decided within 14 days.";
        status = "expired";
        await ctx.q.update(approvalRequests).set({ status, decidedAt: ctx.now.toISOString(), decisionNote: note }).where(eq(approvalRequests.id, id));
        await emit(ctx.q, { type: "approval.expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "approval_request", id }, payload: { actionType: req.actionType, roleId: ctx.state.roleId, version: ctx.state.packetVersion }, correlationId: ctx.run.id });
      }
      if (status === "approved") return { kind: "next", step: "open" };
      // Cancelled: a newer version replaced this one and its own run carries the approval; nothing to undo here.
      if (status === "cancelled") return { kind: "complete" };
      // Rejected or expired: the role goes back to draft (or, for an edit to an open role, the proposed version is retired), with the note where the owner sees it.
      const [role] = await ctx.q.select().from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1);
      const wasOpen = ctx.state.wasOpen ?? false;
      if (role && wasOpen) {
        await ctx.q.update(rolePackets).set({ status: "superseded" }).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, ctx.state.packetVersion), eq(rolePackets.status, "proposed")));
      } else if (role) {
        await ctx.q.update(roles).set({ status: "draft" }).where(eq(roles.id, role.id));
      }
      await emit(ctx.q, { type: "role.sent_back", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "role", id: ctx.state.roleId }, payload: { version: ctx.state.packetVersion, status, note: note ?? null, wasOpen }, correlationId: ctx.run.id });
      if (role) {
        await notify(ctx.q, {
          companyId: ctx.companyId,
          kind: "role.sent_back",
          title: status === "expired" ? `${role.title}: the approval ran out of time` : `${role.title}: the packet was sent back`,
          body: `${note ? `Note: ${note} ` : ""}${wasOpen ? "The role keeps running on its approved version." : "Edit the role if needed, then ask for approval again from the role page."}`,
          action: { label: "Open the role", href: `/roles/${role.id}` },
        });
      }
      return { kind: "complete" };
    },

    async open(ctx) {
      const now = ctx.now.toISOString();
      const [role] = await ctx.q.select().from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1);
      if (!role) return { kind: "fail", error: "role not found", retryable: false };
      const versions = await ctx.q.select().from(rolePackets).where(eq(rolePackets.roleId, role.id));
      const approved = versions.find((v) => v.version === ctx.state.packetVersion);
      for (const v of versions) {
        if (v.version === ctx.state.packetVersion) {
          if (v.status !== "approved") await ctx.q.update(rolePackets).set({ status: "approved", approvedAt: v.approvedAt ?? now }).where(eq(rolePackets.id, v.id));
        } else if (v.status !== "superseded") {
          await ctx.q.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
        }
      }
      if (ctx.state.wasOpen) {
        // An approved edit to a running role: the new version becomes current; the role's status is untouched (it may have been paused meanwhile).
        await ctx.q.update(roles).set({ currentPacketVersion: ctx.state.packetVersion, ...(approved ? { title: approved.packet.identity.title } : {}) }).where(eq(roles.id, role.id));
        await emit(ctx.q, { type: "role_packet.approved", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "role_packet", id: `${role.id}:${ctx.state.packetVersion}` }, payload: { version: ctx.state.packetVersion, via: "edit_while_open" }, correlationId: ctx.run.id });
        return { kind: "complete" };
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

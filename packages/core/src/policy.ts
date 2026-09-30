import { and, eq, isNull } from "drizzle-orm";
import type { ActionType, Actor, PolicyDecision, PolicyLevel, Subject } from "@ros/contracts";
import { approvalRequests, policies, takeovers, type Queryable } from "@ros/db";
import { emit } from "./events";

/**
 * Platform defaults (docs/06). Company and role rows override them.
 * `human_only` actions are never executed by the system, whatever a row says.
 */
/** Actions that may never be set below a level (AC10.1: the AI never starts scheduling on its own). */
export const MIN_LEVELS: Partial<Record<ActionType, PolicyLevel>> = { "interview.request": "approval" };
const LEVEL_RANK: Record<PolicyLevel, number> = { auto: 0, auto_notify: 1, approval: 2, human_only: 3 };
export function levelAtLeast(level: PolicyLevel, min: PolicyLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min];
}

export const HARD_HUMAN_ONLY: ReadonlySet<ActionType> = new Set([
  "application.reject_on_assessment",
  "application.reject_ineligible", // founder decision (15 Sep 2026, correction 6): a failed eligibility answer holds; only a person declines
  "candidate.hire_decision",
  "offer.negotiate",
  "background_check.adverse_action",
  "policy.change",
  "knockout_rule.change",
  "notice_text.change",
  "data.delete",
  "data.export",
]);

export const DEFAULT_POLICIES: Record<ActionType, { level: PolicyLevel; approverRoles: string[]; params?: Record<string, unknown> }> = {
  "role_packet.propose": { level: "auto", approverRoles: [] },
  "role_packet.approve": { level: "approval", approverRoles: ["owner", "admin", "hiring_manager"] },
  "role.publish": { level: "auto", approverRoles: [] },
  "posting.sponsor_spend": { level: "auto", approverRoles: ["owner", "admin"], params: { dailyBudgetUsdRequiresApprovalAbove: 50 } },
  "message.send_templated": { level: "auto", approverRoles: [] },
  "message.send_freeform": { level: "auto_notify", approverRoles: [] },
  "application.triage": { level: "auto", approverRoles: [] },
  /** The hold is operational, never permission for adverse action: notify, review timer, reminders, escalation of an overdue review. */
  "application.hold_ineligible": { level: "auto_notify", approverRoles: [], params: { reviewWindowHours: 24, remindEveryHours: 24, escalateAfterHours: 72 } },
  "application.reject_ineligible": { level: "human_only", approverRoles: [] },
  "application.reject_on_assessment": { level: "human_only", approverRoles: [] },
  "application.invite_screen": { level: "auto_notify", approverRoles: [] },
  "screen.conduct": { level: "auto", approverRoles: [] },
  "application.recommend_interview": { level: "auto_notify", approverRoles: [] },
  "interview.request": { level: "approval", approverRoles: ["owner", "hiring_manager", "recruiter"] },
  "interview.schedule": { level: "auto", approverRoles: [] },
  "interview.reschedule": { level: "auto_notify", approverRoles: [] },
  "interview.record": { level: "approval", approverRoles: ["interviewer"] },
  "scorecard.draft": { level: "auto", approverRoles: [] },
  "debrief.recommend": { level: "approval", approverRoles: ["owner", "hiring_manager"] },
  "candidate.hire_decision": { level: "human_only", approverRoles: [] },
  "offer.draft": { level: "approval", approverRoles: ["owner", "admin"] },
  "offer.send": { level: "approval", approverRoles: ["owner", "admin"] },
  "offer.negotiate": { level: "human_only", approverRoles: [] },
  "offer.revise": { level: "approval", approverRoles: ["owner", "admin"] },
  "disposition.send": { level: "auto_notify", approverRoles: [] },
  "reference.request": { level: "auto_notify", approverRoles: [] },
  "background_check.order": { level: "approval", approverRoles: ["owner", "admin", "hr"] },
  "background_check.adverse_action": { level: "human_only", approverRoles: [] },
  "employee.create_in_hris": { level: "auto_notify", approverRoles: [] },
  "welcome.send": { level: "auto", approverRoles: [] },
  "checkin.request": { level: "auto", approverRoles: [] },
  "policy.change": { level: "human_only", approverRoles: ["owner", "admin"] },
  "knockout_rule.change": { level: "human_only", approverRoles: ["owner", "admin"] },
  "notice_text.change": { level: "human_only", approverRoles: ["owner", "admin"] },
  "data.delete": { level: "human_only", approverRoles: ["owner", "admin", "hr"] },
  "data.export": { level: "human_only", approverRoles: ["owner", "admin", "hr"] },
  "intervention.nudge": { level: "auto", approverRoles: [], params: { cooldownHours: 48 } },
  "intervention.offer_recruiter": { level: "auto_notify", approverRoles: [] },
  "sourcing.search_internal": { level: "auto", approverRoles: [] },
  "sourcing.enrich_external": { level: "auto", approverRoles: [], params: { withinCredits: true } },
  "outreach.send": { level: "auto_notify", approverRoles: [] },
};

/** Resolution order: takeover overlay → role → company → platform default. */
export async function resolvePolicy(q: Queryable, companyId: string, roleId: string | null, actionType: ActionType): Promise<PolicyDecision> {
  const def = DEFAULT_POLICIES[actionType];
  let decision: PolicyDecision = { actionType, level: def.level, approverRoles: def.approverRoles, source: "default", params: def.params ?? {} };

  const companyRows = await q
    .select()
    .from(policies)
    .where(and(eq(policies.companyId, companyId), isNull(policies.roleId), eq(policies.actionType, actionType)))
    .limit(1);
  if (companyRows[0]) {
    decision = { actionType, level: companyRows[0].level as PolicyLevel, approverRoles: companyRows[0].approverRoles, source: "company", params: companyRows[0].params };
  }
  if (roleId) {
    const roleRows = await q
      .select()
      .from(policies)
      .where(and(eq(policies.companyId, companyId), eq(policies.roleId, roleId), eq(policies.actionType, actionType)))
      .limit(1);
    if (roleRows[0]) {
      decision = { actionType, level: roleRows[0].level as PolicyLevel, approverRoles: roleRows[0].approverRoles, source: "role", params: roleRows[0].params };
    }
    const active = await q
      .select()
      .from(takeovers)
      .where(and(eq(takeovers.companyId, companyId), eq(takeovers.roleId, roleId), eq(takeovers.status, "active")))
      .limit(1);
    if (active[0] && (decision.level === "auto" || decision.level === "auto_notify")) {
      decision = { ...decision, level: "approval", approverRoles: ["recruiter"], source: "takeover" };
    }
  }
  if (HARD_HUMAN_ONLY.has(actionType)) decision = { ...decision, level: "human_only" };
  return decision;
}

export type GateResult =
  | { outcome: "execute"; decision: PolicyDecision; notify: boolean }
  | { outcome: "wait_for_approval"; decision: PolicyDecision; approvalRequestId: string }
  | { outcome: "human_only"; decision: PolicyDecision };

/**
 * The gate every automated action passes through. Returns what the caller may do.
 * For `approval`, an approval request is created and the caller must wait.
 */
export async function gate(
  q: Queryable,
  input: {
    companyId: string;
    roleId: string | null;
    applicationId?: string | null;
    actionType: ActionType;
    subject: Subject;
    proposal: Record<string, unknown>;
    rationale?: string;
    requestedBy: Actor;
    workflowRunId?: string | null;
    expiresInHours?: number;
  },
): Promise<GateResult> {
  const decision = await resolvePolicy(q, input.companyId, input.roleId, input.actionType);
  if (decision.level === "human_only") return { outcome: "human_only", decision };
  if (decision.level === "auto") return { outcome: "execute", decision, notify: false };
  if (decision.level === "auto_notify") return { outcome: "execute", decision, notify: true };

  const [req] = await q
    .insert(approvalRequests)
    .values({
      companyId: input.companyId,
      roleId: input.roleId,
      applicationId: input.applicationId ?? null,
      actionType: input.actionType,
      subject: input.subject,
      proposal: input.proposal,
      rationale: input.rationale ?? null,
      requestedBy: input.requestedBy,
      requiredRoles: decision.approverRoles,
      workflowRunId: input.workflowRunId ?? null,
      expiresAt: input.expiresInHours ? new Date(Date.now() + input.expiresInHours * 3600_000).toISOString() : null,
    })
    .returning({ id: approvalRequests.id });
  await emit(q, {
    type: "approval.requested",
    companyId: input.companyId,
    actor: input.requestedBy,
    subject: { type: "approval_request", id: req.id },
    payload: { actionType: input.actionType, subject: input.subject, requiredRoles: decision.approverRoles, roleId: input.roleId, applicationId: input.applicationId ?? null },
    correlationId: input.workflowRunId ?? null,
  });
  return { outcome: "wait_for_approval", decision, approvalRequestId: req.id };
}

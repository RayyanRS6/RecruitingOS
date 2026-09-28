import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Actor, ApplicationAction } from "@ros/contracts";
import { STAGE_LABEL, assertCan, emit, gate, transition } from "@ros/core";
import { applications, approvalRequests, candidates, companies, interviews, rolePackets, roles, screens, type Tx } from "@ros/db";
import { sendDisposition } from "@ros/agents";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";

/**
 * What may be done with an application in its current state, decided in one place. The API answers with the list
 * (`allowedActions` on the application detail) so the pages show only real choices, and the action route refuses
 * anything not on it, so the two can never disagree.
 */
export const TERMINAL_STAGES: readonly string[] = ["hired", "withdrawn", "rejected", "declined"];
export const SCREEN_OPEN_STATUSES: readonly string[] = ["invited", "reminded", "in_progress"];
export const INTERVIEW_ACTIVE_STATUSES: readonly string[] = ["proposed", "scheduling", "scheduled"];
export const INTERVIEW_DONE_STATUSES: readonly string[] = ["completed", "no_show"];

export type ApplicationCapability = "invite_screen" | "interview" | "advance_to_interview" | "hold" | "reject" | "move_to_talent_pool" | "override_eligibility" | "review_anyway" | "record_decision" | "record_outcome";

export type ApplicationFacts = { stage: string; rejectReason: string | null; hasOpenScreen: boolean; hasActiveInterview: boolean; hasUndecidedInterview: boolean };

export function allowedApplicationActions(f: ApplicationFacts): ApplicationCapability[] {
  const out: ApplicationCapability[] = [];
  const terminal = TERMINAL_STAGES.includes(f.stage);
  if (["triaged", "eligible", "received", "screen_invited", "screening"].includes(f.stage) && !f.hasOpenScreen) out.push("invite_screen");
  if (["triaged", "screen_complete", "interview_recommended", "interview_complete", "eligible", "screen_invited", "screening"].includes(f.stage) && !f.hasActiveInterview) out.push("interview");
  if (["screen_complete", "triaged", "eligible", "screen_invited", "screening"].includes(f.stage)) out.push("advance_to_interview");
  if (!terminal && f.stage !== "talent_pool") out.push("hold", "move_to_talent_pool");
  if (!terminal) out.push("reject");
  if (f.stage === "ineligible") out.push("override_eligibility");
  if (f.stage === "rejected" && f.rejectReason === "eligibility") out.push("review_anyway");
  if (!terminal && f.hasUndecidedInterview) out.push("record_decision");
  if (!terminal) out.push("record_outcome");
  return out;
}

/** The facts the list depends on, from rows the caller may already hold. */
export function applicationFactsFrom(app: Pick<typeof applications.$inferSelect, "stage" | "rejectReason">, screenStatuses: string[], interviewRows: Array<{ status: string; decision: string | null }>): ApplicationFacts {
  return {
    stage: app.stage,
    rejectReason: app.rejectReason,
    hasOpenScreen: screenStatuses.some((s) => SCREEN_OPEN_STATUSES.includes(s)),
    hasActiveInterview: interviewRows.some((i) => INTERVIEW_ACTIVE_STATUSES.includes(i.status)),
    hasUndecidedInterview: interviewRows.some((i) => INTERVIEW_DONE_STATUSES.includes(i.status) && !i.decision),
  };
}

export async function applicationFacts(tx: Tx, app: Pick<typeof applications.$inferSelect, "id" | "stage" | "rejectReason">): Promise<ApplicationFacts> {
  const scr = await tx.select({ status: screens.status }).from(screens).where(eq(screens.applicationId, app.id));
  const ivs = await tx.select({ status: interviews.status, decision: interviews.decision }).from(interviews).where(eq(interviews.applicationId, app.id));
  return applicationFactsFrom(app, scr.map((s) => s.status), ivs);
}

/** Founder decision (correction 6): candidate-facing decline communication only after the human decision is recorded. */
export async function sendDeclineAfterHumanDecision(tx: Tx, container: Container, input: { companyId: string; app: typeof applications.$inferSelect; actor: Actor; reason: string }): Promise<boolean> {
  const { companyId, app, actor, reason } = input;
  const d = await gate(tx, { companyId, roleId: app.roleId, applicationId: app.id, actionType: "disposition.send", subject: { type: "application", id: app.id }, proposal: { reason }, requestedBy: actor });
  if (d.outcome !== "execute") return false;
  const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!cand || !role || !company || !pv) return false;
  const res = await sendDisposition(tx, container.integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor, reason: reason === "eligibility" ? "eligibility" : "human" });
  return res.status === "sent" || res.status === "pending";
}

type ActionBody = z.infer<typeof ApplicationAction>;
export type ActionResult = { ok: true; stage: string; dispositionSent?: boolean; workflowRunId?: string; next?: string };

/** One person's decision about one application, inside the caller's tenant transaction. */
export async function performApplicationAction(tx: Tx, container: Container, input: { app: typeof applications.$inferSelect; body: ActionBody; tenant: Tenant; actor: Actor }): Promise<ActionResult> {
  const { app, body, tenant: t, actor } = input;
  const by = t.role;
  const facts = await applicationFacts(tx, app);
  if (!allowedApplicationActions(facts).includes(body.action)) {
    if (body.action === "invite_screen" && facts.hasOpenScreen) throw new HttpError(409, "already_invited", "They already have an open screening invitation.");
    if (body.action === "override_eligibility") throw new HttpError(409, "invalid", "Only ineligible applications can be overridden.");
    if (body.action === "review_anyway") throw new HttpError(409, "invalid", "Only applications declined on an eligibility answer can be reopened here.");
    throw new HttpError(409, "invalid", `Cannot ${body.action.replace(/_/g, " ")} someone who is ${STAGE_LABEL[app.stage].toLowerCase()}.`);
  }
  switch (body.action) {
    case "reject": {
      assertCan(t.role, "application.reject");
      if (!body.reason) throw new HttpError(400, "reason_required", "A reason is required to decline a candidate.");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "rejected", by, actor, reason: body.reason, payload: { note: body.note ?? null } });
      await tx.update(applications).set({ rejectNote: body.note ?? null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "application.rejected", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { reason: body.reason, byHuman: true } });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "reject", reason: body.reason } });
      const dispositionSent = await sendDeclineAfterHumanDecision(tx, container, { companyId: t.companyId, app, actor, reason: body.reason });
      return { ok: true, stage: "rejected", dispositionSent };
    }
    case "override_eligibility": {
      assertCan(t.role, "application.act");
      if (!body.note?.trim()) throw new HttpError(400, "reason_required", "Say why you are keeping them in; it is recorded so the system can learn.");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "eligible", by, actor, reason: body.note });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "override_eligibility", note: body.note } });
      return { ok: true, stage: "eligible" };
    }
    case "review_anyway": {
      // The exclusion view's "review anyway" (docs/FOUNDER-CONTEXT.md §10): reopen an application that an owner-authored eligibility rule declined.
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "eligible", by, actor, reason: body.note ?? "review anyway" });
      await tx.update(applications).set({ rejectedAt: null, rejectReason: null, rejectNote: null }).where(eq(applications.id, app.id));
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "review_anyway", note: body.note ?? null } });
      const { runId } = await container.engine.start(tx, { workflowKey: "application_intake", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId }, idempotencyKey: `application_intake:${app.id}:reopen:${Date.now()}`, actor });
      return { ok: true, stage: "eligible", workflowRunId: runId };
    }
    case "move_to_talent_pool": {
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "talent_pool", by, actor, reason: body.note });
      await tx.update(candidates).set({ inTalentPool: true }).where(eq(candidates.id, app.candidateId));
      await emit(tx, { type: "application.moved_to_talent_pool", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: {} });
      return { ok: true, stage: "talent_pool" };
    }
    case "hold": {
      assertCan(t.role, "application.act");
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "hold", note: body.note ?? null } });
      return { ok: true, stage: app.stage };
    }
    case "invite_screen": {
      assertCan(t.role, "application.act");
      // The owner's click is the approval when a policy asked for one.
      const pend = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.invite_screen"), eq(approvalRequests.status, "pending")));
      for (const p of pend) {
        await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: new Date().toISOString(), decisionNote: body.note ?? "invited from the candidate page" }).where(eq(approvalRequests.id, p.id));
        await emit(tx, { type: "approval.granted", companyId: t.companyId, actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType }, correlationId: p.workflowRunId });
        await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${p.id}`, payload: { decision: "approved" } });
      }
      const { runId } = await container.engine.start(tx, { workflowKey: "screen", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId, channel: body.channel, invitedBy: t.userId }, idempotencyKey: `screen:${app.id}:${Date.now()}`, actor });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "invite_screen", channel: body.channel ?? "auto", note: body.note ?? null, workflowRunId: runId } });
      return { ok: true, stage: app.stage, workflowRunId: runId };
    }
    case "advance_to_interview": {
      assertCan(t.role, "application.act");
      await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by, actor, reason: body.note ?? "owner decision" });
      const pend = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.recommend_interview"), eq(approvalRequests.status, "pending")));
      for (const p of pend) {
        await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: new Date().toISOString(), decisionNote: body.note ?? "advanced from the candidate page" }).where(eq(approvalRequests.id, p.id));
        await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${p.id}`, payload: { decision: "approved" } });
      }
      await emit(tx, { type: "candidate.recommended", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { by: "human" } });
      await emit(tx, { type: "human.override", companyId: t.companyId, actor, subject: { type: "application", id: app.id }, payload: { action: "advance_to_interview", note: body.note ?? null } });
      return { ok: true, stage: "interview_recommended", next: "Marked as recommended for interview. Open the candidate and choose \"Interview\" to pick the round and interviewers; times go out to the candidate from there." };
    }
  }
}

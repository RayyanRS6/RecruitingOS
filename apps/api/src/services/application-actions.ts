import { and, eq, inArray } from "drizzle-orm";
import { ACTION_BLOCKED, CANDIDATE_TAB_LABEL, MORE_INTERVIEWS_UPGRADE_QUESTION, candidateActionState, stageLabel, tabOf, type ActionResult, type Actor, type BulkActionResult, type BulkApplicationAction, type CandidateAction, type DecisionMessagePreview, type PlanLimitDetails, type PlanStop } from "@ros/contracts";
import { TransitionError, aiInterviewViewOf, can, emit, entitlements, notLocked, recordHire, takeBackDecision, takeBackDecisionEmail, transition } from "@ros/core";
import { DecisionMessageError, decisionMessageDraft, latestScreen, loadDecisionParts, queueDecisionMessage, sendScreenReminder } from "@ros/agents";
import { cancelAiInterview, startAiInterview } from "@ros/workflows";
import { applications, candidates, roles, screens, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import { HttpError } from "../middleware/errors";
import type { Tenant } from "../middleware/session";
import { askForAiHelpOn } from "./ai-credit";
import { actionFacts, jobContext, loadPeople, type Person } from "./candidates";
import { TRIAL_PLAN_QUESTION } from "./trial";

/**
 * What a person on the team does with a candidate: the nine actions of `CandidateAction`, for one person or for several
 * of one job. One rule says what is allowed (`candidateActions` in the contracts, the same call that fills every row's
 * buttons), and an action that is not allowed is refused with that rule's own reason: 409 `action_not_allowed`, or 402
 * `limit_reached` when the plan is what stops it. The software never hires, never declines and never emails a decision
 * by itself: every one of these is a person's press.
 */

type Who = { tenant: Pick<Tenant, "companyId" | "role">; actor: Actor };

/** The reasons of `ACTION_BLOCKED` that are the plan's, and so answer 402. */
const PLAN_REASONS: Record<PlanStop, string> = { ai_interviews_used_up: ACTION_BLOCKED.interviewsUsedUp, ai_used_up: ACTION_BLOCKED.aiUsedUp, trial_ended: ACTION_BLOCKED.trialEnded };

/** The 402 for an action the plan stops: its plain reason, and the request this person may send about it. */
async function planRefusal(tx: Tx, who: Who, stop: PlanStop): Promise<HttpError> {
  const planKey = (await entitlements.planOf(tx, who.tenant.companyId))?.key;
  const ask = stop === "trial_ended" ? { label: "Ask ITS to choose a plan", reason: TRIAL_PLAN_QUESTION } : stop === "ai_used_up" ? askForAiHelpOn(planKey) : { ...askForAiHelpOn(planKey), reason: MORE_INTERVIEWS_UPGRADE_QUESTION };
  const details: PlanLimitDetails = { upgrade: true, ask: can(who.tenant.role, "plan.request") ? ask : null };
  return new HttpError(402, "limit_reached", PLAN_REASONS[stop], details);
}

/**
 * One action for one person, in the caller's transaction. The application's row is held from the first read, so two
 * presses at the same moment take turns and the second meets the state the first left. `roleId`: the job a bulk action
 * names; an application of another job is not found. Returns the answer and the person's name.
 */
export async function performAction(tx: Tx, container: Container, who: Who, input: { applicationId: string; action: CandidateAction; roleId?: string }): Promise<{ result: ActionResult; name: string }> {
  const [app] = await tx.select().from(applications).where(and(eq(applications.id, input.applicationId), notLocked())).limit(1).for("update");
  const [role] = app && (!input.roleId || app.roleId === input.roleId) ? await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1) : [];
  const [person] = app && role ? await loadPeople(tx, [app]) : [];
  if (!app || !role || !person) throw new HttpError(404, "not_found", "Application not found.");
  const ctx = await jobContext(tx, container, role);
  const state = candidateActionState(actionFacts(person, ctx), input.action);
  if (!state) throw new HttpError(409, "action_not_allowed", "That cannot be done with this person where they are now.");
  if (!state.allowed) throw ctx.planStop && state.reason === PLAN_REASONS[ctx.planStop] ? await planRefusal(tx, who, ctx.planStop) : new HttpError(409, "action_not_allowed", state.reason ?? "That cannot be done right now.");
  let done: { message: string; undoUntil: string | null };
  try {
    done = await act(tx, container, who.actor, person, input.action, ctx.now);
  } catch (err) {
    // Someone else's press got there first (the stage or the email moved between the check and the write).
    if (err instanceof TransitionError || err instanceof DecisionMessageError) throw new HttpError(409, "action_not_allowed", err.message);
    throw err;
  }
  await emit(tx, { type: "human.override", companyId: app.companyId, actor: who.actor, subject: { type: "application", id: app.id }, payload: { action: input.action } });
  const [now] = await tx.select({ stage: applications.stage, toldState: applications.toldState }).from(applications).where(eq(applications.id, app.id)).limit(1);
  // A new AI interview's row is written by its run's first step, right after this commits: until then the newest row is
  // the one before it, so the answer names the interview that was just sent, never the one that closed.
  const aiInterview = input.action === "shortlist" || input.action === "send_new_link" ? null : aiInterviewViewOf(await latestScreen(tx, app.id));
  const result: ActionResult = { ok: true, action: input.action, applicationId: app.id, stage: now.stage, tab: tabOf(now.stage), label: stageLabel(now.stage, aiInterview?.status), toldState: now.stage === "rejected" ? now.toldState : null, message: done.message, undoUntil: done.undoUntil };
  return { result, name: `${person.candidate.firstName} ${person.candidate.lastName}`.trim() };
}

/** Does the action the rule allowed, and says so in one sentence for the toast. */
async function act(tx: Tx, container: Container, actor: Actor, p: Person, action: CandidateAction, now: Date): Promise<{ message: string; undoUntil: string | null }> {
  const { app, candidate } = p;
  const name = candidate.firstName;
  const on = { applicationId: app.id, companyId: app.companyId, actor, now };
  const said = (message: string, undoUntil: string | null = null) => ({ message, undoUntil });
  switch (action) {
    case "shortlist":
      await transition(tx, { ...on, to: "screen_invited", by: "team" });
      await startAiInterview(tx, container.engine, { companyId: app.companyId, applicationId: app.id, roleId: app.roleId, actor });
      return said(`AI interview sent to ${name}.`);
    case "send_new_link":
      await startAiInterview(tx, container.engine, { companyId: app.companyId, applicationId: app.id, roleId: app.roleId, actor });
      return said(`A new AI interview link is on its way to ${name}.`);
    case "remind_screen":
      await remind(tx, container, actor, p, now);
      return said(`Reminder sent to ${name}.`);
    case "cancel_screen":
      await cancelAiInterview(tx, container.engine, { applicationId: app.id, actor, reason: "a person cancelled the AI interview", now });
      // One whose link closed, or that they chose not to do, is put aside too: the person is back in New as if none had been sent.
      await tx.update(screens).set({ status: "cancelled" }).where(and(eq(screens.applicationId, app.id), inArray(screens.status, ["expired", "declined_by_candidate"])));
      await transition(tx, { ...on, to: "triaged", by: "team" });
      return said(`AI interview cancelled. ${name} is back in New.`);
    case "hire":
      await cancelAiInterview(tx, container.engine, { applicationId: app.id, actor, reason: "the candidate was hired", now });
      await recordHire(tx, on);
      return said(`${name} is marked Hired. Nothing was emailed.`);
    case "reject":
      await cancelAiInterview(tx, container.engine, { applicationId: app.id, actor, reason: "the candidate was marked Not selected", now });
      await transition(tx, { ...on, to: "rejected", by: "team" });
      await emit(tx, { type: "application.rejected", companyId: app.companyId, actor, subject: { type: "application", id: app.id }, payload: { roleId: app.roleId } });
      return said(`${name} is marked Not selected. Nothing was emailed.`);
    case "undo_decision": {
      const moved = await takeBackDecision(tx, on);
      return said(`${name} is back in ${CANDIDATE_TAB_LABEL[tabOf(moved.to)]}.`);
    }
    case "send_decision": {
      const sendAt = new Date(now.getTime() + container.env.MESSAGE_UNDO_SECONDS * 1000);
      const sent = await queueDecisionMessage(tx, container.integrations, { app, actor, now, sendAt });
      if (!sent.queued) throw new HttpError(409, "action_not_allowed", ACTION_BLOCKED.noEmail);
      return said(`The decision email to ${name} is on its way.`, sendAt.toISOString());
    }
    case "unsend_decision": {
      const taken = await takeBackDecisionEmail(tx, { applicationId: app.id, companyId: app.companyId, actor, reason: "taken back by the team before it was sent" });
      if (!taken) throw new HttpError(409, "action_not_allowed", ACTION_BLOCKED.emailLeft);
      return said(`The decision email to ${name} was not sent.`);
    }
  }
}

/** A person's "Send a reminder" about an AI interview whose link is open: the reminder email, in a message of its own. */
async function remind(tx: Tx, container: Container, actor: Actor, p: Person, now: Date): Promise<void> {
  const [scr] = p.screen ? await tx.select({ id: screens.id, token: screens.token, status: screens.status, workflowRunId: screens.workflowRunId }).from(screens).where(eq(screens.id, p.screen.id)).limit(1) : [];
  const parts = await loadDecisionParts(tx, p.app);
  if (!scr || !parts) throw new HttpError(404, "not_found", "Application not found.");
  await sendScreenReminder(tx, container.integrations, { application: p.app, candidate: parts.cand, role: parts.role, company: parts.company, packet: parts.packet, actor, correlationId: scr.workflowRunId, appBaseUrl: container.env.JOBS_BASE_URL, screen: { id: scr.id, token: scr.token }, sendKey: `screen_reminder:${scr.id}:${now.toISOString()}` });
  await tx.update(screens).set({ remindedAt: now.toISOString(), ...(scr.status === "invited" ? { status: "reminded" } : {}) }).where(eq(screens.id, scr.id));
  await emit(tx, { type: "screen.reminded", companyId: p.app.companyId, actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: p.app.id, by: "person" } });
}

const DONE_WORDS: Record<BulkApplicationAction["action"], (n: number) => string> = {
  shortlist: (n) => `${n} shortlisted.`,
  reject: (n) => `${n} marked Not selected.`,
  send_decision: (n) => `${n} decision email${n === 1 ? "" : "s"} on ${n === 1 ? "its" : "their"} way.`,
  unsend_decision: (n) => `${n} decision email${n === 1 ? "" : "s"} not sent.`,
};

/**
 * The same action for several ticked people of one job: each in a transaction of its own, so one refusal never blocks
 * the rest. A refused person carries the refusal's code and plain reason; someone who is not on this job's list (another
 * job's, or past the plan's limit) is "not found", with no name.
 */
export async function performBulkAction(container: Container, who: Who, roleId: string, body: BulkApplicationAction): Promise<BulkActionResult> {
  const names = new Map((await withTenant(container.db, who.tenant.companyId, (tx) => tx.select({ id: applications.id, firstName: candidates.firstName, lastName: candidates.lastName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, roleId), inArray(applications.id, body.applicationIds), notLocked())))).map((r) => [r.id, `${r.firstName} ${r.lastName}`.trim()]));
  const results: BulkActionResult["results"] = [];
  let undoUntil: string | null = null;
  for (const applicationId of body.applicationIds) {
    try {
      const { result, name } = await withTenant(container.db, who.tenant.companyId, (tx) => performAction(tx, container, who, { applicationId, action: body.action, roleId }));
      results.push({ applicationId, name, ok: true, code: null, message: result.message });
      undoUntil = result.undoUntil ?? undoUntil;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      results.push({ applicationId, name: names.get(applicationId) ?? "", ok: false, code: err.code, message: err.message });
    }
  }
  const done = results.filter((r) => r.ok).length;
  const refused = results.filter((r) => !r.ok);
  const message = `${DONE_WORDS[body.action](done)}${refused.length ? ` ${refused.length} could not be: ${refused[0]!.message}` : ""}`;
  return { action: body.action, results, done, refused: refused.length, message, undoUntil };
}

/** GET /api/v1/applications/:id/decision-message: the exact email "Email the decision" sends to this person now. Null when they are not marked Not selected. */
export async function decisionPreview(tx: Tx, applicationId: string): Promise<DecisionMessagePreview | null> {
  const [app] = await tx.select().from(applications).where(and(eq(applications.id, applicationId), notLocked())).limit(1);
  const draft = app ? await decisionMessageDraft(tx, app) : null;
  return app && draft ? { to: draft.to, subject: draft.subject, text: draft.text, adverseDecisionLine: draft.adverseDecisionLine, toldState: app.toldState } : null;
}

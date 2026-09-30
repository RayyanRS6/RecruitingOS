import { and, desc, eq } from "drizzle-orm";
import type { ScreenAssessment, ScreenChannel, ScreenTurn } from "@ros/contracts";
import type { RunOutcome } from "@ros/ai";
import { emit, entitlements, gate, nextContactWindow, notify, transition } from "@ros/core";
import { applications, assessments, candidates, companies, rolePackets, roles, screens, type Tx } from "@ros/db";
import { applyScreenOpening, assessScreen, createScreen, focusQuestionsFrom, packetForFocusedInvite, prepareScreenOpening, sendScreenInvite, sendScreenReminder, type FocusQuestion } from "@ros/agents";
import { twoPhase, type WorkflowDefinition } from "../types";

/** `focus: "unknowns"` ("Ask about this in a screen"): the screen opens with the résumé assessment's open questions before the packet's own. */
type State = { applicationId: string; roleId: string; screenId?: string; channel?: "web" | "sms"; invitedBy?: string; remindedAt?: string; focus?: "unknowns" };

const INVITE_WAIT_HOURS = 48;
const REMIND_WAIT_HOURS = 72;

/**
 * docs/06 `screen`: invite → wait for the candidate (48h) → remind once → wait (72h) → expire, or on start: wait for
 * completion → assess → recommend. Conversation turns run in the API (`runScreenTurn`) and signal this run.
 * The two steps that need the model (the SMS opening in `invite`, the scorecard in `assess`) call it in a prepare
 * phase with no transaction open.
 */
export const screen: WorkflowDefinition<State> = {
  key: "screen",
  version: 1,
  initialStep: "invite",
  maxAttempts: 4,
  escalationKind: "candidate_issue",
  steps: {
    invite: twoPhase<State, { channel: ScreenChannel; opening: RunOutcome<ScreenTurn> | null }>({
      async prepare(ctx) {
        const plan = await ctx.read(async (q) => {
          const b = await load(q, ctx.state.applicationId);
          if (!b) return null;
          const { app, candidate, company } = b;
          if (!["triaged", "eligible", "received", "screen_invited", "screening"].includes(app.stage)) return null;
          const ent = await entitlements.check(q, ctx.companyId, "text_screens", 1);
          if (!ent.ok && company.planKey !== "design_partner") return null;
          const channel = chooseChannel(ctx.state.channel, candidate);
          if (channel === "sms" && nextContactWindow(ctx.now, company.timezone, company.settings.businessHours).getTime() > ctx.now.getTime()) return { channel, needsOpening: false }; // quiet hours: the run waits
          const existing = (await q.select().from(screens).where(and(eq(screens.applicationId, app.id), eq(screens.status, "invited"))).limit(1))[0];
          const focusQuestions = ctx.state.focus === "unknowns" && !existing ? await focusQuestionsFor(q, app.id) : null;
          return { channel, needsOpening: channel === "sms", existing: existing ?? null, focusQuestions };
        });
        if (!plan) return { channel: "web", opening: null };
        if (!plan.needsOpening) return { channel: plan.channel, opening: null };
        const opening = await prepareScreenOpening(ctx.db, ctx.services.ai, { companyId: ctx.companyId, applicationId: ctx.state.applicationId, channel: plan.channel, workflowRunId: ctx.run.id, screen: plan.existing ?? null, focusQuestions: plan.focusQuestions ?? null });
        return { channel: plan.channel, opening };
      },
      async run(ctx, prepared) {
        const b = await load(ctx.q, ctx.state.applicationId);
        if (!b) return { kind: "fail", error: "application not found", retryable: false };
        const { app, candidate, role, company, packet } = b;
        if (!["triaged", "eligible", "received", "screen_invited", "screening"].includes(app.stage)) return { kind: "fail", error: `application is ${app.stage}; nothing to screen`, retryable: false };
        const ent = await entitlements.check(ctx.q, ctx.companyId, "text_screens", 1);
        if (!ent.ok) {
          await emit(ctx.q, { type: "entitlement.exceeded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { key: "text_screens", limit: ent.limit, used: ent.used, plan: company.planKey }, correlationId: ctx.run.id });
          if (company.planKey === "design_partner") {
            // Founder decision F8: a billing limit never interrupts an active candidate process for a design partner; the owner and ITS are told.
            await notify(ctx.q, { companyId: ctx.companyId, kind: "entitlement.text_screens", title: "Over the pilot's included screens", body: `${candidate.firstName} ${candidate.lastName} is being screened anyway: the Design Partner pilot never interrupts a candidate in progress. ITS has been told so the allowance can be reviewed.`, action: { label: "See usage", href: "/setup" } });
          } else {
            await notify(ctx.q, { companyId: ctx.companyId, kind: "entitlement.text_screens", title: "Screening limit reached", body: `Your plan includes ${ent.limit} text screens this period. ${candidate.firstName} ${candidate.lastName} is waiting for one. Upgrade to keep screening automatically, or review them yourself.`, action: { label: "See plans", href: "/setup" } });
            return { kind: "complete", state: { screenId: undefined } }; // a plan limit is the owner's decision, not a failure for a recruiter
          }
        }
        const channel = chooseChannel(ctx.state.channel, candidate);
        if (channel === "sms") {
          const allowed = nextContactWindow(ctx.now, company.timezone, company.settings.businessHours);
          if (allowed.getTime() > ctx.now.getTime()) return { kind: "wait", wait: { kind: "timer", until: allowed.toISOString(), reason: "quiet hours: texts go out between 8:00 and 21:00 local time, inside the company's contact hours" }, resumeStep: "invite" };
        }
        const expiresAt = new Date(ctx.now.getTime() + (INVITE_WAIT_HOURS + REMIND_WAIT_HOURS) * 3600_000).toISOString();
        // "Ask about this in a screen": the open questions are fixed on the screen now, so a later assessment never changes a conversation under way.
        const focusQuestions = ctx.state.focus === "unknowns" ? await focusQuestionsFor(ctx.q, app.id) : null;
        const scr = await createScreen(ctx.q, { companyId: ctx.companyId, applicationId: app.id, channel, workflowRunId: ctx.run.id, expiresAt, now: ctx.now, focusQuestions });
        let opening: string | null = null;
        if (channel === "sms") {
          if (prepared.channel !== "sms") return { kind: "fail", error: "the channel changed after the read phase; preparing the opening again", retryable: true };
          const o = await applyScreenOpening(ctx.q, { companyId: ctx.companyId, screenId: scr.id, packet, out: prepared.opening });
          if ("error" in o) return { kind: "fail", error: `could not open the screen: ${o.error}`, retryable: true };
          opening = o.message;
        }
        if (!(await ctx.alreadyDone("invite"))) {
          // A focused screen's invitation counts the open questions and says the conversation starts with them.
          const sent = await sendScreenInvite(ctx.q, ctx.services.integrations, { application: app, candidate, role, company, packet: packetForFocusedInvite(packet, scr.progress), actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token, channel }, opening });
          if (sent.email.status === "failed" && !candidate.email && channel !== "sms") return { kind: "fail", error: "candidate has no email and no SMS consent; nobody can be reached", retryable: false };
          await entitlements.record(ctx.q, ctx.companyId, "text_screens", 1, "screen", { screenId: scr.id });
        }
        if (app.stage !== "screen_invited") await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "screen_invited", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "screen.invited", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { channel, applicationId: app.id, invitedBy: ctx.state.invitedBy ?? "system", focus: ctx.state.focus ?? null, focusQuestions: scr.progress.focusQuestions?.length ?? 0 }, correlationId: ctx.run.id });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: new Date(ctx.now.getTime() + INVITE_WAIT_HOURS * 3600_000).toISOString(), reason: "waiting for the candidate to start; reminder after 48h" }, state: { screenId: scr.id, channel }, resumeStep: "after_invite" };
      },
    }),

    async after_invite(ctx) {
      // Woken by the candidate starting (event) or by the 48h timer; the engine hands us either.
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status === "human_requested") return { kind: "complete" };
      if (scr.status === "abandoned") return { kind: "complete" };
      if (scr.status === "completed") return { kind: "next", step: "assess" };
      if (scr.status === "in_progress") return { kind: "wait", wait: { kind: "event", eventTypes: ["completed", "human"], subjectId: `screen:${scr.id}`, until: new Date(ctx.now.getTime() + REMIND_WAIT_HOURS * 3600_000).toISOString(), reason: "conversation under way" }, resumeStep: "after_invite" };
      if (ctx.wake?.kind !== "timer") return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: scr.expiresAt ?? new Date(ctx.now.getTime() + INVITE_WAIT_HOURS * 3600_000).toISOString() }, resumeStep: "after_invite" };
      if (!scr.remindedAt) return { kind: "next", step: "remind" };
      return { kind: "next", step: "expire" };
    },

    async remind(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      if (!b) return { kind: "fail", error: "application not found", retryable: false };
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (scr?.status !== "invited") return { kind: "next", step: "after_invite" };
      if (scr.channel === "sms") {
        const allowed = nextContactWindow(ctx.now, b.company.timezone, b.company.settings.businessHours);
        if (allowed.getTime() > ctx.now.getTime()) return { kind: "wait", wait: { kind: "timer", until: allowed.toISOString(), reason: "quiet hours" }, resumeStep: "remind" };
      }
      await sendScreenReminder(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token, channel: scr.channel as "web" | "sms" } });
      await ctx.q.update(screens).set({ status: "reminded", remindedAt: ctx.now.toISOString() }).where(eq(screens.id, scr.id));
      const until = new Date(ctx.now.getTime() + REMIND_WAIT_HOURS * 3600_000).toISOString();
      // Wait for the candidate or the expiry timer, whichever first.
      await ctx.q.update(screens).set({ expiresAt: until }).where(eq(screens.id, scr.id));
      return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until, reason: "reminder sent; waiting for the candidate" }, state: { remindedAt: ctx.now.toISOString() }, resumeStep: "after_remind" };
    },

    async after_remind(ctx) {
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status === "completed") return { kind: "next", step: "assess" };
      if (scr.status === "in_progress") return { kind: "wait", wait: { kind: "event", eventTypes: ["completed", "human"], subjectId: `screen:${scr.id}`, until: new Date(ctx.now.getTime() + REMIND_WAIT_HOURS * 3600_000).toISOString(), reason: "conversation under way" }, resumeStep: "after_invite" };
      if (scr.status === "human_requested" || scr.status === "abandoned") return { kind: "complete" };
      if (ctx.wake?.kind !== "timer") return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: scr.expiresAt ?? new Date(ctx.now.getTime() + REMIND_WAIT_HOURS * 3600_000).toISOString() }, resumeStep: "after_remind" };
      return { kind: "next", step: "expire" };
    },

    async expire(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr || !b) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status !== "invited" && scr.status !== "reminded") return { kind: "next", step: "after_invite" };
      await ctx.q.update(screens).set({ status: "expired" }).where(eq(screens.id, scr.id));
      await emit(ctx.q, { type: "screen.expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: b.app.id, remindedAt: scr.remindedAt }, correlationId: ctx.run.id });
      await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.expired", title: `${b.candidate.firstName} ${b.candidate.lastName} did not respond to the screen`, body: `Invited ${scr.invitedAt?.slice(0, 10)} and reminded once. You can decline with a reason, keep them in the talent pool, or ask a recruiter to call.`, action: { label: "Review", href: `/roles/${b.role.id}/talent?open=${b.app.id}` } });
      return { kind: "complete" };
    },

    assess: twoPhase<State, { screenId: string; out: RunOutcome<ScreenAssessment> } | null>({
      async prepare(ctx) {
        const pending = await ctx.read(async (q) => {
          const [scr] = await q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
          return scr && !scr.assessmentId ? scr.id : null;
        });
        if (!pending) return null;
        const out = await assessScreen(ctx.db, ctx.services.ai, { companyId: ctx.companyId, screenId: pending, workflowRunId: ctx.run.id });
        return { screenId: pending, out };
      },
      async run(ctx, prepared) {
        const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
        if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
        if (scr.assessmentId) return { kind: "next", step: "recommend" };
        if (!prepared || prepared.screenId !== scr.id) return { kind: "fail", error: "the screen changed after the read phase; assessing again", retryable: true };
        const out = prepared.out;
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          await emit(ctx.q, { type: "ai.output_invalid", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: scr.id }, payload: { error: out.error }, correlationId: ctx.run.id });
          return { kind: "fail", error: `scorecard could not be produced: ${out.error}`, retryable: false };
        }
        const [app] = await ctx.q.select().from(applications).where(eq(applications.id, scr.applicationId)).limit(1);
        const [row] = await ctx.q
          .insert(assessments)
          .values({ companyId: ctx.companyId, applicationId: scr.applicationId, kind: "screen", packetVersion: app.packetVersion, aiRunId: out.runId, result: out.output, overall: out.output.overall, confidence: out.output.confidence, secondaryScore: out.output.secondaryScore !== undefined ? String(out.output.secondaryScore) : null })
          .returning({ id: assessments.id });
        await ctx.q.update(screens).set({ assessmentId: row.id }).where(eq(screens.id, scr.id));
        await ctx.q.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, scr.applicationId));
        await emit(ctx.q, { type: "screen.assessed", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: scr.id }, payload: { assessmentId: row.id, recommendation: out.output.recommendation, confidence: out.output.confidence }, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "assessment.created", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "application", id: scr.applicationId }, payload: { kind: "screen", assessmentId: row.id, overall: out.output.overall }, correlationId: ctx.run.id });
        return { kind: "next", step: "recommend" };
      },
    }),

    async recommend(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!b || !scr?.assessmentId) return { kind: "fail", error: "assessment missing", retryable: false };
      const [asmt] = await ctx.q.select().from(assessments).where(eq(assessments.id, scr.assessmentId)).limit(1);
      const rec = (asmt.result as { recommendation: string }).recommendation;
      const { app, candidate, role } = b;
      const name = `${candidate.firstName} ${candidate.lastName}`;
      if (rec === "strong_interview" || rec === "interview") {
        const g = await gate(ctx.q, { companyId: ctx.companyId, roleId: role.id, applicationId: app.id, actionType: "application.recommend_interview", subject: { type: "application", id: app.id }, proposal: { recommendation: rec, assessmentId: asmt.id }, rationale: `${name} completed the screen: ${asmt.result.summary}`, requestedBy: { kind: "agent", id: "screening", runId: asmt.aiRunId ?? undefined }, workflowRunId: ctx.run.id, expiresInHours: 24 * 7 });
        if (g.outcome === "execute") {
          if (app.stage === "screen_complete") await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "interview_recommended", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
          await emit(ctx.q, { type: "candidate.recommended", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: asmt.aiRunId ?? undefined }, subject: { type: "application", id: app.id }, payload: { recommendation: rec, assessmentId: asmt.id }, correlationId: ctx.run.id });
          if (g.notify) await notify(ctx.q, { companyId: ctx.companyId, kind: "candidate.recommended", title: `${name} is ready to interview`, body: `${rec === "strong_interview" ? "Strong screen. " : ""}${asmt.result.summary}`, action: { label: "Review and decide", href: `/roles/${role.id}/talent?open=${app.id}` } });
        } else if (g.outcome === "wait_for_approval") {
          return { kind: "wait", wait: { kind: "human", approvalRequestId: g.approvalRequestId }, resumeStep: "on_decision" };
        }
        return { kind: "complete" };
      }
      // hold / decline_recommended: nothing moves; the owner sees the scorecard and decides.
      await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.completed", title: `${name} completed the screen`, body: `${rec === "hold" ? "Worth a look before deciding. " : "The screen raised a concern; your call. "}${asmt.result.summary}`, action: { label: "Review", href: `/roles/${role.id}/talent?open=${app.id}` } });
      return { kind: "complete" };
    },

    async on_decision() {
      // The owner (or a policy approver) decided on the recommendation; the application actions route already moved the stage when approving.
      return { kind: "complete" };
    },
  },
};

/** The open questions of the latest résumé assessment, as the first questions of a focused screen. */
async function focusQuestionsFor(q: Tx, applicationId: string): Promise<FocusQuestion[]> {
  const [latest] = await q.select({ result: assessments.result }).from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "triage"))).orderBy(desc(assessments.createdAt)).limit(1);
  return focusQuestionsFrom(latest?.result.unknowns ?? []);
}

/** Text when the candidate agreed to texts and has a number and has not opted out; otherwise the web chat by email. */
function chooseChannel(preferred: "web" | "sms" | undefined, candidate: typeof candidates.$inferSelect): ScreenChannel {
  const wantsSms = (preferred ?? (candidate.consent.sms?.granted && candidate.phone ? "sms" : "web")) === "sms";
  return wantsSms && candidate.consent.sms?.granted && candidate.phone && !candidate.preferences.smsOptOut ? "sms" : "web";
}

async function load(q: Tx, applicationId: string) {
  const [app] = await q.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!app) return null;
  const [candidate] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company || !pv) return null;
  return { app, candidate, role, company, packet: pv.packet };
}

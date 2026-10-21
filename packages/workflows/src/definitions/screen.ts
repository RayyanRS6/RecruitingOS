import { and, desc, eq } from "drizzle-orm";
import type { ScreenAssessment, ScreenChannel, ScreenTurn } from "@ros/contracts";
import type { RunOutcome } from "@ros/ai";
import { runPromptDetached, screenTurnPrompt } from "@ros/ai";
import { audit, emit, entitlements, evaluateEligibility, gate, humanResponseExpectation, isOneVisitFlow, loadBusinessCalendar, nextContactWindow, notify, readingConsistency, transition } from "@ros/core";
import { applications, assessments, candidates, companies, rolePackets, roles, screens, withPlatform, type Tx } from "@ros/db";
import {
  HELD_REASON, answersOf, applyScreenOpening, assessScreen, chatFactsFor, createScreen, finishScreenTurn, focusQuestionsFrom, linkEmailWaiting, loadScreenBundle, packetForFocusedInvite, prepareScreenOpening, requestHuman, screenContextOf, sendConversationHandedOver, sendConversationIdleReminder,
  sendConversationNotOfferedNote, sendConversationNotStartedNote, sendConversationNotStartedReminder, sendConversationResume, sendConversationReviewReminder, sendConversationUnfinishedNote, sendScreenExpiredNote, sendScreenInvite, sendScreenReminder, type FocusQuestion, type ScreenDeps,
} from "@ros/agents";
import type { SendResult } from "@ros/integrations";
import { twoPhase, type StepContext, type StepResult, type WorkflowDefinition } from "../types";
import { SUGGESTION_WINDOW_HOURS, settleSuggestion, waitForSuggestion, type SuggestionState } from "../suggestions";
import { INTERVIEW_LINK_HOURS, READING_SETTLED_EVENT, READING_WAIT_MINUTES, offerInterview, overDesignPartnerAllowance, readingSettled, readingSettledSignal } from "../with-application";
import { HELD_DECISION_EVENT, aiNoticeSentSignal } from "./application-intake";

/**
 * `focus: "unknowns"` ("Ask about this in a screen"): the screen opens with the résumé assessment's open questions before the packet's own.
 * `invitedVia`: the screen was created before this run (with the application, after a confirmed repeat submission, or to
 * write the scorecard of a recruiter's call notes), so the run sends no invitation; `screenId` names it from the start.
 * `waitingForAllowance`: when the run started waiting for the plan's allowance to be topped up (Q17).
 * `flow`: the screen it creates is the conversation that goes with the application, so it reads the same once the link goes out by email.
 * `mode` "with_application" (20 Oct 2026, R20-4): every applicant's AI interview, started by the intake; `readingDeadline`
 * is when it stops waiting for the résumé reading, `heldSince` when a must-have "No" started holding it (R20-10).
 */
type State = { applicationId: string; roleId: string; screenId?: string; channel?: "web" | "sms"; invitedBy?: string; remindedAt?: string; focus?: "unknowns"; invitedVia?: "apply" | "confirmed_repeat" | "recruiter_call" | "with_application"; waitingForAllowance?: string; flow?: "one_visit"; mode?: "with_application"; readingDeadline?: string; heldSince?: string } & SuggestionState;

/** A screen that is over without a scorecard: handed to a person, left, stopped by the team or closed with the application. Nothing more is sent. */
const ENDED = ["human_requested", "abandoned", "cancelled", "expired"];
/**
 * Over before the end without the candidate sending their answers (E3, E4): never read and never shown ("hide them until
 * they send", founder decision of 9 October 2026). The team is told it happened; the reading stays the résumé's.
 */
const PARTIAL = ["unfinished", "declined_by_candidate"];

const INVITE_WAIT_HOURS = 48;
const REMIND_WAIT_HOURS = 72;
/** Started and stopped part-way (E4): one reminder after a day without an answer, closed two days after that. */
export const IDLE_REMIND_HOURS = 24;
export const IDLE_CLOSE_HOURS = 48;
/** The allowance used up (Q17): looked at again every few hours, for up to sixty days. */
const ALLOWANCE_RECHECK_HOURS = 6;
const ALLOWANCE_WAIT_DAYS = 60;
/** The assistant down part-way through (E5): tried again every half hour; after a day a person takes it over. */
const PAUSE_RETRY_MINUTES = 30;
const PAUSE_GIVE_UP_HOURS = 24;

const HOUR = 3600_000;

/** What the conversation functions need from the run. */
function depsOf(ctx: { services: StepContext["services"] }): ScreenDeps {
  return { ai: ctx.services.ai, integrations: ctx.services.integrations, appBaseUrl: ctx.services.env.jobsBaseUrl, signal: (q, input) => ctx.services.engine.signal(q, input), clock: () => ctx.services.engine.clock() };
}

/**
 * docs/06 `screen`: invite → wait for the candidate (48h) → remind once → wait (72h) → expire, or on start: wait for
 * completion → assess → recommend. Conversation turns run in the API (`runScreenTurn`) and signal this run.
 * The two steps that need the model (the SMS opening in `invite`, the scorecard in `assess`) call it in a prepare
 * phase with no transaction open.
 *
 * Wave E: a screen created with the application starts here without an invitation; someone who starts and stops is
 * reminded once and then closed as unfinished (E4), their unsent answers never shown or read; someone who answered
 * everything but did not press Send is reminded once to send them, and is then closed the same way, since only the
 * candidate sends their answers ("hide them until they send", founder decision of 9 October 2026); someone who never
 * starts the conversation that goes with the
 * application is reminded once, then the application goes to the team without it and they are told nothing else is
 * needed (no silent expiry); an outage pauses the conversation and the run tries again until the assistant answers,
 * then emails the candidate to finish, or after a day hands it to a person and tells them (E5); and when the plan's
 * allowance is used up the run waits for it to be topped up instead of giving up, so everyone for a role gets the same
 * process (Q17).
 *
 * 20 October 2026 (R20-4, R20-5): the intake starts one for every applicant (`mode` "with_application"). It waits for the
 * résumé reading (`await_reading`, at most ten minutes), then `invite` offers the AI interview and queues the one email
 * (`offerInterview`); a must-have "No" waits for "Keep them in" (`after_hold`). Every other run starts at `invite` as before.
 * Step 3 (R20-7): a link that lapses or a chat closed unfinished leaves them where they are, under "No AI interview yet"
 * ("Link expired", "Didn't finish"), with the candidate's closing note (G10) and no per-person alert; a person's "Send a
 * reminder" (`remindScreen`) can keep the link open longer, so `after_remind` and `expire` read `expiresAt` again.
 */
export const screen: WorkflowDefinition<State> = {
  key: "screen",
  version: 1,
  initialStep: "await_reading",
  maxAttempts: 4,
  escalationKind: "candidate_issue",
  steps: {
    /**
     * Every applicant's AI interview waits for the intake's reading of the résumé (its signal, or what is stored when the
     * signal came before this run waited), at most until ten minutes after the run started, so the one email goes once
     * the interview's questions can come from the reading, and never later than that. Any other run goes straight on.
     */
    async await_reading(ctx) {
      if (ctx.state.mode !== "with_application" || ctx.state.screenId) return { kind: "next", step: "invite" };
      const deadline = ctx.state.readingDeadline ?? new Date(ctx.now.getTime() + READING_WAIT_MINUTES * 60_000).toISOString();
      const signalled = ctx.wake?.kind === "event" && ctx.wake.key === readingSettledSignal(ctx.state.applicationId);
      if (signalled || ctx.now.getTime() >= Date.parse(deadline)) return { kind: "next", step: "invite", state: { readingDeadline: undefined } };
      const [app] = await ctx.q.select({ id: applications.id, stage: applications.stage }).from(applications).where(eq(applications.id, ctx.state.applicationId)).limit(1);
      if (!app) return { kind: "fail", error: "application not found", retryable: false };
      if (await readingSettled(ctx.q, app)) return { kind: "next", step: "invite", state: { readingDeadline: undefined } };
      return { kind: "wait", wait: { kind: "event", eventTypes: [READING_SETTLED_EVENT], subjectId: app.id, until: deadline, reason: "the AI interview waits for the résumé reading, at most ten minutes after applying" }, state: { readingDeadline: deadline }, resumeStep: "await_reading" };
    },

    invite: twoPhase<State, { channel: ScreenChannel; opening: RunOutcome<ScreenTurn> | null }>({
      async prepare(ctx) {
        if (ctx.state.invitedVia) return { channel: "web", opening: null };
        let usedUp: { companyName: string; used: number; limit: number | null } | null = null;
        const plan = await ctx.read(async (q) => {
          const b = await load(q, ctx.state.applicationId);
          if (!b) return null;
          const { app, candidate, company } = b;
          if (!["triaged", "eligible", "received", "screen_invited", "screening"].includes(app.stage)) return null;
          const ent = await entitlements.check(q, ctx.companyId, entitlements.TEXT_SCREENS, 1);
          if (!ent.ok && company.planKey !== "design_partner") {
            usedUp = { companyName: company.name, used: ent.used, limit: ent.limit };
            return null;
          }
          const channel = ctx.state.flow === "one_visit" ? "web" : chooseChannel(ctx.state.channel, candidate);
          if (channel === "sms" && nextContactWindow(ctx.now, company.timezone, company.settings.businessHours).getTime() > ctx.now.getTime()) return { channel, needsOpening: false }; // quiet hours: the run waits
          const existing = (await q.select().from(screens).where(and(eq(screens.applicationId, app.id), eq(screens.status, "invited"))).limit(1))[0];
          const focusQuestions = ctx.state.focus === "unknowns" && !existing ? await focusQuestionsFor(q, app.id) : null;
          return { channel, needsOpening: channel === "sms", existing: existing ?? null, focusQuestions };
        });
        // ITS hears that the allowance is used up (one alert while it stands; platform side, after the read).
        const blocked = usedUp as { companyName: string; used: number; limit: number | null } | null;
        if (blocked) await withPlatform(ctx.db, (tx) => entitlements.flagScreenAllowance(tx, { companyId: ctx.companyId, companyName: blocked.companyName, crossing: { crossed: "used_up", used: blocked.used, limit: blocked.limit }, now: ctx.now })).catch(() => undefined);
        if (!plan) return { channel: "web", opening: null };
        if (!plan.needsOpening) return { channel: plan.channel, opening: null };
        const opening = await prepareScreenOpening(ctx.db, ctx.services.ai, { companyId: ctx.companyId, applicationId: ctx.state.applicationId, channel: plan.channel, workflowRunId: ctx.run.id, screen: plan.existing ?? null, focusQuestions: plan.focusQuestions ?? null });
        return { channel: plan.channel, opening };
      },
      async run(ctx, prepared) {
        // Created before this run (with the application, a confirmed repeat, a recruiter's notes): nothing is sent here.
        if (ctx.state.invitedVia && ctx.state.screenId) {
          const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId)).limit(1);
          if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
          if (!scr.workflowRunId) await ctx.q.update(screens).set({ workflowRunId: ctx.run.id }).where(eq(screens.id, scr.id));
          if (scr.status !== "invited") return { kind: "next", step: "after_invite", state: { channel: scr.channel as ScreenChannel } };
          // An emailed-in applicant's interview, made with their one email in the intake (R20-5): held for the ITS company check, its clock waits for it (B7).
          const held = scr.invitedVia === "with_application" && (await linkEmailWaiting(ctx.q, scr));
          return waitForStart(scr, new Date(Date.parse(scr.invitedAt ?? ctx.now.toISOString()) + INVITE_WAIT_HOURS * HOUR), { channel: scr.channel as ScreenChannel }, held);
        }
        const b = await load(ctx.q, ctx.state.applicationId);
        if (!b) return { kind: "fail", error: "application not found", retryable: false };
        const { app, candidate, role, company, packet } = b;
        // Every applicant's AI interview and the one email (20 Oct 2026): no gate, no SMS (R20-6), the job's own length.
        if (ctx.state.mode === "with_application") {
          const offer = await offerInterview(ctx.q, { integrations: ctx.services.integrations, jobsBaseUrl: ctx.services.env.jobsBaseUrl }, b, { now: ctx.now, actor: ctx.actor, correlationId: ctx.run.id, workflowRunId: ctx.run.id });
          if (offer.kind === "invited") return waitForStart({ id: offer.screenId, applicationId: app.id }, new Date(ctx.now.getTime() + INVITE_WAIT_HOURS * HOUR), { screenId: offer.screenId, channel: "web", waitingForAllowance: undefined }, emailHeld(offer.email));
          if (offer.kind === "held") {
            const heldSince = ctx.state.heldSince ?? ctx.now.toISOString();
            return { kind: "wait", wait: { kind: "event", eventTypes: [HELD_DECISION_EVENT], subjectId: app.id, until: new Date(ctx.now.getTime() + HELD_RECHECK_HOURS * HOUR).toISOString(), reason: "a must-have answer was No: the AI interview link goes once a person keeps them in" }, state: { heldSince }, resumeStep: "after_hold" };
          }
          if (offer.kind === "used_up") return waitForAllowance(ctx, b, offer);
          return { kind: "complete" }; // left the process (the neutral thank-you went), or a person sent a link already
        }
        if (!["triaged", "eligible", "received", "screen_invited", "screening"].includes(app.stage)) {
          // Left the process while waiting for the allowance: nothing to send, and nobody to page.
          if (ctx.state.waitingForAllowance) return { kind: "complete" };
          return { kind: "fail", error: `application is ${app.stage}; nothing to screen`, retryable: false };
        }
        const ent = await entitlements.check(ctx.q, ctx.companyId, entitlements.TEXT_SCREENS, 1);
        if (!ent.ok) {
          // Founder decision F8: a billing limit never interrupts an active candidate process for a design partner; the owner and ITS are told.
          if (company.planKey === "design_partner") await overDesignPartnerAllowance(ctx.q, { companyId: ctx.companyId, applicationId: app.id, name: `${candidate.firstName} ${candidate.lastName}`, ent, planKey: company.planKey, actor: ctx.actor, correlationId: ctx.run.id });
          else return waitForAllowance(ctx, b, ent);
        }
        // The conversation that goes with the application is on the web only, whatever the candidate agreed to (E1, Q17).
        const channel = ctx.state.flow === "one_visit" ? "web" : chooseChannel(ctx.state.channel, candidate);
        if (channel === "sms") {
          const allowed = nextContactWindow(ctx.now, company.timezone, company.settings.businessHours);
          if (allowed.getTime() > ctx.now.getTime()) return { kind: "wait", wait: { kind: "timer", until: allowed.toISOString(), reason: "quiet hours: texts go out between 8:00 and 21:00 local time, inside the company's contact hours" }, resumeStep: "invite" };
        }
        const expiresAt = new Date(ctx.now.getTime() + (INVITE_WAIT_HOURS + REMIND_WAIT_HOURS) * HOUR).toISOString();
        // "Ask about this in a screen": the open questions are fixed on the screen now, so a later assessment never changes a conversation under way.
        const focusQuestions = ctx.state.focus === "unknowns" ? await focusQuestionsFor(ctx.q, app.id) : null;
        const scr = await createScreen(ctx.q, { companyId: ctx.companyId, applicationId: app.id, channel, workflowRunId: ctx.run.id, expiresAt, now: ctx.now, focusQuestions, flow: ctx.state.flow ?? null });
        // An interview another run made first (every applicant's own, made while this one waited): that run carries it,
        // and this one sends nothing, so the team still hears once when it is scored (R20-8).
        if (scr.workflowRunId && scr.workflowRunId !== ctx.run.id) return { kind: "complete" };
        let opening: string | null = null;
        if (channel === "sms") {
          if (prepared.channel !== "sms") return { kind: "fail", error: "the channel changed after the read phase; preparing the opening again", retryable: true };
          const o = await applyScreenOpening(ctx.q, { companyId: ctx.companyId, screenId: scr.id, packet, out: prepared.opening });
          if ("error" in o) return { kind: "fail", error: `could not open the screen: ${o.error}`, retryable: true };
          opening = o.message;
        }
        // Once per screen and run. Not `alreadyDone("invite")`: waiting out quiet hours above leaves an ok ledger entry for
        // this step, and the invitation would then never go out when the window opens. The run's state names the screen
        // only in the same transaction that queues the invitation. The allowance counts the conversation at its first
        // answer, never here (plan E9).
        if (ctx.state.screenId !== scr.id) {
          // The invitation counts the questions the chat asks (the open questions, and since Wave S8 the company's
          // written questions), and a focused screen's says the conversation starts with the open questions.
          const sent = await sendScreenInvite(ctx.q, ctx.services.integrations, { application: app, candidate, role, company, packet: packetForFocusedInvite(packet, scr.progress), actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token, channel }, opening });
          if (sent.email.status === "failed" && !candidate.email && channel !== "sms") return { kind: "fail", error: "candidate has no email and no SMS consent; nobody can be reached", retryable: false };
        }
        if (app.stage !== "screen_invited") await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "screen_invited", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "screen.invited", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { channel, applicationId: app.id, invitedBy: ctx.state.invitedBy ?? "system", focus: ctx.state.focus ?? null, focusQuestions: scr.progress.focusQuestions?.length ?? 0, ...(ctx.state.waitingForAllowance ? { waitedForAllowanceSince: ctx.state.waitingForAllowance } : {}) }, correlationId: ctx.run.id });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: new Date(ctx.now.getTime() + INVITE_WAIT_HOURS * HOUR).toISOString(), reason: "waiting for the candidate to start; reminder after 48h" }, state: { screenId: scr.id, channel }, resumeStep: "after_invite" };
      },
    }),

    /**
     * A must-have "No" on the form held the AI interview (R20-10): "Keep them in" wakes this at once, and the link goes by
     * itself after the kept-in application's reading, with nothing more to approve. Still held, it looks again every
     * day; a decline or the role closing ends it at `invite` with nothing more sent. Nobody is ever declined here.
     */
    async after_hold(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      if (!b) return { kind: "fail", error: "application not found", retryable: false };
      const { app, packet } = b;
      const heldSince = ctx.state.heldSince ?? ctx.now.toISOString();
      const held = app.stage === "ineligible" || (["applied", "received"].includes(app.stage) && !evaluateEligibility(packet.requirements.eligibility, (app.answers.eligibility ?? {}) as Record<string, unknown>, ctx.now).passed);
      if (held) {
        if (ctx.now.getTime() - Date.parse(heldSince) > HELD_WAIT_DAYS * 24 * HOUR) return { kind: "complete" };
        return { kind: "wait", wait: { kind: "event", eventTypes: [HELD_DECISION_EVENT], subjectId: app.id, until: new Date(ctx.now.getTime() + HELD_RECHECK_HOURS * HOUR).toISOString(), reason: "a must-have answer was No: the AI interview link goes once a person keeps them in" }, state: { heldSince }, resumeStep: "after_hold" };
      }
      return { kind: "next", step: "await_reading", state: { heldSince: undefined, readingDeadline: new Date(ctx.now.getTime() + READING_WAIT_MINUTES * 60_000).toISOString() } };
    },

    async after_invite(ctx) {
      // Woken by the candidate (event) or by a timer; the engine hands us either.
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
      if (ENDED.includes(scr.status)) return { kind: "complete" };
      if (scr.status === "completed") return { kind: "next", step: "assess" };
      // Sent without the conversation (the team was told then) or closed unfinished (told at the close): nothing to read.
      if (PARTIAL.includes(scr.status)) return { kind: "complete" };
      if (scr.status === "paused") return { kind: "next", step: "retry_paused" };
      if (scr.status === "in_progress") {
        // E4: no longer a 72-hour wait repeated for ever. A day without an answer brings one reminder; two more days close it.
        const lastActive = Math.max(Date.parse(scr.lastCandidateMessageAt ?? scr.startedAt ?? ctx.now.toISOString()), scr.idleRemindedAt ? Date.parse(scr.idleRemindedAt) : 0);
        // A person's "Send a reminder" (R20-7) keeps it open at least until `keptOpenUntil` too.
        const kept = scr.idleRemindedAt && scr.progress.keptOpenUntil ? Date.parse(scr.progress.keptOpenUntil) : 0;
        const due = Math.max(lastActive + (scr.idleRemindedAt ? IDLE_CLOSE_HOURS : IDLE_REMIND_HOURS) * HOUR, kept);
        if (ctx.now.getTime() >= due) return { kind: "next", step: scr.idleRemindedAt ? "close_unfinished" : "idle_remind" };
        return { kind: "wait", wait: { kind: "event", eventTypes: ["completed", "human", "paused"], subjectId: `screen:${scr.id}`, until: new Date(due).toISOString(), reason: "conversation under way" }, resumeStep: "after_invite" };
      }
      // B7: the one email with the link was held for the ITS company check. The link's five days, the 48-hour reminder and
      // the day between a person's reminders count from when it leaves (the outbox signals it; `invitedAt` then says when),
      // never from when the interview was made. A person's reminder sent while it waited (before 21 Oct) left it reminded.
      if (scr.invitedVia === "with_application" && (scr.status === "invited" || scr.status === "reminded")) {
        if (ctx.wake?.kind === "event" && ctx.wake.key === aiNoticeSentSignal(scr.applicationId)) {
          await ctx.q.update(screens).set({ invitedAt: ctx.now.toISOString(), expiresAt: new Date(ctx.now.getTime() + INTERVIEW_LINK_HOURS * HOUR).toISOString() }).where(eq(screens.id, scr.id));
          return waitForStart(scr, new Date(ctx.now.getTime() + INVITE_WAIT_HOURS * HOUR), {}, false);
        }
        if (ctx.wake?.kind === "timer" && (await linkEmailWaiting(ctx.q, scr))) return waitForStart(scr, new Date(ctx.now.getTime() + HELD_RECHECK_HOURS * HOUR), {}, true);
      }
      if (ctx.wake?.kind !== "timer") return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: scr.expiresAt ?? new Date(ctx.now.getTime() + INVITE_WAIT_HOURS * HOUR).toISOString() }, resumeStep: "after_invite" };
      if (!scr.remindedAt) return { kind: "next", step: "remind" };
      return { kind: "next", step: "expire" };
    },

    async remind(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      if (!b) return { kind: "fail", error: "application not found", retryable: false };
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr || ENDED.includes(scr.status)) return { kind: "complete" };
      if (scr.status !== "invited") return { kind: "next", step: "after_invite" };
      if (scr.channel === "sms") {
        const allowed = nextContactWindow(ctx.now, b.company.timezone, b.company.settings.businessHours);
        if (allowed.getTime() > ctx.now.getTime()) return { kind: "wait", wait: { kind: "timer", until: allowed.toISOString(), reason: "quiet hours" }, resumeStep: "remind" };
      }
      // The conversation that goes with the application (E4): leaving it costs nothing, and the reminder says so.
      if (isOneVisitFlow(scr.progress)) {
        const packet = (await loadScreenBundle(ctx.q, scr.id))?.packet ?? b.packet;
        await sendConversationNotStartedReminder(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token }, questions: packet.screening.questions.length, minutes: packet.screening.maxMinutes });
      } else await sendScreenReminder(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token, channel: scr.channel as "web" | "sms" } });
      await ctx.q.update(screens).set({ status: "reminded", remindedAt: ctx.now.toISOString() }).where(eq(screens.id, scr.id));
      const until = new Date(ctx.now.getTime() + REMIND_WAIT_HOURS * HOUR).toISOString();
      // Wait for the candidate or the expiry timer, whichever first.
      await ctx.q.update(screens).set({ expiresAt: until }).where(eq(screens.id, scr.id));
      return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until, reason: "reminder sent; waiting for the candidate" }, state: { remindedAt: ctx.now.toISOString() }, resumeStep: "after_remind" };
    },

    async after_remind(ctx) {
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status !== "reminded") return { kind: "next", step: "after_invite" };
      // B7: the email carrying the link still waits for the ITS check, so the link's clock has not started: it waits for
      // that email to leave (`after_invite` then starts the clock), never closing a link nobody received.
      if (scr.invitedVia === "with_application" && (await linkEmailWaiting(ctx.q, scr))) return waitForStart(scr, new Date(ctx.now.getTime() + HELD_RECHECK_HOURS * HOUR), {}, true);
      // A person's "Send a reminder" (R20-7) may have kept the link open longer: the wait is read again from the screen.
      const open = scr.expiresAt && Date.parse(scr.expiresAt) > ctx.now.getTime();
      if (ctx.wake?.kind !== "timer" || open) return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: scr.expiresAt ?? new Date(ctx.now.getTime() + REMIND_WAIT_HOURS * HOUR).toISOString() }, resumeStep: "after_remind" };
      return { kind: "next", step: "expire" };
    },

    async expire(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr || !b) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status !== "invited" && scr.status !== "reminded") return { kind: "next", step: "after_invite" };
      // B7: a link whose email still waits for the ITS check never closes; it waits for the email (`after_invite`).
      if (scr.invitedVia === "with_application" && (await linkEmailWaiting(ctx.q, scr))) return waitForStart(scr, new Date(ctx.now.getTime() + HELD_RECHECK_HOURS * HOUR), {}, true);
      // A person's "Send a reminder" (R20-7) keeps the link open at least 72 hours from then: until that passes, it waits again.
      if (scr.expiresAt && Date.parse(scr.expiresAt) > ctx.now.getTime()) return { kind: "wait", wait: { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${scr.id}`, until: scr.expiresAt, reason: "a person sent a reminder; the link stays open until then" }, resumeStep: "after_remind" };
      // A person's new link that lapses is told as a link that closed (below), never as an application without the chat.
      const oneVisit = isOneVisitFlow(scr.progress) && !byPerson(ctx.state);
      await ctx.q.update(screens).set({ status: "expired" }).where(eq(screens.id, scr.id));
      await emit(ctx.q, { type: "screen.expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: b.app.id, remindedAt: scr.remindedAt, ...(oneVisit ? { oneVisit: true } : {}) }, correlationId: ctx.run.id });
      // Since Step 3 (R20-7) they stay where they are, under "No AI interview yet" as "Link expired": the column and the
      // one line per job on Home replace the per-person alerts, and the team can remind, send a new link or decline there.
      if (oneVisit) {
        // E4 and G10: never started, and nothing is lost by it; the candidate is told nothing else is needed.
        await sendConversationNotStartedNote(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, screen: { id: scr.id } });
        return { kind: "complete" };
      }
      // No silent expiry (plan G10): the candidate is told the link closed, that the application is still with the team,
      // and that a reply brings a new link from a person.
      await sendScreenExpiredNote(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, screen: { id: scr.id } });
      return { kind: "complete" };
    },

    /**
     * E4: one reminder to someone who started and stopped part-way, with their answers kept. Someone who answered every
     * question and did not press Send (E10) is reminded to send them instead, with the day the conversation closes if
     * they do not; answers nobody sent are never passed on (founder decision of 9 October 2026).
     */
    async idle_remind(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr || !b) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status !== "in_progress" || scr.idleRemindedAt) return { kind: "next", step: "after_invite" };
      const packet = (await loadScreenBundle(ctx.q, scr.id))?.packet ?? b.packet;
      const link = { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token }, questions: packet.screening.questions.length, minutes: packet.screening.maxMinutes };
      if (scr.progress.phase === "review") await sendConversationReviewReminder(ctx.q, ctx.services.integrations, { ...link, closesOn: dayWords(new Date(ctx.now.getTime() + IDLE_CLOSE_HOURS * HOUR), b.company.timezone) });
      else await sendConversationIdleReminder(ctx.q, ctx.services.integrations, link);
      await ctx.q.update(screens).set({ idleRemindedAt: ctx.now.toISOString() }).where(eq(screens.id, scr.id));
      await emit(ctx.q, { type: "screen.idle_reminded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: b.app.id, answered: Object.keys(answersOf(scr)).length }, correlationId: ctx.run.id });
      return { kind: "wait", wait: { kind: "event", eventTypes: ["completed", "human", "paused"], subjectId: `screen:${scr.id}`, until: new Date(ctx.now.getTime() + IDLE_CLOSE_HOURS * HOUR).toISOString(), reason: "reminded once; closing unsent if they do not come back" }, resumeStep: "after_invite" };
    },

    /**
     * E4: still nothing two days after the reminder. The conversation closes as unfinished and the candidate gets a short
     * note that nothing else is needed (G10). They never sent their answers, so nothing they said is shown to the team
     * or read for it (founder decision of 9 October 2026, "hide them until they send"), and the reading and the match
     * score stay the résumé's. Someone who answered everything and only did not press Send closes the same way: only the
     * candidate sends their answers, never the software on their behalf, and the reminder told them so. Since Step 3
     * (R20-7) they stay under "No AI interview yet" as "Didn't finish", with no per-person alert: the column and Home's
     * one line per job say it, in the same words whatever they answered, so nothing says how far they got.
     */
    async close_unfinished(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!scr || !b) return { kind: "fail", error: "screen missing", retryable: false };
      if (scr.status !== "in_progress") return { kind: "next", step: "after_invite" };
      // The counts stay on the record for ITS; the team's history never shows them (withoutUnsentScreenEvents).
      const answered = Object.keys(answersOf(scr)).length;
      await ctx.q.update(screens).set({ status: "unfinished", completedAt: ctx.now.toISOString() }).where(eq(screens.id, scr.id));
      await emit(ctx.q, { type: "screen.unfinished", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: b.app.id, answered, questions: b.packet.screening.questions.length, stoppedAt: scr.progress.currentQuestionKey ?? null }, correlationId: ctx.run.id });
      await sendConversationUnfinishedNote(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, screen: { id: scr.id } });
      return { kind: "complete" };
    },

    /**
     * E5: the assistant stopped working part-way. The candidate's last message is tried again every half hour; once the
     * assistant answers, the conversation is open again and the candidate is emailed to finish. After a day a person
     * takes it over. "I'd rather talk to a person" works the whole time.
     */
    retry_paused: twoPhase<State, { screenId: string; latest: string; out: RunOutcome<ScreenTurn> } | null>({
      async prepare(ctx) {
        const plan = await ctx.read(async (q) => {
          const b = await loadScreenBundle(q, ctx.state.screenId!);
          if (b?.screen.status !== "paused") return null;
          const lastCandidate = b.screen.transcript.map((t) => t.role).lastIndexOf("candidate");
          if (lastCandidate < 0) return null;
          // The model sees the conversation up to the message it never answered, not the holding notes after it.
          const transcript = b.screen.transcript.slice(0, lastCandidate + 1);
          const latest = transcript[lastCandidate].content;
          return { screenId: b.screen.id, latest, ctx: screenContextOf({ companyName: b.company.name, companyLocations: b.company.locations, noticeOverrides: b.company.settings.notices, packet: b.packet, firstName: b.candidate.firstName, focusUnknowns: b.triageUnknowns, facts: chatFactsFor(b.chatFacts, b.screen.progress, b.screen.invitedVia) }, { ...b.screen, transcript }, latest) };
        });
        if (!plan) return null;
        const out = await runPromptDetached(ctx.db, ctx.services.ai, screenTurnPrompt, plan.ctx, { companyId: ctx.companyId, workflowRunId: ctx.run.id, inputRef: { screenId: plan.screenId, retry: true } });
        return { screenId: plan.screenId, latest: plan.latest, out };
      },
      async run(ctx, prepared) {
        const b = await loadScreenBundle(ctx.q, ctx.state.screenId!);
        if (!b) return { kind: "fail", error: "screen missing", retryable: false };
        const scr = b.screen;
        if (scr.status !== "paused") return { kind: "next", step: "after_invite" };
        const deps = depsOf(ctx);
        const pausedAt = scr.progress.pausedAt ?? ctx.now.toISOString();
        const retryAt = new Date(ctx.now.getTime() + PAUSE_RETRY_MINUTES * 60_000).toISOString();
        // A person took it over (after a day without the assistant, or the retried answer handed over): the candidate is
        // told, by email, since the page that promised a link to finish will not get one.
        const handedOver = async () => {
          const expectation = humanResponseExpectation(ctx.now, await loadBusinessCalendar(ctx.q));
          await sendConversationHandedOver(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, screen: { id: scr.id }, expectation });
        };
        if (!prepared || prepared.screenId !== scr.id || !prepared.out.ok) {
          if (ctx.now.getTime() - Date.parse(pausedAt) >= PAUSE_GIVE_UP_HOURS * HOUR) {
            await requestHuman(ctx.q, deps, { screenId: scr.id, reason: "assistant failed for a day after pausing the AI interview", actor: ctx.actor, reply: null, replyChannel: "web" });
            await handedOver();
            return { kind: "complete" };
          }
          await ctx.q.update(screens).set({ progress: { ...scr.progress, retriedAt: ctx.now.toISOString() } }).where(eq(screens.id, scr.id));
          return { kind: "wait", wait: { kind: "event", eventTypes: ["human", "completed"], subjectId: `screen:${scr.id}`, until: retryAt, reason: "the assistant is not answering; trying again" }, resumeStep: "retry_paused" };
        }
        const transcript = scr.transcript;
        const ctxModel = screenContextOf({ companyName: b.company.name, companyLocations: b.company.locations, noticeOverrides: b.company.settings.notices, packet: b.packet, firstName: b.candidate.firstName, focusUnknowns: b.triageUnknowns, facts: chatFactsFor(b.chatFacts, scr.progress, scr.invitedVia) }, scr, prepared.latest);
        await finishScreenTurn(ctx.q, deps, { screenId: scr.id, message: prepared.latest, channel: "web", actor: ctx.actor }, { kind: "pending", b, transcript, ctx: ctxModel }, prepared.out);
        // Open again: the candidate is emailed to finish. Handed to a person by the retried answer: told so instead.
        const [after] = await ctx.q.select({ status: screens.status }).from(screens).where(eq(screens.id, scr.id)).limit(1);
        if (after?.status === "in_progress") await sendConversationResume(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token }, questions: b.packet.screening.questions.length, minutes: b.packet.screening.maxMinutes, pausedAt });
        else if (after?.status === "human_requested") await handedOver();
        return { kind: "next", step: "after_invite" };
      },
    }),

    /** Only a complete conversation is read (`assessScreen`); one the candidate did not send never is. */
    assess: twoPhase<State, { screenId: string; out: RunOutcome<ScreenAssessment> } | null>({
      async prepare(ctx) {
        const pending = await ctx.read(async (q) => {
          const [scr] = await q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
          return scr && !scr.assessmentId && scr.status === "completed" ? scr.id : null;
        });
        if (!pending) return null;
        const out = await assessScreen(ctx.db, ctx.services.ai, { companyId: ctx.companyId, screenId: pending, workflowRunId: ctx.run.id });
        return { screenId: pending, out };
      },
      async run(ctx, prepared) {
        const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
        if (!scr) return { kind: "fail", error: "screen missing", retryable: false };
        if (scr.assessmentId) return { kind: "next", step: "recommend" };
        if (scr.status !== "completed") {
          // A run that reached this step for a conversation closed without being sent (one under way when this rule
          // came in, 9 October 2026): nothing is read. Unfinished, it stays under "No AI interview yet" (R20-7, no alert);
          // sent without the conversation, the team hears it as Q16's choice does.
          const b = scr.status === "declined_by_candidate" ? await load(ctx.q, ctx.state.applicationId) : null;
          if (b) await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.declined_by_candidate", title: `${b.candidate.firstName} ${b.candidate.lastName} sent their application without the AI interview`, body: `They chose not to do the AI interview for ${b.packet.identity.title}, which is never held against them. Their application is ready for your review.`, action: { label: "Review", href: `/roles/${b.role.id}/talent?open=${b.app.id}` } });
          return { kind: "complete" };
        }
        if (!prepared || prepared.screenId !== scr.id) return { kind: "fail", error: "the screen changed after the read phase; assessing again", retryable: true };
        const out = prepared.out;
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          await emit(ctx.q, { type: "ai.output_invalid", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: scr.id }, payload: { error: out.error }, correlationId: ctx.run.id });
          return { kind: "fail", error: `scorecard could not be produced: ${out.error}`, retryable: false };
        }
        const [app] = await ctx.q.select().from(applications).where(eq(applications.id, scr.applicationId)).limit(1);
        // The model writes no number (plan 0.9); the column stays for a score worked out in code later.
        const [row] = await ctx.q
          .insert(assessments)
          .values({ companyId: ctx.companyId, applicationId: scr.applicationId, kind: "screen", packetVersion: app.packetVersion, aiRunId: out.runId, result: out.output, overall: out.output.overall, confidence: out.output.confidence, secondaryScore: null })
          .returning({ id: assessments.id });
        await ctx.q.update(screens).set({ assessmentId: row.id }).where(eq(screens.id, scr.id));
        await ctx.q.update(applications).set({ latestAssessmentId: row.id }).where(eq(applications.id, scr.applicationId));
        await emit(ctx.q, { type: "screen.assessed", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: scr.id }, payload: { assessmentId: row.id, recommendation: out.output.recommendation, confidence: out.output.confidence, incomplete: PARTIAL.includes(scr.status) }, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "assessment.created", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "application", id: scr.applicationId }, payload: { kind: "screen", assessmentId: row.id, overall: out.output.overall }, correlationId: ctx.run.id });
        return { kind: "next", step: "recommend" };
      },
    }),

    /**
     * The scorecard's suggestion, under policy `application.recommend_interview`. The software check comes first (plan
     * A8): a scorecard that disagrees with its own must-have findings holds the step for a person, with the reason. A
     * suggestion that waits for approval expires after a week (plan A6). A conversation that was not sent is never read,
     * so it never comes here; a reading made of one before 9 October 2026 suggests nothing and is never quoted.
     */
    async recommend(ctx) {
      const b = await load(ctx.q, ctx.state.applicationId);
      const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId!)).limit(1);
      if (!b || !scr?.assessmentId) return { kind: "fail", error: "assessment missing", retryable: false };
      const [asmt] = await ctx.q.select().from(assessments).where(eq(assessments.id, scr.assessmentId)).limit(1);
      const rec = (asmt.result as { recommendation: string }).recommendation;
      const { app, candidate, role, packet } = b;
      const name = `${candidate.firstName} ${candidate.lastName}`;
      // They left the process while the scorecard was being written: nothing to suggest or announce.
      if (["hired", "withdrawn", "rejected", "declined", "talent_pool"].includes(app.stage)) return { kind: "complete" };
      if (PARTIAL.includes(scr.status)) {
        // Unfinished: under "No AI interview yet", with no per-person alert (R20-7).
        if (scr.status === "declined_by_candidate") await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.declined_by_candidate", title: `${name} sent their application without the AI interview`, body: `They chose not to do the AI interview for ${packet.identity.title}, which is never held against them. Their application is ready for your review.`, action: { label: "Review", href: `/roles/${role.id}/talent?open=${app.id}` } });
        return { kind: "complete" };
      }
      const check = readingConsistency(asmt, packet);
      if (!check.consistent) {
        await audit(ctx.q, { companyId: ctx.companyId, actor: ctx.actor, action: "assessment.flagged", target: { type: "application", id: app.id }, reason: check.reason ?? "the scorecard disagrees with its must-have findings", details: { assessmentId: asmt.id, held: "application.recommend_interview" } });
        await notify(ctx.q, { companyId: ctx.companyId, kind: "application.needs_review", title: `${name} needs a closer look`, body: `${name} finished the AI interview. ${check.reason}`, action: { label: "Take a closer look", href: `/roles/${role.id}/talent?open=${app.id}` } });
        return { kind: "complete" };
      }
      if (rec === "strong_interview" || rec === "interview") {
        const g = await gate(ctx.q, { companyId: ctx.companyId, roleId: role.id, applicationId: app.id, actionType: "application.recommend_interview", subject: { type: "application", id: app.id }, proposal: { recommendation: rec, assessmentId: asmt.id }, rationale: `${name} finished the AI interview: ${asmt.result.summary}`, requestedBy: { kind: "agent", id: "screening", runId: asmt.aiRunId ?? undefined }, workflowRunId: ctx.run.id, expiresInHours: SUGGESTION_WINDOW_HOURS });
        if (g.outcome === "execute") {
          if (app.stage === "screen_complete") await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "interview_recommended", by: "system", actor: ctx.actor, correlationId: ctx.run.id });
          await emit(ctx.q, { type: "candidate.recommended", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: asmt.aiRunId ?? undefined }, subject: { type: "application", id: app.id }, payload: { recommendation: rec, assessmentId: asmt.id }, correlationId: ctx.run.id });
          if (g.notify) await notify(ctx.q, { companyId: ctx.companyId, kind: "candidate.recommended", title: `${name} is ready to interview`, body: `${rec === "strong_interview" ? "Strong AI interview. " : ""}${asmt.result.summary}`, action: { label: "Approve an interview", href: `/roles/${role.id}/talent?open=${app.id}&step=interview` } });
        } else if (g.outcome === "wait_for_approval") {
          return waitForSuggestion(ctx, g.approvalRequestId, "on_decision");
        }
        return { kind: "complete" };
      }
      // hold / decline_recommended: nothing moves; the owner sees the scorecard and decides.
      await notify(ctx.q, { companyId: ctx.companyId, kind: "screen.completed", title: `${name} finished the AI interview`, body: `${rec === "hold" ? "Worth a look before deciding. " : "The AI interview raised a concern; your call. "}${asmt.result.summary}`, action: { label: "Review", href: `/roles/${role.id}/talent?open=${app.id}` } });
      return { kind: "complete" };
    },

    async on_decision(ctx) {
      // The owner (or a policy approver) decided on the recommendation; the application actions route already moved the
      // stage when approving. A suggestion nobody answered within the week lapses here, and nothing is sent.
      return (await settleSuggestion(ctx, "on_decision")) ?? { kind: "complete" };
    },
  },
};

/**
 * A person's own new link ("Send a new AI interview link": `invitedBy` names them), not the interview every applicant
 * gets ("system"), or the one the apply page promised before 20 Oct 2026 ("apply"). Since 21 Oct it is the same AI
 * interview (`flow`), but nothing promised it: a lapse is a link that closed, and an allowance that never came is no
 * broken promise to the candidate.
 */
function byPerson(state: State): boolean {
  return !!state.invitedBy && state.invitedBy !== "system" && state.invitedBy !== "apply";
}

/** A must-have "No" (R20-10): looked at again every day, and given up after sixty days still held; "Keep them in" later starts it again (`startInterviewAgain`). */
const HELD_RECHECK_HOURS = 24;
const HELD_WAIT_DAYS = 60;

/**
 * Waiting for the candidate to start, with the reminder at `until`. While the email carrying the link is held for the
 * ITS company check (B7), its leaving wakes the run too (the outbox's `aiNoticeSentSignal`), and the clock starts then.
 */
function waitForStart(scr: { id: string; applicationId: string }, until: Date, state: Partial<State>, held: boolean): StepResult<State> {
  const keys = ["started", "completed", "human"].map((e) => `screen:${scr.id}:${e}`);
  return { kind: "wait", wait: { kind: "event", eventTypes: held ? [...keys, aiNoticeSentSignal(scr.applicationId)] : keys, until: until.toISOString(), reason: held ? "the email with the link waits for the ITS company check; the reminder clock starts when it leaves" : "waiting for the candidate to start; reminder after 48h" }, state, resumeStep: "after_invite" };
}

/** Whether a queued email is held for the ITS company check (its queue answer says so). */
function emailHeld(email: SendResult): boolean {
  return email.status === "pending" && email.reason === HELD_REASON;
}

/**
 * Q17 (kept on 20 Oct 2026, R20-11): the month's AI interviews are used up. The application stays, and the link goes out
 * by email once more are added, so everyone for the role has the same process. The owner is told once per person and ITS
 * is told (the read phase); the run looks again every few hours, and after sixty days says so instead of lapsing silently.
 */
async function waitForAllowance(ctx: StepContext<State>, b: NonNullable<Awaited<ReturnType<typeof load>>>, ent: { used: number; limit: number | null }): Promise<StepResult<State>> {
  const { app, candidate, role, company, packet } = b;
  const since = ctx.state.waitingForAllowance ?? ctx.now.toISOString();
  if (!ctx.state.waitingForAllowance) {
    await emit(ctx.q, { type: "entitlement.exceeded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { key: entitlements.TEXT_SCREENS, limit: ent.limit, used: ent.used, plan: company.planKey }, correlationId: ctx.run.id });
    await notify(ctx.q, { companyId: ctx.companyId, kind: "entitlement.text_screens", title: "AI interviews used up for this month", body: `Your plan includes ${ent.limit} AI interviews this month. ${candidate.firstName} ${candidate.lastName} is waiting for one and gets the link by email as soon as more are added, so everyone for ${role.title} has the same process. ITS has been told. You can also review them yourself.`, action: { label: "See usage", href: "/setup" } });
  }
  if (ctx.now.getTime() - Date.parse(since) > ALLOWANCE_WAIT_DAYS * 24 * HOUR) {
    // Still used up after the whole wait: no silent lapse (plan G10). Someone whose email promised the link (the
    // interview that goes with the application) is told it is not going ahead and that nothing is needed; the team is
    // told the person never got it, whoever started the run. Nobody stays "Getting the AI interview ready" for ever
    // (R20-7): they move to New, ready for review as they are.
    const promised = ctx.state.flow === "one_visit" && !byPerson(ctx.state);
    await emit(ctx.q, { type: "screen.allowance_lapsed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "application", id: app.id }, payload: { waitingSince: since, days: ALLOWANCE_WAIT_DAYS, promised }, correlationId: ctx.run.id });
    if (app.stage === "eligible" || app.stage === "received") await transition(ctx.q, { applicationId: app.id, companyId: ctx.companyId, to: "triaged", by: "system", actor: ctx.actor, reason: `the plan's AI interviews stayed used up for ${ALLOWANCE_WAIT_DAYS} days`, correlationId: ctx.run.id });
    if (promised) await sendConversationNotOfferedNote(ctx.q, ctx.services.integrations, { application: app, candidate, role, company, packet, actor: ctx.actor, correlationId: ctx.run.id });
    await notify(ctx.q, { companyId: ctx.companyId, kind: "entitlement.text_screens", title: `${candidate.firstName} ${candidate.lastName} never got the AI interview`, body: `Your plan's AI interviews stayed used up for ${ALLOWANCE_WAIT_DAYS} days, so ${candidate.firstName} never got the link.${promised ? " They have been told their application is with you as it is and that nothing else is needed." : ""} Their application is ready for your review; you can also ask a recruiter to call them.`, action: { label: "Review", href: `/roles/${role.id}/talent?open=${app.id}` } });
    return { kind: "complete" };
  }
  return { kind: "wait", wait: { kind: "timer", until: new Date(ctx.now.getTime() + ALLOWANCE_RECHECK_HOURS * HOUR).toISOString(), reason: "the plan's AI interviews are used up; waiting for more" }, state: { waitingForAllowance: since }, resumeStep: "invite" };
}

/** The open questions of the latest résumé assessment, as the first questions of a focused screen. */
async function focusQuestionsFor(q: Tx, applicationId: string): Promise<FocusQuestion[]> {
  const [latest] = await q.select({ result: assessments.result }).from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "triage"))).orderBy(desc(assessments.createdAt)).limit(1);
  return focusQuestionsFrom(latest?.result.unknowns ?? []);
}

/** A day as the candidate reads it, in the company's time zone: "Saturday, October 10, 2026". */
function dayWords(at: Date, timeZone: string): string {
  return at.toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" });
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

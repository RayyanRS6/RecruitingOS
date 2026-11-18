import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { SCREEN_ACTIVE_STATUSES, SCREEN_LINK_OPEN_DAYS, SCREEN_REMINDER_AFTER_HOURS, appPaths, type Actor, type ScreenAssessment } from "@ros/contracts";
import { outOfCredit, type RunOutcome } from "@ros/ai";
import { emit, notify, remindedRecently } from "@ros/core";
import { applications, assessments, candidates, companies, rolePackets, roles, screens, workflowRuns, type Tx } from "@ros/db";
import { assessScreen, createScreen, screenPacketVersion, screenSignalKey, sendScreenExpiredNote, sendScreenInvite, sendScreenReminder, type ScreenRow } from "@ros/agents";
import { twoPhase, type StepResult, type WorkflowDefinition } from "../types";
import type { WorkflowEngine } from "../engine";
import { waitForCredit } from "../credit-wait";

/** `screenId`: the interview this run made. `creditWaitSince`: when its scorecard started waiting for the company's AI help. */
type State = { applicationId: string; roleId: string; screenId?: string; creditWaitSince?: string };

export const SCREEN_WORKFLOW_KEY = "screen";
const HOUR = 3_600_000;

/**
 * One AI interview, from the moment a person on the team shortlists someone (or sends a new link):
 *
 * invite (the interview is made and its link emailed; open five days) → remind (one reminder after 48 hours, if the
 * answers were not sent) → close (at five days the link closes, with one short note to the candidate) and, whenever the
 * candidate presses "Send my answers": sent (the team is told, once) → score (the scorecard is written and stored).
 *
 * The interview follows the job as it is when the interview is made: `invite` stores the job's current version on the
 * interview's row, and the chat, the emails about it and the scorecard read that version to the end, whatever is edited
 * later. A new link is a new interview, made with the job as it is then.
 *
 * The chat itself is not here: its turns run when the candidate writes (packages/agents, `runScreenTurn`), and sending
 * the answers moves the application to Interviewed at that press. The run wakes on the interview's signal
 * (`screenSignalKey`: sent, or the candidate chose not to do it) and reads the interview's row to see which; cancelling
 * the interview, hiring, marking Not selected, withdrawing and closing the job cancel the run of an interview still
 * open. Nothing here declines or hires anyone.
 */
export const screen: WorkflowDefinition<State> = {
  key: SCREEN_WORKFLOW_KEY,
  version: 2,
  initialStep: "invite",
  maxAttempts: 4,
  steps: {
    async invite(ctx) {
      // The job's row is held to the end of this step, so the version read here is the live one when the interview is stored.
      const [live] = await ctx.q.select({ version: roles.currentPacketVersion, status: roles.status }).from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1).for("update");
      const made = await load(ctx.q, ctx.state.applicationId, live?.version ?? null);
      if (!made) return { kind: "fail", error: "application not found", retryable: false };
      // Cancelled, decided or withdrawn before the run got here, or the job closed: no interview is made.
      if ((made.app.stage !== "screen_invited" && made.app.stage !== "screening") || live?.status === "closed") return { kind: "complete" };
      const scr = await createScreen(ctx.q, { companyId: ctx.companyId, applicationId: made.app.id, packetVersion: made.version, workflowRunId: ctx.run.id, expiresAt: new Date(ctx.now.getTime() + SCREEN_LINK_OPEN_DAYS * 24 * HOUR).toISOString(), now: ctx.now });
      // An interview already open is returned as it is: its invitation speaks of the version it was made with.
      const b = scr.packetVersion === made.version ? made : await load(ctx.q, made.app.id, screenPacketVersion(scr, made.app));
      if (!b) return { kind: "fail", error: "application not found", retryable: false };
      const { app, candidate, role, company, packet } = b;
      await sendScreenInvite(ctx.q, ctx.services.integrations, { application: app, candidate, role, company, packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token } });
      await emit(ctx.q, { type: "screen.invited", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: app.id }, correlationId: ctx.run.id });
      return waitFor(scr, reminderDue(scr), "remind", { screenId: scr.id });
    },

    /** 48 hours after the link went: one reminder, unless a person sent one in the last day. Then the wait for the link to close. */
    async remind(ctx) {
      const scr = await interviewOf(ctx);
      if (!scr) return { kind: "fail", error: "the AI interview is missing", retryable: false };
      const over = whenOver(scr);
      if (over) return over;
      // Woken early by a signal that changed nothing: back to waiting.
      if (ctx.now.getTime() < reminderDue(scr).getTime()) return waitFor(scr, reminderDue(scr), "remind");
      if (!remindedRecently(scr, ctx.now)) {
        const b = await load(ctx.q, scr.applicationId, scr.packetVersion);
        if (!b) return { kind: "fail", error: "application not found", retryable: false };
        await sendScreenReminder(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, appBaseUrl: ctx.services.env.jobsBaseUrl, screen: { id: scr.id, token: scr.token } });
        await ctx.q.update(screens).set({ remindedAt: ctx.now.toISOString(), ...(scr.status === "invited" ? { status: "reminded" } : {}) }).where(eq(screens.id, scr.id));
        await emit(ctx.q, { type: "screen.reminded", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: scr.applicationId }, correlationId: ctx.run.id });
      }
      return waitFor(scr, closesAt(scr), "close");
    },

    /** Five days after the link went, with the answers not sent: the link closes, started or not, and the candidate gets one short note. The team can send a new link. */
    async close(ctx) {
      const scr = await interviewOf(ctx);
      if (!scr) return { kind: "fail", error: "the AI interview is missing", retryable: false };
      const over = whenOver(scr);
      if (over) return over;
      if (ctx.now.getTime() < closesAt(scr).getTime()) return waitFor(scr, closesAt(scr), "close");
      const b = await load(ctx.q, scr.applicationId, scr.packetVersion);
      if (!b) return { kind: "fail", error: "application not found", retryable: false };
      await ctx.q.update(screens).set({ status: "expired", completedAt: ctx.now.toISOString() }).where(eq(screens.id, scr.id));
      await emit(ctx.q, { type: "screen.expired", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: scr.applicationId, started: !!scr.startedAt }, correlationId: ctx.run.id });
      await sendScreenExpiredNote(ctx.q, ctx.services.integrations, { application: b.app, candidate: b.candidate, role: b.role, company: b.company, packet: b.packet, actor: ctx.actor, correlationId: ctx.run.id, screen: { id: scr.id } });
      return { kind: "complete" };
    },

    /** The candidate pressed "Send my answers": the team is told once, here, whatever becomes of the scorecard. */
    async sent(ctx) {
      const scr = await interviewOf(ctx);
      const b = scr ? await load(ctx.q, scr.applicationId, scr.packetVersion) : null;
      if (!scr || !b) return { kind: "fail", error: "the AI interview is missing", retryable: false };
      const name = `${b.candidate.firstName} ${b.candidate.lastName}`.trim();
      await notify(ctx.q, { companyId: ctx.companyId, about: b.app.id, kind: "screen.completed", title: `${name} finished the AI interview`, body: `They sent their answers for ${b.packet.identity.title}. Their answers are on their page, and the interview score follows.`, action: { label: "Open the candidate", href: appPaths.candidate(b.role.id, b.app.id) } });
      return { kind: "next", step: "score" };
    },

    /**
     * The scorecard of the interview the candidate sent: one finding for each question asked, stored as the application's
     * newest reading of kind `screen`, with the job version the interview asked about. The interview score is worked out
     * from it wherever it is shown. With no AI help left the run waits and the interview says so
     * (`scoreWaitsForCredit`): the answers are there for the team to read.
     *
     * An interview the candidate sent is always scored, whatever became of the person since: marked Not selected, hired
     * or withdrawn while the scorecard waited, they still get it. A decision can be taken back with Undo, and their sent
     * interview must then have its score. (The resume reading is different: it skips someone who left the process.)
     */
    score: twoPhase<State, { screenId: string; out: RunOutcome<ScreenAssessment> } | null>({
      async prepare(ctx) {
        const pending = await ctx.read(async (q) => {
          const scr = await interviewOf({ q, state: ctx.state });
          return scr && !scr.assessmentId && scr.status === "completed" ? scr.id : null;
        });
        if (!pending) return null;
        return { screenId: pending, out: await assessScreen(ctx.db, ctx.services.ai, { companyId: ctx.companyId, screenId: pending, workflowRunId: ctx.run.id }) };
      },
      async run(ctx, prepared) {
        const scr = await interviewOf(ctx);
        if (!scr) return { kind: "fail", error: "the AI interview is missing", retryable: false };
        if (scr.assessmentId || scr.status !== "completed") return { kind: "complete" };
        if (prepared?.screenId !== scr.id) return { kind: "fail", error: "the AI interview changed after the read phase; scoring it again", retryable: true };
        const out = prepared.out;
        const { scoreWaitsForCredit: waiting, ...progress } = scr.progress;
        if (outOfCredit(out)) {
          // Refused only for money held by calls still running, nothing is used up: no mark, so the team reads "being scored".
          const { roomSoon, wait } = await waitForCredit(ctx, "score", out.refusedHoldUsd, { creditWaitSince: ctx.state.creditWaitSince ?? ctx.now.toISOString() });
          if (!roomSoon && !waiting) await ctx.q.update(screens).set({ progress: { ...scr.progress, scoreWaitsForCredit: ctx.now.toISOString() } }).where(eq(screens.id, scr.id));
          if (roomSoon && waiting) await ctx.q.update(screens).set({ progress }).where(eq(screens.id, scr.id));
          return wait;
        }
        if (!out.ok) {
          if (out.reason === "error") return { kind: "fail", error: out.error, retryable: true };
          return { kind: "fail", error: `the scorecard could not be written: ${out.error}`, retryable: false };
        }
        const [app] = await ctx.q.select({ packetVersion: applications.packetVersion }).from(applications).where(eq(applications.id, scr.applicationId)).limit(1);
        const [row] = await ctx.q.insert(assessments).values({ companyId: ctx.companyId, applicationId: scr.applicationId, kind: "screen", packetVersion: screenPacketVersion(scr, app), aiRunId: out.runId, result: out.output }).returning({ id: assessments.id });
        await ctx.q.update(screens).set({ assessmentId: row.id, progress }).where(eq(screens.id, scr.id));
        await emit(ctx.q, { type: "screen.assessed", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "screen", id: scr.id }, payload: { assessmentId: row.id }, correlationId: ctx.run.id });
        await emit(ctx.q, { type: "assessment.created", companyId: ctx.companyId, actor: { kind: "agent", id: "screening", runId: out.runId }, subject: { type: "application", id: scr.applicationId }, payload: { kind: "screen", assessmentId: row.id }, correlationId: ctx.run.id });
        return { kind: "complete" };
      },
    }),
  },
};

/** When the one reminder is due, and when the link closes. */
const reminderDue = (scr: Pick<ScreenRow, "invitedAt" | "createdAt">): Date => new Date(Date.parse(scr.invitedAt ?? scr.createdAt) + SCREEN_REMINDER_AFTER_HOURS * HOUR);
const closesAt = (scr: Pick<ScreenRow, "invitedAt" | "createdAt" | "expiresAt">): Date => new Date(scr.expiresAt ?? Date.parse(scr.invitedAt ?? scr.createdAt) + SCREEN_LINK_OPEN_DAYS * 24 * HOUR);

/** Waits until `until`, or until the interview's signal says something changed, then goes on at `step`. */
function waitFor(scr: Pick<ScreenRow, "id">, until: Date, step: "remind" | "close", state?: Partial<State>): StepResult<State> {
  return { kind: "wait", wait: { kind: "event", eventTypes: [screenSignalKey(scr.id)], until: until.toISOString(), reason: step === "remind" ? "the AI interview's link is out: one reminder goes after 48 hours" : "the AI interview's link closes five days after it went" }, ...(state ? { state } : {}), resumeStep: step };
}

/** Where the run goes once the interview is no longer open: on to the scorecard when the answers were sent, otherwise it is over. Null while it is open. */
function whenOver(scr: Pick<ScreenRow, "status">): StepResult<State> | null {
  if (scr.status === "completed") return { kind: "next", step: "sent" };
  return (SCREEN_ACTIVE_STATUSES as readonly string[]).includes(scr.status) ? null : { kind: "complete" };
}

async function interviewOf(ctx: { q: Tx; state: Pick<State, "screenId"> }): Promise<ScreenRow | null> {
  if (!ctx.state.screenId) return null;
  const [scr] = await ctx.q.select().from(screens).where(eq(screens.id, ctx.state.screenId)).limit(1);
  return scr ?? null;
}

/**
 * What a step reads about an application and its interview. `version`: the job version the interview asks about (the
 * job's current one when the interview is being made, the interview's own afterwards); without one, the version the
 * person applied to.
 */
async function load(q: Tx, applicationId: string, version: number | null) {
  const [app] = await q.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!app) return null;
  const [candidate] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await q.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await q.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await q.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, version ?? app.packetVersion))).limit(1);
  if (!candidate || !role || !company || !pv) return null;
  return { app, candidate, role, company, packet: pv.packet, version: pv.version };
}

const ENDED_RUN = ["completed", "failed", "cancelled"];

/**
 * Starts the run of a new AI interview for an application: the first one when a person shortlists them, another when a
 * person sends a new link. One run per interview: the key counts the interviews the application has had, so two presses
 * at the same moment start one run.
 */
export async function startAiInterview(q: Tx, engine: Pick<WorkflowEngine, "start">, input: { companyId: string; applicationId: string; roleId: string; actor: Actor }): Promise<{ runId: string; created: boolean }> {
  const had = await q.select({ id: screens.id }).from(screens).where(eq(screens.applicationId, input.applicationId));
  return engine.start(q, { workflowKey: SCREEN_WORKFLOW_KEY, companyId: input.companyId, subject: { type: "application", id: input.applicationId }, state: { applicationId: input.applicationId, roleId: input.roleId }, idempotencyKey: `${SCREEN_WORKFLOW_KEY}:${input.applicationId}:${had.length + 1}`, actor: input.actor });
}

/**
 * Closes whatever AI interview an application still has open, and ends its run: the interview becomes `cancelled`, so
 * the team reads the person as if none had been sent. One the candidate already sent stays as it is, with its score, and
 * so does its run, which may still be writing the scorecard. Called when a person cancels the interview, hires or marks
 * Not selected, when the candidate withdraws, and when the job closes. Returns how many interviews it closed.
 */
export async function cancelAiInterview(q: Tx, engine: Pick<WorkflowEngine, "cancel">, input: { applicationId: string; actor: Actor; reason: string; now: Date }): Promise<number> {
  const open = await q.update(screens).set({ status: "cancelled", completedAt: input.now.toISOString() }).where(and(eq(screens.applicationId, input.applicationId), inArray(screens.status, [...SCREEN_ACTIVE_STATUSES]))).returning({ id: screens.id, companyId: screens.companyId });
  for (const scr of open) await emit(q, { type: "screen.cancelled", companyId: scr.companyId, actor: input.actor, subject: { type: "screen", id: scr.id }, payload: { applicationId: input.applicationId, reason: input.reason } });
  // A run that made no interview yet (shortlisted a moment ago), and the run of each one closed here: neither has anything left to do.
  const sentIds = (await q.select({ runId: screens.workflowRunId }).from(screens).where(and(eq(screens.applicationId, input.applicationId), eq(screens.status, "completed")))).map((s) => s.runId).filter((id): id is string => !!id);
  const runs = await q.select({ id: workflowRuns.id }).from(workflowRuns).where(and(eq(workflowRuns.workflowKey, SCREEN_WORKFLOW_KEY), notInArray(workflowRuns.status, ENDED_RUN), sql`${workflowRuns.subject}->>'id' = ${input.applicationId}`));
  for (const run of runs) if (!sentIds.includes(run.id)) await engine.cancel(q, run.id, input.actor, input.reason);
  return open.length;
}

/**
 * A job that closes takes no more applications, so no AI interview link of it may still work. Every interview of the job
 * that is still open (not yet sent) is closed the way `cancelAiInterview` closes one: the candidate reads that the
 * interview is closed, its run ends, and nobody is emailed. The run of someone shortlisted a moment ago, whose
 * interview was not made yet, ends too, and makes none. Nobody's place in the process changes: a close moves nobody.
 * An interview the candidate already sent keeps its answers and its score, and one whose link had closed by itself, or
 * that the candidate chose not to do, stays as it is. Pausing a job closes nothing. Returns how many interviews it closed.
 */
export async function closeAiInterviewsOfJob(q: Tx, engine: Pick<WorkflowEngine, "cancel">, input: { roleId: string; actor: Actor; now: Date }): Promise<number> {
  // The applications are held first, in one order, so a close and a person's action on one of them take turns.
  const shortlisted = await q.select({ id: applications.id }).from(applications).where(and(eq(applications.roleId, input.roleId), inArray(applications.stage, ["screen_invited", "screening"]))).orderBy(asc(applications.id)).for("update");
  let closed = 0;
  for (const app of shortlisted) closed += await cancelAiInterview(q, engine, { applicationId: app.id, actor: input.actor, reason: "the job closed", now: input.now });
  return closed;
}

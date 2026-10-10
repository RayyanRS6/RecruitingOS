import { and, eq, inArray, sql } from "drizzle-orm";
import type { Actor, AutoNewTimesReason } from "@ros/contracts";
import { notifyNewTimesNotSent, recordAutoRun, roleTakenOver, setAutoState, type FollowUpRow } from "@ros/core";
import { companyConfirmed } from "@ros/agents";
import { applications, candidates, interviewFollowups, interviews, roles, workflowRuns, type Queryable } from "@ros/db";
import type { WorkflowEngine } from "../engine";
import { activeInterviewersOf, newTimesStoppedByTakeover, reopenForNewTimes, type ReopenRefusal } from "../new-times-reopen";
import type { StepContext, StepResult, WorkflowDefinition } from "../types";

type State = { followUpId: string; applicationId: string; roleId: string; interviewId: string };

export const NEW_TIMES_KEY = "interview_new_times";

const DAYS = 86_400_000;
/** How long a set that fell due waits for ITS to confirm the company again before the team is told it did not go. */
const COMPANY_CHECK_WAIT_DAYS = 10;
/** Where an application has left the process: nothing more goes to them. */
const LEFT_PROCESS = ["hired", "withdrawn", "rejected", "declined", "talent_pool"];
/** Interviews with times being worked out, offered or booked: the team (or the candidate) already has one in hand. */
const OPEN_INTERVIEW = ["proposed", "scheduling", "scheduled"];

/** Still promised: waiting for its day, or for the ITS check. Anything else (resolved, stopped, sent) ends the run quietly. */
function stillPromised(f: FollowUpRow | undefined): f is FollowUpRow & { autoDueAt: string } {
  if (!f || f.resolvedAt || !f.autoDueAt) return false;
  return f.autoState === "waiting" || f.autoState === "waiting_check";
}

/** What a refused reopen means for the set: a person got there first, or the interview changed under it. */
const REOPEN_REASON: Record<ReopenRefusal, AutoNewTimesReason> = { times_out: "team_acted", team_acted: "team_acted", interview_changed: "interview_changed", not_reopenable: "interview_changed", no_interviewers: "no_interviewers" };
/** The reasons the team must hear about (they may need to act); the others say a person already did, or that the person left. */
const TELL_TEAM: ReadonlySet<AutoNewTimesReason> = new Set(["no_email", "interview_changed", "takeover", "no_interviewers", "company_not_checked"]);

/**
 * The one automatic set of new times (founder decisions 2A and 3A, 9 October 2026), for a candidate who cancelled a
 * booked interview and asked for them. A timer per person, kept in the jobs table so it survives restarts, due at the
 * stored moment the candidate was told (never recomputed). When it is due everything is checked again: a timer alone
 * never sends anything. If they are still under Cancelled with nothing else in motion, the interview a person already
 * approved is reopened for new times (`reopenForNewTimes`): it never creates one. The set is `preparing` until
 * `schedule_interview` has times to offer and queues the email; only then is it `sent` (`newTimesOffered`).
 *
 * Runs are cancelled only when a person stops or replaces the set (`cancelNewTimesRuns`). Leaving the process does not
 * cancel the run, so a private decision taken back before the day can restore the set; a run that wakes for someone no
 * longer under Cancelled completes and writes nothing.
 */
export const interviewNewTimes: WorkflowDefinition<State> = {
  key: NEW_TIMES_KEY,
  version: 1,
  initialStep: "wait",
  maxAttempts: 5,
  escalationKind: "candidate_issue",
  steps: {
    async wait(ctx) {
      const [f] = await ctx.q.select().from(interviewFollowups).where(eq(interviewFollowups.id, ctx.state.followUpId)).limit(1);
      if (!stillPromised(f)) return { kind: "complete" };
      const due = new Date(f.autoDueAt);
      if (ctx.now.getTime() < due.getTime()) return { kind: "wait", wait: { kind: "timer", until: due.toISOString(), reason: "new times go out on the day the candidate was told" }, resumeStep: "wait" };
      return { kind: "next", step: "send" };
    },

    async send(ctx) {
      // The same two locks, in the same order, as a person's "Send new times" and "Approve an interview": an automatic send
      // and a person's never both pass their checks. The second waits, then finds an interview open or the set moved on.
      const [app] = await ctx.q.select().from(applications).where(eq(applications.id, ctx.state.applicationId)).limit(1).for("update");
      const [f] = await ctx.q.select().from(interviewFollowups).where(eq(interviewFollowups.id, ctx.state.followUpId)).limit(1).for("update");
      if (!app || !stillPromised(f)) return { kind: "complete" };
      const notSent = (reason: AutoNewTimesReason) => endNotSent(ctx, f, reason);

      const [role] = await ctx.q.select({ status: roles.status }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
      if (LEFT_PROCESS.includes(app.stage) || role?.status === "closed" || role?.status === "filled") return notSent("left_process");
      const [candidate] = await ctx.q.select({ email: candidates.email, anonymizedAt: candidates.anonymizedAt }).from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      if (candidate?.anonymizedAt) return notSent("details_deleted");
      if (!candidate?.email) return notSent("no_email");
      const [iv] = await ctx.q.select({ status: interviews.status, attempt: interviews.attempt }).from(interviews).where(eq(interviews.id, f.interviewId)).limit(1);
      if (!iv || iv.status !== "cancelled" || iv.attempt !== f.interviewAttempt) return notSent("interview_changed");
      const [open] = await ctx.q.select({ id: interviews.id }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, OPEN_INTERVIEW))).limit(1);
      if (open) return notSent("team_acted");
      if (await roleTakenOver(ctx.q, ctx.companyId, app.roleId)) return notSent("takeover");
      if (!(await activeInterviewersOf(ctx.q, ctx.companyId, f.interviewId)).length) return notSent("no_interviewers");
      // The setting is not read again: switching automatic times off asks what happens to people already told a day, and
      // "stop" ends their sets at that moment (apps/api company-settings.ts). A set still waiting here is one the owner kept.

      // ITS took back its confirmation of the company after this was armed (founder decision B7): every email to its
      // candidates waits, so the interview is not reopened until ITS confirms it again; a held times email would let the
      // offer run out unseen. The clock decides when to give up, never the kind of wake (a retry wakes on a timer too).
      if (!(await companyConfirmed(ctx.q, ctx.companyId))) {
        const giveUp = new Date(new Date(f.autoDueAt).getTime() + COMPANY_CHECK_WAIT_DAYS * DAYS);
        if (ctx.now.getTime() >= giveUp.getTime()) return notSent("company_not_checked");
        if (f.autoState === "waiting") await setAutoState(ctx.q, { followUpId: f.id, to: "waiting_check", actor: ctx.actor, now: ctx.now });
        return { kind: "wait", wait: { kind: "event", eventTypes: ["company.verified"], subjectId: ctx.companyId, until: giveUp.toISOString(), reason: "waiting for ITS to confirm the company" }, resumeStep: "send" };
      }

      const reopened = await reopenForNewTimes(ctx.q, ctx.services.engine, { followUp: f, actor: ctx.actor, via: "auto", offerKind: "new_times_asked", now: ctx.now });
      if (!reopened.ok) return notSent(REOPEN_REASON[reopened.reason]);
      // Being prepared: the one-set index now counts it. It becomes "sent" when `schedule_interview` queues the email.
      await setAutoState(ctx.q, { followUpId: f.id, to: "preparing", actor: ctx.actor, now: ctx.now });
      return { kind: "complete" };
    },
  },
};

/**
 * The set does not go: recorded with its reason, and the team told when they may need to act. Under an ITS takeover the
 * recruiter running the role is brought in too, to arrange the time with the candidate (founder question 7).
 */
async function endNotSent(ctx: StepContext<State>, f: FollowUpRow, reason: AutoNewTimesReason): Promise<StepResult<State>> {
  const row = await setAutoState(ctx.q, { followUpId: f.id, to: "not_sent", reason, actor: ctx.actor, now: ctx.now });
  if (reason === "takeover") await newTimesStoppedByTakeover(ctx.q, { followUp: row, actor: ctx.actor, now: ctx.now, workflowRunId: ctx.run.id });
  else if (TELL_TEAM.has(reason)) await notifyNewTimesNotSent(ctx.q, { followUp: row, reason });
  return { kind: "complete" };
}

/**
 * Arms the automatic set for someone who just went under Cancelled asking for new times: a timer run per follow-up (one
 * ever, by its key), recorded on the row. Call inside the caller's tenant transaction, after `openFollowUp` wrote the row
 * as `waiting` with its due moment.
 */
export async function armNewTimes(q: Queryable, engine: WorkflowEngine, input: { companyId: string; followUpId: string; applicationId: string; roleId: string; interviewId: string; actor: Actor }): Promise<string> {
  const state: State = { followUpId: input.followUpId, applicationId: input.applicationId, roleId: input.roleId, interviewId: input.interviewId };
  const { runId } = await engine.start(q, { workflowKey: NEW_TIMES_KEY, companyId: input.companyId, subject: { type: "application", id: input.applicationId }, state, idempotencyKey: `new_times:${input.followUpId}`, actor: input.actor });
  await recordAutoRun(q, { followUpId: input.followUpId, runId });
  return runId;
}

/**
 * Cancels the automatic set's timer for an application, when a person stops or replaces it (stop, a team send, "Next
 * round", a reply asking for a person or saying no, switching it off with "stop"). The caller moves the set itself
 * (`setAutoState`). A stale timer job is ignored by the engine. Returns how many runs were cancelled.
 */
export async function cancelNewTimesRuns(q: Queryable, engine: WorkflowEngine, input: { companyId: string; applicationId: string; actor: Actor; reason: string }): Promise<number> {
  const live = await q
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.workflowKey, NEW_TIMES_KEY), inArray(workflowRuns.status, ["running", "waiting"]), sql`${workflowRuns.subject}->>'id' = ${input.applicationId}`));
  for (const r of live) await engine.cancel(q, r.id, input.actor, input.reason);
  return live.length;
}

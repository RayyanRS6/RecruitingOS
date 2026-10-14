import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { SYSTEM_ACTOR, createEscalation, emit, raiseAlert, raiseAlertOnce, resolveAlertsOfKind } from "@ros/core";
import { jobs, randomToken, rowsOf, workflowRuns, workflowSteps, withTenant, type Queryable, type Tx, type WaitCondition } from "@ros/db";
import type { EngineDeps, EngineOptions, PrepareContext, RunRow, StartInput, StepContext, StepResult, WakePayload, WorkflowDefinition } from "./types";

/**
 * A durable, Postgres-backed workflow engine (docs/06).
 *
 * - A run is a row; every step execution is a ledger row; the queue is the `jobs` table.
 * - Steps run inside a tenant transaction; if the process dies mid-step the transaction rolls back and the
 *   job lease expires, so the step re-executes. Steps are written to be idempotent.
 * - A step with slow external work (a model call) declares a `prepare` phase that runs before its transaction opens,
 *   so no connection or lock is held while a provider is thinking; messages leave through the outbox after commit.
 * - `wait` suspends the run on a human decision, an event, or a timer; `signal` wakes event and human waits;
 *   timers are jobs with a future `run_at`.
 * - Failures retry with exponential backoff; after `maxAttempts` the run fails, emits `workflow.failed`, and
 *   creates a recruiter escalation for the role or candidate involved (an alert for ITS administrators when the run
 *   names neither) so nothing dies silently.
 * - An AI provider that is not answering is not a reason to give up (Wave S5 C2): such a failure is retried with
 *   growing waits for at least `PROVIDER_OUTAGE_PATIENCE_MS`, then the run is held (not failed, no escalation), one
 *   alert tells ITS, and a check every `AI_HOLD_CHECK_EVERY_MS` tries one held run; when it goes through, every held
 *   run resumes by itself.
 * - A job claimed by a worker keeps its lease while it runs (renewed every third of the lease), so a slow model step
 *   is never picked up and repeated by a second worker.
 */
export type JobHandler = (payload: Record<string, unknown>, ctx: { attempt: number; maxAttempts: number; now: Date }) => Promise<void>;

/** How long a run keeps retrying while the AI provider is not answering, before it is held instead. */
export const PROVIDER_OUTAGE_PATIENCE_MS = 60 * 60_000;
/** The key a held run waits on (`wait.keys`); `signal` with it, or the hold check, wakes the run. */
export const AI_HOLD_KEY = "ai.provider_available";
/** The job that tries one held run and, when the provider answers, resumes all of them. Re-armed while runs are held. */
export const AI_HOLD_CHECK_JOB_KIND = "workflow.ai_hold_check";
export const AI_HOLD_CHECK_EVERY_MS = 15 * 60_000;
/** The one alert a provider outage raises (not one escalation per application). */
export const AI_OUTAGE_ALERT_KIND = "ai.provider_outage";
/** How far apart held runs go again once the provider answers (each a few seconds after the one before). */
export const HELD_RELEASE_SPACING_MS = 3000;

/** The wait before a run's next try after its `attempts`-th failure: 2 s, 4 s, 8 s ... up to 10 minutes. */
export function retryDelayMs(attempts: number): number {
  return Math.min(10 * 60_000, 2000 * 2 ** (Math.max(1, attempts) - 1));
}

/** How many tries a run gets while the provider is out: enough that the waits between them add up to the patience. */
export function outageAttempts(patienceMs = PROVIDER_OUTAGE_PATIENCE_MS): number {
  let waited = 0;
  let attempts = 1;
  while (waited < patienceMs) {
    waited += retryDelayMs(attempts);
    attempts += 1;
  }
  return attempts;
}

/** Words a provider error carries when the provider did not answer: no connection, a timeout, an overload. */
const UNAVAILABLE_WORDS = /connection|timed? ?out|timeout|did not finish|overloaded|outage|unavailable|bad gateway|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|network|terminated|aborted/i;

/**
 * What kind of provider trouble a step's error is, from the runner's "provider ..." error:
 * - "outage": the provider did not answer (a 5xx or 529, a 408, 409 or 429, no connection, a timeout);
 * - "account": a problem with the whole account that waiting alone will not fix but that hits every application the same
 *   way (a 401 or 403, "credit balance is too low"): held like an outage, with an alert saying to check the key or billing;
 * - null: anything else, such as a request the provider refused as malformed, or a local error the Anthropic adapter
 *   wraps as "provider error: <message>" (a TypeError, a schema conversion): that fails like any other error, so a
 *   fixed bug is not retried for an hour and held under an alert that says the provider is down.
 * "provider threw" (a provider that threw instead of answering) counts as an outage unless it names a 4xx.
 */
export function providerProblem(error: string): "outage" | "account" | null {
  const m = /^provider (error|threw|unavailable|account): (.*)$/s.exec(error.trim());
  if (!m) return null;
  const kind = m[1];
  const rest = m[2] ?? "";
  if (kind === "account") return "account";
  if (kind === "unavailable") return "outage";
  const status = /^(\d{3})\b/.exec(rest)?.[1];
  if (status === "401" || status === "403" || /credit balance/i.test(rest)) return "account";
  if (status) return status.startsWith("4") && !["408", "409", "429"].includes(status) ? null : "outage";
  if (kind === "threw") return "outage";
  return UNAVAILABLE_WORDS.test(rest) ? "outage" : null;
}

/** Whether a step's error is provider trouble that holds work instead of failing it (`providerProblem`). */
export function isProviderOutage(error: string): boolean {
  return providerProblem(error) !== null;
}

/** The longest a queued job waits between tries: long enough that a job given enough tries outlasts an hour's outage. */
export const JOB_RETRY_CAP_MS = 15 * 60_000;
/** The wait before a queued job's next try after its `attempts`-th failure: 2 s, 4 s, 8 s ... up to 15 minutes. */
export function jobRetryDelayMs(attempts: number): number {
  return Math.min(JOB_RETRY_CAP_MS, 1000 * 2 ** Math.max(1, attempts));
}

type HeldWait = WaitCondition & { keys: string[]; heldAt: string };
type HeldRun = { id: string; companyId: string | null; token: string | null };

/** The wake a held run gets when it goes again: its hold's own timer token, as a retry's timer carries. */
function heldWake(run: HeldRun): WakePayload {
  return run.token ? { kind: "timer", key: run.token } : { kind: "timer" };
}

const STOPPED_WORK: Record<string, string> = {
  application_intake: "Processing this application",
  screen: "The screening chat",
  schedule_interview: "Scheduling this interview",
  role_approval: "Approving this role",
  publish_role: "Publishing this role",
};

/**
 * The request a stopped run raises, in plain words: the customer reads it under their recruiter requests. The error
 * itself stays with the run (`last_error`, the `workflow.failed` event) for ITS, never in front of the customer.
 */
export function stoppedRunQuestion(workflowKey: string, attempts: number): string {
  const tries = attempts === 1 ? "the first try" : `${attempts} tries`;
  return `${STOPPED_WORK[workflowKey] ?? "An automatic step"} stopped after ${tries} and needs a person to take over.`;
}

export class WorkflowEngine {
  private defs = new Map<string, WorkflowDefinition>();
  private workerId: string;
  private now: () => Date;
  private maxInlineSteps: number;
  private leaseMs: number;

  constructor(private deps: EngineDeps, opts: EngineOptions = {}) {
    this.workerId = opts.workerId ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    this.now = opts.now ?? (() => new Date());
    this.maxInlineSteps = opts.maxInlineSteps ?? 25;
    this.leaseMs = opts.leaseMs ?? 5 * 60_000;
    // The engine's own job: runs held while the AI provider was out are tried again here (see `checkHeldRuns`).
    // A check that falls over is armed again for later rather than retried to exhaustion: held runs are never left
    // without one.
    this.jobHandlers.set(AI_HOLD_CHECK_JOB_KIND, async () => {
      try {
        await this.checkHeldRuns();
      } catch (err) {
        console.error(`[queue] the AI hold check failed; it runs again in ${Math.round(AI_HOLD_CHECK_EVERY_MS / 60_000)} minutes: ${err instanceof Error ? err.message : String(err)}`);
        await this.ensureQueued(this.deps.db, { kind: AI_HOLD_CHECK_JOB_KIND, runAt: new Date(this.now().getTime() + AI_HOLD_CHECK_EVERY_MS) });
      }
    });
  }

  register<S extends Record<string, unknown>>(def: WorkflowDefinition<S>): void {
    this.defs.set(def.key, def as unknown as WorkflowDefinition);
  }

  definitions(): string[] {
    return [...this.defs.keys()];
  }

  /** The identity this engine claims jobs with (`jobs.locked_by`); the worker writes its heartbeat under the same id. */
  identity(): string {
    return this.workerId;
  }

  /** Starts a run. Call inside the caller's tenant transaction so the run and its trigger commit together. */
  async start(q: Queryable, input: StartInput): Promise<{ runId: string; created: boolean }> {
    const def = this.defs.get(input.workflowKey);
    if (!def) throw new Error(`unknown workflow ${input.workflowKey}`);
    if (input.idempotencyKey) {
      const existing = await q.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing[0]) return { runId: existing[0].id, created: false };
    }
    const [run] = await q
      .insert(workflowRuns)
      .values({
        companyId: input.companyId,
        workflowKey: def.key,
        workflowVersion: def.version,
        subject: input.subject,
        status: "running",
        currentStep: def.initialStep,
        state: input.state ?? {},
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    await q.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id }, runAt: this.now().toISOString() });
    await emit(q, {
      type: "workflow.started",
      companyId: input.companyId,
      actor: input.actor ?? SYSTEM_ACTOR,
      subject: { type: "workflow_run", id: run.id },
      payload: { workflowKey: def.key, subject: input.subject },
      correlationId: run.id,
    });
    return { runId: run.id, created: true };
  }

  /** Wakes runs waiting on an event or human decision key (e.g. `approval:<id>`, `application:<id>:message.received`). */
  async signal(q: Queryable, input: { companyId: string; key: string; payload?: Record<string, unknown> }): Promise<number> {
    const waiting = await q
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(and(eq(workflowRuns.companyId, input.companyId), eq(workflowRuns.status, "waiting"), sql`${workflowRuns.wait}->'keys' ? ${input.key}`));
    for (const w of waiting) {
      await q.insert(jobs).values({ kind: "workflow.tick", payload: { runId: w.id, wake: { kind: "event", key: input.key, payload: input.payload ?? {} } }, runAt: this.now().toISOString() });
    }
    return waiting.length;
  }

  private jobHandlers = new Map<string, JobHandler>();
  /** The engine's clock (tests move it); routes that enqueue jobs use it so a job is due on the same clock that runs it. */
  clock(): Date {
    return this.now();
  }

  /** Registers a handler for a queued job kind other than workflow ticks (for example credential revocation). */
  registerJob(kind: string, handler: JobHandler): void {
    this.jobHandlers.set(kind, handler);
  }

  /** Queues a job for a registered handler. Call inside the caller's transaction so the job commits with its cause. */
  async enqueue(q: Queryable, input: { kind: string; payload?: Record<string, unknown>; runAt?: Date; maxAttempts?: number }): Promise<void> {
    if (input.kind !== "workflow.tick" && !this.jobHandlers.has(input.kind)) throw new Error(`no handler registered for job kind ${input.kind}`);
    await q.insert(jobs).values({ kind: input.kind, payload: input.payload ?? {}, runAt: (input.runAt ?? this.now()).toISOString(), maxAttempts: input.maxAttempts ?? 5 });
  }

  /**
   * Queues a job of this kind unless one is already waiting (queued and not being run). This is how a recurring job is
   * seeded at boot by any process and re-armed by its own run: the run that is arming the next one is locked, so it does
   * not count, and two processes booting together leave one chain, not two.
   */
  async ensureQueued(q: Queryable, input: { kind: string; runAt?: Date; maxAttempts?: number }): Promise<boolean> {
    if (!this.jobHandlers.has(input.kind)) throw new Error(`no handler registered for job kind ${input.kind}`);
    const [waiting] = await q.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, input.kind), eq(jobs.status, "queued"), isNull(jobs.lockedAt))).limit(1);
    if (waiting) return false;
    await q.insert(jobs).values({ kind: input.kind, payload: {}, runAt: (input.runAt ?? this.now()).toISOString(), maxAttempts: input.maxAttempts ?? 3 });
    return true;
  }

  /** Claims due jobs with SKIP LOCKED semantics and processes them. Returns the number processed. */
  async runPending(limit = 10): Promise<number> {
    const nowIso = this.now().toISOString();
    const staleIso = new Date(this.now().getTime() - this.leaseMs).toISOString();
    const claimed = (await this.deps.db.execute(sql`
      UPDATE jobs SET locked_at = ${nowIso}, locked_by = ${this.workerId}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
        WHERE status = 'queued' AND run_at <= ${nowIso} AND (locked_at IS NULL OR locked_at < ${staleIso})
        ORDER BY run_at ASC LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, kind, payload, attempts, max_attempts
    `));
    const rows = rowsOf<Record<string, unknown>>(claimed);
    // Every claimed job keeps its lease from the moment it is claimed, not only from its turn: a batch of slow model steps
    // run one after another would otherwise leave the later ones past the lease, for a second worker to claim and repeat.
    const pending = new Set(rows.map((j) => Number(j.id)));
    const releaseLease = this.keepLease(pending);
    try {
      for (const job of rows) {
        const id = Number(job.id);
        try {
          // Still ours, right before it runs: a job another worker re-claimed (after a missed renewal) is theirs now.
          if (!(await this.stillHolds(id))) continue;
          await this.runClaimed(id, job);
        } finally {
          pending.delete(id);
        }
      }
    } finally {
      releaseLease();
    }
    return rows.length;
  }

  /** Re-takes this worker's lease on a claimed job right before running it; false when it is no longer this worker's. */
  private async stillHolds(jobId: number): Promise<boolean> {
    const mine = await this.deps.db
      .update(jobs)
      .set({ lockedAt: this.now().toISOString() })
      .where(and(eq(jobs.id, jobId), eq(jobs.lockedBy, this.workerId), eq(jobs.status, "queued")))
      .returning({ id: jobs.id });
    return mine.length > 0;
  }

  /** Runs one claimed job and records how it ended: done, retried later with a growing wait, or failed for good. */
  private async runClaimed(id: number, job: Record<string, unknown>): Promise<void> {
    const payload = (job.payload ?? {}) as { runId?: string; wake?: WakePayload };
    try {
      if (job.kind === "workflow.tick" && payload.runId) {
        await this.tick(payload.runId, payload.wake ?? null);
      } else if (job.kind !== "workflow.tick") {
        const handler = this.jobHandlers.get(String(job.kind));
        if (!handler) throw new Error(`no handler registered for job kind ${String(job.kind)}`);
        await handler(job.payload as Record<string, unknown>, { attempt: Number(job.attempts), maxAttempts: Number(job.max_attempts), now: this.now() });
      }
      await this.deps.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = Number(job.attempts);
      const max = Number(job.max_attempts);
      if (attempts >= max) {
        await this.deps.db.update(jobs).set({ status: "failed", lastError: message }).where(eq(jobs.id, id));
        await this.jobFailedForGood({ kind: String(job.kind), jobId: id, attempts, error: message });
      } else {
        const delay = jobRetryDelayMs(attempts);
        await this.deps.db.update(jobs).set({ lastError: message, lockedAt: null, lockedBy: null, runAt: new Date(this.now().getTime() + delay).toISOString() }).where(eq(jobs.id, id));
      }
    }
  }

  /**
   * Keeps this worker's lease on the jobs it claimed and has not finished (audit row 113): `locked_at` moves forward every
   * third of the lease, so a model step that takes longer than the lease, or a job waiting its turn behind slow ones in
   * the same batch, is never claimed again by a second worker. Only while this worker still holds the job and it is
   * still queued (a finished or released job is left alone). A renewal that fails is ignored: the next one tries again,
   * and the lease is long enough for a missed one.
   */
  private keepLease(jobIds: ReadonlySet<number>): () => void {
    const every = Math.max(1000, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      if (!jobIds.size) return;
      void this.deps.db
        .update(jobs)
        .set({ lockedAt: this.now().toISOString() })
        .where(and(inArray(jobs.id, [...jobIds]), eq(jobs.lockedBy, this.workerId), eq(jobs.status, "queued")))
        .catch(() => undefined);
    }, every);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * A queued job that used up its attempts is never silent (H2): a person sees an alert in the console, and the
   * process's error reporter hears about it with the kind and the ids only, never the payload. Neither may break the
   * loop: the job is already marked failed and the next job is waiting.
   */
  private async jobFailedForGood(info: { kind: string; jobId: number; attempts: number; error: string }): Promise<void> {
    try {
      await raiseAlert(this.deps.db, {
        kind: "job.failed",
        severity: "high",
        title: `A background job gave up: ${info.kind}`,
        body: `Job ${info.jobId} (${info.kind}) failed ${info.attempts} ${info.attempts === 1 ? "time" : "times"} and will not run again on its own. Last error: ${info.error.slice(0, 300)}. Open the Failures tab, fix the cause, then retry or re-queue it.`,
        details: { jobId: info.jobId, kind: info.kind, attempts: info.attempts, lastError: info.error.slice(0, 500) },
      });
    } catch (err) {
      console.error(`[queue] could not raise the job.failed alert for job ${info.jobId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.deps.onJobFailed?.(info);
    } catch {
      // a reporting hook never affects the queue
    }
  }

  /** Drives the queue until nothing is due. Used by tests and by the inline dev worker. */
  async runUntilIdle(maxRounds = 200): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxRounds; i++) {
      const n = await this.runPending(25);
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  /** Executes steps for one run until it waits, completes, fails, or hits the inline step cap. */
  async tick(runId: string, wake: WakePayload = null): Promise<RunRow | null> {
    const [run] = await this.deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run) return null;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
    if (run.status === "paused") return run;
    if (run.status === "waiting") {
      const w = run.wait;
      if (wake?.kind === "timer" && w?.token && wake.key && wake.key !== w.token) return run; // a timer from an earlier wait; ignore
      // an event for an earlier wait (two signals queued before the run ticked): the run waits on other keys now; ignore
      const keys = (w as { keys?: unknown } | null)?.keys;
      if (wake?.kind === "event" && wake.key && Array.isArray(keys) && !keys.includes(wake.key)) return run;
      if (w?.kind === "timer" && Date.parse(w.until) > this.now().getTime()) return run; // not due yet
      if ((w?.kind === "event" || w?.kind === "human") && !wake) return run; // needs a signal (or its timer)
    }
    const def = this.defs.get(run.workflowKey);
    if (!def) throw new Error(`unknown workflow ${run.workflowKey}`);
    if (!run.companyId) throw new Error("platform-level workflows are not supported yet");

    let current = run;
    let currentWake = wake;
    for (let i = 0; i < this.maxInlineSteps; i++) {
      const result = await this.executeStep(def, current, currentWake);
      currentWake = null;
      const [reloaded] = await this.deps.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
      current = reloaded;
      if (result !== "continue") break;
    }
    return current;
  }

  private async executeStep(def: WorkflowDefinition, run: RunRow, wake: WakePayload): Promise<"continue" | "stop"> {
    const companyId = run.companyId!;
    const stepKey = run.currentStep;
    const step = def.steps[stepKey];
    if (!step) throw new Error(`workflow ${def.key} has no step ${stepKey}`);
    const seq = await this.nextSeq(run.id);
    const actor: Actor = { kind: "system", id: `workflow:${def.key}` };

    let outcome: StepResult | { kind: "threw"; error: string } | { kind: "ended" };
    try {
      // The slow half of a two-phase step runs here, with no transaction open.
      let prepared: unknown ;
      if (typeof step !== "function") {
        const pctx: PrepareContext = { run, companyId, state: run.state, services: this.deps.services, wake, now: this.now(), actor, db: this.deps.db, read: (fn) => withTenant(this.deps.db, companyId, fn) };
        prepared = await step.prepare(pctx);
      }
      outcome = await withTenant(this.deps.db, companyId, async (q): Promise<StepResult | { kind: "ended" }> => {
        // A run that ended while the slow half ran (cancelled when the candidate's data was deleted, say) is never
        // written again: the row lock makes a cancel and this step take turns, and the step stands down if it lost.
        if (await runHasEnded(q, run.id, true)) return { kind: "ended" };
        const ctx: StepContext = {
          run,
          companyId,
          state: run.state,
          q,
          services: this.deps.services,
          wake,
          now: this.now(),
          actor,
          alreadyDone: async (k) => {
            const rows = await q.select({ id: workflowSteps.id }).from(workflowSteps).where(and(eq(workflowSteps.runId, run.id), eq(workflowSteps.stepKey, k), eq(workflowSteps.status, "ok"))).limit(1);
            return rows.length > 0;
          },
        };
        const res = typeof step === "function" ? await step(ctx) : await step.run(ctx, prepared);
        await this.applyResult(q, def, run, stepKey, seq, res, wake, actor);
        return res;
      });
    } catch (err) {
      // A step's own "fail" result rolls its transaction back by throwing StepFailed; it keeps the step's word on whether
      // trying again can help, so a failure that cannot be retried goes straight to failForGood.
      outcome = err instanceof StepFailed ? { kind: "fail", error: err.message, retryable: err.retryable } : { kind: "threw", error: err instanceof Error ? err.message : String(err) };
    }

    if (outcome.kind === "ended") return "stop";
    if (outcome.kind === "threw" || (outcome.kind === "fail" && outcome.retryable !== false)) {
      const error = outcome.kind === "threw" ? outcome.error : outcome.error;
      return this.handleRetry(def, run, stepKey, seq, error, actor);
    }
    if (outcome.kind === "fail") {
      await this.failForGood(def, run, stepKey, outcome.error, actor);
      return "stop";
    }
    return outcome.kind === "next" ? "continue" : "stop";
  }

  private async applyResult(q: Tx, def: WorkflowDefinition, run: RunRow, stepKey: string, seq: number, res: StepResult, wake: WakePayload, actor: Actor): Promise<void> {
    if (res.kind === "fail") throw new StepFailed(res.error, res.retryable !== false);
    const state = { ...run.state, ...(res.state ?? {}) };
    await q.insert(workflowSteps).values({ runId: run.id, companyId: run.companyId, stepKey, seq, status: "ok", input: { wake }, output: summarize(res), finishedAt: this.now().toISOString() });
    await emit(q, { type: "workflow.step_completed", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, result: res.kind, next: res.kind === "next" ? res.step : null }, correlationId: run.id });

    if (res.kind === "next") {
      await q.update(workflowRuns).set({ status: "running", currentStep: res.step, state, wait: null, attempts: 0, lastError: null }).where(eq(workflowRuns.id, run.id));
      return;
    }
    if (res.kind === "wait") {
      const token = randomToken(8);
      const wait = { ...withKeys(res.wait), token };
      await q.update(workflowRuns).set({ status: "waiting", currentStep: res.resumeStep ?? stepKey, state, wait, attempts: 0, lastError: null }).where(eq(workflowRuns.id, run.id));
      // A timer wait is due at `until`; an event or human wait with `until` is woken then too (an approval that ran out of time).
      const until = wait.until;
      if (until) {
        await q.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id, wake: { kind: "timer", key: token } }, runAt: until });
      }
      await emit(q, { type: "workflow.waiting", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, wait }, correlationId: run.id });
      return;
    }
    // complete
    await q.update(workflowRuns).set({ status: "completed", state, wait: null, completedAt: this.now().toISOString() }).where(eq(workflowRuns.id, run.id));
    await emit(q, { type: "workflow.completed", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { workflowKey: def.key }, correlationId: run.id });
  }

  private async handleRetry(def: WorkflowDefinition, run: RunRow, stepKey: string, seq: number, error: string, actor: Actor): Promise<"stop"> {
    const outage = isProviderOutage(error);
    // A held run tried again (the hold check's probe): its count of outage tries is not ordinary failures. Another outage
    // holds it again; any other failure is its first ordinary one, never its sixteenth.
    const heldKeys = (run.wait as { keys?: unknown } | null | undefined)?.keys;
    const wasHeld = Array.isArray(heldKeys) && heldKeys.includes(AI_HOLD_KEY);
    const attempts = wasHeld && !outage ? 1 : run.attempts + 1;
    const max = def.maxAttempts ?? 3;
    if (await runHasEnded(this.deps.db, run.id)) return "stop"; // cancelled while the step ran: nothing to retry
    await this.deps.db.insert(workflowSteps).values({ runId: run.id, companyId: run.companyId, stepKey, seq, status: "error", input: {}, output: {}, attempts, error, finishedAt: this.now().toISOString() });
    // The AI provider not answering gets an hour of tries, then a hold that resumes by itself (never a failed run and an
    // escalation per application). Any other failure keeps the definition's own number of tries.
    if (outage && (wasHeld || attempts >= Math.max(max, outageAttempts()))) {
      await this.holdForProvider(def, run, stepKey, error, actor, attempts);
      return "stop";
    }
    if (!outage && attempts >= max) {
      await this.failForGood(def, run, stepKey, error, actor, attempts);
      return "stop";
    }
    const delayMs = retryDelayMs(attempts);
    const until = new Date(this.now().getTime() + delayMs).toISOString();
    const token = randomToken(8);
    const retried = await this.deps.db.update(workflowRuns).set({ status: "waiting", attempts, lastError: error, wait: { kind: "timer", until, reason: `retry ${attempts}/${max}`, token } }).where(and(eq(workflowRuns.id, run.id), notInArray(workflowRuns.status, ENDED_STATUSES))).returning({ id: workflowRuns.id });
    if (retried.length === 0) return "stop";
    await this.deps.db.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id, wake: { kind: "timer", key: token } }, runAt: until });
    await emit(this.deps.db, { type: "workflow.retried", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, attempt: attempts, error, until }, correlationId: run.id });
    return "stop";
  }

  /**
   * The AI provider has not answered for an hour of tries: the run waits on `AI_HOLD_KEY` instead of failing. Nothing is
   * lost and nobody is asked to take over each application; ITS gets one alert for the whole outage (it stands while
   * any run is held), and the hold check is armed to try again.
   */
  private async holdForProvider(def: WorkflowDefinition, run: RunRow, stepKey: string, error: string, actor: Actor, attempts: number): Promise<void> {
    const now = this.now();
    const wait: HeldWait = { kind: "event", eventTypes: [AI_HOLD_KEY], reason: "held: the AI provider is not answering; it resumes by itself when it answers again", token: randomToken(8), keys: [AI_HOLD_KEY], heldAt: now.toISOString() };
    const held = await this.deps.db.update(workflowRuns).set({ status: "waiting", attempts, lastError: error, wait }).where(and(eq(workflowRuns.id, run.id), notInArray(workflowRuns.status, ENDED_STATUSES))).returning({ id: workflowRuns.id });
    if (held.length === 0) return;
    await emit(this.deps.db, { type: "workflow.waiting", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, held: true, reason: "ai_provider_outage", attempts, error, wait }, correlationId: run.id });
    await this.ensureQueued(this.deps.db, { kind: AI_HOLD_CHECK_JOB_KIND, runAt: new Date(now.getTime() + AI_HOLD_CHECK_EVERY_MS) });
    const account = providerProblem(error) === "account";
    try {
      await raiseAlertOnce(this.deps.db, {
        kind: AI_OUTAGE_ALERT_KIND,
        severity: "critical",
        title: account ? "The AI provider refuses our account: applications are on hold" : "The AI provider is not answering: applications are on hold",
        body: `A ${def.key} run stopped at "${stepKey}" after an hour of tries (${error.slice(0, 200)}). Runs like it are held, not failed: nothing is lost and no recruiter request is opened for each one. Every ${Math.round(AI_HOLD_CHECK_EVERY_MS / 60_000)} minutes one held run is tried again, and when the provider answers they all resume by themselves. ${account ? "The provider refused the account itself: check the API key or billing (credit balance)." : "Check the provider's status page and the API key."}`,
        details: { workflowKey: def.key, step: stepKey, attempts, ...(account ? { cause: "account" } : {}) },
      }, { now });
    } catch (err) {
      console.error(`[queue] could not raise the AI outage alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The runs held while the AI provider was out, the longest untouched first. */
  async heldRuns(): Promise<HeldRun[]> {
    const rows = await this.deps.db.select({ id: workflowRuns.id, companyId: workflowRuns.companyId, wait: workflowRuns.wait }).from(workflowRuns).where(and(eq(workflowRuns.status, "waiting"), sql`${workflowRuns.wait}->'keys' ? ${AI_HOLD_KEY}`)).orderBy(asc(workflowRuns.updatedAt), asc(workflowRuns.id));
    return rows.map((r) => ({ id: r.id, companyId: r.companyId, token: r.wait?.token ?? null }));
  }

  /**
   * Lets one held run go again `afterMs` from now: the hold becomes an ordinary retry timer with its count of tries back
   * at zero, so a run that meets trouble after the outage gets the normal tries again (an hour's worth for the provider,
   * the definition's own for anything else). The caller spreads the runs out, so a provider just recovering is not met
   * by every held run in the same second.
   */
  private async releaseHeld(q: Queryable, run: HeldRun, afterMs: number): Promise<void> {
    const until = new Date(this.now().getTime() + afterMs).toISOString();
    const token = randomToken(8);
    const released = await q
      .update(workflowRuns)
      .set({ attempts: 0, wait: { kind: "timer", until, reason: "resuming: the AI provider answers again", token } })
      .where(and(eq(workflowRuns.id, run.id), eq(workflowRuns.status, "waiting"), sql`${workflowRuns.wait}->'keys' ? ${AI_HOLD_KEY}`))
      .returning({ id: workflowRuns.id });
    if (released.length) await q.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id, wake: { kind: "timer", key: token } }, runAt: until });
  }

  /**
   * The hold check (`AI_HOLD_CHECK_JOB_KIND`): the run held longest goes again now, as a probe. If it gets past the step
   * (or stops for some other reason than the provider), the provider is answering, and every other held run is queued
   * to go again too; if it is held again, the provider is still out and the check comes back later. The outage alert is
   * resolved once no run is held. Every held run resumes where it stopped, as from a retry.
   */
  async checkHeldRuns(): Promise<{ held: number; resumed: number; providerAnswers: boolean }> {
    const held = await this.heldRuns();
    if (!held.length) {
      await resolveAlertsOfKind(this.deps.db, AI_OUTAGE_ALERT_KIND, { now: this.now(), reason: "no work is held for the AI provider any more" });
      return { held: 0, resumed: 0, providerAnswers: true };
    }
    const [probe, ...rest] = held;
    try {
      await this.tick(probe.id, heldWake(probe));
    } catch (err) {
      console.warn(`[queue] the held run ${probe.id} could not be tried again: ${err instanceof Error ? err.message : String(err)}`);
    }
    const [after] = await this.deps.db.select({ status: workflowRuns.status, wait: workflowRuns.wait }).from(workflowRuns).where(eq(workflowRuns.id, probe.id)).limit(1);
    const keys = (after?.wait as { keys?: unknown } | null | undefined)?.keys;
    const heldAgain = after?.status === "waiting" && Array.isArray(keys) && keys.includes(AI_HOLD_KEY);
    // A probe that failed for another reason says nothing about the provider: the next check tries another run.
    const providerAnswers = !!after && !heldAgain && after.status !== "failed";
    if (providerAnswers) {
      // a few seconds apart, so the recovering provider is not met by every held run at once
      for (const [i, r] of rest.entries()) await this.releaseHeld(this.deps.db, r, (i + 1) * HELD_RELEASE_SPACING_MS);
      for (const r of [probe, ...rest]) await emit(this.deps.db, { type: "workflow.resumed", companyId: r.companyId, actor: SYSTEM_ACTOR, subject: { type: "workflow_run", id: r.id }, payload: { reason: "ai_provider_answers" }, correlationId: r.id });
    }
    const stillHeld = providerAnswers ? rest.length : held.length - (heldAgain ? 0 : 1);
    if (stillHeld > 0) await this.ensureQueued(this.deps.db, { kind: AI_HOLD_CHECK_JOB_KIND, runAt: new Date(this.now().getTime() + AI_HOLD_CHECK_EVERY_MS) });
    else await resolveAlertsOfKind(this.deps.db, AI_OUTAGE_ALERT_KIND, { now: this.now(), reason: "the AI provider answers again; the held work resumed" });
    return { held: held.length, resumed: providerAnswers ? held.length : 0, providerAnswers };
  }

  private async failForGood(def: WorkflowDefinition, run: RunRow, stepKey: string, error: string, actor: Actor, attempts = run.attempts + 1): Promise<void> {
    // A run cancelled while its step ran stays cancelled (and scrubbed, if that was why it was cancelled).
    const failed = await this.deps.db.update(workflowRuns).set({ status: "failed", attempts, lastError: error, wait: null }).where(and(eq(workflowRuns.id, run.id), notInArray(workflowRuns.status, ENDED_STATUSES))).returning({ id: workflowRuns.id });
    if (failed.length === 0) return;
    await emit(this.deps.db, { type: "workflow.failed", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, error, attempts }, correlationId: run.id });
    try {
      // The process's error reporter hears about the failed run with keys and ids only (H2); never the run's state.
      this.deps.onStepFailed?.({ workflowKey: def.key, runId: run.id, step: stepKey, attempts, error, companyId: run.companyId });
    } catch {
      // a reporting hook never affects the run
    }
    if (run.companyId) {
      const subject = run.subject;
      const roleId = (run.state.roleId as string | undefined) ?? (subject.type === "role" ? subject.id : null);
      const applicationId = (run.state.applicationId as string | undefined) ?? (subject.type === "application" ? subject.id : null);
      // A failed run with no role and no candidate attached goes to ITS administrators, never to a recruiter with access
      // to the whole company (founder decision Q31: automatic requests reach only the candidate or role involved).
      if (!roleId && !applicationId) {
        try {
          await raiseAlert(this.deps.db, {
            kind: "workflow.failed",
            severity: "high",
            title: `A workflow stopped and needs a look: ${def.key}`,
            body: `Step "${stepKey}" failed after ${attempts} attempts: ${error}. No role or candidate is attached, so no recruiter was brought in; open the run in the console.`,
            companyId: run.companyId,
            target: { type: "workflow_run", id: run.id },
            details: { workflowKey: def.key, step: stepKey, attempts },
          });
        } catch {
          // the alert is a courtesy; the failed run is in the console regardless
        }
      }
      try {
        await withTenant(this.deps.db, run.companyId, async (q) => {
          if (roleId || applicationId) {
            const esc = await createEscalation(q, {
              companyId: run.companyId!,
              roleId,
              applicationId,
              kind: def.escalationKind ?? "stuck_role",
              question: stoppedRunQuestion(def.key, attempts),
              requestedBy: actor,
              workflowRunId: run.id,
            });
            await q.update(workflowRuns).set({ escalationId: esc.id }).where(eq(workflowRuns.id, run.id));
            await emit(q, { type: "workflow.escalated", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { escalationId: esc.id }, correlationId: run.id });
          }
          if (def.onFailure) {
            const ctx: StepContext = { run, companyId: run.companyId!, state: run.state, q, services: this.deps.services, wake: null, now: this.now(), actor, alreadyDone: async () => false };
            await def.onFailure(ctx, error);
          }
        });
      } catch {
        // escalation failure must not mask the original failure; the admin console surfaces failed runs regardless
      }
    }
  }

  private async nextSeq(runId: string): Promise<number> {
    const list = rowsOf<{ n: number | string }>(await this.deps.db.execute(sql`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM workflow_steps WHERE run_id = ${runId}`));
    return Number(list[0]?.n ?? 1);
  }

  /** Cancels a run (e.g. candidate withdrew). */
  async cancel(q: Queryable, runId: string, actor: Actor, reason: string): Promise<void> {
    const [run] = await q.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return;
    await q.update(workflowRuns).set({ status: "cancelled", wait: null, lastError: reason }).where(eq(workflowRuns.id, runId));
    await emit(q, { type: "workflow.cancelled", companyId: run.companyId, actor, subject: { type: "workflow_run", id: runId }, payload: { reason }, correlationId: runId });
  }
}

const ENDED_STATUSES = ["completed", "failed", "cancelled"];

/** Whether the run has ended; `lock` takes the row lock (inside a step's transaction) so a cancel waits its turn. */
async function runHasEnded(q: Queryable, runId: string, lock = false): Promise<boolean> {
  const rows = rowsOf<{ status: string }>(await q.execute(lock ? sql`SELECT status FROM workflow_runs WHERE id = ${runId} FOR UPDATE` : sql`SELECT status FROM workflow_runs WHERE id = ${runId}`));
  return !rows[0] || ENDED_STATUSES.includes(rows[0].status);
}

class StepFailed extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

function withKeys(wait: WaitCondition): WaitCondition & { keys?: string[] } {
  if (wait.kind === "event") return { ...wait, keys: wait.eventTypes.map((t) => (wait.subjectId ? `${wait.subjectId}:${t}` : t)) };
  if (wait.kind === "human") return { ...wait, keys: [wait.approvalRequestId ? `approval:${wait.approvalRequestId}` : wait.escalationId ? `escalation:${wait.escalationId}` : "human"] };
  return wait;
}

function summarize(res: StepResult): Record<string, unknown> {
  if (res.kind === "next") return { kind: "next", step: res.step };
  if (res.kind === "wait") return { kind: "wait", wait: res.wait };
  if (res.kind === "complete") return { kind: "complete" };
  return { kind: "fail", error: res.error };
}

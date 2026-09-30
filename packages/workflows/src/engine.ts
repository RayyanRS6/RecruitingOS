import { and, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { SYSTEM_ACTOR, createEscalation, emit, raiseAlert } from "@ros/core";
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
 *   creates a recruiter escalation so nothing dies silently.
 */
export type JobHandler = (payload: Record<string, unknown>, ctx: { attempt: number; maxAttempts: number; now: Date }) => Promise<void>;

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
    for (const job of rows) {
      const id = Number(job.id);
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
          const delay = Math.min(60_000, 1000 * 2 ** attempts);
          await this.deps.db.update(jobs).set({ lastError: message, lockedAt: null, lockedBy: null, runAt: new Date(this.now().getTime() + delay).toISOString() }).where(eq(jobs.id, id));
        }
      }
    }
    return rows.length;
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

    let outcome: StepResult | { kind: "threw"; error: string };
    try {
      // The slow half of a two-phase step runs here, with no transaction open.
      let prepared: unknown ;
      if (typeof step !== "function") {
        const pctx: PrepareContext = { run, companyId, state: run.state, services: this.deps.services, wake, now: this.now(), actor, db: this.deps.db, read: (fn) => withTenant(this.deps.db, companyId, fn) };
        prepared = await step.prepare(pctx);
      }
      outcome = await withTenant(this.deps.db, companyId, async (q) => {
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
      outcome = { kind: "threw", error: err instanceof Error ? err.message : String(err) };
    }

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
    const attempts = run.attempts + 1;
    const max = def.maxAttempts ?? 3;
    await this.deps.db.insert(workflowSteps).values({ runId: run.id, companyId: run.companyId, stepKey, seq, status: "error", input: {}, output: {}, attempts, error, finishedAt: this.now().toISOString() });
    if (attempts >= max) {
      await this.failForGood(def, run, stepKey, error, actor, attempts);
      return "stop";
    }
    const delayMs = Math.min(10 * 60_000, 2000 * 2 ** (attempts - 1));
    const until = new Date(this.now().getTime() + delayMs).toISOString();
    const token = randomToken(8);
    await this.deps.db.update(workflowRuns).set({ status: "waiting", attempts, lastError: error, wait: { kind: "timer", until, reason: `retry ${attempts}/${max}`, token } }).where(eq(workflowRuns.id, run.id));
    await this.deps.db.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id, wake: { kind: "timer", key: token } }, runAt: until });
    await emit(this.deps.db, { type: "workflow.retried", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, attempt: attempts, error, until }, correlationId: run.id });
    return "stop";
  }

  private async failForGood(def: WorkflowDefinition, run: RunRow, stepKey: string, error: string, actor: Actor, attempts = run.attempts + 1): Promise<void> {
    await this.deps.db.update(workflowRuns).set({ status: "failed", attempts, lastError: error, wait: null }).where(eq(workflowRuns.id, run.id));
    await emit(this.deps.db, { type: "workflow.failed", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { step: stepKey, error, attempts }, correlationId: run.id });
    try {
      // The process's error reporter hears about the failed run with keys and ids only (H2); never the run's state.
      this.deps.onStepFailed?.({ workflowKey: def.key, runId: run.id, step: stepKey, attempts, error, companyId: run.companyId });
    } catch {
      // a reporting hook never affects the run
    }
    if (run.companyId) {
      try {
        await withTenant(this.deps.db, run.companyId, async (q) => {
          const subject = run.subject;
          const esc = await createEscalation(q, {
            companyId: run.companyId!,
            roleId: (run.state.roleId as string | undefined) ?? (subject.type === "role" ? subject.id : null),
            applicationId: (run.state.applicationId as string | undefined) ?? (subject.type === "application" ? subject.id : null),
            kind: def.escalationKind ?? "stuck_role",
            question: `Workflow ${def.key} failed at step "${stepKey}" after ${attempts} attempts: ${error}. Please take over.`,
            requestedBy: actor,
            workflowRunId: run.id,
          });
          await q.update(workflowRuns).set({ escalationId: esc.id }).where(eq(workflowRuns.id, run.id));
          await emit(q, { type: "workflow.escalated", companyId: run.companyId, actor, subject: { type: "workflow_run", id: run.id }, payload: { escalationId: esc.id }, correlationId: run.id });
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

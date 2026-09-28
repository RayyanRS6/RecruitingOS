import type { Actor, Subject } from "@ros/contracts";
import type { AiRuntime } from "@ros/ai";
import type { Db, Tx, WaitCondition, workflowRuns } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import type { WorkflowEngine } from "./engine";

export type RunRow = typeof workflowRuns.$inferSelect;

export type Services = {
  ai: AiRuntime;
  integrations: Integrations;
  env: { appBaseUrl: string; itsQueueEmail: string };
  engine: WorkflowEngine;
};

export type WakePayload = { kind: "event" | "timer" | "human" | "manual"; key?: string; payload?: Record<string, unknown> } | null;

export type StepContext<S extends Record<string, unknown> = Record<string, unknown>> = {
  run: RunRow;
  companyId: string;
  state: S;
  q: Tx;
  services: Services;
  wake: WakePayload;
  now: Date;
  actor: Actor;
  /** True when this step already produced an `ok` ledger entry in a prior attempt (idempotency helper). */
  alreadyDone(stepKey: string): Promise<boolean>;
};

/**
 * The first phase of a two-phase step runs outside any database transaction: the place for a model call, a provider
 * round trip, or anything else that takes seconds. `read` opens a short tenant transaction for loading inputs and
 * closes it before the slow call; `db` lets helpers record what happened (an AI run) in their own short transaction.
 */
export type PrepareContext<S extends Record<string, unknown> = Record<string, unknown>> = {
  run: RunRow;
  companyId: string;
  state: S;
  services: Services;
  wake: WakePayload;
  now: Date;
  actor: Actor;
  db: Db;
  read<T>(fn: (q: Tx) => Promise<T>): Promise<T>;
};

export type StepResult<S extends Record<string, unknown> = Record<string, unknown>> =
  | { kind: "next"; step: string; state?: Partial<S> }
  | { kind: "wait"; wait: WaitCondition; state?: Partial<S>; resumeStep?: string }
  | { kind: "complete"; state?: Partial<S> }
  | { kind: "fail"; error: string; retryable?: boolean };

export type StepFn<S extends Record<string, unknown> = Record<string, unknown>> = (ctx: StepContext<S>) => Promise<StepResult<S>>;

/**
 * A step whose slow work happens before its transaction opens. `prepare` runs with no transaction held (its result is
 * whatever the step needs to finish: a model's output, a provider's answer); `run` then opens the tenant transaction
 * and writes. A throw in either phase retries the whole step, so `prepare` must be safe to repeat.
 */
export type TwoPhaseStep<S extends Record<string, unknown> = Record<string, unknown>, P = unknown> = {
  prepare(ctx: PrepareContext<S>): Promise<P>;
  run(ctx: StepContext<S>, prepared: P): Promise<StepResult<S>>;
};

export type StepDef<S extends Record<string, unknown> = Record<string, unknown>> = StepFn<S> | TwoPhaseStep<S, unknown>;

/** Types the prepared value for a two-phase step without repeating it. */
export function twoPhase<S extends Record<string, unknown>, P>(step: TwoPhaseStep<S, P>): TwoPhaseStep<S, P> {
  return step;
}

export type WorkflowDefinition<S extends Record<string, unknown> = Record<string, unknown>> = {
  key: string;
  version: number;
  initialStep: string;
  steps: Record<string, StepDef<S>>;
  maxAttempts?: number;
  /** Escalation kind created when the run fails for good. */
  escalationKind?: string;
  /** Called after the run fails for good (after the escalation is created). */
  onFailure?: (ctx: StepContext<S>, error: string) => Promise<void>;
};

export type StartInput = {
  workflowKey: string;
  companyId: string;
  subject: Subject;
  state?: Record<string, unknown>;
  idempotencyKey?: string;
  actor?: Actor;
};

export type EngineOptions = {
  workerId?: string;
  now?: () => Date;
  /** Max steps executed inline in one tick before yielding to the queue. */
  maxInlineSteps?: number;
  leaseMs?: number;
};

export type EngineDeps = { db: Db; services: Services };

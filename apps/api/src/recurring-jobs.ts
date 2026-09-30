import type { Db } from "@ros/db";
import type { WorkflowEngine } from "@ros/workflows";

type JobHandler = Parameters<WorkflowEngine["registerJob"]>[1];
type JobContext = Parameters<JobHandler>[1];

/**
 * A recurring job that survives a bad day (audit remediation H13). The body runs; whatever happened, the next run is
 * armed in `finally`, so one failing sweep never ends the chain. The failing run itself is still retried by the queue
 * and, after its attempts, reported as a failed job. `ensureQueued` never doubles the chain: the run that is arming
 * the next one is locked and does not count as waiting.
 *
 * When the body failed and the re-arm then fails too (the likeliest cause of both is the same lost database), the
 * body's error is the one the queue records and the alert names: the re-arm error goes to the log, and the queue's
 * retry of the failed run arms the chain again.
 */
export function recurring(engine: WorkflowEngine, db: Db, kind: string, everyMs: number, body: (ctx: JobContext) => Promise<void>): JobHandler {
  return async (_payload, ctx) => {
    let failed = false;
    let bodyError: unknown = null;
    try {
      await body(ctx);
    } catch (err) {
      failed = true;
      bodyError = err;
    }
    // The next run is armed whatever the body did; no throw leaves a `finally`, so no error can hide another.
    try {
      await engine.ensureQueued(db, { kind, runAt: new Date(ctx.now.getTime() + everyMs) });
    } catch (err) {
      if (!failed) throw err;
      console.error(`[queue] ${kind}: could not arm the next run: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (failed) throw bodyError;
  };
}

export const DAILY_MS = 24 * 3600_000;

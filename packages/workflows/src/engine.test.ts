import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { adminAlerts, createDb, events, jobs, migrate, withTenant, workflowRuns, workflowSteps, type DbHandle } from "@ros/db";
import { NEWER_BUILD_PATIENCE_MS, NEWER_BUILD_RETRY_MS, OUTDATED_WORKER_ALERT_KIND, WorkflowEngine } from "./engine";
import type { JobFailedInfo, Services, WorkflowDefinition } from "./types";

/**
 * The engine across builds (audit GAP6-2) and the error text it keeps (OPS-2). During a release, after a rollback, or
 * while the web app is live before the worker, an older worker meets work only a newer build knows: it leaves it in
 * the queue, its try not counted, for a worker that knows it, and one alert says an older build is running until such
 * a worker runs it. Work no build runs for NEWER_BUILD_PATIENCE_MS is work no build knows: it fails like any other job.
 * A failed query's values never reach a job's or a step's last error, an alert, an event or the error reporter.
 */
describe("the workflow engine across builds", () => {
  let handle: DbHandle;
  let now = new Date("2026-10-29T12:00:00.000Z");
  const later = (ms: number) => { now = new Date(now.getTime() + ms); };
  const services = {} as Services; // nothing here calls a service
  let companyId = "";
  const engine = (workerId: string, hooks: { onJobFailed?: (info: JobFailedInfo) => void } = {}) => new WorkflowEngine({ db: handle.db, services, ...hooks }, { workerId, now: () => now });
  const start = (e: WorkflowEngine, workflowKey: string) => withTenant(handle.db, companyId, (tx) => e.start(tx, { workflowKey, companyId, subject: { type: "application", id: randomUUID() } }));
  const jobOf = async (id: number) => (await handle.db.select().from(jobs).where(eq(jobs.id, id)))[0];
  const tickOf = async (runId: string) => (await handle.db.select().from(jobs).where(and(eq(jobs.kind, "workflow.tick"), sql`${jobs.payload}->>'runId' = ${runId}`)))[0];
  const runOf = async (runId: string) => (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0];
  const alertsOf = (kind: string) => handle.db.select().from(adminAlerts).where(eq(adminAlerts.kind, kind));

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    companyId = randomUUID();
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${companyId}, 'Harbor Dental', ${`harbor-${companyId}`}, 'dental', '20-49')`);
  });
  afterAll(async () => {
    await handle.close();
  });

  it("an older worker leaves a job kind it has no handler for in the queue, untouched; the newer one runs it", async () => {
    const older = engine("worker-older");
    const newer = engine("worker-newer");
    const ran: string[] = [];
    newer.registerJob("test.added_in_newer_build", async (payload) => { ran.push(String(payload.note)); });
    await newer.enqueue(handle.db, { kind: "test.added_in_newer_build", payload: { note: "from the newer build" } });
    const [queued] = await handle.db.select().from(jobs).where(eq(jobs.kind, "test.added_in_newer_build"));
    expect(await older.runPending(10)).toBe(0);
    expect(await jobOf(queued.id)).toMatchObject({ status: "queued", attempts: 0, lockedBy: null, lastError: null });
    expect(await newer.runPending(10)).toBe(1);
    expect(ran).toEqual(["from the newer build"]);
    expect((await jobOf(queued.id)).status).toBe("done");
    expect(await alertsOf("job.failed")).toEqual([]); // nothing failed on the way
  });

  it("a tick for a workflow this build does not know goes back to the queue uncounted, with one alert; the newer worker runs it", async () => {
    const def: WorkflowDefinition = { key: "test.added_workflow", version: 1, initialStep: "only", steps: { only: async () => ({ kind: "complete" }) } };
    const newer = engine("worker-newer");
    newer.register(def);
    const older = engine("worker-older");
    const { runId } = await start(newer, def.key);
    const tick = await tickOf(runId);
    const firstPutBack = now.toISOString();
    expect(await older.runPending(10)).toBe(1);
    const job = await jobOf(tick.id);
    expect(job).toMatchObject({ status: "queued", attempts: 0, lockedBy: null, lockedAt: null, lastError: "this worker build does not know workflow test.added_workflow" });
    expect(Date.parse(job.runAt)).toBe(now.getTime() + NEWER_BUILD_RETRY_MS);
    // when it was first put back, so the wait has an end
    expect(job.payload).toEqual({ runId, newerBuildSince: firstPutBack });
    expect((await runOf(runId)).status).toBe("running"); // not failed, not stranded
    // it comes round again: still not counted, still one alert, still the first time kept
    later(NEWER_BUILD_RETRY_MS);
    expect(await older.runPending(10)).toBe(1);
    expect(await jobOf(tick.id)).toMatchObject({ attempts: 0, payload: { runId, newerBuildSince: firstPutBack } });
    const alerts = await alertsOf(OUTDATED_WORKER_ALERT_KIND);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "high", status: "open", title: "An older worker build is running" });
    expect(alerts[0].details).toEqual({ workerId: "worker-older", workflowKey: "test.added_workflow" });
    // the newer worker runs it once it is due again
    expect(await newer.runPending(10)).toBe(0);
    later(NEWER_BUILD_RETRY_MS);
    expect(await newer.runPending(10)).toBe(1);
    expect((await runOf(runId)).status).toBe("completed");
    expect((await jobOf(tick.id)).status).toBe("done");
    // and with that the alert is over by itself: nobody has to clear it by hand
    expect((await alertsOf(OUTDATED_WORKER_ALERT_KIND)).map((a) => a.status)).toEqual(["resolved"]);
  });

  it("a tick for a step this build does not have goes back the same way, before anything is written", async () => {
    const newer = engine("worker-newer");
    newer.register({ key: "test.grown", version: 2, initialStep: "first", steps: { first: async () => ({ kind: "next", step: "added" }), added: async () => ({ kind: "complete" }) } });
    const older = engine("worker-older");
    older.register({ key: "test.grown", version: 1, initialStep: "first", steps: { first: async () => ({ kind: "complete" }) } });
    const { runId } = await start(newer, "test.grown");
    // where a newer worker left it: at a step only the newer build has
    await handle.db.update(workflowRuns).set({ currentStep: "added" }).where(eq(workflowRuns.id, runId));
    const tick = await tickOf(runId);
    expect(await older.runPending(10)).toBe(1);
    expect(await jobOf(tick.id)).toMatchObject({ status: "queued", attempts: 0, lockedBy: null, lastError: 'this worker build does not know step "added" of workflow test.grown' });
    expect(await handle.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId))).toEqual([]);
    // a second run on the same step: still one alert standing, not one per run (the one before was resolved by the newer worker)
    const second = await start(newer, "test.grown");
    await handle.db.update(workflowRuns).set({ currentStep: "added" }).where(eq(workflowRuns.id, second.runId));
    expect(await older.runPending(10)).toBe(1);
    const open = async () => (await alertsOf(OUTDATED_WORKER_ALERT_KIND)).filter((a) => a.status === "open");
    expect(await open()).toHaveLength(1);
    later(NEWER_BUILD_RETRY_MS);
    expect(await newer.runPending(10)).toBe(2);
    expect(await runOf(runId)).toMatchObject({ status: "completed", currentStep: "added" });
    expect(await runOf(second.runId)).toMatchObject({ status: "completed", currentStep: "added" });
    expect(await open()).toEqual([]);
  });

  it("a tick no build can run waits NEWER_BUILD_PATIENCE_MS from the first time it was put back, then fails like any other job, with its own error", async () => {
    const current = engine("worker-current");
    current.register({ key: "test.renamed", version: 2, initialStep: "first", steps: { first: async () => ({ kind: "complete" }) } });
    const { runId } = await start(current, "test.renamed");
    // a run left on a step that the current build no longer has (renamed in a later release)
    await handle.db.update(workflowRuns).set({ currentStep: "gone" }).where(eq(workflowRuns.id, runId));
    const tick = await tickOf(runId);
    const firstPutBack = now.toISOString();
    expect(await current.runPending(10)).toBe(1);
    expect(await jobOf(tick.id)).toMatchObject({ status: "queued", attempts: 0, payload: { runId, newerBuildSince: firstPutBack } });
    // put back, uncounted, until the patience runs out
    later(NEWER_BUILD_PATIENCE_MS - NEWER_BUILD_RETRY_MS);
    expect(await current.runPending(10)).toBe(1);
    expect(await jobOf(tick.id)).toMatchObject({ status: "queued", attempts: 0, payload: { newerBuildSince: firstPutBack } });
    // then an ordinary failure: counted, tried its usual number of times, and failed for good with its own error
    const error = 'this worker build does not know step "gone" of workflow test.renamed';
    for (let i = 0; i < 10 && (await jobOf(tick.id)).status === "queued"; i++) {
      later(NEWER_BUILD_RETRY_MS + 20 * 60_000);
      await current.runPending(10);
    }
    expect(await jobOf(tick.id)).toMatchObject({ status: "failed", attempts: 5, lastError: error });
    const failed = (await alertsOf("job.failed")).find((a) => a.details.jobId === tick.id);
    expect(failed?.body).toContain(error);
    expect((await runOf(runId)).status).toBe("running"); // where it stopped, for a person to see in the console
  });

  it("a job of a kind no build knows waits NEWER_BUILD_PATIENCE_MS past its time untouched, then fails at once, with its error", async () => {
    const current = engine("worker-current");
    const [orphan] = await handle.db.insert(jobs).values({ kind: "test.kind_no_build_has", payload: {}, runAt: now.toISOString() }).returning();
    later(1000);
    expect(await current.runPending(10)).toBe(0);
    expect(await jobOf(orphan.id)).toMatchObject({ status: "queued", attempts: 0, lockedBy: null, lastError: null });
    later(NEWER_BUILD_PATIENCE_MS - 2000);
    expect(await current.runPending(10)).toBe(0); // not yet a day past its time
    later(2000);
    expect(await current.runPending(10)).toBe(1);
    const failed = await jobOf(orphan.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, lastError: "this worker build does not know job kind test.kind_no_build_has, and no worker that does ran it in the 24 hours since it was due" });
    const alert = (await alertsOf("job.failed")).find((a) => a.details.jobId === orphan.id);
    expect(alert?.body).toContain("test.kind_no_build_has");
  });

  it("every job and every step that finishes is progress for the worker's watchdog", async () => {
    const e = engine("worker-progress");
    let heard = 0;
    e.onProgress(() => { heard += 1; });
    e.register({ key: "test.two_steps", version: 1, initialStep: "a", steps: { a: async () => ({ kind: "next", step: "b" }), b: async () => ({ kind: "complete" }) } });
    e.registerJob("test.plain", async () => {});
    await start(e, "test.two_steps");
    await e.enqueue(handle.db, { kind: "test.plain" });
    expect(await e.runPending(10)).toBe(2);
    expect(heard).toBe(4); // the two steps, the tick that ran them, and the plain job
    e.onProgress(() => { throw new Error("a listener that fails"); });
    await e.enqueue(handle.db, { kind: "test.plain" });
    expect(await e.runPending(10)).toBe(1); // changes nothing about the queue
    e.onProgress(null);
  });

  describe("a failed query's values (OPS-2)", () => {
    const NAME = "Nia Brooks";
    const EMAIL = "nia.brooks@example.com";
    const PERSON = /Nia Brooks|nia\.brooks@example\.com/;
    const CUT = "Failed query: SELECT $1::int AS name, $2::int AS email\nparams: [redacted]";

    it("never reach a job's last error, the job.failed alert or the error reporter", async () => {
      const reported: JobFailedInfo[] = [];
      const e = engine("worker-ops2-jobs", { onJobFailed: (info) => reported.push(info) });
      e.registerJob("test.query_naming_a_person", async () => {
        await handle.db.execute(sql`SELECT ${NAME}::int AS name, ${EMAIL}::int AS email`);
      });
      await e.enqueue(handle.db, { kind: "test.query_naming_a_person", maxAttempts: 2 });
      const [queued] = await handle.db.select().from(jobs).where(eq(jobs.kind, "test.query_naming_a_person"));
      await e.runPending(10);
      expect(await jobOf(queued.id)).toMatchObject({ status: "queued", lastError: CUT }); // tried again in seconds
      later(60_000);
      await e.runPending(10);
      const failed = await jobOf(queued.id);
      expect(failed).toMatchObject({ status: "failed", lastError: CUT });
      const alert = (await alertsOf("job.failed")).find((a) => a.details.kind === "test.query_naming_a_person");
      expect(alert?.body).toContain(CUT);
      expect(alert?.details.lastError).toBe(CUT);
      expect(reported).toEqual([{ kind: "test.query_naming_a_person", jobId: queued.id, attempts: 2, error: CUT }]);
      expect(JSON.stringify({ failed, alert, reported })).not.toMatch(PERSON);
    });

    it("never reach a step's error, the run's last error or the workflow.retried event", async () => {
      const e = engine("worker-ops2-steps");
      e.register({
        key: "test.step_query",
        version: 1,
        initialStep: "save",
        maxAttempts: 3,
        steps: {
          save: async (ctx) => {
            await ctx.q.execute(sql`SELECT ${NAME}::int AS name, ${EMAIL}::int AS email`);
            return { kind: "complete" };
          },
        },
      });
      const { runId } = await start(e, "test.step_query");
      await e.runPending(10);
      const run = await runOf(runId);
      expect(run).toMatchObject({ status: "waiting", lastError: CUT }); // a retry is armed
      const steps = await handle.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId));
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ status: "error", error: CUT });
      const retried = await handle.db.select().from(events).where(and(eq(events.type, "workflow.retried"), eq(events.subjectId, runId)));
      expect(retried).toHaveLength(1);
      expect(retried[0].payload).toMatchObject({ step: "save", error: CUT });
      expect(JSON.stringify({ run, steps, retried })).not.toMatch(PERSON);
    });
  });
});

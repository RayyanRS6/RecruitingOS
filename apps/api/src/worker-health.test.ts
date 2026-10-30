import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { adminAlerts, jobs, workerHeartbeats } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { appHealthWatch } from "./maintenance";
import { installReporter } from "./observability";
import { FAILED_POLL_PAUSE_MS, HEARTBEAT_STALE_MS, StallWatchdog, WORKER_STALL_EXIT_MS, WorkerHealth, listeningPort, pollOnce, queueSnapshot, readWorkerHealth, stallExitMs, staleAfterMs, startHealthServer, writeHeartbeat } from "./worker-health";

/**
 * Audit remediation H1 and H15: the worker writes a heartbeat every poll, answers its own /healthz (200 while it
 * polls, 503 once the last poll is stale), and the app's /healthz reports the newest heartbeat when the worker is a
 * separate process.
 */
describe("worker health", () => {
  let container: Container;
  const BASE = Date.UTC(2026, 8, 30, 12, 0, 0);
  let offset = 0;
  const now = () => new Date(BASE + offset);
  const testEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory" };

  beforeAll(async () => {
    container = await createContainer({ memory: true, now, env: { ...testEnv, WORKER_INLINE: "true" } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("the heartbeat is written once per worker and replaced on every poll, with the queue as it stands", async () => {
    await container.db.insert(jobs).values([
      { kind: "workflow.tick", status: "queued", runAt: new Date(BASE - 5 * 60_000).toISOString() },
      { kind: "workflow.tick", status: "queued", runAt: new Date(BASE - 60_000).toISOString() },
      { kind: "workflow.tick", status: "queued", runAt: new Date(BASE + 3600_000).toISOString() }, // not due yet
      { kind: "workflow.tick", status: "queued", runAt: new Date(BASE - 60_000).toISOString(), lockedAt: new Date(BASE - 10_000).toISOString(), lockedBy: "another-worker" }, // being run
      { kind: "workflow.tick", status: "done", runAt: new Date(BASE - 60_000).toISOString() },
    ]);
    expect(await queueSnapshot(container.db, now())).toMatchObject({ queueDepth: 2 });
    const health = new WorkerHealth({ workerId: "worker-test-1", pollMs: 500, now, version: "abc123def456" });
    expect(health.status().ok).toBe(false); // never polled
    const snapshot = await health.beat(container.db);
    expect(snapshot.queueDepth).toBe(2);
    expect(Date.parse(snapshot.oldestQueuedAt!)).toBe(BASE - 5 * 60_000);
    const rows = await container.db.select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, "worker-test-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queueDepth: 2, version: "abc123def456" });
    expect(Date.parse(rows[0].lastSeenAt)).toBe(BASE);
    expect(Date.parse(rows[0].lastPollAt!)).toBe(BASE);
    offset = 1000;
    await health.beat(container.db);
    const again = await container.db.select().from(workerHeartbeats).where(eq(workerHeartbeats.workerId, "worker-test-1"));
    expect(again).toHaveLength(1);
    expect(Date.parse(again[0].lastSeenAt)).toBe(BASE + 1000);
    expect(health.status()).toEqual({ ok: true, workerId: "worker-test-1", lastPollAt: new Date(BASE + 1000).toISOString(), queueDepth: 2, oldestQueuedAgeSeconds: 301 }); // the version stays on the row: never in the anonymous body
    // the read side: the newest heartbeat, healthy while it is younger than ten minutes
    const report = await readWorkerHealth(container.db, now());
    expect(report).toMatchObject({ workerId: "worker-test-1", queueDepth: 2, healthy: true, ageSeconds: 0 });
    expect((await readWorkerHealth(container.db, new Date(BASE + 1000 + HEARTBEAT_STALE_MS + 1), HEARTBEAT_STALE_MS))?.healthy).toBe(false);
    expect(staleAfterMs(1000)).toBe(33_000);
  });

  it("the worker's own /healthz answers 200 while it polls and 503 once the last poll is stale", async () => {
    const health = new WorkerHealth({ workerId: "worker-test-2", pollMs: 500, now, version: "abc123def456" });
    const server = await startHealthServer(health, 0, "127.0.0.1");
    try {
      const port = listeningPort(server);
      expect(port).toBeGreaterThan(0);
      const get = (path = "/healthz") => fetch(`http://127.0.0.1:${port}${path}`);
      expect((await get()).status).toBe(503); // nothing polled yet
      await health.beat(container.db);
      const ok = await get();
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      const body = (await ok.json()) as { ok: boolean; workerId: string; lastPollAt: string | null; queueDepth: number; oldestQueuedAgeSeconds: number | null };
      expect(body).toMatchObject({ ok: true, workerId: "worker-test-2", queueDepth: 2 });
      expect(body.lastPollAt).toBeTruthy();
      expect(body.oldestQueuedAgeSeconds).toBeGreaterThan(0);
      expect(Object.keys(body).sort()).toEqual(["lastPollAt", "ok", "oldestQueuedAgeSeconds", "queueDepth", "workerId"]); // no version on an endpoint that needs no session
      expect(JSON.stringify(body)).not.toContain("abc123def456");
      offset += staleAfterMs(500) + 1; // the clock moves past three polls plus thirty seconds without another beat
      const stale = await get();
      expect(stale.status).toBe(503);
      expect(((await stale.json()) as { ok: boolean }).ok).toBe(false);
      expect((await get("/something-else")).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("the app's /healthz reports the newest heartbeat when the worker is a separate process", async () => {
    const external = await createContainer({ memory: true, now, env: { ...testEnv, WORKER_INLINE: "false" } });
    try {
      const app = createApp(external);
      const health = async () => ((await (await app.request("/healthz")).json()) as { ok: boolean; workerHealthy: boolean; worker: { lastSeenAt: string | null; queueDepth: number | null; healthy: boolean } | string });
      const first = await health();
      expect(first.worker).toEqual({ lastSeenAt: null, queueDepth: null, healthy: false });
      expect(first.workerHealthy).toBe(false);
      // H3: the app, the process that is up while the worker is not, raised the stale-worker alert from its own health check
      const raised = await external.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "worker.stale"));
      expect(raised).toHaveLength(1);
      expect(raised[0].body).toContain("No worker has ever written a heartbeat");
      // an uptime monitor that reads only the status code asks with ?strict=1 and sees the stopped worker
      expect((await app.request("/healthz?strict=1")).status).toBe(503);
      await writeHeartbeat(external.db, { workerId: "railway-1", now: now(), queueDepth: 3, oldestQueuedAt: null, version: null });
      const fresh = await health();
      expect(fresh.ok).toBe(true);
      expect(fresh.worker).toMatchObject({ queueDepth: 3, healthy: true });
      expect(fresh.workerHealthy).toBe(true);
      expect((await app.request("/healthz?strict=1")).status).toBe(200);
      offset += HEARTBEAT_STALE_MS + 60_000;
      const stale = await health();
      expect(stale.ok).toBe(true); // the app itself is fine; the worker's state is reported, not hidden
      expect(stale.worker).toMatchObject({ queueDepth: 3, healthy: false });
      expect(stale.workerHealthy).toBe(false);
      // the inline mode still says so
      const inline = (await (await createApp(container).request("/healthz")).json()) as { worker: unknown; workerHealthy: boolean };
      expect(inline.worker).toBe("inline");
      expect(inline.workerHealthy).toBe(true);
    } finally {
      await external.close();
    }
  });

  it("the app's watch raises the alert once a heartbeat goes stale, at most once per interval, and never with an inline queue", async () => {
    const external = await createContainer({ memory: true, now, env: { ...testEnv, WORKER_INLINE: "false" } });
    try {
      const alerts = async () => (await external.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "worker.stale"))).length;
      await writeHeartbeat(external.db, { workerId: "railway-2", now: now(), queueDepth: 0, oldestQueuedAt: null, version: null });
      const watch = appHealthWatch(external.db, { workerInline: false, everyMs: 0 });
      await watch(now());
      expect(await alerts()).toBe(0); // a fresh heartbeat: nothing to say
      offset += HEARTBEAT_STALE_MS + 60_000;
      await watch(now());
      expect(await alerts()).toBe(1);
      await watch(now());
      expect(await alerts()).toBe(1); // one standing alert, not one per check
      // throttled: a second check inside the interval does not run at all
      const throttled = appHealthWatch(external.db, { workerInline: false, everyMs: 60 * 60_000 });
      await external.db.delete(adminAlerts).where(eq(adminAlerts.kind, "worker.stale"));
      await throttled(now());
      await external.db.delete(adminAlerts).where(eq(adminAlerts.kind, "worker.stale"));
      await throttled(now());
      expect(await alerts()).toBe(0);
      // the queue runs in the app itself: there is no separate worker to watch
      await appHealthWatch(external.db, { workerInline: true, everyMs: 0 })(now());
      expect(await alerts()).toBe(0);
    } finally {
      await external.close();
    }
  });
});

/**
 * Audit OPS-V1 and HOST-12: Railway checks the worker's health only while it deploys and restarts only a process that
 * exits, so a worker whose loop stops finishing anything exits by itself. A database outage the loop rides out never
 * trips it, nor does a long batch whose jobs keep finishing. A failed poll is logged and reported without the values
 * its query carried (OPS-2). Inline mode runs the kinds its build registers, as before (GAP6-2).
 */
describe("the worker's watchdog", () => {
  let inline: Container;
  let t = 0;
  const stalls: number[] = [];
  const watchdog = (stallMs = 60_000) => {
    t = 0;
    stalls.length = 0;
    return new StallWatchdog({ stallMs, now: () => t, onStall: (ms) => stalls.push(ms) });
  };
  const PERSON = /Nia Brooks|nia\.brooks@example\.com/;

  beforeAll(async () => {
    inline = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true" } });
  });
  afterAll(async () => {
    inline.engine.onProgress(null);
    await inline.close();
  });

  it("WORKER_STALL_EXIT_MS is fifteen minutes unless set, and never under a minute", () => {
    expect(WORKER_STALL_EXIT_MS).toBe(900_000);
    for (const raw of [undefined, "", "soon", "0", "-5"]) expect(stallExitMs(raw)).toBe(900_000);
    expect(stallExitMs("1200000")).toBe(1_200_000);
    expect(stallExitMs("900")).toBe(60_000); // meant as seconds: a minute at least, so a busy worker is never restarted
  });

  it("calls the stall once nothing has finished for longer than the limit, and only once", () => {
    const dog = watchdog();
    t = 60_000;
    expect(dog.check()).toBe(false);
    t = 60_001;
    expect(dog.check()).toBe(true);
    expect(stalls).toEqual([60_001]);
    t = 90_000;
    expect(dog.check()).toBe(true);
    expect(stalls).toHaveLength(1); // one line, one exit
    dog.progress();
    t = 120_000;
    expect(dog.check()).toBe(false);
  });

  it("checks on its own timer until stopped", () => {
    vi.useFakeTimers();
    try {
      const dog = watchdog();
      const stop = dog.start(30_000);
      t = 61_000;
      vi.advanceTimersByTime(29_999);
      expect(stalls).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(stalls).toEqual([61_000]);
      stop();
      dog.progress();
      t = 200_000;
      vi.advanceTimersByTime(120_000);
      expect(stalls).toHaveLength(1); // stopped: nothing more is checked
    } finally {
      vi.useRealTimers();
    }
  });

  it("a poll that never ends trips it", async () => {
    const dog = watchdog();
    void pollOnce({ beat: () => new Promise(() => undefined), runPending: async () => 0, pollMs: 1000, watchdog: dog });
    t = 59_000;
    expect(dog.check()).toBe(false);
    t = 61_000;
    expect(dog.check()).toBe(true);
    expect(stalls).toEqual([61_000]);
  });

  it("a database outage never trips it, and each failed poll is logged and reported without its query's values", async () => {
    const dog = watchdog();
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reported: Array<{ err: unknown; context?: Record<string, unknown> }> = [];
    installReporter((err, context) => reported.push({ err, context }));
    try {
      const cause = new Error("Connection terminated unexpectedly");
      const failed = new DrizzleQueryError('insert into "candidates" ("first_name", "email") values ($1, $2)', ["Nia Brooks", "nia.brooks@example.com"], cause);
      // each poll waits 50 s for a database that is not there, then pauses: twenty polls, over seventeen minutes
      for (let i = 0; i < 20; i++) {
        await pollOnce({ beat: async () => { t += 50_000; throw failed; }, runPending: async () => 0, pollMs: 1000, watchdog: dog, sleep: async (ms) => { t += ms; } });
        expect(dog.check()).toBe(false);
      }
      expect(t).toBe(20 * (50_000 + FAILED_POLL_PAUSE_MS));
      expect(stalls).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(20);
      expect(logged.mock.calls[0][0]).toBe("[worker] tick failed");
      const line = JSON.stringify(logged.mock.calls[0]);
      expect(line).toContain("params: [redacted]");
      expect(line).toContain("Connection terminated unexpectedly"); // the reason stays
      expect(reported).toHaveLength(20);
      expect(reported[0].context).toEqual({ process: "worker", where: "tick" });
      const err = reported[0].err as Error;
      expect(err.message).toBe('Failed query: insert into "candidates" ("first_name", "email") values ($1, $2)\nparams: [redacted]');
      expect((err.cause as Error).message).toBe("Connection terminated unexpectedly");
      expect("params" in err).toBe(false);
      for (const text of [JSON.stringify(logged.mock.calls), err.message, String(err.stack)]) expect(text).not.toMatch(PERSON);
    } finally {
      logged.mockRestore();
      installReporter(null);
    }
  });

  it("a batch longer than the limit is not a stall while its jobs keep finishing", async () => {
    const dog = watchdog();
    inline.engine.onProgress(() => dog.progress());
    let ran = 0;
    inline.engine.registerJob("test.slow_but_moving", async () => {
      expect(dog.check()).toBe(false); // checked between jobs, as the timer would
      t += 50_000;
      ran += 1;
    });
    for (let i = 0; i < 5; i++) await inline.engine.enqueue(inline.db, { kind: "test.slow_but_moving" });
    await pollOnce({ beat: async () => undefined, runPending: () => inline.engine.runPending(25), pollMs: 1000, watchdog: dog, sleep: async () => undefined });
    expect(ran).toBe(5);
    expect(t).toBe(250_000);
    expect(dog.check()).toBe(false);
    expect(stalls).toEqual([]);
    inline.engine.onProgress(null);
  });

  it("inline mode still runs the kinds its build registers; a kind only a newer build knows stays queued, untouched", async () => {
    let ran = 0;
    inline.engine.registerJob("test.inline_known", async () => { ran += 1; });
    await inline.engine.enqueue(inline.db, { kind: "test.inline_known" });
    const [unknown] = await inline.db.insert(jobs).values({ kind: "test.only_a_newer_build_knows", runAt: new Date(Date.now() - 1000).toISOString() }).returning({ id: jobs.id });
    await inline.kick();
    expect(ran).toBe(1);
    expect((await inline.db.select().from(jobs).where(eq(jobs.kind, "test.inline_known")))[0].status).toBe("done");
    expect((await inline.db.select().from(jobs).where(eq(jobs.id, unknown.id)))[0]).toMatchObject({ status: "queued", attempts: 0, lockedBy: null, lastError: null });
    expect(await inline.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "job.failed"))).toEqual([]);
  });
});

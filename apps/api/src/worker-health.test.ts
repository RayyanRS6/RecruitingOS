import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { jobs, workerHeartbeats } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { HEARTBEAT_STALE_MS, WorkerHealth, listeningPort, queueSnapshot, readWorkerHealth, staleAfterMs, startHealthServer, writeHeartbeat } from "./worker-health";

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
      const health = async () => ((await (await app.request("/healthz")).json()) as { ok: boolean; worker: { lastSeenAt: string | null; queueDepth: number | null; healthy: boolean } | string });
      expect((await health()).worker).toEqual({ lastSeenAt: null, queueDepth: null, healthy: false });
      await writeHeartbeat(external.db, { workerId: "railway-1", now: now(), queueDepth: 3, oldestQueuedAt: null, version: null });
      const fresh = await health();
      expect(fresh.ok).toBe(true);
      expect(fresh.worker).toMatchObject({ queueDepth: 3, healthy: true });
      offset += HEARTBEAT_STALE_MS + 60_000;
      const stale = await health();
      expect(stale.ok).toBe(true); // the app itself is fine; the worker's state is reported, not hidden
      expect(stale.worker).toMatchObject({ queueDepth: 3, healthy: false });
      // the inline mode still says so
      const inline = (await (await createApp(container).request("/healthz")).json()) as { worker: unknown };
      expect(inline.worker).toBe("inline");
    } finally {
      await external.close();
    }
  });
});

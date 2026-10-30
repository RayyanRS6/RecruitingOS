import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies } from "@ros/db";
import { HEALTHZ_CACHE_MS, createApp } from "./app";
import { createContainer, type Container } from "./container";
import { writeHeartbeat } from "./worker-health";

/**
 * HOST-V7: /healthz needs no session, so each process checks the database and the worker at most once every five
 * seconds and answers every request in between from that check, a failed one included; requests that arrive while it
 * runs share it, and `?strict=1` and the 503 answers read the same result.
 */
describe("the app's /healthz checks once every five seconds per process", () => {
  let container: Container;
  const BASE = Date.UTC(2026, 9, 29, 12, 0, 0);
  let offset = 0;
  const now = () => new Date(BASE + offset);
  const testEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory", WORKER_INLINE: "false" };
  type Health = { ok: boolean; error?: string; worker?: { lastSeenAt: string | null; queueDepth: number | null; healthy: boolean }; workerHealthy?: boolean };
  const get = async (app: ReturnType<typeof createApp>, path = "/healthz") => {
    const r = await app.request(path);
    return { status: r.status, body: (await r.json()) as Health };
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, now, env: testEnv });
  });
  afterAll(async () => {
    await container.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The database probe /healthz itself runs (the select of one company id), counted on the container's database. */
  const probes = () => {
    const select = vi.spyOn(container.db, "select");
    return () => select.mock.calls.filter(([fields]) => (fields as { id?: unknown } | undefined)?.id === companies.id).length;
  };

  it("answers from one check for five seconds, ?strict=1 included, then checks again", async () => {
    const app = createApp(container, { healthCacheMs: HEALTHZ_CACHE_MS });
    const count = probes();
    const first = await get(app);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, workerHealthy: false, worker: { lastSeenAt: null, queueDepth: null, healthy: false } });
    expect(count()).toBe(1);
    // a worker starts polling, but inside the five seconds every answer is the one check's: the stopped worker, and a
    // monitor that asks with ?strict=1 still gets 503
    await writeHeartbeat(container.db, { workerId: "railway-1", now: now(), queueDepth: 2, oldestQueuedAt: null, version: null });
    offset += HEALTHZ_CACHE_MS - 1;
    expect((await get(app)).body).toMatchObject({ ok: true, workerHealthy: false });
    const strict = await get(app, "/healthz?strict=1");
    expect(strict.status).toBe(503);
    expect(strict.body).toMatchObject({ ok: false, workerHealthy: false });
    expect(count()).toBe(1);
    // five seconds after the check, the next request checks again and sees the worker
    offset += 1;
    const fresh = await get(app);
    expect(fresh.body).toMatchObject({ ok: true, workerHealthy: true, worker: { queueDepth: 2, healthy: true } });
    expect((await get(app, "/healthz?strict=1")).status).toBe(200);
    expect(count()).toBe(2);
    // requests that arrive together share one check
    offset += HEALTHZ_CACHE_MS;
    const together = await Promise.all(Array.from({ length: 5 }, () => get(app)));
    expect(together.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(count()).toBe(3);
  });

  it("keeps a failed database check, and its 503, for five seconds too, logging it once", async () => {
    const app = createApp(container, { healthCacheMs: HEALTHZ_CACHE_MS });
    const count = probes();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(container.db.select).mockImplementationOnce(() => {
      throw new Error("connect ECONNREFUSED 10.0.0.7:5432");
    });
    const down = await get(app);
    expect(down.status).toBe(503);
    // an anonymous endpoint never shows the driver's error; the log has it
    expect(down.body).toEqual({ ok: false, error: "database unavailable" });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0][0]).toContain("[healthz] database check failed");
    // the database answers again, but inside the five seconds the failed check stands, for ?strict=1 too
    offset += HEALTHZ_CACHE_MS - 1;
    expect((await get(app)).status).toBe(503);
    expect((await get(app, "/healthz?strict=1")).body).toEqual({ ok: false, error: "database unavailable" });
    expect(count()).toBe(1);
    expect(errors).toHaveBeenCalledTimes(1);
    offset += 1;
    expect((await get(app)).status).toBe(200);
    expect(count()).toBe(2);
  });

  it("checks on every request under NODE_ENV=test unless asked, and keeps each check five seconds elsewhere", async () => {
    // tests see a heartbeat they have just written (worker-health.test.ts)
    const count = probes();
    const testApp = createApp(container);
    await get(testApp);
    await get(testApp);
    expect(count()).toBe(2);
    // outside tests the five seconds are the default
    vi.spyOn(console, "log").mockImplementation(() => undefined); // the request log, on outside tests
    const devApp = createApp({ ...container, env: { ...container.env, NODE_ENV: "development" } });
    await get(devApp);
    await get(devApp);
    expect(count()).toBe(3);
  });
});

import type { Pool, PoolConfig } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, type DbHandle, prepareConnection } from "./client";
import type { fakeDriver } from "./test-pg-driver";

/** Every pg Pool createDb builds in this file, and every connection they open: the real pg-pool on the fake driver. */
const wiring = vi.hoisted(() => ({ pools: [] as Pool[], clients: [] as ReturnType<typeof fakeDriver>["clients"] }));

vi.mock("pg", async (importOriginal) => {
  const real = await importOriginal<typeof import("pg")>();
  const driver = (await import("./test-pg-driver")).fakeDriver();
  wiring.clients = driver.clients;
  class FakeDriverPool extends real.default.Pool {
    constructor(config?: PoolConfig) {
      super({ ...config, Client: driver.Client });
      wiring.pools.push(this);
    }
  }
  return { ...real, default: { ...real.default, Pool: FakeDriverPool } };
});

/**
 * The pool createDb itself builds, not one put together from poolSettings in a test: the settings are applied, platform
 * mode comes from the awaited hook and not from a 'connect' listener (the race behind pg's DeprecationWarning), and a
 * connection closed under the pool is logged and dropped instead of ending the process (12 Oct 2026 incident).
 */
describe("createDb's Postgres pool", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    vi.stubEnv("DATABASE_POOL_MAX", "3");
    vi.stubEnv("DATABASE_SSL_CA", "");
    vi.stubEnv("DATABASE_SSL_CA_FILE", "");
    handle = await createDb({ databaseUrl: "postgres://u:p@127.0.0.1:5432/x" });
  });
  afterAll(async () => {
    await handle.close();
    vi.unstubAllEnvs();
  });

  it("uses poolSettings, and every connection enters platform mode before its first query with no query overlapping another", async () => {
    await Promise.all(Array.from({ length: 15 }, () => handle.query("select 1", [])));
    expect(wiring.pools).toHaveLength(1);
    const pool = wiring.pools[0];
    expect(pool.options).toMatchObject({ max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, onConnect: prepareConnection });
    expect(wiring.clients.length).toBeGreaterThan(0);
    expect(wiring.clients.length).toBeLessThanOrEqual(3);
    for (const c of wiring.clients) {
      expect(c.queries[0]).toBe("SET app.platform = 'on'");
      expect(c.overlaps).toBe(0);
    }
    expect(wiring.clients.flatMap((c) => c.queries).filter((q) => q === "select 1")).toHaveLength(15);
    // The old fire-and-forget SET was a 'connect' listener; next to the hook it would bring the race back.
    expect(pool.listenerCount("connect")).toBe(0);
    expect(pool.listenerCount("error")).toBe(1);
  });

  it("an idle connection the pooler or the server closes is logged and dropped; it never ends the process", async () => {
    await handle.query("select 1", []);
    const pool = wiring.pools[0];
    const idle = wiring.clients.find((c) => !c.ended)!;
    const before = pool.totalCount;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // pg-pool's idle listener drops the connection and re-emits on the pool, which throws if nothing listens there.
      const err = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
      expect(() => idle.emit("error", err)).not.toThrow();
      expect(pool.totalCount).toBe(before - 1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("57P01 terminating connection"));
    } finally {
      warn.mockRestore();
    }
  });

  it("whenIdle watches this pool: while the pool holds a connection, the wait lasts until its cap", async () => {
    const held = await wiring.pools[0].connect();
    try {
      const started = Date.now();
      await handle.whenIdle(300);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    } finally {
      held.release();
    }
  });
});

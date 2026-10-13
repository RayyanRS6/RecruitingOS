import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createDb, poolSettings, prepareConnection, waitForPoolIdle } from "./client";
import { fakeDriver } from "./test-pg-driver";

/**
 * The pool policy behind the 12 Oct 2026 staging incident (the session pooler full after three redeploys): a small
 * pool per process, idle connections closed after 5 s, a query that cannot get a connection failing in 10 s instead
 * of hanging, and platform mode entered before a connection is ever handed out.
 */
describe("the Postgres connection pool", () => {
  it("poolSettings: default 3, DATABASE_POOL_MAX honoured and clamped", () => {
    expect(poolSettings({})).toMatchObject({ max: 3, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000 });
    expect(poolSettings({}).onConnect).toBe(prepareConnection);
    expect(poolSettings({ DATABASE_POOL_MAX: "5" }).max).toBe(5);
    expect(poolSettings({ DATABASE_POOL_MAX: "50" }).max).toBe(20);
    expect(poolSettings({ DATABASE_POOL_MAX: "0" }).max).toBe(3);
    expect(poolSettings({ DATABASE_POOL_MAX: "abc" }).max).toBe(3);
    // pg-pool never closes the connections it keeps for `min`, so a suspended instance would hold them
    expect("min" in poolSettings({})).toBe(false);
  });

  it("every connection enters platform mode before its first query, and no query overlaps another", async () => {
    const driver = fakeDriver();
    const pool = new pg.Pool({ ...poolSettings({ DATABASE_POOL_MAX: "3" }), Client: driver.Client });
    try {
      await Promise.all(Array.from({ length: 15 }, () => pool.query("select 1")));
      expect(driver.clients.length).toBeGreaterThan(0);
      expect(driver.clients.length).toBeLessThanOrEqual(3);
      for (const c of driver.clients) {
        expect(c.queries[0]).toBe("SET app.platform = 'on'");
        expect(c.overlaps).toBe(0);
      }
      expect(driver.clients.flatMap((c) => c.queries).filter((q) => q === "select 1")).toHaveLength(15);
    } finally {
      await pool.end();
    }
  });

  it("a connection that cannot enter platform mode is closed and never used", async () => {
    const driver = fakeDriver({ refuseSet: true });
    const pool = new pg.Pool({ ...poolSettings({}), Client: driver.Client });
    try {
      await expect(pool.query("select 1")).rejects.toThrow(/permission denied to set parameter/);
      expect(driver.clients).toHaveLength(1);
      expect(driver.clients[0].ended).toBe(true);
      expect(driver.clients[0].queries).not.toContain("select 1");
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("a connection closed while it is checked out (a transaction) is logged and dropped, never thrown at the process", async () => {
    const driver = fakeDriver();
    const pool = new pg.Pool({ ...poolSettings({}), Client: driver.Client });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const held = await pool.connect();
    try {
      try {
        // What pg does when the socket dies under a checked-out connection: it stops taking queries and emits 'error'.
        driver.clients[0]._queryable = false;
        const err = Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
        expect(() => held.emit("error", err)).not.toThrow();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("57P01 terminating connection"));
      } finally {
        held.release();
      }
      // The pool does not take a dead connection back.
      expect(pool.totalCount).toBe(0);
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });

  it("a full pool fails a waiting query after the connect timeout instead of hanging", async () => {
    const driver = fakeDriver();
    const pool = new pg.Pool({ ...poolSettings({ DATABASE_POOL_MAX: "1" }), connectionTimeoutMillis: 50, Client: driver.Client });
    const held = await pool.connect();
    try {
      await expect(pool.query("select 1")).rejects.toThrow(/timeout exceeded/);
    } finally {
      held.release();
      await pool.end();
    }
  });

  it("waitForPoolIdle resolves when the idle timer has closed every connection, and at the cap while one is in use", async () => {
    const driver = fakeDriver();
    const pool = new pg.Pool({ ...poolSettings({}), idleTimeoutMillis: 50, Client: driver.Client });
    try {
      await pool.query("select 1");
      expect(pool.totalCount).toBe(1);
      let started = Date.now();
      await waitForPoolIdle(pool, 2000);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(pool.totalCount).toBe(0);

      // A connection still in use: the wait gives up at its cap rather than holding the request open indefinitely.
      const held = await pool.connect();
      try {
        started = Date.now();
        await waitForPoolIdle(pool, 300);
        expect(Date.now() - started).toBeGreaterThanOrEqual(300);
        expect(pool.totalCount).toBe(1);
      } finally {
        held.release();
      }
    } finally {
      await pool.end();
    }
  });

  // A real Postgres test database (the owner role of an empty one, as for rls.test.ts); skipped without one.
  const testUrl = process.env.TEST_DATABASE_URL?.trim();
  it.skipIf(!testUrl)("on a real Postgres: every connection is in platform mode, the pool stays at 3, pg warns about nothing, and it drains", async () => {
    vi.stubEnv("DATABASE_POOL_MAX", "3");
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(w.message);
    process.on("warning", onWarning);
    const handle = await createDb({ databaseUrl: testUrl });
    try {
      const rows = (await Promise.all(Array.from({ length: 20 }, () => handle.query("select current_setting('app.platform', true) as p, pg_backend_pid() as pid", [])))).flat();
      expect(rows.every((r) => r.p === "on")).toBe(true);
      expect(new Set(rows.map((r) => r.pid)).size).toBeLessThanOrEqual(3);
      // whenIdle also resolves at its cap, so only the time it took shows the pool emptied: the 5-second idle timer and
      // one 200 ms poll end well before the 7-second cap.
      const started = Date.now();
      await handle.whenIdle(7000);
      expect(Date.now() - started).toBeLessThan(6_500);
      expect(warnings.filter((m) => /already executing a query/.test(m))).toEqual([]);
    } finally {
      process.off("warning", onWarning);
      await handle.close();
      vi.unstubAllEnvs();
    }
  });
});

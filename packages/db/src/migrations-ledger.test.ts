import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, rowsOf, type DbHandle } from "./client";
import { migrate, migrationStatus, readMigrations } from "./migrate";

/**
 * The production boot check (migrationStatus, apps/api/src/container.ts) runs as the process's own role: ros_app on
 * Vercel, ros_worker on Railway. Both must be able to read the ledger, or every production start fails with
 * "permission denied for table _migrations" (found on staging, 5 October 2026). Neither may write it, and the tenant
 * role sees nothing of it.
 */
describe("the migrations ledger and the application roles", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
  });
  afterAll(async () => {
    await handle.close();
  });

  const as = <T>(role: string, fn: (tx: Parameters<Parameters<DbHandle["db"]["transaction"]>[0]>[0]) => Promise<T>) =>
    handle.db.transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
      return fn(tx);
    });

  for (const role of ["ros_app", "ros_worker"]) {
    it(`${role} reads every applied migration's name, so the production boot check can run`, async () => {
      const names = await as(role, async (tx) => rowsOf<{ name: string }>(await tx.execute(sql`SELECT name FROM _migrations ORDER BY name`)).map((r) => r.name));
      expect(names).toEqual(readMigrations().map((f) => f.name));
    });

    it(`${role} cannot add, change or remove a ledger row`, async () => {
      for (const statement of [sql`INSERT INTO _migrations (name) VALUES ('9999_forged.sql')`, sql`UPDATE _migrations SET name = name`, sql`DELETE FROM _migrations`]) {
        const refused = await as(role, async (tx) => tx.execute(statement)).then(() => null, (e: unknown) => e);
        expect(refused, String(statement.queryChunks)).toBeInstanceOf(Error);
      }
    });
  }

  it("the tenant role cannot read the ledger", async () => {
    const refused = await as("app_tenant", async (tx) => tx.execute(sql`SELECT name FROM _migrations`)).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
  });

  it("the status report shows nothing pending once every file is applied", async () => {
    expect((await migrationStatus(handle)).pending).toEqual([]);
  });
});

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";

/**
 * Migration 0036 on data that existed before it: `applications.locked_at` is added with no default and no backfill, so
 * every application already there stays visible (null), and a new one is visible unless something decides otherwise.
 */
describe("migration 0036: applications.locked_at", () => {
  let handle: DbHandle;
  let dir = "";
  const ids = { company: "11111111-1111-4111-8111-111111111111", role: "22222222-2222-4222-8222-222222222222", old: "33333333-3333-4333-8333-333333333333", fresh: "33333333-3333-4333-8333-333333333334", a: "44444444-4444-4444-8444-444444444444", b: "44444444-4444-4444-8444-444444444445" };
  const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  const application = (id: string, candidateId: string) => sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token) VALUES (${id}, ${ids.company}, ${ids.role}, ${candidateId}, 1, 'direct', ${`token-${id}`})`;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0036-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0036")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${ids.company}, 'Old Dental', 'old-dental', 'dental', '20-49')`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${ids.role}, ${ids.company}, 'Hygienist', 'open', ${actor})`);
    for (const [id, name] of [[ids.a, "Ada"], [ids.b, "Ben"]]) await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, first_source) VALUES (${id}, ${ids.company}, ${name}, 'Old', 'direct')`);
    await handle.db.execute(application(ids.old, ids.a));
    await migrate(handle);
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves an application that was already there visible", async () => {
    expect(await rows<{ locked_at: string | null }>(sql`SELECT locked_at FROM applications WHERE id = ${ids.old}`)).toEqual([{ locked_at: null }]);
  });

  it("is a nullable timestamptz with no default, so a new application is visible too", async () => {
    expect(await rows(sql`SELECT is_nullable, column_default, udt_name FROM information_schema.columns WHERE table_name = 'applications' AND column_name = 'locked_at'`)).toEqual([{ is_nullable: "YES", column_default: null, udt_name: "timestamptz" }]);
    await handle.db.execute(application(ids.fresh, ids.b));
    expect(await rows<{ locked_at: string | null }>(sql`SELECT locked_at FROM applications WHERE id = ${ids.fresh}`)).toEqual([{ locked_at: null }]);
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, isDuplicateObjectError, rowsOf, type DbHandle } from "./client";
import { createdObjects, migrate, MigrationError, migrationStatus } from "./migrate";

/**
 * The staging database setup must be safe to run again after an interruption (founder request, 22 Sep 2026): a
 * migration either lands whole or not at all, one that an earlier non-transactional run left half-applied is
 * completed rather than failed, and a read-only status report says where things stand.
 */
describe("migration runner: atomic files, repair of an interrupted file, status", () => {
  let handle: DbHandle;
  let dir: string;
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
  const exists = async (table: string) => rowsOf<{ e: boolean }>(await handle.db.execute(sql`SELECT to_regclass(${table}) IS NOT NULL AS e`))[0]!.e;
  const ledger = async () => rowsOf<{ name: string }>(await handle.db.execute(sql`SELECT name FROM _migrations ORDER BY name`)).map((r) => r.name);

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    dir = mkdtempSync(join(tmpdir(), "ros-migrations-"));
  });
  afterAll(async () => {
    await handle.close();
  });

  it("applies a file whole, and a failing statement rolls the whole file back with nothing recorded", async () => {
    write("0000_first.sql", `CREATE TABLE t_one (id int primary key);\n--> statement-breakpoint\nCREATE TABLE t_two (id int primary key);\n--> statement-breakpoint\nCREATE TABLE t_three (id int primary key);`);
    expect(await migrate(handle, { dir })).toEqual(["0000_first.sql"]);
    expect(await ledger()).toEqual(["0000_first.sql"]);
    write("0001_broken.sql", `CREATE TABLE t_four (id int primary key);\n--> statement-breakpoint\nCREATE TABLE t_five (id int primary key);\n--> statement-breakpoint\nSELECT * FROM does_not_exist;`);
    let error: MigrationError | null = null;
    try {
      await migrate(handle, { dir });
    } catch (e) {
      error = e as MigrationError;
    }
    expect(error).toBeInstanceOf(MigrationError);
    expect(error!.file).toBe("0001_broken.sql");
    expect(error!.statementIndex).toBe(2);
    expect(error!.statementCount).toBe(3);
    expect(error!.message).toContain("statement 3 of 3");
    // nothing from the broken file survived, and it is not recorded
    expect(await exists("t_four")).toBe(false);
    expect(await exists("t_five")).toBe(false);
    expect(await ledger()).toEqual(["0000_first.sql"]);
    // fixing the file and running again applies it
    write("0001_broken.sql", `CREATE TABLE t_four (id int primary key);\n--> statement-breakpoint\nCREATE TABLE t_five (id int primary key);`);
    expect(await migrate(handle, { dir })).toEqual(["0001_broken.sql"]);
    expect(await exists("t_five")).toBe(true);
    expect(await migrate(handle, { dir })).toEqual([]);
  });

  it("completes a migration that an earlier run left half-applied, reports it, and records it", async () => {
    write("0002_partial.sql", `CREATE TABLE t_six (id int primary key);\n--> statement-breakpoint\nCREATE INDEX t_six_idx ON t_six (id);\n--> statement-breakpoint\nCREATE TYPE mood AS ENUM ('ok');\n--> statement-breakpoint\nALTER TABLE t_six ADD COLUMN note text;\n--> statement-breakpoint\nCREATE TABLE t_seven (id int primary key);\n--> statement-breakpoint\nINSERT INTO t_seven (id) VALUES (1);`);
    // simulate the old runner dying after the fourth statement (no transaction, no ledger row)
    await handle.execRaw(`CREATE TABLE t_six (id int primary key)`);
    await handle.execRaw(`CREATE INDEX t_six_idx ON t_six (id)`);
    await handle.execRaw(`CREATE TYPE mood AS ENUM ('ok')`);
    await handle.execRaw(`ALTER TABLE t_six ADD COLUMN note text`);
    const status = await migrationStatus(handle, { dir });
    expect(status.pending).toEqual(["0002_partial.sql"]);
    expect(status.partial).toEqual({ file: "0002_partial.sql", existing: ["table t_six", "index t_six_idx", "type mood"], total: 4 });
    const logs: string[] = [];
    expect(await migrate(handle, { dir, log: (s) => logs.push(s) })).toEqual(["0002_partial.sql"]);
    expect(logs.some((l) => l.startsWith("repair: 0002_partial.sql had 4 of 6 statements already applied"))).toBe(true);
    expect(await exists("t_seven")).toBe(true);
    expect(rowsOf<{ n: number }>(await handle.db.execute(sql`SELECT count(*)::int AS n FROM t_seven`))[0]!.n).toBe(1);
    expect(await ledger()).toContain("0002_partial.sql");
    const after = await migrationStatus(handle, { dir });
    expect(after.pending).toEqual([]);
    expect(after.partial).toBeNull();
  });

  it("only the first pending migration is repaired; a later one that hits an existing object fails whole", async () => {
    write("0003_ok.sql", `CREATE TABLE t_eight (id int primary key);`);
    write("0004_collides.sql", `CREATE TABLE t_nine (id int primary key);\n--> statement-breakpoint\nCREATE TABLE t_eight (id int primary key);`);
    let error: MigrationError | null = null;
    try {
      await migrate(handle, { dir });
    } catch (e) {
      error = e as MigrationError;
    }
    expect(error?.file).toBe("0004_collides.sql");
    expect(error?.code).toBe("42P07");
    expect(await exists("t_nine")).toBe(false);
    expect(await ledger()).toContain("0003_ok.sql");
    expect(await ledger()).not.toContain("0004_collides.sql");
    write("0004_collides.sql", `CREATE TABLE t_nine (id int primary key);`);
    expect(await migrate(handle, { dir })).toEqual(["0004_collides.sql"]);
  });

  it("a failure other than a duplicate is never skipped, even in the first pending migration", async () => {
    write("0005_bad.sql", `CREATE TABLE t_ten (id int primary key);\n--> statement-breakpoint\nINSERT INTO t_ten (id) VALUES ('not a number');`);
    await expect(migrate(handle, { dir })).rejects.toBeInstanceOf(MigrationError);
    expect(await exists("t_ten")).toBe(false);
    write("0005_bad.sql", `CREATE TABLE t_ten (id int primary key);`);
    expect(await migrate(handle, { dir })).toEqual(["0005_bad.sql"]);
  });

  it("recognises duplicate-object errors by code and, without a code, by message", () => {
    expect(isDuplicateObjectError({ code: "42P07", message: "relation exists" })).toBe(true);
    expect(isDuplicateObjectError({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe(true);
    expect(isDuplicateObjectError({ code: "42601", message: "syntax error" })).toBe(false);
    expect(isDuplicateObjectError({ message: 'relation "x" already exists' })).toBe(true);
    expect(isDuplicateObjectError({ message: "permission denied" })).toBe(false);
    expect(isDuplicateObjectError(null)).toBe(false);
  });

  it("lists the objects a migration creates for the status report", () => {
    expect(createdObjects([`CREATE TABLE "companies" (id uuid)`, `CREATE UNIQUE INDEX "companies_slug_idx" ON "companies" (slug)`, `CREATE TYPE "public"."stage" AS ENUM ('a')`, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ros_app') THEN CREATE ROLE ros_app NOLOGIN; END IF; END $$`, `GRANT SELECT ON x TO y`])).toEqual([
      { kind: "table", name: "companies" }, { kind: "index", name: "companies_slug_idx" }, { kind: "type", name: "stage" }, { kind: "role", name: "ros_app" },
    ]);
  });

  it("the real migrations still apply on a fresh database and report up to date afterwards", async () => {
    const fresh = await createDb({ pgliteDir: "memory://" });
    try {
      const applied = await migrate(fresh);
      expect(applied.length).toBeGreaterThanOrEqual(17);
      expect(await migrate(fresh)).toEqual([]);
      const s = await migrationStatus(fresh);
      expect(s.pending).toEqual([]);
      expect(s.applied.length).toBe(applied.length);
    } finally {
      await fresh.close();
    }
  });
});

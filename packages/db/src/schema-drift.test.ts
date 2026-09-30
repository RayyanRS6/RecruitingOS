import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { is } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { migrate } from "./migrate";
import * as schema from "./schema";

/**
 * The SQL migrations are the source of truth for the database; the Drizzle schema in ./schema is what the code
 * believes the database looks like. Nothing generates one from the other any more, so this test keeps them honest:
 * every table and column the code names must exist after the migrations run, with the same nullability, and every
 * column a migrated table has must be named in the schema. A column the code does not know about is a query that
 * silently ignores data; a column the database does not have is a runtime error.
 */
type DbColumn = { table: string; column: string; nullable: boolean; udt: string };

describe("Drizzle schema against the migrated database", () => {
  let handle: DbHandle;
  const columns = new Map<string, Map<string, DbColumn>>();

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    const rows = rowsOf<{ table_name: string; column_name: string; is_nullable: string; udt_name: string }>(
      await handle.db.execute(sql`SELECT table_name, column_name, is_nullable, udt_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`),
    );
    for (const r of rows) {
      let t = columns.get(r.table_name);
      if (!t) { t = new Map(); columns.set(r.table_name, t); }
      t.set(r.column_name, { table: r.table_name, column: r.column_name, nullable: r.is_nullable === "YES", udt: r.udt_name });
    }
  });
  afterAll(async () => {
    await handle.close();
  });

  const tables = Object.values(schema as Record<string, unknown>).filter((v): v is PgTable => is(v, PgTable));

  it("names at least the tables the product is built on", () => {
    expect(tables.length).toBeGreaterThan(20);
  });

  it("every table and column in the schema exists in the database with the same nullability", () => {
    const problems: string[] = [];
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const db = columns.get(cfg.name);
      if (!db) { problems.push(`table ${cfg.name} is in the schema but not in the migrations`); continue; }
      for (const col of cfg.columns) {
        const dbCol = db.get(col.name);
        if (!dbCol) { problems.push(`${cfg.name}.${col.name} is in the schema but not in the migrations`); continue; }
        const schemaNullable = !col.notNull && !col.primary;
        if (dbCol.nullable !== schemaNullable) problems.push(`${cfg.name}.${col.name} is ${schemaNullable ? "nullable" : "NOT NULL"} in the schema but ${dbCol.nullable ? "nullable" : "NOT NULL"} in the database`);
        if (!typesAgree(col.getSQLType(), dbCol.udt)) problems.push(`${cfg.name}.${col.name} is ${col.getSQLType()} in the schema but ${dbCol.udt} in the database`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every column of a migrated table that the schema names is known to the schema", () => {
    const problems: string[] = [];
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const known = new Set(cfg.columns.map((c) => c.name));
      for (const name of columns.get(cfg.name)?.keys() ?? []) if (!known.has(name)) problems.push(`${cfg.name}.${name} exists in the database but not in the schema`);
    }
    expect(problems).toEqual([]);
  });
});

/** Drizzle's SQL type against Postgres's udt_name, by family; precision and array marks are not compared. */
function typesAgree(schemaType: string, udt: string): boolean {
  const s = schemaType.toLowerCase().replace(/\(.*\)$/, "").replace(/\[\]$/, "");
  const u = udt.replace(/^_/, "");
  const families: Record<string, string[]> = {
    text: ["text"],
    uuid: ["uuid"],
    boolean: ["bool"],
    integer: ["int4"],
    bigint: ["int8"],
    bigserial: ["int8"],
    serial: ["int4"],
    numeric: ["numeric"],
    jsonb: ["jsonb"],
    date: ["date"],
    timestamp: ["timestamp", "timestamptz"],
    "timestamp with time zone": ["timestamptz"],
    "timestamp (3) with time zone": ["timestamptz"],
    vector: ["vector"],
  };
  const family = families[s] ?? [s];
  return family.includes(u);
}

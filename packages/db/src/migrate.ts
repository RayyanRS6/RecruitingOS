import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rowsOf, type DbHandle } from "./client";
import { sql } from "drizzle-orm";

function findMigrationsDir(): string {
  if (process.env.ROS_MIGRATIONS_DIR) return process.env.ROS_MIGRATIONS_DIR;
  try {
    const u = import.meta.url;
    if (typeof u === "string" && u.startsWith("file:")) {
      const candidate = join(dirname(fileURLToPath(u)), "..", "migrations");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // bundled: fall through to the workspace walk
  }
  let dir = process.cwd();
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "packages", "db", "migrations");
}
export const MIGRATIONS_DIR = findMigrationsDir();

/**
 * Applies the SQL migrations in ./migrations in filename order, once each,
 * recording them in `_migrations`. Identical behavior on PGlite and Postgres.
 * drizzle-kit generates the schema migrations; RLS and grants are hand-written SQL
 * in the same folder so they are reviewed like any other migration.
 */
export async function migrate(handle: DbHandle, opts: { log?: (s: string) => void } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  await handle.execRaw(`CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set<string>();
  const list = rowsOf<{ name: string }>(await handle.db.execute(sql`SELECT name FROM _migrations`));
  for (const r of list) applied.add(r.name);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const appliedNow: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const statements = text
      .split(/-->\s*statement-breakpoint/g)
      .map((s) => s.trim())
      .filter(Boolean);
    log(`applying ${file} (${statements.length} statements)`);
    for (const stmt of statements) {
      await handle.execRaw(stmt);
    }
    await handle.execRaw(`INSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
    appliedNow.push(file);
  }
  return appliedNow;
}

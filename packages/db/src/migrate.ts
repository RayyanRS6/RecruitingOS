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

export type MigrationFile = { name: string; statements: string[] };

/** The migration files in order, each split into statements at drizzle's breakpoint marker. */
export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      statements: readFileSync(join(dir, name), "utf8")
        .split(/-->\s*statement-breakpoint/g)
        .map((s) => s.trim())
        .filter(Boolean),
    }));
}

async function ensureLedger(handle: DbHandle): Promise<Set<string>> {
  await handle.execRaw(`CREATE TABLE IF NOT EXISTS _migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set<string>();
  for (const r of rowsOf<{ name: string }>(await handle.db.execute(sql`SELECT name FROM _migrations`))) applied.add(r.name);
  return applied;
}

export class MigrationError extends Error {
  constructor(public readonly file: string, public readonly statementIndex: number, public readonly statementCount: number, public readonly code: string | undefined, message: string, public readonly statementHead: string) {
    super(`migration ${file} failed at statement ${statementIndex + 1} of ${statementCount}${code ? ` (${code})` : ""}: ${message}`);
  }
}

/**
 * Applies the SQL migrations in ./migrations in filename order, once each, recording them in `_migrations`.
 * Identical behaviour on PGlite and Postgres. drizzle-kit generates the schema migrations; RLS and grants are
 * hand-written SQL in the same folder so they are reviewed like any other migration.
 *
 * Each file is applied inside one transaction together with its ledger row, so an interruption leaves either the
 * whole migration or nothing. The first pending migration is the only one an earlier, non-transactional run could
 * have left half-applied; it is applied with "already exists" statements skipped and reported, so a rerun completes
 * it instead of failing on the objects that survived. Every later migration runs strictly.
 */
export async function migrate(handle: DbHandle, opts: { log?: (s: string) => void; dir?: string } = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const applied = await ensureLedger(handle);
  const appliedNow: string[] = [];
  let first = true;
  for (const file of readMigrations(opts.dir)) {
    if (applied.has(file.name)) continue;
    const ledgerRow = `INSERT INTO _migrations (name) VALUES ('${file.name.replace(/'/g, "''")}')`;
    log(`applying ${file.name} (${file.statements.length} statements)`);
    try {
      const { skipped } = await handle.execAtomic([...file.statements, ledgerRow], { onDuplicate: first ? "skip" : "fail" });
      if (skipped.length) log(`repair: ${file.name} had ${skipped.length} of ${file.statements.length} statements already applied by an interrupted run; the rest were applied and the migration is now recorded`);
    } catch (err) {
      const e = err as { code?: string; message?: string; statementIndex?: number };
      const at = typeof e.statementIndex === "number" ? e.statementIndex : locateFailure(err, file.statements);
      throw new MigrationError(file.name, at, file.statements.length, e.code, String(e.message ?? err), file.statements[at]?.slice(0, 80) ?? "");
    }
    appliedNow.push(file.name);
    first = false;
  }
  return appliedNow;
}

/** Best effort: which statement the driver's error message points at. Postgres does not say; the head of the message often names the object. */
function locateFailure(err: unknown, statements: string[]): number {
  const msg = String((err as { message?: string })?.message ?? "");
  const m = msg.match(/"([^"]+)"/);
  if (m) {
    const idx = statements.findIndex((s) => s.includes(`"${m[1]}"`) || s.includes(` ${m[1]} `) || s.includes(` ${m[1]}(`));
    if (idx >= 0) return idx;
  }
  return -1;
}

export type MigrationStatus = {
  applied: string[];
  pending: string[];
  /** For the first pending migration: objects it creates that already exist, a sign of an interrupted run. */
  partial: { file: string; existing: string[]; total: number } | null;
};

/** Read-only: which migrations are applied, which are pending, and whether the next one was interrupted halfway. */
export async function migrationStatus(handle: DbHandle, opts: { dir?: string } = {}): Promise<MigrationStatus> {
  const files = readMigrations(opts.dir);
  const ledger = rowsOf<{ exists: boolean }>(await handle.db.execute(sql`SELECT to_regclass('_migrations') IS NOT NULL AS exists`));
  const applied = new Set<string>();
  if (ledger[0]?.exists) for (const r of rowsOf<{ name: string }>(await handle.db.execute(sql`SELECT name FROM _migrations`))) applied.add(r.name);
  const pending = files.filter((f) => !applied.has(f.name));
  let partial: MigrationStatus["partial"] = null;
  const next = pending[0];
  if (next) {
    const names = createdObjects(next.statements);
    const existing: string[] = [];
    for (const n of names) {
      const q = n.kind === "table" || n.kind === "index"
        ? sql`SELECT to_regclass(${n.name}) IS NOT NULL AS exists`
        : n.kind === "type"
          ? sql`SELECT EXISTS (SELECT 1 FROM pg_type WHERE typname = ${n.name}) AS exists`
          : sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${n.name}) AS exists`;
      if (rowsOf<{ exists: boolean }>(await handle.db.execute(q))[0]?.exists) existing.push(`${n.kind} ${n.name}`);
    }
    partial = { file: next.name, existing, total: names.length };
  }
  return { applied: files.filter((f) => applied.has(f.name)).map((f) => f.name), pending: pending.map((f) => f.name), partial };
}

/** Names of tables, indexes, types and roles a migration creates (for the status report; not used to decide anything). */
export function createdObjects(statements: string[]): Array<{ kind: "table" | "index" | "type" | "role"; name: string }> {
  const out: Array<{ kind: "table" | "index" | "type" | "role"; name: string }> = [];
  for (const s of statements) {
    let m = s.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
    if (m) { out.push({ kind: "table", name: m[1]! }); continue; }
    m = s.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
    if (m) { out.push({ kind: "index", name: m[1]! }); continue; }
    m = s.match(/^CREATE\s+TYPE\s+(?:"?public"?\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
    if (m) { out.push({ kind: "type", name: m[1]! }); continue; }
    for (const r of s.matchAll(/CREATE\s+ROLE\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi)) out.push({ kind: "role", name: r[1]! });
  }
  return out;
}

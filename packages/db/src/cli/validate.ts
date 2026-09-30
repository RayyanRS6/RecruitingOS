import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, rowsOf } from "../client";
import { migrate } from "../migrate";

/**
 * Migration validation (21 Sep, item 7). Static checks on the SQL files, then every migration applied to a fresh
 * in-memory database and the result inspected: every table with a company id has row-level security and a policy;
 * platform-only tables are out of the tenant role's reach unless listed here on purpose; nothing destructive slipped in.
 * Runs locally (`pnpm db:validate`) and in CI. Fails loudly; prints what it checked. Lives in the db package so it
 * resolves the same driver and ORM the application uses.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");
const DESTRUCTIVE = [/\bDROP\s+TABLE\b/i, /\bTRUNCATE\b/i, /\bDROP\s+COLUMN\b/i, /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i];
/**
 * Platform tables (no company id, no row policy) the tenant role may touch on purpose, with the privileges it may hold.
 * Every entry is a decision recorded in a migration comment or docs/spec/09; anything else is a finding.
 */
const TENANT_MAY: Record<string, ReadonlyArray<"SELECT" | "INSERT" | "UPDATE" | "DELETE">> = {
  plans: ["SELECT"], // public price list
  playbooks: ["SELECT"], // platform-wide playbook text the agents read inside tenant transactions
  email_suppressions: ["SELECT"], // every send checks the do-not-send list (migration 0010)
  business_calendar_versions: ["SELECT"], // service-level clocks read the ITS calendar inside tenant transactions (correction 12)
  jobs: ["INSERT"], // tenant transactions enqueue work; only the worker claims, updates or deletes (migration 0003)
};

/** Tables that are facts, never deleted by any application role (audit trail, role ledger, recorded outcomes). */
const APPEND_ONLY = ["audit_records", "platform_role_grants", "hiring_outcomes"];

const problems: string[] = [];
const notes: string[] = [];

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
files.forEach((f, i) => {
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(f)) problems.push(`${f}: name must be NNNN_snake_case.sql`);
  const n = Number(f.slice(0, 4));
  if (n !== i) problems.push(`${f}: expected number ${String(i).padStart(4, "0")} (no gaps, no duplicates)`);
  const text = readFileSync(join(DIR, f), "utf8");
  if (!text.trim()) problems.push(`${f}: empty`);
  const statements = text.split(/-->\s*statement-breakpoint/g).map((s) => s.trim()).filter(Boolean);
  if (!statements.length) problems.push(`${f}: no statements`);
  for (const st of statements) {
    if (/allow-destructive:/.test(st)) continue;
    for (const re of DESTRUCTIVE) if (re.test(st)) problems.push(`${f}: destructive statement without an "-- allow-destructive: <reason>" comment: ${st.split("\n")[0].slice(0, 80)}`);
  }
});
notes.push(`${files.length} migration files, contiguous numbering`);

async function main() {
  const handle = await createDb({ pgliteDir: "memory://" });
  const applied = await migrate(handle);
  notes.push(`${applied.length} migrations applied to a fresh database`);
  const n = rowsOf<{ n: number }>(await handle.db.execute(sql`SELECT count(*)::int AS n FROM _migrations`))[0]?.n;
  if (n !== files.length) problems.push(`_migrations records ${n} rows, expected ${files.length}`);

  const tables = rows<{ table_name: string }>(await handle.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_migrations' ORDER BY 1`)).map((r) => r.table_name);
  const withCompany = new Set(rows<{ table_name: string }>(await handle.db.execute(sql`SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'company_id'`)).map((r) => r.table_name));
  const rls = new Map(rows<{ relname: string; relrowsecurity: boolean }>(await handle.db.execute(sql`SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`)).map((r) => [r.relname, r.relrowsecurity]));
  const policies = new Map<string, number>();
  for (const p of rows<{ tablename: string; policyname: string; qual: string | null; with_check: string | null; permissive: string }>(await handle.db.execute(sql`SELECT tablename, policyname, qual, with_check, permissive FROM pg_policies WHERE schemaname = 'public'`))) {
    policies.set(p.tablename, (policies.get(p.tablename) ?? 0) + 1);
    // every policy must scope rows by the tenant setting (or, for users, through memberships that are); a permissive policy without it opens the table
    const scoped = (text: string | null) => !!text && /app\.company_id/.test(text);
    if (!scoped(p.qual)) problems.push(`${p.tablename}: policy ${p.policyname} does not scope rows by app.company_id (${(p.qual ?? "no USING clause").slice(0, 80)})`);
    if (p.with_check && !scoped(p.with_check)) problems.push(`${p.tablename}: policy ${p.policyname} WITH CHECK does not scope rows by app.company_id`);
  }
  const views = rows<{ table_name: string }>(await handle.db.execute(sql`SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`)).map((v) => v.table_name);
  for (const v of views) problems.push(`${v}: a view in the public schema runs with its owner's privileges and bypasses row-level security; none is allowed without a security_invoker review`);
  let tenantTables = 0;
  let platformTables = 0;
  const privilegeTable: string[] = [];
  for (const t of tables) {
    // A table is tenant-scoped when it carries a company id, or when a row policy scopes it (companies by id, users by membership).
    if (withCompany.has(t) || (rls.get(t) && (policies.get(t) ?? 0) > 0)) {
      tenantTables += 1;
      if (!rls.get(t)) problems.push(`${t}: tenant table but row-level security is not enabled`);
      if (!policies.get(t)) problems.push(`${t}: tenant table but no policy`);
    } else {
      platformTables += 1;
      const priv = rows<{ s: boolean; i: boolean; u: boolean; d: boolean }>(await handle.db.execute(sql`SELECT has_table_privilege('app_tenant', ${t}, 'SELECT') AS s, has_table_privilege('app_tenant', ${t}, 'INSERT') AS i, has_table_privilege('app_tenant', ${t}, 'UPDATE') AS u, has_table_privilege('app_tenant', ${t}, 'DELETE') AS d`))[0];
      const held = [priv.s && "SELECT", priv.i && "INSERT", priv.u && "UPDATE", priv.d && "DELETE"].filter(Boolean) as string[];
      privilegeTable.push(`${t}: ${held.join(", ") || "none"}`);
      const allowed = TENANT_MAY[t] ?? [];
      for (const p of held) if (!allowed.includes(p as "SELECT")) problems.push(`${t}: platform table grants ${p} to the tenant role; not listed as intended in the validator`);
    }
  }
  for (const t of APPEND_ONLY) {
    if (!tables.includes(t)) { problems.push(`${t}: append-only table missing`); continue; }
    for (const role of ["app_tenant", "ros_app", "ros_worker"]) {
      const d = rows<{ d: boolean }>(await handle.db.execute(sql`SELECT has_table_privilege(${role}, ${t}, 'DELETE') AS d`))[0];
      if (d?.d) problems.push(`${t}: ${role} may DELETE from an append-only table`);
    }
  }
  notes.push(`${APPEND_ONLY.length} append-only tables checked against every application role; ${policies.size} tables with policies checked for tenant scoping; ${views.length} views`);
  notes.push(`${tenantTables} tenant tables with row-level security and a policy; ${platformTables} platform tables checked against the tenant role`);
  if (problems.length) notes.push(`tenant-role privileges on platform tables:\n  ${privilegeTable.join("\n  ")}`);
  await handle.close();
}

function rows<T>(result: unknown): T[] {
  return rowsOf<T>(result as Parameters<typeof rowsOf>[0]);
}

main().then(() => {
  for (const n of notes) console.log(`migration validation: ${n}`);
  if (problems.length) {
    console.error(`migration validation: ${problems.length} problem(s)\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("migration validation: ok");
}).catch((e) => { console.error(e); process.exit(1); });

import { mkdirSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema";

export type Schema = typeof schema;
export type Db = PgDatabase<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Anything you can run queries on: the root client or a transaction. */
export type Queryable = Db | Tx;

/** Which application role this connection is meant for. The API is `app`; the workflow and integration worker is `worker`. */
export type DbRole = "app" | "worker";

export type DbHandle = {
  db: Db;
  kind: "pglite" | "postgres";
  role: DbRole;
  close(): Promise<void>;
  /** Escape hatch for raw SQL (migrations, health checks). */
  execRaw(sqlText: string): Promise<void>;
  /** Parameterised query for adapters that need SQL without the ORM (the secret store). Values are never logged. */
  query(text: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
};

export type CreateDbOptions = {
  databaseUrl?: string | null;
  /** PGlite data directory, or "memory://" for tests. */
  pgliteDir?: string;
  role?: DbRole;
};

/**
 * Creates the database client. Production uses DATABASE_URL (node-postgres) as a non-privileged role
 * (`ros_app` or `ros_worker`, see migrations/0003); development and tests use PGlite (Postgres in WebAssembly)
 * so nothing needs installing. The same SQL migrations run on both.
 *
 * Every Postgres connection starts in platform mode (`app.platform = 'on'`): the row-level-security policies
 * honour it for the application roles only. Tenant work switches to `app_tenant`, which the policies isolate
 * by `app.company_id` no matter what else is set.
 */
export async function createDb(opts: CreateDbOptions = {}): Promise<DbHandle> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL ?? null;
  const role: DbRole = opts.role ?? "app";
  if (url) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pg = await import("pg");
    const pool = new pg.default.Pool({ connectionString: url });
    pool.on("connect", (client) => {
      client.query("SET app.platform = 'on'").catch(() => {
        /* the boot check reports a connection that cannot enter platform mode */
      });
    });
    const db = drizzle({ client: pool, schema }) as unknown as Db;
    return {
      db,
      kind: "postgres",
      role,
      close: () => pool.end(),
      execRaw: async (text) => {
        await pool.query(text);
      },
      query: async (text, params) => (await pool.query(text, params as never[])).rows as Array<Record<string, unknown>>,
    };
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const dir = opts.pgliteDir ?? process.env.PGLITE_DIR ?? "memory://";
  if (!dir.startsWith("memory://")) mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir, { extensions: { vector } });
  await client.waitReady;
  const { drizzle } = await import("drizzle-orm/pglite");
  const db = drizzle({ client, schema }) as unknown as Db;
  return {
    db,
    kind: "pglite",
    role,
    close: () => client.close(),
    execRaw: async (text) => {
      await client.exec(text);
    },
    query: async (text, params) => (await client.query(text, params as never[])).rows as Array<Record<string, unknown>>,
  };
}

/**
 * Runs `fn` inside a transaction scoped to one tenant. The database's row-level
 * security policies enforce isolation: the transaction switches to the non-privileged
 * `app_tenant` role and sets `app.company_id`. Cross-tenant reads return nothing;
 * cross-tenant writes are rejected by Postgres, not by application code. Platform mode is
 * switched off for good measure; the policies ignore it for `app_tenant` anyway.
 */
export async function withTenant<T>(db: Db, companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_tenant`);
    await tx.execute(sql`SELECT set_config('app.platform', 'off', true)`);
    await tx.execute(sql`SELECT set_config('app.company_id', ${companyId}, true)`);
    return fn(tx as unknown as Tx);
  });
}

/** Platform context: no tenant filter. Every caller must be an audited platform path (auth, webhooks, admin, candidate pages). */
export async function withPlatform<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.platform', 'on', true)`);
    return fn(tx as unknown as Tx);
  });
}

export type ConnectionRoleInfo = {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Can the connection switch to `app_tenant` (required by withTenant)? */
  canBecomeTenant: boolean;
  platformMode: boolean;
};

/** What the database says about the connection's own role. Used by the boot check. */
export async function inspectConnectionRole(handle: DbHandle): Promise<ConnectionRoleInfo> {
  const rows = rowsOf<{ role: string; superuser: boolean; bypass: boolean; can_tenant: boolean; platform: string | null }>(
    await handle.db.execute(sql`
      SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
             CASE WHEN EXISTS (SELECT 1 FROM pg_roles t WHERE t.rolname = 'app_tenant') THEN pg_has_role(current_user, 'app_tenant', 'MEMBER') ELSE false END AS can_tenant,
             current_setting('app.platform', true) AS platform
      FROM pg_roles r WHERE r.rolname = current_user
    `),
  );
  const r = rows[0];
  if (!r) throw new Error("could not inspect the connection role");
  return { role: r.role, superuser: !!r.superuser, bypassRls: !!r.bypass, canBecomeTenant: !!r.can_tenant, platformMode: r.platform === "on" };
}

/**
 * The boot check behind founder decision F1: production never runs as a superuser or an RLS-bypassing role,
 * and the role must be able to enter tenant transactions. PGlite (development and tests) is always a superuser
 * and is allowed only because production refuses to run without DATABASE_URL.
 */
export function problemsWithConnectionRole(info: ConnectionRoleInfo, kind: DbHandle["kind"]): string[] {
  const problems: string[] = [];
  if (info.superuser) problems.push(`database role "${info.role}" is a superuser`);
  if (info.bypassRls) problems.push(`database role "${info.role}" bypasses row-level security`);
  if (!info.canBecomeTenant && kind === "postgres") problems.push(`database role "${info.role}" is not a member of app_tenant; run packages/db/scripts/provision-roles.sql`);
  if (!info.platformMode && kind === "postgres") problems.push(`connection did not enter platform mode (SET app.platform failed)`);
  return problems;
}

export { schema };

/** Normalizes raw `execute` results across drivers (PGlite returns {rows}, node-postgres returns {rows}, some return arrays). */
export function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) return ((result as { rows?: T[] }).rows ?? []) as T[];
  return [];
}

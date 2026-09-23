import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
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
  /**
   * Runs statements on one connection inside one transaction: all of them take effect, or none. With
   * `onDuplicate: "skip"`, a statement that fails because its object already exists (table, index, type, policy,
   * role, column, function, schema, or a unique row) is rolled back to a savepoint and skipped, so a migration that
   * was interrupted halfway can be completed. Returns the indexes of skipped statements.
   */
  execAtomic(statements: string[], opts?: { onDuplicate?: "skip" | "fail" }): Promise<{ skipped: number[] }>;
  /** Parameterised query for adapters that need SQL without the ORM (the secret store). Values are never logged. */
  query(text: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
};

export type CreateDbOptions = {
  databaseUrl?: string | null;
  /** PGlite data directory, or "memory://" for tests. */
  pgliteDir?: string;
  role?: DbRole;
  /** Path to a CA certificate file for TLS verification when the server's certificate is not signed by a public CA. */
  sslCaFile?: string | null;
};

/**
 * TLS trust for Postgres connections. Supabase signs its database and pooler certificates with its own authority,
 * which no operating system trusts by itself, so `sslmode=verify-full` needs that certificate: DATABASE_SSL_CA_FILE
 * (a path, on a person's machine) or DATABASE_SSL_CA (the certificate text, in a hosted environment). Verification
 * is never switched off here.
 */
export type TlsTrust = { ca: string; rejectUnauthorized: true };

export function tlsOptionsFromEnv(env: Record<string, string | undefined> = process.env, caFile?: string | null): TlsTrust | undefined {
  const file = caFile ?? env.DATABASE_SSL_CA_FILE;
  const raw = file ? readFileSync(file, "utf8") : env.DATABASE_SSL_CA;
  if (!raw || !raw.trim()) return undefined;
  const source = file ? `the certificate file ${file}` : "DATABASE_SSL_CA";
  return { ca: normalizePem(raw, source), rejectUnauthorized: true };
}

/**
 * A certificate as people paste it: Windows line endings, a trailing newline, or a hosted environment's one-line
 * field with literal "\n" sequences. Normalised, then parsed, so a value the TLS layer would silently ignore is
 * refused with a clear message instead.
 */
export function normalizePem(raw: string, source: string): string {
  const pem = raw.replace(/\r\n?/g, "\n").replace(/\\n/g, "\n").trim() + "\n";
  if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(pem)) throw new Error(`${source} is not a PEM certificate (it must start with -----BEGIN CERTIFICATE-----)`);
  try {
    new X509Certificate(pem);
  } catch {
    throw new Error(`${source} is not a certificate this runtime can parse; download it again from Supabase`);
  }
  return pem;
}

/** The modes and switches that would weaken or remove TLS; refused whatever else the string says. */
const REFUSED_SSL_MODES = new Set(["disable", "no-verify"]);
const REFUSED_SSL_VALUES = new Set(["0", "false", "no-verify"]);

/**
 * The driver options for a connection string plus our own TLS trust. node-postgres parses the connection string
 * AFTER the explicit options and lets the parsed values win: an `sslmode` in the string becomes `ssl: {}` and silently
 * discards the certificate we passed, so verification runs against the operating system's store and fails with
 * SELF_SIGNED_CERT_IN_CHAIN (found on the founder's machine, 22 Sep). So when we hold a certificate, the string
 * loses its `sslmode` and `sslrootcert` (a file named there is read into the trust instead) and the driver gets one
 * `ssl` object: the certificate, full verification, host name checked. `sslmode=disable` is refused: the owner
 * credential never travels in the clear.
 */
export function connectionConfig(url: string, trust: TlsTrust | undefined): { connectionString: string; ssl?: TlsTrust } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Never rethrow the driver's or the platform's error: its `input` would carry the string and the password.
    throw new Error("the database connection string is not a valid URL");
  }
  const mode = u.searchParams.get("sslmode");
  if (mode && REFUSED_SSL_MODES.has(mode)) throw new Error(`sslmode=${mode} is not allowed: connections to the database always verify TLS`);
  const sslParam = u.searchParams.get("ssl");
  if (sslParam && REFUSED_SSL_VALUES.has(sslParam.toLowerCase())) throw new Error(`ssl=${sslParam} is not allowed: connections to the database always verify TLS`);
  if (u.searchParams.has("uselibpqcompat")) throw new Error("uselibpqcompat is not allowed in the connection string: its sslmode meanings weaken verification");
  const rootCertFile = u.searchParams.get("sslrootcert");
  let ca = trust ? normalizePem(trust.ca, "the certificate") : undefined;
  if (rootCertFile) {
    let fromString: string;
    try {
      fromString = normalizePem(readFileSync(rootCertFile, "utf8"), `the certificate file ${rootCertFile} named in the connection string`);
    } catch (err) {
      throw new Error(err instanceof Error && /not a PEM|not a certificate/.test(err.message) ? err.message : `the certificate file named in the connection string (sslrootcert) could not be read`);
    }
    if (ca && ca !== fromString) throw new Error("two different certificates were given (DATABASE_SSL_CA_FILE or DATABASE_SSL_CA, and sslrootcert in the connection string); keep one");
    ca = fromString;
  }
  if (!ca) return { connectionString: url };
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"]) u.searchParams.delete(p);
  return { connectionString: u.toString(), ssl: { ca, rejectUnauthorized: true } };
}

/**
 * Postgres error codes that mean "this object already exists": the marks a half-applied migration leaves behind.
 * Deliberately narrow: a unique violation (23505) is accepted only from an INSERT (a seed row already present), never
 * from CREATE UNIQUE INDEX or ADD CONSTRAINT, where it means the data is not unique; 42P16 is a definition error, not
 * a duplicate.
 */
export const DUPLICATE_OBJECT_CODES = new Set(["42P07", "42710", "42701", "42P06", "42723", "42P04"]);

/** Marks an error with the index of the statement that raised it, for the migration report. */
function tagStatement(err: unknown, index: number): unknown {
  if (err && typeof err === "object") (err as { statementIndex?: number }).statementIndex = index;
  return err;
}

export function isDuplicateObjectError(err: unknown, statement = ""): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e) return false;
  if (e.code && DUPLICATE_OBJECT_CODES.has(e.code)) return true;
  if (e.code === "23505") return /^\s*INSERT\b/i.test(statement);
  if (!e.code && typeof e.message === "string") {
    if (/already exists/i.test(e.message)) return true;
    if (/duplicate key value/i.test(e.message)) return /^\s*INSERT\b/i.test(statement);
  }
  return false;
}

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
    const max = Math.max(1, Math.min(20, Number(process.env.DATABASE_POOL_MAX ?? "5") || 5));
    const pool = new pg.default.Pool({ ...connectionConfig(url, tlsOptionsFromEnv(process.env, opts.sslCaFile)), max });
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
      execAtomic: async (statements, o = {}) => {
        const client = await pool.connect();
        const skipped: number[] = [];
        try {
          await client.query("BEGIN");
          for (let i = 0; i < statements.length; i++) {
            if (o.onDuplicate === "skip") {
              await client.query("SAVEPOINT ros_stmt");
              try {
                await client.query(statements[i]!);
                await client.query("RELEASE SAVEPOINT ros_stmt");
              } catch (err) {
                if (!isDuplicateObjectError(err, statements[i]!)) throw tagStatement(err, i);
                await client.query("ROLLBACK TO SAVEPOINT ros_stmt");
                await client.query("RELEASE SAVEPOINT ros_stmt");
                skipped.push(i);
              }
            } else {
              try {
                await client.query(statements[i]!);
              } catch (err) {
                throw tagStatement(err, i);
              }
            }
          }
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          client.release();
        }
        return { skipped };
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
    execAtomic: async (statements, o = {}) => {
      const skipped: number[] = [];
      await client.transaction(async (tx) => {
        for (let i = 0; i < statements.length; i++) {
          if (o.onDuplicate === "skip") {
            await tx.exec("SAVEPOINT ros_stmt");
            try {
              await tx.exec(statements[i]!);
              await tx.exec("RELEASE SAVEPOINT ros_stmt");
            } catch (err) {
              if (!isDuplicateObjectError(err, statements[i]!)) throw tagStatement(err, i);
              await tx.exec("ROLLBACK TO SAVEPOINT ros_stmt");
              await tx.exec("RELEASE SAVEPOINT ros_stmt");
              skipped.push(i);
            }
          } else {
            try {
              await tx.exec(statements[i]!);
            } catch (err) {
              throw tagStatement(err, i);
            }
          }
        }
      });
      return { skipped };
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

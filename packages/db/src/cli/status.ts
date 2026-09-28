import type { TLSSocket } from "node:tls";
import { connectionConfig, createDb, tlsOptionsFromEnv } from "../client";
import { migrationStatus } from "../migrate";
import { describeConnectionError } from "./db-errors";
import { describeCertificate, fingerprintOfDer, smallPool, withSsl } from "./provisioning";

/**
 * Read-only report of the staging database for the founder (22 Sep 2026): which migrations are applied, whether the
 * next one was interrupted halfway, whether the application roles exist and can log in, whether Supabase Vault is
 * present and granted. Changes nothing. Prints no connection string, password or row data, so the output can be
 * pasted back in full. Exits 0 when everything is in place and non-zero otherwise (3 while setup still has work to
 * do, 2 when it could not connect; pnpm may flatten the code it shows).
 */
const owner = process.env.MIGRATE_DATABASE_URL;
if (!owner) {
  console.error("status: MIGRATE_DATABASE_URL must be set by scripts/staging-db-status.sh.");
  process.exit(2);
}
const ownerUrl = withSsl(owner);

// TLS first: which certificate the driver will verify with, and which authority the server actually presents.
let ca: ReturnType<typeof describeCertificate> = null;
let probe: ReturnType<typeof smallPool> | null = null;
{
  try {
    const cfg = connectionConfig(ownerUrl.toString(), tlsOptionsFromEnv(process.env));
    ca = cfg.ssl ? describeCertificate(cfg.ssl.ca) : null;
    if (ca) console.log(`status: tls: trusting ${ca.subject} (SHA-256 ${ca.fingerprint}, valid until ${ca.validTo})`);
    else console.log("status: tls: no CA certificate given (DATABASE_SSL_CA_FILE); only certificates this computer already trusts will verify");
    probe = smallPool(ownerUrl.toString());
  } catch (err) {
    console.error(`status: tls: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  try {
    const client = await probe.connect();
    try {
      const stream = (client as unknown as { connection?: { stream?: TLSSocket } }).connection?.stream;
      const peer = stream && typeof stream.getPeerCertificate === "function" ? stream.getPeerCertificate(true) : null;
      let root = peer;
      for (let i = 0; root?.issuerCertificate && root.issuerCertificate !== root && i < 6; i++) root = root.issuerCertificate;
      if (root?.raw) {
        const fp = fingerprintOfDer(root.raw);
        console.log(`status: tls: the server's chain ends at "${root.subject?.CN ?? "?"}" (SHA-256 ${fp})${ca ? (fp === ca.fingerprint ? "; matches the certificate you provided" : "; DOES NOT match the certificate you provided") : ""}`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`status: could not connect: ${describeConnectionError(err)}`);
    await probe.end().catch(() => undefined);
    process.exit(2);
  }
  await probe.end();
}

const handle = await createDb({ databaseUrl: ownerUrl.toString() });
const q = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => (await handle.query(text, params)) as T[];
const todo: string[] = [];
try {
  let who: { u: string; su: string; v: string };
  try {
    who = (await q<{ u: string; su: string; v: string }>("select current_user as u, current_setting('is_superuser') as su, split_part(version(), ' ', 2) as v"))[0]!;
  } catch (err) {
    console.error(`status: could not connect: ${describeConnectionError(err)}`);
    process.exit(2);
  }
  console.log(`status: connected to ${ownerUrl.hostname}:${ownerUrl.port || "5432"} as ${who.u} (superuser: ${who.su}), Postgres ${who.v}`);

  const vector = (await q<{ present: boolean }>("select exists (select 1 from pg_extension where extname = 'vector') as present"))[0]!.present;
  console.log(`status: extension vector: ${vector ? "installed" : "not installed (the first migration installs it)"}`);

  const m = await migrationStatus(handle);
  console.log(`status: migrations applied: ${m.applied.length}${m.applied.length ? ` (last: ${m.applied[m.applied.length - 1]})` : ""}`);
  console.log(`status: migrations pending: ${m.pending.length}${m.pending.length ? ` (next: ${m.pending[0]})` : ""}`);
  if (m.partial?.existing.length) {
    console.log(`status: ${m.partial.file} was interrupted halfway: ${m.partial.existing.length} of ${m.partial.total} objects it creates already exist (${m.partial.existing.join(", ")}). The setup completes it safely when run again.`);
  }
  if (m.pending.length) todo.push("apply the pending migrations (run scripts/staging-db-setup.sh again)");

  const roles = await q<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; tenant: boolean }>("select rolname, rolcanlogin, rolsuper, rolbypassrls, pg_has_role(rolname, 'app_tenant', 'MEMBER') as tenant from pg_roles where rolname in ('ros_app','ros_worker','app_tenant') and exists (select 1 from pg_roles where rolname = 'app_tenant') order by rolname");
  for (const r of ["app_tenant", "ros_app", "ros_worker"]) {
    const row = roles.find((x) => x.rolname === r);
    if (!row) { console.log(`status: role ${r}: missing (created by migration 0003)`); todo.push(`role ${r} (migrations)`); continue; }
    const login = r === "app_tenant" ? "" : row.rolcanlogin ? ", can log in (password set)" : ", cannot log in yet (passwords not set)";
    console.log(`status: role ${r}: present${login}${row.rolsuper ? ", SUPERUSER (wrong)" : ""}${row.rolbypassrls ? ", BYPASSRLS (wrong)" : ""}${r !== "app_tenant" ? `, member of app_tenant: ${row.tenant ? "yes" : "no"}` : ""}`);
    if (r !== "app_tenant" && !row.rolcanlogin) todo.push(`set the ${r} password (run scripts/staging-db-setup.sh again)`);
  }

  const sessions = await q<{ usename: string; active: number; idle: number }>("select usename, count(*) filter (where state <> 'idle')::int as active, count(*) filter (where state = 'idle')::int as idle from pg_stat_activity where usename in ('ros_app','ros_worker') group by usename order by usename").catch(() => [] as never[]);
  console.log(`status: sessions of the application roles: ${sessions.length ? sessions.map((s) => `${s.usename} ${s.active} active, ${s.idle} idle`).join("; ") : "none"} (idle pooler connections from a recent verification are normal for a few minutes; active ones while the application is not running are not)`);

  const vault = (await q<{ present: boolean }>("select exists (select 1 from pg_namespace where nspname = 'vault') as present"))[0]!.present;
  if (!vault) {
    console.log("status: vault: schema not present (enable Supabase Vault: Dashboard, Database, Extensions, supabase_vault)");
    todo.push("enable Supabase Vault, then run: bash scripts/staging-db-setup.sh grants");
  } else {
    const ok = roles.some((r) => r.rolname === "ros_app") && roles.some((r) => r.rolname === "ros_worker");
    if (!ok) console.log("status: vault: present; grants wait for the roles");
    else {
      const fns = await q<{ sig: string; app: boolean; worker: boolean }>("select p.oid::regprocedure::text as sig, has_function_privilege('ros_app', p.oid, 'EXECUTE') as app, has_function_privilege('ros_worker', p.oid, 'EXECUTE') as worker from pg_proc p where p.pronamespace = 'vault'::regnamespace and p.proname in ('create_secret','update_secret')").catch(() => [] as never[]);
      const g = (await q<{ app_usage: boolean; worker_usage: boolean; worker_read: boolean; app_read: boolean }>(
        "select has_schema_privilege('ros_app','vault','USAGE') as app_usage, has_schema_privilege('ros_worker','vault','USAGE') as worker_usage, has_table_privilege('ros_worker','vault.decrypted_secrets','SELECT') as worker_read, has_table_privilege('ros_app','vault.decrypted_secrets','SELECT') as app_read",
      ).catch(() => [] as never[]))[0];
      if (!g || !fns.length) console.log("status: vault: present, but its functions or views are not the documented ones; the grants could not be checked");
      else {
        console.log(`status: vault: functions ${fns.map((f) => f.sig).join("; ")}`);
        const granted = g.app_usage && g.worker_usage && fns.every((f) => f.app && f.worker) && g.worker_read && !g.app_read;
        console.log(`status: vault: present; grants ${granted ? "in place (API stores and rotates; only the worker reads)" : "incomplete"}${g.app_read ? "; WRONG: ros_app can read decrypted secrets" : ""}`);
        if (!granted) todo.push("apply the Vault grants (run: bash scripts/staging-db-setup.sh grants)");
      }
    }
  }

  // Supabase's Data API roles must have nothing in public (migration 0017); a no-op elsewhere.
  // Explicit grants only: USAGE that reaches a role through PUBLIC is not something these revokes touch.
  const api = await q<{ rolname: string; usage: boolean; tables: number }>("select r.rolname, exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'public' and a.grantee = r.oid and a.privilege_type = 'USAGE') as usage, (select count(*)::int from information_schema.table_privileges tp where tp.grantee = r.rolname and tp.table_schema = 'public') as tables from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by 1");
  if (api.length) {
    for (const r of api) console.log(`status: data api role ${r.rolname}: explicit schema grant ${r.usage ? "YES (should be revoked)" : "no"}, table privileges ${r.tables}${r.tables ? " (should be 0)" : ""}`);
    if (api.some((r) => r.usage || r.tables)) todo.push("revoke the Data API roles' access to public (migration 0017 does it; run scripts/staging-db-setup.sh again), then remove public from the exposed schemas in Supabase (Project Settings, Data API)");
  }
} finally {
  await handle.close();
}
if (todo.length) {
  console.log(`\nstatus: still to do:\n${todo.map((t) => `  - ${t}`).join("\n")}`);
  process.exit(3);
}
console.log("\nstatus: everything is in place. If DATABASE_URL and WORKER_DATABASE_URL are not stored in 1Password yet, run scripts/staging-db-setup.sh again: it sets fresh passwords and delivers the two strings to the clipboard for 1Password (or shows them once with --print).");

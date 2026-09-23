import { describeConnectionError } from "./db-errors";
import { applicationRoleOf, smallPool } from "./provisioning";

/**
 * Read-only test of one application connection string, for the person deciding whether a copy of DATABASE_URL or
 * WORKER_DATABASE_URL is right (23 Sep 2026: Railway refused the worker's password). The string arrives on standard
 * input from scripts/staging-db-check-role.sh, never as an argument; nothing is printed but the role, the host and
 * the outcome. Exit 0 when the string works, 1 when the server refuses it, 2 when it is not an application string.
 */
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const url = raw.replace(/\r?\n$/, "").trim();
const who = applicationRoleOf(url);
if (!who.ok) {
  console.error(`check: ${who.error}.`);
  process.exit(2);
}
console.log(`check: testing ${who.role} through ${who.host}:${who.port} with TLS verification`);
const pool = smallPool(url);
try {
  const r = (await pool.query("select current_user as u, current_setting('is_superuser') as su, (select rolbypassrls from pg_roles where rolname = current_user) as bypass")).rows[0] as { u: string; su: string; bypass: boolean };
  if (r.u !== who.role || r.su !== "off" || r.bypass) {
    console.error(`check: ${who.role}: connected but the role looks wrong (user=${r.u}, superuser=${r.su}, bypassrls=${r.bypass})`);
    process.exit(1);
  }
  if (who.role === "ros_app") {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local role app_tenant");
      await c.query("rollback");
    } finally {
      c.release();
    }
  }
  console.log(`check: ${who.role}: this string works: password accepted, not a superuser, no row-level-security bypass${who.role === "ros_app" ? ", can enter app_tenant" : ""}. If a host still refuses it, the copy entered there differs from this one.`);
} catch (err) {
  console.error(`check: ${who.role}: FAILED: ${describeConnectionError(err)}`);
  console.error("check: if this is the value in 1Password and it is refused, the password no longer matches: run bash scripts/staging-db-setup.sh again, which sets fresh passwords for both roles and delivers both strings to 1Password; then replace DATABASE_URL in Vercel and WORKER_DATABASE_URL in Railway.");
  await pool.end().catch(() => undefined);
  process.exit(1);
} finally {
  await pool.end().catch(() => undefined);
}

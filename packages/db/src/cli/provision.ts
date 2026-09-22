import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Provisions the application roles on a freshly migrated Postgres (Supabase) database and prints, once, the two
 * connection strings the founder stores in 1Password and enters into Vercel and Railway. Run by the founder on her own
 * machine through scripts/staging-db-setup.sh: the owner connection string and the generated passwords arrive in
 * environment variables of this process only; nothing is written to disk, to a log, or to chat.
 *
 * What it does, as the owner: ALTER ROLE ros_app / ros_worker LOGIN PASSWORD (the roles exist from migration 0003 and
 * own nothing), then the Vault grants (packages/db/scripts/vault-grants.sql); then it connects as each new role and
 * proves it is not a superuser, does not bypass row-level security, and (for the API role) can enter the tenant role.
 */
const owner = process.env.MIGRATE_DATABASE_URL;
const appPassword = process.env.ROS_APP_PASSWORD;
const workerPassword = process.env.ROS_WORKER_PASSWORD;
const password = /^[A-Za-z0-9]{24,}$/;
if (!owner || !appPassword || !workerPassword || !password.test(appPassword) || !password.test(workerPassword)) {
  console.error("provision: MIGRATE_DATABASE_URL, ROS_APP_PASSWORD and ROS_WORKER_PASSWORD must be set by scripts/staging-db-setup.sh (letters and digits, 24 characters or more).");
  process.exit(2);
}

function withSsl(u: string): URL {
  const url = new URL(u);
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "verify-full");
  return url;
}
const ownerUrl = withSsl(owner);

/** The same host as the owner's string, the application role in place of the owner, the transaction pooler port. */
function roleUrl(role: "ros_app" | "ros_worker", pw: string): string {
  const u = new URL(ownerUrl.toString());
  const user = decodeURIComponent(u.username);
  u.username = user.startsWith("postgres.") ? `${role}.${user.slice("postgres.".length)}` : role;
  u.password = pw;
  if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "5432") u.port = "6543";
  return u.toString();
}

const ownerPool = new pg.Pool({ connectionString: ownerUrl.toString(), max: 1 });
try {
  const roles = (await ownerPool.query("select rolname from pg_roles where rolname in ('ros_app','ros_worker','app_tenant')")).rows.map((r: { rolname: string }) => r.rolname);
  for (const r of ["ros_app", "ros_worker", "app_tenant"]) if (!roles.includes(r)) throw new Error(`role ${r} does not exist: run pnpm db:migrate first`);
  await ownerPool.query(`ALTER ROLE ros_app LOGIN PASSWORD '${appPassword}'`);
  await ownerPool.query(`ALTER ROLE ros_worker LOGIN PASSWORD '${workerPassword}'`);
  const grantsFile = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "vault-grants.sql");
  const statements = readFileSync(grantsFile, "utf8").replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  for (const s of statements) await ownerPool.query(s);
  console.log(`provision: passwords set for ros_app and ros_worker; ${statements.length} vault grants applied`);
} finally {
  await ownerPool.end();
}

const appUrl = roleUrl("ros_app", appPassword);
const workerUrl = roleUrl("ros_worker", workerPassword);
for (const [role, url] of [["ros_app", appUrl], ["ros_worker", workerUrl]] as const) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const r = (await pool.query("select current_user as u, current_setting('is_superuser') as su, (select rolbypassrls from pg_roles where rolname = current_user) as bypass")).rows[0] as { u: string; su: string; bypass: boolean };
    if (r.u !== role || r.su !== "off" || r.bypass) throw new Error(`role check failed for ${role}: user=${r.u} superuser=${r.su} bypassrls=${r.bypass}`);
    if (role === "ros_app") {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local role app_tenant");
        const t = (await c.query("select current_user as u")).rows[0] as { u: string };
        if (t.u !== "app_tenant") throw new Error("ros_app cannot enter app_tenant");
        await c.query("rollback");
      } finally {
        c.release();
      }
    }
    console.log(`verified: ${role} connects through ${new URL(url).hostname}:${new URL(url).port || "5432"}, not a superuser, no row-level-security bypass${role === "ros_app" ? ", can enter app_tenant" : ""}`);
  } finally {
    await pool.end();
  }
}

console.log("\nStore these two values in 1Password (vault: Recruiting OS Staging) now. They are shown once and never again.");
console.log("Then enter them where they belong: DATABASE_URL into Vercel (Preview environment, sensitive); WORKER_DATABASE_URL into Railway (sealed).\n");
console.log(`DATABASE_URL=${appUrl}`);
console.log(`WORKER_DATABASE_URL=${workerUrl}\n`);
console.log("Do not paste either value into chat, email or a file. Close this window when they are stored.");

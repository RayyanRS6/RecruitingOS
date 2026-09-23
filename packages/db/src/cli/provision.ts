import { describeConnectionError } from "./db-errors";
import { formatStep, isTransientAuthAfterRotation, PASSWORD_SHAPE, roleUrl, smallPool, vaultGrantStatements, withSsl } from "./provisioning";

/**
 * Provisions the application roles on a migrated Postgres (Supabase) database and prints, once, the two connection
 * strings the founder stores in 1Password and enters into Vercel and Railway. Run by the founder on her own machine
 * through scripts/staging-db-setup.sh: the owner connection string and the generated passwords arrive in
 * environment variables of this process only; nothing is written to disk, to a log, or to chat.
 *
 * Every step is safe to run again (founder request, 22 Sep 2026): ALTER ROLE sets the password whether or not one was
 * set before, the Vault grants are idempotent, verification only reads. Modes (ROS_PROVISION_MODE):
 *   full   (default) passwords, Vault grants, verification through the pooler, the two connection strings
 *   grants Vault grants and catalog checks only; nothing about passwords changes and nothing is printed to store
 * Vault grants are skipped with a clear line when the vault schema is not present yet (Supabase Vault not enabled);
 * run the grants mode after enabling it. Errors are described, never echoed with the connection string.
 */
const mode = process.env.ROS_PROVISION_MODE === "grants" ? "grants" : "full";
const owner = process.env.MIGRATE_DATABASE_URL;
const appPassword = process.env.ROS_APP_PASSWORD ?? "";
const workerPassword = process.env.ROS_WORKER_PASSWORD ?? "";
if (!owner) {
  console.error("provision: MIGRATE_DATABASE_URL must be set by scripts/staging-db-setup.sh.");
  process.exit(2);
}
if (mode === "full" && (!PASSWORD_SHAPE.test(appPassword) || !PASSWORD_SHAPE.test(workerPassword))) {
  console.error("provision: ROS_APP_PASSWORD and ROS_WORKER_PASSWORD must be set by scripts/staging-db-setup.sh (letters and digits, 24 characters or more).");
  process.exit(2);
}
const ownerUrl = withSsl(owner);
const say = (step: string, state: "done" | "skipped" | "failed", detail = "") => console.log(formatStep({ step, state, detail }));

let vaultGranted = false;
const ownerPool = smallPool(ownerUrl.toString());
try {
  try {
    await ownerPool.query("select 1");
  } catch (err) {
    console.error(`provision: could not connect as the owner: ${describeConnectionError(err)}`);
    process.exit(1);
  }
  const roles = (await ownerPool.query("select rolname, rolcanlogin from pg_roles where rolname in ('ros_app','ros_worker','app_tenant')")).rows as Array<{ rolname: string; rolcanlogin: boolean }>;
  const missing = ["ros_app", "ros_worker", "app_tenant"].filter((r) => !roles.some((x) => x.rolname === r));
  if (missing.length) {
    say("roles present", "failed", `${missing.join(", ")} missing. If migrations 0001 and 0003 are not recorded yet, run scripts/staging-db-setup.sh again; if they are, the role was removed by hand and its grants with it: tell the team before doing anything else`);
    process.exit(1);
  }
  say("roles present", "done", "ros_app, ros_worker, app_tenant");

  const vault = (await ownerPool.query("select exists (select 1 from pg_namespace where nspname = 'vault') as present")).rows[0] as { present: boolean };
  if (mode === "full") {
    // Passwords and grants land together or not at all, so "passwords set" and "grants applied" are one fact.
    const c = await ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER ROLE ros_app LOGIN PASSWORD '${appPassword}'`);
      await c.query(`ALTER ROLE ros_worker LOGIN PASSWORD '${workerPassword}'`);
      if (vault.present) for (const s of vaultGrantStatements()) await c.query(s);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    say("passwords set", "done", "ros_app and ros_worker can log in with the new passwords; any earlier ones no longer work");
  } else {
    const noLogin = roles.filter((r) => r.rolname !== "app_tenant" && !r.rolcanlogin).map((r) => r.rolname);
    say("passwords set", noLogin.length ? "skipped" : "done", noLogin.length ? `${noLogin.join(", ")} cannot log in yet: run the setup in full mode` : "unchanged in grants mode");
  }

  if (!vault.present) {
    say("vault grants", "skipped", "schema vault is not present: enable Supabase Vault (Dashboard, Database, Extensions, supabase_vault), then run: bash scripts/staging-db-setup.sh grants");
  } else {
    const statements = vaultGrantStatements();
    if (mode === "grants") for (const s of statements) await ownerPool.query(s);
    vaultGranted = true;
    say("vault grants", "done", `${statements.length} statements; the API role stores and rotates, only the worker reads`);
  }
} catch (err) {
  console.error(`provision: failed: ${describeConnectionError(err)}`);
  process.exit(1);
} finally {
  await ownerPool.end();
}

if (mode === "grants") {
  console.log(`provision: grants mode finished${vaultGranted ? "" : " with the Vault grants still pending"}. Nothing about passwords or connection strings changed.`);
  process.exit(vaultGranted ? 0 : 1);
}

const appUrl = roleUrl(ownerUrl, "ros_app", appPassword);
const workerUrl = roleUrl(ownerUrl, "ros_worker", workerPassword);
let verifiedAll = true;
for (const [role, url] of [["ros_app", appUrl], ["ros_worker", workerUrl]] as const) {
  const pool = smallPool(url);
  try {
    // The pooler may take a few seconds to see a fresh password: retry an authentication refusal for up to 30 seconds.
    let r: { u: string; su: string; bypass: boolean } | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        r = (await pool.query("select current_user as u, current_setting('is_superuser') as su, (select rolbypassrls from pg_roles where rolname = current_user) as bypass")).rows[0] as typeof r;
        break;
      } catch (err) {
        if (attempt >= 6 || !isTransientAuthAfterRotation(err)) throw err;
        if (attempt === 1) console.log(`verified: ${role}: waiting for the pooler to pick up the new password`);
        await new Promise((res) => setTimeout(res, 5000));
      }
    }
    if (!r) throw new Error("no row");
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
  } catch (err) {
    verifiedAll = false;
    console.error(`verified: ${role}: FAILED: ${describeConnectionError(err)}`);
  } finally {
    await pool.end();
  }
}
if (!verifiedAll) {
  console.error("\nprovision: the passwords are set and the grants are applied, but a role could not be verified through the pooler (see above). Fix the cause and run the setup again; it is safe to repeat and will set fresh passwords.");
  process.exit(1);
}
console.log("\nStore these two values in 1Password (vault: Recruiting OS Staging) now. They are shown once and never again.");
console.log("Then enter them where they belong: DATABASE_URL into Vercel (Preview environment, sensitive); WORKER_DATABASE_URL into Railway (sealed).");
console.log("Both environments also need DATABASE_SSL_CA (not sensitive): the text of the Supabase CA certificate you downloaded, so verify-full can verify.\n");
console.log(`DATABASE_URL=${appUrl}`);
console.log(`WORKER_DATABASE_URL=${workerUrl}\n`);
console.log("Do not paste either value into chat, email or a file. Close this window when they are stored.");
if (!vaultGranted) console.log("Reminder: the Vault grants are still pending (see above); run: bash scripts/staging-db-setup.sh grants after enabling Supabase Vault.");

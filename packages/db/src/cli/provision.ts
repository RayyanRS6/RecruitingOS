import { clipboardIoForThisComputer, deliverToClipboard, type DeliveryIo } from "./deliver";
import { describeConnectionError } from "./db-errors";
import { checkProjectRef, commandsFor, dbEnvironmentFrom } from "./environment";
import { describeRoleLimits, formatStep, isTransientAuthAfterRotation, LIMIT_NAMES, PASSWORD_SHAPE, roleLimitGaps, roleLimitStatements, roleUrl, smallPool, vaultGrantStatements, withSsl } from "./provisioning";

/**
 * Provisions the application roles on a migrated Postgres (Supabase) database and hands over, once, the two connection
 * strings the founder stores in 1Password and enters into Vercel and Railway. Run by the founder on her own computer
 * through scripts/db-setup.ps1 (Windows) or scripts/staging-db-setup.sh (a Mac, staging only): the owner connection
 * string and the generated passwords arrive in environment variables of this process only; nothing is written to
 * disk, to a log, or to chat.
 *
 * ROS_DB_ENV names the database, staging or production (environment.ts); a run without it, or with a connection string
 * from another Supabase project, is refused before anything connects. The words name that environment's vault, item,
 * Vercel environment and Railway worker.
 *
 * Every step is safe to run again (founder request, 22 Sep 2026): ALTER ROLE sets the password whether or not one was
 * set before, the Vault grants and the role safety limits are idempotent, verification only reads. Modes
 * (ROS_PROVISION_MODE):
 *   full   (default) passwords, role safety limits, Vault grants, verification through the pooler, the two strings
 *   grants role safety limits, Vault grants and catalog checks only; nothing about passwords changes and nothing is
 *          handed over
 * Vault grants are skipped with a clear line when the vault schema is not present yet (Supabase Vault not enabled);
 * run the grants mode after enabling it. Errors are described, never echoed with the connection string.
 *
 * Every full run is also a rotation: the roles get fresh passwords, their earlier sessions are ended, and the old
 * strings stop working at once. Delivery of the two new strings (ROS_PROVISION_DELIVERY): `clipboard` places each on
 * the clipboard in turn for 1Password and clears it afterwards, never printing (on Windows through
 * scripts/lib/clipboard.ps1, kept out of clipboard history); `print` (default when run by hand) shows them once, for
 * staging only: production strings are never shown.
 */
const environment = dbEnvironmentFrom(process.env);
if (!environment.ok) {
  console.error(`provision: ${environment.error}.`);
  process.exit(2);
}
const target = environment.target;
const commands = commandsFor(target);
const mode = process.env.ROS_PROVISION_MODE === "grants" ? "grants" : "full";
const delivery = process.env.ROS_PROVISION_DELIVERY === "clipboard" ? "clipboard" : "print";
const owner = process.env.MIGRATE_DATABASE_URL;
const appPassword = process.env.ROS_APP_PASSWORD ?? "";
const workerPassword = process.env.ROS_WORKER_PASSWORD ?? "";
if (!owner) {
  console.error(`provision: MIGRATE_DATABASE_URL must be set by the setup script (${commands.setup}).`);
  process.exit(2);
}
const project = checkProjectRef(target, owner);
if (!project.ok) {
  console.error(`provision: ${project.error}.`);
  process.exit(2);
}
if (mode === "full" && target.name === "production" && delivery !== "clipboard") {
  console.error(`provision: production connection strings are never shown on screen; nothing was changed. Run the setup, which delivers them through the clipboard: ${commands.setup}`);
  process.exit(2);
}
if (mode === "full" && (!PASSWORD_SHAPE.test(appPassword) || !PASSWORD_SHAPE.test(workerPassword))) {
  console.error("provision: ROS_APP_PASSWORD and ROS_WORKER_PASSWORD must be set by the setup script (letters and digits, 24 characters or more).");
  process.exit(2);
}
const ownerUrl = withSsl(owner);
const say = (step: string, state: "done" | "skipped" | "failed", detail = "") => console.log(formatStep({ step, state, detail }));

// The clipboard is tried before anything changes: a full run rotates the passwords, so a computer whose clipboard
// cannot take the new strings must find out now, not after the old strings have stopped working.
let clipboard: DeliveryIo | null = null;
if (mode === "full" && delivery === "clipboard") {
  clipboard = clipboardIoForThisComputer();
  try {
    await clipboard.clear();
  } catch {
    clipboard.close();
    console.error(`provision: the clipboard cannot be used on this computer, so nothing was changed: a full run sets new passwords, and the new strings could not be delivered.${process.platform === "darwin" && target.name === "staging" ? " Run the setup with --print if this Mac has no clipboard tool." : ""}`);
    process.exit(1);
  }
  say("clipboard ready", "done", "cleared; the two strings will go there one at a time, never shown");
}

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
    say("roles present", "failed", `${missing.join(", ")} missing. If migrations 0001 and 0003 are not recorded yet, run the setup again (${commands.setup}); if they are, the role was removed by hand and its grants with it: tell the team before doing anything else`);
    process.exit(1);
  }
  say("roles present", "done", "ros_app, ros_worker, app_tenant");

  const vault = (await ownerPool.query("select exists (select 1 from pg_namespace where nspname = 'vault') as present")).rows[0] as { present: boolean };
  if (mode === "full") {
    // Passwords, limits and grants land together or not at all, so "passwords set" and "grants applied" are one fact.
    const c = await ownerPool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`ALTER ROLE ros_app LOGIN PASSWORD '${appPassword}'`);
      await c.query(`ALTER ROLE ros_worker LOGIN PASSWORD '${workerPassword}'`);
      for (const s of roleLimitStatements()) await c.query(s);
      if (vault.present) for (const s of vaultGrantStatements()) await c.query(s);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
    say("passwords set", "done", "ros_app and ros_worker can log in with the new passwords; any earlier ones no longer work");
    // A rotation after an exposure must also end whatever was already connected with the old passwords.
    try {
      const ended = (await ownerPool.query("select count(*) filter (where pg_terminate_backend(pid))::int as n, count(*)::int as total from pg_stat_activity where usename in ('ros_app','ros_worker') and pid <> pg_backend_pid()")).rows[0] as { n: number; total: number };
      say("earlier sessions ended", "done", `${ended.n} of ${ended.total} session${ended.total === 1 ? "" : "s"} of the application roles`);
    } catch (err) {
      if ((err as { code?: string }).code === "42501") say("earlier sessions ended", "skipped", "the owner is not permitted to end other roles' sessions on this server; if the old strings were ever entered anywhere, ask Supabase support to end them");
      else throw err;
    }
  } else {
    const noLogin = roles.filter((r) => r.rolname !== "app_tenant" && !r.rolcanlogin).map((r) => r.rolname);
    say("passwords set", noLogin.length ? "skipped" : "done", noLogin.length ? `${noLogin.join(", ")} cannot log in yet: run the setup in full mode` : "unchanged in grants mode");
    for (const s of roleLimitStatements()) await ownerPool.query(s);
  }
  say("role safety limits", "done", `ros_app: ${describeRoleLimits("ros_app")}; ros_worker: ${describeRoleLimits("ros_worker")}; every session the roles open from now on gets them`);

  if (!vault.present) {
    say("vault grants", "skipped", `schema vault is not present: enable Supabase Vault (Dashboard, Database, Extensions, supabase_vault), then run: ${commands.grants}`);
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
    let r: { u: string; su: string; bypass: boolean; statement_timeout: string | null; lock_timeout: string | null; idle_in_transaction_session_timeout: string | null } | undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        r = (await pool.query(`select current_user as u, current_setting('is_superuser') as su, (select rolbypassrls from pg_roles where rolname = current_user) as bypass, ${LIMIT_NAMES.map((n) => `(select setting from pg_settings where name = '${n}') as ${n}`).join(", ")}`)).rows[0] as typeof r;
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
    const gaps = roleLimitGaps(role, r);
    console.log(`verified: ${role} connects through ${new URL(url).hostname}:${new URL(url).port || "5432"}, not a superuser, no row-level-security bypass${role === "ros_app" ? ", can enter app_tenant" : ""}${gaps.length ? "" : `, ${describeRoleLimits(role)}`}`);
    // Informational: a pooler connection opened before the limits were set keeps its old values until it ends.
    if (gaps.length) console.log(`verified: ${role}: this connection does not have ${gaps.join(", ")} yet; it was most likely opened before the limits were set. New sessions get them; the status report shows the role's settings.`);
  } catch (err) {
    verifiedAll = false;
    console.error(`verified: ${role}: FAILED: ${describeConnectionError(err)}`);
  } finally {
    await pool.end();
  }
}
if (!verifiedAll) {
  clipboard?.close();
  console.error("\nprovision: the passwords are set and the grants are applied, but a role could not be verified through the pooler (see above). Fix the cause and run the setup again; it is safe to repeat and will set fresh passwords.");
  process.exit(1);
}
const pendingVault = `Reminder: the Vault grants are still pending (see above); run: ${commands.grants} after enabling Supabase Vault.`;
if (clipboard) {
  console.log(`\nThe two connection strings are ready. They are not shown; they go to the clipboard one at a time for 1Password (vault: ${target.vault}).`);
  console.log(`Later they go where they belong: DATABASE_URL into ${target.vercel}; WORKER_DATABASE_URL into ${target.railway}; both with DATABASE_SSL_CA.\n`);
  let result: { delivered: string[]; timedOut: boolean };
  try {
    result = await deliverToClipboard(
      [
        { name: "DATABASE_URL", value: appUrl, where: `It goes into ${target.vercelShort} later.` },
        { name: "WORKER_DATABASE_URL", value: workerUrl, where: `It goes into ${target.railwayShort} later.` },
      ],
      clipboard,
      target,
    );
  } catch {
    console.error(`provision: the clipboard could not be written; nothing was delivered and the clipboard was cleared. Run the setup again (it sets fresh passwords)${process.platform === "darwin" && target.name === "staging" ? ", with --print if this Mac has no clipboard tool" : ""}.`);
    process.exit(1);
  }
  if (!vaultGranted) console.log(pendingVault);
  process.exit(result.timedOut ? 1 : 0);
} else {
  console.log(`\nStore these two values in 1Password (vault: ${target.vault}) now. They are shown once and never again.`);
  console.log(`Then enter them where they belong: DATABASE_URL into ${target.vercel}; WORKER_DATABASE_URL into ${target.railway}.`);
  console.log("Both environments also need DATABASE_SSL_CA (not sensitive): the text of the Supabase CA certificate you downloaded, so verify-full can verify.\n");
  console.log(`DATABASE_URL=${appUrl}`);
  console.log(`WORKER_DATABASE_URL=${workerUrl}\n`);
  console.log("Do not paste either value into chat, email or a file, and do not photograph this window. Close it when they are stored.");
}
if (!vaultGranted) console.log(pendingVault);

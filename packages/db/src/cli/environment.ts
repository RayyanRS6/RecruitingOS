/**
 * Which database a setup, delivery or status run is for (audit GATE-V3, 29 Oct 2026). ROS_DB_ENV names it, staging or
 * production, and nothing guesses: a run without it is refused. The words each run prints name that environment's
 * 1Password vault and item, its Vercel environment and its Railway worker. The connection string must belong to that
 * environment's Supabase project (the Session pooler user is postgres.<project-ref>): staging is vjuaiyjmtrenbrmujvtc;
 * production is ROS_DB_PROJECT_REF, which production requires and which may never be the staging project. Pure, so it
 * is tested without a server. A project reference is not a secret (it is in every Supabase address), so messages
 * name it; they never carry a connection string or a password.
 */

export const STAGING_PROJECT_REF = "vjuaiyjmtrenbrmujvtc";

export type DbEnvironmentName = "staging" | "production";

export type DbEnvironment = {
  name: DbEnvironmentName;
  projectRef: string;
  /** 1Password: the vault, and the item whose fields DATABASE_URL and WORKER_DATABASE_URL hold the two strings. */
  vault: string;
  item: string;
  /** Where DATABASE_URL and WORKER_DATABASE_URL are entered after 1Password, in full and in short. */
  vercel: string;
  railway: string;
  vercelShort: string;
  railwayShort: string;
};

/** What a Supabase project reference looks like: the lowercase name in https://<ref>.supabase.co. */
const PROJECT_REF_SHAPE = /^[a-z0-9]{10,40}$/;

const WORDS: Record<DbEnvironmentName, Omit<DbEnvironment, "name" | "projectRef">> = {
  staging: {
    vault: "Recruiting OS Staging",
    item: "Recruiting OS staging database",
    vercel: "Vercel (Preview environment, sensitive)",
    railway: "Railway (sealed)",
    vercelShort: "Vercel",
    railwayShort: "Railway",
  },
  production: {
    vault: "Recruiting OS Production",
    item: "Recruiting OS production database",
    vercel: "Vercel (Production environment, sensitive)",
    railway: "the production Railway worker (sealed)",
    vercelShort: "Vercel's Production environment",
    railwayShort: "the production Railway worker",
  },
};

/** The environment named by ROS_DB_ENV and ROS_DB_PROJECT_REF, or why it cannot be used. */
export function dbEnvironmentFrom(env: Record<string, string | undefined>): { ok: true; target: DbEnvironment } | { ok: false; error: string } {
  const raw = (env.ROS_DB_ENV ?? "").trim().toLowerCase();
  if (!raw) return { ok: false, error: "ROS_DB_ENV must name the database, staging or production; it is not set, so nothing was done" };
  if (raw !== "staging" && raw !== "production") return { ok: false, error: `ROS_DB_ENV must be staging or production, not "${raw.slice(0, 40)}"` };
  const given = (env.ROS_DB_PROJECT_REF ?? "").trim().toLowerCase();
  if (given && !PROJECT_REF_SHAPE.test(given)) return { ok: false, error: "ROS_DB_PROJECT_REF must be the project's reference: the lowercase letters in https://<ref>.supabase.co (Supabase, Project Settings, General, Project ID)" };
  if (raw === "staging") {
    if (given && given !== STAGING_PROJECT_REF) return { ok: false, error: `staging is the Supabase project ${STAGING_PROJECT_REF}, but ROS_DB_PROJECT_REF says ${given}` };
    return { ok: true, target: { name: "staging", projectRef: STAGING_PROJECT_REF, ...WORDS.staging } };
  }
  if (!given) return { ok: false, error: "production needs ROS_DB_PROJECT_REF: the production project's reference (Supabase, Project Settings, General, Project ID)" };
  if (given === STAGING_PROJECT_REF) return { ok: false, error: `${STAGING_PROJECT_REF} is the staging project; production is a different Supabase project with its own reference` };
  return { ok: true, target: { name: "production", projectRef: given, ...WORDS.production } };
}

/**
 * The Supabase project a connection string belongs to: from its user (postgres.<ref> on the pooler, as Supabase shows
 * it; ros_app.<ref> for an application string) or, for a direct connection, from its host (db.<ref>.supabase.co).
 * Null when the string names no project. Never touches the password.
 */
export function projectRefOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  let user = u.username;
  try {
    user = decodeURIComponent(user);
  } catch {
    // keep the raw form; a malformed escape names no project anyway
  }
  const dot = user.indexOf(".");
  if (dot > 0 && dot < user.length - 1) return user.slice(dot + 1).toLowerCase();
  const direct = /^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/i.exec(u.hostname);
  return direct ? direct[1]!.toLowerCase() : null;
}

/** Refuses a connection string from any project but the target's, before anything connects. */
export function checkProjectRef(target: DbEnvironment, url: string): { ok: true } | { ok: false; error: string } {
  const ref = projectRefOf(url);
  if (!ref) return { ok: false, error: `the connection string names no Supabase project (its user must be postgres.<project-ref>, as in the Session pooler string), so it cannot be checked against the ${target.name} project ${target.projectRef}. Nothing was changed` };
  if (ref === target.projectRef) return { ok: true };
  const which = ref === STAGING_PROJECT_REF ? `the staging project (${ref})` : `the Supabase project ${ref}`;
  return { ok: false, error: `the connection string is for ${which}, not the ${target.name} project ${target.projectRef}. Nothing was changed. Copy the Session pooler string from the ${target.name} project in Supabase` };
}

/**
 * The commands a message tells the person to run. Production is set up from Windows (scripts/db-setup.ps1); staging
 * from Windows too, or from a Mac with the bash scripts.
 */
export function commandsFor(target: DbEnvironment, platform: string = process.platform): { setup: string; grants: string; status: string } {
  if (target.name === "staging" && platform !== "win32") return { setup: "bash scripts/staging-db-setup.sh", grants: "bash scripts/staging-db-setup.sh grants", status: "bash scripts/staging-db-status.sh" };
  const args = `-Environment ${target.name} -ProjectRef ${target.projectRef}`;
  const ps = (file: string) => `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\${file} ${args}`;
  return { setup: ps("db-setup.ps1"), grants: `${ps("db-setup.ps1")} -Mode grants`, status: ps("db-status.ps1") };
}

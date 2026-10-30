import { createHash, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { connectionConfig, tlsOptionsFromEnv } from "../client";

/** Pure helpers behind provision.ts and status.ts, kept apart so they can be tested without a server. */

export const APP_ROLES = ["ros_app", "ros_worker"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Adds sslmode=verify-full unless the string already says how to handle TLS. */
export function withSsl(u: string): URL {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error("the database connection string is not a valid URL");
  }
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "verify-full");
  return url;
}

/**
 * The application role's connection string: the same host and port as the owner's (the Session pooler, whose
 * per-connection state the application relies on; see docs/runbooks/staging-database-setup.md), the role in place
 * of the owner, TLS options kept.
 */
export function roleUrl(ownerUrl: URL, role: AppRole, password: string): string {
  const u = new URL(ownerUrl.toString());
  const user = decodeURIComponent(u.username);
  u.username = user.startsWith("postgres.") ? `${role}.${user.slice("postgres.".length)}` : role;
  u.password = password;
  return u.toString();
}

/** One-connection pool with the TLS trust from the environment; the same for the owner and for verification. */
export function smallPool(url: string, env: Record<string, string | undefined> = process.env): pg.Pool {
  return new pg.Pool({ ...connectionConfig(url, tlsOptionsFromEnv(env)), max: 1 });
}

/** The Vault grant statements from packages/db/scripts/vault-grants.sql, split at the migration marker, comments removed. */
export function vaultGrantStatements(): string[] {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "vault-grants.sql");
  return readFileSync(file, "utf8")
    .split(/-->\s*statement-breakpoint/g)
    .map((s) => s.replace(/^--.*$/gm, "").trim())
    .filter(Boolean);
}

export const PASSWORD_SHAPE = /^[A-Za-z0-9]{24,}$/;

/**
 * Safety limits on the application roles' sessions (audit OPS-V1, 29 Oct 2026), set with ALTER ROLE so every session
 * either role opens gets them, whatever the code does: a stuck statement, a lock wait or a transaction left open by a
 * request or job that died ends on its own instead of holding one of the role's 15 Session pooler slots and its locks.
 * The owner, which runs the migrations, the maintenance SQL and these tools, is not affected. The values, after a
 * search of the code for long work:
 * - statement_timeout: no API statement comes near a minute (model calls never run inside a statement or a
 *   transaction: runPromptDetached and the two-phase steps); the worker's daily sweep deletes in bulk inside one
 *   platform transaction, so it gets five minutes, the length of a job's lease.
 * - lock_timeout: the locks the code takes are row locks and transaction-level advisory locks held by short
 *   transactions (slow work runs before the transaction opens; messages leave through the outbox after commit), so a
 *   wait past 15 seconds means a stuck holder: the waiting statement fails, its transaction rolls back, and the request
 *   or job is retried.
 * - idle_in_transaction_session_timeout: an API transaction waits on nothing slower than a résumé upload to storage
 *   (the apply path), and a worker step's transaction never waits on the model; two minutes and five minutes end a
 *   transaction whose request or job died mid-way (a suspended Vercel instance, a stalled worker), releasing its locks.
 */
export const LIMIT_NAMES = ["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout"] as const;
export type LimitName = (typeof LIMIT_NAMES)[number];
export const ROLE_LIMITS: Record<AppRole, Record<LimitName, string>> = {
  ros_app: { statement_timeout: "60s", lock_timeout: "15s", idle_in_transaction_session_timeout: "120s" },
  ros_worker: { statement_timeout: "300s", lock_timeout: "15s", idle_in_transaction_session_timeout: "300s" },
};

/** The ALTER ROLE statements that set the limits; safe to run again (each replaces the role's earlier value). */
export function roleLimitStatements(): string[] {
  return APP_ROLES.flatMap((role) => LIMIT_NAMES.map((name) => `ALTER ROLE ${role} SET ${name} = '${ROLE_LIMITS[role][name]}'`));
}

/** One role's limits in words, for the report. */
export function describeRoleLimits(role: AppRole): string {
  return LIMIT_NAMES.map((name) => `${name} ${ROLE_LIMITS[role][name]}`).join(", ");
}

const DURATION_UNITS_MS: Record<string, number> = { us: 0.001, ms: 1, s: 1000, min: 60_000, h: 3_600_000, d: 86_400_000 };

/** A Postgres time setting in milliseconds ("60s", "1min", "60000", "0"), or null when it is not one. */
export function durationMs(value: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/.exec(value);
  if (!m) return null;
  return Math.round(Number(m[1]) * DURATION_UNITS_MS[m[2] ?? "ms"]!);
}

/** A role's own settings from pg_roles.rolconfig ("name=value" entries). */
export function settingsFromRolconfig(rolconfig: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of rolconfig ?? []) {
    const at = entry.indexOf("=");
    if (at > 0) out[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return out;
}

/** The limits a role's settings (or a session's) lack or hold at another value; the same duration in other units counts as set. */
export function roleLimitGaps(role: AppRole, settings: Partial<Record<LimitName, string | null>>): LimitName[] {
  return LIMIT_NAMES.filter((name) => {
    const have = settings[name];
    return have == null || durationMs(have) !== durationMs(ROLE_LIMITS[role][name]);
  });
}

/** The provisioning report, one line per step, printed as it goes so an interruption still shows what happened. */
export type StepReport = { step: string; state: "done" | "skipped" | "failed"; detail: string };
export function formatStep(r: StepReport): string {
  return `provision: ${r.step}: ${r.state}${r.detail ? ` (${r.detail})` : ""}`;
}

/** Subject and SHA-256 fingerprint of a PEM certificate, for the status report's cross-check. */
export function describeCertificate(pem: string): { subject: string; fingerprint: string; validTo: string } | null {
  try {
    const c = new X509Certificate(pem);
    return { subject: c.subject.replace(/\n/g, ", "), fingerprint: c.fingerprint256, validTo: c.validTo };
  } catch {
    return null;
  }
}

export function fingerprintOfDer(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex").toUpperCase().match(/.{2}/g)!.join(":");
}

/** Which application role an already-complete connection string is for, without touching its password. */
export function applicationRoleOf(url: string): { ok: true; role: AppRole; host: string; port: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return { ok: false, error: "that is not a valid connection string" };
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { ok: false, error: "that is not a Postgres connection string" };
  const user = decodeURIComponent(u.username);
  const role = (["ros_app", "ros_worker"] as const).find((r) => user === r || user.startsWith(`${r}.`));
  if (!role) return { ok: false, error: user.startsWith("postgres") ? "that is the owner's string, not an application string; test DATABASE_URL or WORKER_DATABASE_URL" : "the user in that string is not an application role (ros_app or ros_worker)" };
  if (!u.password) return { ok: false, error: "that string carries no password" };
  return { ok: true, role, host: u.hostname, port: u.port || "5432" };
}

/** The pooler caches role credentials briefly; a fresh password can be refused for a few seconds. */
export function isTransientAuthAfterRotation(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string };
  return e.code === "28P01" || /tenant or user not found/i.test(String(e.message ?? ""));
}

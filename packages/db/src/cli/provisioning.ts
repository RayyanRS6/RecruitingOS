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

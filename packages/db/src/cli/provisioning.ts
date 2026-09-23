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
  const url = new URL(u);
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

/** The pooler caches role credentials briefly; a fresh password can be refused for a few seconds. */
export function isTransientAuthAfterRotation(err: unknown): boolean {
  const e = (err ?? {}) as { code?: string; message?: string };
  return e.code === "28P01" || /tenant or user not found/i.test(String(e.message ?? ""));
}

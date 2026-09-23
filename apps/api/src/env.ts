import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Walks up from a directory to the workspace root (the folder holding pnpm-workspace.yaml). */
function findRepoRoot(from: string): string | null {
  let dir = from;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
function moduleDir(): string | null {
  try {
    const u = import.meta.url;
    return typeof u === "string" && u.startsWith("file:") ? dirname(fileURLToPath(u)) : null;
  } catch {
    return null;
  }
}

/**
 * Relative data paths resolve against the repository root, not the process cwd, so any launcher gets the same database.
 * Bundlers (the Next.js shell, D20) rewrite import.meta.url, so an explicit ROS_REPO_ROOT or a walk up from the cwd wins.
 */
export const REPO_ROOT = process.env.ROS_REPO_ROOT ?? findRepoRoot(process.cwd()) ?? (moduleDir() ? resolve(moduleDir()!, "../../..") : process.cwd());
const fromRoot = (p: string) => (isAbsolute(p) || p.startsWith("memory://") ? p : resolve(REPO_ROOT, p));

export type Env = {
  NODE_ENV: string;
  DATABASE_URL: string | null;
  WORKER_DATABASE_URL: string | null;
  PGLITE_DIR: string;
  APP_BASE_URL: string;
  WEB_BASE_URL: string;
  SESSION_SECRET: string;
  /** "supabase" (production) or "fake" (an in-process issuer for development and tests). */
  AUTH_PROVIDER: string;
  SUPABASE_URL: string | null;
  SUPABASE_ANON_KEY: string | null;
  /** Email domains whose users are ITS staff: they must sign in with Microsoft and a second factor (D19, correction 4). */
  ITS_STAFF_EMAIL_DOMAINS: string[];
  /**
   * One-time bootstrap only (21 Sep, item 2): a listed address becomes the FIRST platform administrator on its first
   * Microsoft sign-in with a second factor, only while no administrator exists. After that the list grants nothing and
   * is audited as ignored; remove it. Platform roles live in the platform_role_grants ledger. Never a standing grant.
   */
  BOOTSTRAP_ADMIN_EMAILS: string[];
  /** The internal email magic link. On by default outside production; production defaults to off (the identity service handles email sign-in). */
  MAGIC_LINK_ENABLED: boolean;
  /** "vault" (Supabase Vault, production) or "memory" (development and tests). Never application-side cryptography (F1). */
  SECRET_STORE: string;
  AI_PROVIDER: string;
  EMAIL_PROVIDER: string;
  EMAIL_FROM_DOMAIN: string;
  /** The single sending address (F6): updates@hire.identifiedtalent.com in production. Display names name the customer's hiring team. */
  EMAIL_FROM_ADDRESS: string;
  /** Where candidate replies land until the platform inbox exists: a monitored ITS mailbox (F6). */
  EMAIL_REPLY_TO: string;
  EMAIL_INTAKE_DOMAIN: string;
  ITS_QUEUE_EMAIL: string;
  /** Internal product name used in staff-facing and owner-facing system mail; never a claim to candidates. */
  PRODUCT_NAME: string;
  /** The dedicated privacy-request address shown to candidates (founder decision, correction 7). */
  PRIVACY_EMAIL: string;
  /** memory (tests), local (development), supabase (staging and production; decision 2). */
  STORAGE_PROVIDER: string;
  STORAGE_DIR: string;
  /** "memory" (one process, local) or "shared" (several API processes share counters); see docs/readiness/15. */
  RATE_LIMIT_STORE: string;
  /** Which shared counter to use; only "fake" exists until the founder selects a provider. */
  RATE_LIMIT_SHARED_PROVIDER: string;
  RATE_LIMIT_SHARED_URL: string | null;
  /** Upstash Redis REST endpoint and token (decision 4); the token is a secret entered by the founder at the host. */
  UPSTASH_REDIS_REST_URL: string | null;
  UPSTASH_REDIS_REST_TOKEN: string | null;
  /** Per-policy limit overrides, JSON like {"api.user":5}; tests and staging rehearsals only. */
  RATE_LIMIT_OVERRIDES: Record<string, number>;
  /** How many proxies in front of the API append to X-Forwarded-For (Vercel: 1). The address that many hops from the right is the client; anything a client sends itself is ignored. */
  TRUST_PROXY_HOPS: number;
  /** Text messaging to candidates (decision M2): off until counsel, carrier registration and a partner need it. Opting out always works. */
  SMS_ENABLED: boolean;
  /** Content-security policy: "report-only" (default everywhere until staging reports are reviewed) or "enforce". */
  CSP_MODE: "report-only" | "enforce";
  WORKER_INLINE: boolean;
  WORKER_POLL_MS: number;
  PORT: number;
  raw: Record<string, string | undefined>;
};

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const get = (k: string, d: string) => source[k] ?? d;
  const env: Env = {
    NODE_ENV: get("NODE_ENV", "development"),
    DATABASE_URL: source.DATABASE_URL ?? null,
    WORKER_DATABASE_URL: source.WORKER_DATABASE_URL ?? null,
    PGLITE_DIR: fromRoot(get("PGLITE_DIR", "./.data/pglite")),
    APP_BASE_URL: get("APP_BASE_URL", "http://localhost:3001"),
    WEB_BASE_URL: get("WEB_BASE_URL", "http://localhost:5173"),
    SESSION_SECRET: get("SESSION_SECRET", "dev-only-change-me-32-bytes-minimum-please"),
    SECRET_STORE: get("SECRET_STORE", "memory"),
    AUTH_PROVIDER: get("AUTH_PROVIDER", "fake"),
    SUPABASE_URL: source.SUPABASE_URL ?? null,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY ?? null,
    ITS_STAFF_EMAIL_DOMAINS: get("ITS_STAFF_EMAIL_DOMAINS", "identifiedtalent.com").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
    BOOTSTRAP_ADMIN_EMAILS: (() => { if (source.PLATFORM_ADMIN_EMAILS) console.warn("[env] PLATFORM_ADMIN_EMAILS is no longer read and grants nothing; platform roles live in the platform_role_grants ledger. Use BOOTSTRAP_ADMIN_EMAILS once for the first administrator, then remove it."); return get("BOOTSTRAP_ADMIN_EMAILS", ""); })().split(",").map((d) => d.trim().toLowerCase()).filter(Boolean),
    MAGIC_LINK_ENABLED: get("MAGIC_LINK_ENABLED", get("NODE_ENV", "development") === "production" ? "false" : "true") === "true",
    AI_PROVIDER: get("AI_PROVIDER", "fake"),
    EMAIL_PROVIDER: get("EMAIL_PROVIDER", "fake"),
    EMAIL_FROM_DOMAIN: get("EMAIL_FROM_DOMAIN", "mail.localhost"),
    EMAIL_FROM_ADDRESS: get("EMAIL_FROM_ADDRESS", `updates@${get("EMAIL_FROM_DOMAIN", "mail.localhost")}`),
    EMAIL_REPLY_TO: get("EMAIL_REPLY_TO", get("ITS_QUEUE_EMAIL", "recruiters@its.localhost")),
    EMAIL_INTAKE_DOMAIN: get("EMAIL_INTAKE_DOMAIN", "intake.localhost"),
    ITS_QUEUE_EMAIL: get("ITS_QUEUE_EMAIL", "recruiters@its.localhost"),
    PRODUCT_NAME: get("PRODUCT_NAME", "Recruiting OS"),
    PRIVACY_EMAIL: get("PRIVACY_EMAIL", "privacy@identifiedtalent.com"),
    STORAGE_PROVIDER: get("STORAGE_PROVIDER", "local"),
    RATE_LIMIT_STORE: get("RATE_LIMIT_STORE", "memory"),
    RATE_LIMIT_SHARED_PROVIDER: get("RATE_LIMIT_SHARED_PROVIDER", "fake"),
    RATE_LIMIT_SHARED_URL: source.RATE_LIMIT_SHARED_URL ?? null,
    UPSTASH_REDIS_REST_URL: source.UPSTASH_REDIS_REST_URL ?? null,
    UPSTASH_REDIS_REST_TOKEN: source.UPSTASH_REDIS_REST_TOKEN ?? null,
    RATE_LIMIT_OVERRIDES: (() => { try { const v = JSON.parse(get("RATE_LIMIT_OVERRIDES", "{}")) as Record<string, unknown>; return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) as Record<string, number>; } catch { return {}; } })(),
    CSP_MODE: get("CSP_MODE", "report-only") === "enforce" ? "enforce" : "report-only",
    TRUST_PROXY_HOPS: Math.max(0, Number(get("TRUST_PROXY_HOPS", "1")) || 0),
    SMS_ENABLED: get("SMS_ENABLED", get("SMS_PROVIDER", "fake") === "twilio" ? "true" : "false") === "true",
    STORAGE_DIR: fromRoot(get("STORAGE_DIR", "./.data/files")),
    WORKER_INLINE: get("WORKER_INLINE", "true") !== "false",
    WORKER_POLL_MS: Number(get("WORKER_POLL_MS", "500")),
    PORT: Number(get("PORT", "3001")),
    raw: source,
  };
  if (env.NODE_ENV === "production") {
    if (env.SESSION_SECRET.startsWith("dev-only")) throw new Error("SESSION_SECRET must be set in production");
    if (env.SECRET_STORE !== "vault") throw new Error("SECRET_STORE must be \"vault\" in production: secrets live in the managed key-management service, never in application-side cryptography");
    if (env.AI_PROVIDER === "fake") throw new Error("AI_PROVIDER=fake is not allowed in production");
    if (env.AUTH_PROVIDER !== "supabase") throw new Error("AUTH_PROVIDER must be \"supabase\" in production: sign-in is delegated to the managed identity service (D19)");
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in production for sign-in");
    if (!env.DATABASE_URL && !env.WORKER_DATABASE_URL) throw new Error("DATABASE_URL (the API) or WORKER_DATABASE_URL (the worker) must be set in production");
    if (env.WORKER_INLINE) throw new Error("WORKER_INLINE must be false in production: run the worker as its own process with WORKER_DATABASE_URL");
    if (env.STORAGE_PROVIDER !== "supabase") throw new Error("STORAGE_PROVIDER must be \"supabase\" in production: résumés live in private object storage, never on a function's disk or in memory (decision 2)");
  }
  return env;
}

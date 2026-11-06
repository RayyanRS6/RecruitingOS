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
  /**
   * Which hosted deployment this is (HOST-13): staging and production both run NODE_ENV=production, so this tells them
   * apart. "production" when DEPLOY_ENV=production or on a Vercel Production deployment (VERCEL_ENV=production): the
   * strict mode, whose start-up also refuses every setting that is only right for staging. "staging" when
   * DEPLOY_ENV=staging or on a Vercel Preview deployment. null on a person's machine and in tests. Anything but
   * production keeps search engines out (robots.txt, pages/public-feeds.ts).
   */
  DEPLOY_ENV: "production" | "staging" | null;
  DATABASE_URL: string | null;
  WORKER_DATABASE_URL: string | null;
  PGLITE_DIR: string;
  /** The one public address of a deployment. The app, the API, the candidate pages and the webhooks are all served from it (the Next.js shell mounts the API in-process). */
  APP_BASE_URL: string;
  /**
   * The public job-page host (docs/spec/20 item 1; jobs.identifiedtalent.com once its domain exists): every
   * candidate-facing job URL, feed, sitemap entry, posting package and tracked link is built from it. Defaults to
   * APP_BASE_URL, so one host serves everything until the second domain is attached.
   */
  JOBS_BASE_URL: string;
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
  /**
   * "postmark" sends real email; anything else is the fake, which keeps each email in memory and reports it sent. Allowed
   * in production so staging can run before Postmark exists, but there every boot warns and one standing admin alert
   * says emails are not being sent (email-gate.ts).
   */
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
  /**
   * Where rate-limit counters live: "memory" (one process; local development), "upstash" (shared between every API
   * process; decision 4; staging and production, and the only value the production app accepts), or "fake" (an
   * in-process stand-in for the shared store; tests and rehearsals only).
   */
  RATE_LIMIT_STORE: string;
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
  /**
   * Who may create a company (GATE-V2, GAP3-2). "open" (the default; founder decision B7): anyone signed in who has no
   * company yet. "invite": a platform administrator, or an address SIGNUP_ALLOWED_EMAILS names; anyone else is refused
   * with 403 `signup_invite_only`, and the company step says so instead of showing its form. Signing in and accepting a
   * team invitation work either way. "approval" (6 November 2026): a platform administrator or an address on the list
   * goes in directly, as under "invite"; anyone else signed in may send the company form, and their company starts as a
   * request a platform administrator accepts or declines (services/access-requests.ts). Any other value is refused at
   * start-up, so a misspelling never leaves sign-up open, and the production app refuses to start without it, so leaving
   * it out never does either.
   */
  SIGNUP_MODE: "open" | "invite" | "approval";
  /** Who may still create a company directly under SIGNUP_MODE=invite or approval: full addresses and "@domain" entries (that domain only), lower-cased. */
  SIGNUP_ALLOWED_EMAILS: string[];
  /**
   * The one-time ITS check of a company that signs itself up (founder decision B7): "its" (the default, and the only
   * value production accepts) keeps the careers page, job pages, Google listing and first candidate emails waiting until
   * ITS confirms the company in the admin console; "auto" confirms every new company at once (the default under
   * NODE_ENV=test, and for local journeys that need a public page straight away). Recorded either way. A request for access
   * (SIGNUP_MODE=approval) is never confirmed by "auto": Accept confirms it.
   */
  COMPANY_CHECK: "its" | "auto";
  /**
   * The Undo window (plan G9): how many seconds a message a person sent waits in the outbox before it goes, so they can
   * take it back. 30 by default; 0 under NODE_ENV=test unless set, so tests that send and drain see it leave at once.
   */
  MESSAGE_UNDO_SECONDS: number;
  WORKER_INLINE: boolean;
  WORKER_POLL_MS: number;
  raw: Record<string, string | undefined>;
};

/** Which process is loading the environment: the app (API and pages) or the queue worker. Each needs its own database role in production. */
export type EnvRole = "app" | "worker";

/**
 * DEPLOY_ENV names the deployment; on Vercel, VERCEL_ENV says the same without it (production on a Production
 * deployment, preview on a Preview deployment, which is staging). The Railway worker has no VERCEL_ENV, so only
 * DEPLOY_ENV makes it the production worker, and loadEnv refuses a NODE_ENV=production process that neither names. A
 * contradiction between the two is refused by loadEnv, not resolved here.
 */
function deploymentOf(source: Record<string, string | undefined>): Env["DEPLOY_ENV"] {
  if (source.DEPLOY_ENV === "production" || source.VERCEL_ENV === "production") return "production";
  if (source.DEPLOY_ENV === "staging" || source.VERCEL_ENV === "preview") return "staging";
  return null;
}

/**
 * Staging's Supabase project reference, which the production deployment never names (the database tools refuse it the
 * same way: STAGING_PROJECT_REF in packages/db/src/cli/environment.ts). A copy, because this file imports nothing the
 * public welcome page would then pull in.
 */
const STAGING_SUPABASE_REF = "vjuaiyjmtrenbrmujvtc";

/** A connection string that names its own certificate file (sslrootcert), which the database client reads into its TLS trust (packages/db/src/client.ts). */
function namesRootCert(url: string | null): boolean {
  try {
    return !!url && !!new URL(url).searchParams.get("sslrootcert");
  } catch {
    return false;
  }
}

/**
 * SIGNUP_MODE as loadEnv reads it (GATE-V2): "open" when unset or empty, "invite" or "approval" when set so, and any other
 * value refused. The public welcome page reads it with this too, without starting the API's container.
 */
export function signupModeOf(source: Record<string, string | undefined>): Env["SIGNUP_MODE"] {
  const mode = source.SIGNUP_MODE ?? "";
  if (mode === "" || mode === "open") return "open";
  if (mode === "invite" || mode === "approval") return mode;
  throw new Error(`SIGNUP_MODE must be "open" or "invite" (it is ${JSON.stringify(mode)}), or "approval": "invite" lets only platform administrators and the addresses on SIGNUP_ALLOWED_EMAILS create a company; "approval" also lets anyone else signed in send a request, which a platform administrator accepts or declines; leave it unset for open sign-up`);
}

export function loadEnv(source: Record<string, string | undefined> = process.env, opts: { role?: EnvRole } = {}): Env {
  const get = (k: string, d: string) => source[k] ?? d;
  const env: Env = {
    NODE_ENV: get("NODE_ENV", "development"),
    DEPLOY_ENV: deploymentOf(source),
    DATABASE_URL: source.DATABASE_URL ?? null,
    WORKER_DATABASE_URL: source.WORKER_DATABASE_URL ?? null,
    PGLITE_DIR: fromRoot(get("PGLITE_DIR", "./.data/pglite")),
    APP_BASE_URL: get("APP_BASE_URL", "http://localhost:3000").replace(/\/+$/, ""),
    JOBS_BASE_URL: get("JOBS_BASE_URL", get("APP_BASE_URL", "http://localhost:3000")).replace(/\/+$/, ""),
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
    RATE_LIMIT_STORE: (() => {
      const store = get("RATE_LIMIT_STORE", "memory");
      if (store !== "shared") return store;
      // The earlier spelling: RATE_LIMIT_STORE=shared plus RATE_LIMIT_SHARED_PROVIDER naming the counter. Honoured, with a nudge.
      const provider = get("RATE_LIMIT_SHARED_PROVIDER", "fake");
      console.warn(`[env] RATE_LIMIT_STORE=shared with RATE_LIMIT_SHARED_PROVIDER=${provider} is the old spelling; set RATE_LIMIT_STORE=${provider} and remove RATE_LIMIT_SHARED_PROVIDER and RATE_LIMIT_SHARED_URL.`);
      return provider;
    })(),
    UPSTASH_REDIS_REST_URL: source.UPSTASH_REDIS_REST_URL ?? null,
    UPSTASH_REDIS_REST_TOKEN: source.UPSTASH_REDIS_REST_TOKEN ?? null,
    RATE_LIMIT_OVERRIDES: (() => { try { const v = JSON.parse(get("RATE_LIMIT_OVERRIDES", "{}")) as Record<string, unknown>; return Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === "number")) as Record<string, number>; } catch { return {}; } })(),
    CSP_MODE: get("CSP_MODE", "report-only") === "enforce" ? "enforce" : "report-only",
    SIGNUP_MODE: signupModeOf(source),
    SIGNUP_ALLOWED_EMAILS: get("SIGNUP_ALLOWED_EMAILS", "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    COMPANY_CHECK: get("COMPANY_CHECK", get("NODE_ENV", "development") === "test" ? "auto" : "its") === "auto" ? "auto" : "its",
    MESSAGE_UNDO_SECONDS: Math.min(120, Math.max(0, Number(get("MESSAGE_UNDO_SECONDS", get("NODE_ENV", "development") === "test" ? "0" : "30")) || 0)),
    TRUST_PROXY_HOPS: Math.max(0, Number(get("TRUST_PROXY_HOPS", "1")) || 0),
    SMS_ENABLED: get("SMS_ENABLED", get("SMS_PROVIDER", "fake") === "twilio" ? "true" : "false") === "true",
    STORAGE_DIR: fromRoot(get("STORAGE_DIR", "./.data/files")),
    WORKER_INLINE: get("WORKER_INLINE", "true") !== "false",
    WORKER_POLL_MS: Number(get("WORKER_POLL_MS", "500")),
    raw: source,
  };
  if (source.WEB_BASE_URL && source.WEB_BASE_URL.replace(/\/+$/, "") !== env.APP_BASE_URL) {
    console.warn("[env] WEB_BASE_URL is no longer read: the app and the API share one address, APP_BASE_URL. Remove WEB_BASE_URL.");
  }
  // HOST-13: the deployment's own name. A value that is neither name, or one that contradicts Vercel's, never boots.
  const deployEnv = source.DEPLOY_ENV ?? "";
  if (deployEnv !== "" && deployEnv !== "production" && deployEnv !== "staging") throw new Error(`DEPLOY_ENV must be "production" or "staging" (it is ${JSON.stringify(deployEnv)}); leave it unset on a person's machine and in tests`);
  if (deployEnv === "staging" && source.VERCEL_ENV === "production") throw new Error("DEPLOY_ENV=staging is set on a Vercel Production deployment (VERCEL_ENV=production), and production is never staging: remove DEPLOY_ENV from the Production environment's variables, or set it to production");
  if (deployEnv === "production" && source.VERCEL_ENV === "preview") throw new Error("DEPLOY_ENV=production is set on a Vercel Preview deployment (VERCEL_ENV=preview), which is staging: set DEPLOY_ENV=production in the Production environment's variables only");
  if (env.DEPLOY_ENV === "production" && env.NODE_ENV !== "production") throw new Error(`NODE_ENV must be "production" on the production deployment (it is "${env.NODE_ENV}"): DEPLOY_ENV=production or VERCEL_ENV=production says this is production, and every production check keys on NODE_ENV`);
  // GATE-V2: an allow-list entry that is neither a full address nor "@domain" would quietly match nobody, and a list set
  // while sign-up is open lets everyone in all the same.
  const notAnEntry = env.SIGNUP_ALLOWED_EMAILS.find((e) => !/^[^\s@]*@[^\s@.]+(?:\.[^\s@.]+)+$/.test(e));
  if (notAnEntry !== undefined) throw new Error(`SIGNUP_ALLOWED_EMAILS takes full addresses and "@domain" entries, comma-separated (${JSON.stringify(notAnEntry)} is neither): write "@example.com" for everyone at example.com`);
  if (env.SIGNUP_ALLOWED_EMAILS.length && env.SIGNUP_MODE === "open") console.warn("[env] SIGNUP_ALLOWED_EMAILS is set but SIGNUP_MODE is not \"invite\", so anyone signed in may still create a company. Set SIGNUP_MODE=invite or approval to use the list, or remove it.");
  const role = opts.role ?? "app";
  if (env.NODE_ENV === "production") {
    if (env.SESSION_SECRET.startsWith("dev-only")) throw new Error("SESSION_SECRET must be set in production");
    if (!/^https:\/\/[^/]+$/.test(env.APP_BASE_URL)) throw new Error("APP_BASE_URL must be the deployment's https origin in production (for example https://app.example.com), with no path");
    if (source.JOBS_BASE_URL && !/^https:\/\/[^/]+$/.test(env.JOBS_BASE_URL)) throw new Error("JOBS_BASE_URL must be the public job-page https origin in production (for example https://jobs.example.com), with no path");
    if (!source.ANALYTICS_SALT) throw new Error("ANALYTICS_SALT must be set in production: analytics identifiers are keyed hashes and must never use the development salt");
    if (env.SECRET_STORE !== "vault") throw new Error("SECRET_STORE must be \"vault\" in production: secrets live in the managed key-management service, never in application-side cryptography");
    if (env.AI_PROVIDER === "fake") throw new Error("AI_PROVIDER=fake is not allowed in production");
    if (env.AUTH_PROVIDER !== "supabase") throw new Error("AUTH_PROVIDER must be \"supabase\" in production: sign-in is delegated to the managed identity service (D19)");
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set in production for sign-in");
    // H7: each process names its own database role, and nothing in production may fall back to PGlite, the in-process
    // development database (no durability, a superuser role, a directory on a function's disk).
    if (role === "app" && !env.DATABASE_URL) throw new Error("DATABASE_URL must be set in production for the app (the ros_app connection string). Without it the process would open PGlite, the in-process development database, which production refuses.");
    if (role === "worker" && !env.WORKER_DATABASE_URL) throw new Error("WORKER_DATABASE_URL must be set in production for the worker (the ros_worker connection string, a separate non-privileged role). Without it the process would open PGlite, the in-process development database, which production refuses.");
    if (env.WORKER_INLINE) throw new Error("WORKER_INLINE must be false in production: run the worker as its own process with WORKER_DATABASE_URL");
    if (env.STORAGE_PROVIDER !== "supabase") throw new Error("STORAGE_PROVIDER must be \"supabase\" in production: résumés live in private object storage, never on a function's disk or in memory (decision 2)");
    // Decision 4: on Vercel's many short-lived instances a per-process count is close to no limit, so the app needs the
    // shared store. At run time an unreachable Upstash still degrades to per-process counting with an alert (packages/core rate-limit.ts).
    // The worker answers no request and counts none, so a missing Upstash value never stops the queue; it may not use the test stand-in.
    if (role === "app" && env.RATE_LIMIT_STORE !== "upstash") throw new Error(`RATE_LIMIT_STORE must be "upstash" in production (it is "${env.RATE_LIMIT_STORE}"): "memory" counts in one process only and "fake" is a test stand-in. Set RATE_LIMIT_STORE=upstash with UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (docs/runbooks/staging-environment-variables.md)`);
    if (role === "app" && (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN)) throw new Error("RATE_LIMIT_STORE=upstash needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in production: the database's REST endpoint and its token (docs/runbooks/staging-environment-variables.md)");
    if (env.RATE_LIMIT_STORE === "fake") throw new Error("RATE_LIMIT_STORE=fake is a test stand-in; production uses \"upstash\" (the worker may also use \"memory\")");
    if (env.COMPANY_CHECK !== "its") throw new Error("COMPANY_CHECK=auto is not allowed in production: every company that signs itself up waits for the one-time ITS check before anything is public (founder decision B7)");
    // HOST-13: every hosted process knows which deployment it is. Vercel says so itself (VERCEL_ENV); the Railway worker
    // has only DEPLOY_ENV, and unnamed, the production worker would start under staging's rules without a word.
    if (!env.DEPLOY_ENV) throw new Error("DEPLOY_ENV must be \"production\" or \"staging\" under NODE_ENV=production when VERCEL_ENV does not name the deployment (the Railway worker has no VERCEL_ENV): set DEPLOY_ENV=production on the production worker and DEPLOY_ENV=staging on the staging worker");
  }
  // The production deployment (HOST-13, SEC-10, MAIL-9, SEC-V1) also refuses what staging may still run on: fake email,
  // the fake scanner, .localhost addresses, a database connection without TLS, and the switches kept for tests and
  // staging rehearsals. Staging (NODE_ENV=production on a Preview deployment) never reaches these and boots as before.
  if (env.DEPLOY_ENV === "production") {
    if (env.EMAIL_PROVIDER !== "postmark") throw new Error(`EMAIL_PROVIDER must be "postmark" on the production deployment (it is "${env.EMAIL_PROVIDER}"): the fake keeps every email in memory and reports it sent`);
    if (!source.POSTMARK_SERVER_TOKEN) throw new Error("POSTMARK_SERVER_TOKEN must be set on the production deployment: without the Postmark server's token no email can be sent");
    // Only the app answers Postmark's webhooks (webhooks/postmark.ts); the worker sends but never reads the secret.
    if (role === "app" && !source.POSTMARK_WEBHOOK_SECRET) throw new Error("POSTMARK_WEBHOOK_SECRET must be set on the production deployment: without it the app refuses Postmark's bounce, complaint and delivery reports");
    // Both webhook secrets are passwords the application makes up, as long as the session secret: a forged bounce or
    // complaint would put a candidate on the do-not-send list, and the inbound one admits email into the product.
    if (role === "app" && (source.POSTMARK_WEBHOOK_SECRET ?? "").length < 32) throw new Error("POSTMARK_WEBHOOK_SECRET must be at least 32 characters on the production deployment: generate one for production (scripts/new-secret.ps1), never staging's, and enter the same value as the webhook's password in Postmark");
    if (source.POSTMARK_INBOUND_SECRET && source.POSTMARK_INBOUND_SECRET.length < 32) throw new Error("POSTMARK_INBOUND_SECRET must be at least 32 characters on the production deployment when it is set: generate one for production (scripts/new-secret.ps1), never staging's");
    // Each is set by hand, never left to the fallback a person's machine uses (EMAIL_REPLY_TO is the contact printed on
    // job pages). EMAIL_INTAKE_DOMAIN may end in localhost: that is how inbound email stays off (registry.ts, emailInConfigured).
    for (const [name, fallback] of [["EMAIL_FROM_ADDRESS", "updates@<EMAIL_FROM_DOMAIN>"], ["EMAIL_REPLY_TO", "ITS_QUEUE_EMAIL"], ["ITS_QUEUE_EMAIL", "recruiters@its.localhost"]] as const) {
      const value = source[name];
      if (!value) throw new Error(`${name} must be set on the production deployment to a real mailbox, not left to its fallback (${fallback})`);
      if (/localhost>?$/i.test(value.trim())) throw new Error(`${name} must be a real mailbox on the production deployment, not a localhost address (it is "${value}")`);
    }
    if (!source.DATABASE_SSL_CA?.trim() && !source.DATABASE_SSL_CA_FILE?.trim() && !namesRootCert(role === "worker" ? env.WORKER_DATABASE_URL : env.DATABASE_URL)) throw new Error("DATABASE_SSL_CA must be set on the production deployment (the text of the Supabase CA certificate; DATABASE_SSL_CA_FILE or an sslrootcert in the connection string also do): without a certificate the database connection is made without TLS");
    if (env.AI_PROVIDER === "anthropic" && !source.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY must be set on the production deployment with AI_PROVIDER=anthropic: without it every AI call fails");
    if (source.SENTRY_ENVIRONMENT === "staging") throw new Error("SENTRY_ENVIRONMENT=staging is not allowed on the production deployment: errors would be reported as staging's and the staging-only test-error route would open. Set it to production, or remove it");
    if (source.RATE_LIMIT_OVERRIDES) throw new Error("RATE_LIMIT_OVERRIDES must not be set on the production deployment: per-policy limit overrides are for tests and staging rehearsals. Remove it");
    if (source.COOKIE_DOMAIN) throw new Error("COOKIE_DOMAIN must not be set on the production deployment: the session cookie stays host-only, so no other host under the domain receives it. Remove it");
    if (env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters on the production deployment: generate one for production (openssl rand -base64 48), never staging's");
    if ((source.ANALYTICS_SALT ?? "").length < 32) throw new Error("ANALYTICS_SALT must be at least 32 characters on the production deployment: generate one for production (openssl rand -base64 48), never staging's");
    // Only the worker scans files (the quarantine step); the app never does.
    if (role === "worker" && (source.SCAN_PROVIDER !== "clamav" || !source.CLAMAV_HOST)) throw new Error(`SCAN_PROVIDER must be "clamav" with CLAMAV_HOST on the production worker (SCAN_PROVIDER is "${source.SCAN_PROVIDER ?? "fake"}"${source.CLAMAV_HOST ? "" : ", CLAMAV_HOST is not set"}): the fake scanner checks a file's type, never for malware (docs/runbooks/resume-storage.md, "Running ClamAV on Railway")`);
    // A value copied from staging would sign people in through staging's project and write real data into its database.
    // Only the variable's name and the project reference are named: a connection string carries a password.
    for (const name of ["SUPABASE_URL", "DATABASE_URL", "WORKER_DATABASE_URL", "STORAGE_S3_ENDPOINT"] as const) {
      if (source[name]?.toLowerCase().includes(STAGING_SUPABASE_REF)) throw new Error(`${name} names staging's Supabase project (${STAGING_SUPABASE_REF}) on the production deployment: production has a project of its own; copy the value from it`);
    }
    // GATE-V2: who may open a company is decided on purpose on the production app, never left to the default (open).
    if (role === "app" && !source.SIGNUP_MODE) throw new Error("SIGNUP_MODE must be set on the production deployment: \"invite\" (only platform administrators and the addresses on SIGNUP_ALLOWED_EMAILS open a company) or \"approval\" (anyone else signed in sends a request, which a platform administrator accepts or declines) until trials open, then \"open\"");
    // The internal email link opens sessions outside the identity service and the checks made on its sign-ins.
    if (env.MAGIC_LINK_ENABLED) throw new Error("MAGIC_LINK_ENABLED must not be true on the production deployment: the identity service handles sign-in, and the internal email link would open sessions outside its checks. Remove it");
    // Needed once, for the first administrator's first sign-in, so a warning on every start rather than a refusal.
    if (env.BOOTSTRAP_ADMIN_EMAILS.length) console.warn("[env] WARNING: BOOTSTRAP_ADMIN_EMAILS is set on the production deployment. It is for the first administrator's first sign-in only: remove it as soon as that administrator exists (docs/readiness/13-administrator-bootstrap.md).");
  }
  return env;
}

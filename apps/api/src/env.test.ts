import { describe, expect, it, vi } from "vitest";
import { loadEnv, type EnvRole } from "./env";

/**
 * Audit remediation H7: in production each process names its own database role, and nothing falls back to PGlite.
 * These checks hold for staging and production alike, so the process here is named staging (every NODE_ENV=production
 * process names its deployment; the production deployment's own checks are below).
 */
describe("production boot checks", () => {
  const base = { NODE_ENV: "production", DEPLOY_ENV: "staging", APP_BASE_URL: "https://app.example.test", ANALYTICS_SALT: "salt-for-this-test-only", SESSION_SECRET: "x".repeat(40), SECRET_STORE: "vault", AI_PROVIDER: "anthropic", AUTH_PROVIDER: "supabase", SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "k", WORKER_INLINE: "false", STORAGE_PROVIDER: "supabase", RATE_LIMIT_STORE: "upstash", UPSTASH_REDIS_REST_URL: "https://complete-narwhal-292092.upstash.io", UPSTASH_REDIS_REST_TOKEN: "upstash-token-for-tests-abcdefghij" };
  const appUrl = "postgres://ros_app:pw@host/db";
  const workerUrl = "postgres://ros_worker:pw@host/db";

  it("the app needs DATABASE_URL and is told PGlite is what it would otherwise get", () => {
    expect(() => loadEnv({ ...base })).toThrow(/DATABASE_URL must be set in production for the app/);
    expect(() => loadEnv({ ...base })).toThrow(/PGlite/);
    // the worker's string is not the app's
    expect(() => loadEnv({ ...base, WORKER_DATABASE_URL: workerUrl }, { role: "app" })).toThrow(/DATABASE_URL must be set in production for the app/);
    expect(loadEnv({ ...base, DATABASE_URL: appUrl }).DATABASE_URL).toBe(appUrl);
    expect(loadEnv({ ...base, DATABASE_URL: appUrl }, { role: "app" }).WORKER_DATABASE_URL).toBeNull();
  });

  it("the worker needs WORKER_DATABASE_URL, its own non-privileged role, and never the app's string", () => {
    expect(() => loadEnv({ ...base, DATABASE_URL: appUrl }, { role: "worker" })).toThrow(/WORKER_DATABASE_URL must be set in production for the worker/);
    expect(() => loadEnv({ ...base }, { role: "worker" })).toThrow(/PGlite/);
    const env = loadEnv({ ...base, WORKER_DATABASE_URL: workerUrl }, { role: "worker" });
    expect(env.WORKER_DATABASE_URL).toBe(workerUrl);
    expect(env.DATABASE_URL).toBeNull();
  });

  it("outside production neither string is required and PGlite is the default", () => {
    expect(loadEnv({ NODE_ENV: "development" }, { role: "worker" }).DATABASE_URL).toBeNull();
    expect(loadEnv({ NODE_ENV: "test" }).PGLITE_DIR).toMatch(/pglite$/);
  });

  it("the other production refusals still hold", () => {
    const prod = { ...base, DATABASE_URL: appUrl };
    expect(() => loadEnv({ ...prod, WORKER_INLINE: "true" })).toThrow(/WORKER_INLINE/);
    expect(() => loadEnv({ ...prod, STORAGE_PROVIDER: "local" })).toThrow(/STORAGE_PROVIDER/);
    expect(() => loadEnv({ ...prod, RATE_LIMIT_STORE: "fake" })).toThrow(/RATE_LIMIT_STORE/);
    expect(() => loadEnv({ ...prod, SECRET_STORE: "memory" })).toThrow(/SECRET_STORE/);
    expect(() => loadEnv({ ...prod, AI_PROVIDER: "fake" })).toThrow(/AI_PROVIDER/);
  });

  // Security review: per-process counting on Vercel's many short-lived instances is close to no limit, so production needs the shared store.
  it("the production app refuses any rate-limit store but upstash, and upstash without its address or token", () => {
    const prod = { ...base, DATABASE_URL: appUrl };
    expect(() => loadEnv({ ...prod, RATE_LIMIT_STORE: "memory" })).toThrow(/RATE_LIMIT_STORE must be "upstash" in production \(it is "memory"\)/);
    expect(() => loadEnv({ ...prod, RATE_LIMIT_STORE: "memory" })).toThrow(/staging-environment-variables\.md/);
    // unset is the development default, memory, and is refused the same way
    expect(() => loadEnv({ ...prod, RATE_LIMIT_STORE: undefined })).toThrow(/RATE_LIMIT_STORE must be "upstash"/);
    expect(() => loadEnv({ ...prod, RATE_LIMIT_STORE: "fake" })).toThrow(/RATE_LIMIT_STORE must be "upstash" in production \(it is "fake"\)/);
    expect(() => loadEnv({ ...prod, UPSTASH_REDIS_REST_URL: undefined })).toThrow(/UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN/);
    expect(() => loadEnv({ ...prod, UPSTASH_REDIS_REST_TOKEN: undefined })).toThrow(/UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN/);
    // the old spelling still resolves to the shared store
    expect(loadEnv({ ...prod, RATE_LIMIT_STORE: "shared", RATE_LIMIT_SHARED_PROVIDER: "upstash" }).RATE_LIMIT_STORE).toBe("upstash");
    expect(loadEnv(prod).RATE_LIMIT_STORE).toBe("upstash");
  });

  it("the production worker counts no requests: a missing Upstash value never stops the queue, the test stand-in still does", () => {
    const worker = { ...base, WORKER_DATABASE_URL: "postgres://ros_worker:pw@host/db" };
    // Railway sets the shared store too (docs/runbooks/railway-worker.md)
    expect(loadEnv(worker, { role: "worker" }).RATE_LIMIT_STORE).toBe("upstash");
    expect(loadEnv({ ...worker, RATE_LIMIT_STORE: "memory" }, { role: "worker" }).RATE_LIMIT_STORE).toBe("memory");
    expect(loadEnv({ ...worker, RATE_LIMIT_STORE: undefined, UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined }, { role: "worker" }).RATE_LIMIT_STORE).toBe("memory");
    expect(() => loadEnv({ ...worker, RATE_LIMIT_STORE: "fake" }, { role: "worker" })).toThrow(/RATE_LIMIT_STORE=fake is a test stand-in/);
  });

  it("outside production memory stays the default and fake stays available for tests", () => {
    expect(loadEnv({ NODE_ENV: "development" }).RATE_LIMIT_STORE).toBe("memory");
    expect(loadEnv({ NODE_ENV: "development", RATE_LIMIT_STORE: "memory" }).RATE_LIMIT_STORE).toBe("memory");
    expect(loadEnv({ NODE_ENV: "test", RATE_LIMIT_STORE: "fake" }).RATE_LIMIT_STORE).toBe("fake");
    // upstash outside production needs no address at load time; the store itself refuses to be built without one
    expect(loadEnv({ NODE_ENV: "development", RATE_LIMIT_STORE: "upstash" }).RATE_LIMIT_STORE).toBe("upstash");
  });
});

/**
 * HOST-13, SEC-10, MAIL-9, SEC-V1: staging and production both run NODE_ENV=production. DEPLOY_ENV, or Vercel's own
 * VERCEL_ENV, tells them apart, and the production deployment also refuses what staging may still run on.
 */
describe("the production deployment's own checks (DEPLOY_ENV)", () => {
  // staging as it runs today: a Vercel Preview deployment with fake email, the fake scanner, the fallback addresses, no
  // certificate, a short secret and salt, and its Sentry marker
  const staging: Record<string, string | undefined> = { NODE_ENV: "production", VERCEL_ENV: "preview", APP_BASE_URL: "https://staging.example.test", DATABASE_URL: "postgres://ros_app:pw@host/db", ANALYTICS_SALT: "salt-for-this-test-only", SESSION_SECRET: "a-short-staging-secret", SECRET_STORE: "vault", AI_PROVIDER: "anthropic", AUTH_PROVIDER: "supabase", SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "k", WORKER_INLINE: "false", STORAGE_PROVIDER: "supabase", RATE_LIMIT_STORE: "upstash", UPSTASH_REDIS_REST_URL: "https://complete-narwhal-292092.upstash.io", UPSTASH_REDIS_REST_TOKEN: "upstash-token-for-tests-abcdefghij", EMAIL_PROVIDER: "fake", SCAN_PROVIDER: "fake", SENTRY_ENVIRONMENT: "staging" };
  // the production app on a Vercel Production deployment, with every value the production deployment asks for
  const production = { ...staging, VERCEL_ENV: "production", APP_BASE_URL: "https://hire.example.test", SESSION_SECRET: "x".repeat(40), ANALYTICS_SALT: "s".repeat(40), SENTRY_ENVIRONMENT: "production", EMAIL_PROVIDER: "postmark", POSTMARK_SERVER_TOKEN: "postmark-server-token-for-tests", POSTMARK_WEBHOOK_SECRET: "postmark-webhook-secret-for-tests", EMAIL_FROM_ADDRESS: "updates@hire.example.test", EMAIL_REPLY_TO: "recruiting@example.test", ITS_QUEUE_EMAIL: "recruiting@example.test", DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\nthe CA\n-----END CERTIFICATE-----\n", ANTHROPIC_API_KEY: "anthropic-key-for-tests", SIGNUP_MODE: "invite" };
  // the production worker on Railway: no VERCEL_ENV, so DEPLOY_ENV says it; its own connection string, ClamAV, no webhook secret, no sign-up mode
  const worker = { ...production, VERCEL_ENV: undefined, DEPLOY_ENV: "production", DATABASE_URL: undefined, WORKER_DATABASE_URL: "postgres://ros_worker:pw@host/db", POSTMARK_WEBHOOK_SECRET: undefined, SCAN_PROVIDER: "clamav", CLAMAV_HOST: "clamav.railway.internal", SIGNUP_MODE: undefined };
  /** The refusal's message, or null when the environment loads. */
  const refusal = (source: Record<string, string | undefined>, role?: EnvRole): string | null => {
    try {
      loadEnv(source, { role });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  it("tells the deployments apart by DEPLOY_ENV or Vercel's VERCEL_ENV, and names none on a person's machine or in tests", () => {
    expect(loadEnv({ NODE_ENV: "development" }).DEPLOY_ENV).toBeNull();
    expect(loadEnv({ NODE_ENV: "test" }).DEPLOY_ENV).toBeNull();
    expect(loadEnv({ NODE_ENV: "development", VERCEL_ENV: "development" }).DEPLOY_ENV).toBeNull();
    expect(loadEnv({ NODE_ENV: "development", DEPLOY_ENV: "" }).DEPLOY_ENV).toBeNull(); // empty is unset
    expect(loadEnv({ NODE_ENV: "development", DEPLOY_ENV: "staging" }).DEPLOY_ENV).toBe("staging");
    expect(loadEnv(staging).DEPLOY_ENV).toBe("staging");
    expect(loadEnv({ ...staging, VERCEL_ENV: undefined, DEPLOY_ENV: "staging" }).DEPLOY_ENV).toBe("staging");
    expect(loadEnv(production).DEPLOY_ENV).toBe("production");
    expect(loadEnv({ ...production, DEPLOY_ENV: "production" }).DEPLOY_ENV).toBe("production");
    expect(loadEnv({ ...production, VERCEL_ENV: undefined, DEPLOY_ENV: "production" }).DEPLOY_ENV).toBe("production");
    expect(loadEnv(worker, { role: "worker" }).DEPLOY_ENV).toBe("production");
  });

  it("refuses a DEPLOY_ENV that is neither name, one that contradicts Vercel's, and production without NODE_ENV=production", () => {
    for (const value of ["prod", "Production", "preview", "staging "]) expect(refusal({ NODE_ENV: "development", DEPLOY_ENV: value }), value).toMatch(/^DEPLOY_ENV must be "production" or "staging" \(it is ".+"\)/);
    expect(refusal({ ...production, DEPLOY_ENV: "staging" })).toMatch(/^DEPLOY_ENV=staging is set on a Vercel Production deployment/);
    expect(refusal({ ...staging, DEPLOY_ENV: "production" })).toMatch(/^DEPLOY_ENV=production is set on a Vercel Preview deployment/);
    expect(refusal({ NODE_ENV: "development", DEPLOY_ENV: "production" })).toMatch(/^NODE_ENV must be "production" on the production deployment \(it is "development"\)/);
    expect(refusal({ NODE_ENV: "test", VERCEL_ENV: "production" })).toMatch(/^NODE_ENV must be "production" on the production deployment \(it is "test"\)/);
    expect(refusal({ ...worker, NODE_ENV: undefined }, "worker")).toMatch(/^NODE_ENV must be "production"/);
  });

  it("refuses a NODE_ENV=production process that neither DEPLOY_ENV nor VERCEL_ENV names, so a production worker never runs under staging's rules", () => {
    const unnamed = /^DEPLOY_ENV must be "production" or "staging" under NODE_ENV=production when VERCEL_ENV does not name the deployment/;
    // the production worker without its name, on everything staging may still run on: refused, not started as staging
    expect(refusal({ ...worker, DEPLOY_ENV: undefined, EMAIL_PROVIDER: "fake", SCAN_PROVIDER: "fake", POSTMARK_SERVER_TOKEN: undefined, DATABASE_SSL_CA: undefined }, "worker")).toMatch(unnamed);
    expect(refusal({ ...worker, DEPLOY_ENV: undefined }, "worker")).toMatch(unnamed);
    expect(refusal({ ...worker, DEPLOY_ENV: "" }, "worker")).toMatch(unnamed);
    // the app the same, wherever VERCEL_ENV is missing or names neither deployment
    expect(refusal({ ...staging, VERCEL_ENV: undefined })).toMatch(unnamed);
    expect(refusal({ ...staging, VERCEL_ENV: "development" })).toMatch(unnamed);
    // named either way, each starts
    expect(refusal({ ...staging, VERCEL_ENV: undefined, DEPLOY_ENV: "staging" })).toBeNull();
    expect(refusal(worker, "worker")).toBeNull();
    // a person's machine and the tests name nothing and need not
    expect(refusal({ NODE_ENV: "development" }, "worker")).toBeNull();
    expect(refusal({ NODE_ENV: "test" })).toBeNull();
  });

  it("staging boots exactly as today, and so do a person's machine and the tests", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rehearsal = { ...staging, RATE_LIMIT_OVERRIDES: '{"api.user":50}', COOKIE_DOMAIN: ".example.test", BOOTSTRAP_ADMIN_EMAILS: "first@example.test", MAGIC_LINK_ENABLED: "true" };
      const env = loadEnv(rehearsal);
      expect(env).toMatchObject({ DEPLOY_ENV: "staging", EMAIL_PROVIDER: "fake", EMAIL_FROM_ADDRESS: "updates@mail.localhost", EMAIL_REPLY_TO: "recruiters@its.localhost", ITS_QUEUE_EMAIL: "recruiters@its.localhost", RATE_LIMIT_OVERRIDES: { "api.user": 50 }, MAGIC_LINK_ENABLED: true, SIGNUP_MODE: "open" });
      expect(refusal({ ...rehearsal, DEPLOY_ENV: "staging" })).toBeNull();
      // staging's own Supabase project, a short webhook secret: staging's to keep
      const ref = "vjuaiyjmtrenbrmujvtc";
      expect(refusal({ ...rehearsal, SUPABASE_URL: `https://${ref}.supabase.co`, DATABASE_URL: `postgres://ros_app.${ref}:pw@aws-0-us-west-2.pooler.supabase.com:5432/postgres`, STORAGE_S3_ENDPOINT: `https://${ref}.storage.supabase.co/storage/v1/s3`, POSTMARK_WEBHOOK_SECRET: "short" })).toBeNull();
      // the staging worker on Railway: no VERCEL_ENV, so DEPLOY_ENV=staging names it (unnamed it is refused, below); the fake scanner, as before
      const stagingWorker = { ...rehearsal, VERCEL_ENV: undefined, DEPLOY_ENV: "staging", DATABASE_URL: undefined, WORKER_DATABASE_URL: "postgres://ros_worker:pw@host/db" };
      expect(loadEnv(stagingWorker, { role: "worker" }).DEPLOY_ENV).toBe("staging");
      expect(refusal(stagingWorker, "worker")).toBeNull();
      // the bootstrap warning is the production deployment's alone
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("BOOTSTRAP_ADMIN_EMAILS"));
      expect(refusal({ NODE_ENV: "development", EMAIL_PROVIDER: "fake", COOKIE_DOMAIN: ".example.test" })).toBeNull();
      expect(refusal({ NODE_ENV: "test", RATE_LIMIT_OVERRIDES: '{"api.user":5}', SESSION_SECRET: "short" })).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("the production deployment boots with every value it asks for, the app and the worker alike", () => {
    expect(refusal(production)).toBeNull();
    expect(refusal({ ...production, VERCEL_ENV: undefined, DEPLOY_ENV: "production" })).toBeNull();
    expect(refusal(worker, "worker")).toBeNull();
    // inbound email may stay off: EMAIL_INTAKE_DOMAIN still ends in localhost
    expect(loadEnv({ ...production, EMAIL_INTAKE_DOMAIN: "intake.localhost" }).EMAIL_INTAKE_DOMAIN).toBe("intake.localhost");
    // the certificate as a file path, or named in the process's own connection string
    expect(refusal({ ...production, DATABASE_SSL_CA: undefined, DATABASE_SSL_CA_FILE: "/etc/ssl/supabase-ca.crt" })).toBeNull();
    expect(refusal({ ...production, DATABASE_SSL_CA: undefined, DATABASE_URL: "postgres://ros_app:pw@host/db?sslrootcert=/etc/ssl/supabase-ca.crt" })).toBeNull();
    expect(refusal({ ...worker, DATABASE_SSL_CA: undefined, WORKER_DATABASE_URL: "postgres://ros_worker:pw@host/db?sslrootcert=/etc/ssl/supabase-ca.crt" }, "worker")).toBeNull();
    // 32 characters is enough
    expect(refusal({ ...production, SESSION_SECRET: "y".repeat(32), ANALYTICS_SALT: "z".repeat(32) })).toBeNull();
  });

  it("refuses fake email, Postmark without its token or the app without the webhook secret, and fallback or localhost addresses", () => {
    for (const p of [production, { ...production, VERCEL_ENV: undefined, DEPLOY_ENV: "production" }]) {
      expect(refusal({ ...p, EMAIL_PROVIDER: "fake" })).toMatch(/^EMAIL_PROVIDER must be "postmark" on the production deployment \(it is "fake"\)/);
      expect(refusal({ ...p, EMAIL_PROVIDER: undefined })).toMatch(/^EMAIL_PROVIDER must be "postmark"/);
    }
    expect(refusal({ ...worker, EMAIL_PROVIDER: "fake" }, "worker")).toMatch(/^EMAIL_PROVIDER must be "postmark"/);
    expect(refusal({ ...production, POSTMARK_SERVER_TOKEN: undefined })).toMatch(/^POSTMARK_SERVER_TOKEN must be set on the production deployment/);
    expect(refusal({ ...worker, POSTMARK_SERVER_TOKEN: undefined }, "worker")).toMatch(/^POSTMARK_SERVER_TOKEN must be set/);
    expect(refusal({ ...production, POSTMARK_WEBHOOK_SECRET: undefined })).toMatch(/^POSTMARK_WEBHOOK_SECRET must be set on the production deployment/);
    for (const name of ["EMAIL_FROM_ADDRESS", "EMAIL_REPLY_TO", "ITS_QUEUE_EMAIL"]) {
      expect(refusal({ ...production, [name]: undefined }), name).toMatch(new RegExp(`^${name} must be set on the production deployment to a real mailbox, not left to its fallback`));
      expect(refusal({ ...production, [name]: "" }), name).toMatch(new RegExp(`^${name} must be set`));
      expect(refusal({ ...worker, [name]: undefined }, "worker"), name).toMatch(new RegExp(`^${name} must be set`));
      for (const local of ["updates@mail.localhost", "recruiters@its.localhost", "someone@localhost", "Someone@Its.LOCALHOST "]) expect(refusal({ ...production, [name]: local }), `${name}=${local}`).toMatch(new RegExp(`^${name} must be a real mailbox on the production deployment, not a localhost address`));
    }
    // a real sending domain or queue mailbox does not stand in for an address set by hand
    expect(refusal({ ...production, EMAIL_FROM_DOMAIN: "hire.example.test", EMAIL_FROM_ADDRESS: undefined })).toMatch(/^EMAIL_FROM_ADDRESS must be set/);
    expect(refusal({ ...production, EMAIL_REPLY_TO: undefined })).toMatch(/^EMAIL_REPLY_TO must be set .*\(ITS_QUEUE_EMAIL\)$/);
  });

  it("refuses a database connection without a certificate, and Anthropic without its key", () => {
    expect(refusal({ ...production, DATABASE_SSL_CA: undefined })).toMatch(/^DATABASE_SSL_CA must be set on the production deployment .*without a certificate the database connection is made without TLS$/);
    expect(refusal({ ...production, DATABASE_SSL_CA: "  " })).toMatch(/^DATABASE_SSL_CA must be set/);
    expect(refusal({ ...worker, DATABASE_SSL_CA: undefined }, "worker")).toMatch(/^DATABASE_SSL_CA must be set/);
    // the worker's own connection string counts, not the app's
    expect(refusal({ ...worker, DATABASE_SSL_CA: undefined, DATABASE_URL: "postgres://ros_app:pw@host/db?sslrootcert=/ca.crt" }, "worker")).toMatch(/^DATABASE_SSL_CA must be set/);
    expect(refusal({ ...production, ANTHROPIC_API_KEY: undefined })).toMatch(/^ANTHROPIC_API_KEY must be set on the production deployment with AI_PROVIDER=anthropic/);
    expect(refusal({ ...worker, ANTHROPIC_API_KEY: undefined }, "worker")).toMatch(/^ANTHROPIC_API_KEY must be set/);
  });

  it("refuses the staging marker, rehearsal limits, a cookie domain and a short secret or salt, without printing the secret", () => {
    expect(refusal({ ...production, SENTRY_ENVIRONMENT: "staging" })).toMatch(/^SENTRY_ENVIRONMENT=staging is not allowed on the production deployment/);
    expect(refusal({ ...production, SENTRY_ENVIRONMENT: undefined })).toBeNull();
    expect(refusal({ ...production, RATE_LIMIT_OVERRIDES: '{"api.user":50}' })).toMatch(/^RATE_LIMIT_OVERRIDES must not be set on the production deployment/);
    expect(refusal({ ...production, RATE_LIMIT_OVERRIDES: "{}" })).toMatch(/^RATE_LIMIT_OVERRIDES must not be set/);
    expect(refusal({ ...production, COOKIE_DOMAIN: ".example.test" })).toMatch(/^COOKIE_DOMAIN must not be set on the production deployment/);
    const short = "Sh0rt-but-secret-value-31-chars";
    expect(short).toHaveLength(31);
    for (const name of ["SESSION_SECRET", "ANALYTICS_SALT"]) {
      const message = refusal({ ...production, [name]: short });
      expect(message, name).toMatch(new RegExp(`^${name} must be at least 32 characters on the production deployment`));
      expect(message, name).not.toContain(short);
    }
    expect(refusal({ ...worker, SESSION_SECRET: short }, "worker")).toMatch(/^SESSION_SECRET must be at least 32 characters/);
  });

  it("refuses a Postmark webhook secret under 32 characters on the app, and an inbound one whenever it is set, without printing either", () => {
    const short = "Sh0rt-but-secret-value-31-chars";
    for (const name of ["POSTMARK_WEBHOOK_SECRET", "POSTMARK_INBOUND_SECRET"]) {
      const message = refusal({ ...production, [name]: short });
      expect(message, name).toMatch(new RegExp(`^${name} must be at least 32 characters on the production deployment`));
      expect(message, name).not.toContain(short);
    }
    expect(refusal({ ...production, POSTMARK_WEBHOOK_SECRET: "w".repeat(32), POSTMARK_INBOUND_SECRET: "i".repeat(32) })).toBeNull();
    // the worker sends the inbound secret's addresses, so it is held to it; it never reads the webhook secret
    expect(refusal({ ...worker, POSTMARK_INBOUND_SECRET: short }, "worker")).toMatch(/^POSTMARK_INBOUND_SECRET must be at least 32 characters/);
    expect(refusal({ ...worker, POSTMARK_WEBHOOK_SECRET: "x" }, "worker")).toBeNull();
  });

  it("refuses staging's Supabase project wherever a value could be copied from staging, naming the variable but never the value", () => {
    const ref = "vjuaiyjmtrenbrmujvtc";
    const pooler = "aws-0-us-west-2.pooler.supabase.com:5432/postgres";
    const secret = "the-secret-password";
    /** A connection string (joined in parts, so the secret scan sees no password-shaped literal). */
    const conn = (user: string, host: string) => ["postgres://", user, ":", secret, "@", host].join("");
    const cases: Array<[string, string, EnvRole]> = [
      ["SUPABASE_URL", `https://${ref}.supabase.co`, "app"],
      ["SUPABASE_URL", `https://${ref.toUpperCase()}.supabase.co`, "worker"],
      ["DATABASE_URL", conn(`ros_app.${ref}`, pooler), "app"],
      ["DATABASE_URL", conn("postgres", `db.${ref}.supabase.co:5432/postgres`), "app"],
      ["WORKER_DATABASE_URL", conn(`ros_worker.${ref}`, pooler), "worker"],
      ["STORAGE_S3_ENDPOINT", `https://${ref}.storage.supabase.co/storage/v1/s3`, "app"],
      ["STORAGE_S3_ENDPOINT", `https://${ref}.storage.supabase.co/storage/v1/s3`, "worker"],
    ];
    for (const [name, value, role] of cases) {
      const message = refusal({ ...(role === "worker" ? worker : production), [name]: value }, role);
      expect(message, `${name} (${role})`).toMatch(new RegExp(`^${name} names staging's Supabase project \\(${ref}\\) on the production deployment`));
      expect(message, `${name} (${role})`).not.toContain(secret);
    }
    // the production project's own values start
    expect(refusal({ ...production, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co", DATABASE_URL: `postgres://ros_app.abcdefghijklmnopqrst:pw@${pooler}`, STORAGE_S3_ENDPOINT: "https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/s3" })).toBeNull();
  });

  it("refuses the production app without SIGNUP_MODE set on purpose, and the internal email link on any production process", () => {
    expect(refusal({ ...production, SIGNUP_MODE: undefined })).toMatch(/^SIGNUP_MODE must be set on the production deployment: "invite"/);
    expect(refusal({ ...production, SIGNUP_MODE: "" })).toMatch(/^SIGNUP_MODE must be set on the production deployment/);
    for (const mode of ["invite", "open"]) expect(refusal({ ...production, SIGNUP_MODE: mode }), mode).toBeNull();
    // the worker opens no company: not asked (its fixture leaves SIGNUP_MODE out)
    expect(worker.SIGNUP_MODE).toBeUndefined();
    expect(refusal(worker, "worker")).toBeNull();
    expect(refusal({ ...production, MAGIC_LINK_ENABLED: "true" })).toMatch(/^MAGIC_LINK_ENABLED must not be true on the production deployment/);
    expect(refusal({ ...worker, MAGIC_LINK_ENABLED: "true" }, "worker")).toMatch(/^MAGIC_LINK_ENABLED must not be true/);
    expect(refusal({ ...production, MAGIC_LINK_ENABLED: "false" })).toBeNull();
  });

  it("starts the production app and worker with SIGNUP_MODE=approval, and the words for a missing mode name it", () => {
    expect(refusal({ ...production, SIGNUP_MODE: "approval" })).toBeNull();
    expect(refusal({ ...worker, SIGNUP_MODE: "approval" }, "worker")).toBeNull();
    expect(refusal({ ...production, SIGNUP_MODE: undefined })).toMatch(/"approval" \(anyone else signed in sends a request, which a platform administrator accepts or declines\)/);
  });

  it("refuses the production worker on the fake scanner or ClamAV without its host; the app, which never scans, is not asked", () => {
    expect(refusal({ ...worker, SCAN_PROVIDER: "fake" }, "worker")).toMatch(/^SCAN_PROVIDER must be "clamav" with CLAMAV_HOST on the production worker \(SCAN_PROVIDER is "fake"\)/);
    expect(refusal({ ...worker, SCAN_PROVIDER: undefined, CLAMAV_HOST: undefined }, "worker")).toMatch(/^SCAN_PROVIDER must be "clamav" with CLAMAV_HOST on the production worker \(SCAN_PROVIDER is "fake", CLAMAV_HOST is not set\)/);
    expect(refusal({ ...worker, CLAMAV_HOST: undefined }, "worker")).toMatch(/\(SCAN_PROVIDER is "clamav", CLAMAV_HOST is not set\)/);
    // the app: the fake scanner and no ClamAV host are fine
    expect(refusal({ ...production, SCAN_PROVIDER: "fake", CLAMAV_HOST: undefined }, "app")).toBeNull();
    // the worker serves no webhook: no webhook secret needed
    expect(worker.POSTMARK_WEBHOOK_SECRET).toBeUndefined();
  });

  it("warns loudly, and refuses nothing, while BOOTSTRAP_ADMIN_EMAILS is set on the production deployment", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(loadEnv({ ...production, BOOTSTRAP_ADMIN_EMAILS: "First@Example.test" }).BOOTSTRAP_ADMIN_EMAILS).toEqual(["first@example.test"]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[env\] WARNING: BOOTSTRAP_ADMIN_EMAILS is set on the production deployment\. .*remove it/));
      warn.mockClear();
      loadEnv(production);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

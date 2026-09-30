import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

/** Audit remediation H7: in production each process names its own database role, and nothing falls back to PGlite. */
describe("production boot checks", () => {
  const base = { NODE_ENV: "production", APP_BASE_URL: "https://app.example.test", ANALYTICS_SALT: "salt-for-this-test-only", SESSION_SECRET: "x".repeat(40), SECRET_STORE: "vault", AI_PROVIDER: "anthropic", AUTH_PROVIDER: "supabase", SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "k", WORKER_INLINE: "false", STORAGE_PROVIDER: "supabase", RATE_LIMIT_STORE: "upstash" };
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
});

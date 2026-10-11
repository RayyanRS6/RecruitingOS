import { describe, expect, it } from "vitest";
import { loadEnv } from "./env";

/** Audit remediation H7: in production each process names its own database role, and nothing falls back to PGlite. */
describe("production boot checks", () => {
  const base = { NODE_ENV: "production", APP_BASE_URL: "https://app.example.test", ANALYTICS_SALT: "salt-for-this-test-only", SESSION_SECRET: "x".repeat(40), SECRET_STORE: "vault", AI_PROVIDER: "anthropic", AUTH_PROVIDER: "supabase", SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "k", WORKER_INLINE: "false", STORAGE_PROVIDER: "supabase", RATE_LIMIT_STORE: "upstash", UPSTASH_REDIS_REST_URL: "https://complete-narwhal-292092.upstash.io", UPSTASH_REDIS_REST_TOKEN: "upstash-token-for-tests-abcdefghij" };
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

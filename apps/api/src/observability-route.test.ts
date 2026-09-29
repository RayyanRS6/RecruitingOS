import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { installReporter, sentryOptions } from "./observability";
import { TEST_ERROR_EMAIL, TEST_ERROR_TOKEN, observabilityEnvironment, testErrorAvailable } from "./routes/observability";
import { signInAdmin } from "./test-helpers";

/**
 * The deliberate error for the staging scrubbing proof (docs/readiness/03 section 6): administrators only, audited,
 * never in production, and the token and address it carries are gone from the log line, the response and the event.
 */
describe("the observability test error", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  const seen: Array<{ err: unknown; context?: Record<string, unknown> }> = [];
  const testEnv = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", SENTRY_ENVIRONMENT: "" };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: testEnv });
    app = createApp(container);
    admin = await signInAdmin(app, container, "admin@identifiedtalent.com", "Admin");
    installReporter((err, context) => seen.push({ err, context }));
  });
  afterAll(async () => {
    installReporter(null);
    await container.close();
  });

  const post = (cookie?: string) => app.request("/api/v1/admin/observability/test-error", { method: "POST", headers: { ...(cookie ? { cookie } : {}), "x-admin-reason": "scrubbing proof" } });

  it("is for platform administrators only", async () => {
    expect((await post()).status).toBe(401);
  });

  it("throws on purpose; the token and the address are scrubbed from the response and from the reported event", async () => {
    const r = await post(admin);
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(text).toContain("Deliberate test error");
    expect(text).not.toContain(TEST_ERROR_TOKEN);
    expect(text).not.toContain(TEST_ERROR_EMAIL);
    expect(seen).toHaveLength(1);
    expect(seen[0].context).toEqual({ process: "api", method: "POST", path: "/api/v1/admin/observability/test-error" });
    const err = seen[0].err as Error;
    expect(err.name).toBe("DeliberateTestError");
    expect(err.message).toContain(TEST_ERROR_TOKEN); // the raw error carries them: only the SDK's scrubber stands between it and Sentry
    const event = sentryOptions({ SENTRY_DSN: "https://examplePublicKey@o0.ingest.us.sentry.io/0", SENTRY_ENVIRONMENT: "staging" }).beforeSend({ message: err.message, exception: { values: [{ type: err.name, value: err.message }] }, extra: seen[0].context });
    const json = JSON.stringify(event);
    expect(json).not.toContain(TEST_ERROR_TOKEN);
    expect(json).not.toContain(TEST_ERROR_EMAIL);
    expect(json).toContain("[redacted]");
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "admin.bypass"));
    expect(audits.some((a) => /observability test error raised on purpose \(test\)/.test(a.reason ?? ""))).toBe(true);
  });

  it("exists in development and test, and in a production build only when SENTRY_ENVIRONMENT is exactly staging", async () => {
    expect(observabilityEnvironment({ NODE_ENV: "production", raw: {} })).toBe("production");
    expect(observabilityEnvironment({ NODE_ENV: "production", raw: { SENTRY_ENVIRONMENT: "staging" } })).toBe("staging");
    expect(testErrorAvailable({ NODE_ENV: "development", raw: {} })).toBe(true);
    expect(testErrorAvailable({ NODE_ENV: "test", raw: {} })).toBe(true);
    expect(testErrorAvailable({ NODE_ENV: "production", raw: { SENTRY_ENVIRONMENT: "staging" } })).toBe(true);
    // an allow list: a production build under any other name, or no name, is production
    expect(testErrorAvailable({ NODE_ENV: "production", raw: {} })).toBe(false);
    for (const name of ["production", "prod", "live", "production-us", "Staging", "staging-2"]) expect(testErrorAvailable({ NODE_ENV: "production", raw: { SENTRY_ENVIRONMENT: name } })).toBe(false);
    // end to end: the same database and session behind an app whose environment is a production build under another name
    const prodApp = createApp({ ...container, env: { ...container.env, NODE_ENV: "production", raw: { ...container.env.raw, SENTRY_ENVIRONMENT: "production-us" } } });
    const r = await prodApp.request("/api/v1/admin/observability/test-error", { method: "POST", headers: { cookie: admin, "x-admin-reason": "scrubbing proof" } });
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(1); // nothing new was reported
    const staging = createApp({ ...container, env: { ...container.env, NODE_ENV: "production", raw: { ...container.env.raw, SENTRY_ENVIRONMENT: "staging" } } });
    expect((await staging.request("/api/v1/admin/observability/test-error", { method: "POST", headers: { cookie: admin, "x-admin-reason": "scrubbing proof" } })).status).toBe(500);
    expect(seen).toHaveLength(2);
  });
});

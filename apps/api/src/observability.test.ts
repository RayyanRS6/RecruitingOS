import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerSecretValue } from "@ros/core";
import { errorHandler, HttpError } from "./middleware/errors";
import { installReporter, reportError, sentryOptions } from "./observability";

/** Decision 3: unhandled errors are reported through one process-wide hook, scrubbed, with the route only; nothing happens without a DSN. */
describe("error reporting", () => {
  afterEach(() => installReporter(null));

  it("does nothing without a reporter, and never throws even if the reporter does", () => {
    expect(() => reportError(new Error("x"))).not.toThrow();
    installReporter(() => { throw new Error("reporter down"); });
    expect(() => reportError(new Error("x"))).not.toThrow();
  });

  it("an unhandled route error reaches the reporter with the path only, tokens masked, and the secret registry scrubbed", async () => {
    const seen: Array<{ err: unknown; context?: Record<string, unknown> }> = [];
    installReporter((err, context) => seen.push({ err, context }));
    registerSecretValue("super-secret-value-registered-for-tests");
    const app = new Hono();
    app.onError(errorHandler);
    app.get("/c/status/abc123token", () => { throw new Error("boom super-secret-value-registered-for-tests"); });
    app.get("/handled", () => { throw new HttpError(404, "not_found", "no"); });
    const res = await app.request("/c/status/abc123token?secret=shh");
    expect(res.status).toBe(500);
    expect(seen.length).toBe(1);
    expect(seen[0]!.context).toEqual({ process: "api", method: "GET", path: "/c/status/[token]" });
    expect(JSON.stringify(seen[0]!.context)).not.toContain("shh");
    // a handled error (an HttpError) is answered without being reported
    expect((await app.request("/handled")).status).toBe(404);
    expect(seen.length).toBe(1);
  });

  it("the shared SDK options carry no PII, no replay, tracing off by default, and scrub registered values from events", () => {
    const opts = sentryOptions({ SENTRY_DSN: "https://examplePublicKey@o0.ingest.us.sentry.io/0", SENTRY_ENVIRONMENT: "staging", SENTRY_TRACES_SAMPLE_RATE: "abc" });
    expect(opts.sendDefaultPii).toBe(false);
    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.environment).toBe("staging");
    expect("replaysSessionSampleRate" in opts).toBe(false);
    registerSecretValue("token-value-registered-for-observability-test");
    const scrubbed = opts.beforeSend({ message: "failed with token-value-registered-for-observability-test", request: { url: "https://x/api/v1/auth/callback?code=abc&state=def", headers: { authorization: "Bearer zzz", "user-agent": "ua" }, cookies: "ros_session=1" }, user: { id: "u1", email: "dana@example.com" } });
    expect(JSON.stringify(scrubbed)).not.toContain("token-value-registered-for-observability-test");
    expect(scrubbed.request?.url).toContain("code=[redacted]");
    expect(scrubbed.request?.headers?.authorization).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.user).toEqual({ id: "u1" });
    const withoutDsn = sentryOptions({});
    expect(withoutDsn.dsn).toBeUndefined();
    void vi;
  });
});

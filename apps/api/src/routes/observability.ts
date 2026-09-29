import { Hono } from "hono";
import { audit } from "@ros/core";
import { HttpError } from "../middleware/errors";
import { requirePlatformAdmin, type Vars } from "../middleware/session";

/**
 * The deliberate error behind the staging proof that error reports are scrubbed (docs/readiness/03 section 6;
 * founder decision 3 of 22 September 2026). A platform administrator posts here in development or staging; the
 * request is audited; the handler throws an error whose message carries a token-shaped value and an email address
 * in a query string, so the event that reaches Sentry can be checked for both being gone. The route exists only
 * where it is allowed, never where it is merely not forbidden: in a development or test process, and in a production
 * build only when SENTRY_ENVIRONMENT is exactly "staging". Every other production process answers 404, whatever its
 * environment is called: there is nothing to prove there and no reason to raise errors on purpose.
 */
export const observabilityRoutes = new Hono<Vars>();
observabilityRoutes.use("*", requirePlatformAdmin);

export class DeliberateTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliberateTestError";
  }
}

/** Shapes the scrubber removes by pattern: an API-key-shaped token and an address in a query string. Not real values. */
export const TEST_ERROR_TOKEN = "sk-ant-api03-DELIBERATE-TEST-VALUE-0000000000000000";
export const TEST_ERROR_EMAIL = "deliberate-test@example.com";

/** Which environment the error would be reported under: SENTRY_ENVIRONMENT when set (staging runs with NODE_ENV=production), otherwise NODE_ENV. */
export function observabilityEnvironment(env: { NODE_ENV: string; raw: Record<string, string | undefined> }): string {
  return env.raw.SENTRY_ENVIRONMENT || env.NODE_ENV;
}

/** An allow list, not a deny list: a development or test process, or a production build that names itself staging. */
export function testErrorAvailable(env: { NODE_ENV: string; raw: Record<string, string | undefined> }): boolean {
  return env.NODE_ENV !== "production" || env.raw.SENTRY_ENVIRONMENT === "staging";
}

observabilityRoutes.post("/test-error", async (c) => {
  const container = c.get("container");
  const s = c.get("session")!;
  const environment = observabilityEnvironment(container.env);
  if (!testErrorAvailable(container.env)) throw new HttpError(404, "not_found", "The test error exists in development and in staging only (a production build with SENTRY_ENVIRONMENT=staging).");
  await audit(container.db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "admin.bypass", reason: `observability test error raised on purpose (${environment})`, details: { environment, route: "/api/v1/admin/observability/test-error", reported: !!container.env.raw.SENTRY_DSN } });
  throw new DeliberateTestError(`Deliberate test error from the observability check (${environment}). Nothing is wrong. It carries a token-shaped value ${TEST_ERROR_TOKEN} and an address ?email=${TEST_ERROR_EMAIL} so the event can be checked: neither may appear in Sentry.`);
});

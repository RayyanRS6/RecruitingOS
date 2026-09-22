import * as Sentry from "@sentry/nextjs";
import { installReporter, sentryOptions } from "@ros/api/src/observability";

/**
 * Server-side error reporting for the shell on the Node runtime (founder decision 3): no PII, no replay, every event
 * scrubbed by shape and by registered secret value. An empty DSN keeps it off. The same process-wide hook the worker
 * installs lets the API report unhandled errors without importing an SDK. Loaded only from instrumentation.ts on the
 * Node runtime: the API's observability module reaches the database client through @ros/core, which the Edge bundle
 * cannot carry.
 */
export function registerNode(): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.init(sentryOptions(process.env));
  installReporter((err, context) => Sentry.captureException(err, { extra: context }));
}

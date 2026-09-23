import { redact, registeredSecretValues } from "@ros/core";
import { sentryBaseOptions } from "@ros/integrations";

/**
 * Error reporting (founder decision 3 of 22 September 2026: the official Sentry SDK, staging first, sensitive data
 * collection off, everything scrubbed, no replay, no session capture). Two processes report: the Next.js shell, which
 * initialises the Next SDK in apps/shell/instrumentation.ts, and the worker, which initialises the Node SDK here. Both
 * install the same process-wide hook, so code inside the API never imports an SDK: it calls reportError, which does
 * nothing until a DSN is configured. This module imports no SDK either; apps/api/src/instrument.ts does.
 */
type Reporter = (err: unknown, context?: Record<string, unknown>) => void;
const g = globalThis as unknown as { __rosReportError?: Reporter };

export function installReporter(reporter: Reporter | null): void {
  if (reporter) g.__rosReportError = reporter;
  else delete g.__rosReportError;
}

/** Reports an unexpected error with scrubbed context. Never throws; never blocks the request. */
export function reportError(err: unknown, context: Record<string, unknown> = {}): void {
  try {
    g.__rosReportError?.(err, redact(context));
  } catch {
    // reporting must never fail the caller
  }
}

export type ObservabilityEnv = { SENTRY_DSN?: string; SENTRY_ENVIRONMENT?: string; SENTRY_TRACES_SAMPLE_RATE?: string; NODE_ENV?: string; VERCEL_GIT_COMMIT_SHA?: string; RAILWAY_GIT_COMMIT_SHA?: string };

/** The options every process shares: no PII, no replay, scrubbing by shape and by registered value, tracing off unless asked. */
export function sentryOptions(env: ObservabilityEnv) {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE ?? "0");
  return {
    dsn: env.SENTRY_DSN || undefined,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || "development",
    release: env.VERCEL_GIT_COMMIT_SHA || env.RAILWAY_GIT_COMMIT_SHA || undefined,
    tracesSampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0,
    ...sentryBaseOptions(() => registeredSecretValues()),
  };
}

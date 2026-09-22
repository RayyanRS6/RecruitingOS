import * as Sentry from "@sentry/nextjs";
import { scrubObservabilityEvent } from "@ros/contracts";

/**
 * Browser-side error reporting for the owner, recruiter and administrator app only (candidate pages carry no script).
 * No replay, no session capture, no tracing, no PII; every event is scrubbed by shape. Off without a public DSN.
 */
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || "development",
    sendDefaultPii: false,
    tracesSampleRate: 0,
    integrations: [],
    beforeSend: (event) => scrubObservabilityEvent(event),
  });
}

import * as Sentry from "@sentry/node";
import { installReporter, sentryOptions } from "./observability";

/**
 * Side-effect module, imported first by the worker and the standalone API so the Node SDK is ready before any other
 * code runs. Off without SENTRY_DSN. The only file in the API that imports the SDK.
 */
if (process.env.SENTRY_DSN) {
  Sentry.init(sentryOptions(process.env));
  installReporter((err, context) => Sentry.captureException(err, { extra: context }));
  console.log("[observability] error reporting on (Node SDK, scrubbed, no replay)");
}

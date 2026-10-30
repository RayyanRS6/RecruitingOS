import * as Sentry from "@sentry/nextjs";

/**
 * Next.js instrumentation hook. Next.js resolves NEXT_RUNTIME at build time, so the Node-only module (and the
 * database client behind it) is dropped from the Edge bundle; see instrumentation-node.ts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    registerNode();
  }
}

/**
 * A page, route or action that threw. On the Node runtime it is reported without the values a failed query carries
 * (audit OPS-2, instrumentation-node.ts); the Edge runtime runs only the middleware, which reads no database.
 */
export async function onRequestError(...args: Parameters<typeof Sentry.captureRequestError>): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportRequestError } = await import("./instrumentation-node");
    reportRequestError(...args);
    return;
  }
  Sentry.captureRequestError(...args);
}

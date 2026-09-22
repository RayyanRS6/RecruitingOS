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

export const onRequestError = Sentry.captureRequestError;

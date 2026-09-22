import { redactObject } from "@ros/contracts";

/**
 * Error-tracking hygiene (correction 10): nothing that reaches Sentry may carry a credential, a cookie, an authorization
 * header, or a candidate-identifying query string. Wire `beforeSend` and `beforeSendTransaction` with this, and keep
 * `sendDefaultPii: false`. The value registry comes from @ros/core so anything read from the secret store in this
 * process is scrubbed by value as well as by shape.
 */
export type SentryLikeEvent = {
  message?: string;
  request?: { url?: string; headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown };
  exception?: { values?: Array<{ type?: string; value?: string; stacktrace?: unknown }> };
  breadcrumbs?: Array<{ message?: string; data?: unknown }>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: unknown;
  [key: string]: unknown;
};

const DROP_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-supabase-auth|proxy-authorization)$/i;

export function scrubObservabilityEvent<T extends SentryLikeEvent>(event: T, values: Iterable<string> = []): T {
  const copy = redactObject(event, values) as T;
  if (copy.request) {
    delete copy.request.cookies;
    delete copy.request.data;
    if (copy.request.headers) for (const k of Object.keys(copy.request.headers)) if (DROP_HEADERS.test(k)) delete copy.request.headers[k];
    if (typeof copy.request.url === "string") copy.request.url = copy.request.url.replace(/([?&](?:code|state|token|t)=)[^&#]+/gi, "$1[redacted]");
  }
  // Error tracking is about the code path, not the person: no user identity beyond an opaque id.
  if (copy.user && typeof copy.user === "object") copy.user = { id: (copy.user as { id?: string }).id ?? undefined };
  return copy;
}

/** Sentry init options that hold regardless of environment. Pass the DSN from the environment; an empty DSN disables sending. */
export function sentryBaseOptions(getValues: () => Iterable<string>) {
  return {
    sendDefaultPii: false,
    beforeSend: (event: SentryLikeEvent) => scrubObservabilityEvent(event, getValues()),
    beforeSendTransaction: (event: SentryLikeEvent) => scrubObservabilityEvent(event, getValues()),
    beforeBreadcrumb: (crumb: { message?: string; data?: unknown }) => redactObject(crumb, getValues()),
  };
}

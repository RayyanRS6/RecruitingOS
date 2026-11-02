import { redactContactDetails, redactObject } from "./redact";

/**
 * Error-tracking hygiene (correction 10): nothing that reaches the error tracker may carry a credential, a cookie, an
 * authorization header, or a candidate-identifying query string. Lives here, beside the redaction rules, because the
 * browser bundle of the staff application uses it too: it must stay free of server-only imports.
 */
export type SentryLikeEvent = {
  message?: string;
  request?: { url?: string; headers?: Record<string, string>; cookies?: unknown; data?: unknown; query_string?: unknown };
  exception?: { values?: Array<{ type?: string; value?: string; stacktrace?: unknown }> };
  breadcrumbs?: Array<{ message?: string; data?: unknown }>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  user?: unknown;
};

const DROP_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-supabase-auth|proxy-authorization)$/i;

/** Every text in a breadcrumb with addresses and numbers cut, however deep (a console breadcrumb keeps the logged arguments). */
function withoutContactDetails(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactContactDetails(value);
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => withoutContactDetails(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutContactDetails(v, depth + 1)]));
}

/** Scrubs an event by shape (headers, cookies, body, link tokens in URLs, identity) and by every registered secret value. */
export function scrubObservabilityEvent<T extends SentryLikeEvent>(event: T, values: Iterable<string> = []): T {
  const copy = redactObject(event, values) as T;
  // A person's address or number written into the words (a provider's "could not deliver to ...", a logged line kept as
  // a breadcrumb) is not for the error tracker either (audit OPS-2). Ids, tags and stack frames are left as they are.
  if (typeof copy.message === "string") copy.message = redactContactDetails(copy.message);
  for (const v of copy.exception?.values ?? []) if (typeof v.value === "string") v.value = redactContactDetails(v.value);
  if (copy.breadcrumbs) copy.breadcrumbs = copy.breadcrumbs.map((b) => withoutContactDetails(b) as typeof b);
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

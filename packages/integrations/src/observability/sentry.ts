import { redactObject, scrubObservabilityEvent, type SentryLikeEvent } from "@ros/contracts";

export { scrubObservabilityEvent, type SentryLikeEvent };

/**
 * Sentry init options that hold regardless of environment and process: no default PII, every event, transaction and
 * breadcrumb scrubbed by shape and by registered secret value. The value registry comes from @ros/core in the calling
 * process so anything read from the secret store there is scrubbed by value as well as by shape.
 */
export function sentryBaseOptions(getValues: () => Iterable<string>) {
  return {
    sendDefaultPii: false as const,
    beforeSend: <E extends SentryLikeEvent>(event: E): E => scrubObservabilityEvent(event, getValues()),
    beforeSendTransaction: <E extends SentryLikeEvent>(event: E): E => scrubObservabilityEvent(event, getValues()),
    beforeBreadcrumb: <B extends { message?: string; data?: unknown }>(crumb: B): B => redactObject(crumb, getValues()),
  };
}

import type { SendResult } from "./types";

/** Errors raised before a connection was made: nothing reached the provider, so trying again cannot send twice. */
const BEFORE_CONNECTING = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|getaddrinfo/i;

/**
 * What a send that threw means (Wave S5 review). Neither Postmark nor Twilio de-duplicates a repeated send, so only a
 * failure before the connection was made is tried again. A call cut off by our own timeout, or one that broke after the
 * request may have gone (a reset connection, a closed socket), may have been delivered: it is `uncertain`, never sent
 * again on a guess, and the outbox puts it in front of a person.
 */
export function thrownSendFailure(provider: string, err: unknown, timedOut: boolean, timeoutMs: number): Extract<SendResult, { status: "failed" }> {
  if (timedOut) return { status: "failed", error: `${provider} did not answer within ${Math.round(timeoutMs / 1000)} seconds; it may have been delivered`, retryable: false, uncertain: true };
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as Error & { cause?: { code?: string; message?: string } }).cause : undefined;
  const said = `${message} ${cause?.code ?? ""} ${cause?.message ?? ""}`;
  if (BEFORE_CONNECTING.test(said)) return { status: "failed", error: `${provider} unreachable: ${message}`, retryable: true };
  return { status: "failed", error: `${provider} connection broke while sending: ${message}; it may have been delivered`, retryable: false, uncertain: true };
}

import { REDACTED, containsSecret, redactObject, redactText } from "@ros/contracts";

/**
 * Keeping secrets out of what is written down. The process registers every runtime secret it holds (the session secret,
 * provider keys, database passwords); anything bound for a log line, an error, an event, an audit record or an
 * analytics payload is scrubbed of those values and of anything shaped like a credential. Nothing here ever logs,
 * returns in an API, or persists a value.
 */

export class SecretLeakError extends Error {
  constructor(public readonly where: string) {
    super(`A secret value was about to be written to ${where}; refused.`);
  }
}

// Values registered in this process. Bounded; oldest entries drop first. Never serialized.
const registered: string[] = [];
const MAX_REGISTERED = 512;
export function registerSecretValue(value: string): void {
  if (!value || value.length < 8 || registered.includes(value)) return;
  registered.push(value);
  if (registered.length > MAX_REGISTERED) registered.shift();
}
export function registeredSecretValues(): readonly string[] {
  return registered;
}
/** Tests only. */
export function clearRegisteredSecretValues(): void {
  registered.length = 0;
}

/** Scrubs anything bound for a log line, an error response, an event, an audit record, or an observability payload. */
export function redact<T>(value: T): T {
  return redactObject(value, registered);
}
export function redactString(text: string): string {
  return redactText(text, registered);
}
/**
 * An error's message as a log line may carry it (audit OPS-2): drizzle puts a failed query's values (a candidate's
 * name, address or answers) in the message, and the hosts keep every log line. The values and known secrets are cut;
 * the statement and the reason stay. tests/policy/log-scrubbing.test.ts holds every console call to a scrubber.
 */
export function errorForLog(err: unknown): string {
  return redactString(err instanceof Error ? err.message : String(err));
}

/**
 * Refuses (outside production) or scrubs (in production) a value that carries a secret. Called on every event payload and
 * audit record; production prefers a redacted record over a lost one, and reports the attempt.
 */
export function guardOutbound<T>(value: T, where: string): T {
  if (!containsSecret(value, registered)) return value;
  if (process.env.NODE_ENV === "production") {
    console.error(`[secrets] redacted a secret found in ${where}`);
    return redactObject(value, registered);
  }
  throw new SecretLeakError(where);
}

export { REDACTED };

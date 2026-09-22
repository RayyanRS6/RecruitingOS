import { createHash } from "node:crypto";
import type { Actor, Subject } from "@ros/contracts";
import { REDACTED, containsSecret, fingerprint, redactObject, redactText } from "@ros/contracts";
import type { Queryable } from "@ros/db";
import { audit } from "./audit";

/**
 * Secret lifecycle (founder decision F1/D21; correction 10 of 18 September 2026).
 *
 * Every value that leaves the managed secret store passes through here: the read is recorded (service, purpose, tenant,
 * integration, time) and the value is registered so that any later attempt to write it into a log, an error, an event, an
 * audit record, or an analytics payload is caught. Nothing here ever logs, returns in an API, or persists the value.
 */

/** A minimal view of the store; the concrete stores live in @ros/integrations. */
export interface SecretStoreLike {
  readonly id: string;
  put(name: string, value: string, description?: string): Promise<{ ref: string }>;
  get(ref: string): Promise<string | null>;
  rotate(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export type SecretPurpose = "calendar_sync" | "calendar_booking" | "token_refresh" | "health_check" | "revocation" | "job_board_post" | "webhook_verification" | "migration";

export type SecretContext = { service: string; purpose: SecretPurpose; companyId: string | null; integrationId?: string | null; actor: Actor; ip?: string };

export class SecretLeakError extends Error {
  constructor(public readonly where: string) {
    super(`A secret value was about to be written to ${where}; refused.`);
  }
}
export class SecretDeletionFailed extends Error {
  constructor(public readonly ref: string, cause: unknown) {
    super(`Could not delete secret ${fingerprint(ref)}: ${cause instanceof Error ? redactText(cause.message) : String(cause)}`);
  }
}

// Values read in this process. Bounded; oldest entries drop first. Never serialized.
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

function refTarget(integrationId?: string | null): Subject | null {
  return integrationId ? { type: "integration", id: integrationId } : null;
}
function refDetails(ref: string, ctx: SecretContext): Record<string, unknown> {
  return { service: ctx.service, purpose: ctx.purpose, integrationId: ctx.integrationId ?? null, ref: fingerprint(ref), store: undefined };
}

export async function storeSecret(q: Queryable, store: SecretStoreLike, input: SecretContext & { name: string; value: string }): Promise<{ ref: string }> {
  const { ref } = await store.put(input.name, input.value, `${input.service}:${input.companyId ?? "platform"}`);
  registerSecretValue(input.value);
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "secret.stored", target: refTarget(input.integrationId), reason: input.purpose, ip: input.ip, details: { ...refDetails(ref, input), store: store.id, name: input.name } });
  return { ref };
}

/** The only sanctioned way to read a stored credential. Returns null when the store no longer has it. */
export async function readSecret(q: Queryable, store: SecretStoreLike, input: SecretContext & { ref: string }): Promise<string | null> {
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "secret.read", target: refTarget(input.integrationId), reason: input.purpose, ip: input.ip, details: { ...refDetails(input.ref, input), store: store.id } });
  const value = await store.get(input.ref);
  if (value) registerSecretValue(value);
  return value;
}

export async function rotateSecret(q: Queryable, store: SecretStoreLike, input: SecretContext & { ref: string; value: string }): Promise<void> {
  await store.rotate(input.ref, input.value);
  registerSecretValue(input.value);
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "secret.rotated", target: refTarget(input.integrationId), reason: input.purpose, ip: input.ip, details: { ...refDetails(input.ref, input), store: store.id } });
}

/** Deletes and records it; on failure records the failure and throws so the caller can alert and retry. */
export async function deleteSecret(q: Queryable, store: SecretStoreLike, input: SecretContext & { ref: string }): Promise<void> {
  try {
    await store.delete(input.ref);
  } catch (err) {
    await audit(q, { companyId: input.companyId, actor: input.actor, action: "secret.delete_failed", target: refTarget(input.integrationId), reason: input.purpose, ip: input.ip, details: { ...refDetails(input.ref, input), store: store.id, error: redactText(err instanceof Error ? err.message : String(err), registered) } });
    throw new SecretDeletionFailed(input.ref, err);
  }
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "secret.deleted", target: refTarget(input.integrationId), reason: input.purpose, ip: input.ip, details: { ...refDetails(input.ref, input), store: store.id } });
}

/** A stable digest of a value for equality checks in tests without keeping the value around. */
export function digestForTests(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export { REDACTED };

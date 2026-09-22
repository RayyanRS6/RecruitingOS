import { and, eq, isNull } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { integrations, jobs, uuidv7, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { emit } from "./events";
import { raiseAlert, resolveAlertsFor } from "./alerts";
import { SecretDeletionFailed, deleteSecret, readSecret, storeSecret, type SecretStoreLike } from "./secrets";

/**
 * External connections (calendar, job boards) and their credentials (correction 10 of 18 September 2026).
 *
 * Connecting stores the credential in the managed store and keeps only a reference. Disconnecting makes the connection
 * unusable at once and queues revocation and deletion for the worker (the only role allowed to read the value). A failed
 * deletion raises an operator alert, retries, and is never silent.
 */
export const REVOKE_JOB_KIND = "integration.revoke_and_delete";
export const DELETE_FAILED_ALERT = "secret.delete_failed";

export type ConnectionRow = typeof integrations.$inferSelect;
export type CredentialRevoker = (provider: string, value: string) => Promise<{ ok: boolean; error?: string }>;

/** What a customer or administrator may see about a connection. Never the reference, never the value. */
export function publicConnection(row: ConnectionRow) {
  return { id: row.id, userId: row.userId, provider: row.provider, kind: row.kind, status: row.status, externalAccountId: row.externalAccountId, connectedAt: row.connectedAt, connectedBy: row.connectedBy, lastHealthAt: row.lastHealthAt, lastError: row.lastError, disconnectedAt: row.disconnectedAt, disconnectReason: row.disconnectReason, credentialsDeleted: !row.secretRef, revokedAt: row.revokedAt, config: row.config };
}

export async function connectIntegration(
  q: Queryable,
  store: SecretStoreLike,
  input: { companyId: string; userId?: string | null; provider: string; kind: string; secretValue: string; secretName: string; externalAccountId?: string | null; config?: Record<string, unknown>; status?: string; actor: Actor; now?: Date },
): Promise<ConnectionRow> {
  const now = (input.now ?? new Date()).toISOString();
  const scope = input.userId ? eq(integrations.userId, input.userId) : isNull(integrations.userId);
  const [existing] = await q.select().from(integrations).where(and(eq(integrations.companyId, input.companyId), eq(integrations.provider, input.provider), eq(integrations.kind, input.kind), scope)).limit(1);
  const integrationId = existing?.id ?? uuidv7();
  // Replacing a credential deletes the old one first so nothing lingers in the store.
  if (existing?.secretRef) {
    await deleteSecret(q, store, { ref: existing.secretRef, service: input.provider, purpose: "revocation", companyId: input.companyId, integrationId, actor: input.actor });
  }
  const { ref } = await storeSecret(q, store, { name: input.secretName, value: input.secretValue, service: input.provider, purpose: "token_refresh", companyId: input.companyId, integrationId, actor: input.actor });
  const values = { status: input.status ?? "awaiting_verification", secretRef: ref, secretDeletedAt: null, revokedAt: null, disconnectedAt: null, disconnectReason: null, externalAccountId: input.externalAccountId ?? null, config: input.config ?? {}, connectedBy: input.actor.kind === "user" ? input.actor.id : null, connectedAt: now, lastError: null, credentialsCiphertext: null };
  const [row] = existing
    ? await q.update(integrations).set(values).where(eq(integrations.id, existing.id)).returning()
    : await q.insert(integrations).values({ id: integrationId, companyId: input.companyId, userId: input.userId ?? null, provider: input.provider, kind: input.kind, ...values }).returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "credentials.updated", target: { type: "integration", id: row.id }, reason: existing ? "reconnected" : "connected", details: { provider: row.provider, kind: row.kind, externalAccountId: row.externalAccountId } });
  await emit(q, { type: "integration.connected", companyId: input.companyId, actor: input.actor, subject: { type: "integration", id: row.id }, payload: { provider: row.provider, kind: row.kind, status: row.status, externalAccountId: row.externalAccountId } });
  return row;
}

/** Reads a connection's credential for a stated purpose. Refuses once the connection is disconnected, except for revocation. */
export async function readConnectionSecret(q: Queryable, store: SecretStoreLike, row: ConnectionRow, ctx: { purpose: Exclude<import("./secrets").SecretPurpose, "migration">; actor: Actor; ip?: string }): Promise<string | null> {
  if (!row.secretRef) return null;
  if (row.disconnectedAt && ctx.purpose !== "revocation") throw new Error(`connection ${row.id} is disconnected; its credential may only be used for revocation`);
  return readSecret(q, store, { ref: row.secretRef, service: row.provider, purpose: ctx.purpose, companyId: row.companyId, integrationId: row.id, actor: ctx.actor, ip: ctx.ip });
}

/**
 * Makes the connection unusable immediately and queues revocation and deletion. The queue runs within seconds when a
 * worker is up; until the secret is gone the row says `credentialsDeleted: false` and the customer can see that.
 */
export async function disconnectIntegration(q: Queryable, input: { integrationId: string; companyId: string; reason: string; actor: Actor; now?: Date }): Promise<{ row: ConnectionRow; queued: boolean }> {
  const now = input.now ?? new Date();
  const [row] = await q.select().from(integrations).where(and(eq(integrations.id, input.integrationId), eq(integrations.companyId, input.companyId))).limit(1);
  if (!row) throw new Error("connection not found");
  const [updated] = await q.update(integrations).set({ status: "not_connected", disconnectedAt: now.toISOString(), disconnectReason: input.reason, lastError: null }).where(eq(integrations.id, row.id)).returning();
  await emit(q, { type: "integration.disconnected", companyId: input.companyId, actor: input.actor, subject: { type: "integration", id: row.id }, payload: { provider: row.provider, kind: row.kind, reason: input.reason, credentialsDeleted: !row.secretRef } });
  let queued = false;
  if (row.secretRef) {
    await q.insert(jobs).values({ kind: REVOKE_JOB_KIND, payload: { integrationId: row.id, companyId: input.companyId, actor: input.actor }, runAt: now.toISOString(), maxAttempts: 8 });
    queued = true;
  }
  return { row: updated, queued };
}

/**
 * Worker side: read (audited, purpose revocation), revoke at the provider when a revoker exists, delete from the store.
 * On a deletion failure: alert and mark the connection as needing a person, then report `deleted: false` (never throw,
 * so the alert and the audit record commit); the caller fails the job after commit so the queue retries.
 */
export async function revokeAndDeleteCredentials(
  q: Queryable,
  store: SecretStoreLike,
  input: { integrationId: string; actor: Actor; revoker?: CredentialRevoker | null; attempt?: number; maxAttempts?: number; now?: Date },
): Promise<{ deleted: boolean; revoked: boolean | null; error?: string; alertId?: string }> {
  const now = input.now ?? new Date();
  const [row] = await q.select().from(integrations).where(eq(integrations.id, input.integrationId)).limit(1);
  if (!row) return { deleted: false, revoked: null, error: "connection not found" };
  if (!row.secretRef) {
    await resolveAlertsFor(q, DELETE_FAILED_ALERT, row.id, now);
    return { deleted: true, revoked: row.revokedAt ? true : null };
  }
  let revoked: boolean | null = null;
  let revokeError: string | null = null;
  if (input.revoker && !row.revokedAt) {
    const value = await readConnectionSecret(q, store, row, { purpose: "revocation", actor: input.actor });
    if (value) {
      const r = await input.revoker(row.provider, value);
      revoked = r.ok;
      revokeError = r.ok ? null : r.error ?? "revocation failed";
    }
  }
  try {
    await deleteSecret(q, store, { ref: row.secretRef, service: row.provider, purpose: "revocation", companyId: row.companyId, integrationId: row.id, actor: input.actor });
  } catch (err) {
    const message = err instanceof SecretDeletionFailed ? err.message : String(err);
    const attempt = input.attempt ?? 1;
    const max = input.maxAttempts ?? 8;
    await q.update(integrations).set({ status: "manual_action_required", lastError: `credential deletion failed (attempt ${attempt} of ${max})`, revokedAt: revoked ? now.toISOString() : row.revokedAt }).where(eq(integrations.id, row.id));
    const alert = await raiseAlert(q, { kind: DELETE_FAILED_ALERT, severity: attempt >= max ? "critical" : "high", title: `Credential deletion failed: ${row.provider} ${row.kind}`, body: `The stored credential for this connection could not be deleted from the secret store (attempt ${attempt} of ${max}). The connection is disabled; a person must confirm the deletion in the store or retry from here.`, companyId: row.companyId, target: { type: "integration", id: row.id }, details: { integrationId: row.id, provider: row.provider, kind: row.kind, attempt, max, error: message, revoked } });
    await emit(q, { type: "integration.deletion_failed", companyId: row.companyId, actor: input.actor, subject: { type: "integration", id: row.id }, payload: { provider: row.provider, kind: row.kind, attempt, max } });
    return { deleted: false, revoked, error: message, alertId: alert.id };
  }
  await q.update(integrations).set({ secretRef: null, secretDeletedAt: now.toISOString(), revokedAt: revoked ? now.toISOString() : row.revokedAt, status: row.disconnectedAt ? "not_connected" : row.status, lastError: revokeError ? `provider revocation failed: ${revokeError}` : null, credentialsCiphertext: null }).where(eq(integrations.id, row.id));
  await audit(q, { companyId: row.companyId, actor: input.actor, action: "credentials.deleted", target: { type: "integration", id: row.id }, reason: row.disconnectReason ?? "credential replaced", details: { provider: row.provider, kind: row.kind, revoked, revokeError } });
  await emit(q, { type: "integration.credentials_deleted", companyId: row.companyId, actor: input.actor, subject: { type: "integration", id: row.id }, payload: { provider: row.provider, kind: row.kind, revoked } });
  await resolveAlertsFor(q, DELETE_FAILED_ALERT, row.id, now);
  return { deleted: true, revoked };
}

/** Connections whose credential is still in the store although the connection is disconnected. Empty in a healthy system. */
export async function pendingCredentialDeletions(q: Queryable) {
  const rows = await q.select().from(integrations).where(eq(integrations.status, "manual_action_required"));
  return rows.filter((r) => r.secretRef).map(publicConnection);
}

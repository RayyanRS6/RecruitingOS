import { and, desc, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emailSuppressions, webhookReceipts, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { normalizeEmail } from "./auth";

/**
 * The do-not-send list for email. Every send consults it (the container wraps the email adapter); the webhook processor
 * and administrators write it; every change is audited. Platform-wide by address.
 */
/** `subscription_change` is Postmark telling us the recipient (or someone at Postmark) unsubscribed the address (H10); it is honoured like a manual block, never retried. */
export type SuppressionReason = "hard_bounce" | "spam_complaint" | "soft_bounce_repeated" | "manual" | "subscription_change";
export type SuppressionRow = typeof emailSuppressions.$inferSelect;

/**
 * Listeners keep an in-process copy of the list current the moment it changes (the email guard consults that copy so a
 * send inside a database transaction never has to query outside it). Processes also reload the list periodically.
 */
type SuppressionListener = (change: { address: string; reason: string; active: boolean }) => void;
const listeners = new Set<SuppressionListener>();
export function onSuppressionChange(fn: SuppressionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function announce(change: { address: string; reason: string; active: boolean }) {
  for (const fn of listeners) fn(change);
}

export async function activeSuppression(q: Queryable, address: string): Promise<SuppressionRow | null> {
  const [row] = await q.select().from(emailSuppressions).where(and(eq(emailSuppressions.address, normalizeEmail(address)), eq(emailSuppressions.active, true))).orderBy(desc(emailSuppressions.lastAt)).limit(1);
  return row ?? null;
}

export async function isSuppressed(q: Queryable, address: string): Promise<boolean> {
  return !!(await activeSuppression(q, address));
}

export async function suppressAddress(
  q: Queryable,
  input: { address: string; reason: SuppressionReason; source: "postmark" | "admin"; providerMessageId?: string | null; details?: Record<string, unknown>; actor: Actor; companyId?: string | null; now?: Date },
): Promise<SuppressionRow> {
  const now = (input.now ?? new Date()).toISOString();
  const existing = await activeSuppression(q, input.address);
  let row: SuppressionRow;
  if (existing) {
    [row] = await q.update(emailSuppressions).set({ count: existing.count + 1, lastAt: now, reason: input.reason === "spam_complaint" ? "spam_complaint" : existing.reason, providerMessageId: input.providerMessageId ?? existing.providerMessageId, details: { ...existing.details, ...(input.details ?? {}) } }).where(eq(emailSuppressions.id, existing.id)).returning();
  } else {
    [row] = await q.insert(emailSuppressions).values({ address: normalizeEmail(input.address), reason: input.reason, source: input.source, providerMessageId: input.providerMessageId ?? null, details: input.details ?? {}, firstAt: now, lastAt: now }).returning();
  }
  await audit(q, { companyId: input.companyId ?? null, actor: input.actor, action: "suppression.added", target: null, reason: input.reason, details: { suppressionId: row.id, source: input.source, count: row.count } });
  announce({ address: row.address, reason: row.reason, active: true });
  return row;
}

export async function releaseSuppression(q: Queryable, input: { id: string; reason: string; actor: Actor; now?: Date }): Promise<SuppressionRow | null> {
  const [row] = await q.update(emailSuppressions).set({ active: false, releasedAt: (input.now ?? new Date()).toISOString(), releasedBy: input.actor.kind === "user" ? input.actor.id : null, releaseReason: input.reason }).where(and(eq(emailSuppressions.id, input.id), eq(emailSuppressions.active, true))).returning();
  if (!row) return null;
  await audit(q, { companyId: null, actor: input.actor, action: "suppression.released", target: null, reason: input.reason, details: { suppressionId: row.id, originalReason: row.reason } });
  announce({ address: row.address, reason: row.reason, active: false });
  return row;
}

export async function listSuppressions(q: Queryable, activeOnly = true): Promise<SuppressionRow[]> {
  return q.select().from(emailSuppressions).where(activeOnly ? eq(emailSuppressions.active, true) : undefined).orderBy(desc(emailSuppressions.lastAt)).limit(500);
}

/** True the first time an external id is seen; false when the provider redelivered an event we already handled. */
export async function recordWebhookReceipt(q: Queryable, input: { provider: string; kind: string; externalId: string }): Promise<boolean> {
  try {
    await q.insert(webhookReceipts).values({ provider: input.provider, kind: input.kind, externalId: input.externalId });
    return true;
  } catch (err) {
    const message = err instanceof Error ? `${err.message} ${(err as { cause?: { message?: string } }).cause?.message ?? ""}` : String(err);
    if (/unique|duplicate|23505/i.test(message)) return false;
    throw err;
  }
}

/** Soft-bounce policy: two soft bounces inside a week become a suppression. */
export const SOFT_BOUNCE_LIMIT = 2;
export const SOFT_BOUNCE_WINDOW_MS = 7 * 86_400_000;
export const RETRY_DELAYS_MS = [4 * 3600_000, 24 * 3600_000];

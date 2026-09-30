import { desc, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit, suppressAddress } from "@ros/core";
import { candidates, communications, type Queryable } from "@ros/db";
import type { EmailEvent } from "@ros/integrations";

export type SubscriptionOutcome = { handled: boolean; communicationId: string | null; action: "suppressed" | "recorded" | "unmatched"; suppressionReason?: string };

/**
 * Postmark's SubscriptionChange webhook (audit remediation H10). A suppression at Postmark (the recipient
 * unsubscribed, or an address was suppressed by hand or after a bounce or complaint) goes on our do-not-send list
 * with reason `subscription_change`: nothing is re-sent, no retry is scheduled, and a candidate who unsubscribed is
 * marked as not wanting email. A reactivation at Postmark is acknowledged and nothing more: an address leaves our
 * list only when an administrator releases it with a reason.
 */
export async function handleSubscriptionChange(q: Queryable, input: { event: EmailEvent; now: Date }): Promise<SubscriptionOutcome> {
  const { event, now } = input;
  const actor: Actor = { kind: "system", id: "email_webhook" };
  const [comm] = event.messageId ? await q.select().from(communications).where(eq(communications.providerMessageId, event.messageId)).orderBy(desc(communications.createdAt)).limit(1) : [];
  const address = (event.email || comm?.toAddress || "").trim().toLowerCase();
  if (!address) return { handled: false, communicationId: null, action: "unmatched" };
  const change = event.subscription ?? { suppress: event.hard, reason: event.type, origin: "Unknown" };
  if (!change.suppress) return { handled: true, communicationId: comm?.id ?? null, action: "recorded" };
  await suppressAddress(q, { address, reason: "subscription_change", source: "postmark", providerMessageId: event.messageId, details: { origin: change.origin, suppressionReason: change.reason }, actor, companyId: comm?.companyId ?? null, now });
  if (comm) await emit(q, { type: "message.suppressed", companyId: comm.companyId, actor, subject: { type: "communication", id: comm.id }, payload: { reason: "subscription_change", address, origin: change.origin } });
  if (change.origin === "Recipient") {
    // The person said no to email: every candidate record with the address, in every company, remembers it.
    const cands = await q.select().from(candidates).where(eq(candidates.email, address));
    for (const each of cands) await q.update(candidates).set({ preferences: { ...each.preferences, emailOptOut: true } }).where(eq(candidates.id, each.id));
  }
  return { handled: true, communicationId: comm?.id ?? null, action: "suppressed", suppressionReason: "subscription_change" };
}

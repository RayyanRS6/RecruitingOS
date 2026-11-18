import { Hono, type Context } from "hono";
import { claimWebhookReceipt } from "@ros/core";
import { handleEmailEvent } from "@ros/agents";
import { withPlatform } from "@ros/db";
import { parsePostmarkEvent, verifyPostmarkWebhookAuth } from "@ros/integrations";
import type { Vars } from "../middleware/session";
import { handleSubscriptionChange } from "../services/email-subscriptions";

export const postmarkWebhook = new Hono<Vars>();

/**
 * Delivery events (bounces, spam complaints, deliveries, subscription changes). Authenticated with the webhook secret
 * Postmark is configured to send (basic auth on the URL or a header); fails closed in production. Each event id is
 * processed once.
 */
async function handleDeliveryEvent(c: Context<Vars>) {
  const container = c.get("container");
  const secret = container.env.raw.POSTMARK_WEBHOOK_SECRET;
  if (secret) {
    if (!verifyPostmarkWebhookAuth({ authorization: c.req.header("authorization"), secretHeader: c.req.header("x-webhook-secret") }, secret)) return c.json({ error: { code: "unauthorized", message: "bad webhook credentials" } }, 401);
  } else if (container.env.NODE_ENV === "production") {
    return c.json({ error: { code: "misconfigured", message: "POSTMARK_WEBHOOK_SECRET is not set" } }, 503);
  }
  const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const event = payload ? parsePostmarkEvent(payload) : null;
  if (!event) return c.json({ error: { code: "invalid_request", message: "not a Postmark event" } }, 400);
  // The receipt is claimed in the same transaction as the handling: if the handling fails, the claim rolls back with it,
  // the answer is an error, and Postmark's redelivery is processed (an unsubscribe is never lost to a duplicate answer).
  const outcome = await withPlatform(container.db, async (tx) => {
    if (!(await claimWebhookReceipt(tx, { provider: "postmark", kind: event.recordType, externalId: event.externalId }))) return null;
    // A subscription change is a suppression to honour or a reactivation to acknowledge, never a bounce to retry.
    return event.recordType === "SubscriptionChange"
      ? handleSubscriptionChange(tx, { event, now: container.engine.clock() })
      : handleEmailEvent(tx, { event, now: container.engine.clock() });
  });
  if (!outcome) return c.json({ ok: true, duplicate: true });
  await container.kick();
  return c.json({ ok: true, duplicate: false, ...outcome });
}
postmarkWebhook.post("/bounces", handleDeliveryEvent);
postmarkWebhook.post("/spam", handleDeliveryEvent);
postmarkWebhook.post("/events", handleDeliveryEvent);
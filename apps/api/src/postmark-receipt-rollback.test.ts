import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { emailSuppressions, webhookReceipts } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/** The first handling of a subscription change fails once (a database blip), exactly where the real one would. */
const blip = vi.hoisted(() => ({ failNext: false }));
vi.mock("./services/email-subscriptions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./services/email-subscriptions")>();
  return {
    ...actual,
    handleSubscriptionChange: async (...args: Parameters<typeof actual.handleSubscriptionChange>) => {
      const result = await actual.handleSubscriptionChange(...args);
      if (blip.failNext) {
        blip.failNext = false;
        throw new Error("the database went away mid-transaction");
      }
      return result;
    },
  };
});

/**
 * A Postmark delivery event is claimed and handled in one transaction: when the handling fails the claim rolls back
 * with the half-done work, the answer is an error, and Postmark's redelivery is processed instead of being answered as
 * a duplicate. An unsubscribe is never lost that way.
 */
describe("Postmark delivery events: the receipt and the handling commit together", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const SECRET = "wh-secret-for-tests-1234567890";
  const webhook = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}` }, body: JSON.stringify(payload) });
  const change = { RecordType: "SubscriptionChange", MessageID: "5a1c0de0-6105-42a2-a16a-77a8eac79483", ServerID: 123456, MessageStream: "outbound", ChangedAt: "2026-09-30T15:00:00Z", Recipient: "Blip.Person@example.com", Origin: "Recipient", SuppressSending: true, SuppressionReason: "ManualSuppression", Tag: "acknowledgment", Metadata: {} };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", POSTMARK_WEBHOOK_SECRET: SECRET } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("a failed handling leaves no receipt and no half-written suppression; the redelivery suppresses the address", async () => {
    blip.failNext = true;
    const failed = await webhook(change);
    expect(failed.status).toBe(500);
    expect(await container.db.select().from(webhookReceipts).where(eq(webhookReceipts.kind, "SubscriptionChange"))).toHaveLength(0);
    expect(await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "blip.person@example.com"))).toHaveLength(0);
    // Postmark retries: processed, not answered as a duplicate
    const retried = await webhook(change);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ ok: true, duplicate: false, action: "suppressed" });
    const [row] = await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "blip.person@example.com"));
    expect(row).toMatchObject({ reason: "subscription_change", active: true });
    expect(await container.db.select().from(webhookReceipts).where(eq(webhookReceipts.kind, "SubscriptionChange"))).toHaveLength(1);
    // and a third delivery is the duplicate
    expect(await (await webhook(change)).json()).toMatchObject({ ok: true, duplicate: true });
  });
});

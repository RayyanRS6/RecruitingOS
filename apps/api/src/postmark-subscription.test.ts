import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditRecords, emailSuppressions, jobs, webhookReceipts } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Audit remediation H10: Postmark's SubscriptionChange webhook. A suppression at Postmark goes on our do-not-send
 * list with reason subscription_change and is never retried; a reactivation is acknowledged and releases nothing.
 */
describe("Postmark subscription changes", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const SECRET = "wh-secret-for-tests-1234567890";
  const webhook = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/events", { method: "POST", headers: { "content-type": "application/json", authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString("base64")}` }, body: JSON.stringify(payload) });
  const change = (over: Record<string, unknown> = {}) => ({ RecordType: "SubscriptionChange", MessageID: "883953f4-6105-42a2-a16a-77a8eac79483", ServerID: 123456, MessageStream: "outbound", ChangedAt: "2026-09-30T12:00:00Z", Recipient: "Unsub.Person@example.com", Origin: "Recipient", SuppressSending: true, SuppressionReason: "ManualSuppression", Tag: "acknowledgment", Metadata: {}, ...over });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", POSTMARK_WEBHOOK_SECRET: SECRET } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("a suppression at Postmark goes on the do-not-send list, blocks every later send, and schedules no retry", async () => {
    const r = await webhook(change());
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, duplicate: false, handled: true, action: "suppressed", suppressionReason: "subscription_change" });
    const rows = await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "unsub.person@example.com"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: "subscription_change", source: "postmark", active: true, providerMessageId: "883953f4-6105-42a2-a16a-77a8eac79483" });
    expect(rows[0].details).toMatchObject({ origin: "Recipient", suppressionReason: "ManualSuppression" });
    expect(await container.db.select().from(jobs).where(eq(jobs.kind, "email.retry"))).toHaveLength(0);
    // the receipt identifies the event without holding the address
    const receipts = await container.db.select().from(webhookReceipts).where(eq(webhookReceipts.kind, "SubscriptionChange"));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].externalId).not.toMatch(/example\.com/i);
    // every send to the address is refused from now on
    const sent = await container.integrations.email.send({ to: "unsub.person@example.com", from: "updates@mail.localhost", subject: "Hello", text: "x", idempotencyKey: "after-unsubscribe" });
    expect(sent.status).toBe("failed");
    expect(sent).toMatchObject({ retryable: false });
    expect((sent as { error: string }).error).toContain("subscription change");
    const audits = await container.db.select().from(auditRecords).where(eq(auditRecords.action, "suppression.added"));
    expect(audits.some((a) => a.reason === "subscription_change")).toBe(true);
    // Postmark redelivers: acknowledged once, acted on once
    const again = await webhook(change());
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });
    expect(await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "unsub.person@example.com"))).toHaveLength(1);
  });

  it("a reactivation at Postmark is acknowledged and releases nothing: only an administrator does that", async () => {
    const r = await webhook(change({ SuppressSending: false, SuppressionReason: "", ChangedAt: "2026-09-30T13:00:00Z", Origin: "Customer" }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, duplicate: false, handled: true, action: "recorded" });
    const [row] = await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "unsub.person@example.com"));
    expect(row.active).toBe(true);
  });

  it("a manual suppression at Postmark, which carries no message id, is honoured too", async () => {
    const r = await webhook(change({ MessageID: "00000000-0000-0000-0000-000000000000", Recipient: "another.person@example.com", Origin: "Customer", SuppressionReason: "ManualSuppression", ChangedAt: "2026-09-30T14:00:00Z" }));
    expect(await r.json()).toMatchObject({ action: "suppressed", communicationId: null });
    const [row] = await container.db.select().from(emailSuppressions).where(eq(emailSuppressions.address, "another.person@example.com"));
    expect(row).toMatchObject({ reason: "subscription_change", providerMessageId: null });
  });
});

import { describe, expect, it } from "vitest";
import { PostmarkEmailAdapter } from "./postmark";
import { parsePostmarkEvent } from "./postmark-webhooks";

/** J19: the Postmark adapter against a fake fetch (nothing here reaches the network), and the webhook parser for subscription changes (H10). */
describe("Postmark email adapter", () => {
  const message = { to: "person@example.com", from: "Harbor Dental hiring team <updates@hire.identifiedtalent.com>", replyTo: "replies@its.test", subject: "We received your application", text: "Thanks.", html: "<p>Thanks.</p>", idempotencyKey: "ack:app-1", tags: { template: "acknowledgment" } };
  const fetchWith = (status: number, body: unknown, calls: Array<{ url: string; init: RequestInit }> = []) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  it("sends through the server token and reports the provider's message id", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = new PostmarkEmailAdapter("server-token-for-tests-000000", fetchWith(200, { MessageID: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817", ErrorCode: 0, Message: "OK" }, calls));
    expect(adapter.status).toBe("live");
    expect(await adapter.send(message)).toEqual({ status: "sent", providerMessageId: "b7bc2f4a-e38e-4336-af7d-e6c392c2f817" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.postmarkapp.com/email");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe("server-token-for-tests-000000");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ From: message.from, To: message.to, ReplyTo: message.replyTo, Subject: message.subject, TextBody: message.text, HtmlBody: message.html, MessageStream: "outbound", Tag: "acknowledgment", Metadata: { idempotencyKey: "ack:app-1" } });
  });

  it("a 422 (an invalid message or an inactive recipient) is final: no retry", async () => {
    const adapter = new PostmarkEmailAdapter("server-token-for-tests-000000", fetchWith(422, { ErrorCode: 406, Message: "You tried to send to a recipient that has been marked as inactive." }));
    const result = await adapter.send(message);
    expect(result).toEqual({ status: "failed", error: "postmark 422: You tried to send to a recipient that has been marked as inactive.", retryable: false });
  });

  it("a 500 and a 429 are the provider's problem: retryable", async () => {
    expect(await new PostmarkEmailAdapter("server-token-for-tests-000000", fetchWith(500, { Message: "Internal Server Error" })).send(message)).toEqual({ status: "failed", error: "postmark 500: Internal Server Error", retryable: true });
    expect(await new PostmarkEmailAdapter("server-token-for-tests-000000", fetchWith(429, {})).send(message)).toMatchObject({ status: "failed", error: "postmark 429: unknown", retryable: true });
  });

  it("a network error is retryable and never throws", async () => {
    const adapter = new PostmarkEmailAdapter("server-token-for-tests-000000", (async () => { throw new TypeError("fetch failed: ECONNRESET"); }) as unknown as typeof fetch);
    expect(await adapter.send(message)).toEqual({ status: "failed", error: "fetch failed: ECONNRESET", retryable: true });
  });

  it("without a token nothing is sent and the adapter says so", async () => {
    const adapter = new PostmarkEmailAdapter(undefined, (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch);
    expect(adapter.status).toBe("not_connected");
    expect(await adapter.send(message)).toEqual({ status: "pending", reason: "Postmark server token not configured" });
  });
});

describe("Postmark subscription-change events", () => {
  const change = (over: Record<string, unknown> = {}) => ({ RecordType: "SubscriptionChange", MessageID: "883953f4-6105-42a2-a16a-77a8eac79483", ServerID: 123456, MessageStream: "outbound", ChangedAt: "2026-09-30T12:00:00Z", Recipient: "Unsub.Person@example.com", Origin: "Recipient", SuppressSending: true, SuppressionReason: "ManualSuppression", Tag: "acknowledgment", Metadata: { idempotencyKey: "ack:app-1" }, ...over });

  it("a suppression is a suppression event: hard, never soft, with the reason and origin kept", () => {
    const event = parsePostmarkEvent(change())!;
    expect(event).toMatchObject({ provider: "postmark", recordType: "SubscriptionChange", email: "Unsub.Person@example.com", messageId: "883953f4-6105-42a2-a16a-77a8eac79483", hard: true, soft: false, complaint: false, at: "2026-09-30T12:00:00Z", type: "SubscriptionChange", metadata: { idempotencyKey: "ack:app-1" } });
    expect(event.subscription).toEqual({ suppress: true, reason: "ManualSuppression", origin: "Recipient" });
    expect(event.description).toContain("The recipient unsubscribed");
    // the receipt id identifies the change without holding the address
    expect(event.externalId).toMatch(/^SubscriptionChange:883953f4-6105-42a2-a16a-77a8eac79483:2026-09-30T12:00:00Z:[0-9a-f]{16}$/);
    expect(event.externalId).not.toMatch(/example\.com/i);
    expect(parsePostmarkEvent(change({ Recipient: "other.person@example.com" }))!.externalId).not.toBe(event.externalId);
  });

  it("a reactivation is not a suppression and carries no bounce classification", () => {
    const event = parsePostmarkEvent(change({ SuppressSending: false, SuppressionReason: "" }))!;
    expect(event).toMatchObject({ recordType: "SubscriptionChange", hard: false, soft: false, complaint: false, type: "SubscriptionReactivated" });
    expect(event.subscription).toEqual({ suppress: false, reason: "Reactivated", origin: "Recipient" });
  });

  it("a manual suppression at Postmark has no message id worth keeping, and no recipient means no event", () => {
    const event = parsePostmarkEvent(change({ MessageID: "00000000-0000-0000-0000-000000000000", Origin: "Customer" }))!;
    expect(event.messageId).toBeNull();
    expect(event.externalId.startsWith("SubscriptionChange:00000000-0000-0000-0000-000000000000:")).toBe(true);
    expect(event.description).toContain("Postmark suppressed the address (Customer)");
    expect(parsePostmarkEvent(change({ Recipient: "" }))).toBeNull();
  });

  it("without ChangedAt the receipt id is still the same on every redelivery", () => {
    const first = parsePostmarkEvent(change({ ChangedAt: undefined }))!;
    const again = parsePostmarkEvent(change({ ChangedAt: undefined }))!;
    expect(first.externalId).toBe(again.externalId);
    expect(first.externalId).toMatch(/^SubscriptionChange:883953f4-6105-42a2-a16a-77a8eac79483:unknown-suppressed:[0-9a-f]{16}$/);
    expect(Number.isNaN(Date.parse(first.at))).toBe(false); // the record is still stamped: with the time it arrived
    expect(parsePostmarkEvent(change({ ChangedAt: undefined, SuppressSending: false }))!.externalId).toMatch(/:unknown-reactivated:/);
  });

  it("bounces still parse as before", () => {
    const bounce = parsePostmarkEvent({ RecordType: "Bounce", ID: 42, Type: "HardBounce", MessageID: "m1", Email: "dead@example.com", Description: "unknown user", BouncedAt: "2026-09-30T12:00:00Z" })!;
    expect(bounce).toMatchObject({ recordType: "Bounce", externalId: "Bounce:42", hard: true, soft: false, complaint: false });
    expect(bounce.subscription).toBeUndefined();
  });
});

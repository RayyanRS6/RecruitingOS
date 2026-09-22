import type { EmailAdapter, OutboundEmail, SendResult, SmsAdapter, OutboundSms } from "../types";

/** Records messages instead of sending them. In development the API exposes them at /dev/outbox. */
export class FakeEmailAdapter implements EmailAdapter {
  readonly id = "fake-email";
  readonly status = "fake" as const;
  public sent: Array<OutboundEmail & { at: string; providerMessageId: string }> = [];
  private seen = new Set<string>();
  private failNextCount = 0;

  failNext(times = 1): void {
    this.failNextCount = times;
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    if (this.failNextCount > 0) {
      this.failNextCount -= 1;
      return { status: "failed", error: "simulated email provider outage", retryable: true };
    }
    if (this.seen.has(msg.idempotencyKey)) {
      const prior = this.sent.find((s) => s.idempotencyKey === msg.idempotencyKey)!;
      return { status: "sent", providerMessageId: prior.providerMessageId };
    }
    this.seen.add(msg.idempotencyKey);
    const providerMessageId = `fake-${this.sent.length + 1}`;
    this.sent.push({ ...msg, at: new Date().toISOString(), providerMessageId });
    return { status: "sent", providerMessageId };
  }
}

export class FakeSmsAdapter implements SmsAdapter {
  readonly id = "fake-sms";
  readonly status = "fake" as const;
  public sent: Array<OutboundSms & { at: string; providerMessageId: string }> = [];
  private seen = new Set<string>();
  private failNextCount = 0;

  failNext(times = 1): void {
    this.failNextCount = times;
  }

  async send(msg: OutboundSms): Promise<SendResult> {
    if (this.failNextCount > 0) {
      this.failNextCount -= 1;
      return { status: "failed", error: "simulated SMS provider outage", retryable: true };
    }
    if (this.seen.has(msg.idempotencyKey)) return { status: "sent", providerMessageId: this.sent.find((s) => s.idempotencyKey === msg.idempotencyKey)!.providerMessageId };
    this.seen.add(msg.idempotencyKey);
    const providerMessageId = `fake-sms-${this.sent.length + 1}`;
    this.sent.push({ ...msg, at: new Date().toISOString(), providerMessageId });
    return { status: "sent", providerMessageId };
  }
}

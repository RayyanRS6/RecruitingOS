import type { EmailAdapter, OutboundEmail, SendResult, SmsAdapter, OutboundSms } from "../types";

/**
 * Records messages instead of sending them. In development the API exposes them at /dev/outbox. Like the real
 * providers, it sends every message it is asked to send: it does nothing with the idempotency key, so a test that sends
 * twice sees two messages. Not sending twice is the outbox's job (packages/agents/src/outbox.ts), not the adapter's.
 */
export class FakeEmailAdapter implements EmailAdapter {
  readonly id = "fake-email";
  readonly status = "fake" as const;
  public sent: Array<OutboundEmail & { at: string; providerMessageId: string }> = [];
  private failNextCount = 0;

  failNext(times = 1): void {
    this.failNextCount = times;
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    if (this.failNextCount > 0) {
      this.failNextCount -= 1;
      return { status: "failed", error: "simulated email provider outage", retryable: true };
    }
    const providerMessageId = `fake-${this.sent.length + 1}`;
    this.sent.push({ ...msg, at: new Date().toISOString(), providerMessageId });
    return { status: "sent", providerMessageId };
  }
}

export class FakeSmsAdapter implements SmsAdapter {
  readonly id = "fake-sms";
  readonly status = "fake" as const;
  public sent: Array<OutboundSms & { at: string; providerMessageId: string }> = [];
  private failNextCount = 0;

  failNext(times = 1): void {
    this.failNextCount = times;
  }

  async send(msg: OutboundSms): Promise<SendResult> {
    if (this.failNextCount > 0) {
      this.failNextCount -= 1;
      return { status: "failed", error: "simulated SMS provider outage", retryable: true };
    }
    const providerMessageId = `fake-sms-${this.sent.length + 1}`;
    this.sent.push({ ...msg, at: new Date().toISOString(), providerMessageId });
    return { status: "sent", providerMessageId };
  }
}

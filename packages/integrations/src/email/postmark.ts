import { thrownSendFailure } from "../send-failure";
import type { EmailAdapter, OutboundEmail, SendResult } from "../types";

/**
 * How long one send may take, the reply's body included (audit row 121). Postmark answers in well under a second; a
 * call that hangs would otherwise hold the worker's loop for minutes (Node's own limits). A send cut off here may have
 * been delivered, so it is never retried on a guess: the outbox marks it unknown for a person to check.
 */
export const POSTMARK_TIMEOUT_MS = 30_000;

/**
 * Postmark transactional email. Live when POSTMARK_SERVER_TOKEN is set and the sending domain
 * has SPF, DKIM, and DMARC configured at Postmark. Otherwise reports not_connected and
 * records nothing as sent.
 */
export class PostmarkEmailAdapter implements EmailAdapter {
  readonly id = "postmark";
  readonly status: "live" | "not_connected";
  constructor(private token: string | undefined, private fetchImpl: typeof fetch = fetch, private timeoutMs: number = POSTMARK_TIMEOUT_MS) {
    this.status = token ? "live" : "not_connected";
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    if (!this.token) return { status: "pending", reason: "Postmark server token not configured" };
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
        signal: deadline.signal,
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "X-Postmark-Server-Token": this.token },
        body: JSON.stringify({
          From: msg.from,
          To: msg.to,
          ReplyTo: msg.replyTo,
          Subject: msg.subject,
          TextBody: msg.text,
          HtmlBody: msg.html,
          MessageStream: "outbound",
          Tag: msg.tags?.template,
          Metadata: { idempotencyKey: msg.idempotencyKey },
          Attachments: msg.attachments?.map((a) => ({ Name: a.filename, Content: a.contentBase64, ContentType: a.contentType })),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { MessageID?: string; Message?: string; ErrorCode?: number };
      if (res.ok && body.MessageID) return { status: "sent", providerMessageId: body.MessageID };
      // Postmark took the message but its reply was cut off: it may well have gone, so it is not sent again on a guess;
      // the outbox marks it unknown for a person to check (`uncertain`).
      if (res.ok && deadline.signal.aborted) return { status: "failed", error: `postmark took the message but its reply did not finish within ${Math.round(this.timeoutMs / 1000)} seconds; it may have been delivered`, retryable: false, uncertain: true };
      const retryable = res.status >= 500 || res.status === 429;
      return { status: "failed", error: `postmark ${res.status}: ${body.Message ?? "unknown"}`, retryable };
    } catch (err) {
      // Postmark has no idempotency key: only a failure to connect is tried again (`thrownSendFailure`).
      return thrownSendFailure("postmark", err, deadline.signal.aborted, this.timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }
}

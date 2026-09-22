import type { EmailAdapter, OutboundEmail, SendResult } from "../types";

/**
 * Postmark transactional email. Live when POSTMARK_SERVER_TOKEN is set and the sending domain
 * has SPF, DKIM, and DMARC configured at Postmark. Otherwise reports not_connected and
 * records nothing as sent.
 */
export class PostmarkEmailAdapter implements EmailAdapter {
  readonly id = "postmark";
  readonly status: "live" | "not_connected";
  constructor(private token: string | undefined, private fetchImpl: typeof fetch = fetch) {
    this.status = token ? "live" : "not_connected";
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    if (!this.token) return { status: "pending", reason: "Postmark server token not configured" };
    try {
      const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
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
      const retryable = res.status >= 500 || res.status === 429;
      return { status: "failed", error: `postmark ${res.status}: ${body.Message ?? "unknown"}`, retryable };
    } catch (err) {
      return { status: "failed", error: err instanceof Error ? err.message : String(err), retryable: true };
    }
  }
}

import { createHmac } from "node:crypto";
import type { OutboundSms, SendResult, SmsAdapter } from "../types";

export type TwilioConfig = { accountSid?: string; authToken?: string; messagingServiceSid?: string; from?: string };

/**
 * Twilio Programmable Messaging (docs/15). Live only with credentials and a messaging service (A2P 10DLC campaign);
 * until then it reports `not_connected` and records what it would send. Consent is checked by the caller
 * (`deliverSms`), quiet hours by the workflow; STOP is honored by Twilio and by our inbound webhook.
 */
export class TwilioSmsAdapter implements SmsAdapter {
  readonly id = "twilio";
  readonly status: "live" | "not_connected";
  constructor(private cfg: TwilioConfig, private fetchImpl: typeof fetch = fetch) {
    this.status = cfg.accountSid && cfg.authToken && (cfg.messagingServiceSid || cfg.from) ? "live" : "not_connected";
  }

  async send(msg: OutboundSms): Promise<SendResult> {
    if (this.status !== "live") return { status: "pending", reason: "Twilio credentials or the A2P 10DLC messaging service are not configured" };
    const body = new URLSearchParams({ To: msg.to, Body: msg.body });
    if (this.cfg.messagingServiceSid) body.set("MessagingServiceSid", this.cfg.messagingServiceSid);
    else if (this.cfg.from) body.set("From", this.cfg.from);
    try {
      const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": msg.idempotencyKey },
        body: body.toString(),
      });
      const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
      if (res.ok && json.sid) return { status: "sent", providerMessageId: json.sid };
      const retryable = res.status === 429 || res.status >= 500;
      return { status: "failed", error: `twilio ${res.status}${json.code ? ` (${json.code})` : ""}: ${json.message ?? "send failed"}`, retryable };
    } catch (err) {
      return { status: "failed", error: `twilio unreachable: ${err instanceof Error ? err.message : String(err)}`, retryable: true };
    }
  }
}

export type InboundSms = { from: string; to: string; body: string; messageSid?: string };

/** Normalizes Twilio's inbound form post. Other providers get their own normalizer; the app only sees InboundSms. */
export function parseTwilioInbound(form: Record<string, string | undefined>): InboundSms {
  return { from: (form.From ?? "").trim(), to: (form.To ?? "").trim(), body: (form.Body ?? "").trim(), messageSid: form.MessageSid || undefined };
}

/** Twilio signs webhooks: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)). */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string | undefined>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => `${k}${params[k] ?? ""}`).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Carrier-standard opt-out and help keywords (CTIA). */
export function smsKeyword(body: string): "stop" | "start" | "help" | null {
  const w = body.trim().toUpperCase();
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(w)) return "stop";
  if (["START", "YES", "UNSTOP"].includes(w)) return "start";
  if (["HELP", "INFO"].includes(w)) return "help";
  return null;
}

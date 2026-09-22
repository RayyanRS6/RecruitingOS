import { timingSafeEqual } from "node:crypto";
import type { EmailAdapter, OutboundEmail, SendResult } from "../types";

/**
 * Postmark delivery events (bounce and spam-complaint webhooks). Parsed into one shape the processor understands, with the
 * classification the runbook needs: is this address dead (hard), complaining (never again), or temporarily unreachable.
 */
export type EmailEvent = {
  provider: "postmark";
  recordType: "Bounce" | "SpamComplaint" | "Delivery" | "Other";
  externalId: string;
  messageId: string | null;
  email: string;
  type: string;
  description: string;
  at: string;
  hard: boolean;
  complaint: boolean;
  soft: boolean;
  metadata: Record<string, string>;
};

const HARD = new Set(["HardBounce", "SpamNotification", "Unsubscribe", "ManuallyDeactivated", "BadEmailAddress", "Blocked", "AddressChange", "SMTPApiError", "InboundError", "OpenRelayTest", "Unknown", "VirusNotification"]);
const SOFT = new Set(["SoftBounce", "Transient", "DnsError", "DMARCPolicy", "TemplateRenderingFailed", "ChallengeVerification", "AutoResponder", "ContentRestriction"]);

export function parsePostmarkEvent(payload: Record<string, unknown>): EmailEvent | null {
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : "");
  const recordType = (["Bounce", "SpamComplaint", "Delivery"].includes(str("RecordType")) ? str("RecordType") : "Other") as EmailEvent["recordType"];
  const id = payload.ID !== undefined ? String(payload.ID) : str("MessageID");
  if (!id) return null;
  const type = str("Type") || (recordType === "SpamComplaint" ? "SpamComplaint" : recordType);
  const complaint = recordType === "SpamComplaint" || type === "SpamComplaint" || type === "SpamNotification";
  const metadata = (payload.Metadata && typeof payload.Metadata === "object" ? payload.Metadata : {}) as Record<string, string>;
  return {
    provider: "postmark", recordType, externalId: `${recordType}:${id}`, messageId: str("MessageID") || null, email: str("Email") || str("Recipient"), type, description: str("Description") || str("Details") || str("Name"), at: str("BouncedAt") || str("ReceivedAt") || new Date().toISOString(),
    hard: !complaint && recordType === "Bounce" && (HARD.has(type) || !SOFT.has(type)), complaint, soft: !complaint && recordType === "Bounce" && SOFT.has(type), metadata,
  };
}

/** Postmark can send HTTP basic credentials on the webhook URL; a custom header works too. Fails closed when nothing matches. */
export function verifyPostmarkWebhookAuth(headers: { authorization?: string | null; secretHeader?: string | null }, secret: string): boolean {
  const safe = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
  if (headers.secretHeader && safe(headers.secretHeader, secret)) return true;
  const auth = headers.authorization ?? "";
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const pass = decoded.includes(":") ? decoded.slice(decoded.indexOf(":") + 1) : decoded;
    return safe(pass, secret);
  }
  return false;
}

/** Builds the payload Postmark would post for a message the fake adapter sent (tests and the development outbox). */
export function fakePostmarkEvent(input: { providerMessageId: string; email: string; type: "HardBounce" | "SoftBounce" | "SpamComplaint" | "Transient" | "Unsubscribe"; id?: number; idempotencyKey?: string }): Record<string, unknown> {
  const id = input.id ?? Math.floor(Math.random() * 1e9);
  const isComplaint = input.type === "SpamComplaint";
  return { RecordType: isComplaint ? "SpamComplaint" : "Bounce", ID: id, Type: input.type, TypeCode: isComplaint ? 512 : input.type === "HardBounce" ? 1 : 4096, MessageID: input.providerMessageId, Email: input.email, From: "updates@hire.identifiedtalent.com", Description: isComplaint ? "The recipient marked the message as spam." : input.type === "HardBounce" ? "The server was unable to deliver your message (ex: unknown user, mailbox not found)." : "The message was rejected temporarily; the server asked us to try later.", Details: "fake", BouncedAt: new Date().toISOString(), Inactive: isComplaint || input.type === "HardBounce", CanActivate: !isComplaint, Metadata: input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {} };
}

/**
 * Puts the do-not-send list in front of any email adapter without changing what the adapter is: the guard is a proxy
 * whose target is the adapter itself, so `instanceof`, `sent`, `failNext` and every other property keep working.
 */
export function guardEmailAdapter<T extends EmailAdapter>(inner: T, lookup: (address: string) => Promise<{ reason: string } | null>): T {
  const guardedSend = async (msg: OutboundEmail): Promise<SendResult> => {
    const hit = await lookup(msg.to);
    if (hit) return { status: "failed", error: `address suppressed (${hit.reason.replace(/_/g, " ")}); no email is sent to it until an administrator releases it`, retryable: false };
    return inner.send(msg);
  };
  return new Proxy(inner, { get(target, prop, receiver) { return prop === "send" ? guardedSend : Reflect.get(target, prop, receiver); } });
}

/** Wraps any email adapter with the do-not-send list; the lookup is supplied by the application (it needs the database). */
export class SuppressingEmailAdapter implements EmailAdapter {
  constructor(private inner: EmailAdapter, private lookup: (address: string) => Promise<{ reason: string } | null>) {}
  get id() { return this.inner.id; }
  get status() { return this.inner.status; }
  async send(msg: OutboundEmail): Promise<SendResult> {
    const hit = await this.lookup(msg.to);
    if (hit) return { status: "failed", error: `address suppressed (${hit.reason.replace(/_/g, " ")}); no email is sent to it until an administrator releases it`, retryable: false };
    return this.inner.send(msg);
  }
  /** The wrapped adapter, for tests and development tooling. */
  get underlying(): EmailAdapter { return this.inner; }
}

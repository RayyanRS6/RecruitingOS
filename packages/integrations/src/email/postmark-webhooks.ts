import { createHash, timingSafeEqual } from "node:crypto";
import type { EmailAdapter, OutboundEmail, SendResult } from "../types";

/**
 * Postmark delivery events (bounce and spam-complaint webhooks). Parsed into one shape the processor understands, with the
 * classification the runbook needs: is this address dead (hard), complaining (never again), or temporarily unreachable.
 */
export type EmailEvent = {
  provider: "postmark";
  recordType: "Bounce" | "SpamComplaint" | "Delivery" | "SubscriptionChange" | "Other";
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
  /**
   * A SubscriptionChange (H10): Postmark suppressed the address (the recipient unsubscribed, or someone at Postmark
   * suppressed it by hand or after a bounce or complaint) or reactivated it. `suppress` true is honoured as a
   * suppression with reason `subscription_change`, never retried; false is recorded only, since a release needs an
   * administrator's confirmation. `hard` is set to `suppress` so any consumer that sees only a bounce suppresses
   * rather than re-sends.
   */
  subscription?: { suppress: boolean; reason: string; origin: string };
};

const HARD = new Set(["HardBounce", "SpamNotification", "Unsubscribe", "ManuallyDeactivated", "BadEmailAddress", "Blocked", "AddressChange", "SMTPApiError", "InboundError", "OpenRelayTest", "Unknown", "VirusNotification"]);
const SOFT = new Set(["SoftBounce", "Transient", "DnsError", "DMARCPolicy", "TemplateRenderingFailed", "ChallengeVerification", "AutoResponder", "ContentRestriction"]);

export function parsePostmarkEvent(payload: Record<string, unknown>): EmailEvent | null {
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : "");
  if (str("RecordType") === "SubscriptionChange") return parseSubscriptionChange(payload);
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

/**
 * Postmark's SubscriptionChange webhook carries no event id: the message id (all zeros for a manual change), the
 * change time and the recipient identify it. The external id used for once-only processing is built from the first
 * two and a short digest of the address, so the receipt table never holds the address itself.
 */
function parseSubscriptionChange(payload: Record<string, unknown>): EmailEvent | null {
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : "");
  const email = str("Recipient") || str("Email");
  if (!email) return null;
  const messageId = str("MessageID");
  const suppress = payload.SuppressSending === true || payload.SuppressSending === "true";
  // Postmark always sends ChangedAt. Should it be missing, the id must still be the same on every redelivery (the
  // receipt table processes each id once), so a fixed marker stands in for the time and the direction of the change
  // keeps a suppression and a reactivation apart; the record itself is stamped with the time it arrived.
  const changedAt = str("ChangedAt");
  const at = changedAt || new Date().toISOString();
  const reason = str("SuppressionReason") || (suppress ? "ManualSuppression" : "Reactivated");
  const origin = str("Origin") || "Unknown";
  const metadata = (payload.Metadata && typeof payload.Metadata === "object" ? payload.Metadata : {}) as Record<string, string>;
  return {
    provider: "postmark",
    recordType: "SubscriptionChange",
    externalId: `SubscriptionChange:${messageId || "manual"}:${changedAt || `unknown-${suppress ? "suppressed" : "reactivated"}`}:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`,
    messageId: messageId && !/^0+(-0+)*$/.test(messageId) ? messageId : null,
    email,
    type: suppress ? "SubscriptionChange" : "SubscriptionReactivated",
    description: suppress ? `${origin === "Recipient" ? "The recipient unsubscribed" : `Postmark suppressed the address (${origin})`}: ${reason}.` : `The address was reactivated at Postmark (${origin}).`,
    at,
    hard: suppress,
    complaint: false,
    soft: false,
    metadata,
    subscription: { suppress, reason, origin },
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

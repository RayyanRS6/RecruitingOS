import type { RolePacket } from "@ros/contracts";

/** Founder decision F4: only verified states. `live` means connected and working; boards use the posting states below. */
export type AdapterStatus = "live" | "not_connected" | "manual_action_required" | "awaiting_verification" | "fake" | "disabled";

/** The five channel states shown to customers. */
export type PostingState = "live_verified" | "awaiting_verification" | "manual_action_required" | "not_connected" | "failed";

export type OutboundEmail = {
  to: string;
  from: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** Idempotency key: the same key never sends twice. */
  idempotencyKey: string;
  tags?: Record<string, string>;
  /** Small files such as an iCalendar invitation; content is base64. */
  attachments?: Array<{ filename: string; contentType: string; contentBase64: string }>;
};

export type SendResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "pending"; reason: string }
  | { status: "failed"; error: string; retryable: boolean };

export type InboundAttachment = { filename: string; contentType: string; contentBase64: string; sizeBytes: number };

export type InboundEmail = {
  to: string;
  from: string;
  fromName?: string;
  subject: string;
  text: string;
  html?: string;
  attachments: InboundAttachment[];
  messageId?: string;
  receivedAt: string;
};

export interface EmailAdapter {
  readonly id: string;
  readonly status: AdapterStatus;
  send(msg: OutboundEmail): Promise<SendResult>;
}

export type OutboundSms = { to: string; body: string; idempotencyKey: string };

export interface SmsAdapter {
  readonly id: string;
  readonly status: AdapterStatus;
  send(msg: OutboundSms): Promise<SendResult>;
}

export type PostingInput = {
  roleId: string;
  companyName: string;
  companySlug: string;
  packet: RolePacket;
  jobUrl: string;
  applyUrl: string;
  intakeAddress?: string;
};

export type PublishResult =
  | { status: "live_verified" | "awaiting_verification"; externalId?: string; externalUrl?: string; instructions?: string }
  | { status: "manual_action_required" | "not_connected"; instructions: string; externalUrl?: string }
  | { status: "failed"; error: string; retryable: boolean };

export interface JobBoardAdapter {
  readonly channel: string;
  readonly status: AdapterStatus;
  publish(input: PostingInput): Promise<PublishResult>;
  expire(input: { roleId: string; externalId?: string | null }): Promise<void>;
}

export type CompBenchmark = { metro: string; basis: "hourly" | "salary"; p25: number; p50: number; p75: number; source: string; asOf: string };

export interface CompAdapter {
  readonly id: string;
  readonly status: AdapterStatus;
  benchmark(query: { title: string; socCode?: string; locationText?: string; basis?: "hourly" | "salary" }): Promise<CompBenchmark | null>;
}

export interface StorageAdapter {
  readonly id: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<{ key: string }>;
  get(key: string): Promise<Uint8Array | null>;
  /** Removes a file (privacy requests). Idempotent: a missing key is not an error. */
  delete(key: string): Promise<void>;
}

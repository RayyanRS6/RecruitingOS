import { createHmac } from "node:crypto";
import type { ProductEvent, ProductEventName } from "./types";

/** Domain event → product event. Anything not listed is not sent to analytics at all. */
const MAP: Record<string, ProductEventName> = {
  "application.received": "application_completed",
  "screen.invited": "screening_invited",
  "screen.started": "screening_started",
  "screen.completed": "screening_completed",
  "screen.human_requested": "human_requested",
  "interview.requested": "interview_approved",
  "interview.scheduling_started": "scheduling_started",
  "interview.scheduled": "scheduling_completed",
  "application.withdrawn": "candidate_withdrew",
};

const ALLOWED_CHANNELS = new Set(["web", "sms", "email", "careers_page", "email_in"]);
const ALLOWED_OUTCOMES = new Set(["hired_externally", "candidate_withdrew", "employer_declined", "offer_declined_externally", "no_hire", "filled", "filled_outside_platform", "role_cancelled", "voided"]);

export function refFor(id: string, salt: string): string {
  return createHmac("sha256", salt).update(id).digest("hex").slice(0, 24);
}

/**
 * Builds the analytics event for a domain event, or null when the domain event is not part of the funnel.
 * The payload is never copied: only an enumerated channel or source survives, and identifiers are keyed hashes.
 */
export function toProductEvent(input: { type: string; companyId: string | null; subjectId: string; occurredAt?: string; payload?: Record<string, unknown> }, salt: string): ProductEvent | null {
  let name = MAP[input.type];
  // 21 Sep, item 4: outcomes recorded by people feed the approved metrics with an enumerated value and nothing else.
  let outcome: string | undefined;
  let previous: string | undefined;
  if (input.type === "outcome.corrected" && typeof input.payload?.outcome === "string" && ALLOWED_OUTCOMES.has(input.payload.outcome as string)) {
    outcome = input.payload.outcome as string;
    previous = typeof input.payload?.previous === "string" && ALLOWED_OUTCOMES.has(input.payload.previous as string) ? (input.payload.previous as string) : undefined;
    name = "outcome_corrected";
  }
  if (input.type === "outcome.recorded" && typeof input.payload?.outcome === "string" && ALLOWED_OUTCOMES.has(input.payload.outcome as string)) {
    outcome = input.payload.outcome as string;
    name = input.payload.level === "role" ? "role_outcome_recorded" : outcome === "hired_externally" ? "hire_recorded" : "outcome_recorded";
  }
  if (!name || !input.companyId) return null;
  const applicationId = typeof input.payload?.applicationId === "string" ? (input.payload.applicationId as string) : input.subjectId;
  const channel = typeof input.payload?.channel === "string" && ALLOWED_CHANNELS.has(input.payload.channel as string) ? (input.payload.channel as string) : undefined;
  const source = typeof input.payload?.source === "string" && ALLOWED_CHANNELS.has(input.payload.source as string) ? (input.payload.source as string) : undefined;
  return { name, subjectRef: refFor(applicationId, salt), companyRef: refFor(input.companyId, salt), at: input.occurredAt ?? new Date().toISOString(), properties: { ...(channel ? { channel } : {}), ...(source ? { source } : {}), ...(outcome ? { outcome } : {}), ...(previous ? { previous } : {}) } };
}

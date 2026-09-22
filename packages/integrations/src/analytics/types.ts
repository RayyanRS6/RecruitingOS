import type { AdapterStatus } from "../types";

/**
 * Founder decision (15 Sep 2026, correction 14): product analytics never touches candidate pages and never carries
 * candidate PII. Only these aggregated funnel events exist, keyed by random internal identifiers.
 */
export const PRODUCT_EVENT_NAMES = [
  "application_started",
  "hire_recorded",
  "outcome_corrected",
  "outcome_recorded",
  "role_outcome_recorded",
  "application_completed",
  "screening_invited",
  "screening_started",
  "screening_completed",
  "human_requested",
  "interview_approved",
  "scheduling_started",
  "scheduling_completed",
  "candidate_withdrew",
] as const;
export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number];

export type ProductEvent = {
  name: ProductEventName;
  /** Keyed hash of the application id: stable, random-looking, not reversible without the salt. */
  subjectRef: string;
  /** Keyed hash of the company id. */
  companyRef: string;
  at: string;
  /** Only enumerated, non-identifying properties. */
  properties: { channel?: string; source?: string; outcome?: string; previous?: string };
};

export interface AnalyticsAdapter {
  readonly id: string;
  readonly status: AdapterStatus;
  capture(event: ProductEvent): Promise<void>;
}

import { z } from "zod";

export const ApplicationStage = z.enum([
  "applied",
  "received",
  "ineligible",
  "eligible",
  "triaged",
  "screen_invited",
  "screening",
  "screen_complete",
  "interview_recommended",
  "interview_scheduled",
  "interview_complete",
  "debrief",
  "finalist",
  "reference_check",
  "offer_draft",
  "offer_approval",
  "offer_sent",
  "negotiation",
  "accepted",
  "declined",
  "hired",
  "onboarding",
  "withdrawn",
  "rejected",
  "talent_pool",
]);
export type ApplicationStage = z.infer<typeof ApplicationStage>;

export const TERMINAL_STAGES: ReadonlySet<ApplicationStage> = new Set(["hired", "withdrawn", "rejected", "talent_pool", "declined"]);

/** Owner Mode groups stages into plain language. */
export const OwnerGroup = z.enum(["waiting_on_you", "in_process", "not_moving_forward", "hired"]);
export type OwnerGroup = z.infer<typeof OwnerGroup>;

export const RoleStatus = z.enum(["draft", "pending_approval", "open", "paused", "filled", "closed"]);
export type RoleStatus = z.infer<typeof RoleStatus>;

export const RejectReason = z.enum([
  "eligibility",
  "not_a_match_experience",
  "not_a_match_skills",
  "compensation_mismatch",
  "location_or_schedule",
  "position_filled",
  "role_closed",
  "candidate_unresponsive",
  "other",
]);
export type RejectReason = z.infer<typeof RejectReason>;

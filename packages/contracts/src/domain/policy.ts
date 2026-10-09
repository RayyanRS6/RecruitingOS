import { z } from "zod";

export const PolicyLevel = z.enum(["auto", "auto_notify", "approval", "human_only"]);
export type PolicyLevel = z.infer<typeof PolicyLevel>;

/** Every action the system can take on behalf of a customer is one of these. docs/06 lists the defaults. */
export const ActionType = z.enum([
  "role_packet.propose",
  "role_packet.approve",
  "role.publish",
  "posting.sponsor_spend",
  "message.send_templated",
  "message.send_freeform",
  /** A short "still reviewing" note to someone who has waited a long time for a decision (plan G10). */
  "message.still_reviewing",
  "application.triage",
  "application.hold_ineligible",
  "application.reject_ineligible",
  "application.reject_on_assessment",
  "application.invite_screen",
  "screen.conduct",
  "application.recommend_interview",
  "interview.request",
  "interview.schedule",
  "interview.reschedule",
  "interview.record",
  "scorecard.draft",
  "debrief.recommend",
  "candidate.hire_decision",
  "offer.draft",
  "offer.send",
  "offer.negotiate",
  "offer.revise",
  "disposition.send",
  "reference.request",
  "background_check.order",
  "background_check.adverse_action",
  "employee.create_in_hris",
  "welcome.send",
  "checkin.request",
  "policy.change",
  "knockout_rule.change",
  "notice_text.change",
  "data.delete",
  "data.export",
  "intervention.nudge",
  "intervention.offer_recruiter",
  "sourcing.search_internal",
  "sourcing.enrich_external",
  "outreach.send",
]);
export type ActionType = z.infer<typeof ActionType>;

export const Policy = z.object({
  actionType: ActionType,
  level: PolicyLevel,
  approverRoles: z.array(z.string()).default([]),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type Policy = z.infer<typeof Policy>;

export const PolicyDecision = z.object({
  actionType: ActionType,
  level: PolicyLevel,
  approverRoles: z.array(z.string()),
  source: z.enum(["role", "company", "default", "takeover"]),
  params: z.record(z.string(), z.unknown()),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;

export const ApprovalStatus = z.enum(["pending", "approved", "rejected", "expired", "cancelled"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

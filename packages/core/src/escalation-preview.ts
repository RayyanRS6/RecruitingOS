/**
 * The recruiter queue before acceptance (founder decision I11, correction 11 of 18 September 2026).
 *
 * Until an ITS recruiter accepts an assignment they may see only: the customer name, the role title, the escalation
 * category, its urgency, the expertise it needs, the remaining service-level time, and a generic summary. Nothing
 * here is derived from free text a person typed (the customer's question can name a candidate), and nothing here
 * comes from the candidate's record. The summary is a template chosen by category; the customer's own words open
 * only under a grant.
 */

export const ESCALATION_URGENCIES = ["low", "normal", "high", "critical"] as const;
export type EscalationUrgency = (typeof ESCALATION_URGENCIES)[number];

/** Exactly the fields a pre-acceptance queue row may carry. The automated test holds responses to this list. */
export const ESCALATION_PREVIEW_FIELDS = [
  "id", "status", "kind", "urgency", "requiredExpertise", "summary", "companyName", "roleTitle",
  "slaDueAt", "slaRemainingMinutes", "businessMinutesRemaining", "overdue", "createdAt", "claimedByMe", "claimed",
] as const;

/** Keys that must never appear in any response before acceptance (candidate identity, excerpts, contacts, evaluation, money, or identifiers that lead to them). */
export const ESCALATION_PREVIEW_FORBIDDEN_KEYS = [
  "question", "questionPreview", "contextSnapshot", "candidate", "candidateId", "applicationId", "roleId", "companyId",
  "resumeText", "resume", "transcript", "transcripts", "communications", "assessments", "scorecards", "screens",
  "compensation", "salary", "email", "phone", "firstName", "lastName", "name", "requestedBy", "assignedToUserId",
  "resolution", "answers", "eligibility", "documents", "timeline", "payload", "billing",
] as const;

export type EscalationPreview = {
  id: string;
  status: string;
  kind: string;
  urgency: EscalationUrgency;
  requiredExpertise: string;
  summary: string;
  companyName: string;
  roleTitle: string | null;
  slaDueAt: string | null;
  /** Wall-clock minutes until the deadline; negative when overdue. */
  slaRemainingMinutes: number | null;
  /** Business minutes until the deadline on the ITS calendar; negative when overdue. */
  businessMinutesRemaining: number | null;
  overdue: boolean;
  createdAt: string;
  claimedByMe: boolean;
  claimed: boolean;
};

export function defaultUrgency(kind: string): EscalationUrgency {
  switch (kind) {
    case "platform_blocking": return "critical";
    case "candidate_issue": case "negotiation": return "high";
    case "ask": case "review": case "takeover": case "search_support": case "stuck_role": case "data_request": return "normal";
    default: return "normal";
  }
}

const EXPERTISE: Record<string, string> = {
  ask: "hiring advice",
  review: "candidate evaluation",
  takeover: "full-cycle recruiting",
  negotiation: "offer negotiation",
  search_support: "sourcing",
  candidate_issue: "candidate care",
  stuck_role: "pipeline recovery",
  data_request: "privacy requests",
  platform_blocking: "platform support",
  post_job: "job board posting",
  update_job: "job board posting",
  take_down_job: "job board posting",
};

/** What the assignment needs from the recruiter, plus the customer's industry so the right person picks it up. */
export function requiredExpertise(kind: string, vertical?: string | null): string {
  const base = EXPERTISE[kind] ?? "recruiting";
  return vertical ? `${base}; ${vertical.replace(/_/g, " ")} hiring` : base;
}

/** Template text only. Never interpolate a person's words, a candidate's name, or anything from a candidate record. */
export function genericSummary(kind: string, opts: { hasRole?: boolean; hasApplication?: boolean; origin?: "customer" | "system" | "candidate" } = {}): string {
  const role = opts.hasRole ? "for this role" : "for their hiring";
  switch (kind) {
    case "ask": return `The customer wants a recruiter's advice ${role}.`;
    case "review": return opts.hasApplication ? `The customer wants a recruiter to review one candidate ${role}.` : `The customer wants a recruiter to review the candidates ${role}.`;
    case "takeover": return `The customer wants ITS to run this role.`;
    case "negotiation": return `The customer wants help with an offer conversation ${role}.`;
    case "search_support": return `The customer wants sourcing help ${role}.`;
    case "candidate_issue": return opts.origin === "system"
      ? `The screening assistant could not continue with a candidate ${role}; a person needs to follow up.`
      : `A candidate ${role} asked for a person; the hiring team needs a recruiter to follow up.`;
    case "stuck_role": return `This role has stalled; the hiring team has not acted on reminders.`;
    case "data_request": return `A privacy request needs handling under the privacy runbook.`;
    case "platform_blocking": return `Something in the product is blocking the customer's hiring process.`;
    // ITS posting tasks (plan D3): the board's name, from a fixed list, is added by packages/core/src/posting-tasks.ts.
    case "post_job": return `Post this role on a job board from the customer's own account.`;
    case "update_job": return `Bring this role's job board listing up to date with the approved version.`;
    case "take_down_job": return `Take this role's listing down from a job board; the role or the listing was closed.`;
    default: return `The customer needs a recruiter ${role}.`;
  }
}

/** Builds the pre-acceptance row. The caller supplies the remaining-time figures from the business calendar. */
export function toEscalationPreview(input: {
  id: string; status: string; kind: string; urgency: string; requiredExpertise: string; summary: string;
  companyName: string; roleTitle: string | null; slaDueAt: string | null; createdAt: string; assignedToUserId: string | null;
  viewerUserId: string; now: Date; businessMinutesRemaining: number | null;
}): EscalationPreview {
  const remaining = input.slaDueAt ? Math.round((Date.parse(input.slaDueAt) - input.now.getTime()) / 60_000) : null;
  return {
    id: input.id,
    status: input.status,
    kind: input.kind,
    urgency: (ESCALATION_URGENCIES as readonly string[]).includes(input.urgency) ? (input.urgency as EscalationUrgency) : "normal",
    requiredExpertise: input.requiredExpertise,
    summary: input.summary,
    companyName: input.companyName,
    roleTitle: input.roleTitle,
    slaDueAt: input.slaDueAt,
    slaRemainingMinutes: remaining,
    businessMinutesRemaining: input.businessMinutesRemaining,
    overdue: remaining !== null && remaining < 0 && !["resolved", "cancelled"].includes(input.status),
    createdAt: input.createdAt,
    claimedByMe: input.assignedToUserId === input.viewerUserId,
    claimed: !!input.assignedToUserId,
  };
}

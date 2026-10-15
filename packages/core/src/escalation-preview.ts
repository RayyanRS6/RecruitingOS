/**
 * The recruiter queue before acceptance (founder decision I11, correction 11 of 18 September 2026).
 *
 * Until an ITS recruiter accepts an assignment they may see only: the customer name, the role title, the escalation
 * category, its urgency, the expertise it needs, the remaining service-level time, and a generic summary. Nothing
 * here is derived from free text a person typed (the customer's question can name a candidate), and nothing here
 * comes from the candidate's record. The summary is a template chosen by category, worded for who raised the request
 * (the customer, Recruiting OS on its own, or a candidate), which the server reads from the row and never sends; the
 * customer's own words open only under a grant.
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

/** ITS posting tasks (plan D3) carry their own template summary, whoever raised them. */
const POSTING_KINDS: ReadonlySet<string> = new Set(["post_job", "update_job", "take_down_job"]);

const RAISED_AUTOMATICALLY = "Raised automatically by Recruiting OS:";
const rolePhrase = (hasRole: boolean | undefined) => (hasRole ? "for this role" : "for their hiring");

/**
 * A request Recruiting OS raised on its own (a stopped run, a held applicant's reminder, a stalled role, an interview it
 * could not arrange) says so, so the recruiter never reads it as the customer asking (15 October 2026). Template text,
 * like the rest, and true for every request of its kind: a review about one candidate may be a stopped run to take over
 * or a held applicant the customer must decide on, so it says only that it needs a review. The posting tasks keep their
 * own sentences.
 */
function systemSummary(kind: string, hasApplication: boolean | undefined, role: string): string | null {
  if (POSTING_KINDS.has(kind)) return null;
  switch (kind) {
    case "review": return hasApplication ? `${RAISED_AUTOMATICALLY} one candidate's application needs a recruiter's review.` : `${RAISED_AUTOMATICALLY} the candidates ${role} need a recruiter's review.`;
    case "takeover": return `${RAISED_AUTOMATICALLY} this role needs ITS to take over.`;
    case "stuck_role": return `${RAISED_AUTOMATICALLY} this role has stalled and needs a recruiter.`;
    // Not only screening: an interview nobody could arrange, people not told a decision (a role, no one candidate).
    case "candidate_issue": return hasApplication ? `${RAISED_AUTOMATICALLY} a candidate ${role} needs a person to follow up.` : `${RAISED_AUTOMATICALLY} candidates ${role} need a person to follow up.`;
    default: return `${RAISED_AUTOMATICALLY} this needs a recruiter ${role}.`;
  }
}

/**
 * The screening assistant could not continue (packages/agents/src/screening.ts `requestHuman`, when the candidate did not
 * ask): its caller passes this as the summary, since only it knows the cause. Template text.
 */
export function screeningStoppedSummary(hasRole: boolean): string {
  return `${RAISED_AUTOMATICALLY} the screening assistant could not continue with a candidate ${rolePhrase(hasRole)}; a person needs to follow up.`;
}

/** What every automatic candidate's issue said before 15 October 2026, whatever its cause. Kept only to recognise old rows. */
const OLD_SYSTEM_CANDIDATE_ISSUE = (role: string) => `The screening assistant could not continue with a candidate ${role}; a person needs to follow up.`;

/** Template text only. Never interpolate a person's words, a candidate's name, or anything from a candidate record. */
export function genericSummary(kind: string, opts: { hasRole?: boolean; hasApplication?: boolean; origin?: "customer" | "system" | "candidate" } = {}): string {
  const role = rolePhrase(opts.hasRole);
  const automatic = opts.origin === "system" ? systemSummary(kind, opts.hasApplication, role) : null;
  if (automatic) return automatic;
  switch (kind) {
    case "ask": return `The customer wants a recruiter's advice ${role}.`;
    case "review": return opts.hasApplication ? `The customer wants a recruiter to review one candidate ${role}.` : `The customer wants a recruiter to review the candidates ${role}.`;
    case "takeover": return `The customer wants ITS to run this role.`;
    case "negotiation": return `The customer wants help with an offer conversation ${role}.`;
    case "search_support": return `The customer wants sourcing help ${role}.`;
    case "candidate_issue": return `A candidate ${role} asked for a person; the hiring team needs a recruiter to follow up.`;
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

/**
 * The summary as it is served (the queue, the request page, the ITS console and emails). Requests Recruiting OS raised
 * before 15 October 2026 stored the customer's template ("The customer wants...") or, for a candidate's issue, a sentence
 * that blamed the screening assistant whatever the cause; those read in today's words. The inputs come from the row on
 * the server (who raised it, whether it names a role or a candidate); none of them is ever put in a preview. A candidate's
 * own request can arrive through a system actor (an emailed HUMAN reply): its sentence is not an old automatic one, so it
 * stays as stored.
 */
export function previewSummary(input: { kind: string; storedSummary: string; requestedByKind: string | null | undefined; hasRole: boolean; hasApplication: boolean }): string {
  if (input.requestedByKind !== "system" || POSTING_KINDS.has(input.kind)) return input.storedSummary;
  const opts = { hasRole: input.hasRole, hasApplication: input.hasApplication };
  const old = input.kind === "candidate_issue" ? OLD_SYSTEM_CANDIDATE_ISSUE(rolePhrase(input.hasRole)) : genericSummary(input.kind, { ...opts, origin: "customer" });
  return input.storedSummary === old ? genericSummary(input.kind, { ...opts, origin: "system" }) : input.storedSummary;
}

type StoredRequest = { kind: string; summary: string; requestedBy: { kind: string } | null | undefined; roleId: string | null; applicationId: string | null };

/** `previewSummary` for a stored escalation row. */
export function servedSummary(row: StoredRequest): string {
  return previewSummary({ kind: row.kind, storedSummary: row.summary, requestedByKind: row.requestedBy?.kind, hasRole: !!row.roleId, hasApplication: !!row.applicationId });
}

export type RequestOrigin = "customer" | "recruiter" | "candidate" | "system";

/**
 * Who raised a request, for the words around it once it is open (the thread's first heading, the customer's notice when
 * a recruiter is brought in). Never a name. A candidate's own request can arrive through a system actor (a HUMAN reply by
 * email, the screening hand-over they chose); its summary, chosen for the candidate when it was raised, says so.
 */
export function requestOrigin(row: StoredRequest): RequestOrigin {
  const by = row.requestedBy?.kind;
  if (by === "recruiter") return "recruiter";
  if (by === "candidate") return "candidate";
  if (by !== "system") return "customer";
  const asked = row.kind === "candidate_issue" && row.summary === genericSummary("candidate_issue", { hasRole: !!row.roleId, hasApplication: !!row.applicationId, origin: "candidate" });
  return asked ? "candidate" : "system";
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

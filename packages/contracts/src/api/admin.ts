import { z } from "zod";
import type { Actor, Location } from "../domain/common";
import type { AccessRequestStatus, CustomerAccessChange, CustomerAccessRequest } from "../domain/company";
import type { PublicPlanKey } from "../domain/plans";
import type { RoleStatus } from "../domain/stages";
import type { TrialStanding, TrialTerm } from "../domain/trial";
import type { UsageLine } from "./settings";

/**
 * The admin dashboard: Companies (requests to accept or decline, the list, a company with its plan and its jobs),
 * Privacy requests and System. Platform administrators only, with a second factor; every call is recorded in the audit
 * history, reads included. Nothing here about a company's jobs ever carries a candidate's name, email, CV or answers:
 * counts only.
 *
 * Times in the shapes this file adds (`AdminCompany`, `AdminCompanyJobs`) are ISO. The System and privacy shapes pass
 * the database's own timestamps through (Postgres text, "2026-11-18 09:30:00.123+00"), which `new Date(...)` reads.
 */

/* ------------------------------------------------------------------------------------------------------------ */
/* Companies.                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------ */

/** Where a company stands with the one gate: accepted and live, waiting for an answer, or declined (or its access taken away). */
export const AdminCompanyStatus = z.enum(["active", "waiting", "declined"]);
export type AdminCompanyStatus = z.infer<typeof AdminCompanyStatus>;
export const ADMIN_COMPANY_STATUS_LABEL: Record<AdminCompanyStatus, string> = { active: "Active", waiting: "Waiting", declined: "Declined" };

/** A company's status from its owner's request: none is active, `requested` is waiting, `declined` is declined. */
export function adminCompanyStatus(request: { status: AccessRequestStatus } | null | undefined): AdminCompanyStatus {
  return !request ? "active" : request.status === "requested" ? "waiting" : "declined";
}

/** The access decisions a row offers: Accept and Decline for a request, Accept (the undo) for a declined company, Take away access for an active one. */
export function accessDecisionsFor(status: AdminCompanyStatus): Array<CustomerAccessChange["decision"]> {
  return status === "waiting" ? ["accept", "decline"] : status === "declined" ? ["accept"] : ["remove"];
}

/** A company's AI credit in dollars. Only an administrator reads this; a company reads a percentage and words. */
export type AdminAiCredit = { monthly: boolean; spentUsd: number; limitUsd: number; percent: number; level: "warning" | "used_up" | null; resetsAt: string | null };

/** A company's open request about its plan ("Asked to upgrade"): since when, the plan asked for, the request in words, and who asked. */
export type AdminPlanRequest = { since: string; planKey: PublicPlanKey | null; planName: string | null; words: string; requestedBy: string | null };

/**
 * One company (GET /api/v1/admin/customers answers every company, newest first). The page filters and searches the
 * list itself. `accessRequest`: for a waiting or declined company, who asked and what was decided; `owner`: for an
 * active one, an owner to write to. `accessDecisions`: the decisions POST /api/v1/admin/customers/:id/access takes for
 * it now. `usage`: the plan's usage lines as the company reads them; `aiCredit` and `aiCostUsd` are the same AI help in
 * dollars.
 */
export type AdminCompany = {
  id: string;
  name: string;
  slug: string;
  /** The kind of business, a plain label. */
  vertical: string;
  sizeBand: string;
  timezone: string;
  locations: Location[];
  website: string | null;
  /** When the company (or its request) was created. */
  createdAt: string;
  status: AdminCompanyStatus;
  statusLabel: string;
  accessRequest: CustomerAccessRequest | null;
  owner: { name: string | null; email: string } | null;
  accessDecisions: Array<CustomerAccessChange["decision"]>;
  planKey: string;
  planName: string;
  jobs: { open: number; total: number };
  /** Everyone who applied to any of its jobs, the people the plan keeps locked among them. */
  applicants: number;
  lockedApplicants: number;
  lastActivityAt: string | null;
  usage: UsageLine[];
  seats: { used: number; limit: number | null };
  aiCredit: AdminAiCredit | null;
  aiCostUsd: number;
  trial: TrialStanding | null;
  trialTerm: TrialTerm | null;
  planRequest: AdminPlanRequest | null;
  /** The company's careers page; null while it is not live. */
  careersUrl: string | null;
};

/**
 * One job of a company, for the administrator. Counts only. `shortlisted`, `interviewed` and `hired` are the people in
 * that tab of the job's Candidates list now; `applicants` is everyone who applied. `jobPageUrl`: the public job page,
 * null for a job that has none (a draft, a closed job, a company that is not live).
 */
export type AdminJobRow = { id: string; title: string; status: RoleStatus; statusLabel: string; publishedAt: string | null; applicants: number; shortlisted: number; interviewed: number; hired: number; jobPageUrl: string | null };

/** GET /api/v1/admin/customers/:id/jobs: every job of one company, newest first. */
export type AdminCompanyJobs = { company: { id: string; name: string }; jobs: AdminJobRow[] };

/** GET /api/v1/admin/plans: the plans a company can be put on, the public ones first. */
export type AdminPlanOption = { key: string; name: string; prices: Record<string, number>; limits: Record<string, number | null> };

/** POST /api/v1/admin/customers/:id/plan. The reason is required (five characters or more) and recorded. */
export const PlanChange = z.object({ planKey: z.string().min(1), pilotDays: z.number().int().min(1).max(365).optional(), extendUntil: z.string().optional(), reason: z.string().max(500).optional() });
export type PlanChange = z.infer<typeof PlanChange>;
/** What it answers: whether a trial ended with the change, how many locked applicants the new plan opened, and whether a monthly AI allowance started. */
export type PlanChangeAnswer = { trialEnded: boolean; unlocked: number; aiCreditMonthStarted: boolean };

/** What POST /api/v1/admin/customers/:id/trial answers. */
export type TrialExtensionAnswer = { ok: true; companyId: string; trial: TrialStanding | null };

/* ------------------------------------------------------------------------------------------------------------ */
/* System.                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------ */

/** An alert for an administrator. `status`: open or acknowledged. */
export type AdminAlert = { id: string; kind: string; severity: string; title: string; body: string; status: string; companyId: string | null; target: { type: string; id: string } | null; details: Record<string, unknown>; createdAt: string };
export type AdminFailedRun = { id: string; companyId: string | null; workflowKey: string; status: string; currentStep: string; attempts: number; lastError: string | null; updatedAt: string; subject: { type: string; id: string } };
export type AdminFailedJob = { id: number; kind: string; attempts: number; lastError: string | null; createdAt: string };
export type AdminFailedAiRun = { id: string; task: string; model: string; status: string; error: string | null; createdAt: string };

/** GET /api/v1/admin/failures (System, Health): the work that failed, and the alerts that are open or acknowledged. */
export type AdminFailures = { failedRuns: AdminFailedRun[]; failedJobs: AdminFailedJob[]; failedAi: AdminFailedAiRun[]; alerts: AdminAlert[] };

/** GET /api/v1/admin/queue (System, Health). */
export type AdminQueue = { queued: number; failed: number; oldestQueuedAt: string | null; waitingRuns: number; definitions: string[] };

/** POST /api/v1/admin/alerts/:id/resolve: an optional note. */
export type ResolveAlert = { note?: string };

/** GET /api/v1/admin/costs?since=YYYY-MM-DD (System, Costs): AI spend at list prices, by company, task and model. */
export type AdminCostRow = { companyId: string | null; task: string; model: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number };

/** GET /api/v1/admin/email-suppressions (System, Email): the addresses nothing is sent to. `?all=1` lists released ones too. */
export type EmailSuppression = { id: string; address: string; reason: string; source: string; active: boolean; count: number; firstAt: string; lastAt: string; details: Record<string, unknown>; releasedAt: string | null; releaseReason: string | null };
/** POST /api/v1/admin/email-suppressions: stop emails to an address, with a reason of five characters or more. */
export type SuppressAddress = { address: string; reason: string };
/** POST /api/v1/admin/email-suppressions/:id/release: with a reason. Never for a spam complaint. */
export type ReleaseSuppression = { reason: string };

export type CspReport = { id: string; mode: string; surface: string; documentPath: string; violatedDirective: string; effectiveDirective: string | null; blockedOrigin: string | null; sourceFile: string | null; lineNumber: number | null; userAgent: string | null; count: number; firstAt: string; lastAt: string; reviewedAt: string | null; reviewedBy: string | null; disposition: string | null };
/** GET /api/v1/admin/csp-reports (System, Security reports). */
export type CspReports = { mode: "report-only" | "enforce"; reports: CspReport[] };
/** POST /api/v1/admin/csp-reports/:id/review: what was decided about it, three characters or more. */
export type ReviewCspReport = { disposition: string };

export type PlatformRoleGrant = { id: string; userId: string; email: string; name: string | null; authProvider: string | null; role: string; source: string; grantedBy: Actor; grantReason: string; grantedAt: string; revokedAt: string | null; revokedBy: Actor | null; revokeReason: string | null };
/** GET /api/v1/admin/platform-roles (System, Administrators). */
export type PlatformRoleGrants = { grants: PlatformRoleGrant[]; activeAdmins: number; bootstrap: { configured: number; ignored: boolean } };
/** POST /api/v1/admin/platform-roles: make a staff address a platform administrator, with a reason and a confirmation. Never oneself. */
export type GrantPlatformRole = { email: string; role: "platform_admin"; reason: string; confirm: true };
/** POST /api/v1/admin/platform-roles/:grantId/revoke. The last administrator cannot be revoked. */
export type RevokePlatformRole = { reason: string; confirm: true };
export type PlatformRoleChanged = { ok: true; grantId: string; notified: number; failed: number };
/** POST /api/v1/admin/sessions/revoke: sign someone out everywhere, with a reason and a confirmation. */
export type RevokeSessions = { email: string; reason: string; confirm: true };
export type SessionsRevoked = { ok: true; sessionsEnded: number };

/* ------------------------------------------------------------------------------------------------------------ */
/* Privacy requests.                                                                                              */
/* ------------------------------------------------------------------------------------------------------------ */

/** What a candidate may ask for about their information. `withdrawal`: an application they withdrew, recorded as a request. */
export const DataRequestKind = z.enum(["access", "correct", "delete", "human_review", "withdrawal"]);
export type DataRequestKind = z.infer<typeof DataRequestKind>;
export const DATA_REQUEST_KIND_LABEL: Record<DataRequestKind, string> = { access: "A copy of their information", correct: "A correction", delete: "Deletion", human_review: "A review by a person", withdrawal: "Withdrew an application" };

/** The status-page form offers exactly these four; a withdrawal has its own button. */
export const CandidatePrivacyRequest = z.object({ kind: z.enum(["access", "correct", "delete", "human_review"]), details: z.string().max(2000).optional() });
/** The public privacy-request form: who is asking, what for, in their words; confirmed by an emailed link before anyone acts. `website` is the honeypot. */
export const PrivacyRequestForm = z.object({ email: z.email(), kind: z.enum(["access", "correct", "delete"]), details: z.string().trim().max(2000).optional(), company: z.string().trim().max(80).optional(), website: z.string().max(0).optional() });
export type PrivacyRequestForm = z.infer<typeof PrivacyRequestForm>;

export const AdminCreateDataRequest = z.object({ companyId: z.string().min(1), requesterEmail: z.email(), kind: DataRequestKind, details: z.string().max(2000).optional(), candidateId: z.string().optional(), applicationId: z.string().optional() });
export const DataRequestNote = z.object({ text: z.string().min(1).max(2000) });
export const DataRequestAssign = z.object({ userId: z.string().min(1).nullable() });
export const DataRequestVerify = z.object({ method: z.string().min(3).max(300), outcome: z.enum(["verified", "failed"]) });
export const DataRequestCounsel = z.object({ decision: z.enum(["pending", "approved", "declined"]), note: z.string().max(2000).optional() });
export const DataRequestFulfil = z.object({
  resolution: z.string().min(1).max(4000),
  /** correct: the field and the new value; delete: confirmation that the counsel-approved anonymization may run. */
  correction: z.object({ field: z.enum(["firstName", "lastName", "email", "phone", "locationText"]), value: z.string().min(1).max(300) }).optional(),
  confirmAnonymize: z.boolean().optional(),
});
export const DataRequestDecline = z.object({ resolution: z.string().min(1).max(4000) });

/**
 * One privacy request as the administrator reads it (GET /api/v1/admin/data-requests and every action on one). `kind` is
 * a `DataRequestKind` for every request made now; one recorded earlier may carry a kind that is gone.
 */
export type DataRequestView = {
  id: string;
  companyId: string;
  /** On the list and on one request; left out of an action's answer. */
  companyName?: string;
  candidateId: string | null;
  applicationId: string | null;
  kind: string;
  details: string | null;
  requesterEmail: string;
  channel: string;
  verificationStatus: string;
  verificationNote: string | null;
  verifiedAt: string | null;
  status: string;
  slaDueAt: string;
  assignedTo: string | null;
  notes: Array<{ at: string; by: string; text: string }>;
  counselEscalatedAt: string | null;
  counselDecision: string | null;
  counselNote: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  confirmationSentAt: string | null;
  createdAt: string;
};

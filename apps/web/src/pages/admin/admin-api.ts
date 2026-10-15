import type { ApplyMode } from "../../apply-flow";
import type { RecruiterAskStanding } from "../../recruiter-requests";

/**
 * What every part of the ITS console shares (redesign spec 3.4): the reason header the API audits each read with, the
 * query keys, the rows the API answers with that more than one section reads, and the section contract.
 */

/** Sent with every console call; the API writes it on the audit row of each read (routes/admin.ts). */
export const reason = { headers: { "x-admin-reason": "admin console" } };

/** The same header naming the part of the console that reads, for example `adminReason("overview")`. */
export function adminReason(where: string): { headers: { "x-admin-reason": string } } {
  return { headers: { "x-admin-reason": `admin console: ${where}` } };
}

/**
 * The console's query keys, as the sections use them today. A section that reads the same thing uses the same key, so
 * one answer serves the Overview and the section, and a change invalidates both.
 */
export const adminKeys = {
  customers: ["admin", "customers"],
  alerts: ["admin", "alerts"],
  plans: ["admin", "plans"],
  customerReport: (companyId: string) => ["admin", "customer-report", companyId],
  runs: (status: string) => ["admin", "runs", status],
  run: (id: string) => ["admin", "run", id],
  aiRuns: ["admin", "ai"],
  failures: ["admin", "failures"],
  suppressions: ["admin", "suppressions"],
  csp: ["admin", "csp"],
  failedEmailApplications: ["admin", "failed-email-applications"],
  costs: ["admin", "costs"],
  queue: ["admin", "queue"],
  calendar: ["admin", "calendar"],
  privacy: ["admin", "privacy"],
  privacyRequest: (id: string) => ["admin", "privacy", id],
  platformRoles: ["admin", "platform-roles"],
  outcomes: ["admin", "outcomes"],
} as const;

/**
 * A customer as GET /admin/customers lists it. `applyFlowDefault`: how the company's roles meet the screening
 * conversation unless a role has its own setting (plan E1). `candidateScoreShown`: whether its candidates see their
 * match score after sending (founder decision S7-1; on unless ITS turned it off; absent from an older API reads as on).
 */
export type CustomerRow ={ id: string; name: string; slug: string; vertical: string; sizeBand: string; planKey: string; status: string; roles: number; applications: number; aiCostUsd: number; lastActivityAt: string | null; escalations: number; createdAt: string; settings: { website?: string; candidateScoreSetBy?: { at: string; by: { id: string; name?: string }; reason: string } }; verifiedAt: string | null; verifiedBy: { id: string; name?: string } | null; heldMessages: number; jobBoardsConfirmedAt: string | null; recruiterAsks?: RecruiterAskStanding; applyFlowDefault?: ApplyMode; screeningConversations?: { used: number; limit: number | null; resetsAt?: string | null }; candidateScoreShown?: boolean };

/** An alert as GET /admin/alerts and GET /admin/failures list it. */
export type AlertRow ={ id: string; kind: string; severity: string; title: string; body: string; status: string; companyId: string | null; target: { type: string; id: string } | null; details: Record<string, unknown>; createdAt: string };

/** A privacy request as GET /admin/data-requests lists it. */
export type DataRequest ={ id: string; companyId: string; companyName?: string; candidateId: string | null; applicationId: string | null; kind: string; details: string | null; requesterEmail: string; channel: string; verificationStatus: string; verificationNote: string | null; status: string; slaDueAt: string; assignedTo: string | null; notes: Array<{ at: string; by: string; text: string }>; counselEscalatedAt: string | null; counselDecision: string | null; counselNote: string | null; resolution: string | null; resolvedAt: string | null; confirmationSentAt: string | null; escalationId: string | null; createdAt: string };

/**
 * The section contract (Wave S6): each console section (Customers, Problems, System and settings, Privacy requests) is
 * one component taking the part of it the address names (`?view=`, null for its first part) and a way to change it. The
 * console draws the page heading and keeps `?view=` in the address; the section draws its own part tabs (with counts,
 * where it has them) and the chosen part. A view it does not know shows its first part.
 */
export type SectionProps = { view: string | null; onView: (v: string) => void };

/** One part of a section: its `?view=` value and its tab label. */
export type SectionPart = { id: string; label: string };

/** The part to show for `view`: the one it names, or the section's first part when it names none of them. */
export function partOf(parts: readonly SectionPart[], view: string | null): string {
  return view && parts.some((p) => p.id === view) ? view : parts[0].id;
}

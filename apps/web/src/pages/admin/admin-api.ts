/**
 * What every part of the admin dashboard shares: the reason sent with each call, the query keys, and how a section with
 * several parts chooses the one to show. The shapes the API answers with are in @ros/contracts.
 */

/** Sent with every dashboard call; the API writes it on the audit record of each one, reads included. */
export const reason = { headers: { "x-admin-reason": "admin dashboard" } };

/** The same header naming what was pressed, for example `adminReason("access request")`. */
export function adminReason(what: string): { headers: { "x-admin-reason": string } } {
  return { headers: { "x-admin-reason": `admin dashboard: ${what}` } };
}

/**
 * The dashboard's query keys. Two parts that read the same thing use the same key, so one answer serves both and one
 * change refreshes both. A company's jobs sit under `companies`, so a change to a company reads its jobs again too.
 */
export const adminKeys = {
  companies: ["admin", "companies"],
  companyJobs: (companyId: string) => ["admin", "companies", companyId, "jobs"],
  plans: ["admin", "plans"],
  queue: ["admin", "queue"],
  failures: ["admin", "failures"],
  costs: ["admin", "costs"],
  suppressions: ["admin", "suppressions"],
  csp: ["admin", "csp"],
  privacy: ["admin", "privacy"],
  privacyRequest: (id: string) => ["admin", "privacy", id],
  platformRoles: ["admin", "platform-roles"],
} as const;

/**
 * A section with several parts (Privacy requests, System) is one component taking the part the address names (`?view=`,
 * null for its first part) and a way to change it. The dashboard draws the page heading and keeps `?view=` in the
 * address; the section draws its own tabs and the chosen part. A view it does not know shows its first part.
 */
export type SectionProps = { view: string | null; onView: (v: string) => void };

/** One part of a section: its `?view=` value and its tab label. */
export type SectionPart = { id: string; label: string };

/** The part to show for `view`: the one it names, or the section's first part when it names none of them. */
export function partOf(parts: readonly SectionPart[], view: string | null): string {
  return view && parts.some((p) => p.id === view) ? view : parts[0].id;
}

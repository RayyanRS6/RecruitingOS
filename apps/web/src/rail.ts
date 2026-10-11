/**
 * The left rail's decisions (apps/shell/components/AppShell.tsx), kept free of React so they can be tested: when the
 * rail folds to icons, whether and which roles are listed under Roles, and the words for the signed-in person's role.
 */

/** How many roles the rail lists under Roles; "All roles" leads to the rest. */
export const RAIL_ROLE_LIMIT = 8;

/** The rail folds to a column of icons on a role's own pages (the role, its talent, a candidate), where the work needs the width. */
export function railCompact(pathname: string | null | undefined): boolean {
  return /^\/roles\/[^/]+/.test(pathname ?? "");
}

const TEAM_ROLE_WORD: Record<string, string> = { owner: "Owner", admin: "Admin", hiring_manager: "Hiring manager", hr: "HR", interviewer: "Interviewer", recruiter: "Recruiter" };

/** The person's role in the company chip; an ITS recruiter inside a customer has no membership, only limited access. */
export function teamRoleWord(role: string | null | undefined, staffAccess: boolean): string | null {
  if (role) return TEAM_ROLE_WORD[role] ?? role.replace(/_/g, " ");
  return staffAccess ? "ITS recruiter, limited access" : null;
}

type MeLike = { activeCompanyId: string | null; memberships: ReadonlyArray<{ companyId: string; companyName: string; role: string }>; staffAccess?: { companyName: string | null } | null };

/**
 * The company the person is working in and their role in it. An ITS recruiter inside a customer under a grant has no
 * membership: the company's name comes from the grant and there is no role.
 */
export function activeCompanyOf(me: MeLike | null | undefined): { name: string | null; role: string | null; member: boolean } {
  const m = me?.memberships.find((x) => x.companyId === me.activeCompanyId);
  if (m) return { name: m.companyName, role: m.role, member: true };
  return { name: me?.staffAccess?.companyName ?? null, role: null, member: false };
}

/**
 * Whether the rail reads and lists the company's roles: only for a member of the company. An ITS recruiter working under
 * a grant never gets the list, because every request they make is recorded for the customer as a page they opened, and
 * the rail would add one on every page load that the recruiter never chose to open.
 */
export function railListsRoles(me: MeLike | null | undefined): boolean {
  return !!me && !me.staffAccess && activeCompanyOf(me).member;
}

/** Statuses listed under Roles: the ones still being worked on. Filled and closed roles are on the Roles page. */
const LISTED = ["open", "paused", "pending_approval", "draft"];

/**
 * `tag`: a short word shown where no count is, so the dot's colour never carries the status alone (docs/07: a word
 * always goes with it): "Open" for a live role whose count is hidden, else "Paused", "Waiting" or "Draft".
 */
export type RailRole = { id: string; title: string; live: boolean; applicants: number | null; statusWord: string; tag: string | null };

/** The visible word beside a role with no count; kept short for the narrow rail (the full words are read out). */
const RAIL_TAG: Record<string, string> = { open: "Open", paused: "Paused", pending_approval: "Waiting", draft: "Draft" };

/**
 * The roles under Roles: open ones first (a green dot and how many applied), then paused, waiting for approval and
 * drafts (a grey dot and the word for where they stand), newest first within each, at most RAIL_ROLE_LIMIT. An
 * interviewer's list comes from the API already limited to the roles they interview for and without applicant counts
 * (`countsHidden`), so no count is shown and an open role says "Open" instead.
 */
export function railRoles(roles: ReadonlyArray<{ id: string; title: string; status: string; createdAt?: string | null; counts?: { total?: number } | null; countsHidden?: boolean }>, viewer: { role: string | null }, limit = RAIL_ROLE_LIMIT): RailRole[] {
  const interviewer = viewer.role === "interviewer";
  return roles
    .filter((r) => LISTED.includes(r.status))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => LISTED.indexOf(a.r.status) - LISTED.indexOf(b.r.status) || (b.r.createdAt ?? "").localeCompare(a.r.createdAt ?? "") || a.i - b.i)
    .slice(0, limit)
    .map(({ r }) => {
      const live = r.status === "open";
      const applicants = live && !interviewer && !r.countsHidden ? (r.counts?.total ?? 0) : null;
      return { id: r.id, title: r.title, live, applicants, statusWord: railStatusWord(r.status, applicants), tag: applicants === null ? RAIL_TAG[r.status] ?? null : null };
    });
}

/** What a screen reader hears after the role's title, since the dot and the number are only seen. */
function railStatusWord(status: string, applicants: number | null): string {
  if (status === "open") return applicants === null ? "open" : `open, ${applicants} ${applicants === 1 ? "applicant" : "applicants"}`;
  return status === "pending_approval" ? "waiting for approval" : status;
}

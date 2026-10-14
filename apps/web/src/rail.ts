/**
 * The left rail's decisions (apps/shell/components/AppShell.tsx), kept free of React so they can be tested: when the
 * rail folds to icons, whether and which jobs are listed under Jobs, where a job opens, and the words for the signed-in
 * person's role. (On screen a role is a "job"; the code keeps its old names.)
 */

/** How many jobs the rail (and Home) lists under Jobs; "All jobs" leads to the rest. */
export const RAIL_ROLE_LIMIT = 8;

/** Statuses of a job that has taken applicants: it opens on its Candidates. */
const WENT_LIVE = ["open", "paused", "filled"];

/**
 * Where a job opens (the Kanvis way): straight onto its Candidates once it has gone live, its details while it is a
 * draft or waiting for approval. A closed job opens on its Candidates when it was ever open. Someone who cannot see
 * candidates (an interviewer) always gets the job itself.
 */
export function jobHref(role: { id: string; status: string; openedAt?: string | null }, opts: { talent?: boolean } = {}): string {
  const live = WENT_LIVE.includes(role.status) || (role.status === "closed" && !!role.openedAt);
  return live && opts.talent !== false ? `/roles/${role.id}/talent` : `/roles/${role.id}`;
}

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
 * The other companies the person is a member of, for the company menu's switcher (rows 9 and 49): every active
 * membership but the one in use, by name. Empty for someone in one company, and for an ITS recruiter inside a customer
 * under a grant (they enter companies from the queue, never from here).
 */
export function otherCompanies(me: MeLike | null | undefined): Array<{ companyId: string; companyName: string; role: string }> {
  if (!me || me.staffAccess) return [];
  return me.memberships.filter((m) => m.companyId !== me.activeCompanyId).slice().sort((a, b) => a.companyName.localeCompare(b.companyName)).map((m) => ({ companyId: m.companyId, companyName: m.companyName, role: m.role }));
}

/**
 * Whether the rail reads and lists the company's roles: only for a member of the company. An ITS recruiter working under
 * a grant never gets the list, because every request they make is recorded for the customer as a page they opened, and
 * the rail would add one on every page load that the recruiter never chose to open.
 */
export function railListsRoles(me: MeLike | null | undefined): boolean {
  return !!me && !me.staffAccess && activeCompanyOf(me).member;
}

/** Statuses listed under Jobs: the ones still being worked on. Filled and closed jobs are on the Jobs page. */
const LISTED = ["open", "paused", "pending_approval", "draft"];

/**
 * The jobs still being worked on, in the order the rail and Home list them: open first, then paused, waiting for
 * approval and drafts, newest first within each, at most `limit`.
 */
export function rolesInProgress<T extends { status: string; createdAt?: string | null }>(roles: ReadonlyArray<T>, limit = RAIL_ROLE_LIMIT): T[] {
  return roles
    .filter((r) => LISTED.includes(r.status))
    .map((r, i) => ({ r, i }))
    .sort((a, b) => LISTED.indexOf(a.r.status) - LISTED.indexOf(b.r.status) || (b.r.createdAt ?? "").localeCompare(a.r.createdAt ?? "") || a.i - b.i)
    .slice(0, limit)
    .map(({ r }) => r);
}

/**
 * `tag`: a short word shown where no count is, so the dot's colour never carries the status alone (docs/07: a word
 * always goes with it): "Live" for a live job whose count is hidden (the status pills' word), else "Paused", "Waiting" or
 * "Draft". `href`: where
 * the job opens (jobHref).
 */
export type RailRole = { id: string; title: string; href: string; live: boolean; applicants: number | null; statusWord: string; tag: string | null };

/** The visible word beside a job with no count; kept short for the narrow rail (the full words are read out). */
const RAIL_TAG: Record<string, string> = { open: "Live", paused: "Paused", pending_approval: "Waiting", draft: "Draft" };

/**
 * The jobs under Jobs: open ones first (a green dot and how many applied), then paused, waiting for approval and
 * drafts (a grey dot and the word for where they stand), newest first within each, at most RAIL_ROLE_LIMIT. Each opens
 * on its Candidates once it has gone live. An interviewer's list comes from the API already limited to the jobs they
 * interview for and without applicant counts (`countsHidden`), so no count is shown, an open job says "Live" instead,
 * and every job opens on the job itself (an interviewer has no Candidates page).
 */
export function railRoles(roles: ReadonlyArray<{ id: string; title: string; status: string; openedAt?: string | null; createdAt?: string | null; counts?: { total?: number } | null; countsHidden?: boolean }>, viewer: { role: string | null }, limit = RAIL_ROLE_LIMIT): RailRole[] {
  const interviewer = viewer.role === "interviewer";
  return rolesInProgress(roles, limit).map((r) => {
    const live = r.status === "open";
    const applicants = live && !interviewer && !r.countsHidden ? (r.counts?.total ?? 0) : null;
    return { id: r.id, title: r.title, href: jobHref(r, { talent: !interviewer }), live, applicants, statusWord: railStatusWord(r.status, applicants), tag: applicants === null ? RAIL_TAG[r.status] ?? null : null };
  });
}

/** What a screen reader hears after the role's title, since the dot and the number are only seen. */
function railStatusWord(status: string, applicants: number | null): string {
  if (status === "open") return applicants === null ? "live" : `live, ${applicants} ${applicants === 1 ? "applicant" : "applicants"}`;
  return status === "pending_approval" ? "waiting for approval" : status;
}

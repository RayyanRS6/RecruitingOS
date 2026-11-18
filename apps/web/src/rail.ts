import { appPaths, MEMBERSHIP_ROLE_LABEL, type MembershipRole } from "@ros/contracts";

/**
 * The side rail's decisions (apps/shell/components/AppShell.tsx), kept free of React so they can be tested: a company's
 * four places, when the rail folds to icons, the words for the signed-in person's role, the other companies they can
 * switch to, and how the count of unread updates reads.
 */

/** A company's places in the rail, in order. "Start a hire" is the button above them. */
export const COMPANY_LINKS = [
  { to: appPaths.home, label: "Home", icon: "home", end: true },
  { to: appPaths.jobs, label: "Jobs", icon: "roles", end: false },
  { to: appPaths.allCandidates, label: "Candidates", icon: "talent", end: false },
  { to: appPaths.settings, label: "Settings", icon: "settings", end: false },
] as const;

/** The rail folds to a column of icons on a job's own pages (the job, its candidates, the job builder), where the work needs the width. */
export function railCompact(pathname: string | null | undefined): boolean {
  return /^\/roles\/[^/]+/.test(pathname ?? "");
}

/** The person's role in the company chip: Owner, Admin or Member. */
export function teamRoleWord(role: string | null | undefined): string | null {
  return role ? MEMBERSHIP_ROLE_LABEL[role as MembershipRole] ?? null : null;
}

type MeLike = { activeCompanyId: string | null; memberships: ReadonlyArray<{ companyId: string; companyName: string; role: string }> };

/** The company the person is working in and their role in it. */
export function activeCompanyOf(me: MeLike | null | undefined): { name: string | null; role: string | null; member: boolean } {
  const m = me?.memberships.find((x) => x.companyId === me.activeCompanyId);
  if (m) return { name: m.companyName, role: m.role, member: true };
  return { name: null, role: null, member: false };
}

/** The other companies the person is a member of, by name, for the company chip's switcher. Empty for someone in one company. */
export function otherCompanies(me: MeLike | null | undefined): Array<{ companyId: string; companyName: string; role: string }> {
  if (!me) return [];
  return me.memberships.filter((m) => m.companyId !== me.activeCompanyId).slice().sort((a, b) => a.companyName.localeCompare(b.companyName)).map((m) => ({ companyId: m.companyId, companyName: m.companyName, role: m.role }));
}

/**
 * The count beside Updates in the rail: the figure drawn (at most "99+", nothing at zero) and what a screen reader
 * hears with the link's name.
 */
export function unreadBadge(unread: number | null | undefined): { text: string | null; spoken: string } {
  const n = Math.max(0, Math.floor(unread ?? 0));
  if (!n) return { text: null, spoken: "Updates" };
  return { text: n > 99 ? "99+" : String(n), spoken: `Updates, ${n} unread` };
}

/** The page's local storage, or null where reading it throws (blocked site data, some private windows). */
export function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

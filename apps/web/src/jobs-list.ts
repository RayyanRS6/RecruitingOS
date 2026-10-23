import type { Tone } from "@ros/ui";
import type { RoleSummary } from "./api/client";
import { linkedInPostHref } from "./linkedin-post";

/**
 * The Jobs page's choices (Wave S2: the Kanvis dashboard), kept free of React so they can be tested: which jobs a
 * status chip shows, the search by title, the four orders, the small badges on each row, the one line under the title,
 * and what an empty filter says. The page keeps its choice in the address (?status=&sort=&q=), so a link opens it.
 */

export type JobStatusFilter = "all" | "live" | "drafts" | "paused" | "closed";
export type JobSort = "activity" | "newest" | "oldest" | "title";
export type JobsView = { status: JobStatusFilter; sort: JobSort; q: string };

/** A job as the list reads it. `updatedAt` and `lastActivityAt` come with GET /roles (the latter since Wave S2). */
export type JobRow = Pick<RoleSummary, "id" | "title" | "status"> & Partial<Pick<RoleSummary, "openedAt" | "counts" | "stageCounts" | "countsHidden" | "daysOpen">> & { createdAt?: string | null; updatedAt?: string | null; lastActivityAt?: string | null };

export const JOB_FILTERS: ReadonlyArray<{ id: JobStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "live", label: "Live" },
  { id: "drafts", label: "Drafts" },
  { id: "paused", label: "Paused" },
  { id: "closed", label: "Closed" },
];

export const JOB_SORTS: ReadonlyArray<{ id: JobSort; label: string }> = [
  { id: "activity", label: "Recent activity" },
  { id: "newest", label: "Newest first" },
  { id: "oldest", label: "Oldest first" },
  { id: "title", label: "Title A to Z" },
];

export const DEFAULT_JOBS_VIEW: JobsView = { status: "all", sort: "activity", q: "" };

/** Which chip a job's status sits under; a status no chip names shows only under All. */
const STATUS_FILTER: Record<string, Exclude<JobStatusFilter, "all">> = { open: "live", draft: "drafts", pending_approval: "drafts", paused: "paused", filled: "closed", closed: "closed" };
/** Other words a link may use for a chip (the job statuses themselves). */
const STATUS_ALIAS: Record<string, JobStatusFilter> = { open: "live", draft: "drafts", pending_approval: "drafts", filled: "closed" };

export function jobFilterOf(status: string): Exclude<JobStatusFilter, "all"> | null {
  return STATUS_FILTER[status] ?? null;
}

/** The view a link asks for; anything it does not name, or names wrongly, is the default. */
export function jobsViewFrom(search: Pick<URLSearchParams, "get"> | null | undefined): JobsView {
  const rawStatus = search?.get("status") ?? "";
  const status = JOB_FILTERS.some((f) => f.id === rawStatus) ? (rawStatus as JobStatusFilter) : STATUS_ALIAS[rawStatus] ?? DEFAULT_JOBS_VIEW.status;
  const rawSort = search?.get("sort") ?? "";
  const sort = JOB_SORTS.some((s) => s.id === rawSort) ? (rawSort as JobSort) : DEFAULT_JOBS_VIEW.sort;
  return { status, sort, q: (search?.get("q") ?? "").slice(0, 200) };
}

/**
 * The address's query for a view, defaults left out ("" for the default view), keeping any other parameter the
 * address already had (`keep`).
 */
export function jobsSearch(view: JobsView, keep?: URLSearchParams | null): string {
  const next = new URLSearchParams(keep?.toString() ?? "");
  for (const k of ["status", "sort", "q"]) next.delete(k);
  if (view.status !== DEFAULT_JOBS_VIEW.status) next.set("status", view.status);
  if (view.sort !== DEFAULT_JOBS_VIEW.sort) next.set("sort", view.sort);
  if (view.q.trim()) next.set("q", view.q);
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

/** The part of an address the view reads, to tell whether a link changed it. */
export function jobsViewKey(search: Pick<URLSearchParams, "get"> | null | undefined): string {
  return ["status", "sort", "q"].map((k) => search?.get(k) ?? "").join("\u0000");
}

/** Search by title: every word typed is somewhere in the title, in any case. */
export function titleMatches(title: string | null | undefined, q: string): boolean {
  const words = q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const t = (title ?? "").toLocaleLowerCase();
  return words.every((w) => t.includes(w));
}

const time = (x: string | null | undefined): number => {
  const n = x ? Date.parse(x) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};

/** When anything last happened on a job: the API's `lastActivityAt`, else the latest of the job's own dates. */
export function lastActivityTime(r: JobRow): number {
  if (r.lastActivityAt) return time(r.lastActivityAt);
  return Math.max(time(r.updatedAt), time(r.openedAt), time(r.createdAt));
}

/** How many jobs each chip would show, within the search. */
export function jobFilterCounts(roles: ReadonlyArray<JobRow>, q = ""): Record<JobStatusFilter, number> {
  const out: Record<JobStatusFilter, number> = { all: 0, live: 0, drafts: 0, paused: 0, closed: 0 };
  for (const r of roles) {
    if (!titleMatches(r.title, q)) continue;
    out.all += 1;
    const f = jobFilterOf(r.status);
    if (f) out[f] += 1;
  }
  return out;
}

/** The jobs the view shows, in its order; ties keep the newest first, then the API's order. */
export function jobsShown<T extends JobRow>(roles: ReadonlyArray<T>, view: JobsView): T[] {
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
  const order: Record<JobSort, (a: T, b: T) => number> = {
    activity: (a, b) => lastActivityTime(b) - lastActivityTime(a) || time(b.createdAt) - time(a.createdAt),
    newest: (a, b) => time(b.createdAt) - time(a.createdAt),
    oldest: (a, b) => time(a.createdAt) - time(b.createdAt),
    title: (a, b) => byTitle(a, b) || time(b.createdAt) - time(a.createdAt),
  };
  return roles
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (view.status === "all" || jobFilterOf(r.status) === view.status) && titleMatches(r.title, view.q))
    .sort((a, b) => order[view.sort](a.r, b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** Whole days since a time, never below 0; null when it is not known. */
export function daysSince(at: string | null | undefined, now: number = Date.now()): number | null {
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** A small badge on a row: `label` is what is seen, `spoken` the full words a screen reader hears when they differ. */
export type JobBadge = { key: string; label: string; spoken?: string; tone: Tone };

/**
 * The badges on a row, Kanvis-like: a draft says how old it is ("Draft · 3d old"); a job waiting for approval is
 * "Not live"; a job that has taken applicants says how many wait for review and how many are new, or "No applicants
 * yet" while it is live or paused and nobody has applied. An interviewer's list has no counts, so no count badges.
 */
export function jobBadges(r: JobRow, now: number = Date.now()): JobBadge[] {
  if (r.status === "draft") {
    const d = daysSince(r.createdAt, now);
    if (d === null) return [{ key: "draft", label: "Draft", tone: "neutral" }];
    return [{ key: "draft", label: d === 0 ? "Draft · today" : `Draft · ${d}d old`, spoken: d === 0 ? "Draft, started today" : `Draft, ${d} day${d === 1 ? "" : "s"} old`, tone: "neutral" }];
  }
  if (r.status === "pending_approval") return [{ key: "not-live", label: "Not live", tone: "neutral" }];
  if (r.countsHidden || !r.counts) return [];
  const out: JobBadge[] = [];
  const total = r.counts.total ?? 0;
  const review = r.counts.waiting_on_you ?? 0;
  const fresh = r.stageCounts?.new ?? 0;
  if (!total && (r.status === "open" || r.status === "paused")) out.push({ key: "none", label: "No applicants yet", tone: "neutral" });
  if (review) out.push({ key: "review", label: `${review} to review`, tone: "caution" });
  if (fresh) out.push({ key: "new", label: `${fresh} new`, tone: "accent" });
  return out;
}

/**
 * The one line under a job's title: how many applied and how long it has been open. The counts that call for action
 * ("to review", "new") are the badges, so they are not repeated here.
 */
export function jobRowLine(r: JobRow): string {
  const daysOpen = r.daysOpen ?? null;
  // A job waiting for approval says so here: its badge says only "Not live", and no status pill repeats it.
  const open = daysOpen === null ? (r.status === "pending_approval" ? "Waiting for approval" : "Not posted yet") : `${daysOpen} day${daysOpen === 1 ? "" : "s"} open`;
  if (r.countsHidden || !r.counts) return open;
  const total = r.counts.total ?? 0;
  if (!total && daysOpen === null) return open;
  return `${total} applicant${total === 1 ? "" : "s"} · ${open}`;
}

/** Where "Post on LinkedIn" leads: the Share tab's LinkedIn card (the same address as linkedInPostHref). Only a live job is offered it. */
export function linkedInHref(roleId: string): string {
  return linkedInPostHref(roleId);
}
export const offersLinkedIn = (status: string): boolean => status === "open";

/** The pill for a job's approval requests still waiting: named for what they are, so it never reads as a second "to review". */
export function approvalsWaitingLabel(n: number): string {
  return `${n} approval${n === 1 ? "" : "s"} waiting`;
}

/**
 * What an empty filter says: its title alone (founder, 23 Oct 2026: fewer words), with its one action: "start" (Start a
 * hire, for those who may), "all" (show every job) or "clear" (clear the search). Used when there are jobs, but none in
 * this view; "No jobs yet" stays for none at all.
 */
export function jobsEmpty(view: JobsView, opts: { mayStartHire: boolean }): { title: string; action: "start" | "all" | "clear" } {
  if (view.q.trim()) return { title: "No jobs match your search", action: "clear" };
  switch (view.status) {
    case "live":
      return { title: "No live jobs", action: opts.mayStartHire ? "start" : "all" };
    case "drafts":
      return { title: "No drafts", action: opts.mayStartHire ? "start" : "all" };
    case "paused":
      return { title: "No paused jobs", action: "all" };
    case "closed":
      return { title: "No closed jobs", action: "all" };
    default:
      return { title: "No jobs here", action: "all" };
  }
}

import { describe, expect, it } from "vitest";
import { DEFAULT_JOBS_VIEW, JOB_FILTERS, approvalsWaitingLabel, JOB_SORTS, daysSince, jobBadges, jobFilterCounts, jobFilterOf, jobRowLine, jobsEmpty, jobsSearch, jobsShown, jobsViewFrom, jobsViewKey, lastActivityTime, linkedInHref, offersLinkedIn, titleMatches, type JobRow } from "../../apps/web/src/jobs-list";

/** The Jobs page's choices (Wave S2: the Kanvis dashboard): chips, search, orders, badges, the row line, empty filters. */
const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const job = (over: Partial<JobRow> & { id: string; title: string; status: string }): JobRow => ({ openedAt: null, createdAt: ago(1), counts: { total: 0 }, daysOpen: null, ...over });

const roles: JobRow[] = [
  job({ id: "a", title: "Dental Hygienist", status: "open", createdAt: ago(10), openedAt: ago(8), lastActivityAt: ago(1), counts: { total: 4, waiting_on_you: 2 }, stageCounts: { new: 3 } as JobRow["stageCounts"], daysOpen: 8 }),
  job({ id: "b", title: "office manager", status: "pending_approval", createdAt: ago(2), lastActivityAt: ago(2) }),
  job({ id: "c", title: "Assistant", status: "draft", createdAt: ago(5), lastActivityAt: ago(5) }),
  job({ id: "d", title: "Front Desk", status: "paused", createdAt: ago(20), lastActivityAt: ago(0.5), counts: { total: 0 }, daysOpen: 15 }),
  job({ id: "e", title: "Dentist", status: "filled", createdAt: ago(40), lastActivityAt: ago(30), counts: { total: 9 }, daysOpen: 30 }),
  job({ id: "f", title: "Billing", status: "closed", createdAt: ago(50), counts: { total: 1 }, daysOpen: 2 }),
];

describe("the jobs list", () => {
  it("names the five chips and the four orders", () => {
    expect(JOB_FILTERS.map((f) => f.label)).toEqual(["All", "Live", "Drafts", "Paused", "Closed"]);
    expect(JOB_SORTS.map((s) => s.label)).toEqual(["Recent activity", "Newest first", "Oldest first", "Title A to Z"]);
    expect(["open", "draft", "pending_approval", "paused", "filled", "closed", "weird"].map(jobFilterOf)).toEqual(["live", "drafts", "drafts", "paused", "closed", "closed", null]);
  });

  it("reads the view from the address, and writes it back with the defaults left out", () => {
    expect(jobsViewFrom(new URLSearchParams(""))).toEqual(DEFAULT_JOBS_VIEW);
    expect(jobsViewFrom(new URLSearchParams("status=live&sort=title&q=dent"))).toEqual({ status: "live", sort: "title", q: "dent" });
    // the job statuses themselves work as chip names; nonsense is the default
    expect(jobsViewFrom(new URLSearchParams("status=open")).status).toBe("live");
    expect(jobsViewFrom(new URLSearchParams("status=filled")).status).toBe("closed");
    expect(jobsViewFrom(new URLSearchParams("status=zzz&sort=zzz"))).toEqual(DEFAULT_JOBS_VIEW);
    expect(jobsViewFrom(null)).toEqual(DEFAULT_JOBS_VIEW);
    expect(jobsSearch(DEFAULT_JOBS_VIEW)).toBe("");
    expect(jobsSearch({ status: "paused", sort: "oldest", q: "front desk" })).toBe("?status=paused&sort=oldest&q=front+desk");
    expect(jobsSearch({ ...DEFAULT_JOBS_VIEW, q: "   " })).toBe("");
    // other parameters in the address are kept
    expect(jobsSearch({ ...DEFAULT_JOBS_VIEW, status: "live" }, new URLSearchParams("from=home&status=drafts"))).toBe("?from=home&status=live");
    expect(jobsViewKey(new URLSearchParams("status=live"))).not.toBe(jobsViewKey(new URLSearchParams("")));
    expect(jobsViewKey(new URLSearchParams("from=home"))).toBe(jobsViewKey(new URLSearchParams("")));
  });

  it("searches by title, every word in any case", () => {
    expect(titleMatches("Dental Hygienist", "")).toBe(true);
    expect(titleMatches("Dental Hygienist", "hyg dent")).toBe(true);
    expect(titleMatches("Dental Hygienist", "nurse")).toBe(false);
    expect(titleMatches(null, "x")).toBe(false);
  });

  it("counts each chip within the search", () => {
    expect(jobFilterCounts(roles)).toEqual({ all: 6, live: 1, drafts: 2, paused: 1, closed: 2 });
    expect(jobFilterCounts(roles, "dent")).toEqual({ all: 2, live: 1, drafts: 0, paused: 0, closed: 1 });
  });

  it("filters and sorts", () => {
    const ids = (view: Partial<typeof DEFAULT_JOBS_VIEW>) => jobsShown(roles, { ...DEFAULT_JOBS_VIEW, ...view }).map((r) => r.id);
    // recent activity: the API's lastActivityAt, else the job's own latest date
    expect(ids({})).toEqual(["d", "a", "b", "c", "e", "f"]);
    expect(ids({ sort: "newest" })).toEqual(["b", "c", "a", "d", "e", "f"]);
    expect(ids({ sort: "oldest" })).toEqual(["f", "e", "d", "a", "c", "b"]);
    expect(ids({ sort: "title" })).toEqual(["c", "f", "a", "e", "d", "b"]);
    expect(ids({ status: "drafts" })).toEqual(["b", "c"]);
    expect(ids({ status: "closed", sort: "title" })).toEqual(["f", "e"]);
    expect(ids({ q: "DENT", sort: "title" })).toEqual(["a", "e"]);
    expect(lastActivityTime(job({ id: "x", title: "x", status: "open", createdAt: ago(9), updatedAt: ago(3), openedAt: ago(4) }))).toBe(NOW - 3 * 86_400_000);
  });

  it("puts small badges on a row: to review, new, a draft's age, not live, no applicants yet", () => {
    expect(jobBadges(roles[0], NOW).map((b) => b.label)).toEqual(["2 to review", "3 new"]);
    expect(jobBadges(roles[1], NOW).map((b) => b.label)).toEqual(["Not live"]);
    expect(jobBadges(roles[2], NOW)).toEqual([{ key: "draft", label: "Draft · 5d old", spoken: "Draft, 5 days old", tone: "neutral" }]);
    expect(jobBadges(job({ id: "x", title: "x", status: "draft", createdAt: ago(0.2) }), NOW)[0]).toMatchObject({ label: "Draft · today", spoken: "Draft, started today" });
    expect(jobBadges(job({ id: "x", title: "x", status: "draft", createdAt: null }), NOW)[0]).toMatchObject({ label: "Draft" });
    expect(jobBadges(roles[3], NOW).map((b) => b.label)).toEqual(["No applicants yet"]);
    expect(jobBadges(job({ id: "x", title: "x", status: "open", counts: { total: 0 }, daysOpen: 0 }), NOW).map((b) => b.label)).toEqual(["No applicants yet"]);
    // a closed job with nobody waiting has no badge; an interviewer's list has no counts
    expect(jobBadges(roles[4], NOW)).toEqual([]);
    expect(jobBadges({ ...roles[0], countsHidden: true }, NOW)).toEqual([]);
    expect(daysSince(ago(3), NOW)).toBe(3);
    expect(daysSince(new Date(NOW + 86_400_000).toISOString(), NOW)).toBe(0);
    expect(daysSince(null, NOW)).toBeNull();
  });

  it("gives each row one line: how many applied and how long it has been open", () => {
    expect(jobRowLine(roles[0])).toBe("4 applicants · 8 days open");
    expect(jobRowLine(job({ id: "x", title: "x", status: "open", counts: { total: 1 }, daysOpen: 1 }))).toBe("1 applicant · 1 day open");
    expect(jobRowLine(roles[1])).toBe("Waiting for approval");
    expect(jobRowLine(job({ id: "d", title: "d", status: "draft", counts: { total: 0 }, daysOpen: null }))).toBe("Not posted yet");
    expect(jobRowLine({ ...roles[0], countsHidden: true })).toBe("8 days open");
  });

  it("offers Post to LinkedIn on a live job only, to the Share tab's LinkedIn card", () => {
    expect(linkedInHref("r1")).toBe("/roles/r1?tab=share#linkedin");
    // the same address as the Share tab's own helper, the id made safe for an address
    expect(linkedInHref("a b")).toBe("/roles/a%20b?tab=share#linkedin");
    expect(approvalsWaitingLabel(1)).toBe("1 approval waiting");
    expect(approvalsWaitingLabel(2)).toBe("2 approvals waiting");
    expect(["open", "paused", "draft", "pending_approval", "filled", "closed"].filter(offersLinkedIn)).toEqual(["open"]);
  });

  it("says what an empty filter means, with one action", () => {
    expect(jobsEmpty({ ...DEFAULT_JOBS_VIEW, status: "live" }, { mayStartHire: true })).toMatchObject({ title: "No live jobs", action: "start" });
    expect(jobsEmpty({ ...DEFAULT_JOBS_VIEW, status: "live" }, { mayStartHire: false }).action).toBe("all");
    expect(jobsEmpty({ ...DEFAULT_JOBS_VIEW, status: "drafts" }, { mayStartHire: true })).toMatchObject({ title: "No drafts", action: "start" });
    expect(jobsEmpty({ ...DEFAULT_JOBS_VIEW, status: "paused" }, { mayStartHire: true })).toMatchObject({ title: "No paused jobs", action: "all" });
    expect(jobsEmpty({ ...DEFAULT_JOBS_VIEW, status: "closed" }, { mayStartHire: true })).toMatchObject({ title: "No closed jobs", action: "all" });
    expect(jobsEmpty({ ...DEFAULT_JOBS_VIEW, q: " nurse " }, { mayStartHire: true })).toEqual({ title: "No jobs match your search", action: "clear" });
    // the title alone, with its one action (founder, 23 Oct 2026: fewer words): no line under it
    for (const f of JOB_FILTERS) {
      const e = jobsEmpty({ ...DEFAULT_JOBS_VIEW, status: f.id }, { mayStartHire: true });
      expect(Object.keys(e).sort()).toEqual(["action", "title"]);
    }
  });
});

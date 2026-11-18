import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { AdminCompany, AdminCompanyJobs } from "@ros/contracts";

/**
 * The admin dashboard's Companies page (apps/web/src/pages/admin/companies.tsx and company.tsx) as the server first
 * draws it from answers shaped like the API's: the requests waiting for approval with Accept and Decline, the companies
 * that asked to upgrade, the table with its search box and three filters, and one company's drawer kept in the address
 * (`?open=<id>`) with its details, the decisions the API says it takes, its plan in dollars and its jobs as counts.
 * Nothing on the page ever names a candidate.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
// `replace` is the router's own (a link that opens the drawer leaves no extra step in the history), not an attribute
vi.mock("next/link", () => ({ default: ({ replace: _replace, ...props }: { href: string; replace?: boolean; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Dashboard, viewSearch } = await import("@ros/web/src/pages/admin/Dashboard");
const { AccessChoice } = await import("@ros/web/src/pages/admin/access");
const facts = await import("@ros/web/src/pages/admin/company-facts");
const { ApiError } = await import("@ros/web/src/api/client");

const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
/** The markup from one place on, so a name said earlier on the page does not count. */
const from = (html: string, start: string | RegExp) => {
  const at = typeof start === "string" ? html.indexOf(start) : html.search(start);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
};
/** One card of the page, by its title, up to the end of its section. */
const card = (html: string, title: string) => {
  const rest = from(html, `<h2>${title}</h2>`);
  return rest.slice(0, rest.indexOf("</section>"));
};

const admin = { user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, auth: { provider: "azure", aal: "aal2", mfaVerifiedAt: daysAgo(0) }, memberships: [], activeCompanyId: null, ai: { provider: "fake" } };
function client(data: Array<[readonly unknown[], unknown]> = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], admin);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
/** The Companies page at the address `search`. */
const page = (rows: AdminCompany[] | null, search = "", more: Array<[readonly unknown[], unknown]> = []) => {
  nav.search = search;
  return render(client([...(rows ? [[["admin", "companies"], rows] as [readonly unknown[], unknown]] : []), ...more]), createElement(Dashboard, { section: "companies" }));
};

const person = { name: "Sam Asker", email: "sam@stranger.test" };
const company = (id: string, name: string, over: Partial<AdminCompany> = {}): AdminCompany => ({
  id, name, slug: id, vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", locations: [{ city: "Austin", region: "TX", country: "US" }], website: null, createdAt: daysAgo(30),
  status: "active", statusLabel: "Active", accessRequest: null, owner: { name: "Dana Whitfield", email: "dana@bright.test" }, accessDecisions: ["remove"],
  planKey: "free", planName: "Free", jobs: { open: 1, total: 2 }, applicants: 6, lockedApplicants: 0, lastActivityAt: daysAgo(1),
  usage: [{ key: "jobs_total", label: "Jobs", used: 1, limit: 1, unit: "count", resetsAt: null, words: "1 of 1 jobs" }, { key: "seats", label: "People", used: 2, limit: 2, unit: "count", resetsAt: null, words: "2 of 2 people" }],
  seats: { used: 2, limit: 2 }, aiCredit: null, aiCostUsd: 0.04, trial: null, trialTerm: null, planRequest: null, careersUrl: `https://jobs.example/careers/${id}`, ...over,
});
const asking = (id: string, name: string, over: Partial<AdminCompany> = {}) => company(id, name, { status: "waiting", statusLabel: "Waiting", accessRequest: { status: "requested", person, declined: null }, owner: null, accessDecisions: ["accept", "decline"], createdAt: daysAgo(2), jobs: { open: 0, total: 0 }, applicants: 0, lastActivityAt: null, careersUrl: null, ...over });
// 3:10 PM on 5 November on the reader's own clock, which is how the dashboard shows a time, wherever the test runs
const refused = (id: string, name: string, over: Partial<AdminCompany> = {}) => asking(id, name, { status: "declined", statusLabel: "Declined", accessRequest: { status: "declined", person, declined: { at: new Date(2026, 10, 5, 15, 10).toISOString(), by: "Ada Admin" } }, accessDecisions: ["accept"], createdAt: daysAgo(9), ...over });
const all = () => [
  asking("co8", "Harbor Dental"),
  company("co1", "Bright Dental", { planRequest: { since: daysAgo(1), planKey: "basic", planName: "Basic", words: "We would like to move to the Basic plan.", requestedBy: "dana@bright.test" } }),
  company("co3", "Avon Dental", { planKey: "pro", planName: "Pro", jobs: { open: 0, total: 0 }, applicants: 0, lastActivityAt: null }),
  refused("co9", "Gone Dental"),
];

describe("Companies: the requests waiting for approval", () => {
  it("lists each request with who is asking, where, how long it has waited, and Accept and Decline", () => {
    const html = page(all());
    expect(html).toContain("<h1>Companies</h1>");
    const waiting = card(html, "Waiting for approval");
    const words = text(waiting);
    // the address their sign-in proved first, then the name they typed
    expect(words).toContain("Harbor Dental sam@stranger.test · Sam Asker · Austin, TX · Waiting 2 days");
    expect(waiting).toContain('<button type="button" class="btn primary sm" aria-label="Accept Harbor Dental">Accept</button>');
    expect(waiting).toContain('<button type="button" class="btn quiet sm" aria-label="Decline Harbor Dental">Decline</button>');
    // only the companies that wait: an accepted or a declined one has no row here
    for (const other of ["Bright Dental", "Avon Dental", "Gone Dental"]) expect(waiting, other).not.toContain(other);
    expect(words).not.toContain("No company is waiting.");
  });

  it("says so in one row when nobody waits, and keeps the card", () => {
    const html = page([company("co1", "Bright Dental")]);
    expect(text(card(html, "Waiting for approval"))).toContain("No company is waiting.");
    expect(card(html, "Waiting for approval")).not.toContain("Accept</button>");
  });

  it("the second press swaps the buttons for the question, Yes and No, each saying which company", () => {
    const draw = (decisions: AdminCompany["accessDecisions"], asked: "accept" | "decline" | "remove" | null, pending = false) => renderToStaticMarkup(createElement(AccessChoice, { company: { name: "Harbor Dental", accessDecisions: decisions }, asking: asked, pending, onPress: () => undefined, onYes: () => undefined, onNo: () => undefined }));
    const accept = draw(["accept", "decline"], "accept");
    expect(text(accept).trim()).toBe("Accept Harbor Dental? Yes No");
    expect(accept).toContain('<button type="button" class="btn primary sm" aria-label="Yes, accept Harbor Dental" aria-busy="false">Yes</button>');
    expect(accept).toContain('<button type="button" class="btn quiet sm" aria-label="No, do not accept Harbor Dental">No</button>');
    expect(accept).not.toContain(">Decline<");
    expect(text(draw(["accept", "decline"], "decline")).trim()).toBe("Decline Harbor Dental? Yes No");
    // taking access away is the one that cannot be shrugged off: its Yes is the destructive button
    const remove = draw(["remove"], "remove");
    expect(text(remove).trim()).toBe("Take away access from Harbor Dental? Yes No");
    expect(remove).toContain('<button type="button" class="btn destructive sm" aria-label="Yes, take away access from Harbor Dental" aria-busy="false">Yes</button>');
    expect(remove).toContain('aria-label="No, keep access for Harbor Dental"');
    // on its way: one press only, and the question stays until the answer
    const going = draw(["accept", "decline"], "accept", true);
    expect(going).toContain('aria-busy="true"');
    expect(going).toMatch(/<button type="button" class="btn quiet sm" disabled=""[^>]*>No<\/button>/);
    // no question yet: a button for each decision the API lists, and none it does not
    expect(text(draw(["accept", "decline"], null)).trim()).toBe("Accept Decline");
    expect(text(draw(["accept"], null)).trim()).toBe("Accept");
    expect(text(draw(["remove"], null)).trim()).toBe("Take away access");
    expect(draw(["remove"], null)).toContain('<button type="button" class="btn quiet sm" aria-label="Take away access from Harbor Dental">Take away access</button>');
    expect(draw([], null)).toBe("");
    // a very long name cannot push the row sideways
    expect(renderToStaticMarkup(createElement(AccessChoice, { company: { name: "L".repeat(120), accessDecisions: ["accept"] }, asking: "accept", pending: false, onPress: () => undefined, onYes: () => undefined, onNo: () => undefined }))).toMatch(/<span class="min-w-0 text-sm font-semibold text-ink wrap-anywhere">Accept L{120}\?<\/span>/);
  });
});

describe("Companies: asked to upgrade", () => {
  it("lists the companies with an open request about their plan, in their own words, each a link to the company", () => {
    const html = page(all());
    const asked = card(html, "Asked to upgrade");
    expect(text(asked)).toContain("Bright Dental We would like to move to the Basic plan. yesterday");
    expect(asked).toContain('<a href="/admin?open=co1" class="btn secondary sm" aria-label="Open Bright Dental">Open</a>');
    expect(asked).not.toContain("Avon Dental");
  });

  it("is not drawn when nobody asked", () => {
    expect(page([company("co1", "Bright Dental")])).not.toContain("Asked to upgrade");
  });
});

describe("Companies: the table", () => {
  it("has six columns in the API's order: name and kind of business, status, plan, jobs open of all, applicants, last active", () => {
    const html = page(all());
    const table = from(html, '<section class="table-wrap" tabindex="0" aria-label="Companies">');
    expect([...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1])).toEqual(["Company", "Status", "Plan", "Jobs", "Applicants", "Last active"]);
    expect(table).toContain('<th scope="col" class="num">Applicants</th>');
    // nothing sorts here: the list keeps the order the API gives it
    expect(table).not.toContain("th-sort");
    const order = ["Harbor Dental", "Bright Dental", "Avon Dental", "Gone Dental"].map((name) => table.indexOf(`>${name}</button>`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const words = text(table);
    // the kind of business in the sign-up form's own words, the status word with its dot, the plan by name
    expect(words).toContain("Bright Dental Dental practice or group Active Free 1 of 2 open 6 yesterday");
    expect(words).toContain("Avon Dental Dental practice or group Active Pro None 0 Never");
    expect(words).toContain("Harbor Dental Dental practice or group Waiting Free None 0 Never");
    expect(table).toContain('<span class="pill good sm"><span class="dot" aria-hidden="true"></span>Active</span>');
    expect(table).toContain('<span class="pill caution sm"><span class="dot" aria-hidden="true"></span>Waiting</span>');
    expect(table).toContain('<span class="pill neutral sm"><span class="dot" aria-hidden="true"></span>Declined</span>');
  });

  it("offers a search box and the filters All, Waiting and Declined with their counts; a filter in the address narrows the list", () => {
    const html = page(all());
    expect(html).toContain('<input class="input rounded-full pl-10" type="search" placeholder="Search companies" aria-label="Search companies" value=""/>');
    expect(html).toContain('<button type="button" class="toggle-chip" aria-pressed="true">All <span class="count">4</span></button>');
    expect(html).toContain('aria-pressed="false">Waiting <span class="count">1</span></button>');
    expect(html).toContain('aria-pressed="false">Declined <span class="count">1</span></button>');
    expect(facts.COMPANY_FILTERS.map((f) => f.label)).toEqual(["All", "Waiting", "Declined"]);

    const waiting = from(page(all(), "show=waiting"), '<section class="table-wrap"');
    expect(waiting).toContain("Harbor Dental");
    for (const other of ["Bright Dental", "Avon Dental", "Gone Dental"]) expect(waiting, other).not.toContain(other);
    const declined = from(page(all(), "show=declined"), '<section class="table-wrap"');
    expect(declined).toContain("Gone Dental");
    expect(declined).not.toContain("Harbor Dental");
    // nothing under a filter says so, with one way back
    expect(text(page([company("co1", "Bright Dental")], "show=declined"))).toContain("No company matches. Show all companies");
  });

  it("filters and searches the list already loaded", () => {
    const [harbor, bright, , gone] = all();
    expect(facts.companyInFilter(harbor, "all")).toBe(true);
    expect(facts.companyInFilter(harbor, "waiting")).toBe(true);
    expect(facts.companyInFilter(harbor, "declined")).toBe(false);
    expect(facts.companyInFilter(gone, "declined")).toBe(true);
    expect(facts.companyInFilter(bright, "waiting")).toBe(false);
    expect(facts.companyFilterFrom("declined")).toBe("declined");
    expect(facts.companyFilterFrom("low")).toBe("all");
    expect(facts.companyFilterFrom(null)).toBe("all");
    // its name, its kind of business in words, its website, and who asked or owns it
    expect(facts.companyMatches(bright, " BRIGHT ")).toBe(true);
    expect(facts.companyMatches(bright, "dental practice")).toBe(true);
    expect(facts.companyMatches(bright, "dana@bright")).toBe(true);
    expect(facts.companyMatches(harbor, "sam asker")).toBe(true);
    expect(facts.companyMatches(bright, "sam@stranger")).toBe(false);
    expect(facts.companyMatches(company("co1", "Bright Dental", { website: "https://bright.example" }), "bright.example")).toBe(true);
    expect(facts.companyMatches(bright, "")).toBe(true);
  });

  it("keeps the headings and says so in a row when there are no companies, and shows quiet rows while they load", () => {
    const none = page([]);
    expect(none).toMatch(/<td colspan="6" class="table-empty">No companies yet\.<\/td>/i);
    const loading = page(null);
    expect(loading).toContain('<tbody aria-busy="true">');
    expect(loading).toContain('<span class="sr-only" role="status">Loading…</span>');
  });

  it("a tab left open stays true: the list is asked again on focus and every minute while visible, never in a hidden tab", () => {
    nav.search = "";
    const qc = client([[["admin", "companies"], all()]]);
    render(qc, createElement(Dashboard, { section: "companies" }));
    expect(qc.getQueryCache().find({ queryKey: ["admin", "companies"], exact: true })?.options).toMatchObject({ refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false });
  });

  it("reads and writes its place in the address, everything else in it kept", () => {
    expect(facts.companiesSearch(new URLSearchParams("show=waiting"), { open: "co1" })).toBe("?show=waiting&open=co1");
    expect(facts.companiesSearch(new URLSearchParams("show=waiting&open=co1"), { open: null })).toBe("?show=waiting");
    expect(facts.companiesSearch(new URLSearchParams("show=waiting"), { show: "all" })).toBe("");
    expect(facts.companiesSearch(new URLSearchParams("open=co1"), { show: "declined" })).toBe("?open=co1&show=declined");
    // choosing another part of a section drops a drawer's ?open=
    expect(viewSearch("?open=d1&view=open", "closed")).toBe("?view=closed");
  });
});

describe("one company's drawer", () => {
  const jobs = (list: AdminCompanyJobs["jobs"]): [readonly unknown[], unknown] => [["admin", "companies", "co1", "jobs"], { company: { id: "co1", name: "Bright Dental" }, jobs: list } satisfies AdminCompanyJobs];
  const twoJobs = jobs([
    { id: "r1", title: "Front Desk Lead", status: "open", statusLabel: "Open", publishedAt: new Date(2026, 10, 3, 9, 0).toISOString(), applicants: 12, shortlisted: 3, interviewed: 2, hired: 1, jobPageUrl: "https://jobs.example/careers/co1/jobs/r1" },
    { id: "r2", title: "Dental Assistant", status: "draft", statusLabel: "Draft", publishedAt: null, applicants: 0, shortlisted: 0, interviewed: 0, hired: 0, jobPageUrl: null },
  ]);

  it("opens from the address, named by the company, with its status, the decision it takes now and its details", () => {
    const html = page(all(), "open=co1", [twoJobs]);
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Bright Dental"');
    const drawer = from(html, 'role="dialog"');
    expect(drawer).toContain('<span class="pill good"><span class="dot" aria-hidden="true"></span>Active</span>');
    // an accepted company: Take away access, and nothing else
    expect(drawer).toContain('aria-label="Take away access from Bright Dental">Take away access</button>');
    expect(drawer).not.toContain("Accept</button>");
    expect(drawer).not.toContain("Decline</button>");
    const words = text(drawer);
    expect(words).toContain("Owner dana@bright.test · Dana Whitfield");
    expect(words).toContain("Business Dental practice or group · 20-49 employees");
    expect(words).toContain("Where Austin, TX");
    expect(words).toContain("Website None given");
    expect(words).toContain("Careers page https://jobs.example/careers/co1 (opens in a new tab)");
    expect(words).toContain("Last active yesterday");
    expect(drawer).toContain('<dl class="glance mt-4">');
    // what taking access away does is one click away, not a paragraph in view
    expect(drawer).toMatch(/<details class="more mt-3"><summary>How this works<\/summary><p[^>]*>Its people can no longer work in it, its careers page and job pages go offline and nothing more is emailed to its candidates\. Nothing is deleted\. Accept brings everyone back\.<\/p>/);
    // the one gate: nothing about a second check, held messages or an invitation
    for (const gone of ["ITS check", "Confirm the company", "held", "invitation", "How people apply", "match score"]) expect(words, gone).not.toContain(gone);
  });

  it("shows the plan as the company reads it, the same AI help in dollars, and Change plan", () => {
    const row = company("co1", "Bright Dental", { lockedApplicants: 3, aiCredit: { monthly: false, spentUsd: 9.5, limitUsd: 10, percent: 95, level: "warning", resetsAt: null }, aiCostUsd: 9.5, planRequest: { since: daysAgo(1), planKey: "basic", planName: "Basic", words: "We would like to move to the Basic plan.", requestedBy: "dana@bright.test" } });
    const plan = card(from(page([row], "open=co1", [twoJobs]), 'role="dialog"'), "Plan");
    const words = text(plan);
    expect(words).toContain("Free 1 of 1 jobs 2 of 2 people 3 applicants locked $9.50 of $10 AI credit $9.50 AI cost in all 80% of AI credit used");
    expect(plan).toContain('<span title="$9.5000">$9.50</span> AI cost in all');
    expect(words).toContain("Asked to upgrade We would like to move to the Basic plan. yesterday · dana@bright.test");
    // the people are said once: the usage lines already carry them
    expect(words.match(/of 2 people/g)).toHaveLength(1);
    expect(plan).toContain('<button type="button" class="btn secondary sm">Change plan</button>');
    // the form is one press away
    expect(plan).not.toContain('id="plan-pick"');
    expect(facts.planUsage({ usage: [], seats: { used: 2, limit: 3 }, lockedApplicants: 1 })).toEqual(["2 of 3 people", "1 applicant locked"]);
    expect(facts.seatsWords({ used: 5, limit: null })).toBe("5 people");
  });

  it("lists the jobs as counts, with the job page only for a job that has one, and never a candidate", () => {
    const html = from(page(all(), "open=co1", [twoJobs]), 'role="dialog"');
    const table = from(html, '<section class="table-wrap wrap-heads" tabindex="0" aria-label="Jobs of Bright Dental">');
    expect([...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => m[1])).toEqual(["Job", "Applicants", "Shortlisted", "Interviewed", "Hired"]);
    const words = text(table);
    expect(words).toContain("Front Desk Lead Open Published Nov 3 View job page : Front Desk Lead (opens in a new tab) 12 3 2 1");
    expect(words).toContain("Dental Assistant Draft 0 0 0 0");
    expect(table).toContain('<a class="small" href="https://jobs.example/careers/co1/jobs/r1" target="_blank" rel="noopener noreferrer">View job page');
    // one link, for the job with a public page; a draft has none
    expect(table.match(/View job page/g)).toHaveLength(1);
    // counts only: the answer holds no person, and nothing drawn links into a company's candidates
    for (const never of ["/talent", "/applications", "@", "resume", "score"]) expect(table.slice(0, table.indexOf("</section>")), never).not.toContain(never);
    expect(Object.keys((twoJobs[1] as AdminCompanyJobs).jobs[0]).sort()).toEqual(["applicants", "hired", "id", "interviewed", "jobPageUrl", "publishedAt", "shortlisted", "status", "statusLabel", "title"]);
  });

  it("asks for the jobs only when the company has one", () => {
    nav.search = "open=co3";
    const qc = client([[["admin", "companies"], all()]]);
    const html = render(qc, createElement(Dashboard, { section: "companies" }));
    expect(text(card(from(html, 'role="dialog"'), "Jobs"))).toContain("No jobs yet.");
    expect((qc.getQueryCache().find({ queryKey: ["admin", "companies", "co3", "jobs"], exact: true })?.options as { enabled?: boolean } | undefined)?.enabled).toBe(false);
    nav.search = "open=co1";
    const withJobs = client([[["admin", "companies"], all()]]);
    render(withJobs, createElement(Dashboard, { section: "companies" }));
    expect((withJobs.getQueryCache().find({ queryKey: ["admin", "companies", "co1", "jobs"], exact: true })?.options as { enabled?: boolean } | undefined)?.enabled).toBe(true);
  });

  it("a request: who asked, how long it has waited, Accept and Decline, and no way to change a plan the API would refuse", () => {
    const html = from(page(all(), "open=co8"), 'role="dialog"');
    const words = text(html);
    expect(html).toContain('<span class="pill caution"><span class="dot" aria-hidden="true"></span>Waiting</span>');
    expect(words).toContain("Waiting 2 days");
    expect(words).toContain("Asked by sam@stranger.test · Sam Asker");
    expect(html).toContain('aria-label="Accept Harbor Dental">Accept</button>');
    expect(html).toContain('aria-label="Decline Harbor Dental">Decline</button>');
    expect(html).not.toContain("Take away access");
    expect(words).toContain("Accept lets them in on the Free plan: they can start hiring at once, and their careers page and job pages are public. Decline keeps them out, and you can still accept later.");
    expect(html).not.toContain(">Change plan<");
    expect(words).not.toContain("Careers page");
    expect(words).toContain("No jobs yet.");
  });

  it("a declined company: when and by whom, and Accept alone, which is the undo; one whose access was taken away comes back on its own plan", () => {
    const html = from(page(all(), "open=co9"), 'role="dialog"');
    const words = text(html);
    expect(words).toMatch(/Declined Nov 5, 2026, [^·]* by Ada Admin/);
    expect(html).toContain('aria-label="Accept Gone Dental">Accept</button>');
    expect(html).not.toContain('aria-label="Decline Gone Dental"');
    expect(words).not.toContain("Waiting 9 days");
    expect(words).not.toContain("Decline keeps them out");
    const removed = refused("co9", "Gone Dental", { planKey: "pro", planName: "Pro", accessRequest: { status: "declined", removed: true, person, declined: { at: daysAgo(1), by: "Ada Admin" } } });
    expect(text(from(page([removed], "open=co9"), 'role="dialog"'))).toContain("Accept brings back everyone who lost access, on the same plan, and puts its careers page and job pages back.");
  });

  it("a company on the Trial plan whose days have started gets the trial card, with each extension and its reason", () => {
    const trial = { started: true, startedAt: "2026-09-01T19:00:00.000Z", endsAt: "2026-10-15T19:00:00.000Z", daysLeft: 0, endingSoon: false, ended: true, extendedDays: 14 };
    const term = { startedAt: "2026-09-01T19:00:00.000Z", endsAt: "2026-10-15T19:00:00.000Z", startedBy: "its_check" as const, extensions: [{ days: 14, reason: "The kick-off call moved.", by: { kind: "user" as const, id: "s1", name: "Ada Admin" }, at: "2026-09-25T17:00:00.000Z", from: "2026-10-01T19:00:00.000Z", to: "2026-10-15T19:00:00.000Z" }] };
    const row = company("co7", "Sunrise Dental", { planKey: "trial", planName: "Trial", trial, trialTerm: term, jobs: { open: 0, total: 0 } });
    const html = from(page([row], "open=co7"), 'role="dialog"');
    expect(text(card(html, "Plan"))).toContain("Trial · ended Oct 15, paused");
    const words = text(card(html, "Trial"));
    expect(words).toContain("The trial ended on October 15: new applications, new jobs and new AI interviews are paused.");
    expect(words).toContain("Extended by 14 days on Sep 25 by Ada Admin, to Oct 15: The kick-off call moved.");
    expect(html).toContain('<input id="trial-days" class="input" type="number" inputMode="numeric" min="1" max="90" step="1" value="14"/>');
    // no reason yet: nothing to confirm
    expect(html).toContain('<button type="button" class="btn primary" disabled="">Extend the trial</button>');
    // another plan, or a company that is not accepted, has no trial card
    expect(from(page(all(), "open=co1", [twoJobs]), 'role="dialog"')).not.toContain("Extend the trial");
    expect(from(page([{ ...row, status: "declined", statusLabel: "Declined", accessDecisions: ["accept"] }], "open=co7"), 'role="dialog"')).not.toContain("Extend the trial");
  });

  it("makes a typed website a link only for http and https, and draws what a stranger typed as text", () => {
    const details = (website: string) => from(page([company("co3", "Avon Dental", { website, jobs: { open: 0, total: 0 } })], "open=co3"), "<dt>Website</dt>");
    expect(details("https://avon.example/about")).toContain('<a href="https://avon.example/about" target="_blank" rel="noopener noreferrer nofollow">https://avon.example/about<span class="sr-only"> (opens in a new tab)</span></a>');
    for (const typed of ["avon.example", "javascript:alert(1)", "https://good.example@evil.example"]) {
      const html = details(typed);
      expect(html.slice(0, html.indexOf("</dd>")), typed).not.toContain("<a ");
    }
    const evil = "<img src=x onerror=alert(1)>";
    const html = page([asking("co8", evil, { accessRequest: { status: "requested", person: { name: evil, email: "x@stranger.test" }, declined: null }, website: evil })], "open=co8");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // everything in the drawer breaks a very long word anywhere
    expect(html).toMatch(/<div class="drawer-body"><div class="stack gap-4 wrap-anywhere">/);
  });

  it("opens nothing for a company it does not know", () => {
    expect(page(all(), "open=nobody")).not.toContain('role="dialog"');
  });
});

describe("Accept, Decline and Take away access: what a press sends and says", () => {
  it("each press says where its row stood, so the first press wins; taking access away sends no place", () => {
    expect(facts.accessPress({ accessRequest: { status: "requested", person, declined: null } }, "accept")).toEqual({ decision: "accept", from: "requested", confirm: true });
    expect(facts.accessPress({ accessRequest: { status: "requested", person, declined: null } }, "decline")).toEqual({ decision: "decline", from: "requested", confirm: true });
    expect(facts.accessPress({ accessRequest: { status: "declined", person, declined: { at: daysAgo(1), by: "Ada Admin" } } }, "accept")).toEqual({ decision: "accept", from: "declined", confirm: true });
    expect(facts.accessPress({ accessRequest: null }, "remove")).toEqual({ decision: "remove", confirm: true });
  });

  it("says a press that was refused plainly: someone got there first is calm, an error is an error", () => {
    expect(facts.accessPressRefused(new ApiError(409, "access_decided", "Harbor Dental was declined a moment ago by Ada Admin. Nothing changed."))).toEqual({ title: "Harbor Dental was declined a moment ago by Ada Admin. Nothing changed." });
    expect(facts.accessPressRefused(new ApiError(403, "mfa_required", "Confirm it's you."))).toEqual({ title: "Confirm it's you.", tone: "critical" });
    expect(facts.accessPressRefused(new TypeError("Failed to fetch"))).toEqual({ title: "Could not record that. Try again.", tone: "critical" });
  });

  it("the toast is the API's words; after Take away access it adds how many lost it, and the email only when it left", () => {
    expect(facts.accessToast({ message: "Harbor Dental was accepted." })).toEqual({ title: "Harbor Dental was accepted.", detail: undefined });
    expect(facts.accessToast({ message: "Harbor Dental no longer has access.", people: 2, emailed: true })).toEqual({ title: "Harbor Dental no longer has access.", detail: "2 people can no longer work in it. We emailed the owner." });
    expect(facts.accessToast({ message: "Harbor Dental no longer has access.", people: 1, emailed: false })).toEqual({ title: "Harbor Dental no longer has access.", detail: "1 person can no longer work in it." });
  });

  it("says how long a request has waited", () => {
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    expect(facts.waitingWords("2026-10-15T09:00:00.000Z", now)).toBe("Waiting since today");
    expect(facts.waitingWords("2026-10-14T09:00:00.000Z", now)).toBe("Waiting 1 day");
    expect(facts.waitingWords("2026-10-12T09:00:00.000Z", now)).toBe("Waiting 3 days");
  });
});

describe("the plan and the trial on the dashboard", () => {
  it("says what a plan costs and includes, in dollars", () => {
    expect(facts.planLimitsLine({ active_roles: 1, jobs_total: 1, candidates_per_job: 5, text_screens: null, ai_credit_total_cents: 1000, ai_credit_monthly_cents: null, seats: 2 })).toBe("1 job ever · 5 candidates a job · $10 AI credit in all · 2 seats");
    expect(facts.planLimitsLine({ active_roles: 3, text_screens: 300, seats: null })).toBe("3 active jobs · 300 AI interviews a month · unlimited seats");
    expect(facts.planLimitsLine({ active_roles: 30, jobs_total: null, candidates_per_job: null, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 20000, seats: null })).toBe("30 active jobs · $200 AI credit a month · unlimited seats");
    expect(facts.planLimitsLine({})).toBe("");
    expect(facts.planPriceLine({ monthlyUsd: 149 })).toBe("$149 a month");
    expect(facts.planPriceLine(undefined)).toBeNull();
    expect(facts.aiCreditDollars({ monthly: false, spentUsd: 9.87, limitUsd: 10, resetsAt: null })).toBe("$9.87 of $10 AI credit");
    expect(facts.aiCreditDollars({ monthly: true, spentUsd: 20, limitUsd: 20, resetsAt: "2026-12-05T12:00:00Z" })).toBe("$20.00 of $20 AI credit this month, resets December 5");
    expect([facts.aiCreditChip("used_up"), facts.aiCreditChip("warning"), facts.aiCreditChip(null)]).toEqual(["AI credit used up", "80% of AI credit used", null]);
  });

  it("says what a change of plan did", () => {
    expect(facts.planChangedToast("Bright Dental", "Pro")).toEqual({ title: "Bright Dental is on Pro now.", detail: "The new limits apply at once. This month's usage stays; the reset date does not move." });
    expect(facts.planChangedToast("Bright Dental", "Pro", false, 1).detail).toBe("The new limits apply at once. This month's usage stays; the reset date does not move. 1 locked applicant opens now.");
    expect(facts.planChangedToast("Bright Dental", "Pro", false, 3).detail).toContain("3 locked applicants open now.");
    expect(facts.planChangedToast("Sunrise Dental", "Pro", true).detail).toBe("The trial has ended; new applications are open again. The new limits apply at once. This month's usage stays; the reset date does not move.");
    expect(facts.planChangedToast("Bright Dental", "Basic", false, 0, true).detail).toBe("The new limits apply at once. AI help starts a new month today; other allowances keep their dates.");
  });

  it("says the extension and its date in plain words, counted from the later of the end and now", () => {
    expect(facts.trialExtensionQuestion("Sunrise Dental", 14, "2026-11-13T19:00:00.000Z", "America/Los_Angeles")).toBe("Extend Sunrise Dental's trial by 14 days, to November 13?");
    expect(facts.trialExtensionQuestion("Sunrise Dental", 1, "2026-11-13T19:00:00.000Z", "America/Los_Angeles")).toBe("Extend Sunrise Dental's trial by 1 day, to November 13?");
    expect(facts.trialExtendedToast("2026-11-13T19:00:00.000Z", "America/Los_Angeles")).toBe("Trial extended to November 13.");
    expect(facts.trialExtendedTo({ endsAt: "2026-10-15T19:00:00.000Z" }, 14, Date.parse("2026-10-01T00:00:00.000Z"))).toBe("2026-10-29T19:00:00.000Z");
    expect(facts.trialExtendedTo({ endsAt: "2026-10-15T19:00:00.000Z" }, 14, Date.parse("2026-10-20T00:00:00.000Z"))).toBe("2026-11-03T00:00:00.000Z");
    expect([0, 1, 90, 91, 1.5].map(facts.extensionDaysOk)).toEqual([false, true, true, false, false]);
    expect(facts.extensionLines(null)).toEqual([]);
  });
});

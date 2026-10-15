import * as React from "react";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The ITS console's Customers section (apps/web/src/pages/admin/customers.tsx and outcomes.tsx) as the server first draws
 * it from answers shaped like the API's (redesign spec 3.2, Wave S6): five columns with filter pills, a search box and a
 * Sort chip; the companies waiting for the ITS check kept on top whatever the order (founder decision B7); the customer
 * drawer kept in the address (`?open=<id>&tab=…`) with the bodies of the four sheets the console had before; and the
 * hiring outcomes with the correction in a drawer.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/customers",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { CUSTOMER_SORT, CUSTOMER_SORT_CHOICES, CustomersSection, customerAnnouncement, customerFilterFrom, customerInFilter, customerMatches, customerOrder, customersSearch, customerTabFrom, nextCustomerSort, planChangedToast, planLimitsLine, screeningLine, sortedCustomers, waitingCustomers, waitingWords } = await import("@ros/web/src/pages/admin/customers");
const { Outcomes, outcomeWords } = await import("@ros/web/src/pages/admin/outcomes");
const { sortRows } = await import("@ros/ui");

const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
/** The markup from one table's opening tag on, so a name said earlier on the page (an alert, a heading) does not count. */
const from = (html: string, start: string | RegExp) => {
  const at = typeof start === "string" ? html.indexOf(start) : html.search(start);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
};
/** The Customers section on its first part, as /admin/customers draws it, at the address `search`. */
const Customers = (search = "") => {
  nav.search = search;
  return createElement(CustomersSection, { view: null, onView: () => undefined });
};

const owner = { user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role: "owner" }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } };
const admin = { ...owner, user: { ...owner.user, id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, memberships: [], activeCompanyId: null };

function client(data: Array<[unknown[], unknown]> = [], me: unknown = owner) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}

/** A role report as the API answers it (apps/api/src/services/role-report.ts), trimmed to a few people. */
const report = {
  generatedAt: "2026-10-10T09:00:00.000Z",
  role: null,
  applicants: {
    total: 3, last30Days: 3, timeZone: "America/Los_Angeles",
    bySource: [{ source: "careers_page", label: "Careers page", sourceDetail: null, count: 2 }, { source: "referral", label: "Referral", sourceDetail: "Dr. Patel", count: 1 }],
    byDay: [{ day: "2026-10-08", count: 0 }, { day: "2026-10-09", count: 2 }, { day: "2026-10-10", count: 1 }],
  },
  stages: { total: 3, byStage: [{ stage: "triaged", label: "Ready for your review", group: "waiting_on_you", count: 3 }], byGroup: { waiting_on_you: 3 }, byOwnerStage: { new: 3 } },
  timeInStage: { byStage: [{ stage: "triaged", label: "Ready for your review", group: "waiting_on_you", completed: 0, medianDays: null, averageDays: null, nowHere: 3, longestDays: 2 }], waitingOnYou: { count: 3, averageDays: 1, medianDays: 1, longestDays: 2 } },
  interviews: { total: 1, requested: 0, scheduled: 1, completed: 0, noShow: 0, noShowCandidate: 0, noShowInterviewer: 0, cancelled: 0, offerExpired: 0, rescheduledByCandidate: 0, awaitingDecision: 0, byRound: [{ roundKey: "working", title: "Working interview", total: 1, scheduled: 1, completed: 0, noShow: 0, noShowCandidate: 0, noShowInterviewer: 0, cancelled: 0 }] },
  pendingDecisions: { count: 3, approvals: 0, candidates: 3, oldestDays: 2, list: [] },
  recommendationsVsDecisions: { assessed: 2, rows: [{ recommendation: "advance", label: "Invite to a screen", total: 2, invited: 1, interviewed: 0, shortlisted: 0, declined: 0, held: 0, noActionYet: 1 }] },
  overrides: { eligibilityOverrides: 0, reviewAnyway: 0, holds: 0, flaggedAssessments: 0, byAction: {} },
  escalations: { total: 0, open: 0, resolved: 0, overdue: 0, medianResponseHours: null },
  messages: { total: 0, sent: 0, failed: 0, bounced: 0, unknown: 0, pending: 0, candidatesAffected: 0 },
  outcomes: { statement: "Outcomes are what people recorded.", hired: 0, withdrew: 0, declinedByEmployer: 1, declinedOffer: 0, noHire: 0, talentPool: 0, corrections: 0, role: null, rolesByOutcome: {}, declineReasons: [{ reason: "not_a_match_skills", label: "Skills not a match", count: 1 }] },
};

const company = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, slug: id, vertical: "dental", sizeBand: "20-49", planKey: "starter", status: "active", roles: 1, applications: 0, aiCostUsd: 0, lastActivityAt: daysAgo(1), escalations: 0, createdAt: daysAgo(30),
  settings: {}, verifiedAt: daysAgo(29), verifiedBy: null, heldMessages: 0, jobBoardsConfirmedAt: null, applyFlowDefault: "form_then_screen", ...over,
});
type Row = Parameters<typeof CUSTOMER_SORT.company>[0];

// Cara Dental waits for the check but comes second in the answer: only the B7 rule can put it first
const three = () => [
  company("co1", "Bright Dental", { roles: 2, applications: 3, aiCostUsd: 0.04, recruiterAsks: { used: 12, limit: 10, over: true }, escalations: 14, screeningConversations: { used: 122, limit: 150, resetsAt: "2026-10-30T12:00:00.000Z" } }),
  company("co2", "Cara Dental", { verifiedAt: null, createdAt: daysAgo(3), roles: 0, heldMessages: 2, lastActivityAt: daysAgo(0) }),
  company("co3", "Avon Dental", { applications: 7, aiCostUsd: 0.1, lastActivityAt: daysAgo(9), planKey: "growth" }),
];
const lowAlert = { id: "al1", kind: "billing.screens_warning", severity: "info", title: "", body: "", status: "open", companyId: "co1", target: null, details: { used: 122, limit: 150 }, createdAt: daysAgo(1) };

describe("the customers list", () => {
  it("has five columns, keeps the companies waiting for the ITS check on top (B7) and fits without sideways scrolling", () => {
    const html = render(client([[["admin", "customers"], three()], [["admin", "alerts"], []]], admin), Customers());
    // no sticky first column and no inner scroll box: five columns fit 1366 px (redesign spec 3.3)
    expect(html).toContain('<section class="table-wrap" tabindex="0" aria-label="Customers">');
    expect(html.match(/<th scope="col"/g)).toHaveLength(5);
    expect(html).toContain('<th scope="col"><button type="button" class="th-sort">Company');
    expect(html).toContain('<th scope="col">ITS check</th>');
    expect(html).toContain('<th scope="col">Plan and use</th>');
    expect(html).toContain('<th scope="col"><button type="button" class="th-sort">Last active');
    expect(html).toContain('<span class="sr-only">Actions</span>');
    // AI cost and Applicants are no longer columns; the drawer's Overview has them
    expect(html).not.toContain("$0.0400");
    // nothing is sorted until someone sorts, and nothing is said yet
    expect(html).not.toContain("aria-sort");
    expect(html).toContain('<span class="sr-only" role="status"></span>');
    // the caution alert above the table names Cara Dental too, so the order is read from the table on
    const table = from(html, '<section class="table-wrap"');
    expect(table.indexOf("Cara Dental")).toBeLessThan(table.indexOf("Bright Dental"));
    // the confirmed companies below keep the order they came in until someone sorts
    expect(table.indexOf("Bright Dental")).toBeLessThan(table.indexOf("Avon Dental"));
    const words = text(table);
    // a waiting company: how long, the messages held, and "Confirm" opens its ITS check
    expect(words).toContain("Cara Dental dental · 20-49 Waiting 3 days 2 messages held");
    expect(html).toContain('aria-label="Confirm Cara Dental"');
    expect(html).toContain('aria-label="Open Bright Dental"');
    // the plan in words and this month's chats; last active in words, a quiet company flagged
    expect(words).toContain("Starter 122 of 150 chats this month");
    expect(words).toContain("Growth");
    expect(words).toContain("yesterday");
    expect(words).toContain("quiet 9d");
    expect(words).toContain("today");
  });

  it("keeps the waiting companies on top, the longest waiting first, under every order the Sort chip or a heading gives (B7)", () => {
    const rows = [
      company("co1", "Bright Dental", { applications: 3, aiCostUsd: 0.04, lastActivityAt: daysAgo(3) }),
      company("co2", "Cara Dental", { verifiedAt: null, createdAt: daysAgo(2), applications: 9, aiCostUsd: 0.5, lastActivityAt: daysAgo(0) }),
      company("co3", "Avon Dental", { applications: 7, aiCostUsd: 0.1, lastActivityAt: daysAgo(1) }),
      company("co4", "Zeta Dental", { verifiedAt: null, createdAt: daysAgo(5), applications: 0, aiCostUsd: 0, lastActivityAt: null }),
      company("co5", "Dove Dental", { applications: 1, aiCostUsd: 0.2, lastActivityAt: daysAgo(9) }),
    ] as unknown as Row[];
    const names = (list: Row[]) => list.map((c) => c.name);
    const confirmed = rows.filter((c) => c.verifiedAt);
    expect(names(waitingCustomers(rows))).toEqual(["Zeta Dental", "Cara Dental"]);
    // before anyone sorts, the confirmed companies keep the order they came in
    expect(names(sortedCustomers(rows, null))).toEqual(["Zeta Dental", "Cara Dental", "Bright Dental", "Avon Dental", "Dove Dental"]);
    // the Sort chip offers every order the list had (Company, Applicants, AI cost, Last activity)
    expect(CUSTOMER_SORT_CHOICES.map((c) => c.id).sort()).toEqual(Object.keys(CUSTOMER_SORT).sort());
    let moved = 0;
    for (const choice of CUSTOMER_SORT_CHOICES) {
      // a choice from the chip, then the same heading pressed (or the other way round), gives both directions
      const fromChip = nextCustomerSort(null, choice.id, "chip");
      const flipped = nextCustomerSort(fromChip, choice.id, "heading");
      expect(flipped.dir).not.toBe(fromChip.dir);
      expect(nextCustomerSort(flipped, choice.id, "chip")).toEqual(fromChip);
      for (const sort of [fromChip, flipped]) {
        const order = names(sortedCustomers(rows, sort));
        expect(order.slice(0, 2), `${choice.id} ${sort.dir}`).toEqual(["Zeta Dental", "Cara Dental"]);
        expect(order.slice(2), `${choice.id} ${sort.dir}`).toEqual(names(sortRows(confirmed, CUSTOMER_SORT[sort.key], sort.dir)));
        expect(names(customerOrder(rows, (list) => sortRows(list, CUSTOMER_SORT[sort.key], sort.dir)))).toEqual(order);
        // the fixture bites: sorting every company together would move a waiting one down under each of these orders
        if (names(sortRows(rows, CUSTOMER_SORT[sort.key], sort.dir)).slice(0, 2).join() !== "Zeta Dental,Cara Dental") moved++;
      }
    }
    expect(moved).toBe(8);
    // the usual first order: A to Z for the name, highest first for figures, latest first for the last activity
    expect(nextCustomerSort(null, "company", "chip").dir).toBe("ascending");
    expect(nextCustomerSort(null, "cost", "chip").dir).toBe("descending");
    expect(nextCustomerSort(null, "activity", "chip").dir).toBe("descending");
    expect(customerAnnouncement("Sorted by AI cost, highest first.", 2)).toBe("Sorted by AI cost, highest first. Companies waiting for the ITS check stay at the top.");
    expect(customerAnnouncement("Sorted by AI cost, highest first.", 0)).toBe("Sorted by AI cost, highest first.");
    expect(customerAnnouncement("", 2)).toBe("");
  });

  it("shows the Sort chip as a menu button beside the search box", () => {
    const html = render(client([[["admin", "customers"], three()], [["admin", "alerts"], []]], admin), Customers());
    expect(html).toMatch(/<button type="button" class="btn secondary sm" aria-haspopup="menu" aria-expanded="false">Sort<svg/);
    expect(html).toContain('<input class="input talent-search" type="search" placeholder="Search customers" aria-label="Search customers" value=""/>');
  });

  it("counts each pill and shows only its companies, with one way back when nothing matches", () => {
    const qc = () => client([[["admin", "customers"], three()], [["admin", "alerts"], [lowAlert]]], admin);
    const all = render(qc(), Customers());
    expect(all).toContain('<button type="button" class="toggle-chip" aria-pressed="true">All <span class="count">3</span></button>');
    expect(all).toContain('aria-pressed="false">Waiting for the ITS check <span class="count">1</span></button>');
    expect(all).toContain('aria-pressed="false">Running low <span class="count">1</span></button>');
    expect(all).toContain('aria-pressed="false">Quiet <span class="count">1</span></button>');
    // the low company is flagged on its row; the list of who runs low waits under its pill
    expect(text(all)).toContain("Running low");
    expect(all).toContain('title="80% of screening chats used (122 of 150)"');
    expect(text(all)).not.toContain("Screening chats running low");

    const waiting = from(render(qc(), Customers("show=waiting")), '<section class="table-wrap"');
    expect(waiting).toContain("Cara Dental");
    expect(waiting).not.toContain("Bright Dental");
    expect(waiting).not.toContain("Avon Dental");

    const low = render(qc(), Customers("show=low"));
    expect(text(low)).toContain("Screening chats running low");
    expect(text(low)).toContain("Bright Dental : 80% of screening chats used (122 of 150), since");
    expect(text(low)).toContain("Talk with each about topping up. Nothing is refused:");
    expect(from(low, '<section class="table-wrap"')).not.toContain("Avon Dental");

    const quiet = from(render(qc(), Customers("show=quiet")), '<section class="table-wrap"');
    expect(quiet).toContain("Avon Dental");
    expect(quiet).not.toContain("Bright Dental");

    // a search from the Overview's "See all" (`?q=`) narrows the list; nothing found says so, with one button
    const none = render(qc(), Customers("q=zebra"));
    expect(none).toContain('value="zebra"');
    expect(text(none)).toContain("Nothing matches this filter. Show all customers");
  });

  it("keeps the waiting-companies sentence word for word above the list", () => {
    const words = text(render(client([[["admin", "customers"], three()], [["admin", "alerts"], []]], admin), Customers()));
    expect(words).toContain("1 company is waiting for the ITS check: Cara Dental. Until you confirm a company, its careers page, job pages and Google listing are offline and its emails to candidates wait.");
    expect(words).toContain("Show only these");
  });

  it("keeps the headings and says so in a row when there are no customers", () => {
    const html = render(client([[["admin", "customers"], []], [["admin", "alerts"], []]], admin), Customers());
    expect(html).toMatch(/<td colspan="5" class="table-empty">No customers yet\.<\/td>/i);
    expect(html).toContain('<span class="sr-only" role="status">No customers yet.</span>');
    expect(html).toContain('<th scope="col">Plan and use</th>');
  });

  it("shows quiet rows under the headings while the customers load", () => {
    const loading = render(client([[["admin", "alerts"], []]], admin), Customers());
    expect(loading).toContain('<tbody aria-busy="true">');
    expect(loading).toContain('<span class="sr-only" role="status">Loading…</span>');
  });

  it("reads and writes its place in the address, the console's own settings kept", () => {
    const at = new URLSearchParams("view=all&q=bright");
    expect(customersSearch(at, { open: "co1", tab: "check" })).toBe("?view=all&q=bright&open=co1&tab=check");
    expect(customersSearch(new URLSearchParams("open=co1&tab=plan"), { tab: "overview" })).toBe("?open=co1");
    expect(customersSearch(new URLSearchParams("view=all&open=co1&tab=plan"), { open: null })).toBe("?view=all");
    expect(customersSearch(new URLSearchParams("show=low"), { show: "all" })).toBe("");
    expect(customersSearch(new URLSearchParams(""), { show: "quiet" })).toBe("?show=quiet");
    expect(customerTabFrom("report")).toBe("report");
    expect(customerTabFrom("nonsense")).toBe("overview");
    expect(customerTabFrom(null)).toBe("overview");
    expect(customerFilterFrom("low")).toBe("low");
    expect(customerFilterFrom("anything")).toBe("all");
    const [bright, cara, avon] = three() as unknown as Row[];
    expect(customerInFilter(cara, "waiting", new Map())).toBe(true);
    expect(customerInFilter(bright, "waiting", new Map())).toBe(false);
    expect(customerInFilter(bright, "low", new Map([["co1", {}]]))).toBe(true);
    expect(customerInFilter(avon, "quiet", new Map())).toBe(true);
    expect(customerMatches(bright, " BRIGHT ")).toBe(true);
    expect(customerMatches(bright, "dental")).toBe(true);
    expect(customerMatches(bright, "avon")).toBe(false);
    const now = Date.parse("2026-10-15T12:00:00.000Z");
    expect(waitingWords("2026-10-15T09:00:00.000Z", now)).toBe("Waiting since today");
    expect(waitingWords("2026-10-14T09:00:00.000Z", now)).toBe("Waiting 1 day");
    expect(waitingWords("2026-10-12T09:00:00.000Z", now)).toBe("Waiting 3 days");
  });
});

describe("the customer drawer", () => {
  const data = (): Array<[unknown[], unknown]> => [[["admin", "customers"], three()], [["admin", "alerts"], [lowAlert]]];

  it("opens from the address on its Overview, named by the company, with everything the old row said", () => {
    const html = render(client(data(), admin), Customers("open=co1"));
    expect(html).toContain('role="dialog" aria-modal="true" aria-label="Bright Dental"');
    expect(html).toContain('<div role="tablist" aria-label="Customer sections"');
    for (const tab of ["Overview", "ITS check", "Plan", "How people apply", "Report"]) expect(html).toContain(`data-label="${tab}"`);
    expect(html).toMatch(/id="customer-drawer-tab-overview" class="tab" aria-selected="true"/);
    const words = text(html);
    expect(words).toContain("dental · 20-49 employees · signed up");
    // AI cost in plain money, the exact figure on hover
    expect(html).toContain('<span title="$0.0400">$0.04</span> in all');
    // the recruiter requests this month and in all, and the billing chip past the plan's number (Q33)
    expect(words).toContain("12 of 10 this month · 14 in all");
    expect(words).toContain("Past its recruiter requests: talk about billing");
    // the plan, its screening chats with the reset date, the running-low chip, and the way to change it
    expect(words).toContain("Starter · Active Change plan");
    expect(words).toContain("122 of 150 screening chats this month, resets October 30");
    expect(words).toContain("80% of screening chats used (122 of 150)");
    expect(words).toContain("How people apply Form now, conversation later Change");
    expect(html).toContain('aria-label="Change how people apply"');
    expect(words).toContain("2 jobs · 3 applicants");
    expect(words).toContain("Job boards Not confirmed yet");
    expect(words).toContain("Messages held None");
    expect(words).toContain("See the report");
  });

  it("opens a waiting company on its ITS check, the old sheet's words unchanged", () => {
    const html = render(client(data(), admin), Customers("open=co2&tab=check"));
    expect(html).toContain('aria-label="Cara Dental"');
    expect(html).toMatch(/id="customer-drawer-tab-check" class="tab" aria-selected="true"/);
    const words = text(html);
    expect(words).toContain("Confirm the company");
    expect(words).toContain("Confirm only after checking the company is real: the kick-off call, its website, a phone number.");
    expect(words).toContain("2 messages to candidates are held and will go out when you confirm.");
    expect(html).toContain('<label for="co-check-why">How you checked the company</label>');
    expect(words).toContain("ITS can sign in to the job boards");
  });

  it("holds the plan and how people apply on their own tabs", () => {
    const qc = client([...data(), [["admin", "plans"], [{ key: "starter", name: "Starter", limits: { active_roles: 3 } }, { key: "growth", name: "Growth", limits: { active_roles: 10 } }]], [["admin", "customer-report", "co1"], { roles: [{ id: "r1", title: "Dental Hygienist", status: "open" }] }]], admin);
    const plan = render(qc, Customers("open=co1&tab=plan"));
    expect(text(plan)).toContain("Pick a plan");
    expect(plan).toContain('<select id="plan-pick" class="select">');
    const apply = render(qc, Customers("open=co1&tab=apply"));
    expect(text(apply)).toContain("The company's default");
    expect(text(apply)).toContain("Each role");
    expect(text(apply)).toContain("Dental Hygienist");
  });

  it("gives the administrator's view of a customer's report the same figures on its Report tab, and right-aligns the roles' counts", () => {
    const customer = { company: { id: "co1", name: "Bright Dental", status: "active", planKey: "starter" }, roles: [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), closedAt: null, applicants: 3, waitingOnYou: 2, hired: 0 }], report };
    const html = render(client([...data(), [["admin", "customer-report", "co1"], customer]], admin), Customers("open=co1&tab=report"));
    expect(html).toMatch(/id="customer-drawer-tab-report" class="tab" aria-selected="true"/);
    expect(html).toContain('<th scope="col" class="num">Waiting on them</th>');
    expect(html).toMatch(/<td>Dental Hygienist<\/td><td><span class="pill good sm">.*?open<\/span><\/td><td class="num">3<\/td><td class="num">2<\/td><td class="num">0<\/td>/);
    expect(html).toContain('<div class="daybars" role="img"');
    expect(html.match(/<div class="stat-row">/g)).toHaveLength(2);
  });

  it("opens nothing for a customer it does not know", () => {
    const html = render(client(data(), admin), Customers("open=nobody"));
    expect(html).not.toContain('role="dialog"');
  });
});

describe("the hiring outcomes", () => {
  it("keeps the statement on top and five headings, and says so in a row when none is recorded", () => {
    const html = render(client([[["admin", "outcomes"], { statement: "People record outcomes.", outcomes: [] }]], admin), createElement(Outcomes));
    expect(text(html)).toContain("People record outcomes.");
    expect(html).toMatch(/<td colspan="5" class="table-empty">No outcomes recorded yet\.<\/td>/i);
    expect(html.match(/<th scope="col"/g)).toHaveLength(5);
    expect(html).toContain('<th scope="col">What was recorded</th>');
    expect(html).toContain('<th scope="col">Hire date</th>');
  });

  it("says what was recorded in words, who recorded it and when, and offers a correction only once", () => {
    const outcomes = [
      { id: "o1", companyName: "Bright Dental", applicationId: "a1", roleId: "r1", milestone: "hire", outcome: "hired_externally", hireDate: "2026-10-01", offerAcceptedAt: null, recordedBy: { id: "u1", name: "Dana Whitfield" }, recordedAt: daysAgo(2), correctionOf: null, correctedAt: null, correctionReason: null },
      { id: "o2", companyName: "Avon Dental", applicationId: null, roleId: "r2", milestone: "role", outcome: "filled", hireDate: null, offerAcceptedAt: null, recordedBy: { id: "u2" }, recordedAt: daysAgo(1), correctionOf: null, correctedAt: daysAgo(0), correctionReason: "Wrong role" },
    ];
    const html = render(client([[["admin", "outcomes"], { statement: "People record outcomes.", outcomes }]], admin), createElement(Outcomes));
    const words = text(html);
    expect(words).toContain("Bright Dental Hired externally For a candidate 2026-10-01 Dana Whitfield 2 days ago Correct");
    expect(words).toContain("Filled For the job Corrected: Wrong role");
    expect(html).toContain('aria-label="Correct the outcome for Bright Dental"');
    expect(html).not.toContain('aria-label="Correct the outcome for Avon Dental"');
    // the correction form is in a drawer now, not in the table's cell
    expect(html).not.toContain("Corrected outcome");
    expect(outcomeWords("offer_declined_externally")).toBe("Offer declined externally");
  });
});

describe("the plan and the recruiter requests on the console", () => {
  it("says what a plan includes and when the screening chats start again", () => {
    expect(planLimitsLine({ active_roles: 3, text_screens: 300, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 10, seats: null })).toBe("3 active jobs · 300 screening chats a month · 10 recruiter requests a month · unlimited seats");
    expect(screeningLine({ used: 25, limit: 25, resetsAt: "2026-10-30T12:00:00.000Z" })).toBe("25 of 25 screening chats this month, resets October 30");
    expect(screeningLine({ used: 4, limit: null })).toBe("4 screening chats this month");
    expect(planChangedToast("Bright Dental", "Design Partner")).toEqual({ title: "Bright Dental is on Design Partner now.", detail: "The new limits apply at once. This month's usage stays; the reset date does not move." });
  });

  it("flags a company past its recruiter requests, for a billing conversation", () => {
    const customers = readFileSync(new URL("../../web/src/pages/admin/customers.tsx", import.meta.url), "utf8");
    expect(customers).toContain("c.recruiterAsks?.over ? <Chip tone=\"caution\">{RECRUITER_ASKS_OVER_CHIP}</Chip>");
  });
});

import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The ITS console's Overview (apps/web/src/pages/admin/Overview.tsx, Wave S6), as the server first draws it from answers
 * shaped like the API's: "Needs attention" with one row per open problem, most urgent first, each with the one button
 * that opens the exact place; "Nothing needs you right now." when nothing does; a source that fails says so on its own
 * row with "Try again" while the others still show; the Customers card (waiting companies first, any customer one click
 * away); this month's AI spend with the top three customers by name; and the System line.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { ACCESS_ROWS_EACH, Overview, attentionCount, attentionRows, costSummary, customerLine, customerMatches, dueWords, monthStart, waitedWords } = await import("@ros/web/src/pages/admin/Overview");
const { Console, viewSearch } = await import("@ros/web/src/pages/admin/Console");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString();
const admin = { user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [], activeCompanyId: null, staffAccess: null, ai: { provider: "fake" } };

const customer = (id: string, called: string, extra: Record<string, unknown> = {}) => ({ id, name: called, slug: called.toLowerCase().replace(/\s+/g, "-"), vertical: "dental", sizeBand: "20-49", planKey: "core", status: "active", roles: 1, applications: 2, aiCostUsd: 0.04, lastActivityAt: daysAgo(1), escalations: 0, createdAt: daysAgo(30), settings: {}, verifiedAt: daysAgo(29), verifiedBy: { id: "s1", name: "Ada" }, heldMessages: 0, jobBoardsConfirmedAt: null, ...extra });
const customers = [
  customer("co-bright", "Bright Dental"),
  customer("co-avon", "Avon Dental", { lastActivityAt: daysAgo(9) }),
  // waiting for the ITS check: Zeta has waited longest, so it comes first (B7)
  customer("co-cara", "Cara Dental", { verifiedAt: null, verifiedBy: null, createdAt: daysAgo(3), heldMessages: 2 }),
  customer("co-zeta", "Zeta Dental", { verifiedAt: null, verifiedBy: null, createdAt: daysAgo(5) }),
];
const alertRow = (id: string, kind: string, severity: string, title: string, state = "open", companyId: string | null = null, details: Record<string, unknown> = {}) => ({ id, kind, severity, title, body: "", status: state, companyId, target: null, details, createdAt: daysAgo(0) });
const alerts = [
  alertRow("al1", "credential.delete_failed", "critical", "Credential delete failed"),
  alertRow("al2", "worker.slow", "warning", "Worker is slow", "acknowledged"),
  alertRow("al3", "billing.screens_warning", "warning", "AI interviews at 80%", "open", "co-bright", { used: 122, limit: 150 }),
];
const failures = { failedRuns: [{ id: "r1" }, { id: "r2" }, { id: "r3" }], failedJobs: [], failedAi: [], alerts: [], pendingDeletions: [] };
const request = (id: string, companyName: string, slaDueAt: string, state = "received") => ({ id, companyId: "co-avon", companyName, candidateId: null, applicationId: null, kind: "access", details: null, requesterEmail: "p@x.test", channel: "email", verificationStatus: "pending", verificationNote: null, status: state, slaDueAt, assignedTo: null, notes: [], counselEscalatedAt: null, counselDecision: null, counselNote: null, resolution: null, resolvedAt: null, confirmationSentAt: null, escalationId: null, createdAt: daysAgo(10) });
const privacy = [request("dr1", "Avon Dental", daysAhead(1.5)), request("dr2", "Bright Dental", daysAhead(20)), request("dr3", "Cara Dental", daysAgo(2), "fulfilled")];
const csp = { mode: "report", reports: [{ id: "c1", reviewedAt: null }, { id: "c2", reviewedAt: daysAgo(1) }] };
const escalations = [{ id: "e1", status: "open", overdue: true, companyName: "Bright Dental" }, { id: "e2", status: "open", overdue: false, companyName: "Avon Dental" }];
const calendar = { version: 3, current: { timeZone: "America/Los_Angeles" } };
const queue = { queued: 0, failed: 0, oldestQueuedAt: null, waitingRuns: 2, definitions: ["screen"] };
const since = monthStart("America/Los_Angeles");
const costRow = (companyId: string | null, costUsd: number) => ({ companyId, task: "screen.turn", model: "claude-haiku-5-5", runs: 3, inputTokens: 10, outputTokens: 20, costUsd });
const costs = [costRow("co-bright", 4.1), costRow("co-avon", 2.02), costRow("co-cara", 0.88), costRow("co-zeta", 0.4), costRow(null, 5)];

const ALL: Array<[unknown[], unknown]> = [
  [["admin", "customers"], customers],
  [["admin", "alerts"], alerts],
  [["admin", "failures"], failures],
  [["admin", "privacy"], privacy],
  [["admin", "failed-email-applications"], [{ id: "m1" }]],
  [["admin", "csp"], csp],
  [["escalations"], escalations],
  [["admin", "calendar"], calendar],
  [["admin", "queue"], queue],
  [["admin", "costs", "since", since], costs],
];
const NOTHING: Array<[unknown[], unknown]> = [
  [["admin", "customers"], [customers[0]]],
  [["admin", "alerts"], []],
  [["admin", "failures"], { failedRuns: [], failedJobs: [], failedAi: [], alerts: [], pendingDeletions: [] }],
  [["admin", "privacy"], []],
  [["admin", "failed-email-applications"], []],
  [["admin", "csp"], { mode: "report", reports: [] }],
  [["escalations"], []],
  [["admin", "calendar"], calendar],
  [["admin", "queue"], queue],
  [["admin", "costs", "since", since], []],
];

function client(data: Array<[unknown[], unknown]>) {
  // nothing is fetched on the server: a query that failed stays failed while the page is drawn
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], admin);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
function failed(qc: QueryClient, queryKey: unknown[]) {
  qc.getQueryCache().build(qc, { queryKey }).setState({ status: "error", error: new Error("The server did not answer."), fetchStatus: "idle" });
  return qc;
}
const render = (qc: QueryClient, node: ReactNode = createElement(Overview)) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));

describe("the console's Overview", () => {
  it("greets the administrator, says how many things need them and keeps the recruiter queue one click away", () => {
    const html = render(client(ALL));
    // no eyebrow over the greeting (founder's fewer-words rule, 23 Oct 2026): the rail already says this is the console
    expect(html).not.toContain("ITS · Console");
    expect(html).toMatch(/<h1>Good (morning|afternoon|evening), Ada\.<\/h1>/);
    expect(html).toContain("8 things need you.");
    expect(html).toContain('<a href="/recruiter/queue" class="btn secondary">Open the recruiter queue</a>');
    // the count is said once, in the stat strip; the list's heading under it carries none
    expect(html).toContain('<span class="stat-cell-label">Needs attention</span><span class="stat-cell-value">8</span>');
    expect(html).toContain("<h2>Needs attention</h2>");
    expect(html).not.toContain("Needs attention (8)");
    // the console's audit rule, once, in the strip's tinted cell
    expect(html.split("Every read in the console is recorded with a reason.")).toHaveLength(2);
  });

  it("lists one row per open problem, most urgent first, each with the button that opens the exact place", () => {
    const t = text(render(client(ALL)));
    const rows: Array<[string, string, string]> = [
      ["2 companies wait for the ITS check", "Review", "/admin/customers?open=co-zeta&amp;tab=check"],
      ["1 alert needs a person: “Credential delete failed”", "Open", "/admin/problems?view=alerts"],
      ["1 privacy request is due in 2 days (Avon Dental)", "Open", "/admin/privacy?open=dr1"],
      ["3 workflow runs failed", "Open", "/admin/problems?view=failed"],
      ["1 security report is not reviewed yet", "Open", "/admin/problems?view=security"],
      ["1 email application could not be imported", "Open", "/admin/problems?view=email"],
      ["1 recruiter request is overdue", "Open", "/recruiter/queue/e1"],
      ["Bright Dental has used 80% of its AI interviews", "Open", "/admin/customers?show=low&amp;open=co-bright"],
    ];
    const html = render(client(ALL));
    const at = rows.map(([sentence]) => t.indexOf(sentence));
    for (const [i, [sentence]] of rows.entries()) expect(at[i], sentence).toBeGreaterThan(-1);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const [sentence, label, href] of rows) expect(html, sentence).toContain(`<a href="${href}" class="btn secondary sm" aria-label="${label}: ${sentence}">${label}</a>`);
    // the longest waiting company first, with how long each has waited; the held alert and the closed request are not rows
    expect(t).toContain("Zeta Dental (5 days), Cara Dental (3 days)");
    expect(t).not.toContain("Worker is slow");
    expect(t).not.toContain("Cara Dental (overdue)");
    expect(t).toContain("80% of AI interviews used (122 of 150)");
  });

  it("says plainly when nothing needs a person", () => {
    const html = render(client(NOTHING));
    // said once, as the list's own row: no second line under the greeting, no line under the row
    expect(html.split("Nothing needs you right now.")).toHaveLength(2);
    expect(html).not.toContain('<p class="page-header-sub">');
    expect(html).not.toContain("Everything below is up to date.");
    expect(html).toContain('<span class="stat-cell-label">Needs attention</span><span class="stat-cell-value">0</span>');
    expect(html).toContain("<h2>Needs attention</h2>");
    expect(html).not.toContain("Try again");
    expect(html).not.toContain('class="btn secondary sm" aria-label="Open:');
  });

  it("shows a source that could not be read on its own row with Try again, and every other row still", () => {
    const qc = failed(client(ALL.filter(([key]) => key[1] !== "failures")), ["admin", "failures"]);
    const html = render(qc);
    const t = text(html);
    expect(t).toContain("Could not check failed work.");
    expect(html).toContain('aria-label="Try again: failed work">Try again</button>');
    expect(t).not.toContain("3 workflow runs failed");
    expect(t).toContain("2 companies wait for the ITS check");
    expect(t).toContain("1 alert needs a person");
    expect(t).not.toContain("Nothing needs you right now.");
    expect(t).toContain("7 things need you.");
  });

  it("waits quietly while nothing has been read yet", () => {
    const html = render(client([]));
    expect(html).toContain("<h2>Needs attention</h2>");
    expect(html).not.toContain("Nothing needs you right now.");
    expect(html).not.toContain("need you.");
  });

  it("finds any customer from the Customers card: waiting companies first, each one click from its drawer", () => {
    const html = render(client(ALL));
    // the count is the stat strip's (and the "See all" link's), not the card title's
    expect(html).toContain("<h2>Customers</h2>");
    expect(html).toContain('<span class="stat-cell-label">Customers</span><span class="stat-cell-value">4</span>');
    expect(html).toContain('aria-label="Search customers"');
    const t = text(html);
    const order = ["Zeta Dental Waiting for the ITS check (5 days)", "Cara Dental Waiting for the ITS check (3 days)", "Avon Dental Core · Quiet for 9 days", "Bright Dental Core · Active"].map((s) => t.indexOf(s));
    expect(order.every((i) => i > -1), t).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('<a href="/admin/customers?open=co-zeta&amp;tab=check" class="btn secondary sm" aria-label="Review Zeta Dental">Review</a>');
    expect(html).toContain('<a href="/admin/customers?open=co-bright" class="btn secondary sm" aria-label="Open Bright Dental">Open</a>');
    expect(html).toContain('<a href="/admin/customers" class="console-more">See all 4 customers</a>');
    expect(text(render(client([[["admin", "customers"], []]])))).toContain("No customers yet.");
  });

  it("shows this month's AI spend as one figure and the three customers who spent most, by name", () => {
    const html = render(client(ALL));
    expect(html).toContain("<h2>Costs this month</h2>");
    // the platform's own spend counts in the total, never among the customers
    expect(html).toContain('<p class="console-figure">$12.40</p>');
    const t = text(html);
    // the title says what the figure is; "at list prices" changes what it means, so it stays in view beside the figure,
    // once; the start date is the figure's tooltip, not a line under it
    expect(t).toContain("$12.40 at list prices");
    expect(html.split("at list prices")).toHaveLength(2);
    expect(html).toMatch(/title="AI spend since [A-Z][a-z]{2} 1"><p class="console-figure">/);
    expect(t).not.toContain("AI spend since");
    expect(t).toContain("Bright Dental $4.10");
    expect(t).toContain("Avon Dental $2.02");
    expect(t).toContain("Cara Dental $0.88");
    expect(t).not.toContain("Zeta Dental $0.40");
    expect(html).toContain('<a href="/admin/system?view=costs" class="console-more">See all costs</a>');
  });

  it("a tab left open stays true: every source behind Needs attention is asked again on focus and every minute while visible, never in a hidden tab; the recruiter requests less often", () => {
    // the review of 6 November 2026: left open at 9:00, it said "Nothing needs you right now." at 15:00 with someone waiting
    const qc = client(ALL);
    render(qc);
    const options = (queryKey: unknown[]) => qc.getQueryCache().find({ queryKey, exact: true })?.options as Record<string, unknown> | undefined;
    for (const key of [["admin", "customers"], ["admin", "alerts"], ["admin", "failures"], ["admin", "privacy"], ["admin", "failed-email-applications"], ["admin", "csp"]]) {
      expect(options(key), key.join(" ")).toMatchObject({ refetchOnWindowFocus: true, refetchInterval: 60_000, refetchIntervalInBackground: false });
    }
    // each read of the recruiter requests is recorded per customer: every five minutes, and on focus only once two have passed
    expect(options(["escalations"])).toMatchObject({ refetchOnWindowFocus: true, refetchInterval: 300_000, refetchIntervalInBackground: false, staleTime: 120_000 });
  });

  it("sums up the system in one line, and says when it could not check the queue", () => {
    const t = text(render(client(ALL)));
    expect(t).toContain("System: 0 jobs waiting · 0 failed · 2 workflow runs waiting · business calendar version 3 in force");
    const qc = failed(client(ALL.filter(([key]) => key[1] !== "queue")), ["admin", "queue"]);
    expect(text(render(qc))).toContain("Could not check the queue.");
  });
});

describe("Overview's rules", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  it("words waiting time and due dates plainly", () => {
    expect(waitedWords("2026-10-15T09:00:00Z", now)).toBe("since today");
    expect(waitedWords("2026-10-14T09:00:00Z", now)).toBe("1 day");
    expect(waitedWords("2026-10-10T09:00:00Z", now)).toBe("5 days");
    expect(dueWords("2026-10-15T11:00:00Z", now)).toBe("overdue");
    expect(dueWords("2026-10-15T20:00:00Z", now)).toBe("due within a day");
    expect(dueWords("2026-10-18T11:00:00Z", now)).toBe("due in 3 days");
  });

  it("counts privacy requests overdue or due within five days, and says how many are overdue", () => {
    const due = (id: string, slaDueAt: string) => ({ id, companyId: "c", companyName: "Avon Dental", status: "in_progress", slaDueAt }) as never;
    const rows = attentionRows({ privacy: [due("a", "2026-10-14T00:00:00Z"), due("b", "2026-10-17T00:00:00Z"), due("c", "2026-10-30T00:00:00Z")] }, now);
    expect(rows.map((r) => r.text)).toEqual(["2 privacy requests are due within 5 days, 1 of them overdue"]);
    expect(rows[0].action.href).toBe("/admin/privacy");
  });

  it("counts failed workflow runs always, and failed background tasks and AI runs only from the last week", () => {
    const at = (days: number) => new Date(now - days * DAY).toISOString();
    const base = { failedRuns: [], failedJobs: [], failedAi: [], alerts: [], pendingDeletions: [] };
    // old failures that nothing in the console can clear do not keep Overview from "Nothing needs you"
    expect(attentionRows({ failures: { ...base, failedJobs: [{ id: 1, createdAt: at(30) }], failedAi: [{ id: "a", createdAt: at(8) }] } }, now)).toEqual([]);
    // recent ones count, as a quiet row: they cannot be retried from the console
    const recent = attentionRows({ failures: { ...base, failedJobs: [{ id: 1, createdAt: at(1) }], failedAi: [{ id: "a", createdAt: at(30) }, { id: "b", createdAt: at(2) }] } }, now);
    expect(recent.map((r) => [r.text, r.urgent])).toEqual([["2 things failed", false]]);
    expect(recent[0].sub).toBe("1 background job · 1 AI run");
    // a failed workflow run has Retry, so the row is urgent
    const run = attentionRows({ failures: { ...base, failedRuns: [{ id: "r1" }], failedAi: [{ id: "a", createdAt: at(30) }] } }, now);
    expect(run.map((r) => [r.text, r.urgent, r.action.href])).toEqual([["1 workflow run failed", true, "/admin/problems?view=failed"]]);
  });

  it("gives up to three customers running low a row each, and more one shared row", () => {
    const low = (companyId: string) => ({ id: `al-${companyId}`, kind: "billing.screens_warning", severity: "warning", title: "", body: "", status: "open", companyId, target: null, details: { used: 122, limit: 150 }, createdAt: new Date(now).toISOString() });
    const names = ["a", "b", "c", "d"].map((id) => customer(`co-${id}`, `${id.toUpperCase()} Dental`));
    const three = attentionRows({ customers: names as never, alerts: ["co-a", "co-b", "co-c"].map(low) as never }, now);
    expect(three.map((r) => r.action.href)).toEqual(["/admin/customers?show=low&open=co-a", "/admin/customers?show=low&open=co-b", "/admin/customers?show=low&open=co-c"]);
    const four = attentionRows({ customers: names as never, alerts: ["co-a", "co-b", "co-c", "co-d"].map(low) as never }, now);
    expect(four).toHaveLength(1);
    expect(four[0].text).toBe("4 customers are running low on AI interviews");
    expect(four[0].sub).toBe("A Dental, B Dental, C Dental and 1 more");
    expect(four[0].action.href).toBe("/admin/customers?show=low");
  });

  it("names the month from the 1st in the business calendar's zone, and the reader's own month without one", () => {
    // 03:00 on 1 November in UTC is still 31 October in Los Angeles
    expect(monthStart("America/Los_Angeles", new Date("2026-11-01T03:00:00Z"))).toBe("2026-10-01");
    expect(monthStart("UTC", new Date("2026-11-01T03:00:00Z"))).toBe("2026-11-01");
    expect(monthStart("Not/AZone", new Date(2026, 9, 15))).toBe("2026-10-01");
    expect(monthStart(null, new Date(2026, 0, 15))).toBe("2026-01-01");
  });

  it("ranks the customers who spent most and keeps the platform's own spend in the total only", () => {
    const sum = costSummary([{ companyId: "a", costUsd: 1 }, { companyId: null, costUsd: 2 }, { companyId: "b", costUsd: 3 }, { companyId: "a", costUsd: 1.5 }] as never, new Map([["a", "Avon"]]));
    expect(sum.total).toBe(7.5);
    expect(sum.top).toEqual([{ companyId: "b", name: "A customer no longer listed", usd: 3 }, { companyId: "a", name: "Avon", usd: 2.5 }]);
  });

  it("matches customers by name or address, waiting ones first", () => {
    expect(customerMatches(customers as never, "dental").map((c) => c.id)).toEqual(["co-zeta", "co-cara", "co-avon", "co-bright"]);
    expect(customerMatches(customers as never, "  BRIGHT ").map((c) => c.id)).toEqual(["co-bright"]);
    expect(customerMatches(customers as never, "nobody")).toEqual([]);
    expect(customerLine({ ...customers[0], lastActivityAt: null } as never)).toBe("Core · No activity yet");
  });
});

describe("first sign-in asks for approval, on the Overview", () => {
  // the page draws on today's clock, so the requests are dated from it too: the suite does not depend on the day it runs
  const now = Date.now();
  const asker = (id: string, called: string, days: number, over: Record<string, unknown> = {}) => customer(id, called, { verifiedAt: null, verifiedBy: null, createdAt: new Date(now - days * DAY).toISOString(), locations: [{ city: "Austin", region: "TX", country: "US" }], settings: { website: "https://asker.example" }, accessRequest: { status: "requested", person: { name: "Sam Asker", email: "sam@stranger.test" }, declined: null }, ...over });
  const declined = (id: string, called: string, days: number) => asker(id, called, days, { accessRequest: { status: "declined", person: { name: "Dee Clined", email: "dee@stranger.test" }, declined: { at: new Date(now - DAY).toISOString(), by: "Ada Admin" } } });
  const ordinary = (id: string, called: string, days: number) => customer(id, called, { verifiedAt: null, verifiedBy: null, createdAt: new Date(now - days * DAY).toISOString() });
  const confirmed = customer("co-ok", "Open Dental");

  it("gives each request its own row at the very top, the longest waiting first, naming the company", () => {
    const rows = attentionRows({ customers: [confirmed, ordinary("co-w", "Wren Dental", 9), asker("co-new", "New Dental", 1), asker("co-old", "Old Dental", 4)] as never, alerts: [alertRow("al1", "credential.delete_failed", "critical", "Credential delete failed")] as never }, now);
    expect(rows.map((r) => r.text)).toEqual(["Old Dental is asking for access", "New Dental is asking for access", "1 company waits for the ITS check", "1 alert needs a person: “Credential delete failed”"]);
    expect(rows.slice(0, 2).map((r) => r.urgent)).toEqual([true, true]);
    expect(rows[0].access?.company.id).toBe("co-old");
    // the row's facts: the person's name and email, kind of business, size, city and state, website, how long
    expect(rows[0].sub).toBe("Sam Asker · sam@stranger.test · Dental practice or group · 20-49 employees · Austin, TX · https://asker.example · Waiting 4 days");
    expect(rows[1].sub).toContain("Waiting 1 day");
    expect(rows[0].access?.facts.filter((f) => f.href)).toEqual([{ text: "https://asker.example", href: "https://asker.example/" }]);
  });

  it("leaves out what a request does not have: no name, no place, no website", () => {
    const [row] = attentionRows({ customers: [asker("co-a", "Bare Dental", 0, { locations: [], settings: {}, accessRequest: { status: "requested", person: { name: null, email: "bare@stranger.test" }, declined: null } })] as never }, now);
    expect(row.sub).toBe("bare@stranger.test · Dental practice or group · 20-49 employees · Waiting since today");
  });

  it("shows up to five rows, then one row linking to the rest, and counts each request as one thing", () => {
    const asking = ["A", "B", "C", "D", "E", "F", "G", "H"].map((l, i) => asker(`co-${l}`, `${l} Dental`, 20 - i));
    expect(ACCESS_ROWS_EACH).toBe(5);
    const rows = attentionRows({ customers: asking as never }, now);
    expect(rows.map((r) => r.text)).toEqual(["A Dental is asking for access", "B Dental is asking for access", "C Dental is asking for access", "D Dental is asking for access", "E Dental is asking for access", "3 more companies are asking for access"]);
    expect(rows[5].access).toBeUndefined();
    expect(rows[5].sub).toBe("F Dental, G Dental, H Dental");
    expect(rows[5].action).toEqual({ label: "Open", href: "/admin/customers?show=waiting" });
    expect(attentionCount(rows)).toBe(8);
    const six = attentionRows({ customers: asking.slice(0, 6) as never }, now);
    expect(six[5].text).toBe("1 more company is asking for access");
    expect(attentionCount(six)).toBe(6);
    // five is exactly five rows: no row for a rest that is not there
    expect(attentionRows({ customers: asking.slice(0, 5) as never }, now).map((r) => r.key)).not.toContain("access-more");
    // a flood of requests (the review of 6 November 2026): still five rows, in the order they came, and one line for the rest
    const flood = Array.from({ length: 60 }, (_, i) => asker(`co-f${i}`, `Flood ${i} Dental`, 90 - i));
    const many = attentionRows({ customers: flood as never }, now);
    expect(many.map((r) => r.text)).toEqual([...[0, 1, 2, 3, 4].map((i) => `Flood ${i} Dental is asking for access`), "55 more companies are asking for access"]);
    expect(many[5].sub).toBe("Flood 5 Dental, Flood 6 Dental, Flood 7 Dental and 52 more");
    expect(attentionCount(many)).toBe(60);
  });

  it("leaves requests and declined companies out of the waiting companies' row, and a declined company out of everything", () => {
    const rows = attentionRows({ customers: [asker("co-a", "Asking Dental", 2), declined("co-d", "Declined Dental", 7), ordinary("co-w", "Wren Dental", 3), ordinary("co-x", "Xen Dental", 5)] as never }, now);
    expect(rows.map((r) => r.text)).toEqual(["Asking Dental is asking for access", "2 companies wait for the ITS check"]);
    expect(rows[1].sub).toBe("Xen Dental (5 days), Wren Dental (3 days)");
    expect(rows[1].action.href).toBe("/admin/customers?open=co-x&tab=check");
    // only requests or only declined companies: no row about the ITS check at all, and nothing at all for a declined one
    expect(attentionRows({ customers: [asker("co-a", "Asking Dental", 2)] as never }, now).map((r) => r.key)).toEqual(["access-co-a"]);
    expect(attentionRows({ customers: [declined("co-d", "Declined Dental", 7)] as never }, now)).toEqual([]);
    expect(attentionCount(attentionRows({ customers: [declined("co-d", "Declined Dental", 7)] as never }, now))).toBe(0);
  });

  const withRequests = (rows: unknown[]): Array<[unknown[], unknown]> => NOTHING.map(([key, value]) => (key[1] === "customers" ? [key, rows] : [key, value]));

  it("the stat cells: Waiting counts requests and ordinary waiting alike and never a declined one; Customers leaves both out; Needs attention counts each request", () => {
    const html = render(client(withRequests([customers[0], asker("co-a", "Asking Dental", 2), asker("co-b", "Bay Dental", 1), ordinary("co-w", "Wren Dental", 3), declined("co-d", "Declined Dental", 7)])));
    expect(html).toContain('<span class="stat-cell-label">Waiting for the ITS check</span><span class="stat-cell-value">3</span>');
    expect(html).toContain('<span class="stat-cell-label">Customers</span><span class="stat-cell-value">2</span>');
    expect(html).toContain('<span class="stat-cell-label">Needs attention</span><span class="stat-cell-value">3</span>');
    expect(html).toContain("3 things need you.");
    // past five rows the count still counts the rest
    const many = render(client(withRequests(["A", "B", "C", "D", "E", "F", "G"].map((l, i) => asker(`co-${l}`, `${l} Dental`, 20 - i)))));
    expect(many).toContain('<span class="stat-cell-label">Needs attention</span><span class="stat-cell-value">7</span>');
    expect(many).toContain("7 things need you.");
    expect(many).toContain('<a href="/admin/customers?show=waiting" class="btn secondary sm" aria-label="Open: 2 more companies are asking for access">Open</a>');
  });

  it("the Customers card leaves requests and declined companies out, and says none yet when they are all there is", () => {
    const html = render(client(withRequests([customers[0], asker("co-a", "Asking Dental", 2), declined("co-d", "Declined Dental", 7), ordinary("co-w", "Wren Dental", 3)])));
    const card = html.slice(html.indexOf("<h2>Customers</h2>"), html.indexOf("<h2>Costs this month</h2>"));
    expect(card).toContain("Bright Dental");
    expect(card).toContain("Wren Dental");
    expect(card).not.toContain("Asking Dental");
    expect(card).not.toContain("Declined Dental");
    expect(card).toContain("See all 2 customers");
    expect(render(client(withRequests([customers[0], asker("co-a", "Asking Dental", 2)])))).toContain("See all 1 customer<");
    const onlyAsking = render(client(withRequests([asker("co-a", "Asking Dental", 2), declined("co-d", "Declined Dental", 7)])));
    expect(onlyAsking).toContain("No customers yet.");
    expect(onlyAsking).toContain('<span class="stat-cell-label">Customers</span><span class="stat-cell-value">0</span>');
  });

  it("draws the row: Accept the primary button and Decline a quiet one, the facts in one wrapping line, and no button to open it elsewhere", () => {
    const html = render(client(withRequests([asker("co-a", "Harbor Dental", 2)])));
    const row = html.slice(html.indexOf("<h2>Needs attention</h2>"), html.indexOf("<h2>Customers</h2>"));
    expect(text(row)).toContain("Harbor Dental is asking for access");
    expect(text(row)).toContain("Sam Asker · sam@stranger.test · Dental practice or group · 20-49 employees · Austin, TX · https://asker.example (opens in a new tab) · Waiting 2 days");
    expect(row).toContain('<button type="button" class="btn primary sm" aria-label="Accept Harbor Dental">Accept</button>');
    expect(row).toContain('<button type="button" class="btn quiet sm" aria-label="Decline Harbor Dental">Decline</button>');
    expect(row).not.toContain("Review");
    // the row wraps on a phone, and from a tablet up the buttons take a line of their own rather than crush the facts
    expect(row).toMatch(/<li class="list-row motion-safe:animate-enter flex-wrap"/);
    expect(row).toContain('<span class="list-row-main sm:basis-80">');
    expect(row).toContain('<span class="list-row-end max-w-full">');
  });

  it("makes the website a link only for http and https, with the brief's rel and target; anything else is plain text", () => {
    const rowOf = (website: unknown) => render(client(withRequests([asker("co-a", "Harbor Dental", 2, { settings: { website } })])));
    expect(rowOf("https://asker.example")).toContain('<a href="https://asker.example/" target="_blank" rel="noopener noreferrer nofollow">https://asker.example<span class="sr-only"> (opens in a new tab)</span></a>');
    expect(rowOf("HTTP://Asker.Example/a")).toContain('<a href="http://asker.example/a" target="_blank" rel="noopener noreferrer nofollow">');
    for (const typed of ["javascript:alert(1)", "asker.example", "data:text/html,x", "https://good.example@evil.example"]) {
      const html = rowOf(typed);
      expect(html, typed).not.toContain("noopener noreferrer nofollow");
      expect(html, typed).not.toMatch(/href="(?:javascript|data):/);
      expect(text(html), typed).toContain(`20-49 employees · Austin, TX · ${typed} · Waiting 2 days`);
    }
    // no website: nothing in its place
    expect(text(rowOf(undefined))).toContain("Austin, TX · Waiting 2 days");
  });

  it("shows a company name, a website and a person's name safely, and a very long one breaks anywhere", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const html = render(client(withRequests([asker("co-a", evil, 2, { accessRequest: { status: "requested", person: { name: `<b>${evil}</b>`, email: "x@stranger.test" }, declined: null }, settings: { website: evil } })])));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(text(html)).toContain("&lt;img src=x onerror=alert(1)&gt; is asking for access");
    const long = "L".repeat(120);
    const longRow = render(client(withRequests([asker("co-a", long, 2, { accessRequest: { status: "requested", person: { name: long, email: `${long}@stranger.test` }, declined: null }, settings: { website: `https://${long.toLowerCase()}.example/${long}` } })])));
    // the title is the kit's whole sentence; the facts' one line, and the row's end, cannot hold a word wider than the row
    expect(longRow).toContain(`<span class="list-row-title wrap">${long} is asking for access</span>`);
    expect(longRow).toMatch(new RegExp(`<span class="list-row-meta"><span class="min-w-0 wrap-anywhere">${long}`));
    // the waiting companies' names on their row too
    expect(render(client(withRequests([ordinary("co-w", long, 3)])))).toMatch(new RegExp(`<span class="list-row-meta wrap-anywhere">${long}`));
  });
});

describe("the console's frame", () => {
  it("draws each section under its own title, its parts chosen by ?view=", () => {
    const html = render(client([]), createElement(Console, { section: "system" }));
    // the title stands alone (founder's fewer-words rule, 23 Oct 2026): no eyebrow over it, no line describing the page
    expect(html).not.toContain("ITS · Console");
    expect(html).not.toContain("Costs, workflows, AI runs, the queue");
    expect(html).toContain("<h1>System and settings</h1>");
    // the section draws its own part tabs under the title
    expect(html).toContain('role="tablist"');
    expect(html.indexOf("<h1>System and settings</h1>")).toBeLessThan(html.indexOf('role="tablist"'));
    const customers = render(client([]), createElement(Console, { section: "customers" }));
    expect(customers).toContain("<h1>Customers</h1>");
    expect(customers).not.toContain("Every customer: the ITS check");
    expect(render(client([]), createElement(Console, { section: "privacy" }))).toContain("<h1>Privacy requests</h1>");
    expect(render(client([]), createElement(Console, { section: "problems" }))).toContain("<h1>Problems</h1>");
  });

  it("keeps the address when a part is chosen, dropping only a drawer's ?open= and ?tab=", () => {
    expect(viewSearch("", "outcomes")).toBe("?view=outcomes");
    expect(viewSearch("?view=all&open=co1&tab=plan&q=dental", "outcomes")).toBe("?view=outcomes&q=dental");
  });
});

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
const { Overview, attentionRows, costSummary, customerLine, customerMatches, dueWords, monthStart, waitedWords } = await import("@ros/web/src/pages/admin/Overview");
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
    expect(html).toContain('<p class="eyebrow">ITS · Console</p>');
    expect(html).toMatch(/<h1>Good (morning|afternoon|evening), Ada\.<\/h1>/);
    expect(html).toContain("8 things need you.");
    expect(html).toContain('<a href="/recruiter/queue" class="btn secondary">Open the recruiter queue</a>');
    expect(html).toContain("<h2>Needs attention (8)</h2>");
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
    expect(html).toContain("Nothing needs you right now.");
    expect(html).toContain("Everything below is up to date.");
    expect(html).toContain("<h2>Needs attention (0)</h2>");
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
    expect(html).toContain("<h2>Customers (4)</h2>");
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
    expect(t).toContain("Bright Dental $4.10");
    expect(t).toContain("Avon Dental $2.02");
    expect(t).toContain("Cara Dental $0.88");
    expect(t).not.toContain("Zeta Dental $0.40");
    expect(html).toContain('<a href="/admin/system?view=costs" class="console-more">See all costs</a>');
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

describe("the console's frame", () => {
  it("draws each section under its own title, its parts chosen by ?view=", () => {
    const html = render(client([]), createElement(Console, { section: "system" }));
    expect(html).toContain('<p class="eyebrow">ITS · Console</p>');
    expect(html).toContain("<h1>System and settings</h1>");
    // the section draws its own part tabs under the title
    expect(html).toContain('role="tablist"');
    expect(html.indexOf("<h1>System and settings</h1>")).toBeLessThan(html.indexOf('role="tablist"'));
    expect(render(client([]), createElement(Console, { section: "customers" }))).toContain("<h1>Customers</h1>");
    expect(render(client([]), createElement(Console, { section: "privacy" }))).toContain("<h1>Privacy requests</h1>");
    expect(render(client([]), createElement(Console, { section: "problems" }))).toContain("<h1>Problems</h1>");
  });

  it("keeps the address when a part is chosen, dropping only a drawer's ?open= and ?tab=", () => {
    expect(viewSearch("", "outcomes")).toBe("?view=outcomes");
    expect(viewSearch("?view=all&open=co1&tab=plan&q=dental", "outcomes")).toBe("?view=outcomes&q=dental");
  });
});

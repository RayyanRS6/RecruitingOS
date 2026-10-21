import * as React from "react";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The ITS console's System and settings section (apps/web/src/pages/admin/system.tsx) as the server first draws it from
 * answers shaped like the API's (Wave S6, slice S6-E): workflow runs with status pills and five columns, the run drawer
 * in plain parts, AI runs with five columns, a Sort chip and their own drawer, costs by customer name for this month or
 * all time, Queue health in plain words, the Business calendar and the Administrators unchanged in what they do (their
 * pickers now use the "select" look). Headings kept while loading, figures right-aligned, empty and error states with
 * one way out. Moved here from report-tables.test.ts, demo-fixes-ui.test.ts and tests/web/demo-fixes.test.ts when the
 * console was split into section files (S6-0).
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/system",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Administrators, AiRunDrawer, AiRuns, CalendarAdmin, Costs, costsSinceKey, monthStartIn, Queue, RunDrawer, Runs, RUNS_READ_LIMIT, SystemSection } = await import("@ros/web/src/pages/admin/system");
const { dayKey } = await import("@ros/web/src/pages/candidate-panel/helpers");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const headings = (html: string) => [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
const admin = { user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [], activeCompanyId: null, staffAccess: null, ai: { provider: "fake" } };

function client(data: Array<[unknown[], unknown]> = [], me: unknown = admin) {
  // A query that failed stays failed while the page is drawn (nothing is fetched on the server).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
function failed(qc: QueryClient, queryKey: unknown[]) {
  qc.getQueryCache().build(qc, { queryKey }).setState({ status: "error", error: new Error("The server did not answer."), fetchStatus: "idle" });
  return qc;
}

const customers: [unknown[], unknown] = [["admin", "customers"], [{ id: "co1aaaaaaaa", name: "Bright Dental" }]];
const run = (id: string, status: string, over: Record<string, unknown> = {}) => ({ id, companyId: "co1aaaaaaaa", workflowKey: "application_intake", status, currentStep: "score_reading", wait: null, attempts: 2, lastError: status === "failed" ? "timeout" : null, updatedAt: daysAgo(3), subject: { type: "application", id: "a1aaaaaaaa" }, ...over });
const ai = (id: string, task: string, createdAt: string, costUsd: string, latencyMs: number) => ({ id, companyId: "co1aaaaaaaa", agent: "screening", task, model: "fake-1", promptKey: "screen", promptVersion: 3, status: "ok", inputTokens: 10, outputTokens: 20, costUsd, latencyMs, confidence: "high", createdAt });
const calendarDto = { current: { timeZone: "America/Los_Angeles", hours: {}, holidays: [], closures: [], coverageChanges: [] }, version: null, effectiveFrom: null, description: "Monday to Friday, 9 to 5", upcoming: [], versions: [], preview: [] };

describe("System and settings: the six parts", () => {
  it("draws its six parts as tabs and opens on Costs", () => {
    const html = render(client([customers, [["admin", "calendar"], calendarDto], [costsSinceKey(monthStartIn("America/Los_Angeles")), []]]), createElement(SystemSection, { view: null, onView: () => undefined }));
    for (const label of ["Costs", "Workflows", "AI runs", "Queue health", "Business calendar", "Administrators"]) expect(html).toContain(`data-label="${label}"`);
    expect(html).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Costs/);
  });
});

describe("System and settings: Workflows", () => {
  it("keeps the five headings while the runs load, with quiet rows and the status pills above them", () => {
    const html = render(client(), createElement(Runs));
    expect(html).toMatch(/<section class="table-wrap scroll"/);
    expect(headings(html)).toEqual(["Workflow", "Status", "Step", "Updated", "Actions"]);
    expect(html).toContain('<tbody aria-busy="true">');
    expect(html.match(/<tr aria-hidden="true">/g)).toHaveLength(4);
    expect(html).toContain('<span class="sr-only" role="status">Loading…</span>');
    // the status filter is a row of pills; All is chosen
    expect(html).toContain('<fieldset aria-label="Show runs"');
    expect(html).toContain('<button type="button" class="toggle-chip" aria-pressed="true">All</button>');
    for (const label of ["Running", "Waiting", "Failed", "Done"]) expect(html).toContain(`aria-pressed="false">${label}</button>`);
    expect(html).not.toContain(">Completed<");
  });

  it("says when there are no workflow runs", () => {
    expect(render(client([[["admin", "runs", ""], []]]), createElement(Runs))).toMatch(/<td colspan="5" class="table-empty">No workflow runs yet\.<\/td>/i);
  });

  it("shows each run in plain words with Retry on a failed one, and counts each status", () => {
    const rows = [run("run1", "failed"), run("run2", "completed", { workflowKey: "screen", currentStep: "ask" }), run("run3", "completed", { workflowKey: "brand_new_flow" })];
    const html = render(client([[["admin", "runs", ""], rows]]), createElement(Runs));
    const words = text(html);
    expect(words).toContain("Reading a new application");
    expect(words).toContain("AI interview");
    // an unknown workflow reads as words, never with underscores
    expect(words).toContain("Brand new flow");
    expect(html).not.toContain("brand_new_flow");
    expect(words).toContain("Score reading");
    expect(html).toContain("3 days ago");
    expect(html.match(/>Retry</g)).toHaveLength(1);
    expect(html).toContain('aria-pressed="true">All <span class="count">3</span>');
    expect(html).toContain('aria-pressed="false">Failed <span class="count">1</span>');
    expect(html).toContain('aria-pressed="false">Done <span class="count">2</span>');
    expect(html).toContain('aria-pressed="false">Running <span class="count">0</span>');
    // what left the table lives in the run's drawer
    expect(html).not.toContain("Attempts");
    expect(html).not.toContain("timeout");
    expect(words).not.toContain("of the latest");
  });

  it("says the counts are of the latest 200 when the list is full", () => {
    const rows = Array.from({ length: RUNS_READ_LIMIT }, (_, i) => run(`r${i}`, "completed"));
    expect(text(render(client([[["admin", "runs", ""], rows]]), createElement(Runs)))).toContain("Counts are of the latest 200 runs.");
  });

  it("offers one way back when a status has no runs", () => {
    const html = render(client([[["admin", "runs", ""], [run("run1", "completed")]], [["admin", "runs", "failed"], []]]), createElement(Runs, { initialShow: "failed" }));
    expect(html).toContain('aria-pressed="true">Failed <span class="count">0</span>');
    expect(text(html)).toContain("No runs with this status.");
    expect(text(html)).toContain("Show all runs");
  });

  it("opens a run in plain parts: the facts, what happened, AI calls, who did what, and the raw state folded last", () => {
    const row = run("run1", "failed", { wait: { kind: "timer", until: "2026-10-14T22:10:00.000Z", reason: "retry 2/5" } });
    const detail = {
      run: { ...row, state: { applicationId: "a1aaaaaaaa", secretish: "kept in raw" } },
      steps: [{ seq: 1, stepKey: "read_resume", status: "ok", error: null, output: { kind: "next" }, startedAt: daysAgo(3) }, { seq: 2, stepKey: "score_reading", status: "error", error: "timeout", output: {}, startedAt: daysAgo(3) }],
      aiRuns: [{ id: "ai1", task: "triage.read", model: "fake-1", promptKey: "triage", promptVersion: 4, status: "ok", inputTokens: 100, outputTokens: 20, costUsd: "0.00123", latencyMs: 900, structuredOutput: { fit: "likely" }, error: null }],
      events: [{ type: "workflow.step_completed", occurredAt: daysAgo(3), actor: { kind: "system", id: "engine" }, payload: { step: "read_resume" } }],
    };
    const html = render(client([customers, [["admin", "run", "run1"], detail]]), createElement(RunDrawer, { row, onClose: () => undefined }));
    const words = text(html);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Reading a new application"');
    for (const fact of ["Customer", "Bright Dental", "About", "Application", "Waiting on", "Timer until", "(retry 2/5)", "Attempts", "Error", "timeout"]) expect(words).toContain(fact);
    expect(words).toContain("Retry");
    // the parts, in order, the raw state last and folded
    const at = (s: string) => html.indexOf(s);
    expect(at("What happened")).toBeGreaterThan(0);
    expect(at("What happened")).toBeLessThan(at("AI calls"));
    expect(at("AI calls")).toBeLessThan(at("Who did what"));
    expect(at("Who did what")).toBeLessThan(at("<summary>Raw state</summary>"));
    expect(html).toMatch(/<details class="more"><summary>Raw state<\/summary>/);
    expect(words).toContain("Read resume: done");
    expect(words).toContain("Score reading: failed (timeout)");
    expect(words).toContain("Triage read · fake-1 · OK · less than $0.01");
    expect(words).toContain("$0.00123");
    expect(words).toContain("Workflow step completed");
    // the JSON is kept, folded, not first
    expect(at("kept in raw")).toBeGreaterThan(at("<summary>Raw state</summary>"));
  });
});

describe("System and settings: AI runs", () => {
  it("opens latest first with five columns, When and Cost sortable and a Sort chip that also offers time taken", () => {
    // the older run comes first in the answer
    const html = render(client([[["admin", "ai"], [ai("ai1", "older_task", daysAgo(2), "0.00100", 900), ai("ai2", "newer_task", daysAgo(0), "0.02000", 1500)]]]), createElement(AiRuns));
    expect(headings(html)).toEqual(["When", "Task", "Model", "Status", "Cost"]);
    expect(html).toContain('<th scope="col" aria-sort="descending"><button type="button" class="th-sort">When');
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toContain('<th scope="col" class="num"><button type="button" class="th-sort">Cost');
    // its name is its visible words (WCAG 2.5.3 label in name), as every other Sort chip
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false">Sort: When<svg');
    expect(html).not.toContain('aria-label="Sort AI runs');
    expect(text(html)).toContain("Sort: When");
    expect(html).toContain('<td class="num"><span title="$0.02000">$0.02</span><div class="small muted">1500 ms</div></td>');
    expect(text(html)).toContain("Newer task");
    expect(text(html)).toContain("OK");
    expect(html.indexOf("Newer task")).toBeLessThan(html.indexOf("Older task"));
    expect(html).toMatch(/<section class="table-wrap scroll"/);
    expect(render(client([[["admin", "ai"], []]]), createElement(AiRuns))).toMatch(/<td colspan="5" class="table-empty">No AI runs recorded yet\.<\/td>/i);
  });

  it("keeps the headings while the AI runs load, and says so with a way to try again when they cannot", () => {
    const loading = render(client(), createElement(AiRuns));
    expect(loading).toContain('<tbody aria-busy="true">');
    expect(headings(loading)).toEqual(["When", "Task", "Model", "Status", "Cost"]);
    const broken = render(failed(client(), ["admin", "ai"]), createElement(AiRuns));
    expect(text(broken)).toContain("Could not load AI runs.");
    expect(text(broken)).toContain("Try again");
  });

  it("opens one AI run with its agent, prompt version, tokens, time taken, confidence and result", () => {
    const row = ai("ai2", "screen.turn", daysAgo(0), "0.02000", 1500);
    const detail = { run: { ...row, structuredOutput: { next: "Tell me about a hard day." }, error: null, modelVersion: "2026-09" }, events: [] };
    const html = render(client([customers, [["admin", "ai", "ai2"], detail]]), createElement(AiRunDrawer, { row, onClose: () => undefined }));
    const words = text(html);
    expect(html).toContain('aria-label="Screen turn"');
    for (const fact of ["Bright Dental", "Agent", "Screening", "Prompt", "screen, version 3", "Tokens", "10 in · 20 out", "Cost", "$0.02000", "Time taken", "1500 ms", "Confidence", "High", "Result", "Tell me about a hard day."]) expect(words).toContain(fact);
  });
});

describe("System and settings: Costs", () => {
  const spend = [{ companyId: "co1aaaaaaaa", task: "triage", model: "fake-1", runs: 4, inputTokens: 1000, outputTokens: 200, costUsd: 0.0123 }, { companyId: null, task: "intake.turn", model: "fake-1", runs: 1, inputTokens: 50, outputTokens: 5, costUsd: 0.002 }];

  it("counts this month from the 1st in the business calendar's time zone", () => {
    // 8 PM on 31 October in Los Angeles is already 1 November in UTC
    const evening = new Date("2026-11-01T03:00:00.000Z");
    expect(monthStartIn("America/Los_Angeles", evening)).toBe("2026-10-01");
    expect(monthStartIn("UTC", evening)).toBe("2026-11-01");
    expect(monthStartIn("Not/AZone", new Date(2026, 4, 9))).toBe("2026-05-01");
  });

  it("names the customer, keeps five columns with the figures right-aligned, and puts the tokens under Details", () => {
    const since = monthStartIn("America/Los_Angeles");
    const html = render(client([customers, [["admin", "calendar"], calendarDto], [costsSinceKey(since), spend]]), createElement(Costs));
    expect(html).toContain('aria-pressed="true">This month</button>');
    expect(headings(html).slice(0, 5)).toEqual(["Customer", "Task", "Model", "Runs", "Cost"]);
    expect(html).toContain('<th scope="col" class="num">Cost</th>');
    expect(html).toContain('<td>Bright Dental</td><td>Triage</td><td class="small">fake-1</td><td class="num">4</td><td class="num"><span title="$0.01230">$0.01</span></td>');
    // spend with no customer is ITS's own; nothing shows as an id slice
    expect(text(html)).toContain("ITS platform");
    expect(text(html)).toContain("Intake turn");
    expect(html).not.toContain("co1aaaaa<");
    expect(text(html)).toContain("Spent so far this month: $0.01");
    expect(text(html)).toContain(`Counted from ${since}.`);
    // the tokens: a second table of five, folded
    expect(html).toMatch(/<details class="more"><summary>Details: tokens in and out<\/summary>/);
    expect(html).toContain('<th scope="col" class="num">Tokens in</th>');
    expect(html).toContain('<td class="num">1000</td><td class="num">200</td>');
    expect(html).toMatch(/<section class="table-wrap scroll"/);
  });

  it("keeps the headings when nothing was spent, with one way to see all time", () => {
    const month = render(client([[["admin", "calendar"], calendarDto], [costsSinceKey(monthStartIn("America/Los_Angeles")), []]]), createElement(Costs));
    expect(text(month)).toContain("No model spend recorded this month.");
    expect(text(month)).toContain("Show all time");
    const all = render(client([[["admin", "costs"], []]]), createElement(Costs, { initialPeriod: "all" }));
    expect(all).toContain('aria-pressed="true">All time</button>');
    expect(all).toMatch(/<td colspan="5" class="table-empty">No model spend recorded yet\.<\/td>/i);
    expect(text(all)).toContain("Total model spend recorded: $0.00");
  });

  it("says so with a way to try again when the costs cannot load", () => {
    const html = render(failed(client(), ["admin", "costs"]), createElement(Costs, { initialPeriod: "all" }));
    expect(text(html)).toContain("Could not load costs.");
    expect(text(html)).toContain("Try again");
  });
});

describe("System and settings: Queue health and the Business calendar", () => {
  it("shows an error with a way to try again when the Queue or the Business calendar cannot load", () => {
    const queue = render(failed(client(), ["admin", "queue"]), createElement(Queue));
    expect(text(queue)).toContain("Could not load the queue.");
    expect(text(queue)).toContain("Try again");
    expect(queue).not.toContain('aria-busy="true"');
    const calendar = render(failed(client(), ["admin", "calendar"]), createElement(CalendarAdmin));
    expect(text(calendar)).toContain("Could not load the business calendar.");
    expect(text(calendar)).toContain("Try again");
    expect(calendar).not.toContain('aria-busy="true"');
  });

  it("gives the queue's five facts in plain words, the workflows folded", () => {
    const html = render(client([[["admin", "queue"], { queued: 0, failed: 1, oldestQueuedAt: null, waitingRuns: 2, definitions: ["application_intake", "screen"] }]]), createElement(Queue));
    const words = text(html);
    for (const fact of ["Jobs waiting to run 0", "Oldest waiting job none", "Jobs that failed 1", "Workflow runs waiting 2", "refresh every 5 seconds"]) expect(words).toContain(fact);
    expect(html).toMatch(/<details class="more"><summary>Workflows the system can run \(2\)<\/summary>/);
    expect(words).toContain("Reading a new application");
  });

  it("starts a new calendar version on today's date in the administrator's own calendar, the time zone in a select", () => {
    const html = render(client([[["admin", "calendar"], calendarDto]]), createElement(CalendarAdmin));
    expect(html).toContain(`<input id="cal-eff" class="input" type="date" value="${dayKey(new Date())}"/>`);
    expect(html).toContain('<select id="cal-tz" class="select">');
    expect(text(html)).toContain("Publish version");
  });
});

describe("System and settings: Administrators", () => {
  it("lists the people in five columns with plain role words, and picks a role from a select", () => {
    const grant = { id: "g1", userId: "u1", email: "ben@its.test", name: "Ben", authProvider: "microsoft", role: "platform_admin", source: "console", grantedBy: { id: "s1", name: "Ada Admin" }, grantReason: "Covers the night queue", grantedAt: daysAgo(10), revokedAt: null, revokedBy: null, revokeReason: null };
    const html = render(client([[["admin", "platform-roles"], { grants: [grant], activeAdmins: 1, bootstrap: { configured: 0, ignored: false } }]]), createElement(Administrators));
    expect(headings(html)).toEqual(["Person", "Role", "Granted", "Reason", "Actions"]);
    const words = text(html);
    expect(words).toContain("Platform administrator");
    expect(words).toContain("by Ada Admin");
    expect(words).toContain("Revoke");
    expect(html).not.toContain(">platform admin<");
    expect(html).toContain('<select id="pr-role" class="select">');
  });

  it("signs someone out everywhere by the address they sign in with, with a reason and a confirmation", () => {
    const html = render(client([[["admin", "platform-roles"], { grants: [], activeAdmins: 1, bootstrap: { configured: 0, ignored: false } }]]), createElement(Administrators));
    expect(text(html)).toContain("Sign someone out everywhere");
    expect(html).toContain('id="so-email"');
    expect(html).toContain('id="so-reason"');
    expect(html.slice(html.indexOf('id="so-reason"'))).toMatch(/<button[^>]*disabled/);
    const system = readFileSync(new URL("../../web/src/pages/admin/system.tsx", import.meta.url), "utf8");
    expect(system).toContain('"/api/v1/admin/sessions/revoke", { email: form.email.trim(), reason: form.reason.trim(), confirm: true }, reason)');
    expect(system).toContain("Yes, sign them out");
  });
});

describe("the admin console's retries", () => {
  it("tells the administrator when Retry did not work, and starts the calendar on the local date", () => {
    const system = readFileSync(new URL("../../web/src/pages/admin/system.tsx", import.meta.url), "utf8");
    expect(system).toContain('onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the run. Try again in a moment.")');
    // Retry still puts the run back in the queue through the same endpoint
    expect(system).toContain("api.post(`/api/v1/admin/runs/${id}/retry`, {}, reason)");
    // a retried run leaves Problems › Failed work and Overview too
    expect(system).toContain("qc.invalidateQueries({ queryKey: adminKeys.failures })");
    // the AI runs' Sort menu sets the order it names (choosing the one in force keeps it); a heading press flips it
    expect(system).toContain("if (o) s.choose(o.id, o.label, o.kind);");
    // the business calendar starts on today's date in the administrator's own calendar, never the UTC date
    expect(system).toContain("const todayKey = () => dayKey(new Date());");
    expect(system).not.toContain("toISOString().slice(0, 10)");
    // the AI-run drawer reads the run's own detail
    expect(system).toContain("`/api/v1/admin/ai-runs/${row.id}`");
  });
});

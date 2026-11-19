import * as React from "react";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The admin dashboard's System section (apps/web/src/pages/admin/system.tsx and health.tsx) as the server first draws
 * it from answers shaped like the API's: five parts as tabs. Health (alerts with Acknowledge and Resolve, failed work
 * with Retry, the queue), Costs by company for this month or all time, Email (the addresses nothing is sent to),
 * Security reports and Administrators. Headings kept while loading, figures right-aligned, empty and error states
 * with one way out.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/system",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Administrators, Costs, costsSinceKey, Email, monthStart, Security, SYSTEM_PARTS, SystemSection } = await import("@ros/web/src/pages/admin/system");
const { ACK_FOR_ANOTHER, ackIsForAnother, Health, needsAPerson, NONE, Queue, RESOLVED_TOAST } = await import("@ros/web/src/pages/admin/health");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const headings = (html: string) => [...html.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]).trim());
const admin = { user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, auth: { provider: "azure", aal: "aal2", mfaVerifiedAt: null }, memberships: [], activeCompanyId: null, ai: { provider: "fake" } };

function client(data: Array<[readonly unknown[], unknown]> = []) {
  // A query that failed stays failed while the page is drawn (nothing is fetched on the server).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], admin);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
function failed(qc: QueryClient, queryKey: readonly unknown[]) {
  qc.getQueryCache().build(qc, { queryKey }).setState({ status: "error", error: new Error("The server did not answer."), fetchStatus: "idle" });
  return qc;
}

const companies: [readonly unknown[], unknown] = [["admin", "companies"], [{ id: "co1aaaaaaaa", name: "Bright Dental" }]];
const noFailures = { failedRuns: [], failedJobs: [], failedAi: [], alerts: [] };
const queue = { queued: 0, failed: 1, oldestQueuedAt: null, waitingRuns: 2, definitions: ["application_intake", "screen"] };
const alert = (id: string, kind: string, title: string, over: Record<string, unknown> = {}) => ({ id, kind, severity: "critical", title, body: "Details.", status: "open", companyId: null, target: null, details: {}, createdAt: daysAgo(0), ...over });
const health = (failures: unknown = noFailures) => render(client([[["admin", "failures"], failures], [["admin", "queue"], queue]]), createElement(Health));

describe("System: the five parts", () => {
  it("draws its parts as tabs and opens on Health, also for a part it does not know", () => {
    expect(SYSTEM_PARTS.map((p) => p.label)).toEqual(["Health", "Costs", "Email", "Security reports", "Administrators"]);
    for (const view of [null, "workflows", "calendar"]) {
      const html = render(client([[["admin", "failures"], noFailures], [["admin", "queue"], queue]]), createElement(SystemSection, { view, onView: () => undefined }));
      expect(html).toContain('<div role="tablist" aria-label="System"');
      for (const label of ["Health", "Costs", "Email", "Security reports", "Administrators"]) expect(html).toContain(`data-label="${label}"`);
      expect(html).toMatch(/aria-selected="true"[^>]*>(?:(?!<\/button>).)*Health/);
      expect(text(html)).toContain("Alerts that need a person (0)");
    }
    // nothing of what the old console had besides
    const html = render(client([[["admin", "failures"], noFailures], [["admin", "queue"], queue]]), createElement(SystemSection, { view: null, onView: () => undefined }));
    for (const gone of ["Workflows", "AI runs", "Business calendar", "Queue health"]) expect(html, gone).not.toContain(`data-label="${gone}"`);
  });

  it("draws each part when the address names it", () => {
    const part = (view: string, data: Array<[readonly unknown[], unknown]>) => text(render(client(data), createElement(SystemSection, { view, onView: () => undefined })));
    expect(part("costs", [companies, [costsSinceKey(monthStart()), []]])).toContain("No AI spend recorded this month.");
    expect(part("email", [[["admin", "suppressions"], []]])).toContain("Email addresses we must not send to (0)");
    expect(part("security", [[["admin", "csp"], { mode: "report-only", reports: [] }]])).toContain("Content-security reports (0 not reviewed yet)");
    expect(part("admins", [[["admin", "platform-roles"], { grants: [], activeAdmins: 1, bootstrap: { configured: 0, ignored: false } }]])).toContain("Platform administrators (1)");
  });
});

describe("System, Health: alerts", () => {
  it("counts the alerts that wait for a person, and folds the acknowledged ones and the notices about a company's plan", () => {
    const list = [alert("al1", "worker.stale", "The worker stopped"), alert("al2", "queue.stale", "Queue is slow", { status: "acknowledged" }), alert("al3", "billing.screens_warning", "AI interviews at 80%", { severity: "warning" }), alert("al4", "plan.requested", "Bright Dental asked to upgrade", { severity: "info" })];
    expect(list.map(needsAPerson)).toEqual([true, false, false, false]);
    expect(needsAPerson({ status: "open", kind: "ai.provider_outage" })).toBe(true);
    const html = health({ ...noFailures, alerts: list });
    const words = text(html);
    expect(words).toContain("Alerts that need a person (1)");
    // still listed, every button kept, one click away
    expect(words).toContain("Acknowledged and plan notices (3)");
    expect(html.indexOf("The worker stopped")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Queue is slow"));
    expect(html.slice(html.indexOf("AI interviews at 80%"))).toContain(">Acknowledge</button>");
  });

  it("offers Resolve on every alert, open or acknowledged; Acknowledge only while it is open", () => {
    const html = health({ ...noFailures, alerts: [alert("al3", "worker.stale", "The background worker has stopped polling"), alert("al4", "queue.stale", "Queued work is not being picked up", { status: "acknowledged" })] });
    const open = html.slice(html.indexOf("The background worker has stopped polling"), html.indexOf("Queued work is not being picked up"));
    const seen = html.slice(html.indexOf("Queued work is not being picked up"), html.indexOf("Failed work"));
    expect(open).toContain(">Acknowledge</button>");
    expect(open).toContain(">Resolve</button>");
    expect(seen).not.toContain(">Acknowledge</button>");
    expect(seen).toContain(">Resolve</button>");
    expect(text(seen)).toContain("Acknowledged");
    expect(RESOLVED_TOAST).toEqual({ title: "Resolved.", detail: "If it happens again, a new alert is raised." });
  });

  it("offers no Acknowledge on a platform-role alert about the signed-in administrator, and says who acknowledges it", () => {
    const html = health({ ...noFailures, alerts: [alert("al1", "platform_role.granted", "Platform role granted", { details: { actorId: "s1" } }), alert("al2", "worker.stale", "The worker stopped")] });
    const own = html.slice(html.indexOf("Platform role granted"), html.indexOf("The worker stopped"));
    expect(text(own)).toContain(ACK_FOR_ANOTHER);
    expect(own).not.toContain(">Acknowledge</button>");
    expect(own).not.toContain(">Resolve</button>");
    expect(html.slice(html.indexOf("The worker stopped"))).toContain(">Acknowledge</button>");
    const about = (kind: string, actorId: string | null, targetId: string | null) => ({ kind, details: actorId ? { actorId } : {}, target: targetId ? { type: "user", id: targetId } : null });
    expect(ackIsForAnother(about("platform_role.granted", "s1", "u9"), "s1")).toBe(true);
    expect(ackIsForAnother(about("platform_role.bootstrapped", null, "s1"), "s1")).toBe(true);
    expect(ackIsForAnother(about("platform_role.granted", "s2", "u9"), "s1")).toBe(false);
    // other alerts, and while it is not known who is signed in, keep the button (the server decides)
    expect(ackIsForAnother(about("worker.stale", "s1", "s1"), "s1")).toBe(false);
    expect(ackIsForAnother(about("platform_role.granted", "s1", null), null)).toBe(false);
  });

  it("names each severity in plain words", () => {
    const words = text(health({ ...noFailures, alerts: [alert("al5", "worker.stale", "The worker stopped"), alert("al6", "outbox.slow", "Email is slow", { severity: "warning" }), alert("al7", "note", "Heads up", { severity: "info" })] }));
    expect(words).toContain("Urgent The worker stopped");
    expect(words).toContain("Check soon Email is slow");
    expect(words).toContain("For your information Heads up");
    expect(words).not.toMatch(/\bcritical\b|\bwarning\b/);
    expect(words).toContain("today");
    // nothing about a credential kept after a disconnect: calendars are gone
    expect(words).not.toContain("Retry deletion");
  });
});

describe("System, Health: failed work and the queue", () => {
  it("lists failed runs by their plain name with Retry, background tasks and AI runs that were not OK", () => {
    const failures = {
      ...noFailures,
      failedRuns: [{ id: "r1", companyId: "co1aaaaaaaa", workflowKey: "application_intake", status: "failed", lastError: "model timed out", updatedAt: daysAgo(2), currentStep: "read_resume", attempts: 5, subject: { type: "application", id: "ap1" } }],
      failedJobs: [{ id: 7, kind: "workflow.tick", lastError: "lease lost", attempts: 5, createdAt: daysAgo(1) }],
      failedAi: [{ id: "a1", task: "triage", status: "invalid_output", error: "bad json", createdAt: daysAgo(0), model: "claude-haiku-5-5" }],
    };
    // up to the queue's card, whose folded list names each workflow with its key
    const html = health(failures).split("<h2>Queue</h2>")[0];
    const words = text(html);
    expect(words).toContain("Failed workflow runs (1)");
    expect(words).toContain("Reading a new application");
    expect(words).not.toContain("application_intake");
    expect(words).toContain("Step: read resume · Tried 5 times · model timed out");
    expect(words).toContain("2 days ago");
    expect(html).toContain('aria-label="Retry: Reading a new application"');
    expect(html.match(/>Retry<\/button>/g)).toHaveLength(1);
    expect(words).toContain("Background tasks that failed (1) Workflow.tick");
    expect(words).toContain("Tried 5 times · lease lost");
    expect(words).toContain("AI runs that were not OK (1) Answer not usable Triage");
    // a failed run names no candidate and opens nothing: the run browser is gone
    expect(html).not.toContain("ap1");
  });

  it("says None in each part with nothing in it", () => {
    expect(NONE).toBe("None.");
    const words = text(health());
    expect(words).toContain(`Alerts that need a person (0) ${NONE}`);
    expect(words).toContain(`Failed work (0) ${NONE}`);
  });

  it("gives the queue's figures in plain words, the workflows folded", () => {
    const html = render(client([[["admin", "queue"], queue]]), createElement(Queue));
    const words = text(html);
    for (const fact of ["Jobs waiting to run 0", "Oldest waiting job none", "Jobs that failed 1", "Workflow runs waiting 2", "refresh every 5 seconds"]) expect(words).toContain(fact);
    // each figure stays a dt and its dd, in the kit's stat cells; that they refresh is the mark beside the title
    expect(html).toContain('<dt class="stat-cell-label">Jobs that failed</dt><dd class="stat-cell-value text-critical">1</dd>');
    expect(html).toMatch(/<dl class="stat-strip[^"]*">(?:<div class="stat-cell[^"]*"><dt class="stat-cell-label">[^<]*<\/dt><dd class="stat-cell-value[^"]*">[^<]*<\/dd><\/div>){4}<\/dl>/);
    expect(html).toContain('<span class="icon-label" title="These figures refresh every 5 seconds.">');
    expect(html).toMatch(/<details class="more"><summary>Workflows the system can run \(2\)<\/summary>/);
    expect(words).toContain("Reading a new application");
    expect(words).toContain("AI interview");
  });

  it("says so with a way to try again when the failed work or the queue cannot load", () => {
    const html = render(failed(failed(client(), ["admin", "failures"]), ["admin", "queue"]), createElement(Health));
    expect(text(html)).toContain("Could not load the alerts and the failed work.");
    expect(text(html)).toContain("Could not load the queue.");
    expect(html.match(/>Try again<\/button>/g)).toHaveLength(2);
  });

  it("tells the administrator when a press did not work, and a retry reads the failed work again", () => {
    const source = readFileSync(new URL("../../web/src/pages/admin/health.tsx", import.meta.url), "utf8");
    expect(source).toContain('errorWords(e, "Could not acknowledge the alert. Try again in a moment.")');
    expect(source).toContain('errorWords(e, "Could not retry the run. Try again in a moment.")');
    // Retry puts the run back in the queue through the same endpoint
    expect(source).toContain("api.post(`/api/v1/admin/runs/${id}/retry`, {}, reason)");
    expect(source).toContain("qc.invalidateQueries({ queryKey: adminKeys.failures })");
  });
});

describe("System: Costs", () => {
  const spend = [{ companyId: "co1aaaaaaaa", task: "triage", model: "fake-1", runs: 4, inputTokens: 1000, outputTokens: 200, costUsd: 0.0123 }, { companyId: null, task: "intake.turn", model: "fake-1", runs: 1, inputTokens: 50, outputTokens: 5, costUsd: 0.002 }];

  it("counts this month from the 1st on the reader's own calendar", () => {
    expect(monthStart(new Date(2026, 10, 18, 9, 0))).toBe("2026-11-01");
    expect(monthStart(new Date(2026, 0, 1, 0, 30))).toBe("2026-01-01");
  });

  it("names the company, keeps five columns with the figures right-aligned, and puts the tokens under Details", () => {
    const html = render(client([companies, [costsSinceKey(monthStart()), spend]]), createElement(Costs));
    expect(html).toContain('aria-pressed="true">This month</button>');
    expect(headings(html).slice(0, 5)).toEqual(["Company", "Task", "Model", "Runs", "Cost"]);
    expect(html).toContain('<th scope="col" class="num">Cost</th>');
    expect(html).toContain('<td>Bright Dental</td><td>Triage</td><td class="small">fake-1</td><td class="num">4</td><td class="num"><span title="$0.01230">$0.01</span></td>');
    // spend with no company is the platform's own; nothing shows as an id
    expect(text(html)).toContain("The platform itself");
    expect(text(html)).toContain("Intake turn");
    expect(html).not.toContain("co1aaaaa<");
    expect(text(html)).toContain("Spent so far this month: $0.01");
    expect(html).toContain('title="$0.0143 at list prices"');
    // the tokens: a second table of five, folded
    expect(html).toMatch(/<details class="more"><summary>Details: tokens in and out<\/summary>/);
    expect(html).toContain('<th scope="col" class="num">Tokens in</th>');
    expect(html).toContain('<td class="num">1000</td><td class="num">200</td>');
    expect(html).toMatch(/<section class="table-wrap scroll"/);
  });

  it("keeps the headings when nothing was spent, with one way to see all time", () => {
    const month = render(client([companies, [costsSinceKey(monthStart()), []]]), createElement(Costs));
    expect(text(month)).toContain("No AI spend recorded this month.");
    expect(text(month)).toContain("Show all time");
    const all = render(client([companies, [["admin", "costs"], []]]), createElement(Costs, { initialPeriod: "all" }));
    expect(all).toContain('aria-pressed="true">All time</button>');
    expect(all).toMatch(/<td colspan="5" class="table-empty">No AI spend recorded yet\.<\/td>/i);
    expect(text(all)).toContain("Total AI spend recorded: $0.00");
  });

  it("says so with a way to try again when the costs cannot load", () => {
    const html = render(failed(client([companies]), ["admin", "costs"]), createElement(Costs, { initialPeriod: "all" }));
    expect(text(html)).toContain("Could not load costs.");
    expect(text(html)).toContain("Try again");
  });
});

describe("System: Email", () => {
  const suppression = (id: string, address: string, reason: string, count = 2) => ({ id, address, reason, source: "postmark", active: true, count, firstAt: daysAgo(3), lastAt: daysAgo(1), details: {}, releasedAt: null, releaseReason: null });
  const email = (rows: unknown[]) => render(client([[["admin", "suppressions"], rows]]), createElement(Email));

  it("right-aligns how many times an address bounced, in five columns, with the source under the address", () => {
    const html = email([suppression("sp1", "old@example.com", "hard_bounce")]);
    expect(html).toContain('<th scope="col" class="num">Times</th>');
    expect(html).toContain('<td class="num">2</td>');
    expect(html.match(/<th /g)).toHaveLength(5);
    expect(text(html)).toContain("old@example.com Reported by the email provider");
    expect(text(html)).not.toContain("postmark");
    expect(text(html)).toContain("Bounced");
  });

  it("never offers Release on a spam complaint, and keeps the reason box above the list", () => {
    const html = email([suppression("sp1", "ok@example.com", "hard_bounce"), suppression("sp2", "angry@example.com", "spam_complaint", 1)]);
    const spam = html.slice(html.indexOf("angry@example.com"));
    const bounce = html.slice(html.indexOf("ok@example.com"), html.indexOf("angry@example.com"));
    expect(bounce).toContain('aria-label="Release ok@example.com"');
    expect(spam).not.toContain("Release angry@example.com");
    expect(text(spam)).toContain("Never released");
    expect(text(html)).toContain("A spam complaint is never released from here: the person asked not to be emailed.");
    // the release rule (confirm by another channel, never by emailing the address) is the reason field's own label
    const label = html.indexOf("How you confirmed the address by another channel (required to release; the release is recorded with your reason)");
    expect(label).toBeGreaterThan(-1);
    expect(label).toBeLessThan(html.indexOf("<table"));
  });

  it("offers 'Stop emails to an address' under the list, even when the list is empty, asking for the address and why", () => {
    const html = email([]);
    expect(text(html)).toContain(`Email addresses we must not send to (0) ${NONE}`);
    expect(text(html)).toContain("For someone who asked, by phone or in person, not to be emailed.");
    expect(html).toContain('id="sup-address"');
    expect(html).toContain('id="sup-reason"');
    // nothing typed yet: the button waits
    expect(html.slice(html.indexOf('id="sup-reason"'))).toMatch(/<button[^>]*disabled/);
    // only the addresses nothing is sent to: applications by email are gone
    expect(text(html)).not.toContain("could not be imported");
  });
});

describe("System: Security reports", () => {
  it("shows the policy mode, the unreviewed count, the explanation folded under the mode, Mark reviewed and a report that came back", () => {
    const report = { id: "c1", mode: "report-only", surface: "candidate", documentPath: "/jobs/x", violatedDirective: "style-src", effectiveDirective: null, blockedOrigin: "https://cdn.example", sourceFile: null, lineNumber: null, userAgent: null, count: 3, firstAt: daysAgo(2), lastAt: daysAgo(0), reviewedAt: null, reviewedBy: null, disposition: "expected in dev" };
    const html = render(client([[["admin", "csp"], { mode: "report-only", reports: [report] }]]), createElement(Security));
    const words = text(html);
    expect(words).toContain("Content-security reports (1 not reviewed yet)");
    expect(words).toContain("Policy: Report only: browsers tell us, nothing is blocked yet");
    expect(words).toContain("/jobs/x · blocked https://cdn.example · 3 times");
    expect(words).toContain("Recurred since it was reviewed (\"expected in dev\"); review again.");
    expect(words).toContain("Candidate pages style-src");
    // the explanation is one click away: the policy's mode is the summary of its disclosure
    expect(html).toMatch(/<details class="more[^"]*"><summary>(?:(?!<\/summary>).)*Policy: Report only(?:(?!<\/details>).)*Browsers report what the policy would block/);
    expect(html).toContain('aria-label="What this report means: style-src on /jobs/x"');
    expect(html).toContain('aria-label="Mark reviewed: style-src on /jobs/x"');
  });
});

describe("System: Administrators", () => {
  it("lists the people in five columns with plain role words, and adds an administrator by email with a reason", () => {
    const grant = { id: "g1", userId: "u1", email: "ben@its.test", name: "Ben", authProvider: "microsoft", role: "platform_admin", source: "console", grantedBy: { kind: "user", id: "s1", name: "Ada Admin" }, grantReason: "Covers the night shift", grantedAt: daysAgo(10), revokedAt: null, revokedBy: null, revokeReason: null };
    const html = render(client([[["admin", "platform-roles"], { grants: [grant], activeAdmins: 1, bootstrap: { configured: 0, ignored: false } }]]), createElement(Administrators));
    expect(headings(html)).toEqual(["Person", "Role", "Granted", "Reason", "Actions"]);
    const words = text(html);
    expect(words).toContain("Platform administrators (1)");
    expect(words).toContain("Platform administrator");
    expect(words).toContain("by Ada Admin");
    expect(html).toContain('aria-label="Revoke Ben">Revoke</button>');
    expect(html).not.toContain(">platform admin<");
    expect(words).toContain("Add a platform administrator");
    expect(html).toContain('<input id="pr-email" class="input" value=""/>');
    // who is told of a grant is the eye beside the title (its words its name and tooltip), not a paragraph
    expect(html).toContain('<span class="icon-label" title="Every other administrator is told, and another administrator must acknowledge the alert.">');
    // only an administrator can be granted: no recruiter role is offered or named
    expect(words).not.toContain("recruiter");
  });

  it("signs someone out everywhere by the address they sign in with, with a reason and a confirmation", () => {
    const html = render(client([[["admin", "platform-roles"], { grants: [], activeAdmins: 1, bootstrap: { configured: 0, ignored: false } }]]), createElement(Administrators));
    expect(text(html)).toContain("Sign someone out everywhere");
    expect(text(html)).toContain("For a lost second-factor device, reset it in the identity service first.");
    expect(html).toContain('id="so-email"');
    expect(html).toContain('id="so-reason"');
    expect(html.slice(html.indexOf('id="so-reason"'))).toMatch(/<button[^>]*disabled/);
    const system = readFileSync(new URL("../../web/src/pages/admin/system.tsx", import.meta.url), "utf8");
    expect(system).toContain('"/api/v1/admin/sessions/revoke", { email: form.email.trim(), reason: form.reason.trim(), confirm: true } satisfies RevokeSessions, reason)');
    expect(system).toContain("Yes, sign them out");
  });
});

describe("the dashboard calls only what the API keeps", () => {
  it("names no endpoint of the old console", () => {
    const dir = new URL("../../web/src/pages/admin/", import.meta.url);
    const source = ["access.tsx", "companies.tsx", "company.tsx", "Dashboard.tsx", "health.tsx", "plan.tsx", "privacy.tsx", "system.tsx"].map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
    for (const gone of ["/admin/alerts`", "/admin/alerts\"", "/admin/calendar", "/admin/ai-runs", "/admin/runs\"", "/admin/outcomes", "/admin/failed-email-applications", "/retry-deletion", "/verification", "/candidate-score", "/apply-flow", "/report", "/escalations"]) expect(source, gone).not.toContain(gone);
  });
});

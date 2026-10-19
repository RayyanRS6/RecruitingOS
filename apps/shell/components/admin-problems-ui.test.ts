import * as React from "react";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The ITS console's Problems section (apps/web/src/pages/admin/problems.tsx, redesign spec 3.2, Wave S6 S6-D) as the
 * server first draws it from answers shaped like the API's: four parts (Alerts, Failed work, Email, Security reports)
 * with their counts; an alert about one's own platform role left to another administrator; Resolve on every alert;
 * plain severity words; the bounce count right-aligned in a five-column table; spam complaints never released; each
 * part's empty sentence; and Acknowledge and Retry deletion saying when they did not work. The failed email
 * applications are in failed-email-ui.test.ts.
 */
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/problems",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { ACK_FOR_ANOTHER, needsAPerson, PROBLEMS_EMPTY, PROBLEMS_PARTS, problemCounts, ProblemsSection, RESOLVED_TOAST } = await import("@ros/web/src/pages/admin/problems");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const admin = { user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [], activeCompanyId: null, staffAccess: null, ai: { provider: "fake" } };
const noFailures = { failedRuns: [], failedJobs: [], failedAi: [], alerts: [], pendingDeletions: [] };
const noCsp = { mode: "report-only", reports: [] };

type Answers = { failures?: unknown; suppressions?: unknown; csp?: unknown; failedEmail?: unknown };
function client(a: Answers = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], admin);
  qc.setQueryData(["admin", "failures"], a.failures ?? noFailures);
  qc.setQueryData(["admin", "suppressions"], a.suppressions ?? []);
  qc.setQueryData(["admin", "csp"], a.csp ?? noCsp);
  qc.setQueryData(["admin", "failed-email-applications"], a.failedEmail ?? []);
  return qc;
}
const section = (view: string | null, a: Answers = {}) => renderToStaticMarkup(createElement(QueryClientProvider, { client: client(a) }, createElement(ProblemsSection, { view, onView: () => undefined })));

const alert = (id: string, kind: string, title: string, details: Record<string, unknown> = {}) => ({ id, kind, severity: "critical", title, body: "Details.", status: "open", companyId: null, target: null, details, createdAt: daysAgo(0) });
const suppression = (id: string, address: string, reason: string, count = 2) => ({ id, address, reason, source: "postmark", active: true, count, firstAt: daysAgo(3), lastAt: daysAgo(1), details: {} });

describe("the Problems section's parts", () => {
  it("draws four part tabs with their counts, and opens on Alerts when the address names no part", () => {
    const failures = { ...noFailures, alerts: [alert("al1", "worker.stale", "The worker stopped")], failedRuns: [{ id: "r1", workflowKey: "screen", lastError: "boom", updatedAt: daysAgo(0) }], failedJobs: [{ id: 7, kind: "workflow.tick", lastError: "timeout" }] };
    const csp = { mode: "report-only", reports: [{ id: "c1", mode: "report-only", surface: "candidate", documentPath: "/apply", violatedDirective: "script-src", blockedOrigin: null, sourceFile: null, count: 1, lastAt: daysAgo(0), reviewedAt: null, disposition: null }] };
    const html = section(null, { failures, csp, suppressions: [suppression("sp1", "a@example.com", "hard_bounce")] });
    const words = text(html);
    expect(PROBLEMS_PARTS.map((p) => p.label)).toEqual(["Alerts", "Failed work", "Email", "Security reports"]);
    expect(html).toContain('aria-label="Problems"');
    expect(words).toContain("Alerts 1");
    expect(words).toContain("Failed work 2");
    expect(words).toContain("Email 1");
    expect(words).toContain("Security reports 1");
    // the chosen part is Alerts, and only its body is drawn
    expect(html).toMatch(/aria-selected="true"[^>]*>.*?Alerts/);
    expect(words).toContain("Alerts that need a person (1)");
    expect(words).not.toContain("Failed workflow runs");
    expect(text(section("nonsense", { failures }))).toContain("Alerts that need a person (1)");
  });

  it("counts what each part lists; security counts the reports nobody has reviewed", () => {
    expect(problemCounts({})).toEqual({ alerts: undefined, failed: undefined, email: undefined, security: undefined });
    const counts = problemCounts({
      failures: { ...noFailures, failedAi: [{ id: "a1", task: "triage", status: "error", error: null, createdAt: daysAgo(0) }], pendingDeletions: [{ id: "i1", provider: "google", kind: "calendar", status: "pending", lastError: null, disconnectedAt: null }] },
      suppressions: [],
      failedEmail: [],
      csp: { mode: "enforce", reports: [{ id: "c1", mode: "enforce", surface: "app", documentPath: "/", violatedDirective: "img-src", blockedOrigin: null, sourceFile: null, count: 1, lastAt: daysAgo(0), reviewedAt: daysAgo(0), disposition: "expected" }] },
    });
    expect(counts).toEqual({ alerts: 0, failed: 2, email: 0, security: 0 });
  });

  it("says the same empty sentence in every part with nothing in it", () => {
    expect(PROBLEMS_EMPTY).toBe("None. When something goes wrong, it shows here and on the Overview.");
    for (const view of ["alerts", "failed", "email", "security"]) expect(text(section(view))).toContain(PROBLEMS_EMPTY);
  });

  it("draws each part's own heading when it is chosen", () => {
    expect(text(section("alerts"))).toContain("Alerts that need a person (0)");
    expect(text(section("failed"))).toContain("Failed work (0)");
    expect(text(section("email"))).toContain("Email addresses we must not send to (0)");
    expect(text(section("security"))).toContain("Content-security reports (0 not reviewed yet)");
  });

  it("counts the alerts that wait for a person, as Overview does, and folds the acknowledged ones and screening-chat notices", () => {
    const list = [alert("al1", "worker.stale", "The worker stopped"), { ...alert("al2", "queue.stale", "Queue is slow"), status: "acknowledged" }, { ...alert("al3", "billing.screens_warning", "Screening chats at 80%"), severity: "warning" }];
    expect(problemCounts({ failures: { ...noFailures, alerts: list } as never }).alerts).toBe(1);
    expect(needsAPerson(list[0])).toBe(true);
    expect(needsAPerson(list[1])).toBe(false);
    expect(needsAPerson(list[2])).toBe(false);
    const html = section("alerts", { failures: { ...noFailures, alerts: list } });
    const words = text(html);
    expect(words).toContain("Alerts 1");
    expect(words).toContain("Alerts that need a person (1)");
    // still listed, every button kept, one click away
    expect(words).toContain("Acknowledged and screening-chat notices (2)");
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Queue is slow"));
    expect(html.indexOf("The worker stopped")).toBeLessThan(html.indexOf("<details"));
    expect(html.slice(html.indexOf("Screening chats at 80%"))).toContain(">Acknowledge</button>");
  });
});

describe("the admin console's alerts", () => {
  const alerts = (list: unknown[]) => section("alerts", { failures: { ...noFailures, alerts: list } });

  it("offers no Acknowledge on a platform-role alert about the signed-in administrator, and says who acknowledges it", () => {
    const html = alerts([alert("al1", "platform_role.granted", "Platform role granted", { actorId: "s1" }), alert("al2", "secret.delete_failed", "A credential could not be deleted")]);
    const own = html.slice(html.indexOf("Platform role granted"), html.indexOf("A credential could not be deleted"));
    expect(text(own)).toContain(ACK_FOR_ANOTHER);
    expect(own).not.toContain(">Acknowledge</button>");
    // another alert keeps its button
    expect(html.slice(html.indexOf("A credential could not be deleted"))).toContain("Acknowledge");
    // nor a Resolve on one's own platform-role alert
    expect(own).not.toContain(">Resolve</button>");
  });

  it("offers Resolve on every alert, open or acknowledged; Acknowledge only while it is open (Wave S2 F1)", () => {
    const html = alerts([alert("al3", "worker.stale", "The background worker has stopped polling"), { ...alert("al4", "queue.stale", "Queued work is not being picked up"), status: "acknowledged" }]);
    const open = html.slice(html.indexOf("The background worker has stopped polling"), html.indexOf("Queued work is not being picked up"));
    const seen = html.slice(html.indexOf("Queued work is not being picked up"));
    expect(open).toContain(">Acknowledge</button>");
    expect(open).toContain(">Resolve</button>");
    expect(seen).not.toContain(">Acknowledge</button>");
    expect(seen).toContain(">Resolve</button>");
    expect(text(seen)).toContain("Acknowledged");
    expect(RESOLVED_TOAST).toEqual({ title: "Resolved.", detail: "If it happens again, a new alert is raised." });
  });

  it("names each severity in plain words and offers Retry deletion on a credential that could not be deleted", () => {
    const words = text(alerts([{ ...alert("al5", "secret.delete_failed", "Credential delete failed"), target: { type: "integration", id: "i1" } }, { ...alert("al6", "allowance.warning", "Screening chats at 80%"), severity: "warning" }, { ...alert("al7", "note", "Heads up"), severity: "info" }]));
    expect(words).toContain("Urgent Credential delete failed");
    expect(words).toContain("Check soon Screening chats at 80%");
    expect(words).toContain("For your information Heads up");
    expect(words).not.toMatch(/\bcritical\b|\bwarning\b/);
    expect(words).toContain("Retry deletion");
    expect(words).toContain("today");
  });

  it("tells the administrator when Acknowledge or Retry deletion did not work", () => {
    const problems = readFileSync(new URL("../../web/src/pages/admin/problems.tsx", import.meta.url), "utf8");
    expect(problems).toContain('onError: (e) => toast(e instanceof ApiError ? e.message : "Could not acknowledge the alert. Try again in a moment.")');
    expect(problems).toContain('onError: (e) => toast(e instanceof ApiError ? e.message : "Could not retry the deletion. Try again in a moment.")');
    expect(problems).not.toContain('toast("Credential deleted.")');
  });
});

describe("failed work", () => {
  it("lists failed runs by their plain name with Retry, background tasks, AI runs that were not OK and credentials left behind", () => {
    const failures = {
      ...noFailures,
      failedRuns: [{ id: "r1", workflowKey: "application_intake", lastError: "model timed out", updatedAt: daysAgo(2), currentStep: "read_resume", attempts: 5, subject: { type: "application", id: "ap1" } }],
      failedJobs: [{ id: 7, kind: "workflow.tick", lastError: "lease lost", attempts: 5, createdAt: daysAgo(1) }],
      failedAi: [{ id: "a1", task: "triage", status: "invalid_output", error: "bad json", createdAt: daysAgo(0), model: "claude-haiku-5-5" }],
      pendingDeletions: [{ id: "i1", provider: "google", kind: "calendar", status: "pending", lastError: "vault offline", disconnectedAt: daysAgo(3) }],
    };
    const html = section("failed", { failures });
    const words = text(html);
    expect(words).toContain("Failed workflow runs (1)");
    expect(words).toContain("Reading a new application");
    expect(words).not.toContain("application_intake");
    expect(words).toContain("Step: read resume · model timed out");
    expect(words).toContain("2 days ago");
    expect(words).toContain("Background tasks that failed (1) Workflow.tick");
    expect(words).toContain("Tried 5 times · lease lost");
    // the same words as System › AI runs
    expect(words).toContain("AI runs that were not OK (1) Answer not usable Triage");
    expect(words).toContain("Credentials still in the store after disconnect (1) Google calendar");
    expect(html.match(/>Retry<\/button>/g)?.length).toBe(2);
    // rows, not tables
    expect(html).not.toContain("<table");
  });
});

describe("email that could not go", () => {
  it("right-aligns how many times an address bounced, in five columns, with the source under the address", () => {
    const html = section("email", { suppressions: [suppression("sp1", "old@example.com", "hard_bounce")] });
    expect(html).toContain('<th scope="col" class="num">Times</th>');
    expect(html).toContain('<td class="num">2</td>');
    expect(html.match(/<th /g)?.length).toBe(5);
    expect(text(html)).toContain("old@example.com Reported by the email provider");
    expect(text(html)).not.toContain("postmark");
    expect(text(html)).toContain("Bounced");
  });

  it("never offers Release on a spam complaint, and keeps the reason box above the list", () => {
    const html = section("email", { suppressions: [suppression("sp1", "ok@example.com", "hard_bounce"), suppression("sp2", "angry@example.com", "spam_complaint", 1)] });
    const spam = html.slice(html.indexOf("angry@example.com"));
    const bounce = html.slice(html.indexOf("ok@example.com"), html.indexOf("angry@example.com"));
    expect(bounce).toContain('aria-label="Release ok@example.com"');
    expect(spam).not.toContain("Release angry@example.com");
    expect(text(spam)).toContain("Spam complaint");
    expect(text(spam)).toContain("Never released");
    expect(text(html)).toContain("A spam complaint is never released from here: the person asked not to be emailed.");
    expect(html.indexOf("How you confirmed the address (required to release)")).toBeLessThan(html.indexOf("<table"));
  });

  it("offers 'Stop emails to an address' under the list, even when the list is empty, asking for the address and why", () => {
    const html = section("email", { suppressions: [] });
    expect(text(html)).toContain("Stop emails to an address");
    expect(text(html)).toContain("For someone who asked, by phone or in person, not to be emailed.");
    expect(html).toContain('id="sup-address"');
    expect(html).toContain('id="sup-reason"');
    // nothing typed yet: the button waits
    expect(html.slice(html.indexOf('id="sup-reason"'))).toMatch(/<button[^>]*disabled/);
    const problems = readFileSync(new URL("../../web/src/pages/admin/problems.tsx", import.meta.url), "utf8");
    expect(problems).toContain('api.post("/api/v1/admin/email-suppressions", { address: form.address.trim(), reason: form.reason.trim() }, reason)');
  });
});

describe("security reports", () => {
  it("shows the policy mode, the unreviewed count, the explanation, Mark reviewed and a report that came back", () => {
    const report = { id: "c1", mode: "report-only", surface: "candidate", documentPath: "/jobs/x", violatedDirective: "style-src", blockedOrigin: "https://cdn.example", sourceFile: null, count: 3, lastAt: daysAgo(0), reviewedAt: null, disposition: "expected in dev" };
    const words = text(section("security", { csp: { mode: "report-only", reports: [report] } }));
    expect(words).toContain("Content-security reports (1 not reviewed yet)");
    expect(words).toContain("Policy: Report only: browsers tell us, nothing is blocked yet");
    expect(words).toContain("Browsers report what the policy would block. Review every unexplained report before enforcement is switched on (docs/readiness/18). Paths and origins only; never candidate data.");
    expect(words).toContain("/jobs/x · blocked https://cdn.example · 3 times");
    expect(words).toContain("Recurred since it was reviewed (\"expected in dev\"); review again.");
    expect(words).toContain("Mark reviewed");
    // where it came from in words, and each note and button names the report it is for
    expect(words).toContain("Candidate pages style-src");
    const html = section("security", { csp: { mode: "report-only", reports: [report] } });
    expect(html).toContain('aria-label="What this report means: style-src on /jobs/x"');
    expect(html).toContain('aria-label="Mark reviewed: style-src on /jobs/x"');
  });
});

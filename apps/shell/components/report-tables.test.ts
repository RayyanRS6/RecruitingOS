import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * The tables on the signed-in pages after the clean-table work (the Obsidian-look decisions of 10 October 2026, Q3),
 * as the server first draws them from answers shaped like the API's: figures right-aligned under right-aligned
 * headings; headings that sort on the admin console, the Setup audit history and Interviews, and nowhere on the Report;
 * the companies waiting for the ITS check kept on top whatever the order (founder decision B7); headings kept while
 * rows load or when there are none; the first column pinned on wide tables; and the Report's figure tiles and day bars.
 */
const nav = vi.hoisted(() => ({ search: "", params: { id: "r1" } as Record<string, string> }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/roles/r1/report",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { MustHavesCard, ReportFigures, ScreeningCard } = await import("@ros/web/src/pages/RoleReport");
const { CustomerReportSheet } = await import("@ros/web/src/pages/AdminCustomerReport");
const { BoardSnapshotCard } = await import("@ros/web/src/pages/board/BoardSnapshot");
const { CompareTable } = await import("@ros/web/src/pages/compare/ComparePanel");
const { Admin, AiRuns, Costs, CUSTOMER_SORT, customerAnnouncement, customerOrder, Failures, Outcomes, PrivacyRequests, Runs, waitingCustomers } = await import("@ros/web/src/pages/Admin");
const { sortRows } = await import("@ros/ui");
const { Interviews } = await import("@ros/web/src/pages/Interviews");
const { Setup } = await import("@ros/web/src/pages/Setup");
const { PostingTab } = await import("@ros/web/src/pages/RolePosting");

const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
/** The markup from one table's opening tag on, so a name said earlier on the page (an alert, a heading) does not count. */
const from = (html: string, start: string | RegExp) => {
  const at = typeof start === "string" ? html.indexOf(start) : html.search(start);
  expect(at).toBeGreaterThan(-1);
  return html.slice(at);
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

describe("the Report under a recruiter grant for one candidate (Wave S5)", () => {
  const recruiter = { ...owner, user: { ...owner.user, id: "s2", email: "rae@its.test", name: "Rae Recruiter", platformRole: "its_recruiter" }, memberships: [], staffAccess: { grantId: "g1", kind: "escalation", purpose: "One candidate", expiresAt: "2026-10-20T00:00:00Z", companyName: "Bright Dental", scope: { escalationId: "e1", roleId: "r1", applicationId: "a1" } } };

  it("says plainly that the figures count that one candidate, instead of nothing", async () => {
    const { ReportTab, ONE_CANDIDATE_REPORT } = await import("@ros/web/src/pages/RoleReport");
    const qc = client([[["role", "r1", "report"], report], [["role", "r1", "screening"], { offered: 0, started: 0, finished: 0, unfinished: 0, stillApplying: 0, medianMinutes: null, personChosen: { contactMe: 0, sendWithout: 0 }, skipped: [] }]], recruiter);
    const html = render(qc, createElement(ReportTab, { roleId: "r1" }));
    expect(html.replace(/&#x27;/g, "'")).toContain(ONE_CANDIDATE_REPORT);
    // the team's own view has no such line
    const own = render(client([[["role", "r1", "report"], report], [["role", "r1", "screening"], { offered: 0, started: 0, finished: 0, unfinished: 0, stillApplying: 0, medianMinutes: null, personChosen: { contactMe: 0, sendWithout: 0 }, skipped: [] }]]), createElement(ReportTab, { roleId: "r1" }));
    expect(own).not.toContain("Your recruiter access covers one candidate");
  });

  it("explains the screening chat's refusal (403 staff_scope) in words, never 'Could not load' with a retry", async () => {
    const { ApiError } = await import("@ros/web/src/api/client");
    const { ScreeningCard: Card, ONE_CANDIDATE_SCREENING, isOneCandidateLimit } = await import("@ros/web/src/pages/RoleReport");
    const refusal = new ApiError(403, "staff_scope", "Your access covers one candidate, so you can't see how the screening chat goes for the role's whole group.");
    expect(isOneCandidateLimit(refusal)).toBe(true);
    expect(isOneCandidateLimit(new ApiError(500, "internal", "Something went wrong."))).toBe(false);
    expect(isOneCandidateLimit(new Error("network"))).toBe(false);
    // the refusal as the page holds it once the request was answered (no new request while the server draws the page)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
    qc.setQueryData(["me"], recruiter);
    qc.getQueryCache().build(qc, { queryKey: ["role", "r1", "screening"] }).setState({ status: "error", error: refusal, fetchStatus: "idle", errorUpdatedAt: Date.now(), errorUpdateCount: 1, fetchFailureCount: 1 });
    const html = render(qc, createElement(Card, { roleId: "r1" })).replace(/&#x27;/g, "'");
    expect(html).toContain(ONE_CANDIDATE_SCREENING);
    expect(html).not.toContain("Could not load");
  });
});

describe("the Report: figures right-aligned, figure tiles and day bars, and nothing that sorts", () => {
  it("right-aligns the must-have counts under right-aligned headings", () => {
    const mustHaves = {
      people: 6, showEveryMustHave: 1,
      byMustHave: [{ key: "mh_1", label: "Active CA RDH license", shown: 5, partly: 0, notShown: 1, unknown: 0, total: 6 }, { key: "mh_2", label: "Periodontal charting", shown: 1, partly: 1, notShown: 0, unknown: 2, total: 4 }],
      stricter: null,
    };
    const html = render(client(), createElement(MustHavesCard, { mustHaves, links: true }));
    expect(html).toContain('<th scope="col" class="num">Shown</th>');
    expect(html).toContain('<th scope="col">Must-have</th>');
    expect(html).toContain('<th scope="col" class="num">People read against it</th>');
    expect(html).toMatch(/<td>Active CA RDH license<\/td><td class="num">5<\/td><td class="num">0<\/td><td class="num">1<\/td><td class="num">0<\/td><td class="num">6<\/td>/);
  });

  it("draws the screening conversation's figures as tiles in a stat row, and the skipped-question count as a figure", () => {
    const qc = client([[["role", "r1", "screening"], { offered: 10, started: 8, finished: 6, unfinished: 1, stillApplying: 2, medianMinutes: 6.4, personChosen: { contactMe: 1, sendWithout: 1 }, skipped: [{ key: "q_pay", question: "What pay are you looking for?", count: 3 }] }]]);
    const html = render(qc, createElement(ScreeningCard, { roleId: "r1" }));
    expect(html).toContain('<div class="stat-row"><div class="stat"><span class="stat-n">10</span><span class="stat-label">people offered it</span></div>');
    expect(html).toContain('<div class="stat"><span class="stat-n">2</span><span class="stat-label">still applying now</span></div></div>');
    expect(html).toContain('<th scope="col" class="num">Chose not to answer</th>');
    expect(html).toContain('<td>What pay are you looking for?</td><td class="num">3</td>');
    // the old inline 28px figure is gone: the look comes from the stylesheet
    expect(html).not.toContain("font-size:28px");
  });

  it("draws the applicant tiles, one bar per day (an empty day quieter, its height still data) and every count right-aligned", () => {
    const html = render(client(), createElement(ReportFigures, { report: report as never }));
    expect(html).toContain('<div class="stat-row"><div class="stat"><span class="stat-n">3</span><span class="stat-label">applicants in total</span></div><div class="stat"><span class="stat-n">3</span><span class="stat-label">in the last 30 days</span></div></div>');
    expect(html).toContain('<div class="stat"><span class="stat-n">3</span><span class="stat-label">decisions only a person can make</span></div><div class="stat"><span class="stat-n">2</span><span class="stat-label">days the oldest has waited</span></div>');
    expect(html.match(/<div class="stat-row">/g)).toHaveLength(2);
    // the day bars: the counts stay in the label, the empty day is marked for its quieter colour, the height is inline
    expect(html).toContain('<div class="daybars" role="img" aria-label="Applicants per day over the last 30 days: 2026-10-09 2, 2026-10-10 1"><span title="2026-10-08: 0" class="zero" style="height:4%"></span><span title="2026-10-09: 2" style="height:100%"></span><span title="2026-10-10: 1" style="height:50%"></span></div>');
    expect(html).not.toContain("border-radius:2px");
    // every count column, heading and cells
    expect(html).toContain('<th scope="col" class="num">Applicants</th>');
    expect(html).toContain('<td>Careers page</td><td class="small muted"></td><td class="num">2</td>');
    expect(html).toContain('<td>New</td><td class="num">3</td>');
    // the Cancelled stage is a row of its own, counted like the others
    expect(html).toContain('<td>Cancelled</td><td class="num">0</td>');
    expect(html).toContain('<td>Ready for your review <span class="small muted">(Waiting on you)</span></td><td class="num">3</td>');
    expect(html).toContain('<th scope="col" class="num">Typical stay</th>');
    expect(html).toContain('<td>Ready for your review</td><td class="num">3</td><td class="num">2 days</td><td class="num">0</td><td class="num"></td><td class="num"></td>');
    expect(html).toContain('<td>Working interview</td><td class="num">1</td><td class="num">1</td><td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">0</td>');
    expect(html).toContain('<td>Invite to a screen</td><td class="num">2</td><td class="num">1</td><td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">0</td><td class="num">1</td>');
    expect(html).toContain('<th scope="col" class="num">People</th>');
    expect(html).toContain('<td>Skills not a match</td><td class="num">1</td>');
    // the two wide tables keep their first column in view; the others are plain
    expect(html).toMatch(/<section class="table-wrap pin-first"[^>]*aria-label="Interviews by round">/);
    expect(html).toMatch(/<section class="table-wrap pin-first"[^>]*aria-label="Suggestions and decisions">/);
    expect(html.match(/table-wrap pin-first/g)).toHaveLength(2);
    // the Report's fixed order means something: nothing sorts, so there is no sort button and nothing to announce
    expect(html).not.toContain("th-sort");
    expect(html).not.toContain("aria-sort");
    expect(html).not.toContain('role="status"');
  });

  it("gives the administrator's view of a customer's report the same figures, and right-aligns the roles' counts", () => {
    const customer = { company: { id: "co1", name: "Bright Dental", status: "active", planKey: "starter" }, roles: [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), closedAt: null, applicants: 3, waitingOnYou: 2, hired: 0 }], report };
    const html = render(client([[["admin", "customer-report", "co1"], customer]], admin), createElement(CustomerReportSheet, { companyId: "co1", companyName: "Bright Dental", onClose: () => undefined }));
    expect(html).toContain('<th scope="col" class="num">Waiting on them</th>');
    expect(html).toMatch(/<td>Dental Hygienist<\/td><td><span class="pill good sm">.*?open<\/span><\/td><td class="num">3<\/td><td class="num">2<\/td><td class="num">0<\/td>/);
    expect(html).toContain('<div class="daybars" role="img"');
    expect(html.match(/<div class="stat-row">/g)).toHaveLength(2);
    expect(html).not.toContain("th-sort");
  });
});

describe("tables elsewhere on a role", () => {
  it("right-aligns the score on the board a recruiter is asked to check", () => {
    const snapshot = { capturedAt: "2026-10-09T10:00:00.000Z", summary: { sentences: ["2 people on the board."], counts: { shortlist: 1 } }, people: [
      { applicationId: "a1", name: "Maria Reyes", column: "shortlist", state: "suggested", score: 91, reason: "Match score 91.", needsYourEye: null, nextStep: "Interview" },
      { applicationId: "a5", name: "Sofia Lind", column: null, state: "waiting", score: null, reason: "Still applying.", needsYourEye: null, nextStep: null },
    ] };
    const html = render(client(), createElement(BoardSnapshotCard, { snapshot: snapshot as never }));
    expect(html).toContain('<th scope="col" class="num">Score</th>');
    expect(html).toContain('<td class="small num">91/100</td>');
    expect(html).toContain('<td class="small num">No score yet</td>');
  });

  it("keeps Compare's row headers in view while the people scroll sideways, its headings still plain", () => {
    const cand = (id: string) => ({ applicationId: id, name: id === "a1" ? "Maria Reyes" : "Luis Ortega", stage: "triaged", stageLabel: "Ready", group: "waiting_on_you", mustHaves: {}, competencies: {}, screen: null, resume: null, unknownCount: 0, open: `/roles/r1/talent?open=${id}`, score: null, notes: [] });
    const data = { role: { id: "r1", title: "Dental Hygienist" }, mustHaves: [{ key: "mh_1", text: "Active CA RDH license" }], competencies: [{ key: "c1", name: "Patient care", definition: "Calm with patients", importance: "essential" }], max: 5, reminder: "People decide.", candidates: [cand("a1"), cand("a2")] };
    const html = render(client(), createElement(CompareTable, { data: data as never }));
    expect(html).toMatch(/<section class="table-wrap pin-first"/);
    expect(html).toContain('<th scope="col">Maria Reyes</th>');
    expect(html).not.toContain("th-sort");
    expect(html).not.toContain('role="status"');
  });

  it("right-aligns the visits of each tracked link and the counts of applications by source", () => {
    const postings = {
      role: { id: "r1", title: "Dental hygienist", status: "open", acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, volumeAlertPerDay: 50, applicationsCloseOn: "2026-10-30", openedAt: "2026-10-08T10:00:00.000Z", currentPacketVersion: 1 },
      urls: { careers: "https://jobs.test/c/bright", job: "https://jobs.test/c/bright/jobs/r1", apply: "https://jobs.test/c/bright/jobs/r1/apply" },
      emailIn: { address: "r1@in.test", connected: false, shown: false, status: "failed", error: null },
      postings: [],
      links: [{ id: "l9", url: "https://jobs.test/a/ref", source: "referral", sourceLabel: "Referral", sourceDetail: "Dr. Patel", label: "Referral: Dr. Patel", postingId: null, visits: 5, lastVisitedAt: null, createdAt: daysAgo(3), disabledAt: null, landing: "apply" }],
      boardsStillUp: [],
      publishing: { state: "ready", pollAfterSeconds: 10, message: "Everything is prepared.", checksPending: 0 },
      whoPosts: "its",
      boards: [],
      closingDate: { closesOn: "2026-10-30", closesAt: "2026-10-31T07:00:00.000Z", applyBy: "Apply by Friday, October 30, 2026", timeZone: "America/Los_Angeles", requiredByLaw: false, defaultIfMissing: null, passed: false, applicationsClosedByDate: false },
    };
    const volume = { from: "2026-09-27", to: "2026-10-10", timeZone: "America/Los_Angeles", days: [{ day: "2026-10-09", total: 2, bySource: { careers_page: 2 } }, { day: "2026-10-10", total: 1, bySource: { careers_page: 1 } }], totals: { total: 3, bySource: { careers_page: 3 } }, sources: [{ source: "careers_page", label: "Careers page", total: 3 }], threshold: 50, yesterday: { day: "2026-10-09", total: 2 }, today: { day: "2026-10-10", total: 1 }, acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null };
    const qc = client([[["company"], { settings: { verifiedAt: "2026-10-01T00:00:00.000Z" } }], [["postings", "r1"], postings], [["volume", "r1"], volume]]);
    const html = render(qc, createElement(PostingTab, { roleId: "r1", roleStatus: "open", canManage: true }));
    expect(html).toContain('<th scope="col" class="num">Visits</th>');
    expect(html).toContain('<td class="num">5</td>');
    expect(html).toContain('<th scope="col" class="num">Last 14 days</th>');
    expect(html).toContain('<td>Careers page</td><td class="num">3</td><td class="num">2</td><td class="num">1</td>');
  });
});

const company = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, slug: id, vertical: "dental", sizeBand: "20-49", planKey: "starter", status: "active", roles: 1, applications: 0, aiCostUsd: 0, lastActivityAt: daysAgo(1), escalations: 0, createdAt: daysAgo(30),
  settings: {}, verifiedAt: daysAgo(29), verifiedBy: null, heldMessages: 0, jobBoardsConfirmedAt: null, applyFlowDefault: "form_then_screen", ...over,
});

describe("the admin console's tables", () => {
  it("keeps the companies waiting for the ITS check on top (B7), with sortable headings and right-aligned figures", () => {
    // Cara Dental waits for the check but comes second in the answer: only the B7 rule can put it first
    const customers = [company("co1", "Bright Dental", { roles: 2, applications: 3, aiCostUsd: 0.04 }), company("co2", "Cara Dental", { verifiedAt: null, createdAt: daysAgo(2), roles: 0 }), company("co3", "Avon Dental", { applications: 7, aiCostUsd: 0.1 })];
    const html = render(client([[["admin", "customers"], customers], [["admin", "alerts"], []]], admin), createElement(Admin));
    expect(html).toMatch(/<section class="table-wrap scroll pin-first"/);
    expect(html).toContain('<th scope="col"><button type="button" class="th-sort">Company');
    expect(html).toContain('<th scope="col" class="num"><button type="button" class="th-sort">Applicants');
    expect(html).toContain('<th scope="col" class="num"><button type="button" class="th-sort">AI cost');
    expect(html).toContain('<th scope="col"><button type="button" class="th-sort">Last activity');
    expect(html).toContain('<th scope="col" class="num">Roles</th>');
    // nothing is sorted until someone presses a heading, and nothing is said yet
    expect(html).not.toContain("aria-sort");
    expect(html).toContain('<span class="sr-only" role="status"></span>');
    // the caution alert above the table names Cara Dental too, so the order is read from the table on
    const table = from(html, '<section class="table-wrap scroll pin-first"');
    expect(table.indexOf("Cara Dental")).toBeGreaterThan(-1);
    expect(table.indexOf("Cara Dental")).toBeLessThan(table.indexOf("Bright Dental"));
    // the confirmed companies below keep the order they came in until someone sorts
    expect(table.indexOf("Bright Dental")).toBeLessThan(table.indexOf("Avon Dental"));
    expect(html).toMatch(/<td class="num">3<\/td>/);
    expect(html).toContain('<td class="num">2</td><td class="num">3</td><td class="num">$0.0400</td>');
  });

  it("keeps the waiting companies on top, the longest waiting first, under every order a heading can give (B7), and says so after a sort", () => {
    type Row = Parameters<typeof CUSTOMER_SORT.company>[0];
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
    expect(names(customerOrder(rows, (list) => list))).toEqual(["Zeta Dental", "Cara Dental", "Bright Dental", "Avon Dental", "Dove Dental"]);
    let moved = 0;
    for (const key of Object.keys(CUSTOMER_SORT) as Array<keyof typeof CUSTOMER_SORT>) {
      for (const dir of ["ascending", "descending"] as const) {
        const order = names(customerOrder(rows, (list) => sortRows(list, CUSTOMER_SORT[key], dir)));
        expect(order.slice(0, 2), `${key} ${dir}`).toEqual(["Zeta Dental", "Cara Dental"]);
        expect(order.slice(2), `${key} ${dir}`).toEqual(names(sortRows(confirmed, CUSTOMER_SORT[key], dir)));
        // the fixture bites: sorting every company together would move a waiting one down under each of these orders
        if (names(sortRows(rows, CUSTOMER_SORT[key], dir)).slice(0, 2).join() !== "Zeta Dental,Cara Dental") moved++;
      }
    }
    expect(moved).toBe(8);
    expect(customerAnnouncement("Sorted by AI cost, highest first.", 2)).toBe("Sorted by AI cost, highest first. Companies waiting for the ITS check stay at the top.");
    expect(customerAnnouncement("Sorted by AI cost, highest first.", 0)).toBe("Sorted by AI cost, highest first.");
    expect(customerAnnouncement("", 2)).toBe("");
  });

  it("keeps the headings and says so in a row when there are no customers", () => {
    const html = render(client([[["admin", "customers"], []], [["admin", "alerts"], []]], admin), createElement(Admin));
    expect(html).toMatch(/<td colspan="12" class="table-empty">No customers yet\.<\/td>/i);
    expect(html).toContain('<span class="sr-only" role="status">No customers yet.</span>');
    expect(html).toContain('<th scope="col" class="num">Roles</th>');
  });

  it("keeps the workflow headings while the runs load, with quiet rows instead of a skeleton block", () => {
    const html = render(client([], admin), createElement(Runs));
    expect(html).toMatch(/<section class="table-wrap scroll"/);
    expect(html).toContain('<th scope="col" class="num">Attempts</th>');
    expect(html).toContain('<tbody aria-busy="true">');
    expect(html.match(/<tr aria-hidden="true">/g)).toHaveLength(4);
    expect(html).toContain('<span class="sr-only" role="status">Loading…</span>');
    expect(html).not.toContain('aria-label="Loading"');
    // the status filter stays above the table
    expect(html).toContain('<button type="button" class="on" aria-pressed="true">All</button>');
  });

  it("says when there are no workflow runs, and right-aligns the attempts", () => {
    expect(render(client([[["admin", "runs", ""], []]], admin), createElement(Runs))).toMatch(/<td colspan="9" class="table-empty">No workflow runs yet\.<\/td>/i);
    const run = { id: "run1", companyId: "co1", workflowKey: "triage", status: "failed", currentStep: "score", wait: null, attempts: 2, lastError: "timeout", updatedAt: daysAgo(0), subject: { type: "application", id: "a1aaaaaaaa" } };
    const html = render(client([[["admin", "runs", ""], [run]]], admin), createElement(Runs));
    expect(html).toContain('<td class="num">2</td>');
    expect(html).not.toContain("table-empty");
  });

  it("opens the AI runs latest first, with Cost and Latency sortable and every figure right-aligned", () => {
    const ai = (id: string, task: string, createdAt: string, costUsd: string, latencyMs: number) => ({ id, companyId: "co1", agent: "screening", task, model: "fake-1", promptKey: "screen", promptVersion: 3, status: "ok", inputTokens: 10, outputTokens: 20, costUsd, latencyMs, confidence: null, createdAt });
    // the older run comes first in the answer
    const html = render(client([[["admin", "ai"], [ai("ai1", "older_task", daysAgo(2), "0.00100", 900), ai("ai2", "newer_task", daysAgo(0), "0.02000", 1500)]]], admin), createElement(AiRuns));
    expect(html).toContain('<th scope="col" aria-sort="descending"><button type="button" class="th-sort">When');
    expect(html.match(/aria-sort=/g)).toHaveLength(1);
    expect(html).toContain('<th scope="col" class="num"><button type="button" class="th-sort">Cost');
    expect(html).toContain('<th scope="col" class="num"><button type="button" class="th-sort">Latency');
    expect(html).toContain('<th scope="col" class="num">Tokens in/out</th>');
    expect(html).toContain('<td class="num">10/20</td><td class="num">$0.02000</td><td class="num">1500 ms</td>');
    expect(html.indexOf("newer_task")).toBeLessThan(html.indexOf("older_task"));
    expect(html).toMatch(/<section class="table-wrap scroll"/);
    expect(render(client([[["admin", "ai"], []]], admin), createElement(AiRuns))).toMatch(/<td colspan="10" class="table-empty">No AI runs recorded yet\.<\/td>/i);
  });

  it("right-aligns the model spend, keeping its headings when nothing was spent", () => {
    const html = render(client([[["admin", "costs"], [{ companyId: "co1aaaaaaaa", task: "triage", model: "fake-1", runs: 4, inputTokens: 1000, outputTokens: 200, costUsd: 0.0123 }]]], admin), createElement(Costs));
    expect(html).toContain('<th scope="col" class="num">Tokens in</th>');
    expect(html).toContain('<th scope="col" class="num">Cost</th>');
    expect(html).toContain('<td class="num">4</td><td class="num">1000</td><td class="num">200</td><td class="num">$0.01230</td>');
    expect(html).toMatch(/<section class="table-wrap scroll"/);
    expect(render(client([[["admin", "costs"], []]], admin), createElement(Costs))).toMatch(/<td colspan="7" class="table-empty">No model spend recorded yet\.<\/td>/i);
  });

  it("right-aligns how many times an address bounced", () => {
    const failures = { failedRuns: [], failedJobs: [], failedAi: [], alerts: [], pendingDeletions: [] };
    const suppression = { id: "sp1", address: "old@example.com", reason: "hard_bounce", source: "provider", active: true, count: 2, firstAt: daysAgo(3), lastAt: daysAgo(1), details: {} };
    const html = render(client([[["admin", "failures"], failures], [["admin", "suppressions"], [suppression]], [["admin", "csp"], { mode: "report-only", reports: [] }]], admin), createElement(Failures));
    expect(html).toContain('<th scope="col" class="num">Times</th>');
    expect(html).toContain('<td>provider</td><td class="num">2</td>');
  });

  it("lets ITS sort the open privacy requests by when they came in or when they are due, in the order they came until then", () => {
    const request = (id: string, companyName: string, createdAt: string, slaDueAt: string, status = "received") => ({ id, companyId: "co1", companyName, candidateId: null, applicationId: null, kind: "access", details: null, requesterEmail: "maria@example.com", channel: "email", verificationStatus: "pending", verificationNote: null, status, slaDueAt, assignedTo: null, notes: [], counselEscalatedAt: null, counselDecision: null, counselNote: null, resolution: null, resolvedAt: status === "fulfilled" ? daysAgo(1) : null, confirmationSentAt: null, escalationId: null, createdAt });
    const data = [request("d1", "Avon Dental", daysAgo(5), daysAgo(-10)), request("d2", "Cara Dental", daysAgo(40), daysAgo(1)), request("d3", "Bright Dental", daysAgo(9), daysAgo(-3), "fulfilled")];
    const html = render(client([[["admin", "privacy"], data], [["admin", "customers"], []]], admin), createElement(PrivacyRequests));
    const open = from(html, /<section class="table-wrap scroll"/);
    expect(open).toContain('<th scope="col"><button type="button" class="th-sort">Received');
    expect(open).toContain('<th scope="col"><button type="button" class="th-sort">Due');
    expect(html).not.toContain("aria-sort");
    expect(open.indexOf("Avon Dental")).toBeLessThan(open.indexOf("Cara Dental"));
    expect(open).toContain('<span class="sr-only" role="status"></span>');
    // the closed requests stay a plain table
    expect(html.match(/class="th-sort"/g)).toHaveLength(2);
    expect(html).toContain('<th scope="col">Resolved</th>');
  });

  it("keeps the outcome headings and says so in a row when none is recorded", () => {
    const html = render(client([[["admin", "outcomes"], { statement: "People record outcomes.", outcomes: [] }]], admin), createElement(Outcomes));
    expect(html).toMatch(/<td colspan="7" class="table-empty">No outcomes recorded yet\.<\/td>/i);
    expect(html).toContain('<th scope="col">Hire date</th>');
  });
});

describe("Setup's tables", () => {
  const setupCompany = { id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", planKey: "pilot", status: "active", locations: [{ city: "Irvine", region: "CA" }], settings: { verifiedAt: "2026-10-01T00:00:00.000Z" }, integrations: [], ai: { provider: "fake" } };
  const page = (audit?: unknown[]) => {
    const data: Array<[unknown[], unknown]> = [
      [["company"], setupCompany],
      [["me"], { user: { id: "u1" }, activeCompanyId: "co1", memberships: [{ companyId: "co1", role: "owner", companyName: "Bright Dental" }] }],
      [["public-profile"], { hiringContact: null, contactShown: { email: "help@its.test", name: null, kind: "its" } }],
    ];
    if (audit) data.push([["audit-history", false], audit]);
    return render(client(data), createElement(Setup));
  };
  const auditRow = (id: string, description: string, at: string, name: string | null) => ({ id, action: "company.updated", description, actor: { kind: "user", name }, reason: null, at, details: {} });

  it("opens the audit history latest first, When and Who sortable, the time kept on one line by a class", () => {
    const html = page([auditRow("e1", "Changed the company name", daysAgo(3), "Zoe Adams"), auditRow("e2", "Opened a candidate record", daysAgo(0), "Dana Whitfield")]);
    const table = from(html, /<section class="table-wrap scroll"[^>]*aria-label="Audit history">/);
    expect(table).toContain('<th scope="col" aria-sort="descending"><button type="button" class="th-sort">When');
    expect(table).toContain('<th scope="col"><button type="button" class="th-sort">Who');
    expect(table).toContain('<th scope="col">What happened</th>');
    expect(table.indexOf("Opened a candidate record")).toBeLessThan(table.indexOf("Changed the company name"));
    expect(table).toMatch(/<td class="small nowrap">[^<]+<\/td><td>Opened a candidate record<\/td><td class="small">Dana Whitfield<\/td>/);
    expect(html).not.toContain('style="white-space:nowrap"');
  });

  it("keeps the audit headings while the list loads, and says when nothing is recorded", () => {
    const loading = page();
    const table = from(loading, /<section class="table-wrap scroll"[^>]*aria-label="Audit history">/);
    expect(table).toContain('<tbody aria-busy="true">');
    expect(table.match(/<tr aria-hidden="true">/g)).toHaveLength(5);
    expect(table).toContain('<th scope="col" aria-sort="descending"><button type="button" class="th-sort">When');
    expect(loading).not.toContain("Nothing recorded yet.");
    const none = page([]);
    expect(none).toContain('<p class="small muted">Nothing recorded yet.</p>');
    expect(none).not.toContain('aria-label="Audit history"');
  });

  it("keeps the connected-services headings with a row that says none is connected", () => {
    expect(page([])).toMatch(/<td colspan="4" class="table-empty">No services connected yet\.<\/td>/i);
  });
});

describe("the Interviews tables", () => {
  const interview = (id: string, firstName: string, startsAt: string | null, status: string, who = "Dana Whitfield") => ({
    id, applicationId: `a-${id}`, roleId: "r1", roleTitle: "Dental Hygienist", roundKey: "working", title: "Working interview", format: "in_person", durationMinutes: 45, status, startsAt, endsAt: null, timezone: "America/Los_Angeles", meetingUrl: null, linkSource: "calendar", attempt: 1,
    offeredSlots: [], selectedSlot: null, candidateAvailability: null, schedulingWindow: {}, rescheduleCountCandidate: 0, outcome: status === "completed" ? "happened" : null, decision: null, decisionNote: null, reminders: {}, cancelReason: null, scheduleTokenExpiresAt: null, createdAt: daysAgo(10),
    candidate: { firstName, lastName: "Test", timezone: null, stage: "interview_scheduled", stageLabel: "Interview scheduled" }, participants: [{ userId: "u1", name: who, email: "dana@bright.test", status: "accepted" }],
  });

  it("opens Coming up soonest first (unscheduled last) and Past latest first, whatever order the answer came in", () => {
    nav.params = {};
    try {
      const list = [
        interview("iv0", "Pia", null, "proposed", "Pat Lee"),
        interview("iv1", "Nora", "2026-10-14T18:00:00.000Z", "scheduled", "Zoe Adams"),
        interview("iv2", "Omar", "2026-10-09T17:00:00.000Z", "scheduled"),
        interview("iv3", "Rosa", "2026-10-02T17:00:00.000Z", "completed"),
        interview("iv4", "Sam", "2026-10-06T17:00:00.000Z", "completed"),
      ];
      const html = render(client([[["interviews"], list]]), createElement(Interviews));
      const inMotion = from(html, "Coming up (3)");
      const past = from(html, "Past (2)");
      expect(inMotion).toContain('<th scope="col" aria-sort="ascending"><button type="button" class="th-sort">When');
      expect(inMotion).toContain('<th scope="col"><button type="button" class="th-sort">Candidate');
      expect(inMotion).toContain('<th scope="col"><button type="button" class="th-sort">Round');
      expect(inMotion.indexOf("Omar Test")).toBeGreaterThan(-1);
      expect(inMotion.indexOf("Omar Test")).toBeLessThan(inMotion.indexOf("Nora Test"));
      expect(inMotion.indexOf("Nora Test")).toBeLessThan(inMotion.indexOf("Pia Test"));
      expect(past).toContain('<th scope="col" aria-sort="descending"><button type="button" class="th-sort">When');
      expect(past.indexOf("Sam Test")).toBeGreaterThan(-1);
      expect(past.indexOf("Sam Test")).toBeLessThan(past.indexOf("Rosa Test"));
      expect(html.match(/aria-sort=/g)).toHaveLength(2);
      expect(html.match(/<span class="sr-only" role="status"><\/span>/g)).toHaveLength(2);
      // the interviewer line under Coming up names people soonest interview first, as it did before the table sorted,
      // not in the answer's order (Pat Lee, Zoe Adams, Dana Whitfield)
      expect(html).toMatch(/Interviewer load: (<!-- -->)?Dana Whitfield 1 · Zoe Adams 1 · Pat Lee 1</);
    } finally {
      nav.params = { id: "r1" };
    }
  });
});

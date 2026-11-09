import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The plans of 5 November 2026 on screen, as the server first draws them from answers shaped like the API's. The one Upgrade
 * and its sheet; the room alert, the team card, Settings and Home's row for the AI help; a person past the plan's candidates
 * per job as one card on the list, the board and the panel; the quick start and the job builder when there is no room; and
 * the console's Change plan and customer row. Customers read the AI help as words or a percentage, never dollars; ITS reads
 * dollars. Nothing here names anyone locked.
 */
const nav = vi.hoisted(() => ({ search: "", path: "/", params: {} as Record<string, string> }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { Upgrade, UpgradeSheet } = await import("@ros/web/src/components/Upgrade");
const { AskRecruiter } = await import("@ros/web/src/components/AskRecruiter");
const { LockedCandidates, LockedCard } = await import("@ros/web/src/components/LockedCandidates");
const { RoomAlert } = await import("@ros/web/src/pages/new-role/StartView");
const { TeamCard } = await import("@ros/web/src/pages/TeamCard");
const { Setup } = await import("@ros/web/src/pages/Setup");
const { Home } = await import("@ros/web/src/pages/Home");
const { People } = await import("@ros/web/src/pages/People");
const { RoleDetail } = await import("@ros/web/src/pages/RoleDetail");
const { Interviews } = await import("@ros/web/src/pages/Interviews");
const { NewRole } = await import("@ros/web/src/pages/NewRole");
const { ReportFigures } = await import("@ros/web/src/pages/RoleReport");
const { CandidatePanel } = await import("@ros/web/src/pages/candidate-panel/CandidatePanel");
const { ScorecardWaitingCard } = await import("@ros/web/src/pages/candidate-panel/assessment");
const { CallNotesCard } = await import("@ros/web/src/pages/candidate-panel/call-notes");
const { MessagesTab } = await import("@ros/web/src/pages/candidate-panel/sections");
const { CloseRoleCard } = await import("@ros/web/src/components/ClosingMessage");
const { RecruiterRequests } = await import("@ros/web/src/components/RecruiterRequests");
const { RecruiterQueue } = await import("@ros/web/src/pages/RecruiterQueue");
const { CustomersSection, aiCreditDollars, planChangedToast, planLimitsLine, planPriceLine } = await import("@ros/web/src/pages/admin/customers");
const { attentionRows } = await import("@ros/web/src/pages/admin/Overview");
const { needsAPerson } = await import("@ros/web/src/pages/admin/problems");
const { ApiError } = await import("@ros/web/src/api/client");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const me = (role: string) => ({ user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "fake" } });
const recruiter = { ...me("owner"), user: { id: "s2", email: "rae@its.test", name: "Rae Recruiter", platformRole: "its_recruiter" }, memberships: [], activeCompanyId: "co1", staffAccess: { grantId: "g1", kind: "escalation", purpose: "A role", expiresAt: "2026-12-20T00:00:00Z", companyName: "Bright Dental", scope: { escalationId: "e1", roleId: "r1", applicationId: null } } };
const admin = { ...me("owner"), user: { id: "s1", email: "ada@its.test", name: "Ada Admin", platformRole: "platform_admin" }, memberships: [], activeCompanyId: null };
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function client(data: Array<[readonly unknown[], unknown]> = [], who: unknown = me("owner")) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], who);
  for (const [key, value] of data) qc.setQueryData(key, value);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
/** A refusal as the page holds it once the request was answered (no new request while the server draws the page). */
const refused = (qc: QueryClient, queryKey: readonly unknown[], error: Error) => qc.getQueryCache().build(qc, { queryKey }).setState({ status: "error", error, fetchStatus: "idle", errorUpdatedAt: Date.now(), errorUpdateCount: 1, fetchFailureCount: 1 });
const locked402 = new ApiError(402, "candidate_locked", "Locked. Upgrade to view more candidates.", { upgrade: true, actions: [] });

const plans = {
  requested: false,
  plans: [
    { key: "free", name: "Free", monthlyUsd: 0, activeRoles: 1, jobsTotal: 1, candidatesPerJob: 5, seats: 2, aiHelp: "Included, up to a limit", current: true },
    { key: "basic", name: "Basic", monthlyUsd: 49, activeRoles: 3, jobsTotal: null, candidatesPerJob: 25, seats: 3, aiHelp: "About 600 candidates a month", current: false },
    { key: "pro", name: "Pro", monthlyUsd: 149, activeRoles: 10, jobsTotal: null, candidatesPerJob: 100, seats: 10, aiHelp: "About 1,800", current: false },
    { key: "ultra", name: "Ultra", monthlyUsd: 399, activeRoles: 30, jobsTotal: null, candidatesPerJob: null, seats: null, aiHelp: "About 6,000", current: false },
  ],
};

beforeEach(() => {
  nav.search = "";
  nav.path = "/";
  nav.params = {};
});

describe("the one Upgrade and its sheet", () => {
  const sheet = (data: unknown = plans) => render(client([[["plans"], data]]), createElement(UpgradeSheet, { onClose: () => undefined }));

  it("shows the four plans side by side, the current one marked, with prices, the numbers and the AI help in words", () => {
    const html = sheet();
    const words = text(html);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Upgrade"');
    expect(html).toContain("@xl:grid-cols-4");
    expect(words).toContain("Free Your plan $0");
    expect(words).toContain("Basic $49 a month Jobs 3 at a time Candidates per job 25 People 3 AI help About 600 candidates a month");
    expect(words).toContain("Pro $149 a month");
    expect(words).toContain("Ultra $399 a month Jobs 30 at a time Candidates per job No limit People No limit AI help About 6,000");
    expect(words).toContain("Jobs 1 Candidates per job 5 People 2 AI help Included, up to a limit");
    // Free costs nothing and the company is on it: no radio to choose it; one for each of the others, the next one up chosen
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/<input type="radio"[^>]*checked=""[^>]*value="basic"/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).not.toContain('value="free"');
  });

  it("asks one thing, with one plain line about money; nothing about access, urgency or a recruiter's help", () => {
    const html = sheet();
    const words = text(html);
    expect(words).toContain("A note for ITS (optional)");
    expect(words).toContain("Ask ITS to upgrade");
    expect(words).toContain("No card is charged. ITS will contact you, and nothing changes until then.");
    for (const not of ["will see", "every candidate", "access", "How urgent", "What do you want help with", "Send to a recruiter", "Bring in a recruiter", "$10", "cents"]) expect(words, not).not.toContain(not);
  });

  it("on the last plan nothing below is chosen for them, and they can still talk with ITS, in words that do not send them to a plan that is not there", () => {
    const html = sheet({ requested: false, plans: plans.plans.map((p) => ({ ...p, current: p.key === "ultra" })) });
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toContain('checked=""');
    expect(html).toContain('aria-label="Your plan"');
    expect(html).toMatch(/<button type="button" class="btn primary"[^>]*>Ask ITS about our plan<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Ask ITS about our plan/);
    expect(text(html)).not.toContain("Ask ITS to upgrade");
  });

  it("on a plan not in the list (the pilot, Trial, a retired one) Free is not chosen for them: they pick one, or ask with none picked", () => {
    const html = sheet({ requested: false, plans: plans.plans.map((p) => ({ ...p, current: false })) });
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/<button type="button" class="btn primary"[^>]*>Ask ITS to upgrade<\/button>/);
  });

  it("says softly that ITS has the request, and asks nothing more", () => {
    const words = text(sheet({ ...plans, requested: true }));
    expect(words).toContain("ITS has your request.");
    expect(words).not.toContain("Ask ITS to upgrade");
    expect(words).not.toContain("A note for ITS");
  });

  it("the button shows for anyone at the company who may ask, never for an interviewer or for ITS staff inside a customer, and the sheet stays closed until pressed", () => {
    const button = (who: unknown) => render(client([], who), createElement(Upgrade, {}));
    const html = button(me("owner"));
    expect(html).toMatch(/<button type="button" class="btn secondary"[^>]*>.*Upgrade<\/button>/);
    expect(html).not.toContain('role="dialog"');
    expect(button(me("hiring_manager"))).toContain(">Upgrade<");
    expect(button(me("interviewer"))).toBe("");
    expect(button(recruiter)).toBe("");
  });

  it("a request about the plan always takes this way, whatever the card calls it; any other request keeps the recruiter's form", () => {
    expect(render(client(), createElement(AskRecruiter, { label: "Ask ITS to choose a plan", preset: { kind: "ask", about: "all", topic: "plan", question: "x" } }))).toContain("Ask ITS to choose a plan");
    expect(render(client(), createElement(AskRecruiter, { preset: { kind: "ask", about: "all", topic: "plan", question: "x" } }))).toContain(">Upgrade<");
    expect(render(client(), createElement(AskRecruiter, {}))).toContain(">Bring in a recruiter<");
  });

  it("the room alert: no roles to close and the plan's words, with the Upgrade", () => {
    const room = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true };
    const html = render(client(), createElement(RoomAlert, { room, ask: null }));
    expect(text(html)).toContain("Your Free plan includes one job. Upgrade to post more.");
    expect(html).toContain(">Upgrade<");
    expect(html).not.toContain("Talk to ITS");
    // a plan with places at a time keeps its own words, and its ask opens the same sheet
    const full = { ok: false, limit: 2, used: 2, holding: [{ roleId: "r1", title: "Front Desk", status: "open" }], message: "Your plan includes 2 roles at a time." };
    expect(render(client(), createElement(RoomAlert, { room: full, ask: null }))).toContain("Talk to ITS about more roles");
  });
});

describe("the team card and Settings", () => {
  const member = { userId: "u1", role: "owner", status: "active", email: "dana@bright.test", name: "Dana Whitfield", calendar: null, availability: null, schedulable: false };
  const company = (over: Record<string, unknown> = {}) => ({ id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", planKey: "free", status: "active", plan: { key: "free", name: "Free", limits: { jobs_total: 1, candidates_per_job: 5, seats: 2 } }, locations: [{ city: "Irvine", region: "CA" }], settings: { verifiedAt: daysAgo(30) }, integrations: [{ kind: "jobboard", provider: "linkedin_basic", status: "not_connected" }], ai: { provider: "fake" }, usage: { jobs_total: { used: 1, limit: 1 }, active_roles: { used: 1, limit: 1 }, ai_credit_total_cents: { used: 18, limit: 100, unit: "percent" }, seats: { used: 1, limit: 2 } }, trial: null, whoPosts: "self", itsPosting: false, ...over });
  const page = (c: Record<string, unknown>, search = "", role = "owner") => {
    nav.search = search;
    nav.path = "/setup";
    return render(client([[["company"], c], [["policies"], []], [["members"], [member]], [["invitations"], []], [["public-profile"], { hiringContact: null, contactShown: { email: "help@its.test", name: null, kind: "its" } }], [["notification-preferences"], { groups: [], alwaysSent: [], digest: { timezone: "America/Los_Angeles", hour: 8, weekday: "Monday" }, email: "dana@bright.test" }], [["me", "calendar"], { connection: null, availability: null, providers: [] }]], me(role)), createElement(Setup));
  };

  it("the team card: with every place in use, Invite waits, says why, and offers the Upgrade", () => {
    const html = render(client([[["members"], [member]], [["invitations"], []]]), createElement(TeamCard, { myRole: "owner", myUserId: "u1", seats: { used: 2, limit: 2 }, planKey: "free" }));
    expect(text(html)).toContain("Your plan includes 2 people. Upgrade to add more. Upgrade");
    expect(html).toMatch(/<button type="submit" class="btn primary" disabled=""[^>]*>Invite<\/button>/);
    const room = render(client([[["members"], [member]], [["invitations"], []]]), createElement(TeamCard, { myRole: "owner", myUserId: "u1", seats: { used: 1, limit: 2 }, planKey: "free" }));
    expect(text(room)).not.toContain("Upgrade");
    // on Trial, in Trial's words
    expect(render(client([[["members"], [member]], [["invitations"], []]]), createElement(TeamCard, { myRole: "owner", myUserId: "u1", seats: { used: 3, limit: 3 }, planKey: "trial" }))).toContain("Ask ITS to choose a plan");
  });

  it("the plan section: the plan, its numbers, the AI help as a percentage, an Upgrade; no dollars and no row for candidates per job", () => {
    const words = text(page(company()));
    expect(words).toContain("Plan Free Upgrade");
    expect(words).toContain("jobs: 1 of 1");
    expect(words).toContain("AI help: 18% used");
    expect(words).not.toMatch(/\$\d|cents/);
    expect(words).not.toContain("candidates per job");
    expect(words).not.toContain("0 of 5");
  });

  it("a company moved off an older plan: the rows it keeps for what was never built are not printed", () => {
    const words = text(page(company({ planKey: "pro", plan: { key: "pro", name: "Pro", limits: {} }, usage: { active_roles: { used: 1, limit: 10 }, voice_minutes: { used: 0, limit: 300 }, sourcing_contacts: { used: 0, limit: 50 }, ai_credit_monthly_cents: { used: 4, limit: 100, unit: "percent" } } })));
    expect(words).toContain("active jobs: 1 of 10");
    expect(words).toContain("AI help this month: 4% used");
    expect(words).not.toContain("voice");
    expect(words).not.toContain("sourcing");
  });

  it("no Upgrade where nothing is above: the last public plan and the private pilot; any other plan has one", () => {
    expect(text(page(company({ planKey: "ultra", plan: { key: "ultra", name: "Ultra", limits: {} }, itsPosting: true })))).not.toContain("Upgrade");
    expect(text(page(company({ planKey: "design_partner", plan: { key: "design_partner", name: "Design Partner", limits: {} }, itsPosting: true })))).not.toContain("Upgrade");
    expect(text(page(company({ planKey: "pro", plan: { key: "pro", name: "Pro", limits: {} } })))).toContain("Plan Pro Upgrade");
    expect(text(page(company({ planKey: "growth", plan: { key: "growth", name: "Growth", limits: {} } })))).toContain("Plan Growth Upgrade");
  });

  it("job boards on a plan with no ITS staff time: the team posts, no choice, and the way to ITS is an Upgrade; with it, the choice is the company's", () => {
    const none = text(page(company(), "?tab=rules"));
    expect(none).toContain("Who posts your jobs on the boards Your team posts them Upgrade");
    expect(none).not.toContain("ITS posts them for us");
    const withIts = page(company({ planKey: "pro", whoPosts: "its", itsPosting: true }), "?tab=rules");
    expect(text(withIts)).toContain("ITS posts them for us");
    expect(withIts).toMatch(/aria-pressed="true"[^>]*>ITS posts them for us/);
    // what the Connected services line says follows the same answer, not the setting alone
    expect(text(page(company(), "?tab=security"))).not.toContain("ITS posts your jobs here");
    expect(text(page(company({ whoPosts: "its", itsPosting: true }), "?tab=security"))).toContain("ITS posts your jobs here");
  });
});

describe("Home", () => {
  const page = (over: { credit?: unknown; planKey?: string; cards?: unknown[]; role?: string; room?: unknown } = {}) => render(client([
    [["brief"], { generatedAt: daysAgo(0), summary: "", cards: over.cards ?? [] }],
    [["notifications", "unread"], []],
    [["roles"], []],
    [["escalations", "mine"], []],
    [["company"], { settings: {}, planKey: over.planKey ?? "free", timezone: "America/Los_Angeles", usage: {}, trial: null, aiCredit: over.credit ?? null }],
    ...(over.room ? [[["intake", "mine"], { sessions: [], room: over.room }] as [readonly unknown[], unknown]] : []),
  ], me(over.role ?? "owner")), createElement(Home));
  const usedUp = { level: "used_up", percent: 100, resetsAt: null, notice: { title: "Your plan's AI help is used up", body: "Applications still come in and candidates can still finish. New applicants are not read by AI until you upgrade." } };
  const warning = { level: "warning", percent: 83, resetsAt: null, notice: { title: "80% of your plan's AI help used", body: "Nothing has stopped. Upgrade before it runs out." } };

  it("the AI help at 80% and used up: a row in words or a percentage, never dollars, with the Upgrade; it counts", () => {
    const html = page({ credit: warning });
    const words = text(html);
    expect(words).toContain("80% of your plan's AI help used 83% used Nothing has stopped. Upgrade See usage Why Upgrade before it runs out.");
    expect(html).toContain('<p class="page-header-sub">1 thing needs you</p>');
    expect(words).not.toMatch(/\$\d|cents/);
    const gone = text(page({ credit: usedUp }));
    expect(gone).toContain("Your plan's AI help is used up Used up");
    expect(gone).toContain("See usage");
  });

  it("nothing below the line, nothing to a hiring manager, and at the top of the plans no Upgrade, but a way to ITS: the row always has something to press", () => {
    expect(text(page({ credit: { level: null, percent: 40, resetsAt: null, notice: null } }))).not.toContain("AI help");
    expect(text(page({ credit: warning, role: "hiring_manager" }))).not.toContain("AI help");
    const top = text(page({ credit: { ...usedUp, resetsAt: "2026-12-05T00:00:00Z" }, planKey: "ultra" }));
    expect(top).toContain("Your plan's AI help is used up");
    expect(top).not.toContain("Upgrade See usage");
    expect(top).toContain("Talk to ITS See usage");
    expect(text(page({ credit: warning, planKey: "pro" }))).toContain("Upgrade See usage");
  });

  it("a card's Upgrade opens the sheet: a button of its own, with the card's other ways on beside it", () => {
    const html = page({ cards: [{ kind: "new_applicants", title: "More people applied to Dental Hygienist.", body: "Upgrade to view more candidates.", roleId: "r1", actions: [{ label: "Upgrade", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: "We would like to view more candidates." } }, { label: "See applicants", method: "GET", path: "/roles/r1/talent" }] }] });
    expect(text(html)).toContain("More people applied to Dental Hygienist.");
    expect(html).toContain(">Upgrade<");
    expect(html).toContain('href="/roles/r1/talent"');
  });

  it("the box says the plan has no room before anyone types", () => {
    const html = page({ room: { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true } });
    expect(text(html)).toContain("Who are you hiring?");
    expect(text(html)).toContain("Your Free plan includes one job. Upgrade to post more.");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    const room = page({ room: { ok: true, limit: 1, used: 0, holding: [], message: null } });
    expect(text(room)).not.toContain("includes one job");
    expect(room).not.toMatch(/<textarea[^>]*disabled=""/);
  });
});

describe("a person past the plan's candidates per job", () => {
  const vera = { id: "a1", stage: "triaged", stageLabel: "Ready", group: "in_process", source: "careers_page", createdAt: daysAgo(4), eligibility: null, ownerStage: "new", ownerStageLabel: "New", mark: null, tags: [], stageMoves: [], toldState: null, candidate: { id: "c1", name: "Vera Visible", email: "vera@people.test", phone: null, locationText: "Tustin, CA" }, extractionSummary: null, assessment: null, appliedAt: daysAgo(4), stageChangedAt: daysAgo(3), daysInStage: 3, candidateToldAt: null, decisionMessageWaiting: false, score: 91, cancelled: null };
  const counts = (total: number) => ({ total, byOwnerStage: { new: 1, longlist: 0, shortlist: 0, interviewing: 0, cancelled: 0, on_hold: 0, offer: 0, hired: 0, not_moving_forward: 0, no_ai_interview: 0 }, byGroup: { waiting_on_you: 0, in_process: 1, not_moving_forward: 0, hired: 0 }, notTold: 0, holdsEnded: 0 });
  const job = { id: "r1", title: "Dental Hygienist", status: "open", acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null, closingDate: null, proposedPacket: null, packetApproval: { pending: null, latest: null }, packetVersions: [{ version: 1, status: "approved", source: "intake_session", createdAt: daysAgo(8), createdBy: { kind: "user", id: "u1", name: "Dana Whitfield" }, changeSummary: null }], counts: { in_process: 1 }, lockedCount: 2, boardsStillUp: [], boardsShowingOldVersion: [], whoPosts: "self", decisionMaker: null, boards: [], autoActionsOnOpen: { lines: [], changeHref: "" }, pendingApprovals: [], postings: [], currentPacket: { version: 1, status: "approved", packet: { identity: { locations: [{ city: "Irvine", region: "CA" }], employmentType: "full_time", remotePolicy: "onsite" }, compensation: { basis: "hourly", min: 40, max: 52, discloseRange: true } } } };
  const cards = [{ position: 6, appliedAt: daysAgo(0) }, { position: 7, appliedAt: daysAgo(2) }];
  const people = (search = "", extra: Array<[readonly unknown[], unknown]> = []) => {
    nav.search = search;
    nav.path = "/roles/r1/talent";
    nav.params = { id: "r1" };
    return client([
      [["roles"], [{ id: "r1", title: "Dental Hygienist", status: "open", openedAt: daysAgo(7), counts: { total: 3 }, lockedCount: 2, needsYou: 0, daysOpen: 7 }]],
      [["role", "r1"], job],
      [["applications", "r1"], { applications: [vera], counts: counts(3), locked: { count: 2, cards } }],
      ...extra,
    ]);
  };

  it("one card after the list: a lock, the word, when they applied, the line and the Upgrade; never a name, initials, a score, a stage or a source", () => {
    const html = render(people(), createElement(People));
    const words = text(html);
    expect(html.match(/class="locked-card /g)).toHaveLength(2);
    expect(html).toContain('aria-label="Locked candidates"');
    expect(words).toContain("Locked Applied today · Upgrade to view more candidates. Upgrade");
    expect(words).toContain("Locked Applied 2 days ago · Upgrade to view more candidates. Upgrade");
    // the people the team can read keep their rows; the card comes after them, and the tab counts everyone
    expect(html).toContain('class="talent-name">Vera Visible</button>');
    expect(html.indexOf("Vera Visible")).toBeLessThan(html.indexOf("locked-card"));
    expect(html).toMatch(/data-label="Candidates">Candidates<\/span> <span class="count">3<\/span>/);
    // what a card is built from has nothing else in it
    const card = html.slice(html.indexOf('aria-label="Locked candidates"'));
    for (const not of ["avatar", "score", "careers", "talent-name", "stage"]) expect(card, not).not.toContain(not);
  });

  it("a group folds into one line, and nothing shows with nobody locked", () => {
    const many = { count: 9, cards: Array.from({ length: 9 }, (_, i) => ({ position: i + 6, appliedAt: daysAgo(i) })) };
    const html = render(client(), createElement(LockedCandidates, { locked: many }));
    expect(html.match(/class="locked-card /g)).toHaveLength(4);
    expect(text(html)).toContain("6 more candidates are locked Upgrade to view more candidates. Upgrade");
    expect(render(client(), createElement(LockedCandidates, { locked: { count: 0, cards: [] } }))).toBe("");
    expect(render(client(), createElement(LockedCandidates, { locked: undefined }))).toBe("");
  });

  it("on the board: beside its counts, and the same cards under it", () => {
    const summary = { total: 1, counts: { shortlist: 1 }, toSort: 0, done: 0, noAiInterview: 0, stillApplying: 0, showEveryMustHave: 0, mostMissing: null, longestWaiting: null, nextSteps: [], mustHaves: [], stricter: null, sentences: ["1 person on the board."] };
    const board = { role: { id: "r1", title: "Dental Hygienist", status: "open", currentPacketVersion: 1 }, columns: { shortlist: [], longlist: [], not_moving_forward: [] }, noAiInterview: [], stillApplying: [], summary, lockedCount: 2, generatedAt: daysAgo(0) };
    const html = render(people("view=board", [[["applications", "r1", "board"], board]]), createElement(People));
    expect(text(html)).toContain("· 2 more are locked");
    expect(html.match(/class="locked-card /g)).toHaveLength(2);
  });

  it("the close card's 'and N more you cannot see yet' is who is still in process, not every card an upgrade would open", () => {
    const close = (lockedInProcess: number) => text(render(client([[["applications", "r1"], { applications: [vera], counts: counts(3), locked: { count: 2, cards }, lockedInProcess }]]), createElement(CloseRoleCard, { roleId: "r1", initialOutcome: "filled", mayTell: true, onClose: () => undefined })));
    expect(close(1)).toContain("and 1 more you cannot see yet");
    expect(close(0)).not.toContain("you cannot see yet");
  });

  it("a direct link to them shows the same card in the panel, not an error, with no name and no way to read them", () => {
    const qc = client();
    refused(qc, ["application", "a9"], locked402);
    const html = render(qc, createElement(CandidatePanel, { id: "a9", roleId: "r1", tab: "overview", onTab: () => undefined, step: null, onStep: () => undefined, ids: null, onGo: () => undefined, onClose: () => undefined, composeOnOpen: false }));
    const words = text(html);
    expect(html).toContain('aria-label="Locked"');
    expect(words).toContain("Locked Upgrade to view more candidates. Upgrade");
    expect(words).not.toContain("Could not load this candidate");
    expect(html).not.toContain('aria-label="Candidate sections"');
    // any other failure still says so
    const other = client();
    refused(other, ["application", "a9"], new ApiError(404, "not_found", "Not found."));
    expect(text(render(other, createElement(CandidatePanel, { id: "a9", roleId: "r1", tab: "overview", onTab: () => undefined, step: null, onStep: () => undefined, ids: null, onGo: () => undefined, onClose: () => undefined, composeOnOpen: false })))).toContain("Could not load this candidate");
  });

  it("the interview sheet shows it too", () => {
    nav.path = "/interviews/i9";
    nav.params = { id: "i9" };
    const qc = client([[["interviews"], []]]);
    refused(qc, ["interview", "i9"], locked402);
    const words = text(render(qc, createElement(Interviews)));
    expect(words).toContain("Locked Upgrade to view more candidates.");
    expect(words).not.toContain("Could not load this interview");
  });

  it("the job's page counts them in the Candidates tab, as the Candidates page does; the report says how many beside the total", () => {
    nav.search = "tab=posting";
    nav.path = "/roles/r1";
    nav.params = { id: "r1" };
    expect(render(client([[["role", "r1"], job]]), createElement(RoleDetail))).toMatch(/data-label="Candidates">Candidates<\/span> <span class="count">3<\/span>/);
    const report = { generatedAt: daysAgo(0), role: null, applicants: { total: 5, locked: 2, last30Days: 5, timeZone: "America/Los_Angeles", bySource: [], byDay: [] }, stages: { total: 5, byStage: [], byGroup: {}, byOwnerStage: {} }, timeInStage: { byStage: [], waitingOnYou: { count: 0, averageDays: null, medianDays: null, longestDays: null } }, interviews: { total: 0, requested: 0, scheduled: 0, completed: 0, noShow: 0, noShowCandidate: 0, noShowInterviewer: 0, cancelled: 0, offerExpired: 0, rescheduledByCandidate: 0, awaitingDecision: 0, byRound: [] }, pendingDecisions: { count: 0, approvals: 0, candidates: 0, oldestDays: null, list: [] }, recommendationsVsDecisions: { assessed: 0, rows: [] }, overrides: { eligibilityOverrides: 0, reviewAnyway: 0, holds: 0, flaggedAssessments: 0, byAction: {} }, escalations: { total: 0, open: 0, resolved: 0, overdue: 0, medianResponseHours: null }, messages: { total: 0, sent: 0, failed: 0, bounced: 0, unknown: 0, pending: 0, candidatesAffected: 0 }, outcomes: { statement: "Outcomes are what people recorded.", hired: 0, withdrew: 0, declinedByEmployer: 0, declinedOffer: 0, noHire: 0, talentPool: 0, corrections: 0, role: null, rolesByOutcome: {}, declineReasons: [] } };
    const words = text(render(client(), createElement(ReportFigures, { report: report as never })));
    expect(words).toContain("people are locked");
    expect(text(render(client(), createElement(ReportFigures, { report: { ...report, applicants: { ...report.applicants, locked: 0 } } as never })))).not.toContain("locked");
  });
});

describe("someone locked, as ITS reads them under a grant naming them", () => {
  const person = (over: Record<string, unknown> = {}) => ({ id: "a9", roleId: "r1", stage: "received", lockedAt: daysAgo(3), allowedActions: ["reject"], blockedReasons: {}, screens: [], communications: [], packetLabels: { mustHaves: [], competencies: [], questions: [{ key: "q1", question: "Can you work Saturdays?" }], written: [] }, candidate: { firstName: "Sam", lastName: "Lockwood", email: "sam@people.test" }, ...over }) as never;

  it("the notes from a call say what they do: on the Notes tab, with no AI review and no AI interview to finish", () => {
    const words = text(render(client(), createElement(CallNotesCard, { a: person(), roleId: "r1", prominent: true })));
    expect(words).toContain("Sam is locked, so these notes go on the Notes tab and no AI review is written from them.");
    expect(words).not.toContain("Finish the AI interview");
    expect(words).not.toContain("these notes are their AI interview");
    // someone the team can read keeps what they had
    const open = text(render(client(), createElement(CallNotesCard, { a: person({ lockedAt: null }), roleId: "r1", prominent: true })));
    expect(open).toContain("these notes are their AI interview");
    expect(open).not.toContain("is locked");
  });

  it("writing to them stays, with no suggested line on the company's credit", () => {
    const tab = (a: never) => text(render(client([[["message-preview", "a9"], { to: "sam@people.test", fromName: "Bright Dental hiring team", footer: "Rae Recruiter", needsApproval: false, repliesComeBack: true, undoSeconds: 0 }]]), createElement(MessagesTab, { a, roleId: "r1", compose: { open: true, subject: "", text: "" }, setCompose: () => undefined })));
    const words = tab(person());
    expect(words).toContain("Write to Sam");
    expect(words).toContain("Send");
    expect(words).not.toContain("Suggest an opening line");
    expect(tab(person({ lockedAt: null }))).toContain("Suggest an opening line");
  });

  it("the queue's request gives its own hint, never that the notes finish an AI interview", () => {
    nav.path = "/recruiter/queue/e1";
    nav.params = { id: "e1" };
    const taken = { id: "e1", status: "claimed", kind: "candidate_issue", urgency: "normal", requiredExpertise: "candidate follow-up", summary: "A candidate asked for a person.", companyName: "Bright Dental", roleTitle: "Dental Hygienist", slaDueAt: null, slaRemainingMinutes: null, businessMinutesRemaining: null, overdue: false, createdAt: daysAgo(0), claimedByMe: true, claimed: true, accessGranted: true, why: null, companyId: "co1", roleId: "r1", applicationId: "a9", question: "Sam replied HUMAN.", contextSnapshot: { capturedAt: daysAgo(0) }, thread: [], reopenedCount: 0, grant: { id: "g1", purpose: "A candidate", expiresAt: daysAgo(-7), scope: { roleId: "r1", applicationId: "a9" } } };
    const hint = (detail: unknown) => text(render(client([[["escalations"], [taken]], [["escalation", "e1"], detail]], recruiter), createElement(RecruiterQueue)));
    const locked = hint({ ...taken, lockedForCompany: true });
    expect(locked).toContain("the company cannot read them");
    expect(locked).toContain("no AI interview or interview starts, while they are locked");
    expect(locked).not.toContain("Your notes finish the AI interview");
    expect(hint({ ...taken, lockedForCompany: false })).toContain("Your notes finish the AI interview so the scorecard is written");

    // Nobody at the company reads an answer about them while they are locked, it can once an upgrade opens them, and it never
    // reaches them: the card says so and offers the candidate instead.
    expect(locked).toContain("Write to the candidate");
    expect(locked).toContain("What you did or advised (not sent to the candidate; the company can't read it while the candidate is locked, but can if an upgrade opens them)");
    expect(locked).not.toContain("only ITS reads");
    expect(locked).toContain("Do not name them to the company");
    expect(locked).not.toContain("Write to the customer");
    expect(locked).not.toContain("The person who asked and the owners read it in full");
    expect(locked).not.toContain("the customer reads this in full");
    // Everyone else's request reads as it did.
    const open = hint({ ...taken, lockedForCompany: false });
    expect(open).toContain("Write to the customer");
    expect(open).toContain("the customer reads this in full");
    expect(open).not.toContain("Write to the candidate");
    expect(open).not.toContain("while the candidate is locked");
  });
});

describe("the AI interview waiting for the plan's AI help", () => {
  it("says so on the panel, with the answers to read and the Upgrade; nothing while it is not waiting", () => {
    const detail = (scorecard: string) => ({ screens: [{ id: "s1", scorecard }] }) as never;
    const words = text(render(client(), createElement(ScorecardWaitingCard, { detail: detail("waiting_for_credit") })));
    expect(words).toContain("Their AI interview is in, but your plan's AI help is used up, so it was not scored. Read their answers and decide yourself.");
    expect(words).toContain("Upgrade");
    expect(render(client(), createElement(ScorecardWaitingCard, { detail: detail("writing") }))).toBe("");
  });
});

describe("the job builder and the quick start with no room", () => {
  const start = (room: unknown, search: string) => {
    nav.search = search;
    nav.path = "/roles/new";
    return render(client([[["intake", "mine"], { sessions: [], room }], [["company"], { name: "Bright Dental", vertical: "dental", settings: {} }]]), createElement(NewRole));
  };
  const oneJob = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true };
  const noHelp = { ok: false, limit: 1, used: 0, holding: [], message: "Your plan's AI help is used up. Upgrade to keep going.", upgrade: true, aiHelp: true };

  it("the quick start offers no steps: nobody answers ten questions for nothing; the words and the Upgrade are there, out of jobs and out of AI help", () => {
    for (const room of [oneJob, noHelp]) {
      const html = start(room, "way=quick");
      const words = text(html);
      expect(words).toContain(room.message);
      expect(html).toContain(">Upgrade<");
      expect(words).toContain("Start a hire");
      expect(words).not.toContain("Step 1 of 10");
      expect(words).not.toContain("What is the job title?");
    }
    // a plan with room left to free still shows the steps under its alert: closing a role may bring it back
    const atATime = text(start({ ok: false, limit: 2, used: 2, holding: [], message: "Your plan includes 2 roles at a time." }, "way=quick"));
    expect(atATime).toContain("Step 1 of 10");
  });

  it("the builder says it when a draft opens, and a turn with no AI help left offers the Upgrade, never a recruiter or 'try again'", () => {
    nav.search = "session=s1";
    nav.path = "/roles/new";
    const session = { id: "s1", status: "active", roleId: null, createdAt: daysAgo(0), updatedAt: daysAgo(0), startedBy: { userId: "u1", name: "Dana Whitfield", mine: true }, messages: [], facts: { title: "Dental Hygienist", mustHaves: [], niceToHaves: [], eligibilityNotes: [], interviewers: [], dealBreakers: [], declinedCriteria: [] }, missingFacts: [], questions: [], readiness: { essentials: [], missing: [], payConfirmed: false, mayDraft: false, draftBlocker: null, hasDraft: false, draftOutOfDate: false, draftEdits: 0, openFlags: 0, mayAskForApproval: false, approvalBlockers: ["Write the draft first."] }, pay: { basis: null, benchmark: null, gap: null, stated: { min: null, max: null, ceiling: null }, confirmed: null, belowMarket: false, summary: "" }, draft: null, flags: [], ad: null, fromRole: null, progress: null };
    const seed = (over: Array<[readonly unknown[], unknown]>) => render(client([[["intake", "session", "s1"], { session }], [["members"], []], ...over]), createElement(NewRole));
    const noted = text(seed([[["intake", "mine"], { sessions: [], room: oneJob }]]));
    expect(noted).toContain("Your Free plan includes one job. Upgrade to post more.");
    // a turn refused for the AI help, as the first reply answers it
    const line = "Your plan's AI help is used up. Your draft is saved. Upgrade to keep going.";
    const html = seed([[["intake", "first-reply", "s1"], { error: "AI credit used up", recovery: line, upgrade: true, proposedActions: [{ kind: "ask", label: "Upgrade", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan", question: "We would like more AI help." } }] }]]);
    const words = text(html);
    expect(words).toContain(line);
    expect(words).not.toContain("could not reply");
    expect(html).toContain(">Upgrade<");
    expect(words).not.toContain("Bring in a recruiter");
  });
});

describe("the team's list of requests", () => {
  it("a request about the plan is about the plan, with nothing about access", () => {
    nav.search = "request=e1";
    const row = { id: "e1", kind: "ask", status: "resolved", urgency: "normal", summary: "A customer asked about their plan.", question: "We would like to move to the Pro plan.", scope: "company", topic: "plan", roleId: null, roleTitle: null, applicationId: null, candidateName: null, askedBy: { kind: "you", name: "Dana" }, createdAt: daysAgo(1), slaDueAt: daysAgo(0), firstResponseAt: daysAgo(0), resolvedAt: daysAgo(0), resolution: "Your company is on the Pro plan now.", accessExpiresAt: null, recruiterName: "Ada Admin", reopenedCount: 0, thread: [] };
    const words = text(render(client([[["escalations", "mine"], [row]]]), createElement(RecruiterRequests)));
    expect(words).toContain("Your plan");
    expect(words).not.toContain("All of your hiring");
    expect(words).not.toContain("will see");
  });
});

describe("a request about the plan in the recruiter queue", () => {
  const row = { id: "e1", status: "open", kind: "ask", urgency: "normal", requiredExpertise: "plan and billing", summary: "A customer asked about their plan.", companyName: "Bright Dental", roleTitle: null, slaDueAt: null, slaRemainingMinutes: null, businessMinutesRemaining: null, overdue: false, createdAt: daysAgo(0), claimedByMe: false, claimed: false };
  const taken = { ...row, status: "claimed", claimedByMe: true, claimed: true, accessGranted: true, why: null, companyId: "co1", roleId: null, applicationId: null, question: "We would like to move to the Pro plan.", contextSnapshot: { capturedAt: daysAgo(0), company: { name: "Bright Dental", vertical: "dental", sizeBand: "20-49" } }, thread: [{ id: "e1:question", side: "customer", kind: "question", body: "We would like to move to the Pro plan.", by: "Dana", at: daysAgo(0), raisedBy: "team" }], reopenedCount: 0, grant: null, planRequest: true };
  const queue = (detail: unknown, who: unknown) => {
    nav.path = "/recruiter/queue/e1";
    nav.params = { id: "e1" };
    return render(client([[["escalations"], [row]], [["escalation", "e1"], detail]], who), createElement(RecruiterQueue));
  };

  it("before Accept: says it opens only their words, never that it opens their hiring", () => {
    const words = text(queue({ ...row, accessGranted: false, why: "Accept to read what the customer wrote about their plan. It gives you no access to their hiring." }, recruiter));
    expect(words).toContain("Accept this request");
    expect(words).toContain("Accept to read what the customer wrote about their plan. It gives you no access to their hiring.");
    // not the line every other request has before Accept
    expect(words).not.toContain("Accept to open the full request");
    expect(words).not.toContain("Your access covers");
  });

  it("after Accept, for an administrator: what they wrote and the way to the console's Change plan; no customer's workspace and no access line", () => {
    const html = queue(taken, admin);
    const words = text(html);
    expect(words).toContain("We would like to move to the Pro plan.");
    expect(html).toContain('href="/admin/customers?open=co1&amp;tab=plan"');
    expect(words).toContain("Change the plan in the console");
    expect(words).toContain("Change the plan in the console. That tells the company and closes this request.");
    expect(words).toContain("Release");
    expect(words).not.toContain("Open in the customer's workspace");
    expect(words).not.toContain("Your access covers");
  });

  it("after Accept, for an ITS recruiter: an administrator changes it, and it opens nothing of theirs", () => {
    const words = text(queue(taken, { ...recruiter, staffAccess: null, activeCompanyId: null }));
    expect(words).toContain("An ITS administrator changes the plan in the console. You have no access to this customer's hiring.");
    expect(words).not.toContain("Change the plan in the console");
    expect(words).not.toContain("Open in the customer's workspace");
  });
});
describe("the console", () => {
  const customer = (over: Record<string, unknown> = {}) => ({ id: "co1", name: "Bright Dental", slug: "bright", vertical: "dental", sizeBand: "20-49", planKey: "free", status: "active", roles: 1, applications: 6, aiCostUsd: 1.2, lastActivityAt: daysAgo(1), escalations: 1, createdAt: daysAgo(30), settings: {}, verifiedAt: daysAgo(29), verifiedBy: null, heldMessages: 0, jobBoardsConfirmedAt: null, applyFlowDefault: "form_then_screen", screeningConversations: { used: 4, limit: null }, aiCredit: { monthly: false, spentUsd: 1.2, limitUsd: 10, percent: 12, level: null, resetsAt: null }, lockedApplicants: 3, planRequestSince: daysAgo(1), whoPosts: "self", ...over });
  const section = (search: string, rows: unknown[], plansAnswer: unknown = []) => {
    nav.search = search;
    nav.path = "/admin/customers";
    return render(client([[["admin", "customers"], rows], [["admin", "alerts"], []], [["admin", "plans"], plansAnswer]], admin), createElement(CustomersSection, { view: null, onView: () => undefined }));
  };
  const planRows = [
    { key: "free", name: "Free", prices: { monthlyUsd: 0 }, limits: { active_roles: 1, jobs_total: 1, candidates_per_job: 5, text_screens: null, ai_credit_total_cents: 1000, ai_credit_monthly_cents: null, recruiter_asks: 1, seats: 2, its_work: 0 } },
    { key: "basic", name: "Basic", prices: { monthlyUsd: 49 }, limits: { active_roles: 3, jobs_total: null, candidates_per_job: 25, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 2000, recruiter_asks: 1, seats: 3, its_work: 0 } },
    { key: "pro", name: "Pro", prices: { monthlyUsd: 149 }, limits: {} },
    { key: "ultra", name: "Ultra", prices: { monthlyUsd: 399 }, limits: {} },
    { key: "design_partner", name: "Design Partner", prices: { monthlyUsd: 0 }, limits: {} },
  ];

  it("a customer's row and Overview say the AI credit in dollars, how many are locked, and that it asked to upgrade", () => {
    const words = text(section("", [customer()]));
    expect(words).toContain("$1.20 of $10 AI credit");
    expect(words).toContain("3 locked");
    expect(words).toContain("Asked to upgrade");
    // unlimited chats on a plan the credit meters are not worth a line
    expect(words).not.toContain("chats this month");
    const overview = text(section("?open=co1", [customer()]));
    expect(overview).toContain("Plan Free · Active Change plan");
    expect(overview).toContain("$1.20 of $10 AI credit 3 locked Asked to upgrade");
    expect(overview).toContain("Job boards Their team posts them");
    const used = text(section("", [customer({ aiCredit: { monthly: true, spentUsd: 20, limitUsd: 20, percent: 100, level: "used_up", resetsAt: "2026-12-05T12:00:00Z" } })]));
    expect(used).toContain("$20.00 of $20 AI credit this month, resets December 5");
    expect(used).toContain("AI credit used up");
  });

  it("Change plan lists the plans in the API's order with what each costs and includes; a retired plan the company is on stays chosen", () => {
    const html = section("?open=co1&tab=plan", [customer()], planRows);
    const words = text(html);
    expect([...html.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["free", "basic", "pro", "ultra", "design_partner"]);
    expect(words).toContain("$0 a month · 1 job ever · 5 candidates a job · $10 AI credit in all · 1 recruiter request a month · 2 seats · the team posts its own boards");
    const retired = section("?open=co1&tab=plan", [customer({ planKey: "growth" })], planRows);
    expect([...retired.matchAll(/<option value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["free", "basic", "pro", "ultra", "design_partner", "growth"]);
    expect(retired).toMatch(/<option value="growth" selected="">Growth<\/option>/);
    // nothing to change it to is offered until another is picked
    expect(text(retired)).not.toContain("Why (required");
  });

  it("the job-board access card is for a company whose boards ITS posts", () => {
    expect(text(section("?open=co1&tab=check", [customer()]))).not.toContain("Job-board access");
    expect(text(section("?open=co1&tab=check", [customer({ whoPosts: "its" })]))).toContain("Job-board access");
  });

  it("a plan's line, its price, its dollars and the toast", () => {
    // what the older plans said, unchanged
    expect(planLimitsLine({ active_roles: 3, text_screens: 300, voice_minutes: 0, sourcing_contacts: 0, recruiter_asks: 10, seats: null })).toBe("3 active jobs · 300 AI interviews a month · 10 recruiter requests a month · unlimited seats");
    expect(planLimitsLine({ active_roles: 3, jobs_total: null, candidates_per_job: null, text_screens: 300, ai_credit_total_cents: null, ai_credit_monthly_cents: null, recruiter_asks: 10, seats: null, its_work: null })).toBe("3 active jobs · 300 AI interviews a month · 10 recruiter requests a month · unlimited seats");
    expect(planLimitsLine({ active_roles: 30, jobs_total: null, candidates_per_job: null, text_screens: null, ai_credit_total_cents: null, ai_credit_monthly_cents: 20000, recruiter_asks: 6, seats: null, its_work: null })).toBe("30 active jobs · $200 AI credit a month · 6 recruiter requests a month · unlimited seats");
    expect(planLimitsLine({})).toBe("");
    expect(planPriceLine({ monthlyUsd: 149 })).toBe("$149 a month");
    expect(planPriceLine(undefined)).toBeNull();
    expect(aiCreditDollars({ monthly: false, spentUsd: 9.87, limitUsd: 10, resetsAt: null })).toBe("$9.87 of $10 AI credit");
    expect(planChangedToast("Bright Dental", "Pro", false, 1).detail).toBe("The new limits apply at once. This month's usage stays; the reset date does not move. 1 locked candidate opens now.");
    expect(planChangedToast("Bright Dental", "Pro", false, 3).detail).toContain("3 locked candidates open now.");
    expect(planChangedToast("Bright Dental", "Pro").detail).toBe("The new limits apply at once. This month's usage stays; the reset date does not move.");
  });

  it("the toast after a move up from Free says AI help starts a new month today, the part ITS may be asked about; other allowances keep their dates", () => {
    expect(planChangedToast("Bright Dental", "Basic", false, 0, true).detail).toBe("The new limits apply at once. AI help starts a new month today; other allowances keep their dates.");
    expect(planChangedToast("Bright Dental", "Basic", false, 2, true).detail).toBe("The new limits apply at once. AI help starts a new month today; other allowances keep their dates. 2 locked candidates open now.");
    expect(planChangedToast("Bright Dental", "Basic", false, 0, true).detail).not.toContain("the reset date does not move");
  });

  it("Overview names a customer low on AI credit and one who asked to upgrade; those notices do not count as alerts waiting for a person", () => {
    const rows = attentionRows({ customers: [customer({ aiCredit: { monthly: false, spentUsd: 10, limitUsd: 10, percent: 100, level: "used_up", resetsAt: null } })] as never });
    expect(rows.map((r) => r.text)).toEqual(["Bright Dental has used all its AI credit", "1 customer asked to upgrade"]);
    expect(rows[0].action.href).toBe("/admin/customers?open=co1&tab=plan");
    expect(rows[1].action.href).toBe("/admin/customers?open=co1&tab=plan");
    for (const kind of ["billing.ai_credit_warning", "billing.ai_credit_used_up"]) expect(needsAPerson({ status: "open", kind })).toBe(false);
    expect(needsAPerson({ status: "open", kind: "ai.provider_outage" })).toBe(true);
  });
});

import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Home, the simple, Kanvis-like way (14 October 2026), as the server first draws it from answers shaped like the API's:
 * a greeting and one line on how many things need you; getting started with the steps still to do in view and the done
 * ones folded; "Needs you" as short rows (one line, the buttons, the rest behind "Why"), five at a time; "Your jobs",
 * each opening on its Candidates once live; the "Who are you hiring?" box; and the assistant's recent activity folded,
 * with "Mark all read" and the way to every earlier update still there.
 *
 * Drawn as the browser shows it once the page is its own (useIsClient answers yes): "Your jobs" comes from the rail's
 * jobs list, which the first draw leaves out on both sides (first-draw.test.ts).
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));
vi.mock("@ros/web/src/components/use-is-client", () => ({ useIsClient: () => true }));

(globalThis as { React?: typeof React }).React = React;
const { Home } = await import("@ros/web/src/pages/Home");
const { roleStatus } = await import("@ros/web/src/role-status");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const me = (role: string) => ({ user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", staffAccess: null, ai: { provider: "openai" } });
const decide = (id: string, decision: string) => ({ label: decision === "approve" ? "Yes, interview" : "Not now", method: "POST" as const, path: `/api/v1/approvals/${id}/decide`, body: { decision } });

const cards = [
  { kind: "decision", title: "Interview? Dental Hygienist", body: "Maria shows every must-have. Her license is active in California.", roleId: "r1", applicationId: "a1", approvalRequestId: "p1", actions: [decide("p1", "approve"), decide("p1", "reject"), { label: "Review first", method: "GET", path: "/roles/r1/talent?open=a1" }] },
  { kind: "decision", title: "Send this message to Ben Ortiz?", body: "Sam wrote to Ben Ortiz about Dental Hygienist (\"Friday\"):\n\nHi Ben, could you come in on Friday?", roleId: "r1", applicationId: "a2", approvalRequestId: "p2", actions: [{ label: "Yes, send it", method: "POST", path: "/api/v1/approvals/p2/decide", body: { decision: "approve" } }, { label: "Do not send", method: "POST", path: "/api/v1/approvals/p2/decide", body: { decision: "reject" } }, { label: "Open the candidate", method: "GET", path: "/roles/r1/talent?open=a2" }] },
  { kind: "stuck", title: "3 candidates have waited over 5 days (Dental Hygienist)", body: "People are waiting. Ana Diaz has waited longest, 7 days; 2 more are waiting too. Decide what comes next, put them on hold until a date, or send them a note in your own words.", roleId: "r1", applicationId: "a3", actions: [{ label: "Decide", method: "GET", path: "/roles/r1/talent?open=a3" }, { label: "Hold until a date", method: "GET", path: "/roles/r1/talent?open=a3&step=hold" }, { label: "Send a note", method: "GET", path: "/roles/r1/talent?open=a3&message=1" }, { label: "See everyone waiting", method: "GET", path: "/roles/r1/talent" }, { label: "Have a recruiter review", method: "POST", path: "/api/v1/escalations", body: { kind: "review", roleId: "r1" } }] },
  { kind: "screening", title: "Screening for Dental Hygienist: 2 invited", body: "Candidates answer in their own time; you will see the scorecard when they finish.", roleId: "r1", actions: [{ label: "See people", method: "GET", path: "/roles/r1/talent" }] },
  { kind: "draft", title: "Draft in progress: Front Desk Lead", body: "Pick up where you left off; nothing has been sent to anyone.", actions: [{ label: "Continue", method: "GET", path: "/roles/new?session=s1" }, { label: "Discard", method: "POST", path: "/api/v1/intake/sessions/s1/abandon" }] },
  { kind: "share", title: "Dental Hygienist is live. Share it now", body: "Send it to people you know, a school or a local group. Each place gets its own link.", roleId: "r1", actions: [{ label: "Share the job", method: "GET", path: "/roles/r1?tab=posting#share" }] },
  { kind: "closing_date", title: "Office Manager stops taking applications tonight", body: "Its closing date is Wednesday, October 14. New applications stop at the end of that day.", roleId: "r2", actions: [{ label: "Extend by two weeks", method: "POST", path: "/api/v1/roles/r2/closing-date", body: { closesOn: "2026-10-28" } }, { label: "Choose another date", method: "GET", path: "/roles/r2?tab=posting#closing-date" }] },
];
const setup = {
  kind: "getting_started", title: "Getting started", body: "1 of 3 done. A few steps get your hiring ready; each says why it matters.",
  actions: [{ label: "Hide these steps", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "dismiss" } }],
  gettingStarted: { verified: true, heldMessages: 0, dismissible: true, steps: [
    { key: "team", title: "Invite your team", why: "Everyone signs in with their own work account.", detail: "2 people have joined.", done: true, actions: [{ label: "Invite people", method: "GET", path: "/setup#setup-team" }] },
    { key: "first_role", title: "Start your first role", why: "Describe the job in a sentence or two.", done: false, actions: [{ label: "Start a hire", method: "GET", path: "/roles/new" }] },
    { key: "ai_rules", title: "Review what the assistant may do on its own", why: "Everything starts at the recommended settings.", done: false, actions: [{ label: "Open the AI rules", method: "GET", path: "/setup#setup-rules" }, { label: "I've reviewed them", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "policies_reviewed" } }] },
  ] },
};
const roles = [
  { id: "r1", title: "Dental Hygienist", status: "open", openedAt: "2026-10-01T00:00:00Z", createdAt: "2026-09-30T00:00:00Z", counts: { total: 6, waiting_on_you: 2 }, stageCounts: { new: 3 }, needsYou: 0, daysOpen: 13 },
  { id: "r3", title: "Front Desk Lead", status: "draft", openedAt: null, createdAt: "2026-10-10T00:00:00Z", counts: { total: 0 }, needsYou: 0, daysOpen: null },
  { id: "r4", title: "Office Manager", status: "closed", openedAt: "2026-08-01T00:00:00Z", createdAt: "2026-07-30T00:00:00Z", counts: { total: 9 }, needsYou: 0, daysOpen: null },
];
const updates = [{ id: "n1", kind: "screen.assessed", title: "Maria finished the AI interview", body: "Her answers are on her page.", action: { label: "Open", href: "/roles/r1/talent?open=a1" }, readAt: null, createdAt: "2026-10-14T09:00:00Z" }];

function render(seed: { role?: string; cards?: unknown[] | null; summary?: string; notifications?: unknown[]; roles?: unknown[]; usage?: unknown; trial?: unknown } = {}): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me(seed.role ?? "owner"));
  // `cards: null`: the brief has not come back yet
  if (seed.cards !== null) qc.setQueryData(["brief"], { generatedAt: "2026-10-14T09:00:00Z", summary: seed.summary ?? "4 things need you · 1 strong candidate ready · 1 at risk · 12 handled for you since yesterday.", cards: seed.cards ?? [setup, ...cards] });
  qc.setQueryData(["notifications", "unread"], seed.notifications ?? updates);
  qc.setQueryData(["roles"], seed.roles ?? roles);
  qc.setQueryData(["escalations", "mine"], []);
  qc.setQueryData(["company"], { settings: {}, planKey: seed.trial ? "trial" : "starter", timezone: "America/Los_Angeles", usage: seed.usage ?? {}, trial: seed.trial ?? null });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Home)));
}

describe("Home's top", () => {
  it("greets by first name, says in one line how many things need you, and keeps Start a hire and Bring in a recruiter", () => {
    const html = render();
    expect(html).toMatch(/<h1>Good (morning|afternoon|evening), Dana<\/h1>/);
    // two decisions, the long wait, the draft, the share and the closing date (not the screening chat), plus getting started
    expect(html).toContain('<p class="page-header-sub">7 things need you</p>');
    expect(html).toMatch(/<a href="\/roles\/new" class="btn primary"><svg[\s\S]*?<\/svg>Start a hire<\/a>/);
    expect(html).toContain(">Bring in a recruiter</button>");
    expect(html).not.toContain("Today");
  });

  it("says all caught up when nothing needs you, and shows the quiet day's card on its own", () => {
    const empty = { kind: "empty", title: "Nothing needs you right now", body: "Applicants are being acknowledged and screened. I will tell you when someone is worth your time.", actions: [{ label: "See your roles", method: "GET", path: "/roles" }] };
    const html = render({ cards: [empty] });
    expect(html).toContain('<p class="page-header-sub">All caught up</p>');
    expect(html).toContain("<h2 style=\"font-size:15.5px;min-width:0;overflow-wrap:anywhere\">Nothing needs you right now</h2>");
    expect(text(html)).toContain("Applicants are being acknowledged and screened.");
    expect(text(html)).toContain("I will tell you when someone is worth your time.");
    expect(html).not.toContain(">Needs you</h2>");
  });
});

describe("Needs you", () => {
  it("shows each card as a short row: the title and its word, the first sentence, the buttons, and the rest behind Why", () => {
    const html = render();
    const words = text(html);
    expect(html).toContain(">Needs you</h2>");
    expect(words).toContain("Interview? Dental Hygienist Decision Maria shows every must-have.");
    expect(html).toContain('<summary aria-label="Why: Interview? Dental Hygienist">Why</summary>');
    expect(words).toContain("Her license is active in California.");
    // the buttons answer it from here: the first is the row's strong one, the rest quiet; Start a hire stays Home's
    // only main (primary) button
    expect(html).toMatch(/<button type="button" class="btn secondary sm"[^>]*>Yes, interview<\/button>/);
    expect(html).toMatch(/<button type="button" class="btn quiet sm"[^>]*>Not now<\/button>/);
    expect(html).toContain('<a href="/roles/r1/talent?open=a1" class="btn quiet sm">Review first</a>');
    const needsYou = html.slice(html.indexOf(">Needs you</h2>"), html.indexOf('id="home-jobs"'));
    expect(needsYou).not.toContain("btn primary");
  });

  it("puts a message waiting to be sent behind 'Read the message', never only behind Why", () => {
    const html = render();
    expect(html).toContain('<summary aria-label="Read the message: Send this message to Ben Ortiz?">Read the message</summary>');
    expect(text(html)).toContain("Hi Ben, could you come in on Friday?");
  });

  it("keeps two buttons on a busy row and puts the rest under More", () => {
    const html = render();
    expect(html).toContain('<a href="/roles/r1/talent?open=a3" class="btn secondary sm">Decide</a>');
    expect(html).toContain('<a href="/roles/r1/talent?open=a3&amp;step=hold" class="btn quiet sm">Hold until a date</a>');
    expect(html).toMatch(/<button type="button" class="btn quiet sm" aria-haspopup="menu" aria-expanded="false" aria-label="More: 3 candidates have waited over 5 days \(Dental Hygienist\)">More<svg/);
    expect(html).not.toContain(">Send a note<");
  });

  it("shows five rows, then the rest behind Show N more, the ones that need a person first", () => {
    const html = render();
    expect(html).toContain("<summary>Show 2 more</summary>");
    const fold = html.indexOf("<summary>Show 2 more</summary>");
    // in the brief's order, except that the screening chat only says what is happening: it comes last
    expect(html.indexOf("Dental Hygienist is live. Share it now")).toBeLessThan(fold);
    expect(html.indexOf("Office Manager stops taking applications tonight")).toBeGreaterThan(fold);
    expect(html.indexOf("Screening for Dental Hygienist")).toBeGreaterThan(html.indexOf("Office Manager stops taking applications tonight"));
    expect(html).toContain(">AI interview</span>");
  });

  it("leads with the plan's AI interviews at 80% for an owner, without waiting for the brief, and counts it", () => {
    const usage = { text_screens: { used: 122, limit: 150 } };
    const waiting = text(render({ cards: null, usage }));
    expect(waiting).toContain("Needs you 122 of this month's 150 AI interviews used 80% used Nothing has stopped.");
    expect(waiting).toContain("Ask ITS about adding more");
    expect(waiting).toContain("See usage");
    // the rest of what it says is one click away
    expect(waiting).toContain("ITS has been told and can add more before then.");
    expect(render({ cards: [], usage })).toContain('<p class="page-header-sub">1 thing needs you</p>');
    // only owners and admins, who can talk to ITS about the plan, see it
    expect(text(render({ role: "hiring_manager", cards: [], usage }))).not.toContain("AI interviews used");
  });

  it("asks before a draft is discarded and keeps Continue on the row", () => {
    const html = render();
    expect(html).toContain('<a href="/roles/new?session=s1" class="btn secondary sm">Continue</a>');
    expect(html).toMatch(/<button type="button" class="btn quiet sm"[^>]*>Discard<\/button>/);
  });
});

describe("Home: the Trial plan's 30 days (founder decision L-02 B)", () => {
  const ending = { started: true, startedAt: "2026-10-01T19:00:00.000Z", endsAt: "2026-10-31T19:00:00.000Z", daysLeft: 6, endingSoon: true, ended: false, extendedDays: 0 };

  it("in the last 7 days, owners get one row first under Needs you: when it ends, Ask ITS to choose a plan, See plan; it counts", () => {
    const html = render({ trial: ending });
    const words = text(html);
    expect(words).toContain("Needs you Your trial ends on October 31 Trial ends soon Contact ITS to choose a plan before then; nothing stops until it ends.");
    const needsYou = html.slice(html.indexOf(">Needs you</h2>"));
    expect(needsYou.indexOf("Your trial ends on October 31")).toBeLessThan(needsYou.indexOf("Interview? Dental Hygienist"));
    expect(words).toContain("Ask ITS to choose a plan");
    expect(html).toContain('<a href="/setup" class="btn quiet sm">See plan</a>');
    expect(html).toContain('<p class="page-header-sub">8 things need you</p>');
  });

  it("once it has ended, the row says so in the owner's one line", () => {
    const words = text(render({ cards: [], trial: { ...ending, endingSoon: false, ended: true, daysLeft: 0 } }));
    expect(words).toContain("Your trial has ended Trial ended Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.");
  });

  it("says nothing earlier in the trial, and nothing to a hiring manager", () => {
    expect(text(render({ trial: { ...ending, endingSoon: false, daysLeft: 20 } }))).not.toContain("Your trial");
    expect(text(render({ role: "hiring_manager", trial: { ...ending, endingSoon: false, ended: true, daysLeft: 0 } }))).not.toContain("Your trial");
  });
});

describe("getting started", () => {
  it("keeps the steps still to do in view with their buttons, why behind a click, and the done ones folded", () => {
    const html = render();
    const words = text(html);
    expect(html).toContain('<h2 style="font-size:16px">Getting started</h2>');
    expect(words).toContain("1 of 3 done.");
    expect(html).toContain('<ol aria-label="Steps to get started"');
    expect(html).toContain("<strong>Start your first role</strong>");
    expect(html).toContain('<summary aria-label="Why: Start your first role">Why</summary>');
    // the next step's first button is the main one
    expect(html).toContain('<a href="/roles/new" class="btn primary sm">Start a hire</a>');
    expect(html).toContain(">I&#x27;ve reviewed them</button>");
    expect(html).toContain("<summary>Done (1)</summary>");
    // a done step keeps its detail line under its title, as the steps still to do show theirs
    expect(words).toContain("Invite your team 2 people have joined. Everyone signs in with their own work account.");
    expect(html).toContain(">Hide these steps</button>");
  });

  it("says ITS is confirming the company in one line, with what waits one click away and the word that says so", () => {
    const waiting = { kind: "getting_started", title: "ITS is confirming your company", body: "ITS is confirming your company. This one-time check usually takes up to a business day. Until it is done, your careers page, job pages and Google listing stay offline.", actions: [], gettingStarted: { verified: false, heldMessages: 0, dismissible: false, steps: [] } };
    const html = render({ cards: [waiting] });
    expect(html).toContain(">Waiting for ITS</span>");
    expect(html).toContain("<summary>What waits until then</summary>");
    expect(text(html)).toContain("your careers page, job pages and Google listing stay offline.");
  });
});

describe("your jobs", () => {
  it("lists the jobs in progress, each opening on its Candidates once live, with new and to-review counts", () => {
    const html = render();
    expect(html).toContain('<h2 id="home-jobs">Your jobs</h2>');
    expect(html).toContain('<a href="/roles" class="small">All jobs</a>');
    expect(html).toContain('<a href="/roles/r1/talent" class="list-item">');
    // each with the word for its status (role-status.ts), so the colour never says it alone
    expect(text(html)).toContain(`Dental Hygienist 3 new · 2 to review ${roleStatus("open").label}`);
    expect(html).toContain('<a href="/roles/r3" class="list-item">');
    expect(text(html)).toContain(`Front Desk Lead Not live yet ${roleStatus("draft").label}`);
    // a closed job is on the Jobs page, not here
    expect(html).not.toContain('href="/roles/r4');
  });

  it("is left out when there is no job in progress", () => {
    expect(render({ roles: [] })).not.toContain("Your jobs");
  });
});

describe("the rest of Home", () => {
  it("keeps the 'Who are you hiring?' box short, with the way to the job builder", () => {
    const html = render();
    expect(html).toContain("Who are you hiring?");
    expect(text(html)).toContain("Describe the job, or paste a job ad. Nothing is posted until someone approves it.");
    expect(html).toContain(">Open the job builder</a>");
    expect(html).toContain(">Start drafting</button>");
  });

  it("folds what the assistant did under Recent activity, with Mark all read, the day in numbers and every earlier update", () => {
    const html = render();
    expect(html).toContain("<summary>Recent activity (1)</summary>");
    expect(text(html)).toContain("Maria finished the AI interview");
    expect(html).toContain(">Mark all read</button>");
    expect(text(html)).toContain("12 handled for you since yesterday.");
    expect(html).toContain('<a href="/updates">See earlier updates</a>');
    expect(html).not.toContain("What the assistant did");
  });

  it("with nothing unread, still leads to every earlier update and keeps the day in numbers one click away", () => {
    const html = render({ notifications: [] });
    expect(text(html)).toContain("No new updates. See earlier updates");
    expect(html).toContain("<summary>Recent activity</summary>");
  });

  it("shows HR no Start a hire and no box, and still what needs them", () => {
    const html = render({ role: "hr", cards });
    expect(html).not.toContain(">Start a hire</a>");
    expect(html).not.toContain("Who are you hiring?");
    expect(html).toContain(">Needs you</h2>");
  });
});

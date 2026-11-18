import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ROLE_ACTION_BLOCKED, type CompanyView, type HomeView, type IntakeSessionSummary, type MembershipRole, type PlanRoom, type RoleDetail, type ShareView, type TeamView } from "@ros/contracts";
import { jobCounts, jobDetail, jobSummary } from "../../../tests/web/job-fixture";

/**
 * Home, Jobs, a job's page (its Job and Share tabs) and Settings, as the shell first draws them from answers shaped
 * like the API's. Each shows what it is given and nothing it is not: an action the API does not list is not drawn, and
 * what only an owner or an admin may change has no control for a member.
 */
const nav = vi.hoisted(() => ({ path: "/", params: {} as Record<string, string>, search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => nav.params,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Home } = await import("@ros/web/src/pages/Home");
const { Jobs } = await import("@ros/web/src/pages/Jobs");
const { Job } = await import("@ros/web/src/pages/Job");
const { Settings } = await import("@ros/web/src/pages/Settings");

const plain = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
const text = (html: string) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const me = (role: MembershipRole) => ({ user: { id: "u1", email: "owner@bright.test", name: "Sam Sample", platformRole: "none" }, auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null }, memberships: [{ companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental", role }], activeCompanyId: "co1", ai: { provider: "fake" } });
const room: PlanRoom = { ok: true, limit: 3, used: 1, holding: [], message: null };
const draft = (over: Partial<IntakeSessionSummary> = {}): IntakeSessionSummary => ({ id: "s1", status: "active", title: "Front Desk Lead", startedBy: { userId: "u1", name: "Sam Sample" }, mine: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerMessages: 2, hasDraft: false, missing: ["compensation_range"], ...over });

function client(role: MembershipRole, seed: Array<[unknown[], unknown]> = []): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["me"], me(role));
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return qc;
}
const render = (qc: QueryClient, node: ReactNode) => renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, node));
const at = (path: string, params: Record<string, string> = {}, search = "") => Object.assign(nav, { path, params, search });

describe("Home", () => {
  const home = (over: Partial<HomeView> = {}): HomeView => ({
    jobs: [
      { id: "r1", title: "Dental Assistant", status: "open", statusLabel: "Open", toReview: 3, interviewed: 2, applicants: 9 },
      { id: "r2", title: "Office Manager", status: "paused", statusLabel: "Paused", toReview: 0, interviewed: 0, applicants: 0 },
    ],
    drafts: [draft()], room, notices: [], ...over,
  });
  const draw = (view: HomeView, role: MembershipRole = "owner") => {
    at("/");
    return render(client(role, [[["home"], view]]), createElement(Home));
  };

  it("greets by first name, offers the start box, and lists the drafts and the jobs with counts that open the people they count", () => {
    const html = draw(home());
    expect(html).toMatch(/<h1>Good (morning|afternoon|evening), Sam<\/h1>/);
    expect(text(html)).toContain("Who are you hiring?");
    expect(html).toMatch(/<textarea[^>]*aria-label="Describe the job, or paste a job ad"/);
    expect([...html.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(["Drafts", "Your jobs"]);
    expect(html).toContain('<a href="/roles/new?session=s1" class="list-row-title');
    // the job's title opens its candidates; each count opens its tab
    expect(html).toMatch(/<a href="\/roles\/r1\/talent" class="list-row-title[^"]*">Dental Assistant<\/a>/);
    expect(html).toMatch(/<a href="\/roles\/r1\/talent\?tab=new" class="link-like[^"]*">3 new to review<\/a>/);
    expect(html).toMatch(/<a href="\/roles\/r1\/talent\?tab=interviewed" class="link-like[^"]*">2 finished the AI interview<\/a>/);
    const words = text(html);
    expect(words).toContain("9 applicants");
    // a paused job says so; an open one needs no word
    expect(html).toContain('<span class="pill caution sm"><span class="dot" aria-hidden="true"></span>Paused</span>');
    expect(words).toContain("No applicants yet");
    expect(html).not.toContain(">Open</span>");
    // no other cards: nothing of approvals, interviews to schedule or recent activity
    for (const gone of ["Needs you", "Getting started", "Recent activity", "Interviews"]) expect(words, gone).not.toContain(gone);
  });

  it("shows the plan's notices above everything, with Upgrade only when the API offers it", () => {
    const html = draw(home({ notices: [{ kind: "trial_ending", title: "Your trial ends on November 30.", body: "Choose a plan to keep hiring.", upgrade: true }, { kind: "ai_help_warning", title: "80% of your plan's AI help is used.", body: "Nothing has stopped.", upgrade: false }] }));
    const words = text(html);
    expect(words).toContain("Your trial ends on November 30. Choose a plan to keep hiring. Upgrade");
    expect(words).toContain("80% of your plan's AI help is used. Nothing has stopped.");
    expect(html.match(/>Upgrade<\/button>/g)).toHaveLength(1);
  });

  it("holds the start box with the plan's own line when there is no room for another job", () => {
    const full: PlanRoom = { ok: false, limit: 1, used: 1, holding: [], message: "Your Free plan includes one job. Upgrade to post more.", upgrade: true };
    const html = draw(home({ room: full }));
    expect(text(html)).toContain("Your Free plan includes one job. Upgrade to post more.");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
  });

  it("with no jobs and no drafts yet, is the greeting and the start box alone", () => {
    const html = draw(home({ jobs: [], drafts: [] }));
    expect(html).not.toContain("<h2>Your jobs</h2>");
    expect(html).not.toContain('aria-label="Your drafts"');
    expect(text(html)).toContain("Who are you hiring?");
  });
});

describe("Jobs", () => {
  const draw = (jobs: unknown[], sessions: IntakeSessionSummary[] = []) => {
    at("/roles");
    return render(client("owner", [[["roles"], jobs], [["intake", "sessions", "all"], { sessions, room }]]), createElement(Jobs));
  };

  it("lists every job with its status word, when it was published and its people, and Start a hire", () => {
    const html = draw([
      jobSummary("r1", "open", { counts: jobCounts({ new: 3, shortlisted: 1 }) }),
      { ...jobSummary("r2", "closed"), title: "Office Manager" },
      { ...jobSummary("r3", "draft"), title: "Front Desk Lead" },
    ], [draft({ id: "s2", title: null })]);
    expect(html).toContain("<h1>Jobs</h1>");
    expect(html).toMatch(/<a href="\/roles\/new" class="btn primary"><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Start a hire<\/a>/);
    // a published job opens on its candidates, a draft job on the job itself
    expect(html).toMatch(/<a href="\/roles\/r1\/talent" class="list-row-title[^"]*">Dental Assistant<\/a>/);
    expect(html).toMatch(/<a href="\/roles\/r3" class="list-row-title[^"]*">Front Desk Lead<\/a>/);
    const words = text(html);
    expect(words).toMatch(/Published [A-Z][a-z]{2} \d+ 8 days open 4 applicants 3 new 1 shortlisted/);
    expect(html).toContain('<span class="pill good sm"><span class="dot" aria-hidden="true"></span>Open</span>');
    expect(html).toContain('<span class="pill neutral sm"><span class="dot" aria-hidden="true"></span>Closed</span>');
    // the drafts not yet written into a job, each continuing in the builder
    expect(html).toContain('<a href="/roles/new?session=s2" class="list-row-title');
    expect(words).toContain("Untitled job");
  });

  it("with nothing yet, says so with the one way on", () => {
    const html = draw([]);
    expect(text(html)).toContain("No jobs yet");
    expect(html.match(/href="\/roles\/new"/g)).toHaveLength(2);
    expect(html).not.toContain('class="list-card"');
  });
});

describe("a job's page", () => {
  const draw = (role: RoleDetail, as: MembershipRole = "owner", search = "", seed: Array<[unknown[], unknown]> = []) => {
    at(`/roles/${role.id}`, { id: role.id }, search);
    return render(client(as, [[["role", role.id], role], ...seed]), createElement(Job));
  };
  const menuButton = /<button[^>]*aria-label="More for this job"[^>]*>/;

  it("has one header (title, status, where, the arrangement, the type, the pay) and three tabs as links", () => {
    const html = draw(jobDetail("r1", "open", "owner", { counts: jobCounts({ new: 2 }) }));
    expect(html).toContain("<h1>Dental Assistant</h1>");
    expect(html).toMatch(/<span class="pill good"><span class="dot[^"]*" aria-hidden="true"><\/span>Open<\/span>/);
    expect(text(html)).toContain("Irvine, CA · On site · Full time · $24–$28 an hour");
    expect([...html.matchAll(/<a href="([^"]+)" class="tab"( aria-current="page")?>/g)].map((m) => `${m[1]}${m[2] ? " (here)" : ""}`)).toEqual(["/roles/r1/talent", "/roles/r1 (here)", "/roles/r1?tab=share"]);
    // pause, the closing date and close share one menu; a published job has no Publish button
    expect(html).toMatch(menuButton);
    expect(html).not.toContain(">Publish job</button>");
  });

  it("shows the job as it was written, section by section, with one Edit and the way to see the job page", () => {
    const html = draw(jobDetail("r1", "open"));
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(["Job description", "Requirements", "Screening questions", "AI interview (about 10 minutes)", "Details", "Skills"]);
    const words = text(html);
    expect(words).toContain("Must-haves Active RDA licence Two years chairside Nice-to-haves Spanish");
    expect(words).toContain("Can you work Saturdays? Yes or no");
    expect(words).toContain("Which shift suits you? Choice: Days · Evenings · optional");
    expect(words).toContain("1 Tell us about a busy day. 2 How do you sterilise instruments? 3 Why this practice?");
    expect(words).toContain("Pay $24–$28 an hour Pay on the job page Shown");
    expect(words).toContain("Closing date No closing date");
    expect(words).toContain("Digital radiography Important");
    expect(html).toMatch(/<button type="button" class="btn secondary"[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Edit<\/button>/);
    expect(html).toContain('href="/api/v1/roles/r1/preview/page" target="_blank"');
    // what a model answer is, or why a must-have matters, is for the team's editor, never this page's words
    expect(words).not.toContain("State law.");
  });

  it("offers a draft job Publish job, and lists what the API says is still in the way", () => {
    const html = draw(jobDetail("r1", "draft", "hiring_manager", { publish: { allowed: false, blockers: [{ code: "legal_check", message: "Add the benefits: California asks for them." }] } }));
    expect(html).toMatch(/<button type="button" class="btn primary"[^>]*>Publish job<\/button>/);
    expect(text(html)).toContain("Before this job can be published Add the benefits: California asks for them.");
  });

  it("draws nothing the API does not list: a closed job has no menu and no Publish, and Edit is greyed with why", () => {
    const html = draw(jobDetail("r1", "closed"));
    expect(html).not.toMatch(menuButton);
    expect(html).not.toContain(">Publish job</button>");
    expect(html).toMatch(/<button type="button" class="btn secondary" disabled=""[^>]*><svg(?:(?!<\/svg>)[\s\S])*<\/svg>Edit<\/button>/);
    expect(text(html)).toContain(ROLE_ACTION_BLOCKED.closed);
  });

  it("says a job that is not there plainly, with the way back to Jobs", async () => {
    at("/roles/gone", { id: "gone" });
    const qc = client("owner");
    const { ApiError } = await import("@ros/web/src/api/client");
    await qc.prefetchQuery({ queryKey: ["role", "gone"], queryFn: () => Promise.reject(new ApiError(404, "not_found", "Not found.")) });
    const html = render(qc, createElement(Job));
    expect(text(html)).toContain("We could not find that job");
    expect(html).toContain('<a href="/roles" class="btn primary">Go to Jobs</a>');
  });

  describe("the Share tab", () => {
    const share = (over: Partial<ShareView> = {}): ShareView => ({
      roleId: "r1", jobUrl: "https://jobs.test/careers/bright/jobs/r1", public: true, notPublicLine: null, state: "ready", stateLine: null,
      posts: [
        { channel: "linkedin", label: "LinkedIn post", text: "We are hiring a dental assistant in Irvine.", edited: false, writtenAt: "2026-11-10T16:00:00.000Z", applyUrl: "https://jobs.test/careers/bright/jobs/r1?src=linkedin" },
        { channel: "indeed", label: "Indeed post", text: "Dental Assistant, Irvine, CA. $24 to $28 an hour.", edited: true, writtenAt: "2026-11-10T16:00:00.000Z", applyUrl: "https://jobs.test/careers/bright/jobs/r1?src=indeed" },
      ],
      ...over,
    });
    const tab = (view: ShareView) => draw(jobDetail("r1", "open"), "owner", "tab=share", [[["share", "r1"], view]]);

    it("has the Apply link with Copy, then each post in a box with Copy and Write again, and the link that post should carry", () => {
      const html = tab(share());
      expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(["Apply link", "LinkedIn post", "Indeed post"]);
      expect(html).toContain('<input id="apply-link" class="input" readOnly="" value="https://jobs.test/careers/bright/jobs/r1"/>');
      expect(html).toMatch(/<textarea id="post-linkedin"[^>]*>We are hiring a dental assistant in Irvine\.<\/textarea>/);
      expect(html).toContain('value="https://jobs.test/careers/bright/jobs/r1?src=linkedin"');
      expect(html).toContain('value="https://jobs.test/careers/bright/jobs/r1?src=indeed"');
      expect(html.match(/aria-label="Copy the (LinkedIn|Indeed) post"/g)).toHaveLength(2);
      expect(html.match(/>Write again<\/button>/g)).toHaveLength(2);
      // nothing typed yet: no Save
      expect(html).not.toContain(">Save</button>");
      // the Share tab is the current one
      expect(html).toContain('<a href="/roles/r1?tab=share" class="tab" aria-current="page">');
    });

    it("says the posts are being written, with nothing to copy yet", () => {
      const html = tab(share({ state: "writing", posts: share().posts.map((p) => ({ ...p, text: null, writtenAt: null, edited: false })) }));
      expect(html.match(/<span class="spinner" aria-hidden="true"><\/span>Writing/g)).toHaveLength(2);
      expect(html).toContain('placeholder="Being written…"');
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Copy the LinkedIn post"|<button[^>]*aria-label="Copy the LinkedIn post"[^>]*disabled=""/);
    });

    it("shows the API's own line when the job page is not public, or the posts could not be written", () => {
      expect(text(tab(share({ public: false, notPublicLine: "Publish the job to share it.", state: null, posts: [] })))).toContain("Publish the job to share it.");
      expect(text(tab(share({ state: "failed", stateLine: "The posts could not be written. Press Write again, or write your own." })))).toContain("The posts could not be written. Press Write again, or write your own.");
    });
  });
});

describe("Settings", () => {
  const company = (over: Partial<CompanyView> = {}): CompanyView => ({
    id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "1-19", timezone: "America/Los_Angeles", locations: [{ city: "Irvine", region: "CA", country: "US" }], website: "brightdental.example", logoUrl: null,
    about: { text: "A family dental practice in Irvine, open since 2009.", approvedAt: "2026-11-01T10:00:00.000Z", aiAssisted: false }, aboutDraft: null, benefitsSummary: "Health, dental and paid time off",
    hiringContact: null, contactShown: { email: "hiring@its.example", name: null, kind: "its" }, careersUrl: "https://jobs.test/careers/bright-dental",
    plan: { key: "basic", name: "Basic", usage: [{ key: "jobs_total" as never, label: "Jobs", used: 1, limit: 3, unit: "count", resetsAt: null, words: "1 of 3 jobs" }, { key: "ai_credit" as never, label: "AI help", used: 40, limit: 100, unit: "percent", resetsAt: null, words: "AI help: 40% used" }], aiCredit: null, trial: null, mayUpgrade: true, upgradeRequestedAt: null },
    ...over,
  });
  const team = (role: MembershipRole, over: Partial<TeamView> = {}): TeamView => {
    const manages = role !== "hiring_manager";
    return {
      members: [
        { userId: "u1", name: "Sam Sample", email: "owner@bright.test", role, roleLabel: role === "owner" ? "Owner" : role === "admin" ? "Admin" : "Member", you: true, mayChange: false, changeBlockedReason: "Nobody changes their own membership." },
        { userId: "u2", name: "Alex Example", email: "alex@bright.test", role: "hiring_manager", roleLabel: "Member", you: false, mayChange: manages, changeBlockedReason: manages ? null : "Only an owner or an admin can do this." },
      ],
      invitations: manages ? [{ id: "i1", email: "new.person@example.com", name: null, role: "hiring_manager", roleLabel: "Member", invitedBy: "Sam Sample", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(), emailState: "sent" }] : [],
      seats: { used: 3, limit: 3, full: false, line: null },
      viewer: { userId: "u1", role, mayManage: manages, grantableRoles: role === "owner" ? ["owner", "admin", "hiring_manager"] : role === "admin" ? ["admin", "hiring_manager"] : [], mayLeave: role !== "owner", leaveBlockedReason: role === "owner" ? "The last owner stays." : null },
      ...over,
    };
  };
  const prefs = { emailUpdates: true, email: "owner@bright.test", alwaysEmailedLine: "Notices about your account, your plan and your team are always emailed." };
  const draw = (role: MembershipRole, seed: { company?: CompanyView; team?: TeamView; search?: string } = {}) => {
    at("/setup", {}, seed.search ?? "");
    return render(client(role, [[["company"], seed.company ?? company()], [["team"], seed.team ?? team(role)], [["notifications", "preferences"], prefs]]), createElement(Settings));
  };

  it("is one page with four sections, in order, and no tabs", () => {
    const html = draw("owner");
    expect(html).toContain("<h1>Settings</h1>");
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1])).toEqual(["Company", "Team", "Plan", "Email updates"]);
    expect([...html.matchAll(/<div id="(setup-[a-z]+)"/g)].map((m) => m[1])).toEqual(["setup-company", "setup-team", "setup-plan", "setup-notifications"]);
    expect(html).not.toContain('role="tablist"');
  });

  it("shows the company's details, what candidates read about it, who they write to and the careers link; an owner may change them", () => {
    const html = draw("owner");
    const words = text(html);
    expect(words).toContain("Name Bright Dental Website brightdental.example Location Irvine, CA Time zone Pacific time (Los Angeles) People 1-19 Benefits Health, dental and paid time off");
    expect(words).toContain("A family dental practice in Irvine, open since 2009.");
    expect(words).toContain("hiring@its.example (the ITS inbox, until you set your own)");
    expect(html).toContain('<input id="careers-link" class="input" readOnly="" value="https://jobs.test/careers/bright-dental"/>');
    expect(html.match(/>Edit<\/button>/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('<input id="co-logo" class="input" type="file" accept="image/png,image/jpeg,image/webp"/>');
    // a member reads the same, with nothing to change
    const member = draw("hiring_manager");
    expect(text(member)).toContain("Name Bright Dental");
    expect(member).not.toContain(">Edit</button>");
    expect(member).not.toContain('type="file"');
    expect(member).not.toContain("Take it off the job pages");
  });

  it("lets someone who manages the team invite with the roles the API allows, change a person it marks, and see the open invitations", () => {
    const html = draw("owner");
    const section = html.slice(html.indexOf('id="setup-team"'), html.indexOf('id="setup-plan"'));
    const words = text(section);
    expect(words).toContain("Sam Sample (you) owner@bright.test Owner");
    expect(section).toMatch(/<select class="select[^"]*" aria-label="Role of Alex Example">(?:(?!<\/select>)[\s\S])*<\/select>/);
    expect([.../<select class="select[^"]*" aria-label="Role of Alex Example">([\s\S]*?)<\/select>/.exec(section)?.[1].matchAll(/>([A-Za-z]+)<\/option>/g) ?? []].map((m) => m[1])).toEqual(["Owner", "Admin", "Member"]);
    expect(section).toContain('aria-label="Remove Alex Example"');
    // nobody changes their own membership: no control on their own row, and the reason said
    expect(section).not.toContain('aria-label="Role of Sam Sample"');
    expect(words).toContain("Nobody changes their own membership.");
    expect(words).toMatch(/Invited, not yet in new\.person@example\.com Member · Link works until [A-Z][a-z]{2} \d+ · Email sent/);
    expect(section).toContain('aria-label="Send the invitation to new.person@example.com again"');
    expect(words).toContain("Invite someone");
    expect([.../<select id="invite-role" class="select">([\s\S]*?)<\/select>/.exec(section)?.[1].matchAll(/>([A-Za-z]+)<\/option>/g) ?? []].map((m) => m[1])).toEqual(["Owner", "Admin", "Member"]);
    // the last owner cannot leave: the reason, not the button
    expect(words).toContain("The last owner stays.");
    expect(section).not.toContain(">Leave this company</button>");
    // an admin may give Admin and Member, never Owner
    const admin = draw("admin");
    expect([.../<select id="invite-role" class="select">([\s\S]*?)<\/select>/.exec(admin)?.[1].matchAll(/>([A-Za-z]+)<\/option>/g) ?? []].map((m) => m[1])).toEqual(["Admin", "Member"]);
  });

  it("shows a member the team with no invite form, no role control and no invitations, and the way to leave", () => {
    const html = draw("hiring_manager");
    const section = html.slice(html.indexOf('id="setup-team"'), html.indexOf('id="setup-plan"'));
    expect(text(section)).toContain("Alex Example alex@bright.test Member");
    expect(section).not.toContain("<select");
    expect(section).not.toContain("Invite someone");
    expect(section).not.toContain("Invited, not yet in");
    expect(section).not.toContain('aria-label="Remove');
    expect(section).toMatch(/<button type="button" class="btn ghost sm"[^>]*>Leave this company<\/button>/);
  });

  it("says the plan's own line and offers Upgrade in place of the invite form when every place is in use", () => {
    const html = draw("owner", { team: team("owner", { seats: { used: 3, limit: 3, full: true, line: "Your plan includes 3 people. Upgrade to add more." } }) });
    const section = html.slice(html.indexOf('id="setup-team"'), html.indexOf('id="setup-plan"'));
    expect(text(section)).toContain("Your plan includes 3 people. Upgrade to add more. Upgrade");
    expect(section).not.toContain("Invite someone");
  });

  it("shows the plan with what is used in the server's words, and Upgrade or the day it was asked for", () => {
    const section = (html: string) => html.slice(html.indexOf('id="setup-plan"'), html.indexOf('id="setup-notifications"'));
    const html = section(draw("owner"));
    expect(text(html)).toContain("Plan Upgrade Basic 1 of 3 jobs AI help: 40% used");
    expect(html).not.toMatch(/\$\d/);
    const asked = section(draw("owner", { company: company({ plan: { ...company().plan, upgradeRequestedAt: "2026-11-18T12:00:00.000Z" } }) }));
    expect(text(asked)).toContain("Request sent on November 18, 2026");
    expect(asked).not.toContain(">Upgrade</button>");
    // a plan nobody may ask to change from here offers nothing
    expect(section(draw("owner", { company: company({ plan: { ...company().plan, mayUpgrade: false } }) }))).not.toContain("Upgrade");
    // the notice when the AI help runs low is the server's
    const low = section(draw("owner", { company: company({ plan: { ...company().plan, aiCredit: { level: "warning" as never, percent: 80, resetsAt: null, notice: { title: "80% of your plan's AI help is used.", body: "Nothing has stopped." } } } }) }));
    expect(text(low)).toContain("80% of your plan's AI help is used. Nothing has stopped.");
  });

  it("has one switch for emails, the address they go to, the line about what is always emailed, and the way to every update", () => {
    const html = draw("hiring_manager");
    const section = html.slice(html.indexOf('id="setup-notifications"'));
    expect(section).toContain('<label class="check"><input type="checkbox" checked=""/>');
    expect(text(section)).toContain("Email me updates To owner@bright.test Notices about your account, your plan and your team are always emailed.");
    expect(section).toMatch(/<a href="\/updates" class="text-link">All updates/);
    expect(section.match(/type="checkbox"/g)).toHaveLength(1);
  });

  it("says what came of confirming it's you on the way back", () => {
    expect(text(draw("owner", { search: "reauth=ok" }))).toContain("Thanks, that is confirmed.");
    expect(text(draw("owner", { search: "reauth=mismatch" }))).toContain("That sign-in was a different account.");
    expect(text(draw("owner"))).not.toContain("confirmed");
  });
});

import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Settings (the page at /setup) as the shell first draws it, after the simple-screens wave (14 Oct 2026): one tab strip
 * (Company, Team, Notifications, Hiring rules, Security) instead of thirteen cards on one page; `?tab=` and the
 * calendar coming back open their tab; every card stays on the page, hidden until its tab is chosen; each card says one
 * line, with the rest under "How this works"; and the AI rules show the choices, with the work done the same way for
 * everyone one click away.
 */
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/setup",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

(globalThis as { React?: typeof React }).React = React;
const { Setup } = await import("@ros/web/src/pages/Setup");

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const company = { id: "co1", name: "Bright Dental", slug: "bright-dental", vertical: "dental", sizeBand: "20-49", timezone: "America/Los_Angeles", planKey: "pilot", status: "active", locations: [{ city: "Irvine", region: "CA" }], settings: { verifiedAt: "2026-10-01T00:00:00.000Z" }, integrations: [{ kind: "jobboard", provider: "linkedin_basic", status: "not_connected" }], ai: { provider: "fake" }, usage: { active_roles: { used: 1, limit: 3 }, text_screens: { used: 4, limit: 50, resetsAt: "2026-10-30T12:00:00.000Z" } } };
const policy = (actionType: string, group: string, over: Record<string, unknown> = {}) => ({ group, actionType, level: "approval", approverRoles: ["owner"], source: "default", locked: false, available: true, settable: true, does: null, defaultLevel: "approval", minLevel: null, maxLevel: null, ...over });
const policies = [
  // fixed since 20 Oct 2026 (R20-4): every applicant gets the AI interview, so there is nothing to choose
  policy("application.invite_screen", "Applicants", { level: "auto", defaultLevel: "auto", maxLevel: "auto", settable: false, does: "Every applicant is invited to a short AI interview as soon as their résumé is read." }),
  policy("application.recommend_interview", "Applicants", { level: "approval", defaultLevel: "approval" }),
  policy("application.triage", "Applicants", { level: "auto", settable: false, does: "The assistant reads every applicant and writes an assessment for you to review. It never decides anything with it." }),
  policy("application.reject_on_assessment", "Applicants", { level: "human_only", locked: true, settable: false }),
  policy("disposition.send", "Messages"),
  policy("offer.send", "Offers", { available: false, settable: false }),
];
const alerts = {
  groups: [{ group: "candidates", label: "Candidates", description: "New applicants and their answers.", cadence: "daily", defaultCadence: "daily" }],
  alwaysSent: [{ label: "A candidate asks to talk to a person", why: "Someone is waiting for a reply." }],
  digest: { timezone: "America/Los_Angeles", hour: 8, weekday: "Monday" },
  email: "dana@bright.test",
};

function page(opts: { role?: string; search?: string; members?: unknown[]; company?: Record<string, unknown> } = {}) {
  nav.search = opts.search ?? "";
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  qc.setQueryData(["company"], opts.company ?? company);
  qc.setQueryData(["me"], { user: { id: "u1" }, activeCompanyId: "co1", memberships: [{ companyId: "co1", role: opts.role ?? "owner", companyName: "Bright Dental" }] });
  qc.setQueryData(["public-profile"], { hiringContact: null, contactShown: { email: "help@its.test", name: null, kind: "its" } });
  qc.setQueryData(["policies"], policies);
  qc.setQueryData(["notification-preferences"], alerts);
  qc.setQueryData(["members"], opts.members ?? [{ userId: "u1", role: opts.role ?? "owner", status: "active", email: "dana@bright.test", name: "Dana Whitfield", calendar: null, availability: null, schedulable: false }]);
  qc.setQueryData(["invitations"], []);
  qc.setQueryData(["me", "calendar"], { connection: null, availability: null, providers: [{ key: "google", status: "fake" }] });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(Setup)));
}
/** Whether a tab's panel is on view: its wrapper carries `hidden` until the tab is chosen. */
const panelShown = (html: string, tab: string) => {
  const at = html.indexOf(`<div role="tabpanel" id="settings-panel-${tab}"`);
  expect(at).toBeGreaterThan(-1);
  return !html.slice(Math.max(0, at - 20), at).includes("hidden");
};

describe("Settings' tabs", () => {
  it("is called Settings, with one strip of five tabs, Company first and chosen", () => {
    const html = page();
    expect(html).toContain("<h1>Settings</h1>");
    expect(html).toContain('<div role="tablist" aria-label="Settings" class="tabs"');
    const tabs = [...html.matchAll(/role="tab" id="settings-tab-([a-z]+)"[^>]*aria-selected="(true|false)"/g)].map((m) => [m[1], m[2]]);
    expect(tabs).toEqual([["company", "true"], ["team", "false"], ["notifications", "false"], ["rules", "false"], ["security", "false"]]);
    expect(text(html)).toContain("Company Team Notifications Hiring rules Security");
    expect(panelShown(html, "company")).toBe(true);
    for (const t of ["team", "notifications", "rules", "security"]) expect(panelShown(html, t), t).toBe(false);
    // no side menu of thirteen links any more
    expect(html).not.toContain('aria-label="Setup sections"');
  });

  it("keeps every card on the page under its tab, so old #links still find their card", () => {
    const html = page();
    for (const id of ["setup-company", "setup-profile", "setup-team", "setup-notifications", "setup-availability", "setup-shortcut", "setup-rules", "setup-boards", "setup-new-times", "setup-sessions", "setup-recruiters", "setup-services", "setup-audit"]) {
      expect(html, id).toContain(`<div id="${id}" class="setup-section" tabindex="-1">`);
    }
    expect(html.indexOf('id="settings-panel-notifications"')).toBeLessThan(html.indexOf('id="setup-availability"'));
    expect(html.indexOf('id="setup-availability"')).toBeLessThan(html.indexOf('id="settings-panel-rules"'));
  });

  it("opens the tab named in ?tab=, and My availability when the calendar connection comes back", () => {
    const rules = page({ search: "tab=rules" });
    expect(rules).toMatch(/id="settings-tab-rules" class="tab" aria-selected="true"/);
    expect(panelShown(rules, "rules")).toBe(true);
    expect(panelShown(rules, "company")).toBe(false);
    const back = page({ search: "calendar=connected" });
    expect(panelShown(back, "notifications")).toBe(true);
    expect(text(back)).toContain("Calendar connected. Interviews now use your real free time.");
  });

  it("opens on alerts and availability for an interviewer, who has no shortcut or audit history", () => {
    const html = page({ role: "interviewer" });
    expect(panelShown(html, "notifications")).toBe(true);
    expect(panelShown(html, "company")).toBe(false);
    expect(html).not.toContain('id="setup-shortcut"');
    expect(html).not.toContain('id="setup-audit"');
  });
});

describe("each card says one line, the rest one click away", () => {
  it("the company card shows who you are, the plan and its usage (where 'See usage' lands); type, size, hours and notices fold under one summary", () => {
    const html = page();
    const words = text(html);
    expect(words).toContain("Name Bright Dental ITS check Confirmed Careers page /careers/bright-dental");
    expect(words).toContain("Type, size, hours and notices Business type Dental practice or group");
    expect(words).toContain("active jobs: 1 of 3 · AI interviews this month: 4 of 50");
    // and when the monthly ones start again from zero (Wave S2 F1); roles never reset
    expect(words).toContain("AI interviews this month: 4 of 50 Monthly allowances reset on October 30.");
    // the usage is on the card's first view, not inside the fold
    const card = html.slice(html.indexOf('<div id="setup-company"'), html.indexOf('<div id="setup-profile"'));
    expect(card.indexOf("Usage")).toBeGreaterThan(-1);
    expect(card.indexOf("Usage")).toBeLessThan(card.indexOf("<details"));
  });

  it("the team card offers your own hours when nobody can book you, and says who can do what when asked", () => {
    const html = page();
    expect(html).toContain('<a class="small" href="#setup-availability">Set your hours</a>');
    const words = text(html);
    expect(words).toContain("Who can do what Owner: Everything, including making other owners.");
    expect(words).toContain("Interviewers never see pay.");
    expect(page({ members: [{ userId: "u1", role: "owner", status: "active", email: "dana@bright.test", name: "Dana Whitfield", calendar: null, availability: { timezone: "America/Los_Angeles", windows: 5 }, schedulable: true }] })).not.toContain("Set your hours");
  });

  it("email alerts: the choices first; what always goes and when summaries arrive one click away", () => {
    const words = text(page());
    expect(words).toContain("Choose which updates also reach you by email at dana@bright.test.");
    expect(words).toContain("Always emailed at once (1) These go out whatever you choose above. A candidate asks to talk to a person.");
    expect(words).toContain("How this works Every update shows on Home and in your updates.");
    expect(words).toContain("Daily summaries arrive at 8:00 AM, Los Angeles time");
  });

  it("the AI rules: the choices in their groups, the fixed work and the planned rules folded", () => {
    const html = page();
    const words = text(html);
    expect(words).toContain("Choose how much the AI does without asking you. How this works What the product does today");
    // the rule group removed on 20 Oct (R20-4) does not come back under its old name
    expect(html).not.toContain('aria-label="Invite an applicant to the screening chat"');
    expect(html).not.toContain('aria-label="Invite every applicant to the AI interview"');
    expect(words).toContain("Decline a candidate on judgment always a person");
    expect(words).toContain("What it always does the same way (2)");
    expect(words).toContain("Read and assess applicants (information only) Nothing to choose The assistant reads every applicant");
    expect(words).toContain("Invite every applicant to the AI interview Nothing to choose Every applicant is invited to a short AI interview as soon as their résumé is read.");
    expect(words).toContain("Coming later (1)");
    // the decision message: short on view, and what happens after five working days one click away (D-03 = A)
    expect(words).toContain("Send the decision message when someone presses Send");
    expect(words).toMatch(/What each choice does Declining never sends anything by itself\. Do it: .*five working days after a decision, the standard message goes by itself/);
  });

  it("the security cards: one line each, the explanations under How this works", () => {
    const words = text(page());
    expect(words).toContain("Every place you are signed in. Sign out any you do not recognise.");
    expect(words).toContain("Which ITS recruiters can see your hiring, and until when. How this works A recruiter gets access when your team asks for one");
    expect(words).toContain("Who did what in your workspace, newest first.");
    // services in plain words, not code names
    expect(words).toContain("Job board LinkedIn Not connected");
  });
});

describe("Settings: the Trial plan's 30 days and 3 people (founder decision L-02 B)", () => {
  const ending = { started: true, startedAt: "2026-10-01T19:00:00.000Z", endsAt: "2026-10-31T19:00:00.000Z", daysLeft: 6, endingSoon: true, ended: false, extendedDays: 0 };
  const onTrial = (trial: Record<string, unknown>, seats = { used: 2, limit: 3 }) => ({ ...company, planKey: "trial", status: "trial", plan: { key: "trial", name: "Trial", limits: { seats: 3 } }, usage: { ...company.usage, seats }, trial });

  it("the Plan line says until when, on the company's calendar, and the usage counts people with invitations not yet answered", () => {
    const words = text(page({ company: onTrial({ ...ending, endingSoon: false, daysLeft: 20 }) }));
    expect(words).toContain("Plan Trial · trial until October 31");
    expect(words).toContain("people (invitations not yet answered count too): 2 of 3");
    expect(words).not.toContain("Your trial ends on");
  });

  it("owners see when it ends in its last 7 days, and the one line once it has ended; a hiring manager sees neither", () => {
    expect(text(page({ company: onTrial(ending) }))).toContain("Your trial ends on October 31. Contact ITS to choose a plan before then; nothing stops until it ends.");
    const ended = text(page({ company: onTrial({ ...ending, endingSoon: false, ended: true, daysLeft: 0 }) }));
    expect(ended).toContain("Your trial has ended. New applications are paused until a plan is chosen. Contact ITS to choose a plan.");
    expect(ended).toContain("Plan Trial · trial ended on October 31");
    const hm = text(page({ role: "hiring_manager", company: onTrial({ ...ending, endingSoon: false, ended: true, daysLeft: 0 }) }));
    expect(hm).not.toContain("New applications are paused until a plan is chosen.");
  });

  it("a trial waiting for the ITS check says its 30 days start then", () => {
    expect(text(page({ company: onTrial({ started: false, startedAt: null, endsAt: null, daysLeft: null, endingSoon: false, ended: false, extendedDays: 0 }) }))).toContain("Plan Trial · your 30-day trial starts when ITS confirms your company");
  });

  it("the Team tab's invite form knows the people: all 3 in use, Invite waits and says why", () => {
    const html = page({ search: "?tab=team", company: onTrial(ending, { used: 3, limit: 3 }) });
    expect(text(html)).toContain("Your trial includes 3 people: 3 in use, counting invitations not yet answered.");
    expect(text(html)).toContain("Your trial includes 3 people. Choose a plan to add more.");
    expect(html).toMatch(/<button type="submit" class="btn primary" disabled=""[^>]*>Invite<\/button>/);
  });
});

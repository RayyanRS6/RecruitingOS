import { readFileSync } from "node:fs";
import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../lib/session";

/**
 * The signed-in frame's rail (Wave DS; plain words of 14 October 2026), rendered as the server first sends it: the
 * company chip, "Start a hire" only for the roles that may start one, Home, Jobs (with the jobs in progress underneath,
 * a live one opening on its Candidates), Candidates, Interviews and Settings, the fold to icons on a job's pages, and
 * Sign out always there.
 */
const nav = vi.hoisted(() => ({ path: "/" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({ default: (props: { href: string; children?: ReactNode } & Record<string, unknown>) => createElement("a", props, props.children) }));

// The shell's tsconfig leaves JSX to Next.js ("preserve"), so under the test runner it compiles to React.createElement.
(globalThis as { React?: typeof React }).React = React;
const { AppShell, RAIL_COLLAPSED_KEY, railCollapsedIn, rememberRailCollapsed } = await import("./AppShell");

const company = { companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental" };
function meAs(role: string | null, extra: Partial<Me> = {}): Me {
  return {
    user: { id: "u1", email: "dana@bright.test", name: "Dana Whitfield", platformRole: "none" },
    auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null },
    memberships: role ? [{ ...company, role }] : [],
    activeCompanyId: role ? "co1" : null,
    staffAccess: null,
    ai: { provider: "openai" },
    ...extra,
  };
}
const roles = [
  { id: "r-open", title: "Dental Hygienist", status: "open", openedAt: "2026-10-01T00:00:00Z", counts: { total: 6 }, needsYou: 0, daysOpen: 3 },
  { id: "r-draft", title: "Front Desk Lead", status: "draft", openedAt: null, counts: { total: 0 }, needsYou: 0, daysOpen: null },
  { id: "r-closed", title: "Office Manager", status: "closed", openedAt: null, counts: { total: 2 }, needsYou: 0, daysOpen: null },
];

function renderWith(me: Me, seed: { roles?: unknown } = {}): { html: string; qc: QueryClient } {
  const qc = new QueryClient();
  if (seed.roles) qc.setQueryData(["roles"], seed.roles);
  // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(AppShell, { me, children: createElement("p", null, "page") })));
  return { html, qc };
}
const render = (me: Me, seed: { roles?: unknown } = {}) => renderWith(me, seed).html;
/** Whether the rail's roles query may fetch: its observer options as the shell set them during the render. */
function rolesQueryEnabled(qc: QueryClient): boolean | undefined {
  const query = qc.getQueryCache().find({ queryKey: ["roles"] });
  return (query?.options as { enabled?: boolean } | undefined)?.enabled;
}

describe("the rail", () => {
  beforeEach(() => {
    nav.path = "/";
  });

  it("shows an owner the company chip, Start a hire with its N hint, the jobs in progress and Sign out", () => {
    const html = render(meAs("owner"), { roles });
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain("Bright Dental");
    expect(html).toContain("Owner");
    expect(html).toContain('aria-label="Company settings"');
    expect(html).toMatch(/<a href="\/roles\/new"[^>]*aria-label="Start a hire"[^>]*aria-keyshortcuts="N"/);
    expect(html).toContain('<kbd class="kbd" aria-hidden="true">N</kbd>');
    // the open job with a green dot and its count, opening on its Candidates; the draft with a grey dot, opening on the
    // job itself; never the closed one
    expect(html).toContain('<ul class="rail-sub" aria-label="Jobs in progress">');
    expect(html).toContain('href="/roles/r-open/talent"');
    expect(html).toContain('href="/roles/r-draft"');
    expect(html).not.toContain('href="/roles/r-draft/talent"');
    expect(html).toContain('<span class="dot good" aria-hidden="true"></span><span class="rail-sub-title">Dental Hygienist</span>');
    expect(html).toContain(", live, 6 applicants");
    expect(html).toContain('<span class="dot" aria-hidden="true"></span><span class="rail-sub-title">Front Desk Lead</span>');
    // the draft says so in a word too: the dot's colour never carries the status alone
    expect(html).toContain('<span class="rail-sub-title">Front Desk Lead</span><span class="rail-count rail-tag" aria-hidden="true">Draft</span>');
    expect(html).not.toContain("Office Manager");
    expect(html).toContain("All jobs");
    // the plain words, in this order; the routes keep their names
    const order = [["Home", "/"], ["Jobs", "/roles"], ["Candidates", "/talent"], ["Interviews", "/interviews"], ["Settings", "/setup"]];
    for (const [link, href] of order) expect(html, link).toMatch(new RegExp(`<a href="${href}"[^>]*>(<svg[\\s\\S]*?</svg>)${link}</a>`));
    const at = order.map(([link]) => html.indexOf(`</svg>${link}</a>`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const old of ["Today", "Talent", "Setup", "All roles"]) expect(html, old).not.toContain(`>${old}<`);
    expect(html).toContain("dana@bright.test");
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain('aria-expanded="false" aria-controls="rail-links"');
    expect(html).not.toContain("AI:");
    expect(html).not.toContain('data-rail="compact"');
  });

  it("offers Start a hire only to the roles that may start one", () => {
    for (const role of ["owner", "admin", "hiring_manager", "recruiter"]) expect(render(meAs(role)), role).toContain('aria-label="Start a hire"');
    for (const role of ["hr", "interviewer"]) expect(render(meAs(role)), role).not.toContain('aria-label="Start a hire"');
  });

  it("shows an interviewer the jobs the API gives them (only the ones they interview for), without counts and without Candidates", () => {
    const theirs = [{ ...roles[0], counts: { total: 0 }, countsHidden: true, needsYou: 0 }];
    const html = render(meAs("interviewer"), { roles: theirs });
    expect(html).toContain("Dental Hygienist");
    expect(html).toContain(", live</span>");
    // no count: the word "Live" (the status pills' word) stands beside the green dot instead
    expect(html).toContain('<span class="rail-count rail-tag" aria-hidden="true">Live</span>');
    expect(html).not.toMatch(/<span class="rail-count" aria-hidden="true">\d/);
    expect(html).not.toContain("applicant");
    expect(html).not.toContain(">Candidates</a>");
    // an interviewer has no Candidates page, so even a live job opens on the job itself
    expect(html).toContain('href="/roles/r-open"');
    expect(html).not.toContain('href="/roles/r-open/talent"');
    expect(html).toContain("Interviewer");
  });

  it("marks a live job in the rail as the current page on every page of that job, though it opens on Candidates", () => {
    nav.path = "/roles/r-open";
    expect(render(meAs("owner"), { roles })).toMatch(/<a href="\/roles\/r-open\/talent" class="active" aria-current="page">/);
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"), { roles })).toMatch(/<a href="\/roles\/r-open\/talent" class="active" aria-current="page">/);
    nav.path = "/roles/r-draft";
    const html = render(meAs("owner"), { roles });
    expect(html).toMatch(/<a href="\/roles\/r-draft" class="active" aria-current="page">/);
    expect(html).not.toMatch(/<a href="\/roles\/r-open\/talent" class="active"/);
  });

  it("keeps the development notice to one short line", () => {
    const html = render(meAs("owner", { ai: { provider: "fake" } }));
    expect(html).toContain("Development mode: the AI provider is a deterministic stand-in, so its drafts are rough.");
    expect(html).not.toContain("Role packets");
  });

  it("reads the company's roles for a member, and never for an ITS recruiter inside a customer under a grant", () => {
    expect(rolesQueryEnabled(renderWith(meAs("owner")).qc)).toBe(true);
    // Every request a recruiter makes under a grant is recorded for the customer as a page they opened: the rail makes
    // none, and lists nothing even when another page left the customer's roles in the cache.
    const staff = meAs(null, {
      user: { id: "s1", email: "rae@its.test", name: "Rae Recruiter", platformRole: "its_recruiter" },
      activeCompanyId: "co1",
      staffAccess: { grantId: "g1", kind: "escalation", purpose: "Review these candidates", expiresAt: "2026-10-20T00:00:00Z", companyName: "Bright Dental", scope: { escalationId: "e1", roleId: "r-open", applicationId: null } },
    });
    const { html, qc } = renderWith(staff, { roles });
    expect(rolesQueryEnabled(qc)).toBe(false);
    expect(html).not.toContain("rail-sub");
    expect(html).not.toContain("Dental Hygienist");
    expect(html).toContain("ITS recruiter, limited access");
    expect(html).toContain("Every page you open is recorded for the customer.");
    expect(html).not.toContain('aria-label="Start a hire"');
  });

  it("folds to icons on a role's own pages, and in the job builder", () => {
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"), { roles })).toContain('<div class="shell" data-rail="compact">');
    nav.path = "/roles/new";
    expect(render(meAs("owner"), { roles })).toContain('<div class="shell" data-rail="compact">');
    nav.path = "/roles";
    expect(render(meAs("owner"), { roles })).not.toContain('data-rail="compact"');
  });

  it("offers a company switcher in the company chip to someone in more than one company, and to nobody else (rows 9, 49)", () => {
    // one company: no switcher
    expect(render(meAs("owner"))).not.toContain('aria-label="Switch company"');
    const two = meAs("owner", { memberships: [{ ...company, role: "owner" }, { companyId: "co2", companyName: "Harbor Clinic", companySlug: "harbor-clinic", role: "hiring_manager" }] });
    const html = render(two);
    expect(html).toMatch(/<button[^>]*aria-label="Switch company"[^>]*aria-haspopup="menu"|<button[^>]*aria-haspopup="menu"[^>]*aria-label="Switch company"/);
    // the chip still names the company in use and keeps its cog to Settings
    expect(html).toContain("<strong>Bright Dental</strong>");
    expect(html).toContain('aria-label="Company settings"');
    // an ITS recruiter inside a customer under a grant enters companies from the queue, never from here
    const staff = meAs(null, {
      user: { id: "s1", email: "rae@its.test", name: "Rae Recruiter", platformRole: "its_recruiter" },
      activeCompanyId: "co1",
      staffAccess: { grantId: "g1", kind: "escalation", purpose: "Review", expiresAt: "2026-10-20T00:00:00Z", companyName: "Bright Dental", scope: { escalationId: "e1", roleId: null, applicationId: null } },
    });
    expect(render(staff)).not.toContain('aria-label="Switch company"');
  });

  it("gives ITS staff without a company the queue and Sign out, and no company chip", () => {
    const html = render(meAs(null, { user: { id: "s1", email: "nadine@identifiedtalent.com", name: "Nadine", platformRole: "its_recruiter" } }));
    expect(html).toContain("ITS staff");
    expect(html).not.toContain("rail-org");
    expect(html).not.toContain('aria-label="Start a hire"');
    expect(html).toContain('href="/recruiter/queue"');
    expect(html).toContain(">Sign out</button>");
    // an ITS recruiter has the queue, never the console or its sections
    expect(html).not.toContain('href="/admin');
    expect(html).not.toContain("Console sections");
  });

  it("lists the console's five sections under Console for a platform administrator, marking the one open", () => {
    const admin = meAs(null, { user: { id: "a1", email: "ada@identifiedtalent.com", name: "Ada Admin", platformRole: "platform_admin" } });
    nav.path = "/admin";
    let html = render(admin);
    expect(html).toContain('<ul class="rail-sub console-sub" aria-label="Console sections">');
    const links = [["Overview", "/admin"], ["Customers", "/admin/customers"], ["Privacy requests", "/admin/privacy"], ["Problems", "/admin/problems"], ["System and settings", "/admin/system"]];
    // each with an icon, so the folded rail still shows all five (spec 3.6: every section one click away)
    for (const [label, href] of links) expect(html, label).toMatch(new RegExp(`<a href="${href}"[^>]*><svg[^>]*>[\\s\\S]*?</svg><span class="rail-sub-title">${label}</span></a>`));
    const at = links.map(([label]) => html.indexOf(`>${label}</span>`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // on /admin: Console and Overview are marked, no other section
    expect(html).toMatch(/<a href="\/admin" class="active" aria-current="page"><svg[\s\S]*?<\/svg>Console<\/a>/);
    expect(html).toMatch(/<a href="\/admin" class="active" aria-current="page"><svg[^>]*>[\s\S]*?<\/svg><span class="rail-sub-title">Overview<\/span><\/a>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    // on a section: Console stays marked, the section is marked, Overview is not (it matches /admin only)
    nav.path = "/admin/problems";
    html = render(admin);
    expect(html).toMatch(/<a href="\/admin" class="active" aria-current="page"><svg[\s\S]*?<\/svg>Console<\/a>/);
    expect(html).toMatch(/<a href="\/admin\/problems" class="active" aria-current="page"><svg[^>]*>[\s\S]*?<\/svg><span class="rail-sub-title">Problems<\/span><\/a>/);
    expect(html).toMatch(/<a href="\/admin"><svg[^>]*>[\s\S]*?<\/svg><span class="rail-sub-title">Overview<\/span><\/a>/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    // a company member who is not a platform administrator never sees them
    expect(render(meAs("owner"))).not.toContain("Console sections");
  });

  it("offers a button that folds the rail to icons, except on a job's pages where it is folded already (F3)", () => {
    nav.path = "/roles";
    const html = render(meAs("owner"), { roles });
    // drawn open first (the server keeps no choice), with the button to fold it
    // one name, and whether it is on is said by aria-pressed
    expect(html).toMatch(/<button type="button" class="icon-btn rail-collapse" aria-label="Fold the menu to icons" aria-pressed="false" title="Fold the menu to icons">/);
    expect(html).not.toContain("data-collapsed");
    // folded, the console's sections stay in the rail as icons (they are hidden in the folded rail otherwise)
    const css = readFileSync(new URL("./app-shell.css", import.meta.url), "utf8");
    expect(css).toContain('.shell[data-rail="compact"] .rail .console-sub { display: grid;');
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"), { roles })).not.toContain("rail-collapse");
  });

  it("remembers the folded rail on this browser, and never fails where storage cannot be read or written", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage;
    expect(railCollapsedIn(storage)).toBe(false);
    rememberRailCollapsed(storage, true);
    expect(store.get(RAIL_COLLAPSED_KEY)).toBe("1");
    expect(railCollapsedIn(storage)).toBe(true);
    rememberRailCollapsed(storage, false);
    expect(store.has(RAIL_COLLAPSED_KEY)).toBe(false);
    expect(railCollapsedIn(storage)).toBe(false);
    // blocked site data: reading says "open", writing does nothing, neither throws
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } as unknown as Storage;
    expect(railCollapsedIn(blocked)).toBe(false);
    expect(() => rememberRailCollapsed(blocked, true)).not.toThrow();
    expect(railCollapsedIn(null)).toBe(false);
    expect(() => rememberRailCollapsed(null, true)).not.toThrow();
  });
});

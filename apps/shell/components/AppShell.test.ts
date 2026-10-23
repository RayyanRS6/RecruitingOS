import { existsSync } from "node:fs";
import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../lib/session";

/**
 * The signed-in frame's rail (Wave DS; plain words of 14 October 2026; the October 2026 redesign), rendered as the
 * server first sends it: the company chip, "Start a hire" only for the roles that may start one, Home, Jobs (with the
 * jobs in progress underneath, a live one opening on its Candidates), Candidates, Interviews and Settings, the fold to
 * icons on a job's pages, the highlight behind the current link, the bar above a page that sits under another (with
 * the way back up), and Sign out always there. Since 23 October 2026 (founder: fewer words) the frame carries no slogan
 * card, no label over the company's own links and no company name in the bar above the page.
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
const { AppShell, CONSOLE_LINKS, RAIL_COLLAPSED_KEY, markMove, parentTrail, railCollapsedIn, rememberRailCollapsed, sectionTrail } = await import("./AppShell");
// The page-enter templates, one per section of the signed-in app (Next.js keys a template by the segment below it).
const templates = {
  "(company)": (await import("../app/(app)/(company)/template")).default,
  admin: (await import("../app/(app)/admin/template")).default,
  recruiter: (await import("../app/(app)/recruiter/template")).default,
};

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
const admin = () => meAs(null, { user: { id: "a1", email: "ada@identifiedtalent.com", name: "Ada Admin", platformRole: "platform_admin" } });

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
/** Anything inside one link, never past its end. */
const IN = "(?:(?!</a>)[\\s\\S])*?";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

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
    expect(html).toMatch(/<ul class="[^"]*" aria-label="Jobs in progress">/);
    expect(html).toContain('href="/roles/r-open/talent"');
    expect(html).toContain('href="/roles/r-draft"');
    expect(html).not.toContain('href="/roles/r-draft/talent"');
    expect(html).toMatch(/<span class="dot good" aria-hidden="true"><\/span><span class="[^"]*">Dental Hygienist<\/span>/);
    expect(html).toContain(", live, 6 applicants");
    expect(html).toMatch(/<span class="dot" aria-hidden="true"><\/span><span class="[^"]*">Front Desk Lead<\/span>/);
    // the draft says so in a word too: the dot's colour never carries the status alone
    expect(html).toMatch(/>Front Desk Lead<\/span><span class="[^"]*" aria-hidden="true">Draft<\/span>/);
    expect(html).not.toContain("Office Manager");
    expect(html).toContain("All jobs");
    // the plain words, in this order, each with its icon; the routes keep their names
    const order = [["Home", "/"], ["Jobs", "/roles"], ["Candidates", "/talent"], ["Interviews", "/interviews"], ["Settings", "/setup"]];
    for (const [link, href] of order) expect(html, link).toMatch(new RegExp(`<a href="${esc(href)}"[^>]*>(<span data-mark="main"[^>]*></span>)?<svg${IN}</svg><span[^>]*>${link}</span></a>`));
    const at = order.map(([link]) => html.indexOf(`>${link}</span></a>`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    for (const old of ["Today", "Talent", "Setup", "All roles"]) expect(html, old).not.toContain(`>${old}<`);
    expect(html).toContain("dana@bright.test");
    expect(html).toContain(">Sign out</span></button>");
    // the phone's Menu button and the links it opens (closed on the first draw)
    expect(html).toContain('aria-expanded="false" aria-controls="rail-links"');
    expect(html).toContain('id="rail-links"');
    expect(html).not.toContain("data-open");
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
    expect(html).toMatch(/>Dental Hygienist<\/span><span class="[^"]*" aria-hidden="true">Live<\/span>/);
    expect(html).not.toMatch(/aria-hidden="true">\d+<\/span>/);
    expect(html).not.toContain("applicant");
    expect(html).not.toContain('href="/talent"');
    expect(html).not.toContain(">Candidates</span></a>");
    // an interviewer has no Candidates page, so even a live job opens on the job itself
    expect(html).toContain('href="/roles/r-open"');
    expect(html).not.toContain('href="/roles/r-open/talent"');
    expect(html).toContain("Interviewer");
  });

  it("marks a live job in the rail as the current page on every page of that job, though it opens on Candidates", () => {
    nav.path = "/roles/r-open";
    expect(render(meAs("owner"), { roles })).toMatch(/<a href="\/roles\/r-open\/talent" class="[^"]* active" aria-current="page">/);
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"), { roles })).toMatch(/<a href="\/roles\/r-open\/talent" class="[^"]* active" aria-current="page">/);
    nav.path = "/roles/r-draft";
    const html = render(meAs("owner"), { roles });
    expect(html).toMatch(/<a href="\/roles\/r-draft" class="[^"]* active" aria-current="page">/);
    expect(html).not.toMatch(/<a href="\/roles\/r-open\/talent" class="[^"]* active"/);
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
    expect(html).not.toContain("Jobs in progress");
    expect(html).not.toContain("Dental Hygienist");
    expect(html).toContain("ITS recruiter, limited access");
    expect(html).toContain("Every page you open is recorded for the customer.");
    expect(html).toContain("Bright Dental (recruiter access)");
    expect(html).not.toContain('aria-label="Start a hire"');
  });

  it("folds to icons on a role's own pages, and in the job builder", () => {
    nav.path = "/roles/r-open/talent";
    let html = render(meAs("owner"), { roles });
    expect(html).toMatch(/<div class="[^"]* rail:grid-cols-\[72px_minmax\(0,1fr\)\]" data-rail="compact">/);
    // folded: the icon alone on screen, the word kept for screen readers and shown as the link's tooltip
    expect(html).toMatch(new RegExp(`<a href="/" class="[^"]*" title="Home"><svg${IN}</svg><span class="[^"]* rail:sr-only[^"]*">Home</span></a>`));
    expect(html).toMatch(/title="Start a hire \(press N\)"/);
    // the jobs under Jobs wait in the phone's menu; the side rail has no room for them
    expect(html).toMatch(/<ul class="[^"]* rail:hidden[^"]*" aria-label="Jobs in progress">/);
    nav.path = "/roles/new";
    expect(render(meAs("owner"), { roles })).toContain('data-rail="compact"');
    nav.path = "/roles";
    html = render(meAs("owner"), { roles });
    expect(html).not.toContain('data-rail="compact"');
    expect(html).toMatch(/<div class="[^"]* rail:grid-cols-\[248px_minmax\(0,1fr\)\]">/);
    expect(html).not.toContain('title="Home"');
  });

  it("offers a company switcher in the company chip to someone in more than one company, and to nobody else (rows 9, 49)", () => {
    // one company: no switcher
    expect(render(meAs("owner"))).not.toContain('aria-label="Switch company"');
    const two = meAs("owner", { memberships: [{ ...company, role: "owner" }, { companyId: "co2", companyName: "Harbor Clinic", companySlug: "harbor-clinic", role: "hiring_manager" }] });
    const html = render(two);
    expect(html).toMatch(/<button[^>]*aria-label="Switch company"[^>]*aria-haspopup="menu"|<button[^>]*aria-haspopup="menu"[^>]*aria-label="Switch company"/);
    // the chip still names the company in use and keeps its cog to Settings
    expect(html).toMatch(/<strong[^>]*>Bright Dental<\/strong>/);
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
    expect(html).not.toContain('aria-label="Company settings"');
    expect(html).not.toContain('aria-label="Start a hire"');
    expect(html).toContain('href="/recruiter/queue"');
    expect(html).toContain(">Sign out</span></button>");
    // an ITS recruiter has the queue, never the console or its sections
    expect(html).not.toContain('href="/admin');
    expect(html).not.toContain("Console sections");
  });

  it("lists the console's five sections under Console for a platform administrator, marking the one open", () => {
    nav.path = "/admin";
    let html = render(admin());
    expect(html).toMatch(/<ul class="[^"]*" aria-label="Console sections">/);
    const links = CONSOLE_LINKS.map((l) => [l.label, l.to]);
    expect(links).toEqual([["Overview", "/admin"], ["Customers", "/admin/customers"], ["Privacy requests", "/admin/privacy"], ["Problems", "/admin/problems"], ["System and settings", "/admin/system"]]);
    // each with an icon, so the folded rail still shows all five (spec 3.6: every section one click away)
    for (const [label, href] of links) expect(html, label).toMatch(new RegExp(`<a href="${esc(href)}"[^>]*>(<span data-mark="console"[^>]*></span>)?<svg[^>]*>${IN}</svg><span[^>]*>${label}</span></a>`));
    const at = links.map(([label]) => html.indexOf(`>${label}</span></a>`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // on /admin: Console and Overview are marked, no other section
    expect(html).toMatch(new RegExp(`<a href="/admin" class="[^"]* active" aria-current="page"><span data-mark="main"[^>]*></span><svg${IN}</svg><span[^>]*>Console</span></a>`));
    expect(html).toMatch(new RegExp(`<a href="/admin" class="[^"]* active" aria-current="page"><span data-mark="console"[^>]*></span><svg[^>]*>${IN}</svg><span[^>]*>Overview</span></a>`));
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    // on a section: Console stays marked, the section is marked, Overview is not (it matches /admin only)
    nav.path = "/admin/problems";
    html = render(admin());
    expect(html).toMatch(new RegExp(`<a href="/admin" class="[^"]* active" aria-current="page"><span data-mark="main"[^>]*></span><svg${IN}</svg><span[^>]*>Console</span></a>`));
    expect(html).toMatch(new RegExp(`<a href="/admin/problems" class="[^"]* active" aria-current="page"><span data-mark="console"[^>]*></span><svg[^>]*>${IN}</svg><span[^>]*>Problems</span></a>`));
    expect(html).toMatch(new RegExp(`<a href="/admin" class="[^"]*"><svg[^>]*>${IN}</svg><span[^>]*>Overview</span></a>`));
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    // a company member who is not a platform administrator never sees them
    expect(render(meAs("owner"))).not.toContain("Console sections");
  });

  it("offers a button that folds the rail to icons, except on a job's pages where it is folded already (F3)", () => {
    nav.path = "/roles";
    const html = render(meAs("owner"), { roles });
    // drawn open first (the server keeps no choice), with the button to fold it
    // one name, and whether it is on is said by aria-pressed
    expect(html).toMatch(/<button type="button" class="icon-btn sm[^"]*" aria-label="Fold the menu to icons" aria-pressed="false" title="Fold the menu to icons">/);
    expect(html).not.toContain("data-collapsed");
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"), { roles })).not.toContain('aria-label="Fold the menu to icons"');
    // folded, the console's sections stay in the rail as icons, each named in its tooltip and to screen readers
    nav.path = "/roles/r-open";
    const folded = render(admin());
    expect(folded).toContain('data-rail="compact"');
    expect(folded).toMatch(/<ul class="[^"]*" aria-label="Console sections">/);
    expect(folded).not.toMatch(/<ul class="[^"]*rail:hidden[^"]*" aria-label="Console sections">/);
    for (const l of CONSOLE_LINKS) expect(folded, l.label).toMatch(new RegExp(`<a href="${esc(l.to)}" class="[^"]*" title="${l.label}"><svg[^>]*>${IN}</svg><span class="[^"]* rail:sr-only[^"]*">${l.label}</span></a>`));
  });

  it("keeps a long job name inside the rail, cut short with its count or word still in view", () => {
    const html = render(meAs("owner"), { roles });
    // one column no wider than the rail; the title gives way (min-w-0, ellipsis), the count and word never shrink
    expect(html).toMatch(/<ul class="[^"]*grid-cols-\[minmax\(0,1fr\)\][^"]*" aria-label="Jobs in progress">/);
    expect(html).toContain('<span class="min-w-0 flex-1 truncate">Dental Hygienist</span><span class="shrink-0 ');
    expect(html).toMatch(/<span class="min-w-0 flex-1 truncate">Front Desk Lead<\/span><span class="shrink-0[^"]*" aria-hidden="true">Draft<\/span>/);
  });

  it("offers the light/dark theme switch beside Sign out, on every page and in the folded rail too", () => {
    for (const path of ["/", "/roles/r-open/talent"]) {
      nav.path = path;
      const html = render(meAs("owner"), { roles });
      // drawn light first (only the browser knows the device's setting), one name, whether it is on said by aria-pressed
      expect(html, path).toMatch(/<div class="[^"]*"><button type="button" class="btn quiet sm[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*?Sign out<\/span><\/button><button type="button" class="icon-btn sm" aria-label="Dark theme" aria-pressed="false" title="Switch to the dark theme">/);
    }
  });

  it("draws the name large enough for its coral OS, and the company's initial on coral-peach", () => {
    const html = render(meAs("owner"));
    // 19px bold: the coral is 3.8:1 on the surface, AA only as large text (bold from 18.66px)
    expect(html).toContain('<span class="truncate font-display text-[19px] font-bold tracking-[-0.02em] text-ink">Recruiting <span class="text-accent">OS</span></span>');
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*bg-peach[^"]*text-accent-ink">B<\/span>/);
  });

  it("on phones, puts the Menu button before Start a hire as drawn (top row first), and gives the menu's lists 40px rows", () => {
    const html = render(meAs("owner"), { roles });
    const menu = html.indexOf('aria-controls="rail-links"');
    expect(menu).toBeGreaterThan(-1);
    expect(menu).toBeLessThan(html.indexOf('aria-label="Start a hire"'));
    // the Menu button sits in the top row, Start a hire in the second
    expect(html).toMatch(/<button type="button" class="btn secondary sm [^"]*max-rail:row-start-1[^"]*" aria-expanded="false" aria-controls="rail-links">/);
    expect(html).toMatch(/<a href="\/roles\/new" class="btn primary [^"]*max-rail:row-start-2[^"]*"/);
    // the jobs, All jobs and (for an administrator) the console's sections: 32px in the side rail, 40px on a phone
    for (const href of ["/roles/r-open/talent", "/roles/r-draft"]) expect(html, href).toMatch(new RegExp(`<a href="${esc(href)}" class="[^"]*\\bh-8\\b[^"]*max-rail:h-10\\b`));
    expect(html).toMatch(/<a href="\/roles" class="[^"]*max-rail:h-10\b[^"]*"><span class="min-w-0 flex-1 truncate">All jobs<\/span><\/a>/);
    nav.path = "/admin";
    expect(render(admin())).toMatch(/<a href="\/admin\/customers" class="[^"]*max-rail:h-10\b/);
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

describe("the highlight behind the current link", () => {
  beforeEach(() => {
    nav.path = "/";
  });

  it("is drawn inside the current link only, one per list, hidden from screen readers and never hidden on the first draw", () => {
    nav.path = "/roles";
    const html = render(meAs("owner"), { roles });
    expect(html.match(/data-mark="main"/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/roles" class="[^"]* active" aria-current="page"><span data-mark="main" aria-hidden="true" class="absolute inset-0 -z-10 rounded-\[inherit\] bg-tint"><\/span>/);
    expect(html).not.toContain('data-mark="job"');
    // on a job's page: Jobs in the main list, the job in its own list
    nav.path = "/roles/r-draft";
    const job = render(meAs("owner"), { roles });
    expect(job.match(/data-mark="main"/g)).toHaveLength(1);
    expect(job).toMatch(/<a href="\/roles\/r-draft" class="[^"]* active" aria-current="page"><span data-mark="job" aria-hidden="true"/);
    // the frame carries no inline styles: the server and the browser's first draw are the same, nothing starts hidden
    for (const page of [html, job]) expect(page).not.toMatch(/\sstyle="/);
  });

  it("paints under every link of its list, so gliding past a link never covers its icon and word", () => {
    nav.path = "/roles/r-draft";
    const owner = render(meAs("owner"), { roles });
    nav.path = "/admin/problems";
    const consoleHtml = render(admin());
    // no link is a stacking context of its own; each list is one, so its highlights sit at its bottom
    for (const html of [owner, consoleHtml]) {
      expect(html).not.toMatch(/<a [^>]*class="[^"]*\bisolate\b/);
      expect(html).toMatch(/<div class="isolate [^"]*" id="rail-links"/);
    }
    expect(owner).toMatch(/<ul class="isolate [^"]*" aria-label="Jobs in progress">/);
    expect(consoleHtml).toMatch(/<ul class="isolate [^"]*" aria-label="Console sections">/);
    // hovering the current link leaves its highlight in view
    // (a job's page folds the rail, so Jobs carries its tooltip there)
    expect(owner).toMatch(/<a href="\/roles" class="[^"]*\[&amp;\.active\]:hover:bg-transparent[^"]* active" title="Jobs" aria-current="page">/);
    expect(owner).toMatch(/<a href="\/roles\/r-draft" class="[^"]*\[&amp;\.active\]:hover:bg-transparent[^"]* active" aria-current="page">/);
    expect(consoleHtml).toMatch(/<a href="\/admin\/problems" class="[^"]*\[&amp;\.active\]:hover:bg-transparent[^"]* active" aria-current="page">/);
  });

  it("glides from where it stood to the new link on transform, and stays put when nothing moved", () => {
    const box = { x: 16, y: 120, w: 216, h: 40 };
    expect(markMove(box, box)).toBeNull();
    expect(markMove(box, { ...box, y: 200 })).toBe("translate(0px, -80px) scale(1, 1)");
    expect(markMove({ ...box, w: 52 }, box)).toBe("translate(0px, 0px) scale(0.241, 1)");
    // a highlight that is not drawn (a folded list, the closed phone menu) never moves
    expect(markMove({ x: 0, y: 0, w: 0, h: 0 }, box)).toBeNull();
    expect(markMove(box, { x: 0, y: 0, w: 0, h: 0 })).toBeNull();
  });
});

describe("the bar above the page", () => {
  it("names where the page sits in the rail's own words", () => {
    const jobs = [{ id: "r-open", title: "Dental Hygienist" }];
    expect(sectionTrail("/")).toEqual(["Home"]);
    expect(sectionTrail("/updates")).toEqual(["Home", "Updates"]);
    expect(sectionTrail("/roles")).toEqual(["Jobs"]);
    expect(sectionTrail("/roles/new", jobs)).toEqual(["Jobs", "Start a hire"]);
    expect(sectionTrail("/roles/r-open/talent", jobs)).toEqual(["Jobs", "Dental Hygienist"]);
    // a job the rail does not list is not named (closed ones, or anything an ITS recruiter opens under a grant)
    expect(sectionTrail("/roles/r-closed", jobs)).toEqual(["Jobs"]);
    expect(sectionTrail("/talent")).toEqual(["Candidates"]);
    expect(sectionTrail("/interviews/i1")).toEqual(["Interviews"]);
    expect(sectionTrail("/setup")).toEqual(["Settings"]);
    expect(sectionTrail("/recruiter/queue/q1")).toEqual(["Queue"]);
    expect(sectionTrail("/admin")).toEqual(["Console", "Overview"]);
    expect(sectionTrail("/admin/problems")).toEqual(["Console", "Problems"]);
    expect(sectionTrail("/nothing-here")).toEqual([]);
  });

  it("links back up only from a page under another, naming the page when the rail knows it", () => {
    const jobs = [{ id: "r-open", title: "Dental Hygienist" }];
    const jobsUp = { label: "Jobs", href: "/roles" };
    expect(parentTrail("/roles/r-open/talent", jobs)).toEqual({ parent: jobsUp, here: "Dental Hygienist" });
    expect(parentTrail("/roles/new", jobs)).toEqual({ parent: jobsUp, here: "Start a hire" });
    expect(parentTrail("/updates")).toEqual({ parent: { label: "Home", href: "/" }, here: "Updates" });
    expect(parentTrail("/admin/customers")).toEqual({ parent: { label: "Console", href: "/admin" }, here: "Customers" });
    // a job the rail does not list (or not yet) keeps the way back up without its name, so the bar never appears late
    expect(parentTrail("/roles/r-closed", jobs)).toEqual({ parent: jobsUp, here: null });
    expect(parentTrail("/roles/r-open")).toEqual({ parent: jobsUp, here: null });
    // a section's own page: its heading says where it is, so there is no bar (the console's Overview is Console itself)
    for (const path of ["/", "/roles", "/talent", "/people", "/interviews", "/interviews/i1", "/setup", "/recruiter/queue", "/recruiter/queue/q1", "/admin", "/nothing-here", ""]) expect(parentTrail(path, jobs), path).toBeNull();
  });

  it("draws the trail with its link back up and never the company (the rail's chip names it), adds no landmark, and leaves the page its 1040px column (wider where a page needs it)", () => {
    nav.path = "/roles/r-open/talent";
    const html = render(meAs("owner"), { roles });
    expect(html).toMatch(/<p class="[^"]*"><a href="\/roles" class="[^"]*">Jobs<\/a><span aria-hidden="true">\/<\/span><span class="[^"]*">Dental Hygienist<\/span><\/p>/);
    // the company is named in the rail's chip and under the name in the phone's top bar, nowhere else (no coral dot)
    expect(html.match(/Bright Dental/g)).toHaveLength(2);
    expect(html).not.toMatch(/Bright Dental<\/span><span aria-hidden="true" class="[^"]*bg-accent/);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<(header|aside|footer)\b/);
    expect(html).toMatch(/<main id="main" class="[^"]*max-w-\[1040px\][^"]*">/);
    expect(html).toContain("group-has-[.builder,.start,.pool-board,[data-wide]]/page:max-w-[1440px]");
    expect(html).toContain("<p>page</p></main>");
    // the page's gutter grows 16px, 24px (from sm:, 640px), 40px (from rail:, 900px): named breakpoints only, all in rem,
    // so Tailwind sorts sm: before rail: and rail:px-10 wins on a wide screen; no pixel copy of a breakpoint
    // (min-[900px]:, max-[900px]:, min-[640px]:), which would sort before every rem one
    expect(html).toMatch(/<main id="main" class="[^"]*\bpx-4 [^"]*\bsm:px-6 rail:px-10\b/);
    expect(html).not.toMatch(/class="[^"]*(?<![\w-])(min|max)-\[[\d.]+px\]:/);
  });

  it("draws no bar on a section's own page, so the page column opens on the page; a page under another gets its trail", () => {
    for (const path of ["/", "/roles", "/talent", "/interviews", "/setup"]) {
      nav.path = path;
      const html = render(meAs("owner"), { roles });
      expect(html, path).toMatch(/<div class="group\/page[^"]*"><main id="main"/);
      expect(html, path).not.toContain('<span aria-hidden="true">/</span>');
    }
    nav.path = "/admin";
    expect(render(admin())).toMatch(/<div class="group\/page[^"]*"><main id="main"/);
    nav.path = "/admin/customers";
    const section = render(admin());
    expect(section).not.toMatch(/<div class="group\/page[^"]*"><main id="main"/);
    expect(section).toMatch(/<a href="\/admin" class="[^"]*">Console<\/a><span aria-hidden="true">\/<\/span><span class="[^"]*">Customers<\/span>/);
    // the bar adds no current-page mark: the rail's two links (Console and the section) keep the only ones
    expect(section.match(/aria-current="page"/g)).toHaveLength(2);
    nav.path = "/updates";
    expect(render(meAs("owner"))).toMatch(/<a href="\/" class="[^"]*">Home<\/a><span aria-hidden="true">\/<\/span><span class="[^"]*">Updates<\/span>/);
    // a job the rail has not listed yet: the way back up is there from the first draw, without the job's name
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"))).toMatch(/<p class="[^"]*"><a href="\/roles" class="[^"]*">Jobs<\/a><\/p>/);
  });
});

describe("the rail's foot and labels (founder, 23 October 2026: fewer words)", () => {
  it("ends the rail with who is signed in: no slogan card, and no label over the company's own links", () => {
    for (const path of ["/", "/roles/r-open"]) {
      nav.path = path;
      const html = render(meAs("owner"), { roles });
      for (const cut of ["People first.", "Suggestions help you think", "Your desk"]) expect(html, `${path}: ${cut}`).not.toContain(cut);
      // the foot keeps its place at the bottom of the side rail, with the person's email and Sign out
      expect(html, path).toMatch(/<div class="[^"]* rail:mt-auto[^"]*">(?:(?!<\/nav>)[\s\S])*dana@bright\.test(?:(?!<\/nav>)[\s\S])*>Sign out<\/span><\/button>/);
    }
  });

  it("keeps the ITS staff's Recruiter and Admin labels, which tell their groups apart from the company's links", () => {
    nav.path = "/admin";
    const html = render(admin());
    expect(html).toMatch(/<div class="[^"]*font-mono[^"]*">Recruiter<\/div>/);
    expect(html).toMatch(/<div class="[^"]*font-mono[^"]*">Admin<\/div>/);
  });
});

describe("the page as it opens", () => {
  it("fades up from a template one level under the frame (so moving between sections runs it), and keeps no transform once done", () => {
    // under (app), Next.js would key the template by "(company)" or "admin" and almost never draw it afresh
    expect(existsSync(new URL("../app/(app)/template.tsx", import.meta.url))).toBe(false);
    for (const [section, Template] of Object.entries(templates)) {
      // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
      const html = renderToStaticMarkup(createElement(Template, { children: createElement("p", null, "page") }));
      // filled backwards only: afterwards the wrapper is no containing block for the sheets and menus inside the page
      expect(html, section).toBe('<div class="animate-enter [animation-fill-mode:backwards]"><p>page</p></div>');
    }
  });
});

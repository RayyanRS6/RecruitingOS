import { existsSync } from "node:fs";
import * as React from "react";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../lib/session";

/**
 * The signed-in frame's rail, rendered as the server first sends it: the company chip, "Start a hire" for everyone on a
 * company's team, Home, Jobs, Candidates and Settings and nothing else, the fold to icons on a job's pages, the
 * highlight behind the current link, the bar above a page that sits under another (with the way back up), Updates with
 * how many are unread, and Sign out always there. The frame carries no slogan card, no label over the company's own
 * links and no company name in the bar above the page.
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
};

const company = { companyId: "co1", companyName: "Bright Dental", companySlug: "bright-dental" };
function meAs(role: string | null, extra: Partial<Me> = {}): Me {
  return {
    user: { id: "u1", email: "owner@bright.test", name: "The Owner", platformRole: "none" },
    auth: { provider: "google", aal: "aal1", mfaVerifiedAt: null },
    memberships: role ? [{ ...company, role }] : [],
    activeCompanyId: role ? "co1" : null,
    ai: { provider: "openai" },
    ...extra,
  };
}
const admin = () => meAs(null, { user: { id: "a1", email: "staff@its.test", name: "ITS Staff", platformRole: "platform_admin" } });

/** Where the frame keeps its count of unread updates. */
const UNREAD_KEY = ["notifications", "history", "frame"];
function renderWith(me: Me, seed: { unread?: number } = {}): { html: string; qc: QueryClient } {
  const qc = new QueryClient();
  if (seed.unread !== undefined) qc.setQueryData(UNREAD_KEY, { items: [], nextBefore: null, unreadCount: seed.unread, asOf: "2026-11-18T10:00:00.000Z" });
  // biome-ignore lint/correctness/noChildrenProp: createElement's types want a required children prop among the props
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(AppShell, { me, children: createElement("p", null, "page") })));
  return { html, qc };
}
const render = (me: Me, seed: { unread?: number } = {}) => renderWith(me, seed).html;
/** Whether the frame's unread count may be fetched: its observer options as the shell set them during the render. */
function unreadQueryEnabled(qc: QueryClient): boolean | undefined {
  const query = qc.getQueryCache().find({ queryKey: UNREAD_KEY });
  return (query?.options as { enabled?: boolean } | undefined)?.enabled;
}
/** Anything inside one link, never past its end. */
const IN = "(?:(?!</a>)[\\s\\S])*?";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

describe("the rail", () => {
  beforeEach(() => {
    nav.path = "/";
  });

  it("shows an owner the company chip, Start a hire, the four places and Sign out, and nothing else", () => {
    const html = render(meAs("owner"));
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain("Bright Dental");
    expect(html).toContain("Owner");
    expect(html).toContain('aria-label="Company settings"');
    // Start a hire opens the job builder; no keyboard shortcut is announced or drawn
    expect(html).toMatch(new RegExp(`<a href="/roles/new" class="btn primary [^"]*"><svg${IN}</svg><span>Start a hire</span></a>`));
    expect(html).not.toContain("aria-keyshortcuts");
    expect(html).not.toContain("<kbd");
    // the plain words, in this order, each with its icon; the routes keep their names
    const order = [["Home", "/"], ["Jobs", "/roles"], ["Candidates", "/talent"], ["Settings", "/setup"]];
    for (const [link, href] of order) expect(html, link).toMatch(new RegExp(`<a href="${esc(href)}"[^>]*>(<span data-mark="main"[^>]*></span>)?<svg${IN}</svg><span[^>]*>${link}</span></a>`));
    const at = order.map(([link]) => html.indexOf(`>${link}</span></a>`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // no list of jobs under Jobs, no Interviews, nothing of a recruiter, and none of the old words
    expect(html).not.toContain("Jobs in progress");
    expect(html).not.toContain("All jobs");
    expect(html).not.toContain('href="/interviews"');
    for (const old of ["Today", "Talent", "Setup", "All roles", "Interviews", "Recruiter"]) expect(html, old).not.toContain(`>${old}<`);
    expect(html).toContain("owner@bright.test");
    expect(html).toContain(">Sign out</span></button>");
    // the phone's Menu button and the links it opens (closed on the first draw)
    expect(html).toContain('aria-expanded="false" aria-controls="rail-links"');
    expect(html).toContain('id="rail-links"');
    expect(html).not.toContain("data-open");
    expect(html).not.toContain("AI:");
    expect(html).not.toContain('data-rail="compact"');
  });

  it("offers Start a hire and the same four places to everyone on a company's team, whatever their role", () => {
    for (const role of ["owner", "admin", "hiring_manager"]) {
      const html = render(meAs(role));
      expect(html, role).toContain('href="/roles/new"');
      for (const href of ["/", "/roles", "/talent", "/setup"]) expect(html, `${role} ${href}`).toContain(`<a href="${href}"`);
    }
    // the role in the company chip, in the words Settings uses
    expect(render(meAs("hiring_manager"))).toContain(">Member</span>");
    expect(render(meAs("admin"))).toContain(">Admin</span>");
  });

  it("marks Jobs as the current link on a job's pages and in the job builder, and Candidates only on its own page", () => {
    for (const path of ["/roles", "/roles/r-open", "/roles/r-open/talent", "/roles/new"]) {
      nav.path = path;
      const html = render(meAs("owner"));
      expect(html, path).toMatch(/<a href="\/roles" class="[^"]* active"[^>]*aria-current="page">/);
      expect(html.match(/aria-current="page"/g), path).toHaveLength(1);
    }
    nav.path = "/talent";
    const html = render(meAs("owner"));
    expect(html).toMatch(/<a href="\/talent" class="[^"]* active" aria-current="page">/);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("keeps the development notice to one short line", () => {
    const html = render(meAs("owner", { ai: { provider: "fake" } }));
    expect(html).toContain("Development mode: the AI provider is a deterministic stand-in, so its drafts are rough.");
    expect(html).not.toContain("Role packets");
  });

  it("folds to icons on a job's own pages, and in the job builder", () => {
    nav.path = "/roles/r-open/talent";
    let html = render(meAs("owner"));
    expect(html).toMatch(/<div class="[^"]* rail:grid-cols-\[72px_minmax\(0,1fr\)\]" data-rail="compact">/);
    // folded: the icon alone on screen, the word kept for screen readers and shown as the link's tooltip
    expect(html).toMatch(new RegExp(`<a href="/" class="[^"]*" title="Home"><svg${IN}</svg><span class="[^"]* rail:sr-only[^"]*">Home</span></a>`));
    expect(html).toMatch(new RegExp(`<a href="/roles/new" class="btn primary [^"]*" title="Start a hire"><svg${IN}</svg><span class="rail:sr-only">Start a hire</span></a>`));
    nav.path = "/roles/new";
    expect(render(meAs("owner"))).toContain('data-rail="compact"');
    nav.path = "/roles";
    html = render(meAs("owner"));
    expect(html).not.toContain('data-rail="compact"');
    expect(html).toMatch(/<div class="[^"]* rail:grid-cols-\[248px_minmax\(0,1fr\)\]">/);
    expect(html).not.toContain('title="Home"');
    expect(html).not.toContain('title="Start a hire"');
  });

  it("offers a company switcher in the company chip to someone in more than one company, and to nobody else", () => {
    // one company: no switcher
    expect(render(meAs("owner"))).not.toContain('aria-label="Switch company"');
    const two = meAs("owner", { memberships: [{ ...company, role: "owner" }, { companyId: "co2", companyName: "Harbor Clinic", companySlug: "harbor-clinic", role: "hiring_manager" }] });
    const html = render(two);
    expect(html).toMatch(/<button[^>]*aria-label="Switch company"[^>]*aria-haspopup="menu"|<button[^>]*aria-haspopup="menu"[^>]*aria-label="Switch company"/);
    // the chip still names the company in use and keeps its cog to Settings
    expect(html).toMatch(/<strong[^>]*>Bright Dental<\/strong>/);
    expect(html).toContain('aria-label="Company settings"');
    // ITS staff with no company have no chip, so no switcher
    expect(render(admin())).not.toContain('aria-label="Switch company"');
  });

  it("gives ITS staff without a company the console and Sign out: no company chip, no Start a hire, none of a company's places", () => {
    const html = render(admin());
    expect(html).toContain("ITS staff");
    expect(html).not.toContain('aria-label="Company settings"');
    expect(html).not.toContain('href="/roles/new"');
    for (const href of ["/roles", "/talent", "/setup", "/updates"]) expect(html, href).not.toContain(`<a href="${href}"`);
    expect(html).toContain('href="/admin"');
    expect(html).toContain(">Sign out</span></button>");
  });

  it("lists the console's five sections under Console for a platform administrator, marking the one open", () => {
    nav.path = "/admin";
    let html = render(admin());
    expect(html).toMatch(/<ul class="[^"]*" aria-label="Console sections">/);
    const links = CONSOLE_LINKS.map((l) => [l.label, l.to]);
    expect(links).toEqual([["Overview", "/admin"], ["Customers", "/admin/customers"], ["Privacy requests", "/admin/privacy"], ["Problems", "/admin/problems"], ["System and settings", "/admin/system"]]);
    // each with an icon, so the folded rail still shows all five (every section one click away)
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

  it("offers a button that folds the rail to icons, except on a job's pages where it is folded already", () => {
    nav.path = "/roles";
    const html = render(meAs("owner"));
    // drawn open first (the server keeps no choice), with the button to fold it
    // one name, and whether it is on is said by aria-pressed
    expect(html).toMatch(/<button type="button" class="icon-btn sm[^"]*" aria-label="Fold the menu to icons" aria-pressed="false" title="Fold the menu to icons">/);
    expect(html).not.toContain("data-collapsed");
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"))).not.toContain('aria-label="Fold the menu to icons"');
    // folded, the console's sections stay in the rail as icons, each named in its tooltip and to screen readers
    nav.path = "/roles/r-open";
    const folded = render(admin());
    expect(folded).toContain('data-rail="compact"');
    expect(folded).toMatch(/<ul class="[^"]*" aria-label="Console sections">/);
    expect(folded).not.toMatch(/<ul class="[^"]*rail:hidden[^"]*" aria-label="Console sections">/);
    for (const l of CONSOLE_LINKS) expect(folded, l.label).toMatch(new RegExp(`<a href="${esc(l.to)}" class="[^"]*" title="${l.label}"><svg[^>]*>${IN}</svg><span class="[^"]* rail:sr-only[^"]*">${l.label}</span></a>`));
  });

  it("offers the light/dark theme switch beside Sign out, on every page and in the folded rail too", () => {
    for (const path of ["/", "/roles/r-open/talent"]) {
      nav.path = path;
      const html = render(meAs("owner"));
      // drawn light first (only the browser knows the device's setting), one name, whether it is on said by aria-pressed
      expect(html, path).toMatch(/<button type="button" class="btn quiet sm[^"]*"[^>]*>(?:(?!<\/button>)[\s\S])*?Sign out<\/span><\/button><button type="button" class="icon-btn sm" aria-label="Dark theme" aria-pressed="false" title="Switch to the dark theme">/);
    }
  });

  it("draws the name large enough for its coral OS, and the company's initial on coral-peach", () => {
    const html = render(meAs("owner"));
    // 19px bold: the coral is 3.8:1 on the surface, AA only as large text (bold from 18.66px)
    expect(html).toContain('<span class="truncate font-display text-[19px] font-bold tracking-[-0.02em] text-ink">Recruiting <span class="text-accent">OS</span></span>');
    expect(html).toMatch(/<span aria-hidden="true" class="[^"]*bg-peach[^"]*text-accent-ink">B<\/span>/);
  });

  it("on phones, puts the Menu button before Start a hire as drawn (top row first), and gives the menu's lists 40px rows", () => {
    const html = render(meAs("owner"));
    const menu = html.indexOf('aria-controls="rail-links"');
    expect(menu).toBeGreaterThan(-1);
    expect(menu).toBeLessThan(html.indexOf('href="/roles/new"'));
    // the Menu button sits in the top row, Start a hire in the second
    expect(html).toMatch(/<button type="button" class="btn secondary sm [^"]*max-rail:row-start-1[^"]*" aria-expanded="false" aria-controls="rail-links">/);
    expect(html).toMatch(/<a href="\/roles\/new" class="btn primary [^"]*max-rail:row-start-2[^"]*"/);
    // the console's sections (for an administrator): 32px in the side rail, 40px on a phone
    nav.path = "/admin";
    expect(render(admin())).toMatch(/<a href="\/admin\/customers" class="[^"]*\bh-8\b[^"]*max-rail:h-10\b/);
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

describe("Updates in the frame", () => {
  beforeEach(() => {
    nav.path = "/";
  });

  it("leads to the Updates page beside Sign out, saying how many are unread in its name and as a figure", () => {
    const html = render(meAs("owner"), { unread: 3 });
    expect(html).toMatch(new RegExp(`<a href="/updates" class="icon-btn sm" title="Updates, 3 unread" aria-label="Updates, 3 unread"><svg${IN}</svg></a><span aria-hidden="true" class="[^"]*">3</span>`));
    // it comes before Sign out, in the row that stays in the phone's top bar
    expect(html.indexOf('href="/updates"')).toBeLessThan(html.indexOf(">Sign out</span></button>"));
    // more than 99 reads "99+"; the name still says the number
    const many = render(meAs("owner"), { unread: 120 });
    expect(many).toContain('aria-label="Updates, 120 unread"');
    expect(many).toMatch(/<span aria-hidden="true" class="[^"]*">99\+<\/span>/);
  });

  it("shows no figure with nothing unread, or before the count is known", () => {
    for (const html of [render(meAs("owner"), { unread: 0 }), render(meAs("owner"))]) {
      expect(html).toMatch(new RegExp(`<a href="/updates" class="icon-btn sm" title="Updates" aria-label="Updates"><svg${IN}</svg></a></span>`));
      expect(html).not.toContain("unread");
    }
  });

  it("is the current page on Updates, in the folded rail too", () => {
    nav.path = "/updates";
    expect(render(meAs("hiring_manager"), { unread: 1 })).toMatch(/<a href="\/updates" class="icon-btn sm active" title="Updates, 1 unread" aria-label="Updates, 1 unread" aria-current="page">/);
    nav.path = "/roles/r-open";
    expect(render(meAs("owner"), { unread: 1 })).toContain('<a href="/updates" class="icon-btn sm"');
  });

  it("asks for the count for someone in a company, and never for ITS staff with none", () => {
    expect(unreadQueryEnabled(renderWith(meAs("owner")).qc)).toBe(true);
    // No company in use: nothing is asked for, and no count shows even when another page left one in the cache.
    const { html, qc } = renderWith(admin(), { unread: 4 });
    expect(unreadQueryEnabled(qc)).toBe(false);
    expect(html).not.toContain('href="/updates"');
    expect(html).not.toContain("unread");
  });
});

describe("the highlight behind the current link", () => {
  beforeEach(() => {
    nav.path = "/";
  });

  it("is drawn inside the current link only, one per list, hidden from screen readers and never hidden on the first draw", () => {
    nav.path = "/roles";
    const html = render(meAs("owner"));
    expect(html.match(/data-mark="main"/g)).toHaveLength(1);
    expect(html).toMatch(/<a href="\/roles" class="[^"]* active" aria-current="page"><span data-mark="main" aria-hidden="true" class="absolute inset-0 -z-10 rounded-\[inherit\] bg-tint"><\/span>/);
    // on a job's page: still the one highlight, behind Jobs
    nav.path = "/roles/r-draft";
    const job = render(meAs("owner"));
    expect(job.match(/data-mark=/g)).toHaveLength(1);
    expect(job).toMatch(/<a href="\/roles" class="[^"]* active" title="Jobs" aria-current="page"><span data-mark="main" aria-hidden="true"/);
    // the frame carries no inline styles: the server and the browser's first draw are the same, nothing starts hidden
    for (const page of [html, job]) expect(page).not.toMatch(/\sstyle="/);
  });

  it("paints under every link of its list, so gliding past a link never covers its icon and word", () => {
    nav.path = "/roles/r-draft";
    const owner = render(meAs("owner"));
    nav.path = "/admin/problems";
    const consoleHtml = render(admin());
    // no link is a stacking context of its own; each list is one, so its highlights sit at its bottom
    for (const html of [owner, consoleHtml]) {
      expect(html).not.toMatch(/<a [^>]*class="[^"]*\bisolate\b/);
      expect(html).toMatch(/<div class="isolate [^"]*" id="rail-links"/);
    }
    expect(consoleHtml).toMatch(/<ul class="isolate [^"]*" aria-label="Console sections">/);
    // hovering the current link leaves its highlight in view
    // (a job's page folds the rail, so Jobs carries its tooltip there)
    expect(owner).toMatch(/<a href="\/roles" class="[^"]*\[&amp;\.active\]:hover:bg-transparent[^"]* active" title="Jobs" aria-current="page">/);
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
    expect(sectionTrail("/")).toEqual(["Home"]);
    expect(sectionTrail("/updates")).toEqual(["Home", "Updates"]);
    expect(sectionTrail("/roles")).toEqual(["Jobs"]);
    expect(sectionTrail("/roles/new")).toEqual(["Jobs", "Start a hire"]);
    // a job's pages are under Jobs; the page's own heading names the job
    expect(sectionTrail("/roles/r-open")).toEqual(["Jobs"]);
    expect(sectionTrail("/roles/r-open/talent")).toEqual(["Jobs"]);
    expect(sectionTrail("/talent")).toEqual(["Candidates"]);
    expect(sectionTrail("/setup")).toEqual(["Settings"]);
    expect(sectionTrail("/admin")).toEqual(["Console", "Overview"]);
    expect(sectionTrail("/admin/problems")).toEqual(["Console", "Problems"]);
    // a page that is gone is nowhere in the rail
    expect(sectionTrail("/interviews/i1")).toEqual([]);
    expect(sectionTrail("/nothing-here")).toEqual([]);
  });

  it("links back up only from a page under another, naming the page when the frame can", () => {
    const jobsUp = { label: "Jobs", href: "/roles" };
    expect(parentTrail("/roles/new")).toEqual({ parent: jobsUp, here: "Start a hire" });
    expect(parentTrail("/updates")).toEqual({ parent: { label: "Home", href: "/" }, here: "Updates" });
    expect(parentTrail("/admin/customers")).toEqual({ parent: { label: "Console", href: "/admin" }, here: "Customers" });
    // a job's pages keep the way back up without the job's name, so the bar never appears late
    expect(parentTrail("/roles/r-open")).toEqual({ parent: jobsUp, here: null });
    expect(parentTrail("/roles/r-open/talent")).toEqual({ parent: jobsUp, here: null });
    // a section's own page: its heading says where it is, so there is no bar (the console's Overview is Console itself)
    for (const path of ["/", "/roles", "/talent", "/setup", "/admin", "/nothing-here", ""]) expect(parentTrail(path), path).toBeNull();
  });

  it("draws the trail with its link back up and never the company (the rail's chip names it), adds no landmark, and leaves the page its 1040px column (wider where a page needs it)", () => {
    nav.path = "/roles/new";
    const html = render(meAs("owner"));
    expect(html).toMatch(/<p class="[^"]*"><a href="\/roles" class="[^"]*">Jobs<\/a><span aria-hidden="true">\/<\/span><span class="[^"]*">Start a hire<\/span><\/p>/);
    // the company is named in the rail's chip and under the name in the phone's top bar, nowhere else (no coral dot)
    expect(html.match(/Bright Dental/g)).toHaveLength(2);
    expect(html).not.toMatch(/Bright Dental<\/span><span aria-hidden="true" class="[^"]*bg-accent/);
    expect(html.match(/<nav\b/g)).toHaveLength(1);
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html).not.toMatch(/<(header|aside|footer)\b/);
    expect(html).toMatch(/<main id="main" class="[^"]*max-w-\[1040px\][^"]*">/);
    // the job builder (.builder) and any page that marks an element data-wide get the wide column
    expect(html).toContain("group-has-[.builder,[data-wide]]/page:max-w-[1440px]");
    expect(html).toContain("<p>page</p></main>");
    // the page's gutter grows 16px, 24px (from sm:, 640px), 40px (from rail:, 900px): named breakpoints only, all in rem,
    // so Tailwind sorts sm: before rail: and rail:px-10 wins on a wide screen; no pixel copy of a breakpoint
    // (min-[900px]:, max-[900px]:, min-[640px]:), which would sort before every rem one
    expect(html).toMatch(/<main id="main" class="[^"]*\bpx-4 [^"]*\bsm:px-6 rail:px-10\b/);
    expect(html).not.toMatch(/class="[^"]*(?<![\w-])(min|max)-\[[\d.]+px\]:/);
  });

  it("draws no bar on a section's own page, so the page column opens on the page; a page under another gets its trail", () => {
    for (const path of ["/", "/roles", "/talent", "/setup"]) {
      nav.path = path;
      const html = render(meAs("owner"));
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
    // a job's page: the way back up is there from the first draw, without the job's name
    nav.path = "/roles/r-open/talent";
    expect(render(meAs("owner"))).toMatch(/<p class="[^"]*"><a href="\/roles" class="[^"]*">Jobs<\/a><\/p>/);
  });
});

describe("the rail's foot and labels", () => {
  it("ends the rail with who is signed in: no slogan card, and no label over the company's own links", () => {
    for (const path of ["/", "/roles/r-open"]) {
      nav.path = path;
      const html = render(meAs("owner"));
      for (const cut of ["People first.", "Suggestions help you think", "Your desk"]) expect(html, `${path}: ${cut}`).not.toContain(cut);
      // the foot keeps its place at the bottom of the side rail, with the person's email and Sign out
      expect(html, path).toMatch(/<div class="[^"]* rail:mt-auto[^"]*">(?:(?!<\/nav>)[\s\S])*owner@bright\.test(?:(?!<\/nav>)[\s\S])*>Sign out<\/span><\/button>/);
    }
  });

  it("keeps the ITS staff's Admin label, which tells the console apart from the company's links", () => {
    nav.path = "/admin";
    const html = render(admin());
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

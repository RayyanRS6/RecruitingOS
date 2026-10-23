"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Avatar, cx, Icon, type IconName, initials, Kbd, Menu } from "@ros/ui";
import { ApiError, api, type RoleSummary } from "@ros/web/src/api/client";
import { NavLink } from "@ros/web/src/nav";
import { otherCompanies, type RailRole, railCompact, railListsRoles, railRoles, teamRoleWord } from "@ros/web/src/rail";
import { clearAllQuickStarts } from "@ros/web/src/pages/new-role/quick-start";
import { canSeeTalent, canStartHire } from "@ros/web/src/roles";
import { browserStorage, isFormControl, isStartHireShortcut, SHORTCUT_CHANGED_EVENT, START_HIRE_HREF, START_HIRE_KEY, startHireShortcutOn } from "@ros/web/src/start-hire";
import type { Me } from "../lib/session";
import { shownTheme, type Theme, themeCookie } from "../lib/theme";
import { BrandMark } from "./BrandMark";

/**
 * The ITS console's sections under Console in the rail, each its own address (redesign spec 3.1). Each has an icon, so
 * the rail folded to icons still shows all five and every section stays one click away (spec 3.6).
 */
export const CONSOLE_LINKS: ReadonlyArray<{ to: string; label: string; icon: IconName }> = [
  { to: "/admin", label: "Overview", icon: "home" },
  { to: "/admin/customers", label: "Customers", icon: "building" },
  { to: "/admin/privacy", label: "Privacy requests", icon: "lock" },
  { to: "/admin/problems", label: "Problems", icon: "alert" },
  { to: "/admin/system", label: "System and settings", icon: "settings" },
];

/** Where this browser remembers that the rail was folded to icons (founder answer F3). */
export const RAIL_COLLAPSED_KEY = "ros.rail.collapsed";

/** Whether the rail was folded on this browser; false where nothing can be read (blocked site data, a private window). */
export function railCollapsedIn(storage: Storage | null): boolean {
  try {
    return storage?.getItem(RAIL_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers the choice; where the browser keeps nothing, the rail still folds for this visit. */
export function rememberRailCollapsed(storage: Storage | null, collapsed: boolean): void {
  try {
    if (collapsed) storage?.setItem(RAIL_COLLAPSED_KEY, "1");
    else storage?.removeItem(RAIL_COLLAPSED_KEY);
  } catch {
    // nothing to do: the choice holds until the page is left
  }
}

/**
 * Where the page sits, in the rail's own words (the section, then the job or console section when there is one).
 * Empty for a page the rail does not lead to. A job is named only when the rail lists it.
 */
export function sectionTrail(pathname: string, jobs: ReadonlyArray<Pick<RailRole, "id" | "title">> = []): string[] {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (pathname === "/") return ["Home"];
  if (under("/updates")) return ["Home", "Updates"];
  if (pathname === START_HIRE_HREF) return ["Jobs", "Start a hire"];
  const job = /^\/roles\/([^/]+)/.exec(pathname);
  if (job) {
    const listed = jobs.find((r) => r.id === job[1]);
    return listed ? ["Jobs", listed.title] : ["Jobs"];
  }
  if (under("/roles")) return ["Jobs"];
  if (under("/talent") || under("/people")) return ["Candidates"];
  if (under("/interviews")) return ["Interviews"];
  if (under("/setup")) return ["Settings"];
  if (under("/recruiter")) return ["Queue"];
  if (under("/admin")) {
    const section = CONSOLE_LINKS.find((l) => (l.to === "/admin" ? pathname === "/admin" : under(l.to)));
    return section ? ["Console", section.label] : ["Console"];
  }
  return [];
}

/** The section words that are pages of their own, so a page under them can link back up. */
const SECTION_PAGES: Readonly<Record<string, string>> = { Home: "/", Jobs: "/roles", Console: "/admin" };

/**
 * The thin bar above a page that sits under another page (founder, 23 October 2026: a trail only where it has a link
 * back up): the parent as a link, then the page's own word when the rail knows it ("Jobs / Dental Hygienist",
 * "Console / Customers", "Home / Updates"). Null on a section's own page (Home, Jobs, Candidates, Settings, the
 * console's Overview...), whose heading already says where it is. Decided from the address alone, so the bar never
 * appears late: a job the rail does not list still gets "Jobs", without its name.
 */
export function parentTrail(pathname: string, jobs: ReadonlyArray<Pick<RailRole, "id" | "title">> = []): { parent: { label: string; href: string }; here: string | null } | null {
  const [section, here = null] = sectionTrail(pathname, jobs);
  const href = section ? SECTION_PAGES[section] : undefined;
  const page = pathname.replace(/\/+$/, "") || "/";
  if (!section || !href || href === page) return null;
  return { parent: { label: section, href }, here };
}

/** A box inside the rail, in pixels from its top left corner (scrolled content included). */
export type MarkBox = { x: number; y: number; w: number; h: number };

/**
 * The move that carries the current-link highlight from where it stood to where it now stands: a transform that puts
 * the new highlight over the old one, played back to none. Null when it has not moved (or one box is not drawn).
 */
export function markMove(from: MarkBox, to: MarkBox): string | null {
  if (!from.w || !from.h || !to.w || !to.h) return null;
  const dx = Math.round(from.x - to.x);
  const dy = Math.round(from.y - to.y);
  const sx = Math.round((from.w / to.w) * 1000) / 1000;
  const sy = Math.round((from.h / to.h) * 1000) / 1000;
  if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return null;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * The highlight behind the current link glides to the next current link (spec 4: a shared highlight). Each list has its
 * own highlight (data-mark="main" | "job" | "console"), drawn by the current link alone, so the server and the first
 * draw are the same and nothing starts hidden. After each draw the rail notes where each highlight is; when a different
 * link becomes current, its highlight plays from the old place to the new one on transform (280ms, the soft ease),
 * with the Web Animations API, so it is part of document.getAnimations(). Nothing moves under reduced motion, and a
 * highlight that is not drawn (a folded list, the closed phone menu) is skipped.
 */
function useMarkGlide(rail: RefObject<HTMLElement | null>) {
  const last = useRef(new Map<string, { el: Element; box: MarkBox }>());
  useIsoLayoutEffect(() => {
    const root = rail.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const still = typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const now = new Map<string, { el: Element; box: MarkBox }>();
    for (const el of root.querySelectorAll<HTMLElement>("[data-mark]")) {
      // the link's box: the highlight fills it, and the link itself never moves on transform
      const r = (el.parentElement ?? el).getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const box = { x: r.left - base.left + root.scrollLeft, y: r.top - base.top + root.scrollTop, w: r.width, h: r.height };
      const group = el.dataset.mark ?? "";
      const before = last.current.get(group);
      now.set(group, { el, box });
      if (!before || before.el === el || still || typeof el.animate !== "function") continue;
      const move = markMove(before.box, box);
      if (move) el.animate([{ transformOrigin: "0 0", transform: move }, { transformOrigin: "0 0", transform: "none" }], { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    }
    last.current = now;
  });
}

/**
 * The lavender highlight behind the current link (absolutely placed under its icon and word). The links themselves are
 * not stacking contexts: every highlight paints at the bottom of its list (the list is `isolate`), under every link of
 * that list, so a highlight gliding past other links never covers their icons and words.
 */
function Mark({ group }: { group: "main" | "job" | "console" }) {
  return <span data-mark={group} aria-hidden="true" className="absolute inset-0 -z-10 rounded-[inherit] bg-tint" />;
}

// The rail's looks. Phones and tablets get the top bar (max-rail:, under 900px); rail: is the side rail, from 900px.
// Whole class strings only, so Tailwind finds them. The top bar's gutter is the page's (16px, 24px from sm:). rail: is a
// named breakpoint in rem (styles.css, --breakpoint-rail), so Tailwind sorts it after sm: and md: and before lg:, and
// they mix safely on one property; never write the switch as min-[900px]:, which would sort before every rem one.
const SHELL = "grid min-h-screen grid-cols-[minmax(0,1fr)] rail:grid-cols-[248px_minmax(0,1fr)]";
const SHELL_FOLDED = "grid min-h-screen grid-cols-[minmax(0,1fr)] rail:grid-cols-[72px_minmax(0,1fr)]";
const RAIL =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-3 border-b border-line bg-surface px-4 py-3 sm:px-6 rail:sticky rail:top-0 rail:z-20 rail:flex rail:h-screen rail:flex-col rail:items-stretch rail:gap-0 rail:overflow-y-auto rail:overflow-x-hidden rail:border-b-0 rail:border-r rail:py-5";
// A current link's own hover leaves its highlight in view (the highlight sits under the link's background).
const LINK =
  "relative flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium text-ink-2 transition-colors duration-150 ease-soft hover:bg-surface-2 [&.active]:font-semibold [&.active]:text-primary [&.active]:hover:bg-transparent [&_.icon]:shrink-0 [&_.icon]:text-ink-3 [&.active_.icon]:text-primary";
const LINK_FOLDED = `${LINK} rail:justify-center rail:px-0`;
// 40px tall in the phone menu (a finger's target), 32px in the side rail's lists.
const SUB_LINK =
  "relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] text-ink-2 transition-colors duration-150 ease-soft hover:bg-surface-2 max-rail:h-10 [&.active]:font-semibold [&.active]:text-primary [&.active]:hover:bg-transparent [&_.icon]:shrink-0 [&_.icon]:text-ink-3 [&.active_.icon]:text-primary";
const SUB_LINK_FOLDED = `${SUB_LINK} rail:h-10 rail:justify-center rail:rounded-xl rail:px-0`;
const SUB_LIST = "isolate my-0.5 ml-[22px] grid grid-cols-[minmax(0,1fr)] gap-px border-l border-line py-0.5 pl-2";
const SECTION = "px-3 pb-1.5 pt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3";
const SECTION_FIRST = "px-3 pb-1.5 pt-1 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3 max-rail:pt-0";

/** A link of the rail: icon and word; folded, the icon alone, the word kept for screen readers and in the tooltip. */
function RailLink(props: { to: string; end?: boolean; icon: IconName; label: string; folded: boolean }) {
  return (
    <NavLink to={props.to} end={props.end} className={props.folded ? LINK_FOLDED : LINK} title={props.folded ? props.label : undefined}>
      {(active) => (
        <>
          {active ? <Mark group="main" /> : null}
          <Icon name={props.icon} />
          <span className={props.folded ? "min-w-0 truncate rail:sr-only" : "min-w-0 truncate"}>{props.label}</span>
        </>
      )}
    </NavLink>
  );
}

/**
 * A mono label over the ITS staff's groups of links (Recruiter, Admin), which it tells apart from the company's own
 * links above them; the folded rail draws a hairline instead (the phone menu keeps the word).
 */
function SectionLabel({ children, folded, first }: { children: string; folded: boolean; first?: boolean }) {
  const look = first ? SECTION_FIRST : SECTION;
  return (
    <>
      <div className={folded ? `${look} rail:hidden` : look}>{children}</div>
      {folded ? <div aria-hidden="true" className="mx-3 my-3 hidden h-px bg-line rail:block" /> : null}
    </>
  );
}

/**
 * The signed-in frame (docs/07): the rail, a thin bar with the way back up on a page that sits under another (a job,
 * the job builder, Updates, a console section; none on a section's own page), the staff-access notice, the
 * development-mode notice, and the page.
 *
 * The rail, top to bottom: the name, the company chip (your role, a "Switch company" menu for someone in more than one
 * company, and a cog to Settings), "Start a hire" for the people who may start one (N opens it from anywhere outside a
 * text field, on a page with nothing changed), Home, Jobs with the jobs being worked on listed underneath (for members
 * only; a live job opens on its Candidates), Candidates, Interviews, Settings (Queue and Console for ITS staff under
 * their Recruiter and Admin labels, the console's five sections listed under Console for platform administrators), and,
 * at its foot, who is signed in with Sign out and the light/dark theme switch. No slogans and no label over the
 * company's own links (founder, 23 October 2026: fewer words). The current link sits on a lavender highlight that
 * glides to the next one.
 * On a job's own pages it folds to a column of icons; on every other page the button at its top folds it the same way
 * (founder answer F3), and this browser remembers the choice. Under 900px it becomes a top bar: Start a hire, Sign out
 * and the theme switch stay in it, and the links fold behind a Menu button. (The routes keep their old names: /,
 * /roles, /talent, /setup.)
 *
 * The page column is 1040px wide at most; 1280px when the rail was folded by choice (the room it frees), and 1440px for
 * the pages that need the width: the job builder (.builder, .start), the pool board (.pool-board), or any page that
 * marks an element with data-wide.
 */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const isStaff = ["platform_admin", "its_recruiter"].includes(me.user.platformRole);
  const isAdmin = me.user.platformRole === "platform_admin";
  const active = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  const myRole = active?.role ?? null;
  const companyName = active?.companyName ?? me.staffAccess?.companyName ?? null;
  // Links a role cannot use are not shown: an interviewer has no Candidates page, only the interviews they are on.
  const showTalent = !active || canSeeTalent(active.role);
  // The same rule as Home's button: role.create, held through a membership (an ITS recruiter's grant does not start hires).
  const mayStartHire = !!me.activeCompanyId && canStartHire(myRole);

  // The jobs under Jobs, for members only: an ITS recruiter under a grant gets no list (each request they make is
  // recorded for the customer as a page they opened). The API gives an interviewer only the jobs they interview for.
  // The list refreshes when a page changes a job and every two minutes while the tab is in view. Home reads the same list.
  const listRoles = railListsRoles(me);
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles"), enabled: listRoles, refetchInterval: 120_000 });
  const listed = listRoles ? railRoles(roles.data ?? [], { role: myRole }) : [];

  // Something typed, ticked or chosen on this page may not be saved yet, so N leaves the page alone until the person
  // moves to another page (the Start a hire button still works).
  const [editedOn, setEditedOn] = useState<string | null>(null);
  useEffect(() => {
    const mark = (e: Event) => {
      if (isFormControl(e.target instanceof Element ? (e.target as HTMLElement) : null)) setEditedOn(window.location.pathname);
    };
    document.addEventListener("input", mark, true);
    document.addEventListener("change", mark, true);
    return () => {
      document.removeEventListener("input", mark, true);
      document.removeEventListener("change", mark, true);
    };
  }, []);
  const unsavedWork = editedOn === pathname;

  // The shortcut follows the person's choice in Setup, read after the first render (the server has no storage). Setup
  // says what was chosen on the event itself, so the choice holds even where the browser would not save it; another
  // tab's change arrives as a storage event.
  const [shortcutOn, setShortcutOn] = useState(true);
  useEffect(() => {
    const read = (e?: Event) => {
      const chosen = e instanceof CustomEvent ? (e.detail as { on?: unknown } | null)?.on : undefined;
      setShortcutOn(typeof chosen === "boolean" ? chosen : startHireShortcutOn(browserStorage()));
    };
    read();
    window.addEventListener(SHORTCUT_CHANGED_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(SHORTCUT_CHANGED_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);
  useEffect(() => {
    if (!mayStartHire || !shortcutOn) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? (e.target as HTMLElement) : null;
      if (!isStartHireShortcut(e, target, { modalOpen: !!document.querySelector('[aria-modal="true"]'), unsavedWork })) return;
      e.preventDefault();
      router.push(START_HIRE_HREF);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mayStartHire, shortcutOn, unsavedWork, router]);

  // The rail folded to icons by choice (F3): read after the first render (the server has no storage, so both first draws
  // show it open), saved on every change; where the browser keeps nothing, it still folds for this visit. A job's pages
  // fold it whatever was chosen, so the button is not offered there. A full page load therefore draws the rail open and
  // folds it just after; that brief jump is accepted rather than adding an inline script before paint. The button keeps
  // one name and says whether it is on (aria-pressed).
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(railCollapsedIn(browserStorage()));
  }, []);
  const foldedByPage = railCompact(pathname);
  const foldedByChoice = collapsed && !foldedByPage;
  const folded = foldedByPage || foldedByChoice;
  const toggleRail = () => {
    const next = !collapsed;
    setCollapsed(next);
    rememberRailCollapsed(browserStorage(), next);
  };

  // The light/dark switch beside Sign out. The server drew the page in the theme picked last on this browser; with none
  // picked the page follows the device, which only the browser knows, so the icon settles after the first render. A pick
  // shows at once and is remembered in a cookie (lib/theme.ts). The button keeps one name and says whether it is on.
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const device = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => setDark(shownTheme(document.documentElement.dataset.theme, device.matches) === "dark");
    read();
    device.addEventListener("change", read);
    return () => device.removeEventListener("change", read);
  }, []);
  const toggleTheme = () => {
    const next: Theme = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    // biome-ignore lint/suspicious/noDocumentCookie: one small preference cookie; the Cookie Store API is missing from the older browsers we support
    document.cookie = themeCookie(next, window.location.protocol === "https:");
    setDark(next === "dark");
  };

  // The phone menu belongs to the page it was opened on: following a link closes it. Escape closes it too.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuOpen = menuFor === pathname;
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuFor(null);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  // The company menu (rows 9 and 49): someone in more than one company moves between them here, through POST
  // /auth/switch. Nothing read for the company they leave may show in the next one, so the cache is emptied and the
  // frame drawn again from the new session, on Home.
  const others = otherCompanies(me);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const switchTo = async (companyId: string) => {
    setSwitchError(null);
    try {
      await api.post("/api/v1/auth/switch", { companyId });
    } catch (e) {
      setSwitchError(e instanceof ApiError ? e.message : "Could not switch company. Try again.");
      return;
    }
    qc.clear();
    router.push("/");
    router.refresh();
  };

  const logout = async () => {
    await api.post("/api/v1/auth/logout");
    // The quick start's answers (pay ceiling, deal-breakers) are never left behind for the next person on this browser.
    clearAllQuickStarts(browserStorage());
    qc.clear();
    router.push("/login");
    router.refresh();
  };

  const rail = useRef<HTMLElement>(null);
  useMarkGlide(rail);

  const who = me.user.name ?? me.user.email;
  const roleWord = teamRoleWord(myRole, !!me.staffAccess);
  // The company the page is about, under the name in the phone's top bar (wider screens have the rail's company chip).
  const workspace = companyName ? (active ? companyName : `${companyName} (recruiter access)`) : isStaff ? "ITS staff" : "No company";
  const trail = parentTrail(pathname, listed);
  const width = cx(foldedByChoice ? "max-w-[1280px]" : "max-w-[1040px]", "group-has-[.builder,.start,.pool-board,[data-wide]]/page:max-w-[1440px]");
  return (
    <div className={folded ? SHELL_FOLDED : SHELL} data-rail={folded ? "compact" : undefined} data-collapsed={foldedByChoice ? "true" : undefined}>
      <nav ref={rail} className={cx(RAIL, folded ? "rail:px-3" : "rail:px-4")} aria-label="Main">
        <div className={folded ? "flex min-w-0 items-center max-rail:col-start-1 max-rail:row-start-1 rail:flex-col rail:gap-3" : "flex min-w-0 items-center justify-between gap-2 max-rail:col-start-1 max-rail:row-start-1 rail:pl-1"}>
          <BrandMark textClassName={folded ? "rail:sr-only" : undefined} sub={<small className="truncate text-[12px] text-ink-3 rail:hidden">{workspace}</small>} />
          {foldedByPage ? null : (
            <button type="button" className="icon-btn sm shrink-0 max-rail:hidden" aria-label="Fold the menu to icons" aria-pressed={collapsed} title={collapsed ? "Show the full menu" : "Fold the menu to icons"} onClick={toggleRail}>
              <Icon name={collapsed ? "chevron-right" : "chevron-left"} size={16} />
            </button>
          )}
        </div>
        <div aria-hidden="true" className="my-4 hidden h-px bg-line rail:block" />
        {companyName ? (
          <div className={folded ? "mb-4 hidden justify-center rail:flex" : "mb-4 hidden items-center gap-2.5 rounded-2xl border border-line bg-surface-2/60 py-2 pl-2 pr-1.5 rail:flex"}>
            {/* the workspace's initial on coral-peach (spec 5), beside its name: decorative */}
            <span aria-hidden="true" className="grid size-9 shrink-0 select-none place-items-center rounded-xl bg-peach font-display text-[15px] font-bold leading-none text-accent-ink">
              {initials(companyName, 1)}
            </span>
            <div className={folded ? "hidden" : "grid min-w-0 flex-1 leading-tight"}>
              <strong className="truncate text-[14px] font-semibold text-ink">{companyName}</strong>
              {roleWord ? <span className="truncate text-[12px] text-ink-3">{roleWord}</span> : null}
            </div>
            <div className={folded ? "hidden" : "flex shrink-0 items-center"}>
              {others.length > 0 && active ? (
                <Menu
                  label={<Icon name="building" size={16} />}
                  ariaLabel="Switch company"
                  title="Switch company"
                  heading="Your companies"
                  buttonClassName="icon-btn sm"
                  align="end"
                  items={[{ id: active.companyId, label: active.companyName, current: true }, ...others.map((o) => ({ id: o.companyId, label: o.companyName, hint: teamRoleWord(o.role, false) ?? undefined, current: false }))]}
                  onSelect={(id) => { if (id !== active.companyId) void switchTo(id); }}
                />
              ) : null}
              <NextLink href="/setup" className="icon-btn sm" aria-label="Company settings" title="Company settings">
                <Icon name="settings" size={16} />
              </NextLink>
            </div>
          </div>
        ) : null}
        {switchError ? <div className="col-span-2 rail:mb-3"><Alert tone="critical">{switchError}</Alert></div> : null}
        {/* The phone's Menu button comes before Start a hire, as it is drawn (top row, then the second), so Tab follows
            the bar from the top; the side rail does not show it. */}
        <button ref={toggle} type="button" className="btn secondary sm max-rail:col-start-2 max-rail:row-start-1 max-rail:justify-self-end rail:hidden" aria-expanded={menuOpen} aria-controls="rail-links" onClick={() => setMenuFor(menuOpen ? null : pathname)}>
          <Icon name={menuOpen ? "x" : "menu"} size={16} />
          Menu
        </button>
        {mayStartHire ? (
          <NextLink
            href={START_HIRE_HREF}
            className={
              folded
                ? "btn primary max-rail:col-start-1 max-rail:row-start-2 max-rail:justify-self-start max-rail:[&_.kbd]:hidden rail:mb-5 rail:size-11 rail:self-center rail:justify-center rail:p-0 rail:[&_.kbd]:hidden"
                : "btn primary max-rail:col-start-1 max-rail:row-start-2 max-rail:justify-self-start max-rail:[&_.kbd]:hidden rail:mb-5 rail:w-full rail:justify-start [&_.kbd]:ml-auto [&_.kbd]:border-on-primary/30 [&_.kbd]:bg-on-primary/10 [&_.kbd]:text-on-primary"
            }
            aria-label="Start a hire"
            aria-keyshortcuts={shortcutOn ? START_HIRE_KEY : undefined}
            title={shortcutOn ? `Start a hire (press ${START_HIRE_KEY})` : "Start a hire"}
          >
            <Icon name="plus" />
            <span className={folded ? "rail:sr-only" : undefined}>Start a hire</span>
            {shortcutOn ? <Kbd decorative>{START_HIRE_KEY}</Kbd> : null}
          </NextLink>
        ) : null}
        {/* pb: the links keep 16px clear of the foot when they fill the rail (the foot's mt-auto then has no room) */}
        <div className="isolate col-span-2 hidden animate-fade flex-col gap-0.5 border-t border-line pt-3 data-[open=true]:flex rail:flex rail:animate-none rail:gap-1.5 rail:border-t-0 rail:pb-4 rail:pt-0" id="rail-links" data-open={menuOpen ? "true" : undefined}>
          {me.activeCompanyId ? (
            <>
              <RailLink to="/" end icon="home" label="Home" folded={folded} />
              <RailLink to="/roles" icon="roles" label="Jobs" folded={folded} />
              {listed.length ? (
                <ul className={folded ? `${SUB_LIST} rail:hidden` : SUB_LIST} aria-label="Jobs in progress">
                  {listed.map((r) => (
                    <li key={r.id}>
                      <NavLink to={r.href} activeFor={`/roles/${r.id}`} className={SUB_LINK}>
                        {(on) => (
                          <>
                            {on ? <Mark group="job" /> : null}
                            <span className={r.live ? "dot good" : "dot"} aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate">{r.title}</span>
                            {/* a count, or a short word where there is none: the dot's colour never says the status alone */}
                            {r.applicants !== null ? <span className="shrink-0 text-[12px] font-normal tabular-nums text-ink-3" aria-hidden="true">{r.applicants}</span> : r.tag ? <span className="shrink-0 text-[11.5px] font-normal text-ink-3" aria-hidden="true">{r.tag}</span> : null}
                            <span className="sr-only">, {r.statusWord}</span>
                          </>
                        )}
                      </NavLink>
                    </li>
                  ))}
                  <li><NextLink href="/roles" className={SUB_LINK}><span className="min-w-0 flex-1 truncate">All jobs</span></NextLink></li>
                </ul>
              ) : null}
              {showTalent ? <RailLink to="/talent" icon="talent" label="Candidates" folded={folded} /> : null}
              <RailLink to="/interviews" icon="interviews" label="Interviews" folded={folded} />
              <RailLink to="/setup" icon="settings" label="Settings" folded={folded} />
            </>
          ) : null}
          {isStaff ? (
            <>
              <SectionLabel folded={folded} first={!me.activeCompanyId}>Recruiter</SectionLabel>
              <RailLink to="/recruiter/queue" icon="grid" label="Queue" folded={folded} />
            </>
          ) : null}
          {isAdmin ? (
            <>
              <SectionLabel folded={folded}>Admin</SectionLabel>
              <RailLink to="/admin" icon="lock" label="Console" folded={folded} />
              {/* The console's sections (Wave S6): Console stays marked on all of them, the section itself too. Folded,
                  the rail still shows them, as icons with their word in the tooltip. */}
              <ul className={folded ? `${SUB_LIST} rail:ml-0 rail:border-l-0 rail:pl-0` : SUB_LIST} aria-label="Console sections">
                {CONSOLE_LINKS.map((l) => (
                  <li key={l.to}>
                    <NavLink to={l.to} end={l.to === "/admin"} className={folded ? SUB_LINK_FOLDED : SUB_LINK} title={folded ? l.label : undefined}>
                      {(on) => (
                        <>
                          {on ? <Mark group="console" /> : null}
                          <Icon name={l.icon} size={16} />
                          <span className={folded ? "min-w-0 flex-1 truncate rail:sr-only" : "min-w-0 flex-1 truncate"}>{l.label}</span>
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        {/* The foot, at the bottom of the rail: who is signed in, Sign out and the theme switch. Which AI company we use
            is shown in Settings, not here. Sign out stays reachable in the phone's top bar. */}
        <div className="flex items-center gap-1 max-rail:col-start-2 max-rail:row-start-2 max-rail:justify-self-end rail:mt-auto rail:flex-col rail:items-stretch rail:gap-2.5 rail:border-t rail:border-line rail:pt-4">
          <div className={folded ? "hidden" : "hidden min-w-0 items-center gap-2.5 px-1 rail:flex"}>
            <Avatar name={who} tone="ink" size="sm" />
            <span className="grid min-w-0 leading-tight">
              <strong className="truncate text-[13.5px] font-semibold text-ink">{me.user.name ?? me.user.email}</strong>
              {me.user.name ? <span className="truncate text-[12px] text-ink-3">{me.user.email}</span> : null}
            </span>
          </div>
          <div className={folded ? "flex items-center gap-1 rail:flex-col" : "flex items-center gap-1 rail:justify-between"}>
            <button type="button" className={folded ? "btn quiet sm rail:size-9 rail:justify-center rail:p-0" : "btn quiet sm"} title={folded ? "Sign out" : undefined} onClick={logout}>
              <Icon name="log-out" size={16} className="max-rail:hidden" />
              <span className={folded ? "rail:sr-only" : undefined}>Sign out</span>
            </button>
            <button type="button" className="icon-btn sm" aria-label="Dark theme" aria-pressed={dark} title={dark ? "Switch to the light theme" : "Switch to the dark theme"} onClick={toggleTheme}>
              <Icon name={dark ? "sun" : "moon"} size={16} />
            </button>
          </div>
        </div>
      </nav>
      <div className="group/page flex min-w-0 flex-col">
        {/* The way back up, on a page under another only (parentTrail): words and one link, not a landmark (the rail
            and the page's own heading lead). The company is not repeated here: the rail's chip names it. Phones have
            their own top bar. */}
        {trail ? (
          <div className="hidden h-16 shrink-0 border-b border-line bg-ground/95 rail:block">
            <p className={cx("mx-auto flex h-full w-full min-w-0 items-center gap-2 px-10 text-[13px] text-ink-3", width)}>
              <NextLink href={trail.parent.href} className="shrink-0 rounded-md font-medium text-ink-2 underline decoration-line-strong underline-offset-[3px] transition-colors duration-150 ease-soft hover:text-primary hover:decoration-current pointer-coarse:inline-flex pointer-coarse:min-h-10 pointer-coarse:items-center">
                {trail.parent.label}
              </NextLink>
              {trail.here ? (
                <>
                  <span aria-hidden="true">/</span>
                  <span className="truncate font-medium text-ink">{trail.here}</span>
                </>
              ) : null}
            </p>
          </div>
        ) : null}
        <main id="main" className={cx("mx-auto w-full min-w-0 flex-1 px-4 pb-16 pt-5 sm:px-6 rail:px-10 rail:pb-20", trail ? "rail:pt-9" : "rail:pt-12", width)}>
          {me.staffAccess ? <div className="mb-4"><Alert tone="info">You are inside {me.staffAccess.companyName} through an escalation ({me.staffAccess.purpose}). Access is limited to that request and ends {new Date(me.staffAccess.expiresAt).toLocaleString()}. Every page you open is recorded for the customer.</Alert></div> : null}
          {me.ai.provider === "fake" ? <div className="mb-4"><Alert tone="caution">Development mode: the AI provider is a deterministic stand-in, so its drafts are rough.</Alert></div> : null}
          {children}
        </main>
      </div>
    </div>
  );
}

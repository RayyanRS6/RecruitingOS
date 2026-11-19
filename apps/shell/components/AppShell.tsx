"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { appPaths, type NotificationHistoryPage } from "@ros/contracts";
import { Alert, Avatar, cx, Icon, type IconName, initials, Menu } from "@ros/ui";
import { ApiError, api } from "@ros/web/src/api/client";
import { NavLink } from "@ros/web/src/nav";
import { ADMIN_LINKS, browserStorage, COMPANY_LINKS, otherCompanies, railCompact, teamRoleWord, unreadBadge } from "@ros/web/src/rail";
import { watchForEndedSession } from "@ros/web/src/session-ended";
import type { Me } from "../lib/session";
import { shownTheme, type Theme, themeCookie } from "../lib/theme";
import { BrandMark } from "./BrandMark";

/** Where this browser remembers that the rail was folded to icons. */
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
 * Where the page sits, in the rail's own words (the section, then the page under it when the frame can name it: the
 * job builder, Updates). Empty for a page the rail does not lead to. A job's own pages are under Jobs; the page's
 * heading names the job. Each section of the admin dashboard is a place of its own.
 */
export function sectionTrail(pathname: string): string[] {
  const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
  if (pathname === appPaths.home) return ["Home"];
  if (under(appPaths.updates)) return ["Home", "Updates"];
  if (pathname === appPaths.newJob) return ["Jobs", "Start a hire"];
  if (under(appPaths.jobs)) return ["Jobs"];
  if (under(appPaths.allCandidates)) return ["Candidates"];
  if (under(appPaths.settings)) return ["Settings"];
  const admin = ADMIN_LINKS.find((l) => (l.end ? pathname === l.to : under(l.to)));
  return admin ? [admin.label] : [];
}

/** The section words that are pages of their own, so a page under them can link back up. */
const SECTION_PAGES: Readonly<Record<string, string>> = { Home: "/", Jobs: "/roles" };

/**
 * The thin bar above a page that sits under another page (a trail only where it has a link back up): the parent as a
 * link, then the page's own word when the frame can name it ("Jobs / Start a hire", "Home / Updates"; a job's pages
 * get "Jobs" alone). Null on a section's own page (Home, Jobs, Candidates, Settings, a section of the admin
 * dashboard), whose heading already says where it is. Decided from the address alone, so the bar never appears late.
 */
export function parentTrail(pathname: string): { parent: { label: string; href: string }; here: string | null } | null {
  const [section, here = null] = sectionTrail(pathname);
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
 * The highlight behind the current link glides to the next current link (a shared highlight). It is drawn by the
 * current link alone (data-mark), so the server and the first draw are the same and nothing starts hidden. After each
 * draw the rail notes where the highlight is; when a different link becomes current, the highlight plays from the old
 * place to the new one on transform (280ms, the soft ease), with the Web Animations API, so it is part of
 * document.getAnimations(). Nothing moves under reduced motion, and a highlight that is not drawn (the closed phone
 * menu) is skipped.
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
 * not stacking contexts: the highlight paints at the bottom of the list (the list is `isolate`), under every link of
 * it, so a highlight gliding past other links never covers their icons and words.
 */
function Mark() {
  return <span data-mark="main" aria-hidden="true" className="absolute inset-0 -z-10 rounded-[inherit] bg-tint" />;
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
const SECTION = "px-3 pb-1.5 pt-5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3";

/** A link of the rail: icon and word; folded, the icon alone, the word kept for screen readers and in the tooltip. */
function RailLink(props: { to: string; end?: boolean; icon: IconName; label: string; folded: boolean }) {
  return (
    <NavLink to={props.to} end={props.end} className={props.folded ? LINK_FOLDED : LINK} title={props.folded ? props.label : undefined}>
      {(active) => (
        <>
          {active ? <Mark /> : null}
          <Icon name={props.icon} />
          <span className={props.folded ? "min-w-0 truncate rail:sr-only" : "min-w-0 truncate"}>{props.label}</span>
        </>
      )}
    </NavLink>
  );
}

/**
 * A mono label over the admin dashboard's links (Admin), for a platform administrator who also works in a company: it
 * tells them apart from the company's own links above. The folded rail draws a hairline instead (the phone menu keeps
 * the word).
 */
function SectionLabel({ children, folded }: { children: string; folded: boolean }) {
  return (
    <>
      <div className={folded ? `${SECTION} rail:hidden` : SECTION}>{children}</div>
      {folded ? <div aria-hidden="true" className="mx-3 my-3 hidden h-px bg-line rail:block" /> : null}
    </>
  );
}

/**
 * The signed-in frame (docs/07): the rail, a thin bar with the way back up on a page that sits under another (a job,
 * the job builder, Updates; none on a section's own page), the development-mode notice, and the page.
 *
 * The rail, top to bottom: the name, the company chip (your role, a "Switch company" menu for someone in more than one
 * company, and a cog to Settings), "Start a hire", then Home, Jobs, Candidates and Settings; a platform administrator
 * gets Companies, Privacy requests and System instead (under an Admin label when they also work in a company); and,
 * at its foot, who is signed in with Updates (and how many are unread), Sign out and the light/dark theme switch. No
 * slogans and no label over the company's own links. The current link sits on a lavender highlight that glides to the
 * next one.
 * On a job's own pages it folds to a column of icons; on every other page the button at its top folds it the same way,
 * and this browser remembers the choice. Under 900px it becomes a top bar: Start a hire, Updates, Sign out and the
 * theme switch stay in it, and the links fold behind a Menu button.
 *
 * The page column is 1040px wide at most; 1280px when the rail was folded by choice (the room it frees), and 1440px for
 * the pages that need the width: the job builder (.builder), or any page that marks an element with data-wide.
 */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const isAdmin = me.user.platformRole === "platform_admin";
  const active = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  const myRole = active?.role ?? null;
  const companyName = active?.companyName ?? null;
  // Everyone on a company's team may start a hire; a platform administrator with no company has none to hire for.
  const inCompany = !!me.activeCompanyId;

  // How many updates this person has not read: asked for with the frame, again every two minutes while the tab is in
  // view, and whenever the Updates page marks one (it invalidates every "notifications" read).
  const unread = useQuery({
    queryKey: ["notifications", "history", "frame"],
    queryFn: () => api.get<NotificationHistoryPage>("/api/v1/notifications/history?filter=unread&limit=5"),
    enabled: inCompany,
    refetchInterval: 120_000,
  });
  const updates = unreadBadge(inCompany ? unread.data?.unreadCount : 0);

  // Any page's own look that answers 401 sends it to sign in: the session ended under a tab left open (Take away
  // access, Sign out everywhere), and no page in the frame stays on "Could not load" with a Try again that cannot work.
  useEffect(() => watchForEndedSession(qc, () => window.location.assign("/login")), [qc]);

  // The rail folded to icons by choice: read after the first render (the server has no storage, so both first draws
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

  // The company menu: someone in more than one company moves between them here, through POST
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
    qc.clear();
    router.push("/login");
    router.refresh();
  };

  const rail = useRef<HTMLElement>(null);
  useMarkGlide(rail);

  const who = me.user.name ?? me.user.email;
  const roleWord = teamRoleWord(myRole);
  // The company the page is about, under the name in the phone's top bar (wider screens have the rail's company chip).
  const workspace = companyName ?? (isAdmin ? "Admin dashboard" : "No company");
  const trail = parentTrail(pathname);
  const width = cx(foldedByChoice ? "max-w-[1280px]" : "max-w-[1040px]", "group-has-[.builder,[data-wide]]/page:max-w-[1440px]");
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
            {/* the workspace's initial on coral-peach, beside its name: decorative */}
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
                  items={[{ id: active.companyId, label: active.companyName, current: true }, ...others.map((o) => ({ id: o.companyId, label: o.companyName, hint: teamRoleWord(o.role) ?? undefined, current: false }))]}
                  onSelect={(id) => { if (id !== active.companyId) void switchTo(id); }}
                />
              ) : null}
              <NextLink href={appPaths.settings} className="icon-btn sm" aria-label="Company settings" title="Company settings">
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
        {inCompany ? (
          <NextLink
            href={appPaths.newJob}
            className={
              folded
                ? "btn primary max-rail:col-start-1 max-rail:row-start-2 max-rail:justify-self-start rail:mb-5 rail:size-11 rail:self-center rail:justify-center rail:p-0"
                : "btn primary max-rail:col-start-1 max-rail:row-start-2 max-rail:justify-self-start rail:mb-5 rail:w-full rail:justify-start"
            }
            title={folded ? "Start a hire" : undefined}
          >
            <Icon name="plus" />
            <span className={folded ? "rail:sr-only" : undefined}>Start a hire</span>
          </NextLink>
        ) : null}
        {/* pb: the links keep 16px clear of the foot when they fill the rail (the foot's mt-auto then has no room) */}
        <div className="isolate col-span-2 hidden animate-fade flex-col gap-0.5 border-t border-line pt-3 data-[open=true]:flex rail:flex rail:animate-none rail:gap-1.5 rail:border-t-0 rail:pb-4 rail:pt-0" id="rail-links" data-open={menuOpen ? "true" : undefined}>
          {inCompany ? COMPANY_LINKS.map((l) => <RailLink key={l.to} to={l.to} end={l.end} icon={l.icon} label={l.label} folded={folded} />) : null}
          {isAdmin ? (
            <>
              {inCompany ? <SectionLabel folded={folded}>Admin</SectionLabel> : null}
              {ADMIN_LINKS.map((l) => <RailLink key={l.to} to={l.to} end={l.end} icon={l.icon} label={l.label} folded={folded} />)}
            </>
          ) : null}
        </div>
        {/* The foot, at the bottom of the rail: who is signed in, the way to their updates with how many are unread,
            Sign out and the theme switch. All three stay reachable in the phone's top bar. */}
        <div className="flex items-center gap-1 max-rail:col-start-2 max-rail:row-start-2 max-rail:justify-self-end rail:mt-auto rail:flex-col rail:items-stretch rail:gap-2.5 rail:border-t rail:border-line rail:pt-4">
          <div className={folded ? "hidden" : "hidden min-w-0 items-center gap-2.5 px-1 rail:flex"}>
            <Avatar name={who} tone="ink" size="sm" />
            <span className="grid min-w-0 leading-tight">
              <strong className="truncate text-[13.5px] font-semibold text-ink">{me.user.name ?? me.user.email}</strong>
              {me.user.name ? <span className="truncate text-[12px] text-ink-3">{me.user.email}</span> : null}
            </span>
          </div>
          <div className={folded ? "flex items-center gap-1 rail:flex-col" : "flex items-center gap-1 rail:justify-between"}>
            {inCompany ? (
              // the count sits over the icon's corner; the link's name says it in words
              <span className="relative inline-flex">
                <NavLink to={appPaths.updates} className="icon-btn sm" aria-label={updates.spoken} title={updates.spoken}>
                  <Icon name="inbox" size={16} />
                </NavLink>
                {updates.text ? <span aria-hidden="true" className="pointer-events-none absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-primary px-1 text-[10.5px] font-semibold leading-none tabular-nums text-on-primary">{updates.text}</span> : null}
              </span>
            ) : null}
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
          {me.ai.provider === "fake" ? <div className="mb-4"><Alert tone="caution">Development mode: the AI provider is a deterministic stand-in, so its drafts are rough.</Alert></div> : null}
          {children}
        </main>
      </div>
    </div>
  );
}

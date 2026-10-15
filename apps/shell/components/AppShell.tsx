"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, Avatar, Button, Icon, type IconName, Kbd, Menu } from "@ros/ui";
import { ApiError, api, type RoleSummary } from "@ros/web/src/api/client";
import { NavLink } from "@ros/web/src/nav";
import { otherCompanies, railCompact, railListsRoles, railRoles, teamRoleWord } from "@ros/web/src/rail";
import { clearAllQuickStarts } from "@ros/web/src/pages/new-role/quick-start";
import { canSeeTalent, canStartHire } from "@ros/web/src/roles";
import { browserStorage, isFormControl, isStartHireShortcut, SHORTCUT_CHANGED_EVENT, START_HIRE_HREF, START_HIRE_KEY, startHireShortcutOn } from "@ros/web/src/start-hire";
import type { Me } from "../lib/session";
import { shownTheme, type Theme, themeCookie } from "../lib/theme";
import "./app-shell.css";

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
 * The signed-in frame (docs/07): the rail, the staff-access notice, the development-mode notice, and the page.
 *
 * The rail, top to bottom: the company chip (your role, a "Switch company" menu for someone in more than one company,
 * and a cog to Settings), "Start a hire" for the people who may
 * start one (N opens it from anywhere outside a text field, on a page with nothing changed), Home, Jobs with the jobs
 * being worked on listed underneath (for members only; a live job opens on its Candidates), Candidates, Interviews,
 * Settings (Queue and Console for ITS staff, the console's five sections listed under Console for platform
 * administrators), and who is signed in with Sign out and the light/dark theme switch. On a job's own pages it folds to a column of icons; on every other
 * page the button at its top folds it the same way (founder answer F3), and this browser remembers the choice. Under 900px
 * it becomes a top bar: Start a hire and Sign out stay in it, and the links fold behind a Menu button. (The routes keep
 * their old names: /, /roles, /talent, /setup.)
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
  const who = me.user.name ?? me.user.email;
  const roleWord = teamRoleWord(myRole, !!me.staffAccess);
  return (
    <div className="shell" data-rail={foldedByPage || foldedByChoice ? "compact" : undefined} data-collapsed={foldedByChoice ? "true" : undefined}>
      <nav className="rail" aria-label="Main">
        <div className={companyName ? "brand with-org" : "brand"}>
          Recruiting OS
          <small>{companyName ? (active ? companyName : `${companyName} (recruiter access)`) : isStaff ? "ITS staff" : "No company"}</small>
        </div>
        {foldedByPage ? null : (
          <button type="button" className="icon-btn rail-collapse" aria-label="Fold the menu to icons" aria-pressed={collapsed} title={collapsed ? "Show the full menu" : "Fold the menu to icons"} onClick={toggleRail}>
            <Icon name={collapsed ? "chevron-right" : "chevron-left"} />
          </button>
        )}
        {companyName ? (
          <div className="rail-org">
            <Avatar name={companyName} tone="ink" shape="square" letters={1} />
            <div className="rail-org-text">
              <strong>{companyName}</strong>
              {roleWord ? <span>{roleWord}</span> : null}
            </div>
            {others.length > 0 && active ? (
              <Menu
                label={<Icon name="building" />}
                ariaLabel="Switch company"
                title="Switch company"
                heading="Your companies"
                buttonClassName="icon-btn"
                align="end"
                items={[{ id: active.companyId, label: active.companyName, current: true }, ...others.map((o) => ({ id: o.companyId, label: o.companyName, hint: teamRoleWord(o.role, false) ?? undefined, current: false }))]}
                onSelect={(id) => { if (id !== active.companyId) void switchTo(id); }}
              />
            ) : null}
            <NextLink href="/setup" className="icon-btn" aria-label="Company settings" title="Company settings">
              <Icon name="settings" />
            </NextLink>
          </div>
        ) : null}
        {switchError ? <div style={{ margin: "0 0 10px" }}><Alert tone="critical">{switchError}</Alert></div> : null}
        {mayStartHire ? (
          <NextLink href={START_HIRE_HREF} className="btn primary rail-start" aria-label="Start a hire" aria-keyshortcuts={shortcutOn ? START_HIRE_KEY : undefined} title={shortcutOn ? `Start a hire (press ${START_HIRE_KEY})` : "Start a hire"}>
            <Icon name="plus" />
            <span className="rail-label">Start a hire</span>
            {shortcutOn ? <Kbd decorative>{START_HIRE_KEY}</Kbd> : null}
          </NextLink>
        ) : null}
        <button ref={toggle} type="button" className="btn secondary sm rail-menu-toggle" aria-expanded={menuOpen} aria-controls="rail-links" onClick={() => setMenuFor(menuOpen ? null : pathname)}>
          <Icon name={menuOpen ? "x" : "menu"} />
          Menu
        </button>
        <div className="rail-links" id="rail-links" data-open={menuOpen ? "true" : undefined}>
          {me.activeCompanyId ? (
            <>
              <NavLink to="/" end><Icon name="home" />Home</NavLink>
              <NavLink to="/roles"><Icon name="roles" />Jobs</NavLink>
              {listed.length ? (
                <ul className="rail-sub" aria-label="Jobs in progress">
                  {listed.map((r) => (
                    <li key={r.id}>
                      <NavLink to={r.href} activeFor={`/roles/${r.id}`}>
                        <span className={r.live ? "dot good" : "dot"} aria-hidden="true" />
                        <span className="rail-sub-title">{r.title}</span>
                        {/* a count, or a short word where there is none: the dot's colour never says the status alone */}
                        {r.applicants !== null ? <span className="rail-count" aria-hidden="true">{r.applicants}</span> : r.tag ? <span className="rail-count rail-tag" aria-hidden="true">{r.tag}</span> : null}
                        <span className="sr-only">, {r.statusWord}</span>
                      </NavLink>
                    </li>
                  ))}
                  <li><NextLink href="/roles"><span className="rail-sub-title">All jobs</span></NextLink></li>
                </ul>
              ) : null}
              {showTalent ? <NavLink to="/talent"><Icon name="talent" />Candidates</NavLink> : null}
              <NavLink to="/interviews"><Icon name="interviews" />Interviews</NavLink>
              <NavLink to="/setup"><Icon name="settings" />Settings</NavLink>
            </>
          ) : null}
          {isStaff ? (
            <>
              <div className="section">Recruiter</div>
              <NavLink to="/recruiter/queue"><Icon name="grid" />Queue</NavLink>
            </>
          ) : null}
          {isAdmin ? (
            <>
              <div className="section">Admin</div>
              <NavLink to="/admin"><Icon name="lock" />Console</NavLink>
              {/* The console's sections (Wave S6): Console stays marked on all of them, the section itself too. Folded,
                  the rail still shows them, as icons with their word (app-shell.css). */}
              <ul className="rail-sub console-sub" aria-label="Console sections">
                {CONSOLE_LINKS.map((l) => (
                  <li key={l.to}>
                    <NavLink to={l.to} end={l.to === "/admin"}><Icon name={l.icon} /><span className="rail-sub-title">{l.label}</span></NavLink>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
        {/* Which AI company we use is shown in Settings, not here. Sign out stays reachable on phones and tablets (tokens.css). */}
        <div className="foot">
          <div className="who">
            <Avatar name={who} tone="ink" size="sm" />
            <span className="who-text">
              <strong>{me.user.name ?? me.user.email}</strong>
              {me.user.name ? <span>{me.user.email}</span> : null}
            </span>
          </div>
          <div className="foot-actions">
            <Button variant="quiet" size="sm" onClick={logout}>Sign out</Button>
            <button type="button" className="icon-btn sm theme-switch" aria-label="Dark theme" aria-pressed={dark} title={dark ? "Switch to the light theme" : "Switch to the dark theme"} onClick={toggleTheme}>
              <Icon name={dark ? "sun" : "moon"} />
            </button>
          </div>
        </div>
      </nav>
      <main className="main" id="main">
        {me.staffAccess ? <div style={{ marginBottom: 14 }}><Alert tone="info">You are inside {me.staffAccess.companyName} through an escalation ({me.staffAccess.purpose}). Access is limited to that request and ends {new Date(me.staffAccess.expiresAt).toLocaleString()}. Every page you open is recorded for the customer.</Alert></div> : null}
        {me.ai.provider === "fake" ? <div style={{ marginBottom: 14 }}><Alert tone="caution">Development mode: the AI provider is a deterministic stand-in, so its drafts are rough.</Alert></div> : null}
        {children}
      </main>
    </div>
  );
}

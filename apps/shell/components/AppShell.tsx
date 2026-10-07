"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import NextLink from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, Avatar, Button, Icon, Kbd } from "@ros/ui";
import { api, type RoleSummary } from "@ros/web/src/api/client";
import { NavLink } from "@ros/web/src/nav";
import { railCompact, railListsRoles, railRoles, teamRoleWord } from "@ros/web/src/rail";
import { canSeeTalent, canStartHire } from "@ros/web/src/roles";
import { browserStorage, isFormControl, isStartHireShortcut, SHORTCUT_CHANGED_EVENT, START_HIRE_HREF, START_HIRE_KEY, startHireShortcutOn } from "@ros/web/src/start-hire";
import type { Me } from "../lib/session";
import "./app-shell.css";

/**
 * The signed-in frame (docs/07): the rail, the staff-access notice, the development-mode notice, and the page.
 *
 * The rail, top to bottom: the company chip (your role, and a cog to Setup), "Start a hire" for the people who may start
 * one (N opens it from anywhere outside a text field, on a page with nothing changed), Today, Roles with the roles being
 * worked on listed underneath (for members only), Talent, Interviews, Setup (Queue and Console for ITS staff), and who
 * is signed in with Sign out. On a role's own pages it folds to a column of icons. Under 900px it becomes a top bar:
 * Start a hire and Sign out stay in it, and the links fold behind a Menu button.
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
  // Links a role cannot use are not shown: an interviewer has no Talent page, only the interviews they are on.
  const showTalent = !active || canSeeTalent(active.role);
  // The same rule as Today's button: role.create, held through a membership (an ITS recruiter's grant does not start hires).
  const mayStartHire = !!me.activeCompanyId && canStartHire(myRole);

  // The roles under Roles, for members only: an ITS recruiter under a grant gets no list (each request they make is
  // recorded for the customer as a page they opened). The API gives an interviewer only the roles they interview for.
  // The list refreshes when a page changes a role and every two minutes while the tab is in view.
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

  const logout = async () => {
    await api.post("/api/v1/auth/logout");
    qc.clear();
    router.push("/login");
    router.refresh();
  };
  const who = me.user.name ?? me.user.email;
  const roleWord = teamRoleWord(myRole, !!me.staffAccess);
  return (
    <div className="shell" data-rail={railCompact(pathname) ? "compact" : undefined}>
      <nav className="rail" aria-label="Main">
        <div className={companyName ? "brand with-org" : "brand"}>
          Recruiting OS
          <small>{companyName ? (active ? companyName : `${companyName} (recruiter access)`) : isStaff ? "ITS staff" : "No company"}</small>
        </div>
        {companyName ? (
          <div className="rail-org">
            <Avatar name={companyName} tone="ink" shape="square" letters={1} />
            <div className="rail-org-text">
              <strong>{companyName}</strong>
              {roleWord ? <span>{roleWord}</span> : null}
            </div>
            <NextLink href="/setup" className="icon-btn" aria-label="Company setup" title="Company setup">
              <Icon name="settings" />
            </NextLink>
          </div>
        ) : null}
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
              <NavLink to="/" end><Icon name="today" />Today</NavLink>
              <NavLink to="/roles"><Icon name="roles" />Roles</NavLink>
              {listed.length ? (
                <ul className="rail-sub" aria-label="Roles in progress">
                  {listed.map((r) => (
                    <li key={r.id}>
                      <NavLink to={`/roles/${r.id}`}>
                        <span className={r.live ? "dot good" : "dot"} aria-hidden="true" />
                        <span className="rail-sub-title">{r.title}</span>
                        {r.applicants !== null ? <span className="rail-count" aria-hidden="true">{r.applicants}</span> : null}
                        <span className="sr-only">, {r.statusWord}</span>
                      </NavLink>
                    </li>
                  ))}
                  <li><NextLink href="/roles"><span className="rail-sub-title">All roles</span></NextLink></li>
                </ul>
              ) : null}
              {showTalent ? <NavLink to="/talent"><Icon name="talent" />Talent</NavLink> : null}
              <NavLink to="/interviews"><Icon name="interviews" />Interviews</NavLink>
              <NavLink to="/setup"><Icon name="settings" />Setup</NavLink>
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
            </>
          ) : null}
        </div>
        {/* Which AI company we use is shown in Setup, not here. Sign out stays reachable on phones and tablets (tokens.css). */}
        <div className="foot">
          <div className="who">
            <Avatar name={who} tone="ink" size="sm" />
            <span className="who-text">
              <strong>{me.user.name ?? me.user.email}</strong>
              {me.user.name ? <span>{me.user.email}</span> : null}
            </span>
          </div>
          <Button variant="quiet" size="sm" onClick={logout}>Sign out</Button>
        </div>
      </nav>
      <main className="main" id="main">
        {me.staffAccess ? <div style={{ marginBottom: 14 }}><Alert tone="info">You are inside {me.staffAccess.companyName} through an escalation ({me.staffAccess.purpose}). Access is limited to that request and ends {new Date(me.staffAccess.expiresAt).toLocaleString()}. Every page you open is recorded for the customer.</Alert></div> : null}
        {me.ai.provider === "fake" ? <div style={{ marginBottom: 14 }}><Alert tone="caution">Development mode: the AI provider is a deterministic stand-in. Role packets and extractions are heuristic drafts, labeled as such.</Alert></div> : null}
        {children}
      </main>
    </div>
  );
}

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { Alert, Button } from "@ros/ui";
import { api } from "@ros/web/src/api/client";
import { NavLink } from "@ros/web/src/nav";
import type { Me } from "../lib/session";

/**
 * The signed-in frame: the rail (Today, Roles, Talent, Interviews, Setup; Queue for ITS staff; Console for platform
 * administrators), the staff-access notice, the development-mode notice, and the page. Collapses to a top bar under 900px.
 */
export function AppShell({ me, children }: { me: Me; children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const isStaff = ["platform_admin", "its_recruiter"].includes(me.user.platformRole);
  const isAdmin = me.user.platformRole === "platform_admin";
  const active = me.memberships.find((m) => m.companyId === me.activeCompanyId);
  const logout = async () => {
    await api.post("/api/v1/auth/logout");
    qc.clear();
    router.push("/login");
    router.refresh();
  };
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          Recruiting OS
          <small>{active ? active.companyName : me.staffAccess?.companyName ? `${me.staffAccess.companyName} (recruiter access)` : isStaff ? "ITS staff" : "No company"}</small>
        </div>
        {me.activeCompanyId ? (
          <>
            <NavLink to="/" end>Today</NavLink>
            <NavLink to="/roles">Roles</NavLink>
            <NavLink to="/talent">Talent</NavLink>
            <NavLink to="/interviews">Interviews</NavLink>
            <NavLink to="/setup">Setup</NavLink>
          </>
        ) : null}
        {isStaff ? (
          <>
            <div className="section">Recruiter</div>
            <NavLink to="/recruiter/queue">Queue</NavLink>
          </>
        ) : null}
        {isAdmin ? (
          <>
            <div className="section">Admin</div>
            <NavLink to="/admin">Console</NavLink>
          </>
        ) : null}
        <div className="foot">
          {me.user.name ?? me.user.email}
          <br />
          AI: {me.ai.provider === "fake" ? <span title="Deterministic test provider; never used in production">fake provider (dev)</span> : me.ai.provider}
          <br />
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

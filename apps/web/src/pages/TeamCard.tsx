"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, ErrorState, Field, Pill, Skeleton } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { toast } from "../toast";

type Member = { userId: string; role: string; status: string; email: string; name: string | null; calendar: { provider: string; status: string; email: string | null } | null; availability: { timezone: string; windows: number } | null; schedulable: boolean };
type Invitation = { id: string; email: string; role: string; name: string | null; expiresAt: string; invitedBy: { name: string | null }; createdAt: string };

/** The roles a person on the team can hold, in the words the team page uses. Recruiters are ITS staff under a grant, never assigned here. */
const ROLES: Array<{ value: string; label: string; help: string }> = [
  { value: "owner", label: "Owner", help: "Everything, including making other owners." },
  { value: "admin", label: "Admin", help: "Everything except the owner role." },
  { value: "hiring_manager", label: "Hiring manager", help: "Runs hires: approves jobs, decides on candidates. Owners and admins handle the job-board postings." },
  { value: "interviewer", label: "Interviewer", help: "Sees the interviews they are on and the candidates in them, and says whether each took place. Never sees pay." },
  { value: "hr", label: "HR", help: "Talent pool, offers and the team list. Cannot make anyone an admin or an owner." },
];
const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r.replace(/_/g, " ");
/** members.manage in packages/core/src/permissions.ts: owner, admin and HR. */
const CAN_MANAGE_MEMBERS = ["owner", "admin", "hr"];
/** Who may make someone an admin, or change or remove an admin (apps/api/src/services/team.ts, plan B7): never HR. */
const CAN_GRANT_ADMIN = ["owner", "admin"];
/** The roles a person may give: an owner gives any; an admin any but owner; HR neither owner nor admin. */
const grantable = (myRole: string) => ROLES.filter((r) => (r.value !== "owner" || myRole === "owner") && (r.value !== "admin" || CAN_GRANT_ADMIN.includes(myRole)));
/**
 * Who may send again or withdraw an invitation to a role: the same ranks as giving it (services/team.ts): an owner's
 * invitation is an owner's to handle, an admin's an owner's or an admin's.
 */
const mayHandleInvitation = (myRole: string, role: string) => grantable(myRole).some((r) => r.value === role);
/** Signing a teammate out (POST /members/:userId/sign-out): owners and admins; only an owner signs an owner out. */
const maySignOut = (myRole: string, theirRole: string) => CAN_GRANT_ADMIN.includes(myRole) && (theirRole !== "owner" || myRole === "owner");

/** The API's codes, in plain words. */
function explain(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  switch (e.code) {
    case "last_owner": return "This is the only owner. Make someone else an owner first.";
    case "staff_domain": return "That address belongs to ITS. Recruiters are not team members; ask for one under Bring in a recruiter.";
    case "already_member": return "That person is already on your team.";
    case "self_change": return "You cannot change your own role or remove yourself. Ask another owner or admin.";
    case "owner_only": return "Only an owner can make someone an owner or change an owner's role.";
    case "admin_only": return "Only an owner or an admin can make someone an admin, or change or remove an admin.";
    case "reauth_required": return "Making someone an admin or an owner needs a fresh sign-in. Confirm it's you (at the top of this page), then try again.";
    case "not_found": return "That person is no longer on the team. Refresh the page.";
    case "forbidden": return "Your role cannot do that.";
    case "invalid_request": return "Check the email address and the role.";
    default: return e.message || fallback;
  }
}

/**
 * The team (docs/spec/21, area A): who is here and as what, who is invited and not yet in, and the changes an owner,
 * admin or HR can make. Every change that affects someone else asks first and says what will happen.
 */
export function TeamCard({ myRole, myUserId, onReauthRequired }: { myRole: string; myUserId: string; onReauthRequired?: () => void }) {
  const qc = useQueryClient();
  const canManage = CAN_MANAGE_MEMBERS.includes(myRole);
  const isOwner = myRole === "owner";
  const mayGrantAdmin = CAN_GRANT_ADMIN.includes(myRole);
  // A refusal for an old sign-in brings up "Confirm it's you" at the top of Setup, as a rule change does.
  const failed = (e: unknown, fallback: string) => { if (e instanceof ApiError && e.code === "reauth_required") onReauthRequired?.(); setError(explain(e, fallback)); };
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Member[]>("/api/v1/companies/current/members") });
  // Pending invitations are for those who manage the team (the API refuses everyone else): never asked for otherwise.
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<Invitation[]>("/api/v1/companies/current/invitations"), enabled: canManage });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["members"] }); await qc.invalidateQueries({ queryKey: ["invitations"] }); };

  const [invite, setInvite] = useState({ email: "", role: "hiring_manager", name: "" });
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roleChange, setRoleChange] = useState<{ userId: string; role: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);
  /** A refusal over rank says what it is about (signing out, withdrawing); the API's own words fit better than the role-change ones. */
  const rankAware = (e: unknown, fallback: string) => (e instanceof ApiError && (e.code === "owner_only" || e.code === "admin_only") ? e.message : explain(e, fallback));

  const sendInvite = useMutation({
    mutationFn: () => api.post<{ ok: boolean; devLink?: string; replaced: number }>("/api/v1/companies/current/members/invite", { email: invite.email, role: invite.role, ...(invite.name.trim() ? { name: invite.name.trim() } : {}) }),
    onSuccess: async (r) => { toast(r.replaced ? "Invitation sent again with a new link; the old one no longer works." : "Invitation sent. It works for seven days."); setInviteLink(r.devLink ?? null); setError(null); setInvite({ email: "", role: "hiring_manager", name: "" }); await refresh(); },
    onError: (e) => failed(e, "Could not send the invitation."),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; devLink?: string }>(`/api/v1/companies/current/invitations/${id}/resend`),
    onSuccess: async (r) => { toast("Invitation sent again with a new link."); setInviteLink(r.devLink ?? null); setError(null); await refresh(); },
    onError: (e) => failed(e, "Could not send the invitation again."),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/companies/current/invitations/${id}/revoke`),
    onSuccess: async () => { toast("Invitation withdrawn. The link no longer works."); setError(null); await refresh(); },
    onError: (e) => setError(rankAware(e, "Could not withdraw the invitation.")),
  });
  const signOut = useMutation({
    mutationFn: (userId: string) => api.post<{ sessionsEnded: number; message?: string }>(`/api/v1/companies/current/members/${userId}/sign-out`),
    onSuccess: (r) => { toast(r.message ?? (r.sessionsEnded ? "Signed out. They must sign in again to work here." : "They had no session open here.")); setSigningOut(null); setError(null); },
    onError: (e) => { setError(rankAware(e, "Could not sign them out.")); setSigningOut(null); },
  });
  const update = useMutation({
    mutationFn: (input: { userId: string; body: { role?: string; status?: "removed" } }) => api.patch<{ sessionsEnded: number; calendarDeletionQueued: boolean; interviewsFlagged: number; interviewsCancelled?: number }>(`/api/v1/companies/current/members/${input.userId}`, input.body),
    onSuccess: async (r, input) => {
      // Interviews nobody else was on are cancelled by the removal (there is no way to add an interviewer to one); the others go ahead.
      const cancelled = r.interviewsCancelled ?? 0;
      if (input.body.status === "removed") toast(`Removed. They are signed out of this company${r.calendarDeletionQueued ? ", their calendar is disconnected" : ""}${cancelled ? `, and ${cancelled === 1 ? "one interview they alone were running was" : `${cancelled} interviews they alone were running were`} cancelled: approve a new one from the candidate's page` : ""}.`);
      else toast("Role changed. They are signed out and get the new role when they sign in again.");
      setRoleChange(null); setRemoving(null); setError(null); await refresh();
    },
    onError: (e) => { failed(e, "Could not change the team."); setRoleChange(null); setRemoving(null); },
  });

  const list = members.data ?? [];
  const pending = invitations.data ?? [];
  const nameOf = (m: Member) => m.name ?? m.email;

  return (
    <Card title="Team">
      {error ? <Alert tone="critical">{error}</Alert> : null}
      {members.isLoading ? <Skeleton lines={2} /> : members.error ? <ErrorState message="Could not load your team." onRetry={() => members.refetch()} /> : (
        <div className="stack" style={{ gap: 6 }}>
          {list.map((m) => {
            const self = m.userId === myUserId;
            // Only an owner touches an owner, only an owner or admin touches an admin (the API says owner_only or
            // admin_only otherwise), and nobody touches themselves.
            const canTouch = canManage && !self && (isOwner || m.role !== "owner") && (mayGrantAdmin || m.role !== "admin");
            return (
              <div key={m.userId} className="stack" style={{ gap: 4, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <span className="row" style={{ flexWrap: "nowrap", minWidth: 0 }}><Avatar name={nameOf(m)} size="sm" /><span>{nameOf(m)}{self ? <span className="muted small"> (you)</span> : null} <span className="muted small">{m.email}</span></span></span>
                  <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                    <Pill size="sm" tone={m.schedulable ? "good" : "caution"}>{m.calendar?.status === "live" ? `${m.calendar.provider} calendar` : m.availability ? "hours declared" : "no availability"}</Pill>
                    {/* the way to one's own hours, on the Notifications tab (Settings follows the #hash to the card) */}
                    {self && !m.schedulable ? <a className="small" href="#setup-availability">Set your hours</a> : null}
                    {canTouch ? (
                      <select className="select" aria-label={`Role of ${nameOf(m)}`} value={roleChange?.userId === m.userId ? roleChange.role : m.role} onChange={(e) => setRoleChange({ userId: m.userId, role: e.target.value })} disabled={update.isPending}>
                        {grantable(myRole).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    ) : <Chip>{roleLabel(m.role)}</Chip>}
                    {canTouch && removing !== m.userId ? <Button size="sm" variant="quiet" onClick={() => { setRemoving(m.userId); setRoleChange(null); setSigningOut(null); }}>Remove</Button> : null}
                    {!self && maySignOut(myRole, m.role) && signingOut !== m.userId ? <Button size="sm" variant="quiet" ariaLabel={`Sign out everywhere: ${nameOf(m)}`} onClick={() => { setSigningOut(m.userId); setRemoving(null); setRoleChange(null); }}>Sign out everywhere</Button> : null}
                  </span>
                </div>
                {signingOut === m.userId ? (
                  <Alert tone="caution">
                    <div className="stack" style={{ gap: 6 }}>
                      <span>Sign {nameOf(m)} out on every device? Each session they have open in this company ends, and they must sign in again. They stay on the team with the same role.</span>
                      <details className="more">
                        <summary>If they also work for another company</summary>
                        <span>Sessions working in another company stay open. From those they could come back here, so to keep them out, remove them from the team.</span>
                      </details>
                      <div className="row"><Button size="sm" variant="primary" loading={signOut.isPending} onClick={() => signOut.mutate(m.userId)}>Sign {nameOf(m)} out</Button><Button size="sm" variant="quiet" onClick={() => setSigningOut(null)}>Cancel</Button></div>
                    </div>
                  </Alert>
                ) : null}
                {roleChange?.userId === m.userId && roleChange.role !== m.role ? (
                  <Alert tone="caution">
                    <div className="stack" style={{ gap: 6 }}>
                      <span>Make {nameOf(m)} {ROLES.find((r) => r.value === roleChange.role)?.label.toLowerCase() ?? roleChange.role}? {ROLES.find((r) => r.value === roleChange.role)?.help} They are signed out and get the new role when they sign in again.{roleChange.role === "admin" || roleChange.role === "owner" ? " Making someone an admin or an owner needs a recent sign-in; if yours is older, you are asked to confirm it's you first." : ""}</span>
                      <div className="row"><Button size="sm" variant="primary" loading={update.isPending} onClick={() => update.mutate({ userId: m.userId, body: { role: roleChange.role } })}>Change role</Button><Button size="sm" variant="quiet" onClick={() => setRoleChange(null)}>Keep as is</Button></div>
                    </div>
                  </Alert>
                ) : null}
                {removing === m.userId ? (
                  <Alert tone="critical">
                    <div className="stack" style={{ gap: 6 }}>
                      <span>Remove {nameOf(m)} from the team? They lose access right away and are signed out of this company.</span>
                      <details className="more">
                        <summary>What else happens</summary>
                        <span>Their calendar connection is disconnected and its credential deleted. An interview they were going to run alone is cancelled (a candidate with a booked time is told) and you approve a new one with someone else; an interview others also run goes ahead with them. You will be told which ones. What they did stays in the record.</span>
                      </details>
                      <div className="row"><Button size="sm" variant="destructive" loading={update.isPending} onClick={() => update.mutate({ userId: m.userId, body: { status: "removed" } })}>Remove {nameOf(m)}</Button><Button size="sm" variant="quiet" onClick={() => setRemoving(null)}>Keep them</Button></div>
                    </div>
                  </Alert>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Only those who manage the team may list invitations; for anyone else the refusal is expected and says nothing. */}
      {canManage && invitations.error ? <p className="small" style={{ marginTop: 12, color: "var(--ink-2)" }}>Could not load the pending invitations. <Button size="sm" variant="quiet" onClick={() => invitations.refetch()}>Try again</Button></p> : null}
      {canManage && pending.length ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ marginBottom: 6 }}>Invited, not yet in</h3>
          <div className="stack" style={{ gap: 6 }}>
            {pending.map((inv) => (
              <div key={inv.id} className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <span>{inv.name ? <>{inv.name} <span className="muted small">{inv.email}</span></> : inv.email} <span className="muted small">· {roleLabel(inv.role)} · invited by {inv.invitedBy.name ?? "a teammate"} · link works until {new Date(inv.expiresAt).toLocaleDateString()}</span></span>
                {mayHandleInvitation(myRole, inv.role) ? <span className="row" style={{ gap: 6 }}><Button size="sm" variant="secondary" loading={resend.isPending && resend.variables === inv.id} onClick={() => resend.mutate(inv.id)}>Send again</Button><Button size="sm" variant="quiet" loading={revoke.isPending && revoke.variables === inv.id} onClick={() => revoke.mutate(inv.id)}>Withdraw</Button></span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {canManage ? (
        <form className="stack" style={{ marginTop: 12, gap: 8 }} onSubmit={(e) => { e.preventDefault(); sendInvite.mutate(); }}>
          <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 8 }}>
            <Field label="Invite by email" htmlFor="inv"><input id="inv" className="input" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
            <Field label="Name (optional)" htmlFor="invname"><input id="invname" className="input" type="text" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} /></Field>
            <Field label="Role" htmlFor="invrole"><select id="invrole" className="select" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{grantable(myRole).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
            <Button type="submit" variant="primary" loading={sendInvite.isPending}>Invite</Button>
          </div>
          <p className="small muted">{ROLES.find((r) => r.value === invite.role)?.help}</p>
        </form>
      ) : (
        <p className="small muted" style={{ marginTop: 12 }}>Only owners, admins and HR invite people or change roles.</p>
      )}
      {inviteLink ? <p className="small muted" style={{ marginTop: 8 }}>Development mode: <a href={inviteLink}>invitation link</a></p> : null}
      {/* Who can do what, and how an invitation works: one click away. */}
      <details className="more" style={{ marginTop: 10 }}>
        <summary>Who can do what</summary>
        <div className="stack small muted" style={{ gap: 6 }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {ROLES.map((r) => <li key={r.value}><strong>{r.label}:</strong> {r.help}</li>)}
          </ul>
          <p style={{ margin: 0 }}>An invited person gets one email with a link that works for seven days, and signs in with Google or Microsoft using that address.</p>
          <p style={{ margin: 0 }}>Interviewers never see pay. Hiring managers can approve jobs and decide on candidates. Only owners and admins can make someone an admin, and only an owner can make another owner; either needs a recent sign-in. The last owner cannot be removed. Owners and admins can sign a teammate out of this company; only an owner signs out an owner.</p>
        </div>
      </details>
    </Card>
  );
}

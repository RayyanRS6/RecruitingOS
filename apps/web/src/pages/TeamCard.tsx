"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, ErrorState, Field, Icon, Skeleton } from "@ros/ui";
import { api, ApiError } from "../api/client";
import { useNavigate, useRefresh } from "../nav";
import { toast } from "../toast";
import { seatLine, seatsAllUsed, seatsFullWords, type SeatUsage } from "../trial";

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
    // The Trial plan's people are all in use (founder decision L-02 B): the API's own words say so and what to do.
    case "seats_full": return e.message;
    default: return e.message || fallback;
  }
}

/**
 * The team (docs/spec/21, area A): who is here and as what, who is invited and not yet in, and the changes an owner,
 * admin or HR can make. Every change that affects someone else asks first and says what will happen. `seats`: the
 * plan's people (GET /companies/current `usage.seats`); with a limit (3 on the Trial plan, founder decision L-02 B) the
 * line above the invite form says how many are in use, invitations not yet answered included, and when all are, Invite
 * waits and says why.
 */
export function TeamCard({ myRole, myUserId, onReauthRequired, seats }: { myRole: string; myUserId: string; onReauthRequired?: () => void; seats?: SeatUsage }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const refreshFrame = useRefresh();
  const canManage = CAN_MANAGE_MEMBERS.includes(myRole);
  const isOwner = myRole === "owner";
  const mayGrantAdmin = CAN_GRANT_ADMIN.includes(myRole);
  // A refusal for an old sign-in brings up "Confirm it's you" at the top of Setup, as a rule change does.
  const failed = (e: unknown, fallback: string) => { if (e instanceof ApiError && e.code === "reauth_required") onReauthRequired?.(); setError(explain(e, fallback)); };
  const members = useQuery({ queryKey: ["members"], queryFn: () => api.get<Member[]>("/api/v1/companies/current/members") });
  // Pending invitations are for those who manage the team (the API refuses everyone else): never asked for otherwise.
  const invitations = useQuery({ queryKey: ["invitations"], queryFn: () => api.get<Invitation[]>("/api/v1/companies/current/invitations"), enabled: canManage });
  // The company's usage too: the people line counts the members and the invitations not yet answered.
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["members"] }); await qc.invalidateQueries({ queryKey: ["invitations"] }); await qc.invalidateQueries({ queryKey: ["company"] }); };
  const seatWords = seatLine(seats);
  const full = seatsAllUsed(seats);

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
  // "Leave this company" (founder decision L-10): for oneself; an owner only while another owner remains (the API says so).
  const [leaving, setLeaving] = useState(false);
  const leave = useMutation({
    mutationFn: () => api.post<{ movedTo: { companyId: string; companyName: string } | null; signedOut: boolean }>("/api/v1/companies/current/leave", { confirm: true }),
    onSuccess: (r) => {
      toast(r.movedTo ? `You left the company. You are now in ${r.movedTo.companyName}.` : "You left the company and are signed out.");
      qc.clear();
      // The whole frame changes (another company, or none): it is drawn again from the new session, as the company switch
      // does. Not a full page load, which would drop the line above before anyone could read it.
      navigate(r.movedTo ? "/" : "/login");
      refreshFrame();
    },
    onError: (e) => { setError(e instanceof ApiError ? e.message : "Could not leave the company."); setLeaving(false); },
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
    <Card title="Team" className="max-sm:px-4 max-sm:py-5">
      <div className="stack gap-5">
        {error ? <Alert tone="critical">{error}</Alert> : null}

        {/* The invitation comes first (screenshot 6): how many people the plan allows, then one row of fields. The
            fields are laid out by the width the card has (a container query), not the screen's, so they never squeeze
            when Settings puts the card in its narrower right-hand column. */}
        {canManage ? (
          <form className="stack gap-3 @container" onSubmit={(e) => { e.preventDefault(); if (!full) sendInvite.mutate(); }}>
            {seatWords ? <p className="flex items-start gap-2.5 rounded-xl border border-line-tint bg-tint px-4 py-3 text-[13.5px] leading-snug text-ink-2"><Icon name="shield" size={16} className="mt-px text-primary" />{seatWords}</p> : null}
            {full && seats ? <Alert tone="caution">{seatsFullWords(seats)}</Alert> : null}
            <div className="grid items-end gap-3 @md:grid-cols-2 @xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_10.5rem_auto] [&>.btn]:justify-self-start">
              <Field label="Invite by email" htmlFor="inv"><input id="inv" className="input" type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></Field>
              <Field label="Name (optional)" htmlFor="invname"><input id="invname" className="input" type="text" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} /></Field>
              <Field label="Role" htmlFor="invrole"><select id="invrole" className="select" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>{grantable(myRole).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
              <Button type="submit" variant="primary" loading={sendInvite.isPending} disabled={full}>Invite</Button>
            </div>
            <p className="small muted">{ROLES.find((r) => r.value === invite.role)?.help}</p>
          </form>
        ) : null}
        {inviteLink ? <p className="small muted">Development mode: <a href={inviteLink}>invitation link</a></p> : null}

        {/* The people with access, as a table once the card is wide enough (screenshot 6): who, their role, whether
            interviews can be booked with them, and the round Remove button. "Sign out everywhere" and "Leave this
            company" keep their words, as quiet buttons on a line of their own under the person. The columns follow the
            card's own width (a container query), so a narrow card stacks each row like a phone does. */}
        {members.isLoading ? <Skeleton lines={2} /> : members.error ? <ErrorState message="Could not load your team." onRetry={() => members.refetch()} /> : (
          <div className="grid divide-y divide-line rounded-xl border border-line @container">
            <div aria-hidden="true" className={`hidden px-4 py-2.5 font-mono text-[11px] uppercase leading-[1.4] tracking-[0.12em] text-ink-3 ${TEAM_COLUMNS}`}>
              <span>Name</span><span>Role</span><span>Availability</span><span />
            </div>
            {list.map((m, i) => {
              const self = m.userId === myUserId;
              // Only an owner touches an owner, only an owner or admin touches an admin (the API says owner_only or
              // admin_only otherwise), and nobody touches themselves.
              const canTouch = canManage && !self && (isOwner || m.role !== "owner") && (mayGrantAdmin || m.role !== "admin");
              const offerSignOut = !self && maySignOut(myRole, m.role) && signingOut !== m.userId;
              const offerLeave = self && !leaving;
              return (
                <div key={m.userId} className="px-4 py-3.5 motion-safe:animate-enter" style={{ animationDelay: `${Math.min(i, 7) * 30}ms` }}>
                  <div className={`flex flex-wrap items-center gap-x-3 gap-y-2.5 @xl:gap-y-1 ${TEAM_COLUMNS}`}>
                    <span className="flex min-w-0 basis-full items-center gap-3">
                      <Avatar name={nameOf(m)} />
                      <span className="grid min-w-0 leading-tight">
                        {/* the "(you)" tag stays whole beside a long name: only the name is cut short */}
                        <span className="flex min-w-0 items-center gap-1.5"><span className="truncate text-[14.5px] font-semibold text-ink">{nameOf(m)}</span>{self ? <>{" "}<span className={YOU_TAG}>(you)</span></> : null}</span>
                        <span className="truncate pt-0.5 text-[13px] text-ink-3">{m.email}</span>
                      </span>
                    </span>
                    <span className="min-w-0">
                      {canTouch ? (
                        <select className="select min-h-10 w-auto py-1.5 text-[14px] @xl:w-full" aria-label={`Role of ${nameOf(m)}`} value={roleChange?.userId === m.userId ? roleChange.role : m.role} onChange={(e) => setRoleChange({ userId: m.userId, role: e.target.value })} disabled={update.isPending}>
                          {grantable(myRole).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      ) : <Chip tone={m.role === "owner" ? "good" : "neutral"} icon={m.role === "owner" ? "check-circle" : undefined}>{roleLabel(m.role)}</Chip>}
                    </span>
                    <span className="flex min-w-0 flex-col items-start gap-0.5 text-[13px] text-ink-2">
                      <span className="inline-flex items-center gap-2"><span className={m.schedulable ? "dot good" : "dot caution"} aria-hidden="true" />{m.calendar?.status === "live" ? `${m.calendar.provider} calendar` : m.availability ? "hours declared" : "no availability"}</span>
                      {/* the way to one's own hours, on the Notifications tab (Settings follows the #hash to the card) */}
                      {self && !m.schedulable ? <a className="small" href="#setup-availability">Set your hours</a> : null}
                    </span>
                    <span className="ml-auto flex items-center justify-end @xl:ml-0">
                      {canTouch && removing !== m.userId ? <button type="button" className="icon-btn" title="Remove" onClick={() => { setRemoving(m.userId); setRoleChange(null); setSigningOut(null); }}><Icon name="x" size={16} /><span className="sr-only">Remove</span></button> : null}
                    </span>
                    {/* the person's other actions, in words, lined up under their name on a wide card */}
                    {offerSignOut || offerLeave ? (
                      <span className="flex basis-full flex-wrap gap-2 @xl:col-span-full @xl:pl-[37px]">
                        {offerSignOut ? <Button size="sm" variant="quiet" icon="lock" ariaLabel={`Sign out everywhere: ${nameOf(m)}`} onClick={() => { setSigningOut(m.userId); setRemoving(null); setRoleChange(null); }}>Sign out everywhere</Button> : null}
                        {offerLeave ? <Button size="sm" variant="quiet" icon="log-out" onClick={() => { setLeaving(true); setRemoving(null); setRoleChange(null); setSigningOut(null); }}>Leave this company</Button> : null}
                      </span>
                    ) : null}
                  </div>
                  {self && leaving ? (
                    <div className="mt-3">
                      <Alert tone="critical">
                        <div className="stack gap-2">
                          <span>Leave this company? You lose access right away. If you work for another company here, you move to it; otherwise you are signed out.</span>
                          <details className="more">
                            <summary>What else happens</summary>
                            <span>Your calendar connection here is disconnected. An interview you were going to run alone is cancelled and the team is told; one others also run goes ahead with them. What you did stays in the record. {m.role === "owner" ? "An owner can leave only while another owner remains. " : ""}To close the whole company, ask ITS.</span>
                          </details>
                          <div className="row"><Button size="sm" variant="destructive" loading={leave.isPending} onClick={() => leave.mutate()}>Leave this company</Button><Button size="sm" variant="quiet" onClick={() => setLeaving(false)}>Stay</Button></div>
                        </div>
                      </Alert>
                    </div>
                  ) : null}
                  {signingOut === m.userId ? (
                    <div className="mt-3">
                      <Alert tone="caution">
                        <div className="stack gap-2">
                          <span>Sign {nameOf(m)} out on every device? Each session they have open in this company ends, and they must sign in again. They stay on the team with the same role.</span>
                          <details className="more">
                            <summary>If they also work for another company</summary>
                            <span>Sessions working in another company stay open. From those they could come back here, so to keep them out, remove them from the team.</span>
                          </details>
                          <div className="row"><Button size="sm" variant="primary" loading={signOut.isPending} onClick={() => signOut.mutate(m.userId)}>Sign {nameOf(m)} out</Button><Button size="sm" variant="quiet" onClick={() => setSigningOut(null)}>Cancel</Button></div>
                        </div>
                      </Alert>
                    </div>
                  ) : null}
                  {roleChange?.userId === m.userId && roleChange.role !== m.role ? (
                    <div className="mt-3">
                      <Alert tone="caution">
                        <div className="stack gap-2">
                          <span>Make {nameOf(m)} {ROLES.find((r) => r.value === roleChange.role)?.label.toLowerCase() ?? roleChange.role}? {ROLES.find((r) => r.value === roleChange.role)?.help} They are signed out and get the new role when they sign in again.{roleChange.role === "admin" || roleChange.role === "owner" ? " Making someone an admin or an owner needs a recent sign-in; if yours is older, you are asked to confirm it's you first." : ""}</span>
                          <div className="row"><Button size="sm" variant="primary" loading={update.isPending} onClick={() => update.mutate({ userId: m.userId, body: { role: roleChange.role } })}>Change role</Button><Button size="sm" variant="quiet" onClick={() => setRoleChange(null)}>Keep as is</Button></div>
                        </div>
                      </Alert>
                    </div>
                  ) : null}
                  {removing === m.userId ? (
                    <div className="mt-3">
                      <Alert tone="critical">
                        <div className="stack gap-2">
                          <span>Remove {nameOf(m)} from the team? They lose access right away and are signed out of this company.</span>
                          <details className="more">
                            <summary>What else happens</summary>
                            <span>Their calendar connection is disconnected and its credential deleted. An interview they were going to run alone is cancelled (a candidate with a booked time is told) and you approve a new one with someone else; an interview others also run goes ahead with them. You will be told which ones. What they did stays in the record.</span>
                          </details>
                          <div className="row"><Button size="sm" variant="destructive" loading={update.isPending} onClick={() => update.mutate({ userId: m.userId, body: { status: "removed" } })}>Remove {nameOf(m)}</Button><Button size="sm" variant="quiet" onClick={() => setRemoving(null)}>Keep them</Button></div>
                        </div>
                      </Alert>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* Only those who manage the team may list invitations; for anyone else the refusal is expected and says nothing. */}
        {canManage && invitations.error ? <p className="small text-ink-2">Could not load the pending invitations. <Button size="sm" variant="quiet" onClick={() => invitations.refetch()}>Try again</Button></p> : null}
        {canManage && pending.length ? (
          <div className="stack gap-2.5">
            <h3 className="text-[15px]">Invited, not yet in</h3>
            <div className="grid divide-y divide-line rounded-xl border border-line">
              {pending.map((inv) => (
                <div key={inv.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                  <span className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-ink-3"><Icon name="mail" size={16} /></span>
                    <span className="min-w-0 text-[14px] text-ink">{inv.name ? <>{inv.name} <span className="muted small">{inv.email}</span></> : inv.email} <span className="muted small">· {roleLabel(inv.role)} · invited by {inv.invitedBy.name ?? "a teammate"} · link works until {new Date(inv.expiresAt).toLocaleDateString()}</span></span>
                  </span>
                  {mayHandleInvitation(myRole, inv.role) ? <span className="row gap-2"><Button size="sm" variant="secondary" loading={resend.isPending && resend.variables === inv.id} onClick={() => resend.mutate(inv.id)}>Send again</Button><Button size="sm" variant="quiet" loading={revoke.isPending && revoke.variables === inv.id} onClick={() => revoke.mutate(inv.id)}>Withdraw</Button></span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {canManage ? null : <p className="small muted">Only owners, admins and HR invite people or change roles.</p>}
        {/* Who can do what, and how an invitation works: one click away, as the table's footnote. */}
        <details className="more [&>summary]:text-[13px] [&>summary]:text-ink-3 [&>summary]:before:order-1">
          <summary><Icon name="clock" size={15} />Who can do what</summary>
          <div className="stack small muted gap-1.5">
            <ul className="list-disc pl-[18px]">
              {ROLES.map((r) => <li key={r.value}><strong className="text-ink-2">{r.label}:</strong> {r.help}</li>)}
            </ul>
            <p>An invited person gets one email with a link that works for seven days, and signs in with Google or Microsoft using that address.</p>
            <p>Interviewers never see pay. Hiring managers can approve jobs and decide on candidates. Only owners and admins can make someone an admin, and only an owner can make another owner; either needs a recent sign-in. The last owner cannot be removed. Owners and admins can sign a teammate out of this company; only an owner signs out an owner. Anyone can leave the company from their own row, an owner only while another owner remains.</p>
          </div>
        </details>
      </div>
    </Card>
  );
}

/**
 * The team table's columns once the list itself is at least 36rem wide (a container query on the list, so the card's
 * own width decides, wherever Settings places it): the person (at least about 180px), their role, whether interviews
 * can be booked, the Remove button. The words-buttons take a row of their own under these.
 */
const TEAM_COLUMNS = "@xl:grid @xl:grid-cols-[minmax(0,1fr)_10rem_8rem_2.5rem] @xl:gap-x-3";
/** "(you)" beside one's own name, as a small lavender tag that never shrinks. */
const YOU_TAG = "shrink-0 rounded-md bg-tint-2 px-1.5 font-mono text-[11px] font-normal leading-[1.5] text-primary";

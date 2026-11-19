"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MORE_PEOPLE_UPGRADE_QUESTION, type InviteAnswer, type InviteMember, type LeftCompany, type MemberChanged, type MembershipRole, type TeamInvitation, type TeamMember, type TeamView, type UpdateMember } from "@ros/contracts";
import { Alert, Avatar, Button, Card, ErrorState, Field, Skeleton } from "@ros/ui";
import { api, errorCode, errorWords } from "../../api/client";
import { CopyButton } from "../../components/CopyButton";
import { Upgrade } from "../../components/Upgrade";
import { CONFIRM_FIRST_LINE, afterLeaving, defaultInviteRole, invitationFacts, inviteToast, memberChangedWords, roleChangeQuestion, roleOptions } from "../../settings";
import { toast } from "../../toast";
import { SUBHEAD } from "../look";

type Problem = { message: string; seats: boolean };

/**
 * Settings, Team: who is on the team with their role, the invitations still open, and inviting someone. What the
 * person looking may do comes with the team from the API: the invite form and the roles it offers, a role select and
 * Remove on each person they may change (the reason when not), and "Leave this company". A change refused for an older
 * sign-in offers "Confirm it's you", which comes back here.
 */
export function TeamSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["team"], queryFn: () => api.get<TeamView>("/api/v1/companies/current/members") });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirmFirst, setConfirmFirst] = useState(false);
  const [answer, setAnswer] = useState<InviteAnswer | null>(null);
  const changed = () => {
    setProblem(null);
    setConfirmFirst(false);
    // the Plan section's "people" line counts the team and its open invitations
    for (const key of [["team"], ["company"]]) qc.invalidateQueries({ queryKey: key });
  };
  const failed = (e: unknown, fallback: string) => {
    if (errorCode(e) === "reauth_required") return setConfirmFirst(true);
    setProblem({ message: errorWords(e, fallback), seats: errorCode(e) === "seats_full" });
  };
  const invited = (a: InviteAnswer) => {
    const said = inviteToast(a);
    toast(said.title, said.detail);
    setAnswer(a);
    changed();
  };
  const resend = useMutation({
    mutationFn: (id: string) => api.post<InviteAnswer>(`/api/v1/companies/current/invitations/${id}/resend`),
    onSuccess: invited,
    onError: (e) => failed(e, "Could not send it again."),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.post<{ ok: true }>(`/api/v1/companies/current/invitations/${id}/revoke`),
    onSuccess: () => { toast("Invitation withdrawn."); setAnswer(null); changed(); },
    onError: (e) => failed(e, "Could not withdraw it."),
  });
  const confirm = useMutation({
    mutationFn: () => api.post<{ url: string }>("/api/v1/auth/reauth/start", { returnTo: "/setup" }),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => setProblem({ message: errorWords(e, "Could not start the confirmation."), seats: false }),
  });
  if (q.isLoading) return <Card title="Team"><Skeleton lines={4} /></Card>;
  if (q.error || !q.data) return <Card title="Team"><ErrorState message="Could not load the team." onRetry={() => q.refetch()} /></Card>;
  const team = q.data;
  return (
    <Card title="Team">
      <div className="stack gap-6">
        {confirmFirst ? (
          <Alert tone="caution">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{CONFIRM_FIRST_LINE}</span>
              <Button size="sm" variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>Confirm it's you</Button>
            </div>
          </Alert>
        ) : null}
        {problem ? (
          <Alert tone="critical">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{problem.message}</span>
              {problem.seats ? <Upgrade size="sm" reason={MORE_PEOPLE_UPGRADE_QUESTION} /> : null}
            </div>
          </Alert>
        ) : null}
        <ul className="grid divide-y divide-line" aria-label="People on the team">
          {team.members.map((m) => <MemberRow key={m.userId} member={m} viewer={team.viewer} onChanged={changed} onFailed={failed} />)}
        </ul>
        {team.invitations.length ? (
          <div className="grid gap-2.5">
            <h3 className={SUBHEAD}>Invited, not yet in</h3>
            <ul className="grid divide-y divide-line">
              {team.invitations.map((inv) => (
                <InvitationRow
                  key={inv.id}
                  invitation={inv}
                  link={answer?.invitation.id === inv.id ? answer.link : null}
                  mayManage={team.viewer.mayManage}
                  sending={resend.isPending && resend.variables === inv.id}
                  withdrawing={revoke.isPending && revoke.variables === inv.id}
                  onResend={() => resend.mutate(inv.id)}
                  onRevoke={() => revoke.mutate(inv.id)}
                />
              ))}
            </ul>
          </div>
        ) : null}
        {team.viewer.mayManage ? (
          team.seats.full ? (
            <Alert tone="info">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{team.seats.line}</span>
                <Upgrade size="sm" reason={MORE_PEOPLE_UPGRADE_QUESTION} />
              </div>
            </Alert>
          ) : <InviteForm viewer={team.viewer} onInvited={invited} onFailed={failed} />
        ) : null}
        <Leave viewer={team.viewer} onFailed={failed} />
      </div>
    </Card>
  );
}

/** One person: who they are, their role, and for someone the viewer may change, a role to choose and Remove (each asked once more). */
function MemberRow({ member: m, viewer, onChanged, onFailed }: { member: TeamMember; viewer: TeamView["viewer"]; onChanged: () => void; onFailed: (e: unknown, fallback: string) => void }) {
  const [removing, setRemoving] = useState(false);
  const [newRole, setNewRole] = useState<MembershipRole | null>(null);
  const who = m.name ?? m.email;
  const settle = () => { setRemoving(false); setNewRole(null); };
  const change = useMutation({
    mutationFn: (body: UpdateMember) => api.patch<MemberChanged>(`/api/v1/companies/current/members/${m.userId}`, body),
    onSuccess: (r) => { toast(memberChangedWords(r, who)); settle(); onChanged(); },
    onError: (e) => { settle(); onFailed(e, "Could not change that."); },
  });
  const roles = roleOptions(viewer);
  // the person's own role stays a choice even when the viewer could not give it, so the select shows what is true
  const options = roles.some((r) => r.value === m.role) ? roles : [{ value: m.role, label: m.roleLabel }, ...roles];
  return (
    <li className="grid gap-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="flex min-w-0 items-center gap-3">
          <Avatar name={who} size="sm" />
          <span className="grid min-w-0 leading-snug">
            <strong className="wrap-anywhere">{who}{m.you ? <span className="inline-tag">(you)</span> : null}</strong>
            {m.name ? <span className="small muted wrap-anywhere">{m.email}</span> : null}
          </span>
        </span>
        {m.mayChange ? (
          <span className="row">
            <select className="select min-h-10 w-auto py-1.5 text-[14px]" aria-label={`Role of ${who}`} value={newRole ?? m.role} disabled={change.isPending} onChange={(e) => { setRemoving(false); setNewRole(e.target.value === m.role ? null : (e.target.value as MembershipRole)); }}>
              {options.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
            <Button size="sm" variant="ghost" disabled={change.isPending} onClick={() => { setNewRole(null); setRemoving(true); }} ariaLabel={`Remove ${who}`}>Remove</Button>
          </span>
        ) : <span className="small text-ink-2">{m.roleLabel}</span>}
      </div>
      {!m.mayChange && m.changeBlockedReason && viewer.mayManage ? <p className="small muted">{m.changeBlockedReason}</p> : null}
      {newRole ? (
        <Alert tone="caution">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{roleChangeQuestion(who, newRole)}</span>
            <span className="row">
              <Button size="sm" variant="primary" loading={change.isPending} onClick={() => change.mutate({ role: newRole })}>Change role</Button>
              <Button size="sm" variant="ghost" disabled={change.isPending} onClick={() => setNewRole(null)}>Keep as is</Button>
            </span>
          </div>
        </Alert>
      ) : null}
      {removing ? (
        <Alert tone="caution">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Remove {who} from the team? They can no longer open this company.</span>
            <span className="row">
              <Button size="sm" variant="danger" loading={change.isPending} onClick={() => change.mutate({ status: "removed" })}>Remove</Button>
              <Button size="sm" variant="ghost" disabled={change.isPending} onClick={() => setRemoving(false)}>Keep them</Button>
            </span>
          </div>
        </Alert>
      ) : null}
    </li>
  );
}

/** One invitation not yet answered: who, as what, until when its link works, what became of its email; its link to copy once it was made or sent again here. */
function InvitationRow(props: { invitation: TeamInvitation; link: string | null; mayManage: boolean; sending: boolean; withdrawing: boolean; onResend: () => void; onRevoke: () => void }) {
  const inv = props.invitation;
  return (
    <li className="grid gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="grid min-w-0 leading-snug">
          <strong className="wrap-anywhere">{inv.name ?? inv.email}</strong>
          <span className="small muted wrap-anywhere">{[...(inv.name ? [inv.email] : []), ...invitationFacts(inv)].join(" · ")}</span>
        </span>
        {props.mayManage ? (
          <span className="row">
            <Button size="sm" loading={props.sending} disabled={props.withdrawing} onClick={props.onResend} ariaLabel={`Send the invitation to ${inv.email} again`}>Send again</Button>
            <Button size="sm" variant="ghost" loading={props.withdrawing} disabled={props.sending} onClick={props.onRevoke} ariaLabel={`Withdraw the invitation to ${inv.email}`}>Withdraw</Button>
          </span>
        ) : null}
      </div>
      {props.link ? (
        <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Invitation link" htmlFor={`invite-link-${inv.id}`}><input id={`invite-link-${inv.id}`} className="input" readOnly value={props.link} onFocus={(e) => e.currentTarget.select()} /></Field>
          <CopyButton text={props.link} ariaLabel={`Copy the invitation link for ${inv.email}`} />
        </div>
      ) : null}
    </li>
  );
}

/** Invite someone: their email, their name if known, and one of the roles the viewer may give. */
function InviteForm({ viewer, onInvited, onFailed }: { viewer: TeamView["viewer"]; onInvited: (a: InviteAnswer) => void; onFailed: (e: unknown, fallback: string) => void }) {
  const roles = roleOptions(viewer);
  const [form, setForm] = useState<{ email: string; name: string; role: MembershipRole | null }>({ email: "", name: "", role: defaultInviteRole(viewer) });
  const invite = useMutation({
    mutationFn: (body: InviteMember) => api.post<InviteAnswer>("/api/v1/companies/current/members/invite", body),
    onSuccess: (a) => { setForm((f) => ({ ...f, email: "", name: "" })); onInvited(a); },
    onError: (e) => onFailed(e, "Could not invite them."),
  });
  if (!form.role) return null;
  const role = form.role;
  return (
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); invite.mutate({ email: form.email.trim(), role, ...(form.name.trim() ? { name: form.name.trim() } : {}) }); }}>
      <h3 className={SUBHEAD}>Invite someone</h3>
      <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_auto_auto]">
        <Field label="Email" htmlFor="invite-email"><input id="invite-email" className="input" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label="Name (optional)" htmlFor="invite-name"><input id="invite-name" className="input" maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Role" htmlFor="invite-role"><select id="invite-role" className="select" value={role} onChange={(e) => setForm({ ...form, role: e.target.value as MembershipRole })}>{roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select></Field>
        <Button type="submit" variant="primary" icon="user-plus" loading={invite.isPending}>Invite</Button>
      </div>
    </form>
  );
}

/** "Leave this company", asked once more; when the viewer cannot leave, the reason instead. */
function Leave({ viewer, onFailed }: { viewer: TeamView["viewer"]; onFailed: (e: unknown, fallback: string) => void }) {
  const [asking, setAsking] = useState(false);
  const leave = useMutation({
    mutationFn: () => api.post<LeftCompany>("/api/v1/companies/current/leave", { confirm: true }),
    // a full load: the frame, and everything read for the company left, starts again from the new session
    onSuccess: (left) => window.location.assign(afterLeaving(left)),
    onError: (e) => { setAsking(false); onFailed(e, "Could not leave."); },
  });
  if (!viewer.mayLeave) return viewer.leaveBlockedReason ? <p className="small muted">{viewer.leaveBlockedReason}</p> : null;
  if (!asking) return <div className="row"><Button size="sm" variant="ghost" onClick={() => setAsking(true)}>Leave this company</Button></div>;
  return (
    <Alert tone="caution">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>Leave this company? You will no longer see its jobs or candidates.</span>
        <span className="row">
          <Button size="sm" variant="danger" loading={leave.isPending} onClick={() => leave.mutate()}>Leave this company</Button>
          <Button size="sm" variant="ghost" disabled={leave.isPending} onClick={() => setAsking(false)}>Stay</Button>
        </span>
      </div>
    </Alert>
  );
}

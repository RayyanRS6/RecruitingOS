"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Card, Chip, EmptyState, ErrorState, Field, Skeleton, Timeline } from "@ros/ui";
import { api, ApiError, type DecisionMaker, type InterviewPlanView, type Requirement, type RoleDetail, type RoleEvent, type RolePacket } from "../api/client";
import { toast } from "../toast";

/**
 * The role page's approval card, preferences card, requirement lists, Interview plan tab and Activity tab
 * (docs/spec/21 section 7: B2, B8, B9, B11). RoleDetail.tsx composes them; nothing here knows about the other tabs.
 */

export const WORK_MODEL: Record<string, string> = { onsite: "On site", hybrid: "Hybrid", remote: "Remote" };
export function workModelLabel(policy: string | undefined): string {
  return WORK_MODEL[policy ?? ""] ?? "On site";
}

const EVIDENCE_LABEL: Record<string, string> = { resume: "résumé", application: "application", screen: "screen", interview: "interview" };
const ROUND_FORMAT: Record<string, string> = { video: "video call", phone: "phone", onsite: "on site", working_session: "working session" };

/** Must-haves and nice-to-haves with why they matter and where each is checked. */
export function RequirementList({ items, empty }: { items: Requirement[]; empty: string }) {
  if (!items.length) return <p className="muted">{empty}</p>;
  return (
    <ul style={{ paddingLeft: 18, margin: 0 }}>
      {items.map((m) => (
        <li key={m.key} style={{ marginBottom: 6 }}>
          <strong>{m.text}</strong>
          <br />
          <span className="small muted">{m.rationale}</span>
          <br />
          <span className="small muted">Evidenced in: {(m.evidencedBy ?? []).map((e) => EVIDENCE_LABEL[e] ?? e).join(" / ") || "not set"}</span>
        </li>
      ))}
    </ul>
  );
}

/** What the owner said matters, in their words: deal-breakers, what failure looks like, who decides. */
export function PreferencesCard({ packet, decisionMaker }: { packet: RolePacket; decisionMaker: DecisionMaker | null }) {
  const pref = packet.preferences;
  const stated = pref.decisionMakerName?.trim();
  const statedIsAPerson = !!stated && !/^(the )?(owner|hiring manager)$|^(me|myself|i)$/i.test(stated);
  return (
    <Card title="What matters to you">
      <dl className="kv">
        <dt>Final decision</dt>
        <dd>
          {decisionMaker ? <>{decisionMaker.name ?? decisionMaker.email} <Chip tone="good">on the team</Chip></> : stated ? <>{stated}{statedIsAPerson ? <> <Chip tone="caution">not on the team yet</Chip></> : null}</> : "Not named yet"}
          <br />
          <span className="small muted">{decisionMaker ? "Packet approvals are reserved for them; an owner can also decide." : statedIsAPerson ? "Invite them to the team and approvals will go to them." : "Any owner, admin or hiring manager can approve."}</span>
        </dd>
        <dt>Deal-breakers</dt>
        <dd>{pref.dealBreakersInTheirWords.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{pref.dealBreakersInTheirWords.map((d, i) => <li key={i}>{d}</li>)}</ul> : <span className="muted">None stated</span>}</dd>
        <dt>What failure looks like</dt>
        <dd>{pref.whatFailureLooksLike ?? <span className="muted">Not stated</span>}</dd>
        {pref.interviewStyle ? <><dt>Interview style</dt><dd>{pref.interviewStyle}</dd></> : null}
      </dl>
      <p className="small muted" style={{ marginTop: 8 }}>In your words from the intake conversation. Use "Everything (advanced)" in Edit to change them.</p>
    </Card>
  );
}

/**
 * The decision on a role packet: approve, send back with a note, or ask again after it was sent back. What the
 * signed-in person may do comes from the API (the self-approval rule and the named decision maker live there).
 */
export function PacketApprovalCard({ role, onEdit }: { role: RoleDetail; onEdit: () => void }) {
  const qc = useQueryClient();
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["role", role.id] });
    await qc.invalidateQueries({ queryKey: ["brief"] });
    await qc.invalidateQueries({ queryKey: ["roles"] });
    await qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const pending = role.packetApproval?.pending ?? null;
  const latest = role.packetApproval?.latest ?? null;
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState("");
  const approve = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${role.id}/approve`, { version: pending!.version }),
    onSuccess: async () => { toast(pending?.editWhileOpen ? "Approved. The role now runs on the new version." : "Approved. Posting now."); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not approve."),
  });
  const sendBack = useMutation({
    mutationFn: () => api.post(`/api/v1/approvals/${pending!.id}/decide`, { decision: "reject", ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: async () => { toast(pending?.editWhileOpen ? "Sent back. The role keeps its approved version." : "Sent back. The role is a draft again."); setSendingBack(false); setNote(""); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send it back."),
  });
  const again = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${role.id}/request-approval`, {}),
    onSuccess: async () => { toast("Sent for approval again."); await refresh(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not ask for approval."),
  });

  const sentBack = role.status === "draft" && latest && (latest.status === "rejected" || latest.status === "expired") ? latest : null;
  if (sentBack) {
    return (
      <Card needsYou lift title={sentBack.status === "expired" ? "The approval ran out of time" : "Sent back"}>
        <p style={{ color: "var(--ink-2)" }}>
          {sentBack.status === "expired" ? "Nobody decided within 14 days, so the role is a draft again." : `Sent back${sentBack.decidedBy ? ` by ${sentBack.decidedBy.name}` : ""}${sentBack.decidedAt ? ` on ${new Date(sentBack.decidedAt).toLocaleDateString()}` : ""}: ${sentBack.decisionNote ?? "no note was left"}.`}
        </p>
        <p className="small muted" style={{ marginTop: 6 }}>Edit anything that needs changing, then ask for approval again. Every edit is kept as a new version.</p>
        <div className="row" style={{ marginTop: 12 }}>
          <Button variant="primary" loading={again.isPending} onClick={() => again.mutate()}>Request approval again</Button>
          <Button onClick={onEdit}>Edit first</Button>
        </div>
      </Card>
    );
  }
  if (!pending) return null;
  const packet = pending.editWhileOpen ? role.proposedPacket?.packet ?? null : role.currentPacket?.packet ?? null;
  const assumptions = packet?.provenance.assumptions ?? [];
  const expires = pending.expiresAt ? new Date(pending.expiresAt).toLocaleDateString() : null;
  return (
    <Card needsYou lift title={pending.editWhileOpen ? `Approve packet v${pending.version} of ${role.title}` : "Approve this role packet"}>
      <p style={{ color: "var(--ink-2)" }}>{pending.rationale ?? (pending.editWhileOpen ? "The role keeps running on its approved version until you decide." : "Review the packet, edit anything, then approve. Approval opens the role and posts it.")}</p>
      {pending.editWhileOpen && role.proposedPacket ? <p className="small" style={{ color: "var(--ink-2)", marginTop: 6 }}>What changed: {role.proposedPacket.changeSummary ?? "edited"} · by {role.proposedPacket.createdBy.name ?? "a team member"} on {new Date(role.proposedPacket.createdAt).toLocaleDateString()}. Current version: v{role.currentPacket?.version ?? "?"}.</p> : null}
      <p className="small muted" style={{ marginTop: 6 }}>
        {pending.decisionMaker ? `Reserved for ${pending.decisionMaker.name ?? pending.decisionMaker.email}; an owner can also decide.` : "Any owner, admin or hiring manager can decide."}
        {expires ? ` Waits until ${expires}, then goes back to a draft.` : ""}
      </p>
      {assumptions.length ? (
        <div className="alert caution" style={{ marginTop: 10 }}>
          <strong>Assumptions the assistant made:</strong>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      ) : null}
      {!pending.viewer.mayDecide ? <Alert tone="info">{pending.viewer.reason ?? "Someone else on your team decides this one."}</Alert> : null}
      {sendingBack ? (
        <div className="stack" style={{ gap: 8, marginTop: 12, maxWidth: 520 }}>
          <Field label="What should change? (the note goes back with the packet)" htmlFor="sendback-note"><input id="sendback-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Raise the ceiling before we post this" /></Field>
          <div className="row">
            <Button variant="destructive" loading={sendBack.isPending} onClick={() => sendBack.mutate()}>Send back</Button>
            <Button variant="quiet" onClick={() => setSendingBack(false)}>Keep reviewing</Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          {pending.viewer.mayDecide ? <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>{pending.editWhileOpen ? "Approve this version" : "Approve and post"}</Button> : null}
          {pending.viewer.mayDecide ? <Button onClick={() => setSendingBack(true)}>Send back with a note</Button> : null}
          <Button onClick={onEdit}>{pending.viewer.mayDecide ? "Edit first" : "Edit"}</Button>
        </div>
      )}
    </Card>
  );
}

/** The rounds with who interviews and whether times can be offered to them, and a way to assign people per round. */
export function InterviewPlanTab({ roleId }: { roleId: string }) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["interview-plan", roleId], queryFn: () => api.get<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`) });
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (input: { key: string; ids: string[] }) => api.patch<InterviewPlanView>(`/api/v1/roles/${roleId}/interview-plan`, { rounds: [{ key: input.key, interviewerUserIds: input.ids }] }),
    onSuccess: async (r) => {
      toast(r.outcome === "approved_current" ? "Interviewers assigned." : r.outcome === "proposed_pending_approval" ? "Saved as a new version. It takes effect once an approver says yes." : "Saved with the draft.");
      setEditingKey(null);
      await qc.invalidateQueries({ queryKey: ["interview-plan", roleId] });
      await qc.invalidateQueries({ queryKey: ["role", roleId] });
      await qc.invalidateQueries({ queryKey: ["brief"] });
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not save the interviewers."),
  });
  if (plan.isLoading) return <Skeleton lines={4} />;
  if (plan.error || !plan.data) return <ErrorState message="Could not load the interview plan." onRetry={() => plan.refetch()} />;
  const d = plan.data;
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)));
  return (
    <Card title="Interview rounds" aside={<Chip>Packet v{d.version}</Chip>}>
      <p className="small muted" style={{ marginBottom: 10 }}>Each round names who interviews. Someone with a connected calendar or declared hours can be offered times straight away; the others are asked to add theirs. Assigning interviewers saves a new packet version.</p>
      <ol style={{ paddingLeft: 18, margin: 0 }} className="stack">
        {d.rounds.map((r) => (
          <li key={r.key}>
            <strong>{r.title}</strong> · {r.durationMinutes} min · {ROUND_FORMAT[r.format] ?? r.format}
            <br />
            <span className="small muted">{r.purpose}</span>
            <div className="row" style={{ marginTop: 6 }}>
              {r.interviewers.length
                ? r.interviewers.map((i) => <Chip key={i.userId} tone={i.schedulable ? "good" : "caution"}>{i.name} · {i.schedulable ? "can be scheduled" : "no calendar or hours yet"}</Chip>)
                : <span className="small muted">Nobody assigned yet{r.interviewerRoles.length ? ` (planned: ${r.interviewerRoles.join(", ")})` : ""}.</span>}
              {editingKey !== r.key ? <Button size="sm" onClick={() => { setEditingKey(r.key); setPicked(r.interviewers.map((i) => i.userId)); }}>{r.interviewers.length ? "Change" : "Assign interviewers"}</Button> : null}
            </div>
            {editingKey === r.key ? (
              <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                {d.team.length ? d.team.map((m) => (
                  <label key={m.userId} className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={picked.includes(m.userId)} onChange={(e) => toggle(m.userId, e.target.checked)} />
                    <span>{m.name} <span className="small muted">({m.role.replace(/_/g, " ")})</span></span>
                    <Chip tone={m.schedulable ? "good" : "caution"}>{m.schedulable ? "availability known" : "no calendar or hours yet"}</Chip>
                  </label>
                )) : <p className="small muted">Nobody is on the team yet. Invite people from Setup.</p>}
                <div className="row">
                  <Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate({ key: r.key, ids: picked })}>Save interviewers</Button>
                  <Button size="sm" variant="quiet" onClick={() => setEditingKey(null)}>Cancel</Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** Owner Mode never shows raw stage names (docs/07); mirrors STAGE_LABEL in packages/core. */
const STAGE_WORDS: Record<string, string> = {
  applied: "Just applied", received: "Received", ineligible: "Doesn't meet eligibility", eligible: "Eligible", triaged: "Ready for your review", screen_invited: "Invited to a screen",
  screening: "Being screened", screen_complete: "Screen complete", interview_recommended: "Recommended for interview", interview_scheduled: "Interviewing", interview_complete: "Interview done",
  debrief: "Deciding", finalist: "Finalist", reference_check: "Checking references", offer_draft: "Offer being prepared", offer_approval: "Offer needs your approval", offer_sent: "Offer out",
  negotiation: "Negotiating", accepted: "Accepted", declined: "Declined the offer", hired: "Hired", onboarding: "Starting soon", withdrawn: "Withdrew", rejected: "Not moving forward", talent_pool: "In your talent pool",
};

/** Plain words for what happened on a role; anything unknown falls back to the event's own name in words. */
export function describeRoleEvent(e: RoleEvent): string {
  const p = e.payload as Record<string, string | number | boolean | null | undefined>;
  const v = p.version !== undefined && p.version !== null ? `v${p.version}` : "";
  const note = typeof p.note === "string" && p.note ? `: ${p.note}` : "";
  const known: Record<string, string> = {
    "role.created": "Role drafted from the intake conversation",
    "role_packet.proposed": `Packet ${v} ${p.again ? "sent for approval again" : "proposed for approval"}`.trim(),
    "role_packet.edited": `Packet ${v} edited${typeof p.changeSummary === "string" && p.changeSummary ? `: ${p.changeSummary}` : ""}`,
    "role_packet.approved": `Packet ${v} approved${p.via === "edit_while_open" ? " and made current" : ""}`,
    "approval.requested": "Approval requested",
    "approval.granted": `Approved${note}`,
    "approval.denied": `Sent back${note}`,
    "approval.expired": "The approval ran out of time (14 days)",
    "approval.cancelled": `Approval withdrawn${typeof p.reason === "string" && p.reason ? ` (${p.reason})` : ""}`,
    "role.sent_back": p.wasOpen ? `Proposed ${v} retired${note}` : `Back to a draft${note}`,
    "role.approved": "Role approved",
    "role.opened": "Role opened",
    "role.paused": "Role paused",
    "role.resumed": "Role resumed",
    "role.closed": "Role closed",
    "role.filled": "Role filled",
    "role.applications_closed": "Stopped accepting applications",
    "role.applications_reopened": "Accepting applications again",
    "role.volume_high": "Unusually many applications in a day",
    "role.outcome_recorded": "Outcome recorded",
    "application.received": "An application arrived",
    "application.acknowledged": "An applicant was acknowledged",
    "application.duplicate_detected": "Someone applied again (the original was kept)",
    "application.ineligible": "An application was held on an eligibility answer",
    "application.triaged": "An application was assessed",
    "application.stage_changed": `A candidate is now "${STAGE_WORDS[String(p.to ?? "")] ?? String(p.to ?? "").replace(/_/g, " ")}"`,
    "application.rejected": "A candidate was declined by a person",
    "application.withdrawn": "A candidate withdrew",
    "application.moved_to_talent_pool": "A candidate was added to the talent pool",
    "candidate.recommended": "A candidate was recommended for interview",
    "screen.invited": "A candidate was invited to a screen",
    "screen.completed": "A candidate completed the screen",
    "interview.requested": "An interview was requested",
    "interview.scheduled": "An interview was booked",
    "interview.completed": "An interview took place",
    "posting.published": "Posted on a channel",
    "posting.live_verified": "A posting was checked and is live",
    "posting.closed": "A posting was closed",
    "posting.closure_confirmed": "A board posting was confirmed taken down",
    "outcome.recorded": "An outcome was recorded",
    "recruiter.requested": "A recruiter was asked for help",
    "recruiter.claimed": "An ITS recruiter picked it up",
    "recruiter.resolved": "The ITS recruiter responded",
  };
  return known[e.type] ?? e.type.replace(/[._]/g, " ");
}

/** Everything that happened on the role, newest first, in plain words. */
export function ActivityTab({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["role-timeline", roleId], queryFn: () => api.get<RoleEvent[]>(`/api/v1/roles/${roleId}/timeline`) });
  if (q.isLoading) return <Skeleton lines={5} />;
  if (q.error || !q.data) return <ErrorState message={q.error instanceof ApiError && q.error.status === 403 ? "Your role cannot see this role's activity." : "Could not load the activity."} onRetry={() => q.refetch()} />;
  if (!q.data.length) return <EmptyState title="Nothing yet" body="What happens on this role shows up here, newest first." />;
  const who = (e: RoleEvent) => e.actor.name ?? (e.actor.kind === "agent" ? `AI (${e.actor.id})` : e.actor.kind === "system" ? "the system" : e.actor.kind);
  return (
    <Card title="Activity" aside={<Chip>{q.data.length} {q.data.length === 1 ? "entry" : "entries"}</Chip>}>
      <Timeline items={q.data.map((e) => ({ when: e.occurredAt, what: describeRoleEvent(e), who: who(e) }))} />
      <p className="small muted" style={{ marginTop: 8 }}>Candidates are not named here; open Talent for the people.</p>
    </Card>
  );
}

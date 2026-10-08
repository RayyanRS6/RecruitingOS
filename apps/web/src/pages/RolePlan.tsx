"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Card, Chip, EmptyState, ErrorState, Field, Pill, Skeleton, Timeline } from "@ros/ui";
import { api, ApiError, type DecisionMaker, type InterviewPlanView, type PacketFlag, type Requirement, type RoleDetail, type RoleEvent, type RolePacket } from "../api/client";
import { APPROVE_WAITS_FOR_CHECK, approvedToast } from "../company-check";
import { useCompanyCheck } from "../components/use-company-check";
import { toast } from "../toast";
import { actorWords, describeRoleEvent, roleWords } from "../role-words";

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
          {decisionMaker ? <>{decisionMaker.name ?? decisionMaker.email} <Pill size="sm" tone="good">on the team</Pill></> : stated ? <>{stated}{statedIsAPerson ? <> <Pill size="sm" tone="caution">not on the team yet</Pill></> : null}</> : "Not named yet"}
          <br />
          <span className="small muted">{decisionMaker ? "Packet approvals are reserved for them; an owner can also decide." : statedIsAPerson ? "Invite them to the team and approvals will go to them." : "Any owner, admin or hiring manager can approve."}</span>
        </dd>
        <dt>Deal-breakers</dt>
        <dd>{pref.dealBreakersInTheirWords.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{pref.dealBreakersInTheirWords.map((d, i) => <li key={i}>{d}</li>)}</ul> : <span className="muted">None stated</span>}</dd>
        <dt>What failure looks like</dt>
        <dd>{pref.whatFailureLooksLike ?? <span className="muted">Not stated</span>}</dd>
        {pref.interviewStyle ? <><dt>Interview style</dt><dd>{pref.interviewStyle}</dd></> : null}
      </dl>
      <p className="small muted" style={{ marginTop: 8 }}>In your words from the conversation with the assistant. Change them with Edit.</p>
    </Card>
  );
}

/**
 * The decision on a role packet: approve, send back with a note, or ask again after it was sent back. What the
 * signed-in person may do comes from the API (the self-approval rule and the named decision maker live there); Edit
 * and "Request approval again" need packet.edit, so they are left out for anyone without it (`canEdit`).
 * `onShowProposed` switches the role page's tabs to the version waiting for approval, and back.
 */
export function PacketApprovalCard({ role, onEdit, canEdit, showingProposed, onShowProposed }: { role: RoleDetail; onEdit: () => void; canEdit: boolean; showingProposed: boolean; onShowProposed: (show: boolean) => void }) {
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
  // Until ITS confirms the company (founder decision B7) an approved role waits to go public; the toast says so.
  const check = useCompanyCheck();
  const approve = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${role.id}/approve`, { version: pending!.version }),
    onSuccess: async () => { toast(approvedToast({ editWhileOpen: !!pending?.editWhileOpen, check })); await refresh(); },
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
        {canEdit ? (
          <>
            <p className="small muted" style={{ marginTop: 6 }}>Edit anything that needs changing, then ask for approval again. Every edit is kept as a new version.</p>
            <div className="row" style={{ marginTop: 12 }}>
              <Button variant="primary" loading={again.isPending} onClick={() => again.mutate()}>Request approval again</Button>
              <Button onClick={onEdit}>Edit first</Button>
            </div>
          </>
        ) : <p className="small muted" style={{ marginTop: 6 }}>An owner, an admin or a hiring manager edits it and asks for approval again.</p>}
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
      {!pending.editWhileOpen && check === "waiting" ? <Alert tone="info">{APPROVE_WAITS_FOR_CHECK}</Alert> : null}
      {pending.editWhileOpen && role.proposedPacket ? (
        <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <p className="small" style={{ color: "var(--ink-2)", margin: 0 }}>What changed: {role.proposedPacket.changeSummary ?? "edited"} · by {role.proposedPacket.createdBy.name ?? "a team member"} on {new Date(role.proposedPacket.createdAt).toLocaleDateString()}. Current version: v{role.currentPacket?.version ?? "?"}.</p>
          <Button size="sm" onClick={() => onShowProposed(!showingProposed)}>{showingProposed ? `Back to v${role.currentPacket?.version ?? "?"}` : `Show v${role.proposedPacket.version}`}</Button>
        </div>
      ) : null}
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
      {pending.flags.length ? <ApprovalFlags roleId={role.id} version={pending.version} flags={pending.flags} canKeep={canEdit} onEdit={onEdit} onKept={refresh} /> : null}
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
          {pending.viewer.maySendBack ? <Button onClick={() => setSendingBack(true)}>Send back with a note</Button> : null}
          {canEdit ? <Button onClick={onEdit}>{pending.viewer.mayDecide ? "Edit first" : "Edit"}</Button> : null}
        </div>
      )}
    </Card>
  );
}

/**
 * The wording the fairness check flagged on the version waiting for approval (plan C1), on the approval card itself:
 * each phrase, where it is, why, and the lawful way to say it. Until each open one is changed (Edit) or kept by a person
 * with a reason, the role cannot be approved; a kept one shows who kept it and why, for the approver to weigh.
 */
function ApprovalFlags({ roleId, version, flags, canKeep, onEdit, onKept }: { roleId: string; version: number; flags: PacketFlag[]; canKeep: boolean; onEdit: () => void; onKept: () => Promise<void> }) {
  const [open, setOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const keep = useMutation({
    mutationFn: (input: { flagId: string; reason: string }) => api.post(`/api/v1/roles/${roleId}/packets/${version}/flags/keep`, input),
    onSuccess: async () => { toast("Kept, with your reason.", "Whoever approves the role sees why."); setOpen(null); setReason(""); await onKept(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not keep it."),
  });
  const waiting = flags.filter((f) => !f.kept);
  return (
    <section className="flag-list" aria-label="Wording to check before approval" style={{ marginTop: 10 }}>
      <h3 style={{ fontSize: 14 }}>{waiting.length ? "Check this wording before approving" : "Wording someone chose to keep"}</h3>
      {flags.map((f) => {
        const id = `keep-${version}-${f.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        return (
          <div key={f.id} className="wording-flag">
            <p><strong>"{f.text}"</strong> <span className="small muted">({flagPlace(f.path)})</span> {f.reason}</p>
            {f.alternative ? <p className="small" style={{ color: "var(--ink-2)" }}>Instead: {f.alternative}</p> : null}
            {f.kept ? (
              <p className="small"><Chip tone="caution">Kept</Chip> {f.kept.by.name ?? "A team member"} kept it on {new Date(f.kept.at).toLocaleDateString()}: "{f.kept.reason}"</p>
            ) : open === f.id ? (
              <div className="stack" style={{ gap: 6 }}>
                <Field label="Why keep it? (whoever approves the role sees this)" htmlFor={id}><input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Required by our state licence board" /></Field>
                <div className="row">
                  <Button size="sm" variant="primary" disabled={reason.trim().length < 5} loading={keep.isPending} onClick={() => keep.mutate({ flagId: f.id, reason: reason.trim() })}>Keep it, with this reason</Button>
                  <Button size="sm" variant="quiet" onClick={() => setOpen(null)}>Cancel</Button>
                </div>
              </div>
            ) : canKeep ? (
              <div className="row">
                <Button size="sm" variant="primary" onClick={onEdit}>Change the wording</Button>
                <Button size="sm" onClick={() => { setOpen(f.id); setReason(""); }}>Keep it…</Button>
              </div>
            ) : <p className="small muted">Someone who can edit the role changes the wording, or keeps it and says why.</p>}
          </div>
        );
      })}
    </section>
  );
}

/** Where in the role a flagged phrase is, in plain words. */
function flagPlace(path: string): string {
  const p = path.replace(/\[[^\]]*\]/g, "");
  if (p.startsWith("identity")) return "the job title";
  if (p.startsWith("description.publicJobDescription")) return "the job description";
  if (p.startsWith("description")) return "the team's notes";
  if (p.startsWith("requirements.mustHaves")) return "a must-have";
  if (p.startsWith("requirements.niceToHaves")) return "a nice-to-have";
  if (p.startsWith("requirements.eligibility")) return "an application question";
  if (p.startsWith("screening")) return "a screening question";
  if (p.startsWith("competencies")) return "what interviewers look for";
  if (p.startsWith("evaluation")) return "how applications are judged";
  if (p.startsWith("interviews")) return "an interview question";
  if (p.startsWith("preferences.dealBreakers")) return "the deal-breakers";
  if (p.startsWith("communication")) return "the company description";
  return "the role";
}

/** The rounds with who interviews and whether times can be offered to them, and, for anyone with packet.edit (`canEdit`), a way to assign people per round. */
export function InterviewPlanTab({ roleId, canEdit }: { roleId: string; canEdit: boolean }) {
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
      <p className="small muted" style={{ marginBottom: 10 }}>Each round names who interviews. Someone with a connected calendar or declared hours can be offered times straight away; the others are asked to add theirs. {canEdit ? "Assigning interviewers saves a new packet version." : "An owner, an admin or a hiring manager assigns the interviewers."}</p>
      <ol style={{ paddingLeft: 18, margin: 0 }} className="stack">
        {d.rounds.map((r) => (
          <li key={r.key}>
            <strong>{r.title}</strong> · {r.durationMinutes} min · {ROUND_FORMAT[r.format] ?? r.format}
            <br />
            <span className="small muted">{r.purpose}</span>
            <div className="row" style={{ marginTop: 6 }}>
              {r.interviewers.length
                ? r.interviewers.map((i) => <Pill key={i.userId} size="sm" tone={i.schedulable ? "good" : "caution"}>{i.name} · {i.schedulable ? "can be scheduled" : "no calendar or hours yet"}</Pill>)
                : <span className="small muted">Nobody assigned yet{r.interviewerRoles.length ? ` (planned: ${roleWords(r.interviewerRoles)})` : ""}.</span>}
              {canEdit && editingKey !== r.key ? <Button size="sm" onClick={() => { setEditingKey(r.key); setPicked(r.interviewers.map((i) => i.userId)); }}>{r.interviewers.length ? "Change" : "Assign interviewers"}</Button> : null}
            </div>
            {canEdit && editingKey === r.key ? (
              <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                {d.team.length ? d.team.map((m) => (
                  <label key={m.userId} className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={picked.includes(m.userId)} onChange={(e) => toggle(m.userId, e.target.checked)} />
                    <Avatar name={m.name} size="sm" />
                    <span>{m.name} <span className="small muted">({m.role.replace(/_/g, " ")})</span></span>
                    <Pill size="sm" tone={m.schedulable ? "good" : "caution"}>{m.schedulable ? "availability known" : "no calendar or hours yet"}</Pill>
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

// What happened on a role, in plain words (describeRoleEvent), lives in role-words.ts with the channel and role words.

/** Everything that happened on the role, newest first, in plain words. */
export function ActivityTab({ roleId }: { roleId: string }) {
  const q = useQuery({ queryKey: ["role-timeline", roleId], queryFn: () => api.get<RoleEvent[]>(`/api/v1/roles/${roleId}/timeline`) });
  if (q.isLoading) return <Skeleton lines={5} />;
  if (q.error || !q.data) return <ErrorState message={q.error instanceof ApiError && q.error.status === 403 ? "Your role cannot see this role's activity." : "Could not load the activity."} onRetry={() => q.refetch()} />;
  if (!q.data.length) return <EmptyState title="Nothing yet" body="What happens on this role shows up here, newest first." />;
  return (
    <Card title="Activity" aside={<Chip>{q.data.length} {q.data.length === 1 ? "entry" : "entries"}</Chip>}>
      <Timeline items={q.data.map((e) => ({ when: e.occurredAt, what: describeRoleEvent(e), who: actorWords(e.actor) }))} />
      <p className="small muted" style={{ marginTop: 8 }}>Candidates are not named here; open Talent for the people.</p>
    </Card>
  );
}

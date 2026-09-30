"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "../nav";
import { Alert, Button, Card, Chip, EmptyState, ErrorState, Field, Sheet, Skeleton, Table, Timeline } from "@ros/ui";
import { api, ApiError, type InterviewDetail, type InterviewSummary, type Me } from "../api/client";
import { toast } from "../toast";
import { canDecideInterviews, canManageInterviews, canSeeTalent } from "../roles";

const STATUS_LABEL: Record<string, string> = { proposed: "Preparing times", scheduling: "Waiting on the candidate", scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No-show", offer_expired: "Times expired" };
const DECISION_LABEL: Record<string, string> = { next_round: "Next round", finalist: "Finalist", not_moving_forward: "Not moving forward", hired: "Hired" };
const STATUS_TONE: Record<string, "neutral" | "accent" | "needs" | "good" | "caution" | "critical"> = { proposed: "accent", scheduling: "needs", scheduled: "good", completed: "neutral", cancelled: "critical", no_show: "caution", offer_expired: "caution" };
const when = (iso: string | null, tz: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: tz ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not yet");

/** Interviews across roles (docs/04): who, when, who is interviewing, and what needs a person. */
export function Interviews() {
  const { id } = useParams();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const role = me.data?.memberships.find((m) => m.companyId === me.data?.activeCompanyId)?.role ?? null;
  const list = useQuery({ queryKey: ["interviews"], queryFn: () => api.get<InterviewSummary[]>("/api/v1/interviews"), refetchInterval: 15000 });
  const upcoming = (list.data ?? []).filter((i) => ["proposed", "scheduling", "scheduled"].includes(i.status)).sort((a, b) => (a.startsAt ?? "9").localeCompare(b.startsAt ?? "9"));
  const past = (list.data ?? []).filter((i) => !["proposed", "scheduling", "scheduled"].includes(i.status));
  const load: Record<string, number> = {};
  for (const i of upcoming) for (const p of i.participants) load[p.name ?? p.email] = (load[p.name ?? p.email] ?? 0) + 1;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head"><div><h1>Interviews</h1><p>{canManageInterviews(role) ? "Every interview a person approved: waiting on the candidate, scheduled, or done. Reschedule and cancel from here; nothing is decided by software." : "Your interviews: waiting on the candidate, scheduled, or done. Afterwards, tell us whether it took place; the hiring team records the decision."}</p></div></div>
      {list.isLoading ? <Skeleton lines={4} /> : list.error ? <ErrorState message="Could not load interviews." onRetry={() => list.refetch()} /> : (
        <>
          {upcoming.length === 0 ? <EmptyState title="No interviews in motion" body={canSeeTalent(role) ? "Open a candidate and choose Interview to start one." : "You will see an interview here as soon as you are put on one."} action={canSeeTalent(role) ? <Link to="/talent" className="btn primary">Go to Talent</Link> : undefined} /> : (
            <Card title={`In motion (${upcoming.length})`}>
              <Table head={["Candidate", "Round", "When", "Interviewers", "Status", ""]}>
                {upcoming.map((i) => (
                  <tr key={i.id}>
                    <td>{i.candidate.firstName} {i.candidate.lastName}<br /><span className="small muted">{i.roleTitle}</span></td>
                    <td>{i.title}</td>
                    <td>{when(i.startsAt, i.timezone)}{i.status === "scheduling" ? <><br /><span className="small muted">{i.offeredSlots.length} times offered</span></> : null}</td>
                    <td className="small">{i.participants.map((p) => p.name ?? p.email).join(", ")}</td>
                    <td><Chip tone={STATUS_TONE[i.status] ?? "neutral"}>{STATUS_LABEL[i.status] ?? i.status}</Chip></td>
                    <td><Link to={`/interviews/${i.id}`} className="btn quiet sm">Open</Link></td>
                  </tr>
                ))}
              </Table>
              {Object.keys(load).length ? <p className="small muted" style={{ marginTop: 8 }}>Interviewer load: {Object.entries(load).map(([n, c]) => `${n} ${c}`).join(" · ")}</p> : null}
            </Card>
          )}
          {past.length ? (
            <Card title={`Past (${past.length})`}>
              <Table head={["Candidate", "Round", "When", "Outcome", "Decision", ""]}>
                {past.map((i) => (
                  <tr key={i.id}>
                    <td>{i.candidate.firstName} {i.candidate.lastName}<br /><span className="small muted">{i.roleTitle}</span></td>
                    <td>{i.title}</td>
                    <td>{when(i.startsAt, i.timezone)}</td>
                    <td><Chip tone={STATUS_TONE[i.status] ?? "neutral"}>{i.outcome ? i.outcome.replace(/_/g, " ") : STATUS_LABEL[i.status] ?? i.status}</Chip></td>
                    <td className="small">{i.decision ? DECISION_LABEL[i.decision] ?? i.decision.replace(/_/g, " ") : "not yet"}</td>
                    <td><Link to={`/interviews/${i.id}`} className="btn quiet sm">Open</Link></td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}
        </>
      )}
      {id ? <InterviewSheet id={id} role={role} userId={me.data?.user.id ?? null} /> : null}
    </div>
  );
}

/** One interview. What can be changed here follows the person's role: interviewers see their interview and record whether it took place; the decision is recorded from the candidate's page by the hiring team. */
function InterviewSheet({ id, role, userId }: { id: string; role: string | null; userId: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["interview", id], queryFn: () => api.get<InterviewDetail>(`/api/v1/interviews/${id}`), refetchInterval: 10000 });
  const [reason, setReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["interview", id] }); await qc.invalidateQueries({ queryKey: ["interviews"] }); await qc.invalidateQueries({ queryKey: ["brief"] }); };
  const reschedule = useMutation({ mutationFn: () => api.post(`/api/v1/interviews/${id}/reschedule`, { reason: reason || undefined }), onSuccess: async () => { toast("New times are going out."); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not reschedule.") });
  const cancel = useMutation({ mutationFn: () => api.post(`/api/v1/interviews/${id}/cancel`, { reason }), onSuccess: async () => { toast("Cancelled. The candidate and interviewers are told."); setConfirmCancel(false); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not cancel.") });
  const outcome = useMutation({ mutationFn: (o: string) => api.post(`/api/v1/interviews/${id}/outcome`, { outcome: o }), onSuccess: async () => { toast("Recorded."); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not record.") });
  const book = useMutation({ mutationFn: (slotId: string) => api.post(`/api/v1/interviews/${id}/book-on-behalf`, { slotId, note: "chosen with the candidate by phone" }), onSuccess: async () => { toast("Booked on the candidate's behalf."); await refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not book.") });
  const i = q.data;
  const manage = canManageInterviews(role);
  const participant = !!i && !!userId && i.participants.some((p) => p.userId === userId);
  const finished = !!i && ["completed", "no_show"].includes(i.status);
  return (
    <Sheet open onClose={() => nav("/interviews")} title={i ? `${i.candidate.firstName} ${i.candidate.lastName} · ${i.title}` : "Interview"}>
      {q.isLoading || !i ? <Skeleton lines={8} /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row"><Chip tone={STATUS_TONE[i.status] ?? "neutral"}>{STATUS_LABEL[i.status] ?? i.status}</Chip><span className="small muted">{i.roleTitle} · attempt {i.attempt}</span></div>
          {finished ? (
            <Card needsYou={!i.decision && canDecideInterviews(role)} title="After the interview">
              {i.decision ? (
                <>
                  <p><strong>Decision: {DECISION_LABEL[i.decision] ?? i.decision.replace(/_/g, " ")}</strong></p>
                  {i.decisionNote ? <p className="small muted" style={{ marginTop: 4 }}>Note (kept internally): {i.decisionNote}</p> : null}
                </>
              ) : (
                <>
                  <p className="small" style={{ color: "var(--ink-2)" }}>{i.outcome ? "" : "First say whether it took place. "}Nobody has recorded a decision yet: next round, finalist, or not moving forward.</p>
                  {canDecideInterviews(role) ? <div className="row" style={{ marginTop: 10 }}><Link to={`/roles/${i.roleId}/talent?open=${i.applicationId}`} className="btn primary sm">Record the decision</Link></div> : <p className="small muted" style={{ marginTop: 6 }}>The hiring team records it; it will show here.</p>}
                </>
              )}
            </Card>
          ) : null}
          <Card title="Details">
            <dl className="kv">
              <dt>When</dt><dd>{when(i.startsAt, i.timezone)}{i.timezone ? ` (${i.timezone})` : ""}</dd>
              <dt>Length</dt><dd>{i.durationMinutes} minutes, {i.format.replace("_", " ")}</dd>
              <dt>Link</dt><dd>{i.meetingUrl ? <a href={i.meetingUrl} target="_blank" rel="noreferrer">{i.meetingUrl}</a> : i.linkSource === "calendar" ? "created with the calendar event" : "none"}</dd>
              <dt>Interviewers</dt><dd>{i.participants.map((p) => { const s = i.availabilitySources.find((x) => x.userId === p.userId); return <span key={p.userId} style={{ marginRight: 8 }}>{p.name ?? p.email} <Chip tone={s?.source === "calendar" ? "good" : s?.source === "declared" ? "accent" : "caution"}>{s?.source === "calendar" ? "calendar" : s?.source === "declared" ? "declared hours" : "no availability"}</Chip></span>; })}</dd>
              <dt>Window</dt><dd>{i.schedulingWindow.fromDate} to {i.schedulingWindow.toDate}</dd>
              <dt>Candidate reschedules</dt><dd>{i.rescheduleCountCandidate} of 2</dd>
            </dl>
          </Card>
          {i.candidateAvailability?.note || i.candidateAvailability?.accessibilityNote ? <Alert tone="info">{i.candidateAvailability.accessibilityNote ? `Accommodation request: ${i.candidateAvailability.accessibilityNote}. ` : ""}{i.candidateAvailability.note ? `The candidate wrote: "${i.candidateAvailability.note}"` : ""}</Alert> : null}
          {i.status === "scheduling" && i.offeredSlots.length ? (
            <Card title="Times offered to the candidate">
              <ul className="small" style={{ paddingLeft: 18 }}>{i.offeredSlots.map((s) => <li key={s.id}>{when(s.startsAt, i.timezone)}{manage ? <> <Button size="sm" variant="quiet" loading={book.isPending} onClick={() => book.mutate(s.id)}>Book this for them</Button></> : null}</li>)}</ul>
              {manage ? <p className="small muted">Booking on their behalf is for when you agreed a time by phone; it is recorded as your action.</p> : null}
            </Card>
          ) : null}
          {["scheduled", "completed"].includes(i.status) && !i.outcome && (manage || participant) ? (
            <Card title="Did it take place?">
              <p className="small muted" style={{ marginBottom: 8 }}>Either answer keeps the record straight; a no-show is never held against anyone automatically.</p>
              <div className="row"><Button size="sm" variant="primary" loading={outcome.isPending} onClick={() => outcome.mutate("happened")}>Yes</Button><Button size="sm" loading={outcome.isPending} onClick={() => outcome.mutate("no_show_candidate")}>Candidate did not show</Button><Button size="sm" loading={outcome.isPending} onClick={() => outcome.mutate("no_show_interviewer")}>We did not show</Button></div>
            </Card>
          ) : null}
          {manage && ["proposed", "scheduling", "scheduled"].includes(i.status) ? (
            <Card title="Change it">
              <Field label="Reason (the candidate sees it when you cancel)" htmlFor="iv-reason"><input id="iv-reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <div className="row" style={{ marginTop: 10 }}>
                <Button size="sm" loading={reschedule.isPending} onClick={() => reschedule.mutate()}>Offer new times</Button>
                {confirmCancel ? <Button size="sm" variant="destructive" loading={cancel.isPending} disabled={!reason.trim()} onClick={() => cancel.mutate()}>Confirm cancel</Button> : <Button size="sm" variant="destructive" onClick={() => setConfirmCancel(true)}>Cancel interview</Button>}
              </div>
            </Card>
          ) : null}
          <Card title="Timeline"><Timeline items={i.timeline.map((e) => ({ when: new Date(e.occurredAt).toLocaleString(), what: e.type.replace(/[._]/g, " "), who: e.actor.name ?? e.actor.kind }))} /></Card>
        </div>
      )}
    </Sheet>
  );
}

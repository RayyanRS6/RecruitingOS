"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "../nav";
import { Alert, Avatar, Button, Card, Chip, Drawer, EmptyState, ErrorState, Field, PageHeader, Pill, Skeleton, Table, Timeline, type Tone } from "@ros/ui";
import { api, ApiError, type InterviewDetail, type InterviewSummary, type InterviewerBrief, type Me } from "../api/client";
import { toast } from "../toast";
import { activeCompanyOf } from "../rail";
import { canDecideInterviews, canManageInterviews, canSeeTalent } from "../roles";

const STATUS_LABEL: Record<string, string> = { proposed: "Preparing times", scheduling: "Waiting on the candidate", scheduled: "Scheduled", completed: "Completed", cancelled: "Cancelled", no_show: "No-show", offer_expired: "Times expired" };
const DECISION_LABEL: Record<string, string> = { next_round: "Next round", finalist: "Finalist", not_moving_forward: "Not moving forward", hired: "Hired" };
// Red is only for a missing must-have or a critical error (docs/07), so a cancelled interview is plain grey.
const STATUS_TONE: Record<string, Tone> = { proposed: "accent", scheduling: "caution", scheduled: "good", completed: "neutral", cancelled: "neutral", no_show: "caution", offer_expired: "caution" };
const when = (iso: string | null, tz: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: tz ?? undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not yet");

/** Interviews across roles (docs/04): who, when, who is interviewing, and what needs a person. */
export function Interviews() {
  const { id } = useParams();
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const role = company.role;
  const list = useQuery({ queryKey: ["interviews"], queryFn: () => api.get<InterviewSummary[]>("/api/v1/interviews"), refetchInterval: 15000 });
  const upcoming = (list.data ?? []).filter((i) => ["proposed", "scheduling", "scheduled"].includes(i.status)).sort((a, b) => (a.startsAt ?? "9").localeCompare(b.startsAt ?? "9"));
  const past = (list.data ?? []).filter((i) => !["proposed", "scheduling", "scheduled"].includes(i.status));
  const load: Record<string, number> = {};
  for (const i of upcoming) for (const p of i.participants) load[p.name ?? p.email] = (load[p.name ?? p.email] ?? 0) + 1;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow={company.name ?? undefined} title="Interviews" sub={canManageInterviews(role) ? "Every interview a person approved: waiting on the candidate, scheduled, or done. Reschedule and cancel from here; nothing is decided by software." : "Your interviews: waiting on the candidate, scheduled, or done. Afterwards, tell us whether it took place; the hiring team records the decision."} />
      {list.isLoading ? <Skeleton lines={4} /> : list.error ? <ErrorState message="Could not load interviews." onRetry={() => list.refetch()} /> : (
        <>
          {upcoming.length === 0 ? <EmptyState icon="interviews" title="No interviews in motion" body={canSeeTalent(role) ? "Open a candidate and choose Interview to start one." : "You will see an interview here as soon as you are put on one."} action={canSeeTalent(role) ? <Link to="/talent" className="btn primary">Go to Talent</Link> : undefined} /> : (
            <Card title={`In motion (${upcoming.length})`}>
              <Table head={["Candidate", "Round", "When", "Interviewers", "Status", ""]}>
                {upcoming.map((i) => (
                  <tr key={i.id}>
                    <td><CandidateCell i={i} /></td>
                    <td>{i.title}</td>
                    <td>{when(i.startsAt, i.timezone)}{i.status === "scheduling" ? <><br /><span className="small muted">{i.offeredSlots.length} times offered</span></> : null}</td>
                    <td className="small">{i.participants.map((p) => p.name ?? p.email).join(", ")}</td>
                    <td><Pill size="sm" tone={STATUS_TONE[i.status] ?? "neutral"}>{STATUS_LABEL[i.status] ?? i.status}</Pill></td>
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
                    <td><CandidateCell i={i} /></td>
                    <td>{i.title}</td>
                    <td>{when(i.startsAt, i.timezone)}</td>
                    <td><Pill size="sm" tone={STATUS_TONE[i.status] ?? "neutral"}>{i.outcome ? i.outcome.replace(/_/g, " ") : STATUS_LABEL[i.status] ?? i.status}</Pill></td>
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

/** The candidate column: initials, the name, and the role underneath. */
function CandidateCell({ i }: { i: InterviewSummary }) {
  const name = `${i.candidate.firstName} ${i.candidate.lastName}`;
  return (
    <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-start" }}>
      <Avatar name={name} size="sm" />
      <span>{name}<br /><span className="small muted">{i.roleTitle}</span></span>
    </div>
  );
}

/** One interview. What can be changed here follows the person's role: interviewers see their interview and record whether it took place; the decision is recorded from the candidate's page by the hiring team. */
function InterviewSheet({ id, role, userId }: { id: string; role: string | null; userId: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  // A refusal or a missing interview is an answer, not a hiccup: it is not retried and the 10-second refresh stops while it stands.
  const q = useQuery({
    queryKey: ["interview", id],
    queryFn: () => api.get<InterviewDetail>(`/api/v1/interviews/${id}`),
    refetchInterval: (query) => (query.state.status === "error" ? false : 10000),
    retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && count < 3,
  });
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
    <Drawer open onClose={() => nav("/interviews")} title={i ? `${i.candidate.firstName} ${i.candidate.lastName} · ${i.title}` : "Interview"} leading={i ? <Avatar name={`${i.candidate.firstName} ${i.candidate.lastName}`} size="lg" /> : undefined}>
      {q.error && !i ? <ErrorState message={q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 403) ? "This interview is not one of yours, or it no longer exists." : "Could not load this interview."} onRetry={() => q.refetch()} /> : q.isLoading || !i ? <Skeleton lines={8} /> : (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="row"><Pill tone={STATUS_TONE[i.status] ?? "neutral"}>{STATUS_LABEL[i.status] ?? i.status}</Pill><span className="small muted">{i.roleTitle} · attempt {i.attempt}</span></span>
            {canSeeTalent(role) ? <Link to={`/roles/${i.roleId}/talent?open=${i.applicationId}&message=1`} className="btn secondary sm">Message the candidate</Link> : null}
          </div>
          {i.brief ? <BriefCard brief={i.brief} /> : null}
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
    </Drawer>
  );
}

const MET_LABEL: Record<string, string> = { yes: "met", partially: "partly met", no: "not met", unknown: "unknown so far" };
const MET_TONE: Record<string, "good" | "accent" | "caution" | "neutral"> = { yes: "good", partially: "accent", no: "caution", unknown: "neutral" };
const FINDING_LABEL: Record<string, string> = { evidenced: "seen", partially_evidenced: "partly seen", not_evidenced: "not seen yet", contradicted: "contradicted" };
const FINDING_TONE: Record<string, "good" | "accent" | "caution" | "neutral"> = { evidenced: "good", partially_evidenced: "accent", not_evidenced: "neutral", contradicted: "caution" };

/** The interviewer's brief (F7): what the round is for, what to look for, what the evidence says so far. No score, no rationale, pay only when the role may see it. */
function BriefCard({ brief }: { brief: InterviewerBrief }) {
  return (
    <Card title={`Your brief: ${brief.round.title}`}>
      <p className="small" style={{ color: "var(--ink-2)" }}><strong>What this round is for:</strong> {brief.round.purpose}</p>
      <div className="stack" style={{ gap: 10, marginTop: 10 }}>
        <div>
          <h3 className="small" style={{ margin: "0 0 4px" }}>What to look for</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {brief.competencies.map((c) => <li key={c.key}><strong>{c.name}</strong>: {c.definition} <Chip tone={c.finding ? FINDING_TONE[c.finding] ?? "neutral" : "neutral"}>{c.finding ? FINDING_LABEL[c.finding] ?? c.finding : "not assessed yet"}</Chip>{c.note ? <span className="muted"> {c.note}</span> : null}</li>)}
          </ul>
        </div>
        {brief.questions.length ? (
          <div>
            <h3 className="small" style={{ margin: "0 0 4px" }}>Questions the plan suggests</h3>
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{brief.questions.map((qn, i) => <li key={i}>{qn}</li>)}</ul>
          </div>
        ) : null}
        <div>
          <h3 className="small" style={{ margin: "0 0 4px" }}>Must-haves and what we know</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {brief.mustHaves.map((m) => <li key={m.key}>{m.text} <Chip tone={MET_TONE[m.met] ?? "neutral"}>{MET_LABEL[m.met] ?? m.met}</Chip>{m.quote ? <span className="muted"> "{m.quote}"</span> : null}</li>)}
          </ul>
        </div>
        <div>
          <h3 className="small" style={{ margin: "0 0 4px" }}>Strengths so far</h3>
          {brief.strengths.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{brief.strengths.map((s, i) => <li key={i}>{s.claim}{s.quote ? <span className="muted"> "{s.quote}"</span> : null}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>None recorded yet.</p>}
        </div>
        <div>
          <h3 className="small" style={{ margin: "0 0 4px" }}>Worth exploring</h3>
          {brief.concerns.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{brief.concerns.map((s, i) => <li key={i}>{s.claim}{s.quote ? <span className="muted"> "{s.quote}"</span> : null}</li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>Nothing flagged yet.</p>}
        </div>
        {brief.screen?.answers.length ? (
          <details>
            <summary className="small">What they said in the screen ({brief.screen.answers.length} answers)</summary>
            <dl className="kv small" style={{ marginTop: 6 }}>{brief.screen.answers.map((a, i) => <div key={i}><dt>{a.question}</dt><dd>{a.answer}</dd></div>)}</dl>
          </details>
        ) : null}
        {brief.includesPay && brief.pay?.expectation ? <p className="small"><strong>Pay expectation:</strong> {brief.pay.expectation} <Chip tone={brief.pay.withinRange === "yes" ? "good" : brief.pay.withinRange === "unknown" ? "neutral" : "caution"}>{brief.pay.withinRange === "yes" ? "within the range" : brief.pay.withinRange === "unknown" ? "not compared" : `${brief.pay.withinRange} the range`}</Chip></p> : null}
        <p className="small muted" style={{ margin: 0 }}>The decision after the interview is the hiring team's, recorded with a reason. Nothing here is a score.</p>
      </div>
    </Card>
  );
}

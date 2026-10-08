"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useRefresh } from "../nav";
import { Alert, Button, Card, Chip, EmptyState, ErrorState, Field, PageHeader, Pill, Skeleton, type Tone } from "@ros/ui";
import type { EscalationThreadEntry } from "@ros/contracts";
import { api, ApiError } from "../api/client";
import { queueThreadHeading } from "../recruiter-requests";
import { toast } from "../toast";

/** Exactly what a recruiter sees before accepting (correction 11): no customer words, nothing from a candidate record. */
type Preview = { id: string; status: string; kind: string; urgency: "low" | "normal" | "high" | "critical"; requiredExpertise: string; summary: string; companyName: string; roleTitle: string | null; slaDueAt: string | null; slaRemainingMinutes: number | null; businessMinutesRemaining: number | null; overdue: boolean; createdAt: string; claimedByMe: boolean; claimed: boolean };
type Detail = Preview & { accessGranted: boolean; why?: string | null; companyId?: string; roleId?: string | null; applicationId?: string | null; question?: string; contextSnapshot?: Record<string, unknown>; resolution?: string | null; minutesSpent?: number | null; firstResponseAt?: string | null; thread?: EscalationThreadEntry[]; reopenedCount?: number; grant?: { id: string; purpose: string; expiresAt: string; scope: { roleId: string | null; applicationId: string | null } } };

const URGENCY_TONE: Record<Preview["urgency"], Tone> = { low: "neutral", normal: "accent", high: "caution", critical: "critical" };

function remainingText(e: Preview): string {
  if (e.businessMinutesRemaining == null) return "no deadline";
  const m = Math.abs(e.businessMinutesRemaining);
  const h = Math.floor(m / 60);
  const span = h ? `${h}h ${m % 60}m` : `${m}m`;
  return e.businessMinutesRemaining < 0 ? `overdue by ${span} of business time` : `${span} of business time left`;
}

/**
 * The ITS recruiter queue (founder decision F10; correction 11). Before accepting, a recruiter sees the customer, the
 * role, the category, urgency, the expertise needed, the remaining service-level time and a generic summary. Accepting
 * creates a scoped, time-limited grant; the customer's own words and the full context open under it; every page is
 * recorded for the customer; releasing or resolving ends the access.
 */
export function RecruiterQueue() {
  const { id } = useParams();
  const list = useQuery({ queryKey: ["escalations"], queryFn: () => api.get<Preview[]>("/api/v1/escalations") });
  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader eyebrow="ITS recruiters" title="Recruiter queue" sub="Requests from customers: urgent ones first, then the soonest deadline. Urgency changes the order, never the reply-by time. Accept one to open the request itself; your access is limited to that request and ends a day after it is resolved." />
      <div className="grid-2" style={{ gridTemplateColumns: id ? "minmax(260px, 1fr) 2fr" : undefined }}>
        <div className="stack">
          {list.isLoading ? <Skeleton lines={4} /> : list.error ? <ErrorState message="Could not load the queue." onRetry={() => list.refetch()} /> : list.data!.length === 0 ? <EmptyState icon="grid" title="Queue is empty" body="Customer requests appear here." /> : list.data!.map((e) => (
            <Card key={e.id} needsYou={e.status === "open"}>
              <div className="card-title"><h2 style={{ fontSize: 15 }}><Link to={`/recruiter/queue/${e.id}`} style={{ textDecoration: "none", color: "inherit" }}>{e.kind.replace(/_/g, " ")} · {e.companyName}</Link></h2><div className="row"><Pill size="sm" tone={URGENCY_TONE[e.urgency]}>{e.urgency}</Pill><Pill size="sm" tone={e.status === "open" ? "caution" : "accent"}>{e.claimedByMe ? "yours" : e.status}</Pill></div></div>
              <p className="small" style={{ color: "var(--ink-2)" }}>{e.roleTitle ? `${e.roleTitle}: ` : ""}{e.summary}</p>
              <p className="small muted" style={{ marginTop: 6 }}>Needs {e.requiredExpertise} · {remainingText(e)}{e.slaDueAt ? ` · respond by ${new Date(e.slaDueAt).toLocaleString()}` : ""}</p>
            </Card>
          ))}
        </div>
        {id ? <EscalationDetail id={id} /> : null}
      </div>
    </div>
  );
}

function EscalationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ["escalation", id], queryFn: () => api.get<Detail>(`/api/v1/escalations/${id}`) });
  const [resolution, setResolution] = useState("");
  const [minutes, setMinutes] = useState("");
  const [reply, setReply] = useState("");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["escalation", id] }); qc.invalidateQueries({ queryKey: ["escalations"] }); qc.invalidateQueries({ queryKey: ["me"] }); };
  const claim = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/claim`), onSuccess: () => { toast("Accepted. Your access to this customer is now active."); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not accept.") });
  const release = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/release`), onSuccess: () => { toast("Released. Your access ended."); refresh(); } });
  const resolve = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/resolve`, { resolution, minutesSpent: minutes ? Number(minutes) : undefined }), onSuccess: () => { toast("Resolved. The customer has your answer in full; your access ends in 24 hours."); setResolution(""); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not resolve.") });
  // A message without resolving (plan B5): a question back, or progress. The person who asked and the owners read it in full.
  const write = useMutation({ mutationFn: () => api.post(`/api/v1/escalations/${id}/messages`, { body: reply.trim() }), onSuccess: () => { toast("Sent to the customer."); setReply(""); refresh(); }, onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send.") });
  const refreshFrame = useRefresh();
  const enter = useMutation({
    mutationFn: async (e: Detail) => { await api.post("/api/v1/auth/switch", { companyId: e.companyId }); return e; },
    // Another company now: nothing read for the previous one may show (the cache is emptied), and the frame around the
    // page (the access notice, the company chip) is drawn again from the new session.
    onSuccess: (e) => { qc.clear(); nav(e.roleId ? `/roles/${e.roleId}/talent` : "/"); refreshFrame(); },
    onError: (err) => toast(err instanceof ApiError ? err.message : "Could not open the customer."),
  });
  if (q.isLoading || !q.data) return <Skeleton lines={8} />;
  const e = q.data;
  const ctx = (e.contextSnapshot ?? {}) as { company?: { name: string; vertical: string; sizeBand: string }; role?: { title: string; status: string }; packet?: { version: number; packet: { compensation: { basis: string; min: number; max: number; ceiling: number }; requirements: { mustHaves: Array<{ text: string }>; eligibility: Array<{ question: string }> }; description: { publicJobDescription: string } } }; candidate?: { name: string; email: string | null; phone: string | null }; application?: { stage: string }; resumeText?: string | null; assessments?: Array<{ kind: string; overall: string; result: { summary: string } }>; communications?: Array<{ direction: string; subject: string | null; at: string }>; timeline?: Array<{ type: string; at: string }> };
  return (
    <div className="stack">
      <Card title={`${e.kind.replace(/_/g, " ")} · ${e.companyName}${e.roleTitle ? ` · ${e.roleTitle}` : ""}`} aside={<div className="row"><Pill size="sm" tone={URGENCY_TONE[e.urgency]}>{e.urgency}</Pill>{e.status === "open" ? <Button size="sm" variant="primary" loading={claim.isPending} onClick={() => claim.mutate()}>Accept this request</Button> : null}</div>}>
        <p>{e.summary}</p>
        <p className="small muted">Needs {e.requiredExpertise} · {remainingText(e)}{e.slaDueAt ? ` · respond by ${new Date(e.slaDueAt).toLocaleString()}` : ""}{e.firstResponseAt ? ` · first response ${new Date(e.firstResponseAt).toLocaleString()}` : ""}</p>
        {e.reopenedCount ? <p className="small" style={{ marginTop: 6 }}><Chip tone="caution">Reopened{e.reopenedCount > 1 ? ` ${e.reopenedCount} times` : ""}</Chip> The customer said an earlier answer did not solve it; their reason is in the conversation below.</p> : null}
        {e.accessGranted && e.thread?.length ? (
          <div style={{ marginTop: 10 }}>
            <p className="small muted">The conversation</p>
            <ol aria-label="The conversation" style={{ listStyle: "none", margin: 0, padding: "0 0 0 12px", borderLeft: "2px solid var(--line)" }}>
              {e.thread.map((m) => <li key={m.id} style={{ padding: "4px 0" }}><p className="small muted" style={{ margin: 0 }}>{queueThreadHeading(m)} · {new Date(m.at).toLocaleString()}</p><p style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>{m.body}</p></li>)}
            </ol>
          </div>
        ) : e.accessGranted && e.question ? <div style={{ marginTop: 10 }}><p className="small muted">The customer's request</p><p style={{ whiteSpace: "pre-wrap" }}>{e.question}</p></div> : null}
        {e.resolution ? <Alert tone="info">Resolved: {e.resolution}{e.minutesSpent != null ? ` (${e.minutesSpent} min)` : ""}</Alert> : null}
      </Card>
      {!e.accessGranted ? (
        <Alert tone="neutral">{e.why === "claim it to open the full context" ? "Accept the request to open the customer's own words and context. Access is limited to what the request covers (one candidate, one role, or all of their hiring when they chose that), ends a day after the request is resolved, and every page you open is recorded for the customer." : e.why}</Alert>
      ) : (
        <>
          {e.grant ? <Alert tone="info">Your access covers {e.grant.scope.applicationId ? "this candidate" : e.grant.scope.roleId ? "this role" : "this customer"} and ends {new Date(e.grant.expiresAt).toLocaleString()}. <Button size="sm" variant="secondary" loading={enter.isPending} onClick={() => enter.mutate(e)}>Open in the customer's workspace</Button> <Button size="sm" variant="quiet" loading={release.isPending} onClick={() => release.mutate()}>Release</Button></Alert> : null}
          {ctx.company ? <Card title="Company"><dl className="kv"><dt>Name</dt><dd>{ctx.company.name}</dd><dt>Vertical</dt><dd>{ctx.company.vertical}</dd><dt>Size</dt><dd>{ctx.company.sizeBand}</dd></dl></Card> : null}
          {ctx.role && ctx.packet ? (
            <Card title={`Role: ${ctx.role.title} (packet v${ctx.packet.version})`}>
              <dl className="kv">
                <dt>Status</dt><dd>{ctx.role.status}</dd>
                <dt>Pay</dt><dd>{ctx.packet.packet.compensation.min}–{ctx.packet.packet.compensation.max} {ctx.packet.packet.compensation.basis}, ceiling {ctx.packet.packet.compensation.ceiling}</dd>
                <dt>Must-haves</dt><dd>{ctx.packet.packet.requirements.mustHaves.map((m) => m.text).join("; ")}</dd>
                <dt>Eligibility</dt><dd>{ctx.packet.packet.requirements.eligibility.map((m) => m.question).join("; ")}</dd>
              </dl>
              <details style={{ marginTop: 8 }}><summary className="small">Public description</summary><p className="small" style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{ctx.packet.packet.description.publicJobDescription}</p></details>
            </Card>
          ) : null}
          {ctx.candidate ? (
            <Card title={`Candidate: ${ctx.candidate.name}`}>
              <dl className="kv"><dt>Email</dt><dd>{ctx.candidate.email ?? "none"}</dd><dt>Phone</dt><dd>{ctx.candidate.phone ?? "none"}</dd><dt>Stage</dt><dd>{ctx.application?.stage}</dd></dl>
              {ctx.assessments?.length ? <div style={{ marginTop: 8 }}>{ctx.assessments.map((a, i) => <p key={i} className="small"><Chip>{a.kind}</Chip> {a.overall}: {a.result.summary}</p>)}</div> : null}
              {ctx.resumeText ? <details style={{ marginTop: 8 }}><summary className="small">Resume text</summary><pre style={{ whiteSpace: "pre-wrap" }}>{ctx.resumeText}</pre></details> : null}
              {ctx.communications?.length ? <details style={{ marginTop: 8 }}><summary className="small">Messages ({ctx.communications.length})</summary>{ctx.communications.map((m, i) => <div key={i} className="small" style={{ marginTop: 6 }}><strong>{m.direction}: {m.subject}</strong><br /><span className="muted">{new Date(m.at).toLocaleString()}</span></div>)}</details> : null}
              {ctx.timeline?.length ? <details style={{ marginTop: 8 }}><summary className="small">Timeline ({ctx.timeline.length})</summary><ul className="small" style={{ paddingLeft: 18 }}>{ctx.timeline.map((t, i) => <li key={i}>{new Date(t.at).toLocaleString()} · {t.type}</li>)}</ul></details> : null}
            </Card>
          ) : null}
          {e.status !== "resolved" && e.status !== "cancelled" ? (
            <Card title="Write to the customer">
              <Field label="A question or an update, without resolving the request" hint="The person who asked and the owners read it in full on Today." htmlFor="reply"><textarea id="reply" className="textarea" value={reply} onChange={(ev) => setReply(ev.target.value)} /></Field>
              <div style={{ marginTop: 10 }}><Button variant="secondary" loading={write.isPending} disabled={!reply.trim()} onClick={() => write.mutate()}>Send</Button></div>
            </Card>
          ) : null}
          {e.status !== "resolved" ? (
            <Card title="Resolve">
              <Field label="What you did or advised (the customer reads this in full)" htmlFor="res"><textarea id="res" className="textarea" value={resolution} onChange={(ev) => setResolution(ev.target.value)} /></Field>
              <Field label="Minutes spent" hint="Recorded to size recruiter capacity and pricing." htmlFor="mins"><input id="mins" className="input" type="number" min={0} max={1440} value={minutes} onChange={(ev) => setMinutes(ev.target.value)} /></Field>
              <div style={{ marginTop: 10 }}><Button variant="primary" loading={resolve.isPending} disabled={!resolution.trim()} onClick={() => resolve.mutate()}>Mark resolved</Button></div>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

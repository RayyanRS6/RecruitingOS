"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "../nav";
import { Alert, Button, Card, Chip, ErrorState, Field, Segmented, Sheet, Skeleton } from "@ros/ui";
import { formatPayRange } from "@ros/contracts";
import { api, ApiError, type RoleDetail as RoleDetailT, type RolePacket } from "../api/client";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";

type Tab = "overview" | "requirements" | "evaluation" | "posting" | "history";

/** The role page: approve the packet as one thing, see where it is posted, and edit without losing history. */
export function RoleDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const role = useQuery({ queryKey: ["role", id], queryFn: () => api.get<RoleDetailT>(`/api/v1/roles/${id}`) });
  const [tab, setTab] = useState<Tab>("overview");
  const [editing, setEditing] = useState(false);

  const approve = useMutation({
    mutationFn: () => api.post(`/api/v1/roles/${id}/approve`, { version: role.data!.currentPacket!.version }),
    onSuccess: async () => { toast("Approved. Posting now."); await qc.invalidateQueries({ queryKey: ["role", id] }); await qc.invalidateQueries({ queryKey: ["brief"] }); await qc.invalidateQueries({ queryKey: ["roles"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not approve."),
  });
  const status = useMutation({
    mutationFn: (action: "pause" | "resume") => api.post(`/api/v1/roles/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role", id] }),
  });
  const [closing, setClosing] = useState<{ outcome: string; reason: string } | null>(null);
  const closeWithOutcome = useMutation({
    mutationFn: (body: { outcome: string; reason: string }) => api.post(`/api/v1/roles/${id}/outcome`, { outcome: body.outcome, confirm: true, reason: body.reason || undefined }),
    onSuccess: async () => { toast("Role closed; the outcome is recorded with your name."); setClosing(null); await qc.invalidateQueries({ queryKey: ["role", id] }); await qc.invalidateQueries({ queryKey: ["roles"] }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not close the role."),
  });
  const retry = useMutation({
    mutationFn: (channel: string) => api.post(`/api/v1/roles/${id}/postings/${channel}/retry`),
    onSuccess: () => { toast("Retrying."); qc.invalidateQueries({ queryKey: ["role", id] }); },
  });

  if (role.isLoading) return <Skeleton lines={5} />;
  if (role.error || !role.data) return <ErrorState message="Could not load this role." onRetry={() => role.refetch()} />;
  const r = role.data;
  const p = r.currentPacket?.packet;
  const pending = r.pendingApprovals.find((a) => a.actionType === "role_packet.approve");

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <p className="small muted"><Link to="/roles">Roles</Link> / {r.title}</p>
          <h1>{r.title}</h1>
          <p>{p ? `${[p.identity.locations[0]?.city, p.identity.locations[0]?.region].filter(Boolean).join(", ")} · ${p.identity.employmentType.replace("_", " ")} · ${money(p)}` : "No packet yet."}</p>
        </div>
        <div className="row">
          <AskRecruiter roleId={r.id} />
          {r.status === "open" ? <Button onClick={() => status.mutate("pause")}>Pause</Button> : null}
          {r.status === "paused" ? <Button onClick={() => status.mutate("resume")}>Resume</Button> : null}
          {["open", "paused"].includes(r.status) ? <Button variant="destructive" onClick={() => setClosing({ outcome: "filled_outside_platform", reason: "" })}>Close</Button> : null}
        </div>
      </div>

      {closing ? (
        <Card needsYou title="Close this role">
          <p className="small" style={{ color: "var(--ink-2)" }}>Say what happened. It is recorded with your name; active candidates are kept in your talent pool. The platform made no offer.</p>
          <div className="stack" style={{ gap: 8, marginTop: 8, maxWidth: 520 }}>
            <Field label="Outcome" htmlFor="rc-outcome"><select id="rc-outcome" className="select" value={closing.outcome} onChange={(e) => setClosing({ ...closing, outcome: e.target.value })}>
              <option value="filled_outside_platform">Filled outside the platform</option>
              <option value="filled">Filled with a candidate from here (already recorded on the candidate)</option>
              <option value="role_cancelled">Cancelled</option>
              <option value="no_hire">Closed without a hire</option>
            </select></Field>
            <Field label="Reason (optional)" htmlFor="rc-reason"><input id="rc-reason" className="input" value={closing.reason} onChange={(e) => setClosing({ ...closing, reason: e.target.value })} /></Field>
            <div className="row"><Button variant="destructive" loading={closeWithOutcome.isPending} onClick={() => closeWithOutcome.mutate(closing)}>Confirm and close the role</Button><Button variant="quiet" onClick={() => setClosing(null)}>Keep it open</Button></div>
          </div>
        </Card>
      ) : null}

      {pending && p ? (
        <Card needsYou lift title="Approve this role packet">
          <p style={{ color: "var(--ink-2)" }}>{pending.rationale ?? "Review the packet, edit anything, then approve. Approval opens the role and posts it."}</p>
          {p.provenance.assumptions.length ? (
            <div className="alert caution" style={{ marginTop: 10 }}>
              <strong>Assumptions the assistant made:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{p.provenance.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </div>
          ) : null}
          <div className="row" style={{ marginTop: 12 }}>
            <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>Approve and post</Button>
            <Button onClick={() => setEditing(true)}>Edit first</Button>
          </div>
        </Card>
      ) : null}

      {p ? (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Segmented value={tab} onChange={setTab} ariaLabel="Role packet sections" options={[{ value: "overview", label: "Overview" }, { value: "requirements", label: "Requirements" }, { value: "evaluation", label: "How we'll evaluate" }, { value: "posting", label: "Posting" }, { value: "history", label: "History" }]} />
            <div className="row">
              <Chip>Packet v{r.currentPacket!.version}</Chip>
              <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
              <Link to={`/roles/${r.id}/talent`} className="btn primary sm">Talent ({r.counts ? Object.values(r.counts).reduce((a, b) => a + b, 0) : 0})</Link>
            </div>
          </div>

          {tab === "overview" ? (
            <div className="grid-2">
              <Card title="Public description"><p style={{ whiteSpace: "pre-wrap", color: "var(--ink-2)" }}>{p.description.publicJobDescription}</p></Card>
              <div className="stack">
                <Card title="Pay">
                  <dl className="kv">
                    <dt>Range</dt><dd>{money(p)}</dd>
                    <dt>Ceiling</dt><dd>{p.compensation.basis === "hourly" ? `$${p.compensation.ceiling}/hr` : `$${p.compensation.ceiling.toLocaleString()}`} <span className="muted small">(never exceeded without your approval)</span></dd>
                    <dt>Shown to candidates</dt><dd>{p.compensation.discloseRange ? "Yes" : "No"}</dd>
                    <dt>Sources</dt><dd>{p.compensation.sources.map((s) => s.name).join("; ") || "owner-stated"}</dd>
                  </dl>
                </Card>
                <Card title="Why and when">
                  <dl className="kv">
                    <dt>Reason</dt><dd>{p.business.reason.replace("_", " ")}{p.business.reasonDetail ? ` · ${p.business.reasonDetail}` : ""}</dd>
                    <dt>Target start</dt><dd>{p.business.timeline.targetStartDate ?? "Flexible"}</dd>
                    <dt>Urgency</dt><dd>{p.business.timeline.urgency}</dd>
                    <dt>Schedule</dt><dd>{p.identity.schedule ?? "As posted"}</dd>
                  </dl>
                </Card>
                <Card title="Where candidates will come from"><p className="small" style={{ color: "var(--ink-2)" }}>{p.sourcing.summary}</p><div className="row" style={{ marginTop: 8 }}>{p.sourcing.channels.map((c) => <Chip key={c}>{c.replace("_", " ")}</Chip>)}</div></Card>
              </div>
            </div>
          ) : null}

          {tab === "requirements" ? (
            <div className="grid-2">
              <Card title="Must-haves"><ul style={{ paddingLeft: 18, margin: 0 }}>{p.requirements.mustHaves.map((m) => <li key={m.key}><strong>{m.text}</strong><br /><span className="small muted">{m.rationale}</span></li>)}</ul></Card>
              <Card title="Nice-to-haves">{p.requirements.niceToHaves.length ? <ul style={{ paddingLeft: 18, margin: 0 }}>{p.requirements.niceToHaves.map((m) => <li key={m.key}>{m.text}</li>)}</ul> : <p className="muted">None listed.</p>}</Card>
              <Card title="Eligibility questions (the only automatic holds)">
                <p className="small muted" style={{ marginBottom: 8 }}>Candidates answer these when they apply. A "no" on a required one holds the application for your decision: you are reminded, and nothing is sent to the candidate unless you decline. Nothing is ever declined automatically.</p>
                <ul style={{ paddingLeft: 18, margin: 0 }}>{p.requirements.eligibility.map((e) => <li key={e.key}>{e.question} <Chip tone={e.knockout ? "needs" : "neutral"}>{e.knockout ? "required" : "asked"}</Chip><br /><span className="small muted">{e.rationale}</span></li>)}</ul>
              </Card>
              <Card title="Notices candidates see"><div className="row">{p.compliance.notices.map((n) => <Chip key={n}>{n.replace(/_/g, " ")}</Chip>)}</div><p className="small muted" style={{ marginTop: 8 }}>Jurisdictions: {p.compliance.jurisdictions.join(", ") || "none"}</p></Card>
            </div>
          ) : null}

          {tab === "evaluation" ? (
            <div className="grid-2">
              <Card title="What we look for">
                <ul style={{ paddingLeft: 18, margin: 0 }}>{p.competencies.map((c) => <li key={c.key}><strong>{c.name}</strong> <Chip>weight {c.weight}</Chip> <Chip>{c.evaluatedIn}</Chip><br /><span className="small muted">{c.definition}</span></li>)}</ul>
              </Card>
              <Card title={`Screening questions (about ${p.screening.maxMinutes} minutes)`}>
                <ol style={{ paddingLeft: 18, margin: 0 }}>{p.screening.questions.map((q) => <li key={q.key}>{q.question} <Chip>{q.kind}</Chip></li>)}</ol>
              </Card>
              <Card title="Interview plan">
                <ol style={{ paddingLeft: 18, margin: 0 }}>{p.interviews.plan.map((s) => <li key={s.key}><strong>{s.title}</strong> · {s.durationMinutes} min · {s.format}<br /><span className="small muted">{s.purpose} With: {s.interviewerRoles.join(", ") || "owner"}.</span></li>)}</ol>
              </Card>
              <Card title="How candidates are messaged"><p className="small" style={{ color: "var(--ink-2)" }}>{p.communication.disclosureText}</p><p className="small muted" style={{ marginTop: 6 }}>{p.communication.humanAlternativeText}</p></Card>
            </div>
          ) : null}

          {tab === "posting" ? (
            <div className="stack">
              {r.status !== "open" ? <Alert tone="caution">Posting starts when the role is approved and open.</Alert> : null}
              {r.postings.map((po) => (
                <Card key={po.id}>
                  <div className="card-title">
                    <h2 style={{ fontSize: 15 }}>{channelName(po.channel)}</h2>
                    <Chip tone={po.status === "live_verified" ? "good" : po.status === "failed" ? "critical" : po.status === "manual_action_required" ? "needs" : po.status === "awaiting_verification" ? "accent" : "neutral"}>{POSTING_STATE_LABEL[po.status] ?? po.status}</Chip>
                  </div>
                  {po.externalUrl ? <p className="small"><a href={po.externalUrl} target="_blank" rel="noreferrer">{po.externalUrl}</a></p> : null}
                  {po.instructions ? <p className="small" style={{ color: "var(--ink-2)", marginTop: 6 }}>{po.instructions}</p> : null}
                  {po.channel === "email_in" && po.externalUrl === null && po.intakeToken ? null : null}
                  {po.error ? <Alert tone="critical">{po.error}</Alert> : null}
                  <div className="row" style={{ marginTop: 8 }}>
                    {po.status === "failed" ? <Button size="sm" onClick={() => retry.mutate(po.channel)}>Retry</Button> : null}
                    {po.instructions?.includes("@") ? <Button size="sm" onClick={() => { const addr = po.instructions!.match(/apply-[a-z0-9]+@[a-z0-9.-]+/i)?.[0]; if (addr) { navigator.clipboard.writeText(addr); toast("Copied the intake address."); } }}>Copy intake address</Button> : null}
                  </div>
                </Card>
              ))}
              {r.postings.length === 0 ? <p className="muted">Nothing posted yet.</p> : null}
            </div>
          ) : null}

          {tab === "history" ? (
            <Card title="Packet versions">
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {r.packetVersions.map((v) => <li key={v.version}>v{v.version} · {v.status} · {v.source.replace("_", " ")} · {new Date(v.createdAt).toLocaleString()} · {v.createdBy.name ?? v.createdBy.kind}{v.changeSummary ? ` · ${v.changeSummary}` : ""}</li>)}
              </ul>
              <p className="small muted" style={{ marginTop: 8 }}>Every version is kept. Nothing is overwritten.</p>
            </Card>
          ) : null}
        </>
      ) : null}

      {p ? <EditPacket open={editing} onClose={() => setEditing(false)} roleId={r.id} packet={p} /> : null}
    </div>
  );
}

/** The five channel states (founder decision F4). Nothing is called live without verification. */
const POSTING_STATE_LABEL: Record<string, string> = { live_verified: "Live and verified", awaiting_verification: "Submitted, awaiting verification", manual_action_required: "Manual action required", not_connected: "Not connected", failed: "Failed" };

function money(p: RolePacket): string {
  return formatPayRange(p.compensation);
}

function channelName(c: string): string {
  return { careers_page: "Your careers page", google_jobs: "Google for Jobs", email_in: "Applications by email (Indeed and others)", linkedin_basic: "LinkedIn basic listing", indeed: "Indeed", ziprecruiter: "ZipRecruiter" }[c] ?? c;
}

/** Owner-friendly edit of the most-changed fields; recruiters can edit the whole packet as JSON. Every save is a new version. */
function EditPacket({ open, onClose, roleId, packet }: { open: boolean; onClose: () => void; roleId: string; packet: RolePacket }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"simple" | "json">("simple");
  const [description, setDescription] = useState(packet.description.publicJobDescription);
  const [min, setMin] = useState(String(packet.compensation.min));
  const [max, setMax] = useState(String(packet.compensation.max));
  const [ceiling, setCeiling] = useState(String(packet.compensation.ceiling));
  const [mustHaves, setMustHaves] = useState(packet.requirements.mustHaves.map((m) => m.text).join("\n"));
  const [json, setJson] = useState(JSON.stringify(packet, null, 2));
  const [summary, setSummary] = useState("");
  const save = useMutation({
    mutationFn: () => {
      let next: RolePacket;
      if (mode === "json") next = JSON.parse(json) as RolePacket;
      else {
        next = structuredClone(packet);
        next.description.publicJobDescription = description;
        next.compensation.min = Number(min);
        next.compensation.max = Number(max);
        next.compensation.ceiling = Math.max(Number(ceiling), Number(max));
        next.requirements.mustHaves = mustHaves.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6).map((text, i) => packet.requirements.mustHaves.find((m) => m.text === text) ?? { key: `mh_${i + 1}_${text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30)}`, text, rationale: "Added by the owner" });
      }
      return api.post(`/api/v1/roles/${roleId}/packets`, { packet: next, changeSummary: summary || "Edited by the owner" });
    },
    onSuccess: async () => { toast("Saved as a new version."); await qc.invalidateQueries({ queryKey: ["role", roleId] }); await qc.invalidateQueries({ queryKey: ["brief"] }); onClose(); },
  });
  return (
    <Sheet open={open} onClose={onClose} title="Edit the role">
      <div className="stack">
        <Segmented value={mode} onChange={setMode} options={[{ value: "simple", label: "The usual edits" }, { value: "json", label: "Everything (advanced)" }]} />
        {mode === "simple" ? (
          <>
            <Field label="Public description" htmlFor="desc"><textarea id="desc" className="textarea" style={{ minHeight: 180 }} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <div className="grid-2">
              <Field label="Pay minimum" htmlFor="min"><input id="min" className="input" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
              <Field label="Pay maximum" htmlFor="max"><input id="max" className="input" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
            </div>
            <Field label="Ceiling (the most you would pay)" htmlFor="ceil" hint="Offers never go above this without a new approval."><input id="ceil" className="input" value={ceiling} onChange={(e) => setCeiling(e.target.value)} /></Field>
            <Field label="Must-haves, one per line (max six)" htmlFor="mh"><textarea id="mh" className="textarea" value={mustHaves} onChange={(e) => setMustHaves(e.target.value)} /></Field>
          </>
        ) : (
          <Field label="Role packet JSON" hint="Validated on save. Eligibility rules must use the allowed types."><textarea className="textarea" style={{ minHeight: 360, fontFamily: "var(--mono)", fontSize: 12 }} value={json} onChange={(e) => setJson(e.target.value)} /></Field>
        )}
        <Field label="What changed and why" htmlFor="sum"><input id="sum" className="input" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Raised the range after seeing the market number" /></Field>
        {save.error ? <Alert tone="critical">{save.error instanceof ApiError ? save.error.message : "Could not save."}</Alert> : null}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save as a new version</Button>
      </div>
    </Sheet>
  );
}

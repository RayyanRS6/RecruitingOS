"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Button, Card, Chip, ErrorState, Field, Segmented, Skeleton } from "@ros/ui";
import { formatPayRange } from "@ros/contracts";
import { api, ApiError, type RoleDetail as RoleDetailT, type RolePacket } from "../api/client";
import { toast } from "../toast";
import { AskRecruiter } from "../components/AskRecruiter";
import { AcceptingSwitch, ClosedBanner, PostingTab, StillUpAlert } from "./RolePosting";
import { ActivityTab, InterviewPlanTab, PacketApprovalCard, PreferencesCard, RequirementList, workModelLabel } from "./RolePlan";
import { EditPacket } from "./RoleEditor";
import { ReportTab } from "./RoleReport";

type Tab = "overview" | "requirements" | "evaluation" | "plan" | "posting" | "activity" | "history" | "report";
const TABS: readonly Tab[] = ["overview", "requirements", "evaluation", "plan", "posting", "activity", "history", "report"];
/** `?tab=posting` opens the Posting tab straight from a notification or a brief card. */
function tabFrom(value: string | null): Tab {
  return value && (TABS as readonly string[]).includes(value) ? (value as Tab) : "overview";
}

/** The role page: approve the packet as one thing, see where it is posted, and edit without losing history. */
export function RoleDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const role = useQuery({ queryKey: ["role", id], queryFn: () => api.get<RoleDetailT>(`/api/v1/roles/${id}`) });
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const wantedTab = search.get("tab");
  const [tab, setTab] = useState<Tab>(tabFrom(wantedTab));
  // A notification or a brief card followed while this page is already open only changes the query string: follow it.
  useEffect(() => { if (wantedTab) setTab(tabFrom(wantedTab)); }, [wantedTab]);
  // A tab picked by hand keeps the address honest, so the next `?tab=posting` link is seen as a change.
  const pickTab = (next: Tab) => { setTab(next); if (wantedTab && wantedTab !== next) navigate(`/roles/${id}?tab=${next}`, { replace: true }); };
  const [editing, setEditing] = useState(false);

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
  if (role.isLoading) return <Skeleton lines={5} />;
  if (role.error || !role.data) return <ErrorState message="Could not load this role." onRetry={() => role.refetch()} />;
  const r = role.data;
  const p = r.currentPacket?.packet;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <p className="small muted"><Link to="/roles">Roles</Link> / {r.title}</p>
          <h1>{r.title}</h1>
          <p>{p ? `${[p.identity.locations[0]?.city, p.identity.locations[0]?.region].filter(Boolean).join(", ")} · ${p.identity.employmentType.replace("_", " ")} · ${workModelLabel(p.identity.remotePolicy)} · ${money(p)}` : "No packet yet."}</p>
        </div>
        <div className="row">
          <AskRecruiter roleId={r.id} />
          <AcceptingSwitch role={r} />
          {r.status === "open" ? <Button onClick={() => status.mutate("pause")}>Pause</Button> : null}
          {r.status === "paused" ? <Button onClick={() => status.mutate("resume")}>Resume</Button> : null}
          {["open", "paused"].includes(r.status) ? <Button variant="destructive" onClick={() => setClosing({ outcome: "filled_outside_platform", reason: "" })}>Close</Button> : null}
        </div>
      </div>

      <StillUpAlert channels={r.boardsStillUp ?? []} roleStatus={r.status} onOpen={() => pickTab("posting")} />
      <ClosedBanner role={r} />

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

      {p ? <PacketApprovalCard role={r} onEdit={() => setEditing(true)} /> : null}

      {p ? (
        <>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <Segmented value={tab} onChange={pickTab} ariaLabel="Role packet sections" options={[{ value: "overview", label: "Overview" }, { value: "requirements", label: "Requirements" }, { value: "evaluation", label: "How we'll evaluate" }, { value: "plan", label: "Interview plan" }, { value: "posting", label: "Posting" }, { value: "activity", label: "Activity" }, { value: "history", label: "History" }, { value: "report", label: "Report" }]} />
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
                    <dt>Work model</dt><dd>{workModelLabel(p.identity.remotePolicy)}</dd>
                  </dl>
                </Card>
                <PreferencesCard packet={p} decisionMaker={r.decisionMaker ?? null} />
                <Card title="Where candidates will come from"><p className="small" style={{ color: "var(--ink-2)" }}>{p.sourcing.summary}</p><div className="row" style={{ marginTop: 8 }}>{p.sourcing.channels.map((c) => <Chip key={c}>{c.replace("_", " ")}</Chip>)}</div></Card>
              </div>
            </div>
          ) : null}

          {tab === "requirements" ? (
            <div className="grid-2">
              <Card title="Must-haves"><RequirementList items={p.requirements.mustHaves} empty="None listed." /><p className="small muted" style={{ marginTop: 8 }}>"Evidenced in" says where each one is checked; a must-have marked "screen" is asked about in the screening conversation.</p></Card>
              <Card title="Nice-to-haves"><RequirementList items={p.requirements.niceToHaves} empty="None listed." /></Card>
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
              <Card title="Interview rounds"><p className="small" style={{ color: "var(--ink-2)" }}>{p.interviews.plan.map((s) => s.title).join(", ")}.</p><p className="small muted" style={{ marginTop: 6 }}>Who interviews in each round, and whether times can be offered to them, is on the Interview plan tab.</p><div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => pickTab("plan")}>Open the interview plan</Button></div></Card>
              <Card title="How candidates are messaged"><p className="small" style={{ color: "var(--ink-2)" }}>{p.communication.disclosureText}</p><p className="small muted" style={{ marginTop: 6 }}>{p.communication.humanAlternativeText}</p></Card>
            </div>
          ) : null}

          {tab === "plan" ? <InterviewPlanTab roleId={r.id} /> : null}

          {tab === "posting" ? <PostingTab roleId={r.id} roleStatus={r.status} /> : null}

          {tab === "activity" ? <ActivityTab roleId={r.id} /> : null}

          {tab === "report" ? <ReportTab roleId={r.id} /> : null}

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

function money(p: RolePacket): string {
  return formatPayRange(p.compensation);
}

// The packet editor lives in RoleEditor.tsx; the approval card, the preferences card and the Interview plan and Activity tabs in RolePlan.tsx.

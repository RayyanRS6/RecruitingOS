"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Alert, Avatar, Button, Card, Chip, EmptyState, ErrorState, Icon, PageHeader, Pill, Sheet, Skeleton, StageButton, StatusChip, TabPanel, Table, Tabs, type OwnerStage } from "@ros/ui";
import { api, ApiError, type ActionResult, type ApplicationSummary, type ApplicationsWithCounts, type CompareResponse, type DecisionMessagePreview, type DecisionMessagesResponse, type Me, type RoleSummary } from "../api/client";
import { toast } from "../toast";
import { messageOnItsWayChip } from "../company-check";
import { AskRecruiter } from "../components/AskRecruiter";
import { ShareJob } from "../components/ShareJob";
import { useCompanyCheck } from "../components/use-company-check";
import { LOW_CONFIDENCE_LABEL } from "../evidence";
import { activeCompanyOf } from "../rail";
import { canDecline, canShareJob } from "../roles";
import { roleStatus } from "../role-status";
import { actionToast, batches, bulkSendToast, holdDay, mergeDecisionResults, noticeText, stageBlocked, stageIntent, type PanelStep } from "../talent-actions";
import { ORDERS, READING, READING_FILTERS, appliedWhen, applyView, defaultView, emptyText, readingCounts, readingOf, stripItems, waitingText, type Order, type ReadingFilter, type TalentView } from "../talent-list";
import { CandidatePanel } from "./candidate-panel/CandidatePanel";
import { MET_TONE, overallLabel } from "./candidate-panel/assessment";
import { REC_LABEL, STAGE_LABEL, panelSearch, panelTabFrom, type PanelTab } from "./candidate-panel/helpers";
import type { ActionBody } from "./candidate-panel/hooks";

/** Where the candidate panel stands: who, which section, a step a stage choice opened, and the list it was opened from. */
type PanelState = { id: string; tab: PanelTab; step: PanelStep | null; roundKey?: string; ids: string[] | null; compose: boolean };

/** The link filters (`?ownerStage=`, `?stage=`, `?told=`) as one key: when a link changes them, the view starts again from it. */
const linkKey = (p: URLSearchParams) => ["ownerStage", "stage", "told"].map((k) => p.get(k) ?? "").join("|");

/**
 * Talent (plan A3; founder decisions B3 and B6): one role's applicants as a calm list. The stage strip counts everyone
 * at each stage and filters by a click; each row has the person's initials, name, when they applied, how long they have
 * waited on you, the latest reading and the stage button. Readings only filter; nothing is ordered by them. A row opens
 * the candidate panel, whose place is kept in the address (`?open=<id>&tab=…`).
 */
export function People() {
  const params = useParams();
  const nav = useNavigate();
  const [search] = useSearchParams();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const myRole = company.role ?? (me.data?.staffAccess ? "recruiter" : null);
  const roleId = params.id ?? roles.data?.find((r) => r.status === "open")?.id ?? roles.data?.[0]?.id;
  const role = roles.data?.find((r) => r.id === roleId);
  const apps = useQuery({ queryKey: ["applications", roleId], queryFn: () => api.get<ApplicationsWithCounts>(`/api/v1/roles/${roleId}/applications?counts=1`), enabled: !!roleId });
  const rows = apps.data?.applications ?? [];
  const counts = apps.data?.counts;

  // The view: what a link asked for, otherwise "waiting on you" when anyone does; changed by the strip and the filters.
  const key = linkKey(search);
  const [viewState, setViewState] = useState<{ key: string; view: TalentView } | null>(null);
  const view = viewState?.key === key ? viewState.view : defaultView(search, counts);
  const setView = (patch: Partial<TalentView>) => setViewState({ key, view: { ...view, ...patch } });
  /** Takes the link's step filter (`?stage=`) off, from the address too, so a reload does not bring it back. */
  const clearStageLink = () => {
    const next = new URLSearchParams(search);
    next.delete("stage");
    setViewState({ key: linkKey(next), view: { ...view, internalStage: null } });
    const qs = next.toString();
    nav(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  const shown = applyView(rows, view);
  const shownIds = shown.map((a) => a.id);
  const byReading = readingCounts(rows, view);
  const provenMissKnown = rows.some((a) => a.evidence?.hasProvenMiss !== undefined);
  const waitingCount = counts?.byGroup.waiting_on_you ?? 0;
  const notTold = rows.filter((a) => a.toldState === "not_told" && !a.decisionMessageWaiting);
  const mayTell = canDecline(myRole);
  const [compareOpen, setCompareOpen] = useState(false);
  const [telling, setTelling] = useState(false);

  // The candidate panel, mirrored in the address with replace, so Back leaves the page as before.
  const openParam = search.get("open");
  const fromLink = (): PanelState | null => (openParam ? { id: openParam, tab: search.get("message") === "1" ? "messages" : panelTabFrom(search.get("tab")), step: null, ids: null, compose: search.get("message") === "1" } : null);
  const [panel, setPanel] = useState<PanelState | null>(fromLink);
  // A notification or a Today card followed while this page is open changes only the address: follow it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new `?open=` in the address re-reads it
  useEffect(() => { if (openParam && openParam !== panel?.id) setPanel(fromLink()); }, [openParam]);
  const showPanel = (next: PanelState | null) => {
    setPanel(next);
    nav(`${window.location.pathname}${panelSearch(search, next ? { open: next.id, tab: next.tab } : { open: null })}`, { replace: true });
  };
  const openPanel = (id: string, step: PanelStep | null = null) => showPanel({ id, tab: "overview", step, ids: shownIds, compose: false });
  // Opened from a link, the panel steps through the list on screen when the person is in it.
  const panelIds = panel ? (panel.ids ?? (shownIds.includes(panel.id) ? shownIds : null)) : null;

  // A stage choice on a row: a mark in one click; anything that needs more opens that step in the panel.
  const rowAct = useMutation({
    mutationFn: (input: { id: string; body: ActionBody }) => api.post<ActionResult>(`/api/v1/applications/${input.id}/actions`, input.body),
    onSuccess: async (r, input) => {
      const t = actionToast(input.body.action, r);
      toast(t.title, t.detail);
      await Promise.all([qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["application", input.id] }), qc.invalidateQueries({ queryKey: ["brief"] }), qc.invalidateQueries({ queryKey: ["roles"] })]);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Try again."),
  });
  const onRowMove = (a: ApplicationSummary, to: OwnerStage) => {
    const move = a.stageMoves.find((m) => m.to === to);
    if (!move) return;
    const intent = stageIntent(move);
    if (intent.kind === "action") rowAct.mutate({ id: a.id, body: intent.body });
    else if (intent.kind === "step") openPanel(a.id, intent.step);
  };

  const status = role ? (role.status === "open" ? { label: "Live", tone: "good" as const } : roleStatus(role.status)) : null;
  const total = counts?.total ?? rows.length;
  const empty = emptyText(view, total);
  const filtersOn = view.reading !== "any" || view.query.trim() !== "" || view.waiting || view.stage !== "all" || !!view.internalStage || !!view.told;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow={company.name ? `Job · ${company.name}` : "Job"}
        title={role?.title ?? "Talent"}
        status={status ? <Pill tone={status.tone} pulse={role?.status === "open"}>{status.label}</Pill> : undefined}
        sub={roleId && apps.data ? `${total} ${total === 1 ? "applicant" : "applicants"}${waitingCount ? ` · ${waitingCount} waiting on you` : ""}` : undefined}
        actions={
          <>
            {roles.data && roles.data.length > 1 ? (
              <select className="select" style={{ width: "auto" }} value={roleId ?? ""} onChange={(e) => nav(`/roles/${e.target.value}/talent`)} aria-label="Role">
                {roles.data.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            ) : null}
            {roleId && rows.length > 1 ? <Button variant={compareOpen ? "primary" : "secondary"} onClick={() => setCompareOpen((v) => !v)}>{compareOpen ? "Done comparing" : "Compare"}</Button> : null}
            {roleId ? <AskRecruiter roleId={roleId} /> : null}
          </>
        }
      />
      {!roleId ? (
        roles.isLoading ? <Skeleton lines={4} /> : <EmptyState icon="talent" title="No roles yet" body="Open a role first; its applicants show here." action={<Link to="/" className="btn primary">Go to Today</Link>} />
      ) : (
        <>
          <Tabs idBase="talent-strip" label="Stages" variant="counts" value={view.stage} onChange={(v) => setView({ stage: v as TalentView["stage"], waiting: false })} items={stripItems(counts)} />
          <div className="talent-toolbar">
            {waitingCount ? <button type="button" className="toggle-chip" aria-pressed={view.waiting} onClick={() => setView({ waiting: !view.waiting, order: view.waiting ? view.order : "waiting" })}>Waiting on you <span className="count">{waitingCount}</span></button> : null}
            {mayTell && (counts?.notTold ?? 0) > 0 ? <button type="button" className="toggle-chip" aria-pressed={view.told === "not_told"} onClick={() => setView(view.told === "not_told" ? { told: null } : { told: "not_told", stage: "not_moving_forward", waiting: false })}>Not told yet <span className="count">{counts?.notTold}</span></button> : null}
            {view.internalStage ? <button type="button" className="toggle-chip" aria-pressed="true" aria-label={`Showing only: ${STAGE_LABEL[view.internalStage] ?? view.internalStage}. Remove this filter`} onClick={clearStageLink}>{STAGE_LABEL[view.internalStage] ?? view.internalStage.replace(/_/g, " ")} <Icon name="x" size={14} /></button> : null}
            <select className="select" aria-label="Reading" value={view.reading} onChange={(e) => setView({ reading: e.target.value as ReadingFilter })}>
              {READING_FILTERS.filter((f) => f.id !== "missing_must_have" || provenMissKnown).map((f) => <option key={f.id} value={f.id}>{f.label}{f.id === "any" ? "" : ` (${byReading[f.id]})`}</option>)}
            </select>
            <input className="input talent-search" type="search" value={view.query} onChange={(e) => setView({ query: e.target.value })} placeholder="Search name, email or source" aria-label="Search applicants" />
            <select className="select" aria-label="Order" value={view.order} onChange={(e) => setView({ order: e.target.value as Order })}>
              {ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          {mayTell && notTold.length && (view.told === "not_told" || view.stage === "not_moving_forward") ? (
            <Alert tone="info">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{notTold.length === 1 ? "1 person has" : `${notTold.length} people have`} not been told your decision. Decisions stay private until someone sends the decision message or records telling them.</span>
                <Button size="sm" variant="primary" icon="send" onClick={() => setTelling(true)}>Review and send</Button>
              </div>
            </Alert>
          ) : null}
          {compareOpen ? <ComparePanel roleId={roleId} candidates={shown.map((a) => ({ id: a.id, name: a.candidate?.name ?? "Unknown", stageLabel: a.ownerStageLabel }))} /> : null}
          <TabPanel idBase="talent-strip" value={view.stage}>
            {apps.isLoading ? <Skeleton lines={5} /> : apps.error ? <ErrorState message="Could not load the applicants." onRetry={() => apps.refetch()} /> : shown.length === 0 && total === 0 && role?.status === "open" && canShareJob(myRole) ? (
              // Nobody yet on a live job (plan D8): the empty list is the place to share it from.
              <div className="empty" style={{ justifyItems: "stretch", textAlign: "left" }}>
                <h2 style={{ textAlign: "center" }}>Nobody has applied yet</h2>
                <p style={{ textAlign: "center", justifySelf: "center" }}>Share the job to bring in the first applicants. Each place gets its own link, so you can see here where people came from.</p>
                <ShareJob roleId={roleId} roleTitle={role.title} companyName={company.name} compact />
              </div>
            ) : shown.length === 0 ? (
              <EmptyState icon="talent" title={empty.title} body={empty.body} action={filtersOn && total > 0 ? <Button size="sm" onClick={() => setViewState({ key, view: { ...defaultView(new URLSearchParams(), null), waiting: false } })}>Show everyone</Button> : undefined} />
            ) : (
              <div className="talent-list">
                {shown.map((a) => <TalentRow key={a.id} a={a} busy={rowAct.isPending && rowAct.variables?.id === a.id} onOpen={() => openPanel(a.id)} onMove={(to) => onRowMove(a, to)} />)}
              </div>
            )}
          </TabPanel>
        </>
      )}
      {panel && roleId ? (
        <CandidatePanel
          id={panel.id}
          roleId={roleId}
          roleTitle={role?.title ?? null}
          tab={panel.tab}
          onTab={(tab) => showPanel({ ...panel, tab })}
          step={panel.step}
          roundKey={panel.roundKey}
          onStep={(step, opts) => setPanel((p) => (p ? { ...p, step, roundKey: opts?.roundKey } : p))}
          ids={panelIds}
          onGo={(id) => showPanel({ ...panel, id, step: null, roundKey: undefined, compose: false, ids: panelIds })}
          onClose={() => showPanel(null)}
          composeOnOpen={panel.compose}
        />
      ) : null}
      {telling && roleId ? <TellSheet roleId={roleId} people={notTold} onClose={() => setTelling(false)} /> : null}
    </div>
  );
}

/** One applicant: initials, name, when they applied, the wait, the reading, the room kept for the match score, the stage button. */
function TalentRow({ a, busy, onOpen, onMove }: { a: ApplicationSummary; busy: boolean; onOpen: () => void; onMove: (to: OwnerStage) => void }) {
  const name = a.candidate?.name ?? "Unknown";
  const reading = readingOf(a);
  const waiting = waitingText(a);
  // A decision message in the outbox of a company ITS has not confirmed yet waits for the check (founder decision B7).
  const check = useCompanyCheck();
  return (
    <div className="talent-row">
      <Avatar name={name} />
      <div className="talent-row-main">
        <button type="button" className="talent-name" onClick={onOpen}>{name}</button>
        <span className="talent-row-sub">
          <span>{appliedWhen(a.appliedAt ?? a.createdAt)}</span>
          <span>{a.source.replace(/_/g, " ")}</span>
          {waiting ? <span className="waiting">{waiting}</span> : null}
          {a.mark?.mark === "on_hold" && a.mark.remindAt && !a.tags.includes("Hold ended") ? <span>On hold until {holdDay(a.mark.remindAt)}</span> : null}
        </span>
      </div>
      <div className="talent-row-chips">
        {reading !== "none" ? <Pill size="sm" tone={READING[reading].tone}>{READING[reading].label}</Pill> : null}
        {a.evidence?.lowConfidence && reading !== "closer_look" ? <Chip tone="caution">{LOW_CONFIDENCE_LABEL}</Chip> : null}
        {a.tags.map((t) => <Chip key={t} tone="caution">{t}</Chip>)}
        {a.toldState === "not_told" ? <Chip>{a.decisionMessageWaiting ? "Message waiting for approval" : "Not told yet"}</Chip> : null}
        {a.toldState === "queued" ? <Chip>{messageOnItsWayChip(check)}</Chip> : null}
      </div>
      {/* the match score (Wave F) goes here; the room is kept so the rows do not move when it arrives */}
      <span className="score-slot" aria-hidden="true" />
      <StageButton stage={a.ownerStage} label={a.ownerStageLabel} blocked={stageBlocked(a.stageMoves)} disabled={busy} onMove={onMove} align="end" />
    </div>
  );
}

/**
 * "Not told yet" for several people at once (founder decision B6): the standard wording shown first, each person ticked
 * by default, then one Send that sends to each of them separately, with every person's own result.
 */
function TellSheet({ roleId, people, onClose }: { roleId: string; people: ApplicationSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string[]>(people.map((p) => p.id));
  const [results, setResults] = useState<DecisionMessagesResponse | null>(null);
  const sample = picked[0] ?? null;
  const preview = useQuery({ queryKey: ["decision-message", sample], queryFn: () => api.get<DecisionMessagePreview>(`/api/v1/applications/${sample}/decision-message`), enabled: !!sample && !results });
  const send = useMutation({
    // in requests of at most a hundred people each, one after the other, so a long list after a role close goes out whole
    mutationFn: async () => {
      const parts: DecisionMessagesResponse[] = [];
      for (const ids of batches(picked)) parts.push(await api.post<DecisionMessagesResponse>(`/api/v1/roles/${roleId}/decision-messages`, { applicationIds: ids }));
      return mergeDecisionResults(parts);
    },
    onSuccess: async (r) => {
      setResults(r);
      const t = bulkSendToast(r);
      toast(t.title, t.detail);
      await Promise.all([qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["brief"] }), qc.invalidateQueries({ queryKey: ["application"] })]);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send the messages."),
  });
  const nameOf = (id: string) => people.find((p) => p.id === id)?.candidate?.name ?? "A candidate";
  const policy = preview.data?.policy;
  return (
    <Sheet open onClose={onClose} title="Send the decision message">
      {results ? (
        <div className="stack">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {results.results.map((r) => <li key={r.applicationId}><strong>{nameOf(r.applicationId)}</strong>: {r.ok && r.candidateNotice ? noticeText(r.candidateNotice) : r.message ?? "Not sent."}</li>)}
          </ul>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>Each person gets the standard decision message on its own, with their own name. Untick anyone you would rather tell yourself.</p>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted">Who gets it</legend>
            {people.map((p) => (
              <label key={p.id} className="row small" style={{ gap: 8 }}>
                <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((now) => (e.target.checked ? [...now, p.id] : now.filter((x) => x !== p.id)))} />
                {p.candidate?.name ?? "Unknown"}{p.candidate?.email ? "" : <span className="muted"> (no email address on file)</span>}
              </label>
            ))}
          </fieldset>
          {sample ? (
            preview.isLoading ? <Skeleton lines={4} /> : preview.data ? (
              <Card title={`What ${nameOf(sample).split(" ")[0]} will get`}>
                <p className="small" style={{ margin: 0 }}><strong>{preview.data.subject}</strong></p>
                <p className="small" style={{ margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{preview.data.text}</p>
                <p className="small muted" style={{ marginTop: 8 }}>People declined on an eligibility answer get the version about their answers.</p>
              </Card>
            ) : <ErrorState message="Could not load the message." onRetry={() => preview.refetch()} />
          ) : null}
          {policy === "not_sent" ? <Alert tone="caution">Under your settings no decision messages are sent. Tell each person yourself, then record it on their page.</Alert> : null}
          {policy === "needs_approval" ? <p className="small muted" style={{ margin: 0 }}>Under your settings each message waits for approval before it goes out.</p> : null}
          <Button variant="primary" icon="send" disabled={!picked.length || policy === "not_sent"} loading={send.isPending} onClick={() => send.mutate()}>{policy === "needs_approval" ? `Send ${picked.length} for approval` : `Send to ${picked.length} ${picked.length === 1 ? "person" : "people"}`}</Button>
        </div>
      )}
    </Sheet>
  );
}

const COMPARE_MAX = 5;
const COMPARE_LABEL: Record<string, string> = { yes: "met", partially: "partly met", no: "not met", unknown: "unknown", evidenced: "seen", partially_evidenced: "partly seen", not_evidenced: "not seen yet", contradicted: "contradicted" };

/** Compare mode (F10): pick up to five people from the list, then see must-haves and competencies side by side. Nothing is ranked. */
function ComparePanel({ roleId, candidates }: { roleId: string; candidates: Array<{ id: string; name: string; stageLabel: string }> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [ids, setIds] = useState<string[] | null>(null);
  const toggle = (id: string, on: boolean) => setPicked((p) => (on ? (p.includes(id) || p.length >= COMPARE_MAX ? p : [...p, id]) : p.filter((x) => x !== id)));
  const q = useQuery({ queryKey: ["compare", roleId, (ids ?? []).join(",")], queryFn: () => api.get<CompareResponse>(`/api/v1/roles/${roleId}/compare?ids=${(ids ?? []).join(",")}`), enabled: !!ids?.length });
  return (
    <Card title="Compare candidates" aside={<span className="small muted">{picked.length} of {COMPARE_MAX} chosen</span>}>
      <p className="small muted" style={{ margin: 0 }}>Tick up to five people, then compare. People decide; nothing here is ranked.</p>
      <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
        {candidates.map((c) => (
          <label key={c.id} className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={picked.includes(c.id)} disabled={!picked.includes(c.id) && picked.length >= COMPARE_MAX} onChange={(e) => toggle(c.id, e.target.checked)} />
            {c.name} <span className="muted">({c.stageLabel})</span>
          </label>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Button size="sm" variant="primary" disabled={!picked.length} onClick={() => setIds(picked)}>Compare selected</Button>
        {ids ? <Button size="sm" variant="quiet" onClick={() => { setIds(null); setPicked([]); }}>Clear</Button> : null}
      </div>
      {ids?.length ? (q.isLoading ? <Skeleton lines={3} /> : q.error ? <ErrorState message="Could not load the comparison." onRetry={() => q.refetch()} /> : q.data ? <CompareTable data={q.data} /> : null) : null}
    </Card>
  );
}

/** Candidates as columns, must-haves and competencies as rows, findings as chips; a link back to each panel. */
function CompareTable({ data }: { data: CompareResponse }) {
  const chip = (v: string | undefined) => (v ? <Chip tone={MET_TONE[v] ?? "neutral"}>{COMPARE_LABEL[v] ?? v.replace(/_/g, " ")}</Chip> : <span className="small muted">no evidence yet</span>);
  const cands = data.candidates;
  return (
    <div style={{ marginTop: 12 }}>
      <Table head={["What we checked", ...cands.map((c) => c.name)]} label="Candidates compared">
        <tr><td className="small muted">Where they are</td>{cands.map((c) => <td key={c.applicationId}><StatusChip stage={c.stage} label={c.ownerStageLabel ?? c.stageLabel} group={c.group} /></td>)}</tr>
        {data.mustHaves.map((m) => <tr key={m.key}><td className="small"><strong>Must-have:</strong> {m.text}</td>{cands.map((c) => <td key={c.applicationId}>{chip(c.mustHaves[m.key]?.met)}</td>)}</tr>)}
        {data.competencies.map((x) => <tr key={x.key}><td className="small" title={x.definition}>{x.name}</td>{cands.map((c) => <td key={c.applicationId}>{chip(c.competencies[x.key]?.finding)}</td>)}</tr>)}
        <tr><td className="small muted">Screen</td>{cands.map((c) => <td key={c.applicationId} className="small">{c.screen ? REC_LABEL[c.screen.recommendation] ?? c.screen.recommendation.replace(/_/g, " ") : <span className="muted">no screen yet</span>}</td>)}</tr>
        <tr><td className="small muted">Résumé</td>{cands.map((c) => <td key={c.applicationId} className="small">{c.resume ? overallLabel(c.resume.overall) : <span className="muted">not assessed yet</span>}</td>)}</tr>
        <tr><td className="small muted">Still unknown</td>{cands.map((c) => <td key={c.applicationId} className="small">{c.unknownCount}</td>)}</tr>
        <tr><td className="small muted">Their panel</td>{cands.map((c) => <td key={c.applicationId}><Link to={c.open} className="btn quiet sm">Open</Link></td>)}</tr>
      </Table>
      <p className="small muted" style={{ marginTop: 8 }}>{data.reminder}</p>
    </div>
  );
}

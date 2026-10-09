"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Alert, Avatar, Button, Card, Chip, EmptyState, ErrorState, Field, Icon, PageHeader, Pill, ScoreBadge, Sheet, Skeleton, StageButton, TabPanel, Tabs, type OwnerStage } from "@ros/ui";
import { CHOOSABLE_WORDINGS, DECISION_WORDING_LABEL, type DecisionWording } from "@ros/contracts";
import { api, ApiError, type ActionResult, type ApplicationSummary, type ApplicationsWithCounts, type BoardView, type DecisionMessagePreview, type DecisionMessagesResponse, type Me, type RoleSummary } from "../api/client";
import { toast } from "../toast";
import { messageOnItsWayChip } from "../company-check";
import { AskRecruiter } from "../components/AskRecruiter";
import { ShareJob } from "../components/ShareJob";
import { useCompanyCheck } from "../components/use-company-check";
import { LOW_CONFIDENCE_LABEL } from "../evidence";
import { focusLost, rowFocusAfterMove } from "../focus-after";
import { activeCompanyOf } from "../rail";
import { canDecline, canSeeTalent, canShareJob } from "../roles";
import { roleStatus } from "../role-status";
import { actionToast, batches, bulkSendToast, holdDay, mergeDecisionResults, noticeText, panelStepFrom, stageBlocked, stageIntent, type PanelStep } from "../talent-actions";
import { InlineUndo } from "../components/InlineUndo";
import { useBulkTakeBack, useBulkUndoToast } from "../components/use-undo";
import { waitingOnCandidateRow } from "../hiring";
import { WORDING_HINT, bulkUndoMillis, undoable } from "../telling";
import { ORDERS, READING, READING_FILTERS, STILL_APPLYING_LABEL, STILL_APPLYING_TEXT, appliedWhen, applyView, defaultView, emptyText, isStillApplying, readingCounts, readingOf, stillApplyingCount, stripItems, waitingOnYouCount, waitingText, type Order, type ReadingFilter, type TalentView } from "../talent-list";
import { CandidatePanel } from "./candidate-panel/CandidatePanel";
import { STAGE_LABEL, panelSearch, panelTabFrom, type PanelTab } from "./candidate-panel/helpers";
import type { ActionBody } from "./candidate-panel/hooks";
import { ComparePanel } from "./compare/ComparePanel";
import { AskPool } from "./board/AskPool";
import { PoolBoard, SortStrip } from "./board/PoolBoard";
import { ReviewApply } from "./board/ReviewApply";
import { boardOrder, boardSearch, modeFrom, type TalentMode } from "./board/board-model";

/** Where the candidate panel stands: who, which section, a step a stage choice opened, and the list it was opened from. */
type PanelState = { id: string; tab: PanelTab; step: PanelStep | null; roundKey?: string; ids: string[] | null; compose: boolean };

/** The link filters (`?ownerStage=`, `?stage=`, `?told=`, `?applying=`) as one key: when a link changes them, the view starts again from it. */
const linkKey = (p: URLSearchParams) => ["ownerStage", "stage", "told", "applying"].map((k) => p.get(k) ?? "").join("|");

/**
 * Talent (plan A3; founder decisions B3 and B6): one role's applicants as a calm list. The stage strip counts everyone
 * at each stage and filters by a click; each row has the person's initials, name, when they applied, how long they have
 * waited on you, the latest reading, the match score and the stage button. Readings only filter; the list can be sorted
 * by the match score (B2), newest, waiting longest or name. A row opens the candidate panel, whose place is kept in the
 * address (`?open=<id>&tab=…`).
 *
 * Beside the strip, "Still applying" (plan E6) counts the people still in the visit that sent their application (the
 * screening conversation offered with it, not finished yet) and shows only them on a click. They are never counted or
 * shown as waiting on you.
 *
 * The pool board (plan F6-F10; founder decisions B2, B4, B5): "Sort the pool" switches to the board (`?view=board`),
 * where the people who finished applying sit in Shortlist, Longlist and Not moving forward with the reason for each,
 * under a summary in plain words. "Review and apply" (`&review=1`, also Today's link) files the ticked people privately;
 * "Ask about this pool" opens the one-click questions. Nothing moves until a person applies it, and nobody is emailed.
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
  // Nobody still applying waits on you (plan E6), whatever their group says.
  const waitingCount = waitingOnYouCount(counts, rows);
  const applyingCount = stillApplyingCount(counts, rows);

  // The view: what a link asked for, otherwise "waiting on you" when anyone does; changed by the strip and the filters.
  const key = linkKey(search);
  const [viewState, setViewState] = useState<{ key: string; view: TalentView } | null>(null);
  const view = viewState?.key === key ? viewState.view : defaultView(search, counts ? { byGroup: { ...counts.byGroup, waiting_on_you: waitingCount } } : counts);
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
  const notTold = rows.filter((a) => a.toldState === "not_told" && !a.decisionMessageWaiting);
  const mayTell = canDecline(myRole);
  const [compareOpen, setCompareOpen] = useState(false);
  const [telling, setTelling] = useState(false);

  // The pool board (plan F6): its view and Review and apply live in the address, so Today's links open them. The board
  // sits under the applications' key, so every change that refreshes the list refreshes the board too.
  const mode = modeFrom(search);
  const goTo = (qs: string) => nav(`${window.location.pathname}${qs}`, { replace: true });
  const setMode = (next: TalentMode) => goTo(boardSearch(search, { mode: next }));
  const board = useQuery({ queryKey: ["applications", roleId, "board"], queryFn: () => api.get<BoardView>(`/api/v1/roles/${roleId}/board`), enabled: !!roleId && mode === "board" });
  const reviewing = mode === "board" && search.get("review") === "1";
  const [asking, setAsking] = useState(false);
  // "Show these on the board" from an answer: only those people, until the chip is pressed (or another role is chosen).
  const [onlyFor, setOnlyFor] = useState<{ roleId: string; ids: string[]; label: string } | null>(null);
  const only = onlyFor && onlyFor.roleId === roleId ? onlyFor : null;
  // Review and apply needs application.act: everyone who sees the applicants (an interviewer sees none).
  const mayApply = canSeeTalent(myRole);
  const boardIds = board.data ? boardOrder(board.data, only ? new Set(only.ids) : null) : [];
  const navIds = mode === "board" ? boardIds : shownIds;

  // The candidate panel, mirrored in the address with replace, so Back leaves the page as before.
  const openParam = search.get("open");
  // `step` and `round` open a step once (Today's "Yes, interview" opens the interview approval, filled in; plan H4).
  const fromLink = (): PanelState | null => (openParam ? { id: openParam, tab: search.get("message") === "1" ? "messages" : panelTabFrom(search.get("tab")), step: panelStepFrom(search.get("step")), roundKey: search.get("round") ?? undefined, ids: null, compose: search.get("message") === "1" } : null);
  const [panel, setPanel] = useState<PanelState | null>(fromLink);
  // A notification or a Today card followed while this page is open changes only the address: follow it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new `?open=` in the address re-reads it
  useEffect(() => { if (openParam && openParam !== panel?.id) setPanel(fromLink()); }, [openParam]);
  const showPanel = (next: PanelState | null) => {
    setPanel(next);
    nav(`${window.location.pathname}${panelSearch(search, next ? { open: next.id, tab: next.tab } : { open: null })}`, { replace: true });
  };
  // The panel steps through what is on screen: the list, or the board's columns left to right.
  const openPanel = (id: string, step: PanelStep | null = null) => showPanel({ id, tab: "overview", step, ids: navIds.includes(id) ? navIds : null, compose: false });
  // Opened from a link, the panel steps through the list or the board on screen when the person is in it.
  const panelIds = panel ? (panel.ids ?? (navIds.includes(panel.id) ? navIds : null)) : null;

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
  // A move from a row's stage button can take the row out of the view (the "New" tab, "Waiting on you"), and the stage
  // button that had the focus with it. Once the move has settled (the list is fetched again first), focus that was lost
  // goes to the person now in that place, or back to the same row's button when it is still listed.
  const listArea = useRef<HTMLDivElement>(null);
  const moved = useRef<{ id: string; index: number } | null>(null);
  const onRowMove = (a: ApplicationSummary, to: OwnerStage) => {
    const move = a.stageMoves.find((m) => m.to === to);
    if (!move) return;
    const intent = stageIntent(move);
    if (intent.kind === "action") { moved.current = { id: a.id, index: shownIds.indexOf(a.id) }; rowAct.mutate({ id: a.id, body: intent.body }); }
    else if (intent.kind === "step") openPanel(a.id, intent.step);
  };
  useEffect(() => {
    const m = moved.current;
    if (!m || rowAct.isPending) return;
    moved.current = null;
    if (!focusLost(document.activeElement, document.body)) return;
    const area = listArea.current;
    if (!area) return;
    const rowsNow = Array.from(area.querySelectorAll<HTMLElement>(".talent-row[data-application]"));
    const target = rowFocusAfterMove(rowsNow.map((r) => r.dataset.application ?? ""), m);
    const row = target ? rowsNow.find((r) => r.dataset.application === target.id) : null;
    const el = row && target ? row.querySelector<HTMLElement>(target.same ? ".menu-wrap > button" : ".talent-name") : area.querySelector<HTMLElement>('[role="tabpanel"]');
    el?.focus();
  }, [rowAct.isPending]);
  // Closing Review and apply after everyone was applied leaves its opener ("Review and apply N") disabled, so focus
  // cannot go back to it; the board's heading takes it instead.
  const closeReview = () => {
    goTo(boardSearch(search, { review: false }));
    requestAnimationFrame(() => { if (focusLost(document.activeElement, document.body)) document.getElementById("board-title")?.focus(); });
  };

  const status = role ? (role.status === "open" ? { label: "Live", tone: "good" as const } : roleStatus(role.status)) : null;
  const total = counts?.total ?? rows.length;
  const empty = emptyText(view, total);
  const filtersOn = view.reading !== "any" || view.query.trim() !== "" || view.waiting || view.applying || view.stage !== "all" || !!view.internalStage || !!view.told;
  const headline = [`${total} ${total === 1 ? "applicant" : "applicants"}`, waitingCount ? `${waitingCount} waiting on you` : "", applyingCount ? `${applyingCount} still applying` : ""].filter(Boolean).join(" · ");

  return (
    <div className="stack" style={{ gap: 18 }}>
      <PageHeader
        eyebrow={company.name ? `Job · ${company.name}` : "Job"}
        title={role?.title ?? "Talent"}
        status={status ? <Pill tone={status.tone} pulse={role?.status === "open"}>{status.label}</Pill> : undefined}
        sub={roleId && apps.data ? headline : undefined}
        actions={
          <>
            {roles.data && roles.data.length > 1 ? (
              <select className="select" style={{ width: "auto" }} value={roleId ?? ""} onChange={(e) => nav(`/roles/${e.target.value}/talent`)} aria-label="Role">
                {roles.data.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
              </select>
            ) : null}
            {/* On the board, "Compare these" and "Have a recruiter check this" sit in the board's own header. */}
            {roleId && mode === "list" && rows.length > 1 ? <Button variant={compareOpen ? "primary" : "secondary"} onClick={() => setCompareOpen((v) => !v)}>{compareOpen ? "Done comparing" : "Compare"}</Button> : null}
            {roleId && mode === "list" ? <AskRecruiter roleId={roleId} /> : null}
          </>
        }
      />
      {roleId && (total > 0 || mode === "board") ? <SortStrip mode={mode} onMode={setMode} onSort={() => (mode === "board" ? board.refetch() : setMode("board"))} sorting={board.isFetching} generatedAt={board.data?.generatedAt ?? null} /> : null}
      {!roleId ? (
        roles.isLoading ? <Skeleton lines={4} /> : <EmptyState icon="talent" title="No roles yet" body="Open a role first; its applicants show here." action={<Link to="/" className="btn primary">Go to Today</Link>} />
      ) : mode === "board" ? (
        board.isLoading ? <Skeleton lines={6} /> : board.error ? <ErrorState message="Could not sort the pool just now." onRetry={() => board.refetch()} /> : board.data ? (
          <PoolBoard roleId={roleId} board={board.data} only={only} onClearOnly={() => setOnlyFor(null)} onOpen={(id) => openPanel(id)} onReview={() => goTo(boardSearch(search, { review: true }))} onAsk={() => setAsking(true)} mayApply={mayApply} />
        ) : null
      ) : (
        <>
          <div className="talent-strip">
            <Tabs idBase="talent-strip" label="Stages" variant="counts" value={view.stage} onChange={(v) => setView({ stage: v as TalentView["stage"], waiting: false })} items={stripItems(counts)} />
            {/* Beside the strip, not in it (plan E6): the people still in the visit that sent their application. */}
            {applyingCount || view.applying ? <button type="button" className="toggle-chip" aria-pressed={view.applying} title="Sent the form and answering the screening questions now" onClick={() => setView({ applying: !view.applying, waiting: false })}>{STILL_APPLYING_LABEL} <span className="count">{applyingCount}</span></button> : null}
          </div>
          <div className="talent-toolbar">
            {waitingCount ? <button type="button" className="toggle-chip" aria-pressed={view.waiting} onClick={() => setView({ waiting: !view.waiting, applying: false, order: view.waiting ? view.order : "waiting" })}>Waiting on you <span className="count">{waitingCount}</span></button> : null}
            {mayTell && (counts?.notTold ?? 0) > 0 ? <button type="button" className="toggle-chip" aria-pressed={view.told === "not_told"} onClick={() => setView(view.told === "not_told" ? { told: null } : { told: "not_told", stage: "not_moving_forward", waiting: false, applying: false })}>Not told yet <span className="count">{counts?.notTold}</span></button> : null}
            {view.internalStage ? <button type="button" className="toggle-chip" aria-pressed="true" aria-label={`Showing only: ${STAGE_LABEL[view.internalStage] ?? view.internalStage}. Remove this filter`} onClick={clearStageLink}>{STAGE_LABEL[view.internalStage] ?? view.internalStage.replace(/_/g, " ")} <Icon name="x" size={14} /></button> : null}
            <select className="select" aria-label="Reading" value={view.reading} onChange={(e) => setView({ reading: e.target.value as ReadingFilter })}>
              {READING_FILTERS.filter((f) => f.id !== "missing_must_have" || provenMissKnown).map((f) => <option key={f.id} value={f.id}>{f.label}{f.id === "any" ? "" : ` (${byReading[f.id]})`}</option>)}
            </select>
            <input className="input talent-search" type="search" value={view.query} onChange={(e) => setView({ query: e.target.value })} placeholder="Search name, email or source" aria-label="Search applicants" />
            <select className="select" aria-label="Sort by" value={view.order} onChange={(e) => setView({ order: e.target.value as Order })}>
              {ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          {view.applying ? <Alert tone="info">{STILL_APPLYING_TEXT}</Alert> : null}
          {mayTell && notTold.length && (view.told === "not_told" || view.stage === "not_moving_forward") ? (
            <Alert tone="info">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{notTold.length === 1 ? "1 person has" : `${notTold.length} people have`} not been told your decision. Decisions stay private until someone sends the decision message or records telling them.</span>
                <Button size="sm" variant="primary" icon="send" onClick={() => setTelling(true)}>Review and send</Button>
              </div>
            </Alert>
          ) : null}
          {compareOpen ? <ComparePanel roleId={roleId} candidates={shown.map((a) => ({ id: a.id, name: a.candidate?.name ?? "Unknown", stageLabel: a.ownerStageLabel, score: a.score }))} /> : null}
          <div ref={listArea}>
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
          </div>
        </>
      )}
      {/* The candidate panel comes last, so a name opened from Review and apply or from an answer sits on top of them. */}
      {reviewing && roleId && board.data ? <ReviewApply roleId={roleId} board={board.data} mayDecline={mayTell} onClose={closeReview} onOpen={(id) => openPanel(id)} /> : null}
      {asking && roleId && board.data ? <AskPool roleId={roleId} board={board.data} onClose={() => setAsking(false)} onOpen={(id) => openPanel(id)} onShow={(ids, label) => { setOnlyFor({ roleId, ids, label }); setAsking(false); }} /> : null}
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

/** One applicant: initials, name, when they applied, the wait, the reading, the match score (B2), the stage button. */
function TalentRow({ a, busy, onOpen, onMove }: { a: ApplicationSummary; busy: boolean; onOpen: () => void; onMove: (to: OwnerStage) => void }) {
  const name = a.candidate?.name ?? "Unknown";
  const reading = readingOf(a);
  // waiting on you, or (an offer made outside the app, plan H2) waiting on the candidate's answer
  const waiting = waitingText(a) ?? waitingOnCandidateRow(a);
  // A decision message in the outbox of a company ITS has not confirmed yet waits for the check (founder decision B7).
  const check = useCompanyCheck();
  return (
    <div className="talent-row" data-application={a.id}>
      <Avatar name={name} />
      <div className="talent-row-main">
        <button type="button" className="talent-name" onClick={onOpen}>{name}</button>
        <span className="talent-row-sub">
          <span>{appliedWhen(a.appliedAt ?? a.createdAt)}</span>
          <span>{a.source.replace(/_/g, " ")}</span>
          {waiting ? <span className="waiting">{waiting}</span> : null}
          {a.mark?.mark === "on_hold" && a.mark.remindAt && !a.tags.includes("Hold ended") ? <span>On hold until {holdDay(a.mark.remindAt)}</span> : null}
          {/* a reading made against an earlier version of the role (plan F4): its score uses the requirements as they were then */}
          {a.readingVersion ? <span title={a.readingVersion.label}>Read against version {a.readingVersion.readAgainst}</span> : null}
        </span>
      </div>
      <div className="talent-row-chips">
        {/* answering the screening questions in the visit that sent the application (plan E6): nothing waits on you yet */}
        {isStillApplying(a) ? <Pill size="sm" tone="neutral" pulse title="Sent the form and answering the screening questions now">{STILL_APPLYING_LABEL}</Pill> : null}
        {reading !== "none" ? <Pill size="sm" tone={READING[reading].tone}>{READING[reading].label}</Pill> : null}
        {a.evidence?.lowConfidence && reading !== "closer_look" ? <Chip tone="caution">{LOW_CONFIDENCE_LABEL}</Chip> : null}
        {a.tags.map((t) => <Chip key={t} tone="caution">{t}</Chip>)}
        {a.toldState === "not_told" ? <Chip>{a.decisionMessageWaiting ? "Message waiting for approval" : "Not told yet"}</Chip> : null}
        {a.toldState === "queued" ? <Chip>{messageOnItsWayChip(check)}</Chip> : null}
      </div>
      {/* the match score, worked out by code from the checked findings (founder decision B2); an older answer has none */}
      <span className="score-slot" title={a.coverage?.words}>{a.score !== undefined ? <ScoreBadge score={a.score} size="sm" /> : null}</span>
      <StageButton stage={a.ownerStage} label={a.ownerStageLabel} blocked={stageBlocked(a.stageMoves)} disabled={busy} onMove={onMove} align="end" />
    </div>
  );
}

/** The wordings a person may choose for several people at once (Q28): each person's suggested one, or one approved wording for all. */
const BULK_WORDINGS: ReadonlyArray<DecisionWording> = CHOOSABLE_WORDINGS;

/**
 * "Not told yet" for several people at once (founder decisions B6 and Q28): one approved wording for all of them, or each
 * person's suggested one, the message shown first, each person ticked by default, then one Send that sends to each of
 * them separately, with every person's own result and "Undo all" while the messages wait out the Undo window (plan G9).
 * A personal line is written on each person's own page.
 */
function TellSheet({ roleId, people, onClose }: { roleId: string; people: ApplicationSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const bulkUndo = useBulkUndoToast();
  const bulkTakeBack = useBulkTakeBack();
  const [picked, setPicked] = useState<string[]>(people.map((p) => p.id));
  const [wording, setWording] = useState<DecisionWording | "each">("each");
  const [results, setResults] = useState<DecisionMessagesResponse | null>(null);
  // The messages of this Send still waiting out their Undo window, and when the first of them leaves: "Undo all" is in
  // the sheet as well as on the toast, which the keyboard cannot reach while the sheet is open.
  const [waiting, setWaiting] = useState<{ items: Array<{ applicationId: string; communicationId: string }>; until: string } | null>(null);
  const sample = picked[0] ?? null;
  const preview = useQuery({
    queryKey: ["decision-message", sample, wording],
    queryFn: () => (wording === "each" ? api.get<DecisionMessagePreview>(`/api/v1/applications/${sample}/decision-message`) : api.post<DecisionMessagePreview>(`/api/v1/applications/${sample}/decision-message/preview`, { wording })),
    enabled: !!sample && !results,
    retry: false,
  });
  const send = useMutation({
    // in requests of at most a hundred people each, one after the other, so a long list after a role close goes out whole
    mutationFn: async () => {
      const parts: DecisionMessagesResponse[] = [];
      for (const ids of batches(picked)) parts.push(await api.post<DecisionMessagesResponse>(`/api/v1/roles/${roleId}/decision-messages`, { applicationIds: ids, ...(wording === "each" ? {} : { wording }) }));
      return mergeDecisionResults(parts);
    },
    onSuccess: async (r) => {
      setResults(r);
      const t = bulkSendToast(r);
      const items = undoable(r.results);
      const ms = bulkUndoMillis(r.results);
      bulkUndo({ roleId, items, ms, title: t.title, detail: items.length ? [t.detail, "Undo all takes back every message still waiting."].filter(Boolean).join(" ") : t.detail });
      setWaiting(items.length && ms > 0 ? { items, until: new Date(Date.now() + ms).toISOString() } : null);
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
          <div className="row">
            {waiting ? <InlineUndo autoFocus label="Undo all" ariaLabel={`Undo all: take back the ${waiting.items.length === 1 ? "message" : `${waiting.items.length} messages`} still waiting`} undoUntil={waiting.until} onUndo={async () => { await bulkTakeBack(roleId, waiting.items); setWaiting(null); }} /> : null}
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>Each person gets the decision message on its own, with their own name. Untick anyone you would rather tell yourself. To add a personal line, send from that person's own page.</p>
          <Field label="Wording" htmlFor="bulk-wording" hint={wording === "each" ? "Each person gets the wording that fits their decision: after an interview, position filled, or the standard one." : WORDING_HINT[wording]}>
            <select id="bulk-wording" className="select" value={wording} onChange={(e) => setWording(e.target.value as DecisionWording | "each")}>
              <option value="each">The suggested wording for each person</option>
              {BULK_WORDINGS.map((w) => <option key={w} value={w}>{DECISION_WORDING_LABEL[w]} for everyone</option>)}
            </select>
          </Field>
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
                <p className="small muted" style={{ marginTop: 8 }}>People declined on an eligibility answer always get the version about their answers.</p>
              </Card>
            ) : preview.error instanceof ApiError && preview.error.code === "wording_not_allowed" ? (
              <Alert tone="info">{nameOf(sample)} gets the wording for their own decision instead: {preview.error.message}</Alert>
            ) : <ErrorState message="Could not load the message." onRetry={() => preview.refetch()} />
          ) : null}
          {policy === "not_sent" ? <Alert tone="caution">Under your settings no decision messages are sent. Tell each person yourself, then record it on their page.</Alert> : null}
          {policy === "needs_approval" ? <p className="small muted" style={{ margin: 0 }}>Under your settings each message waits for approval before it goes out.</p> : null}
          {policy === "sends" && preview.data?.undoSeconds ? <p className="small muted" style={{ margin: 0 }}>Each message waits {preview.data.undoSeconds} seconds before it goes, so you can undo the Send.</p> : null}
          <Button variant="primary" icon="send" disabled={!picked.length || policy === "not_sent"} loading={send.isPending} onClick={() => send.mutate()}>{policy === "needs_approval" ? `Send ${picked.length} for approval` : `Send to ${picked.length} ${picked.length === 1 ? "person" : "people"}`}</Button>
        </div>
      )}
    </Sheet>
  );
}

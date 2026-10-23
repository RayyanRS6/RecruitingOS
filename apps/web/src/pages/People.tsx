"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "../nav";
import { Alert, Avatar, Button, Card, EmptyState, ErrorState, Field, Icon, Menu, Pill, ScoreBadge, Sheet, Skeleton, StageButton, TabPanel, Tabs, type OwnerStage } from "@ros/ui";
import { CHOOSABLE_WORDINGS, DECISION_WORDING_LABEL, type DecisionWording } from "@ros/contracts";
import { api, ApiError, type ActionResult, type ApplicationSummary, type ApplicationsWithCounts, type BoardView, type DecisionMessagePreview, type DecisionMessagesResponse, type Me, type NewTimesSettingView, type RoleDetail, type RoleSummary, type SendNewTimesBatchResult } from "../api/client";
import { toast } from "../toast";
import { NEW_TIMES_SHEET_TEXT, cancelledAlertText, cancelledChips, mergeNewTimesResults, newTimesResultLine, newTimesSendLabel, newTimesSheetRows } from "../cancelled";
import { messageOnItsWayChip } from "../company-check";
import { AskRecruiter } from "../components/AskRecruiter";
import { CloseRoleCard, ClosingMessageCard } from "../components/ClosingMessage";
import { ShareJob } from "../components/ShareJob";
import { useCompanyCheck } from "../components/use-company-check";
import { useIsClient } from "../components/use-is-client";
import { LOW_CONFIDENCE_LABEL } from "../evidence";
import { focusLost, rowFocusAfterMove } from "../focus-after";
import { activeCompanyOf } from "../rail";
import { canDecline, canManageInterviews, canSeeTalent, canShareJob, canTryWeights } from "../roles";
import { jobTabs, roleStatus } from "../role-status";
import { actionToast, batches, bulkSendToast, holdDay, mergeDecisionResults, newTimesToast, noticeText, panelStepFrom, stageBlocked, stageIntent, type PanelStep } from "../talent-actions";
import { InlineUndo } from "../components/InlineUndo";
import { useBulkTakeBack, useBulkUndoToast } from "../components/use-undo";
import { waitingOnCandidateRow } from "../hiring";
import { bulkUndoMillis, undoable } from "../telling";
import { AI_INTERVIEW_CHIPS, ORDERS, READING_FILTERS, ROW_CHIP_LIMIT, SAFETY_NET_NOTE, aiInterviewAlert, aiInterviewCounts, appliedWhen, applyView, defaultView, emptyText, readingCounts, resumeOnlyChip, rowChips, scoreTitle, stripParts, waitingOnYouCount, waitingText, type Order, type ReadingFilter, type RowChip, type TalentView } from "../talent-list";
import { CandidatePanel } from "./candidate-panel/CandidatePanel";
import { STAGE_LABEL, panelSearch, panelTabFrom, type PanelTab } from "./candidate-panel/helpers";
import type { ActionBody } from "./candidate-panel/hooks";
import { ComparePanel } from "./compare/ComparePanel";
import { AskPool } from "./board/AskPool";
import { PoolBoard, SortStrip } from "./board/PoolBoard";
import { ReviewApply } from "./board/ReviewApply";
import { boardOrder, boardSearch, modeFrom, type TalentMode } from "./board/board-model";
import { JobHeader, JobMenu, JobTabs, jobFactsFor } from "./JobHeader";
import { NotOnThisJob, notOnThisJob } from "./RoleDetail";
import { WeightsPreview } from "./role/WeightsPreview";
import { CandidatePreview } from "./new-role/CandidatePreview";
import { RoomAlert } from "./new-role/StartView";
import { useStartDraft } from "./new-role/use-start-draft";

/** Where the candidate panel stands: who, which section, a step a stage choice opened, and the list it was opened from. */
type PanelState = { id: string; tab: PanelTab; step: PanelStep | null; roundKey?: string; ids: string[] | null; compose: boolean };

/** The filters a link can set: `?ownerStage=`, `?stage=`, `?told=`, `?applying=` (older links), `?cancelled=`, `?aiInterview=`. */
const LINK_FILTERS = ["ownerStage", "stage", "told", "applying", "cancelled", "aiInterview"] as const;
/** The link filters as one key: when a link changes them, the view starts again from it. */
const linkKey = (p: URLSearchParams) => LINK_FILTERS.map((k) => p.get(k) ?? "").join("|");

/** One filter in force, shown as a removable chip above the list. */
type ActiveFilter = { id: string; label: string; remove: () => void };

/** The words of a Match choice, as its dropdown chip shows them. */
const readingLabel = (id: ReadingFilter) => READING_FILTERS.find((f) => f.id === id)?.label ?? READING_FILTERS[0].label;

/**
 * What an empty list says when the filters in force leave nobody (Wave S6): the title alone, since "Clear filters" sits
 * under it and each filter's chip above removes it (founder, 23 Oct 2026: no line repeating them).
 */
const NO_MATCH: { title: string; body?: string } = { title: "Nothing matches these filters" };

/** The page: the job's header (its own bottom margin trimmed to `mb-1`, as on the job page), then each part 20px apart. */
const PAGE = "stack gap-5";
/** Each person's result after a send, one line each. */
const RESULTS = "grid list-disc gap-1.5 ps-5 text-[14px] leading-snug marker:text-ink-3";
/** A group of ticks' heading, above the rows. */
const LEGEND = "mb-2 text-[13px] font-semibold text-ink";

/**
 * Candidates (plan A3; founder decisions B3 and B6; Wave S1): one job's applicants as a calm list, under the job's own
 * header and tab strip (shared with the job page). The stage strip counts everyone at each stage and filters by a
 * click; the stages nobody is at wait under "More stages". Each row has the person's initials, name, when they
 * applied, how long they have waited on you, at most two chips, the match score and the stage button. A row opens the
 * candidate panel, whose place is kept in the address (`?open=<id>&tab=…`).
 *
 * Above the list (Wave S6, as on Kanvis): Match, the order and the job switcher are dropdown chips with the choice in
 * force ticked; every filter in force shows as a chip that removes it, with "Clear all"; a list the filters leave empty
 * says "Nothing matches these filters" with one "Clear filters".
 *
 * "No AI interview yet" (20 Oct 2026, R20-7; it replaced plan E6's "Still applying" toggle) is the strip's first column:
 * everyone from applying until they send the AI interview, also when its link lapsed or they stopped part-way. Its chips
 * split it into not started, started, asked for a person and link closed (`?aiInterview=`), each row says where they
 * stand, and an info line says nothing there waits on you. They are never counted or shown as waiting on you.
 *
 * Cancelled (founder decisions 1A to 4A) holds the candidates who cancelled a booked interview and the ones who did not
 * come to one. Its chips split it by what each person chose ("Asked for new times", "No longer interested", "No-show"),
 * each row says where their new times stand, and "Send new times…" sends them to several people at once.
 *
 * The pool board (plan F6-F10; founder decisions B2, B4, B5): "Sort the pool" switches to the board (`?view=board`),
 * where the people who finished applying sit in Shortlist, Longlist and Not moving forward with the reason for each,
 * under a summary in plain words. "Review and apply" (`&review=1`, also Home's link) files the ticked people privately;
 * "Ask about this pool" opens the one-click questions. Nothing moves until a person applies it, and nobody is emailed.
 *
 * The header's More menu: Compare, and what the job page offers (pause, the accepting switch, close, the closing
 * message, hire again, Candidate view) right here; Edit opens the job page's editor.
 */
export function People() {
  const params = useParams();
  const nav = useNavigate();
  const [search] = useSearchParams();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleSummary[]>("/api/v1/roles") });
  // The jobs list is the rail's too (one request, shared), so the browser may hold it before it takes this page over;
  // the server never does. Until the page is the browser's (use-is-client.ts) the list counts as not read yet, so the
  // first draw is the server's ("Candidates", no job picker) and the job's own title follows, as it always did.
  const isClient = useIsClient();
  const jobList = isClient ? roles.data : undefined;
  const jobListLoading = !isClient || roles.isLoading;
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<Me>("/api/v1/auth/me") });
  const company = activeCompanyOf(me.data);
  const myRole = company.role ?? (me.data?.staffAccess ? "recruiter" : null);
  const roleId = params.id ?? jobList?.find((r) => r.status === "open")?.id ?? jobList?.[0]?.id;
  const role = jobList?.find((r) => r.id === roleId);
  // The job itself, for the header's More menu (its accepting switch, its version for Candidate view).
  // A refusal (a job an interviewer is not on) is an answer, not a hiccup: it is not asked again.
  const detail = useQuery({ queryKey: ["role", roleId], queryFn: () => api.get<RoleDetail>(`/api/v1/roles/${roleId}`), enabled: !!roleId, retry: (count, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && count < 1 });
  // An interviewer reads no applicants (they see the people they interview under Interviews), so the list is not asked for.
  const interviewer = myRole === "interviewer";
  const apps = useQuery({ queryKey: ["applications", roleId], queryFn: () => api.get<ApplicationsWithCounts>(`/api/v1/roles/${roleId}/applications?counts=1`), enabled: !!roleId && !interviewer });
  const rows = apps.data?.applications ?? [];
  const counts = apps.data?.counts;
  // Nobody under "No AI interview yet" waits on you (R20-7), whatever their group says.
  const waitingCount = waitingOnYouCount(counts, rows);
  const noInterviewCount = counts?.byOwnerStage.no_ai_interview ?? rows.filter((a) => a.ownerStage === "no_ai_interview").length;
  const aiCounts = aiInterviewCounts(counts, rows);

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
  // The Cancelled column (founder decisions 1A to 4A): its reasons as chips, and new times to many people at once for
  // those who may manage interviews. The alert's wording follows the company's setting.
  const underCancelled = rows.filter((a) => a.ownerStage === "cancelled" && a.cancelled);
  const cancelledCount = counts?.byOwnerStage.cancelled ?? underCancelled.length;
  const mayManageInterviews = canManageInterviews(myRole);
  const newTimesSetting = useQuery({ queryKey: ["new-times-setting"], queryFn: () => api.get<NewTimesSettingView>("/api/v1/companies/current/new-times"), enabled: mayManageInterviews && view.stage === "cancelled" });
  const [sendingNewTimes, setSendingNewTimes] = useState(false);
  // What the header's More menu opens on this page: the close card, the closing message, the job page as candidates see it.
  const [closing, setClosing] = useState(false);
  const [closingMessage, setClosingMessage] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // "Try different weights" (founder decision L-07 A): a preview that saves nothing; its "Use these weights" opens the editor on the job page.
  const [weightsOpen, setWeightsOpen] = useState(false);
  const again = useStartDraft();

  // The pool board (plan F6): its view and Review and apply live in the address, so Home's links open them. The board
  // sits under the applications' key, so every change that refreshes the list refreshes the board too.
  const mode = modeFrom(search);
  const goTo = (qs: string) => nav(`${window.location.pathname}${qs}`, { replace: true });
  const setMode = (next: TalentMode) => goTo(boardSearch(search, { mode: next }));
  const board = useQuery({ queryKey: ["applications", roleId, "board"], queryFn: () => api.get<BoardView>(`/api/v1/roles/${roleId}/board`), enabled: !!roleId && mode === "board" && !interviewer });
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
  // `step` and `round` open a step once (Home's "Yes, interview" opens the interview approval, filled in; plan H4).
  const fromLink = (): PanelState | null => (openParam ? { id: openParam, tab: search.get("message") === "1" ? "messages" : panelTabFrom(search.get("tab")), step: panelStepFrom(search.get("step")), roundKey: search.get("round") ?? undefined, ids: null, compose: search.get("message") === "1" } : null);
  const [panel, setPanel] = useState<PanelState | null>(fromLink);
  // A notification or a Home card followed while this page is open changes only the address: follow it.
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

  const total = counts?.total ?? rows.length;
  const headline = [`${total} ${total === 1 ? "applicant" : "applicants"}`, waitingCount ? `${waitingCount} waiting on you` : "", noInterviewCount ? `${noInterviewCount} without an AI interview yet` : ""].filter(Boolean).join(" · ");
  const strip = stripParts(counts, view.stage);
  const pickStage = (stage: TalentView["stage"]) => setView({ stage, waiting: false, cancelledReason: null, aiInterview: null });
  // Every filter that narrows the list, as a removable chip above it (Wave S6, as on Kanvis), so a short list always
  // says why. The order is not a filter and stays.
  const activeFilters: ActiveFilter[] = [];
  if (view.stage !== "all") activeFilters.push({ id: "stage", label: `Stage: ${[...strip.shown, ...strip.more].find((s) => s.id === view.stage)?.label ?? view.stage}`, remove: () => setView({ stage: "all", cancelledReason: null, aiInterview: null }) });
  if (view.cancelledReason) activeFilters.push({ id: "cancelled", label: cancelledChips(counts?.cancelled, rows).find((c) => c.id === view.cancelledReason)?.label ?? view.cancelledReason, remove: () => setView({ cancelledReason: null }) });
  if (view.waiting) activeFilters.push({ id: "waiting", label: "Waiting on you", remove: () => setView({ waiting: false }) });
  if (view.aiInterview) activeFilters.push({ id: "ai-interview", label: AI_INTERVIEW_CHIPS.find((c) => c.id === view.aiInterview)?.label ?? view.aiInterview, remove: () => setView({ aiInterview: null }) });
  if (view.told) activeFilters.push({ id: "told", label: "Not told yet", remove: () => setView({ told: null }) });
  if (view.internalStage) activeFilters.push({ id: "internal-stage", label: `Only: ${STAGE_LABEL[view.internalStage] ?? view.internalStage.replace(/_/g, " ")}`, remove: clearStageLink });
  if (view.reading !== "any") activeFilters.push({ id: "reading", label: readingLabel(view.reading), remove: () => setView({ reading: "any" }) });
  if (view.query.trim()) activeFilters.push({ id: "query", label: `Search: ${view.query.trim()}`, remove: () => setView({ query: "" }) });
  const filtersOn = activeFilters.length > 0;
  /** Every filter off, the order kept; the link's filters leave the address too, so a reload does not bring them back. */
  const clearFilters = () => {
    const next = new URLSearchParams(search);
    for (const k of LINK_FILTERS) next.delete(k);
    setViewState({ key: linkKey(next), view: { ...defaultView(next, null), order: view.order } });
    const qs = next.toString();
    if (qs !== search.toString()) nav(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  // When filters leave nobody and no closer reason fits, emptyText's plain answer ("Nobody here") becomes the one
  // no-match state, with "Clear filters" under it.
  const said = emptyText(view, total);
  const empty = filtersOn && total > 0 && said.title === "Nobody here" ? NO_MATCH : said;
  const job = detail.data ?? null;
  const status = job?.status ?? role?.status ?? null;
  // The shared header's one line (place · type · pay), as on the job's other tabs; the counts are also on the Candidates
  // tab, "Waiting on you" and the "No AI interview yet" column. Until the job's details are read (or when it has none), the counts stand
  // in, so the line is never empty and nothing jumps when the details arrive.
  const facts = job ? jobFactsFor(job) : null;
  const sub = !roleId ? undefined : facts ?? (apps.data ? headline : undefined);
  // Only with someone to put in order, and never on an ITS grant about one candidate (roles.ts canTryWeights).
  const mayTryWeights = canTryWeights(myRole, me.data?.staffAccess?.scope) && !!job?.currentPacket && total > 0;

  // An interviewer: a job they are not on says so; on their own job, where the people they interview are.
  if (interviewer && roleId) {
    if (notOnThisJob(detail.error, myRole)) return <NotOnThisJob />;
    return (
      <div className={PAGE}>
        <JobHeader title={role?.title ?? job?.title ?? "Candidates"} status={status} pulse={status === "open"} sub={facts ?? undefined} className="mb-1" />
        <NotOnThisJob title="Candidates are for the hiring team" body="You see the people you interview under Interviews." />
      </div>
    );
  }

  return (
    <div className={PAGE}>
      <JobHeader
        title={role?.title ?? job?.title ?? "Candidates"}
        status={status}
        pulse={status === "open"}
        sub={sub}
        className="mb-1"
        actions={
          <>
            {/* Another job's candidates: a dropdown with this job ticked and each job's status beside its title (Wave S6). */}
            {jobList && jobList.length > 1 ? (
              <Menu
                label="Switch job"
                heading="Jobs"
                currentLabel="Showing"
                align="end"
                items={jobList.map((r) => ({ id: r.id, label: r.title, hint: roleStatus(r.status).label, current: r.id === roleId }))}
                onSelect={(id) => nav(`/roles/${id}/talent`)}
              />
            ) : null}
            {/* On the board, "Have a recruiter check this" sits in the board's own header. */}
            {roleId && mode === "list" ? <AskRecruiter roleId={roleId} /> : null}
            {roleId && status ? (
              <JobMenu
                roleId={roleId}
                role={job}
                status={status}
                myRole={myRole}
                // On the board, "Compare these" is one of the pool's questions.
                comparing={mode === "list" && rows.length > 1 ? compareOpen : null}
                closingMessageOpen={closingMessage || closing}
                on={{
                  compare: () => setCompareOpen((v) => !v),
                  edit: () => nav(`/roles/${roleId}?edit=1`),
                  preview: () => setPreviewOpen(true),
                  weights: mayTryWeights ? () => setWeightsOpen(true) : undefined,
                  close: () => setClosing(true),
                  "closing-message": () => setClosingMessage(true),
                  "hire-again": () => again.hireAgain(roleId),
                }}
              />
            ) : null}
          </>
        }
      />
      {roleId ? <JobTabs roleId={roleId} current="candidates" items={jobTabs({ seesCandidates: true, candidates: apps.data ? total : null })} /> : null}
      {again.limit?.room && !again.limit.room.ok ? <RoomAlert room={again.limit.room} ask={again.limit.ask} /> : null}
      {again.problem ? <Alert tone="critical">{again.problem}</Alert> : null}
      {/* Closing lists who is still in process, then shows the one closing message for them all (founder decision Q30). */}
      {closing && roleId ? <CloseRoleCard roleId={roleId} initialOutcome="filled_outside_platform" mayTell={mayTell} onClose={() => setClosing(false)} /> : null}
      {closingMessage && !closing && roleId && status === "closed" && mayTell ? <ClosingMessageCard roleId={roleId} onDone={() => setClosingMessage(false)} /> : null}
      {roleId && (total > 0 || mode === "board") ? <SortStrip mode={mode} onMode={setMode} onSort={() => (mode === "board" ? board.refetch() : setMode("board"))} sorting={board.isFetching} generatedAt={board.data?.generatedAt ?? null} /> : null}
      {!roleId ? (
        jobListLoading ? <Skeleton lines={4} /> : <EmptyState icon="talent" title="No jobs yet" body="Open a job first; its candidates show here." action={<Link to="/" className="btn primary">Go to Home</Link>} />
      ) : mode === "board" ? (
        board.isLoading ? <Skeleton lines={6} /> : board.error ? <ErrorState message="Could not sort the pool just now." onRetry={() => board.refetch()} /> : board.data ? (
          <PoolBoard roleId={roleId} board={board.data} only={only} onClearOnly={() => setOnlyFor(null)} onOpen={(id) => openPanel(id)} onReview={() => goTo(boardSearch(search, { review: true }))} onAsk={() => setAsking(true)} mayApply={mayApply} />
        ) : null
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
          {/* The stage strip: the kit's counts tabs (each count above its word), the empty stages one click away at its end.
              The column may shrink below the strip's width so the strip scrolls sideways instead of widening the page. */}
          <div className="talent-strip flex items-center gap-2 shadow-[inset_0_-1px_0_var(--line)] [&>.tabs]:min-w-0 [&>.tabs]:flex-1">
            <Tabs idBase="talent-strip" label="Stages" variant="counts" value={view.stage} onChange={(v) => pickStage(v as TalentView["stage"])} items={strip.shown} />
            {/* The stages nobody is at, one click away with their counts (Wave S1). */}
            {/* A stage picked here moves onto the strip (and "More stages" may go): focus follows it to its tab. */}
            {strip.more.length ? <Menu label="More stages" ariaLabel="More stages" heading="Stages with nobody in them" items={strip.more.map((s) => ({ id: s.id, label: s.label, hint: String(s.count) }))} onSelect={(id) => { pickStage(id as TalentView["stage"]); requestAnimationFrame(() => document.getElementById(`talent-strip-tab-${id}`)?.focus()); }} /> : null}
          </div>
          {/* The filters as pills, the search as a rounded field, Match and the order as dropdown pills on the right. */}
          <div className="flex flex-wrap items-center gap-2">
            {waitingCount ? <button type="button" className="toggle-chip" aria-pressed={view.waiting} onClick={() => setView({ waiting: !view.waiting, order: view.waiting ? view.order : "waiting" })}>Waiting on you <span className="count">{waitingCount}</span></button> : null}
            {mayTell && (counts?.notTold ?? 0) > 0 ? <button type="button" className="toggle-chip" aria-pressed={view.told === "not_told"} onClick={() => setView(view.told === "not_told" ? { told: null } : { told: "not_told", stage: "not_moving_forward", waiting: false, cancelledReason: null, aiInterview: null })}>Not told yet <span className="count">{counts?.notTold}</span></button> : null}
            {/* under Cancelled: what each person chose, or that they did not come (founder decision 2A) */}
            {/* under "No AI interview yet": where people stand with it (R20-7), never how far anyone got */}
            {view.stage === "no_ai_interview" ? AI_INTERVIEW_CHIPS.map((c) => <button key={c.id} type="button" className="toggle-chip" aria-pressed={view.aiInterview === c.id} onClick={() => setView({ aiInterview: view.aiInterview === c.id ? null : c.id })}>{c.label} <span className="count">{aiCounts[c.id]}</span></button>) : null}
            {view.stage === "cancelled" ? cancelledChips(counts?.cancelled, rows).map((c) => <button key={c.id} type="button" className="toggle-chip" aria-pressed={view.cancelledReason === c.id} onClick={() => setView({ cancelledReason: view.cancelledReason === c.id ? null : c.id })}>{c.label} <span className="count">{c.count}</span></button>) : null}
            <div className="relative min-w-0 flex-[1_1_14rem] sm:max-w-xs">
              <Icon name="search" size={16} className="pointer-events-none absolute start-3.5 top-1/2 -translate-y-1/2 text-ink-3" />
              <input className="input min-h-9 rounded-full py-1.5 ps-10 text-[14px] pointer-coarse:min-h-10" type="search" value={view.query} onChange={(e) => setView({ query: e.target.value })} placeholder="Search name, email or source" aria-label="Search candidates" />
            </div>
            {/* Match and the order as dropdown chips (Wave S6): the choice in force is written on the chip and ticked in its list. */}
            <div className="flex flex-wrap items-center gap-2 sm:ms-auto">
              <Menu
                label={`Match: ${readingLabel(view.reading)}`}
                heading="Match"
                buttonClassName="toggle-chip"
                currentLabel="Now"
                align="end"
                items={READING_FILTERS.filter((f) => f.id !== "missing_must_have" || provenMissKnown).map((f) => ({ id: f.id, label: f.id === "any" ? f.label : `${f.label} (${byReading[f.id]})`, current: f.id === view.reading }))}
                onSelect={(id) => setView({ reading: id as ReadingFilter })}
              />
              <Menu
                label={`Sort: ${ORDERS.find((o) => o.id === view.order)?.label ?? ORDERS[0].label}`}
                heading="Sort by"
                buttonClassName="toggle-chip"
                currentLabel="Now"
                align="end"
                items={ORDERS.map((o) => ({ id: o.id, label: o.label, current: o.id === view.order }))}
                onSelect={(id) => setView({ order: id as Order })}
              />
            </div>
          </div>
          {/* What narrows the list, each removable, and one way to clear them all (Wave S6, as on Kanvis). */}
          {activeFilters.length ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="small muted" id="talent-filters-on">Filters on</span>
              <ul className="own-items flex min-w-0 flex-wrap items-center gap-2 [&>li]:max-w-full [&_.toggle-chip]:max-w-full [&_.toggle-chip]:whitespace-normal [&_.toggle-chip]:text-left" aria-labelledby="talent-filters-on">
                {activeFilters.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="toggle-chip" onClick={f.remove}>
                      <span className="sr-only">Remove the filter: </span>
                      {f.label}
                      <Icon name="x" size={14} />
                    </button>
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" onClick={clearFilters}>Clear all</Button>
            </div>
          ) : null}
          {view.stage === "no_ai_interview" && noInterviewCount > 0 ? <Alert tone="info">{aiInterviewAlert(aiCounts)}</Alert> : null}
          {mayTell && notTold.length && (view.told === "not_told" || view.stage === "not_moving_forward") ? (
            <Alert tone="info">
              <div className="row justify-between">
                <span>{notTold.length === 1 ? "1 person has" : `${notTold.length} people have`} not been told your decision. {SAFETY_NET_NOTE}</span>
                <Button size="sm" variant="primary" icon="send" onClick={() => setTelling(true)}>Review and send</Button>
              </div>
            </Alert>
          ) : null}
          {mayManageInterviews && view.stage === "cancelled" && cancelledCount > 0 ? (
            <Alert tone="info">
              <div className="row justify-between">
                <span>{cancelledAlertText(cancelledCount, newTimesSetting.data?.auto, newTimesSetting.data?.companyConfirmed)}</span>
                {/* before ITS confirms the company every send is refused, so the way to send waits for it too */}
                {newTimesSetting.data?.companyConfirmed === false ? null : <Button size="sm" variant="primary" icon="send" onClick={() => setSendingNewTimes(true)}>Send new times…</Button>}
              </div>
            </Alert>
          ) : null}
          {compareOpen ? (
            <div className="stack gap-2">
              <div className="row"><Button size="sm" onClick={() => setCompareOpen(false)}>Done comparing</Button></div>
              <ComparePanel roleId={roleId} candidates={shown.map((a) => ({ id: a.id, name: a.candidate?.name ?? "Unknown", stageLabel: a.ownerStageLabel, score: a.score, interview: a.interview, basis: a.basis }))} />
            </div>
          ) : null}
          <div ref={listArea} className="[&>.tab-panel]:pt-0">
          <TabPanel idBase="talent-strip" value={view.stage}>
            {apps.isLoading ? <Skeleton lines={5} /> : apps.error ? <ErrorState message="Could not load the candidates." onRetry={() => apps.refetch()} /> : shown.length === 0 && total === 0 && status === "open" && canShareJob(myRole) ? (
              // Nobody yet on a live job (plan D8): the empty list is the place to share it from.
              <div className="empty justify-items-stretch text-left">
                <h2 className="text-center">Nobody has applied yet</h2>
                <p className="justify-self-center text-center">Share the job to bring in your first applicants.</p>
                <ShareJob roleId={roleId} roleTitle={role?.title ?? job?.title ?? ""} companyName={company.name} compact />
              </div>
            ) : shown.length === 0 ? (
              <EmptyState icon="talent" title={empty.title} body={empty.body} action={filtersOn && total > 0 ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : undefined} />
            ) : (
              // one bordered list (screenshot 4's table look); a row's menu may open over the rows below it
              <div className="list-card">
                {shown.map((a, i) => <TalentRow key={a.id} a={a} index={i} busy={rowAct.isPending && rowAct.variables?.id === a.id} onOpen={() => openPanel(a.id)} onMove={(to) => onRowMove(a, to)} />)}
              </div>
            )}
          </TabPanel>
          </div>
        </div>
      )}
      {/* The candidate panel comes last, so a name opened from Review and apply or from an answer sits on top of them. */}
      {reviewing && roleId && board.data ? <ReviewApply roleId={roleId} board={board.data} mayDecline={mayTell} onClose={closeReview} onOpen={(id) => openPanel(id)} /> : null}
      {asking && roleId && board.data ? <AskPool roleId={roleId} board={board.data} onClose={() => setAsking(false)} onOpen={(id) => openPanel(id)} onShow={(ids, label) => { setOnlyFor({ roleId, ids, label }); setAsking(false); }} /> : null}
      {panel && roleId ? (
        <CandidatePanel
          id={panel.id}
          roleId={roleId}
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
      {sendingNewTimes && roleId ? <NewTimesSheet roleId={roleId} people={underCancelled} onClose={() => setSendingNewTimes(false)} /> : null}
      {/* The job page as candidates see it, from the More menu (the version the job runs on). */}
      {roleId && job?.currentPacket ? <CandidatePreview open={previewOpen} onClose={() => setPreviewOpen(false)} path={`/api/v1/roles/${roleId}/preview?version=${job.currentPacket.version}`} /> : null}
      {/* "Use these weights" opens the job page's editor at the part that changed (its ?edit= link); nothing is carried over. */}
      {weightsOpen && roleId && job?.currentPacket ? <WeightsPreview roleId={roleId} packet={job.currentPacket.packet} onClose={() => setWeightsOpen(false)} onUse={(focus) => nav(`/roles/${roleId}?tab=scoring&edit=${focus}`)} /> : null}
    </div>
  );
}

/** One chip on a row; a short one ("Check") carries its full words for a screen reader and on hover. */
function RowChipView({ c }: { c: RowChip }) {
  if (c.kind === "pill") return <Pill size="sm" tone={c.tone} title={c.title}>{c.label}</Pill>;
  const short = c.title && c.label.length < c.title.length && c.key === "low";
  return (
    <span className={`chip ${c.tone}`} title={c.title}>
      {short ? <><span aria-hidden="true">{c.label}</span><span className="sr-only">{c.title}</span></> : c.label}
    </span>
  );
}

/**
 * One applicant: initials, name, when they applied, the wait, at most two chips, the match score (B2), the stage button.
 * A row of screenshot 4's table: the person on the left, the chips, score and stage on the right (under the name on a
 * phone). The name button, the chips' box and the score's slot keep bare class names (tests and the focus-after-move
 * code find them), so their look comes from the row and the box around them. The first rows rise in one after another.
 */
function TalentRow({ a, index, busy, onOpen, onMove }: { a: ApplicationSummary; index: number; busy: boolean; onOpen: () => void; onMove: (to: OwnerStage) => void }) {
  const name = a.candidate?.name ?? "Unknown";
  // waiting on you, or (an offer made outside the app, plan H2) waiting on the candidate's answer
  const waiting = waitingText(a) ?? waitingOnCandidateRow(a);
  // A decision message in the outbox of a company ITS has not confirmed yet waits for the check (founder decision B7).
  const check = useCompanyCheck();
  // Most pressing first; past two, the rest are counted in "+N" and said in full to a screen reader and on hover.
  const chips = rowChips(a, { onItsWay: messageOnItsWayChip(check), lowConfidence: LOW_CONFIDENCE_LABEL });
  const seen = chips.slice(0, ROW_CHIP_LIMIT);
  const rest = chips.slice(ROW_CHIP_LIMIT);
  const restWords = rest.map((c) => c.title ?? c.label).join("; ");
  const resumeOnly = resumeOnlyChip(a);
  return (
    <div className={ROW} style={{ animationDelay: `${Math.min(index, ROW_STAGGER_MAX) * 30}ms` }} data-application={a.id}>
      <Avatar name={name} />
      <div className={ROW_MAIN}>
        <button type="button" className="talent-name" onClick={onOpen}>{name}</button>
        <span className={ROW_SUB}>
          <span>{appliedWhen(a.appliedAt ?? a.createdAt)}</span>
          <span>{a.source.replace(/_/g, " ")}</span>
          {waiting ? <span className="font-medium text-caution">{waiting}</span> : null}
          {a.mark?.mark === "on_hold" && a.mark.remindAt && !a.tags.includes("Hold ended") ? <span>On hold until {holdDay(a.mark.remindAt)}</span> : null}
          {/* a review made against an earlier version of the job (plan F4): its score uses the requirements as they were then */}
          {a.readingVersion ? <span title={a.readingVersion.label}>Read against version {a.readingVersion.readAgainst}</span> : null}
        </span>
      </div>
      <div className={ROW_END}>
        <div className="talent-row-chips">
          {seen.map((c) => <RowChipView key={c.key} c={c} />)}
          {rest.length ? <span className="chip neutral" title={restWords}><span aria-hidden="true">+{rest.length}</span><span className="sr-only">Also: {restWords}</span></span> : null}
        </div>
        {/* the match score, worked out by code from the checked findings (founder decision B2); an older answer has none.
            A score with no AI interview in it yet says so beside the badge (R20-9), the full label on hover. */}
        <span className="score-slot" title={scoreTitle(a)}>{resumeOnly ? <span className="chip neutral" title={resumeOnly.title}>{resumeOnly.label}</span> : null}{a.score !== undefined ? <ScoreBadge score={a.score} size="sm" /> : null}</span>
        <StageButton stage={a.ownerStage} label={a.ownerStageLabel} blocked={stageBlocked(a.stageMoves)} disabled={busy} onMove={onMove} align="end" />
      </div>
    </div>
  );
}

/** The first rows rise in 30ms apart; from the ninth on they come with the eighth (spec section 4). */
const ROW_STAGGER_MAX = 7;
/**
 * A row of the list: the kit's divided row, roomier, a quiet fill under the mouse, rising in once (motion-safe). The
 * whole row is the name button's press area (its ::after covers the row), so the row draws the button's focus ring,
 * following the list card's rounded corners on the first and last rows.
 */
const ROW = "talent-row list-row relative flex-wrap gap-x-4 gap-y-2.5 px-4 py-3.5 hover:bg-surface-2/50 has-[.talent-name:focus-visible]:shadow-[inset_0_0_0_2px_var(--focus)] sm:px-5 motion-safe:animate-enter motion-safe:[animation-fill-mode:backwards]";
/** The name (its button's class is pinned, so the size and weight come from here) over the facts line. */
const ROW_MAIN = "grid min-w-0 flex-[1_1_14rem] gap-0.5 text-[15px] font-semibold leading-snug text-ink [&>.talent-name]:justify-self-start [&>.talent-name]:rounded-sm [&>.talent-name]:text-left [&>.talent-name]:[overflow-wrap:anywhere] [&>.talent-name]:hover:text-primary [&>.talent-name]:focus-visible:outline-none [&>.talent-name]:after:absolute [&>.talent-name]:after:inset-0 [&>.talent-name]:after:content-[''] pointer-coarse:[&>.talent-name]:min-h-10";
/** When they applied, the source, the wait and the rest, as one muted line with a dot between the parts. */
const ROW_SUB = "flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] font-normal text-ink-3 [&>*+*]:before:me-2 [&>*+*]:before:content-['·']";
/**
 * The chips, the score and the stage button: on the right on a wide screen, under the name on a phone. A long chip
 * wraps rather than running past the row. The stage button sits above the row's press area, and above the rows below
 * it while its menu is open.
 */
const ROW_END = "flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full max-sm:ps-[52px] sm:ms-auto sm:justify-end [&>.talent-row-chips]:flex [&>.talent-row-chips]:min-w-0 [&>.talent-row-chips]:max-w-full [&>.talent-row-chips]:flex-wrap [&>.talent-row-chips]:items-center [&>.talent-row-chips]:gap-1.5 [&>.talent-row-chips:empty]:hidden [&>.talent-row-chips>*]:max-w-full [&>.talent-row-chips>*]:whitespace-normal [&>.score-slot]:inline-flex [&>.score-slot]:items-center [&>.score-slot]:gap-1.5 [&_.menu-wrap]:z-[1] [&_.menu-wrap:focus-within]:z-[3] [&_.menu-wrap:has(.menu)]:z-[3]";

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
        <div className="stack gap-4">
          <ul className={RESULTS}>
            {results.results.map((r) => <li key={r.applicationId}><strong>{nameOf(r.applicationId)}</strong>: {r.ok && r.candidateNotice ? noticeText(r.candidateNotice) : r.message ?? "Not sent."}</li>)}
          </ul>
          <div className="row">
            {waiting ? <InlineUndo autoFocus label="Undo all" ariaLabel={`Undo all: take back the ${waiting.items.length === 1 ? "message" : `${waiting.items.length} messages`} still waiting`} undoUntil={waiting.until} onUndo={async () => { await bulkTakeBack(roleId, waiting.items); setWaiting(null); }} /> : null}
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="stack gap-5">
          {/* kept: nobody sees the others' names or addresses. What a wording says is the preview below, so no hint under the field. */}
          <p className="small text-ink-2">Each person gets their own message, with their name.</p>
          <Field label="Wording" htmlFor="bulk-wording">
            <select id="bulk-wording" className="select" value={wording} onChange={(e) => setWording(e.target.value as DecisionWording | "each")}>
              <option value="each">The suggested wording for each person</option>
              {BULK_WORDINGS.map((w) => <option key={w} value={w}>{DECISION_WORDING_LABEL[w]} for everyone</option>)}
            </select>
          </Field>
          <fieldset className="grid gap-2">
            <legend className={LEGEND}>Who gets it</legend>
            {people.map((p) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked((now) => (e.target.checked ? [...now, p.id] : now.filter((x) => x !== p.id)))} />
                <span>{p.candidate?.name ?? "Unknown"}{p.candidate?.email ? "" : <span className="muted"> (no email address on file)</span>}</span>
              </label>
            ))}
          </fieldset>
          {sample ? (
            preview.isLoading ? <Skeleton lines={4} /> : preview.data ? (
              <Card title={`What ${nameOf(sample).split(" ")[0]} will get`}>
                <p className="small"><strong>{preview.data.subject}</strong></p>
                <p className="small mt-1.5 whitespace-pre-wrap">{preview.data.text}</p>
                <p className="small muted mt-2">People declined on an eligibility answer always get the version about their answers.</p>
              </Card>
            ) : preview.error instanceof ApiError && preview.error.code === "wording_not_allowed" ? (
              <Alert tone="info">{nameOf(sample)} gets the wording for their own decision instead: {preview.error.message}</Alert>
            ) : <ErrorState message="Could not load the message." onRetry={() => preview.refetch()} />
          ) : null}
          {policy === "not_sent" ? <Alert tone="caution">Under your settings no decision messages are sent. Tell each person yourself, then record it on their page.</Alert> : null}
          {policy === "needs_approval" ? <p className="small muted">Under your settings each message waits for approval before it goes out.</p> : null}
          {policy === "sends" && preview.data?.undoSeconds ? <p className="small muted">Each message waits {preview.data.undoSeconds} seconds before it goes, so you can undo the Send.</p> : null}
          <Button variant="primary" icon="send" disabled={!picked.length || policy === "not_sent"} loading={send.isPending} onClick={() => send.mutate()}>{policy === "needs_approval" ? `Send ${picked.length} for approval` : `Send to ${picked.length} ${picked.length === 1 ? "person" : "people"}`}</Button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * "Send new times" for everyone under Cancelled at once (founder decision 2A, founder question 4): people who asked for
 * new times and people who did not come are ticked; people who said they are no longer interested are listed but not
 * ticked; anyone whose new times are already being prepared or are out cannot be ticked. One Send asks for each person
 * separately, so one refusal never holds up the rest, and each person's own result is shown.
 */
function NewTimesSheet({ roleId, people, onClose }: { roleId: string; people: ApplicationSummary[]; onClose: () => void }) {
  const qc = useQueryClient();
  const rows = newTimesSheetRows(people);
  const [picked, setPicked] = useState<string[]>(rows.filter((r) => r.ticked).map((r) => r.id));
  const [results, setResults] = useState<SendNewTimesBatchResult | null>(null);
  const send = useMutation({
    // in requests of at most a hundred people each, one after the other
    mutationFn: async () => {
      const parts: SendNewTimesBatchResult[] = [];
      for (const ids of batches(picked)) parts.push(await api.post<SendNewTimesBatchResult>(`/api/v1/roles/${roleId}/new-times`, { applicationIds: ids }));
      return mergeNewTimesResults(parts);
    },
    onSuccess: async (r) => {
      setResults(r);
      const t = newTimesToast({ kind: "batch", ...r });
      toast(t.title, t.detail);
      await Promise.all([qc.invalidateQueries({ queryKey: ["applications", roleId] }), qc.invalidateQueries({ queryKey: ["brief"] }), qc.invalidateQueries({ queryKey: ["application"] }), qc.invalidateQueries({ queryKey: ["interviews"] }), qc.invalidateQueries({ queryKey: ["roles"] })]);
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "Could not send new times."),
  });
  return (
    <Sheet open onClose={onClose} title="Send new times">
      {results ? (
        <div className="stack gap-4">
          <ul className={RESULTS}>
            {results.results.map((r) => <li key={r.applicationId}><strong>{r.name}</strong>: {newTimesResultLine(r)}</li>)}
          </ul>
          <div className="row"><Button onClick={onClose}>Done</Button></div>
        </div>
      ) : (
        <div className="stack gap-5">
          <p className="small text-ink-2">{NEW_TIMES_SHEET_TEXT}</p>
          <fieldset className="grid gap-2">
            <legend className={LEGEND}>Who gets new times</legend>
            {rows.map((p) => (
              <label key={p.id} className="check has-disabled:cursor-not-allowed has-disabled:opacity-60">
                <input type="checkbox" checked={picked.includes(p.id)} disabled={p.disabled} onChange={(e) => setPicked((now) => (e.target.checked ? [...now, p.id] : now.filter((x) => x !== p.id)))} />
                <span>{p.name}{p.note ? <span className="muted">{p.note}</span> : null}</span>
              </label>
            ))}
          </fieldset>
          <Button variant="primary" icon="send" disabled={!picked.length} loading={send.isPending} onClick={() => send.mutate()}>{newTimesSendLabel(picked.length)}</Button>
        </div>
      )}
    </Sheet>
  );
}

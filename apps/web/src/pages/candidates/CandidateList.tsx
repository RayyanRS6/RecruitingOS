"use client";

import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CANDIDATE_TAB_LABEL, type CandidateActionState, type CandidateList as CandidateListView, type CandidateRow, type CandidateTab } from "@ros/contracts";
import { Alert, Avatar, Button, EmptyState, ErrorState, Icon, Menu, ScoreBadge, Skeleton, TabPanel, Tabs } from "@ros/ui";
import { api } from "../../api/client";
import {
  bulkButtons, bulkLabel, emptyView, listHref, listRefresh, opensPanelFirst, rowView, SHORTLIST_NOTE, tabFrom, tabItems, ticksOnScreen, toggleAll, toggleTick,
  type BulkButton, type EmptyView, type ListPlace, type RowView, type ScoreView,
} from "../../candidates";
import { LockedCandidates } from "../../components/LockedCandidates";
import { Upgrade } from "../../components/Upgrade";
import { Link, useNavigate, useSearchParams } from "../../nav";
import { toast } from "../../toast";
import { ActionButton } from "./ActionButton";
import { CandidatePanel } from "./CandidatePanel";
import { useCandidateActions } from "./use-actions";

/** The tabs and their panel share these ids (aria-controls, aria-labelledby). */
const TABS_ID = "candidate-tabs";

/**
 * A job's candidates: five tabs with how many people each holds, and the people of the chosen tab in the order the
 * server ranks them (by resume score; under Interviewed by interview score). Each row has a tick, the name, when they
 * applied, the resume score with its band word and must-have line, any "Answered No" flag, and the person's actions.
 * Ticking rows turns the line above the list into one bar with the actions for several people. A row opens the
 * candidate panel, kept in the address (`?open=`). The list asks again every few seconds while a resume is being read
 * or an AI interview scored. `place`: under a job's own Candidates tab, or under Candidates in the rail.
 */
export function CandidateList({ place }: { place: ListPlace }) {
  const nav = useNavigate();
  const [search] = useSearchParams();
  const tab = tabFrom(search.get("tab"));
  const open = search.get("open");
  const roleId = place.roleId;
  const q = useQuery({
    queryKey: ["candidates", roleId, tab],
    queryFn: () => api.get<CandidateListView>(`/api/v1/roles/${roleId}/applications?tab=${tab}`),
    // the counts of the tab just left stay on the strip while the next tab's people are on their way
    placeholderData: keepPreviousData,
    refetchInterval: (query) => listRefresh(query.state.data),
  });
  const list = q.data && q.data.role.id === roleId ? q.data : undefined;
  const rows = list && list.tab === tab ? list.rows : null;
  const [tickedIds, setTicked] = useState<ReadonlySet<string>>(new Set());
  const ticked = ticksOnScreen(tickedIds, rows ?? []);
  const [confirming, setConfirming] = useState<BulkButton | null>(null);
  // "Email the decision" pressed on a row: the panel opens on the email itself
  const [decisionFor, setDecisionFor] = useState<string | null>(null);
  const actions = useCandidateActions(roleId);
  const go = (state: { tab: CandidateTab; open?: string | null }) => nav(listHref(place, state), { replace: true });
  const pickTab = (next: CandidateTab) => {
    setTicked(new Set());
    setConfirming(null);
    actions.clear();
    go({ tab: next });
  };
  const openPanel = (id: string | null) => {
    if (!id) setDecisionFor(null);
    go({ tab, open: id });
  };
  const run = (row: CandidateRow, state: CandidateActionState) => {
    if (!state.allowed) return toast(state.reason ?? "This is not possible right now.");
    if (actions.one.isPending) return;
    if (opensPanelFirst(state.action)) {
      setDecisionFor(row.id);
      go({ tab, open: row.id });
    } else actions.one.mutate({ id: row.id, action: state.action });
  };
  const runBulk = (button: BulkButton) => {
    if (button.action === "send_decision" && confirming?.action !== "send_decision") return setConfirming(button);
    actions.many.mutate(button, { onSuccess: () => { setTicked(new Set()); setConfirming(null); } });
  };
  const buttons = rows ? bulkButtons(rows, ticked) : [];
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <Tabs idBase={TABS_ID} label="Candidates by stage" variant="counts" value={tab} onChange={(id) => pickTab(tabFrom(id))} items={tabItems(list?.counts)} />
      {actions.problem && !open ? (
        <Alert tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{actions.problem.message}</span>
            {actions.problem.ask ? <Upgrade label={actions.problem.ask.label} size="sm" reason={actions.problem.ask.reason} /> : null}
          </div>
        </Alert>
      ) : null}
      {actions.refused.length ? (
        <Alert tone="caution">
          <strong>{actions.refused.length === 1 ? "Not done for 1 person" : `Not done for ${actions.refused.length} people`}</strong>
          <ul className="mt-1.5 grid list-disc gap-0.5 pl-[18px]">{actions.refused.map((line) => <li key={line}>{line}</li>)}</ul>
        </Alert>
      ) : null}
      <div className="[&>.tab-panel]:pt-0">
        <TabPanel idBase={TABS_ID} value={tab}>
          {!rows ? (
            q.error ? <ErrorState message="Could not load the candidates." onRetry={() => q.refetch()} /> : <Skeleton lines={5} />
          ) : rows.length === 0 && list ? (
            <Empty view={emptyView(tab, list)} onTab={pickTab} />
          ) : (
            <div className="grid gap-3">
              <SelectionBar
                total={rows.length}
                ticked={ticked.size}
                buttons={buttons}
                confirming={confirming}
                busy={actions.many.isPending ? actions.many.variables?.action ?? null : null}
                onToggleAll={() => { setTicked(toggleAll(ticked, rows)); setConfirming(null); }}
                onRun={runBulk}
                onCancel={() => setConfirming(null)}
              />
              <ul className="list-card" aria-label={`${CANDIDATE_TAB_LABEL[tab]} candidates`}>
                {rows.map((row) => (
                  <Row
                    key={row.id}
                    view={rowView(row)}
                    interviewFirst={tab === "interviewed"}
                    ticked={ticked.has(row.id)}
                    busy={actions.one.isPending && actions.one.variables?.id === row.id ? actions.one.variables.action : null}
                    onTick={() => { setTicked(toggleTick(ticked, row.id)); setConfirming(null); }}
                    onOpen={() => openPanel(row.id)}
                    onRun={(state) => run(row, state)}
                  />
                ))}
              </ul>
            </div>
          )}
        </TabPanel>
      </div>
      {tab === "new" ? <LockedCandidates locked={list?.locked} /> : null}
      {open ? <CandidatePanel key={open} id={open} actions={actions} decisionOpen={decisionFor === open} onDecisionOpen={(on) => setDecisionFor(on ? open : null)} onClose={() => openPanel(null)} /> : null}
    </div>
  );
}

/** Nobody in this tab: the title, and at most one way on. */
function Empty({ view, onTab }: { view: EmptyView; onTab: (tab: CandidateTab) => void }) {
  const a = view.action;
  const action = !a ? undefined : "href" in a ? <Link to={a.href} className="btn primary">{a.label}</Link> : <Button variant="primary" onClick={() => onTab(a.tab)}>{a.label}</Button>;
  return <EmptyState icon="talent" title={view.title} action={action} />;
}

/**
 * The line above the list: "Select all", and once anyone is ticked, how many are and one button for each action the
 * API allows for some of them. "Email the decision" for several asks once before it sends.
 */
function SelectionBar(props: { total: number; ticked: number; buttons: BulkButton[]; confirming: BulkButton | null; busy: string | null; onToggleAll: () => void; onRun: (button: BulkButton) => void; onCancel: () => void }) {
  const { ticked, total, confirming } = props;
  const some = ticked > 0;
  return (
    <fieldset className="flex min-h-12 min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-3 py-1.5 data-[on=true]:border-line-tint data-[on=true]:bg-tint" data-on={some ? "true" : undefined} aria-label="Actions for the people you ticked">
      <label className="inline-flex min-h-10 cursor-pointer items-center gap-2.5 text-[14px] font-medium text-ink">
        <input
          type="checkbox"
          checked={some && ticked === total}
          ref={(el) => {
            if (el) el.indeterminate = some && ticked < total;
          }}
          onChange={props.onToggleAll}
        />
        {some ? `${ticked} selected` : "Select all"}
      </label>
      {confirming ? (
        <>
          <span className="text-[14px] text-ink">{`Email the decision to ${confirming.ids.length === 1 ? "1 person" : `${confirming.ids.length} people`}?`}</span>
          <Button size="sm" variant="primary" icon="send" loading={props.busy === confirming.action} onClick={() => props.onRun(confirming)}>Send</Button>
          <Button size="sm" variant="ghost" disabled={!!props.busy} onClick={props.onCancel}>Cancel</Button>
        </>
      ) : (
        <>
          {props.buttons.map((b, i) => <Button key={b.action} size="sm" variant={i === 0 ? "primary" : "secondary"} loading={props.busy === b.action} disabled={!!props.busy && props.busy !== b.action} onClick={() => props.onRun(b)}>{bulkLabel(b, ticked)}</Button>)}
          {props.buttons.some((b) => b.action === "shortlist") ? <span className="small muted">{SHORTLIST_NOTE}</span> : null}
        </>
      )}
    </fieldset>
  );
}

/** A score on a row: a small word for which score it is, then the number with its band word; with no number, the words for why. */
function RowScore({ word, label, view }: { word: string; label: string; view: ScoreView }) {
  return (
    <span className="inline-flex items-center gap-2">
      {view.score === null ? null : <span className="text-[12px] font-normal text-ink-3">{word}</span>}
      <ScoreBadge size="sm" label={label} score={view.score} tone={view.tone} band={view.band} none={view.none ?? undefined} />
    </span>
  );
}

/**
 * One person. The whole row is the name button's press area (its ::after covers the row), so the row draws the
 * button's focus ring; the tick, the action button and the More menu sit above that area. candidate-row and
 * candidate-name are hooks for tests and e2e (no CSS of their own).
 */
function Row(props: { view: RowView; interviewFirst: boolean; ticked: boolean; busy: string | null; onTick: () => void; onOpen: () => void; onRun: (state: CandidateActionState) => void }) {
  const v = props.view;
  const resume = <RowScore word="Resume" label="Resume match" view={v.resume} />;
  const interview = v.interview ? <RowScore word="Interview" label="AI interview" view={v.interview} /> : null;
  return (
    <li className={ROW} data-application={v.id}>
      <label className="relative z-[1] grid size-10 shrink-0 cursor-pointer place-items-center">
        <input type="checkbox" checked={props.ticked} onChange={props.onTick} />
        <span className="sr-only">Select {v.name}</span>
      </label>
      <Avatar name={v.name} />
      <div className={ROW_MAIN}>
        <button type="button" className="candidate-name" onClick={props.onOpen}>{v.name}</button>
        <span className={ROW_FACTS}>{v.facts.map((f) => <span key={f}>{f}</span>)}</span>
        {v.mustHaveLine ? <span className={ROW_LINE}>{v.mustHaveLine}</span> : null}
        {v.missingLine ? <span className="text-[13px] font-medium text-critical wrap-anywhere">{v.missingLine}</span> : null}
        {v.earlierVersion ? <span className={ROW_LINE}>{v.earlierVersion}</span> : null}
        {v.flags.map((f) => <span key={f} className="flex items-start gap-1.5 text-[13px] font-medium text-caution wrap-anywhere"><Icon name="flag" size={13} className="mt-0.5 shrink-0" />{f}</span>)}
      </div>
      <div className={ROW_END}>
        <span className="grid justify-items-start gap-1 sm:justify-items-end">{props.interviewFirst ? <>{interview}{resume}</> : <>{resume}{interview}</>}</span>
        {v.primary ? <ActionButton state={v.primary} who={v.name} size="sm" busy={props.busy === v.primary.action} waiting={!!props.busy && props.busy !== v.primary.action} onRun={() => props.onRun(v.primary as CandidateActionState)} /> : null}
        {v.more.length ? (
          <Menu
            label="More"
            ariaLabel={`More for ${v.name}`}
            buttonClassName="btn quiet sm"
            align="end"
            items={v.more.map((a) => ({ id: a.action, label: a.label, disabled: !a.allowed, reason: a.reason ?? undefined }))}
            onSelect={(id) => {
              const state = v.more.find((a) => a.action === id);
              if (state) props.onRun(state);
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

/** A row of the list: the kit's divided row, roomier, a quiet fill under the mouse, the name button's focus ring drawn on the row. */
const ROW = "candidate-row list-row relative flex-wrap items-start gap-x-3 gap-y-2.5 px-3 py-3.5 hover:bg-surface-2/50 has-[.candidate-name:focus-visible]:shadow-[inset_0_0_0_2px_var(--focus)] sm:px-4";
/** The name (its button's class is a hook, so the size and weight come from here) over the person's lines. */
const ROW_MAIN = "grid min-w-0 flex-[1_1_10rem] gap-0.5 text-[15px] font-semibold leading-snug text-ink [&>.candidate-name]:justify-self-start [&>.candidate-name]:rounded-sm [&>.candidate-name]:text-left [&>.candidate-name]:[overflow-wrap:anywhere] [&>.candidate-name]:hover:text-primary [&>.candidate-name]:focus-visible:outline-none [&>.candidate-name]:after:absolute [&>.candidate-name]:after:inset-0 [&>.candidate-name]:after:content-[''] pointer-coarse:[&>.candidate-name]:min-h-10";
/** When they applied and where they stand, as one muted line with a dot between the parts. */
const ROW_FACTS = "flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] font-normal text-ink-3 [&>*+*]:before:me-2 [&>*+*]:before:content-['·']";
/** A plain line under the facts. */
const ROW_LINE = "text-[13px] font-normal text-ink-2";
/** The scores and the actions: on the right on a wide screen, under the name on a phone. The controls sit above the row's press area, and above the rows below while a menu is open. */
const ROW_END = "flex min-w-0 flex-wrap items-center gap-2.5 max-sm:w-full sm:ms-auto sm:justify-end [&>.btn]:relative [&>.btn]:z-[1] [&_.menu-wrap]:z-[1] [&_.menu-wrap:focus-within]:z-[3] [&_.menu-wrap:has(.menu)]:z-[3]";

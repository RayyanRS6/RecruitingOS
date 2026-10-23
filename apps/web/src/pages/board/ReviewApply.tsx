"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Avatar, Button, Chip, cn, Dialog, Icon } from "@ros/ui";
import type { RejectReason } from "@ros/contracts";
import { api, ApiError, type BatchPreview, type BatchResult, type BoardView } from "../../api/client";
import { toast } from "../../toast";
import { BOARD_COLUMNS, DECLINE_CHOICES, GROUP_WORDS, REVIEW_FOOT, REVIEW_SUB, applyLabel, appliedNote, appliedToast, batchItems, extraWarnings, groupCount, initialReview, isTicked, needsReason, previewByPerson, previewItems, readyCounts, readyLine, reasonOf, reviewFootNote, reviewRows, rowWarnings, tickable, type ReviewRow, type ReviewState } from "./board-model";

/** What to know first, in the warning's own colour: red only for a must-have their own words show missing. */
const WARN_TONE: Record<"caution" | "critical", string> = { caution: "text-caution", critical: "text-critical" };

/**
 * Review and apply (plan F8; plan-adjustments section 3; founder decisions B4 and B6): the board's suggestions in three
 * groups, Shortlist, Longlist and Not moving forward, each person with a tick, their score, the reason, and what to know
 * first. People the board placed with confidence start ticked; anyone who needs your eye starts unticked with the
 * reason. Each not-moving-forward row carries a reason from the fixed list, pre-filled from their own evidence and
 * changeable here. A preview from the API (nothing changes) says who cannot be included and why, before anything is
 * applied. Apply files everyone ticked privately, each in their own step: nobody is emailed now, and the decision
 * message is sent later by a person, from Candidates; a decision nobody tells meets the day-5 safety net (the footer
 * and the toast say so; founder decision D-03).
 *
 * Few words (founder, 23 Oct 2026): where each group goes is its heading's title, and "untick anyone you want to decide
 * yourself" is the Apply button's; the footer keeps what applying means, privately, beside the live counter.
 *
 * The rows are taken when the window opens, so the list does not shift under the person while the board refreshes.
 */
export function ReviewApply(props: { roleId: string; board: BoardView; mayDecline: boolean; onClose: () => void; onOpen: (applicationId: string) => void }) {
  const qc = useQueryClient();
  const [{ rows, left }] = useState(() => reviewRows(props.board, { mayDecline: props.mayDecline }));
  const [own, setOwn] = useState<Pick<ReviewState, "ticks" | "reasons">>(() => initialReview(rows));
  const [results, setResults] = useState<BatchResult | null>(null);
  const items = previewItems(rows);
  // The API's own rules for each person, before anything changes (dryRun): who cannot be included, and why.
  const preview = useQuery({
    queryKey: ["applications", props.roleId, "review-preview", items.map((i) => `${i.applicationId}:${i.action}`).join(",")],
    queryFn: () => api.post<BatchPreview>(`/api/v1/roles/${props.roleId}/batch`, { items, dryRun: true }),
    enabled: items.length > 0 && !results,
    retry: false,
    staleTime: 30_000,
  });
  const fromPreview = previewByPerson(preview.data);
  const state: ReviewState = { ...own, refused: fromPreview.refused };
  const counts = readyCounts(rows, state);
  const apply = useMutation({
    mutationFn: () => api.post<BatchResult>(`/api/v1/roles/${props.roleId}/batch`, { items: batchItems(rows, state), dryRun: false }),
    onSuccess: async (r) => {
      const t = appliedToast(r);
      toast(t.title, r.applied ? { detail: t.detail, tone: "good" } : t.detail);
      await Promise.all([qc.invalidateQueries({ queryKey: ["applications", props.roleId] }), qc.invalidateQueries({ queryKey: ["brief"] }), qc.invalidateQueries({ queryKey: ["roles"] })]);
      // Everyone applied: the board shows them as done. Anyone refused: the window stays, with each person's result.
      if (r.refused) setResults(r);
      else props.onClose();
    },
    onError: (e) => toast(e instanceof ApiError ? e.message : "That did not go through. Check the board before trying again."),
  });
  const tick = (id: string, on: boolean) => setOwn((s) => ({ ...s, ticks: { ...s.ticks, [id]: on } }));
  const choose = (id: string, reason: RejectReason) => setOwn((s) => ({ ...s, reasons: { ...s.reasons, [id]: reason } }));

  const footNote = reviewFootNote(counts);
  // The foot stays in view under the scrolling rows: what applying means and the live counter on the left, Cancel and
  // Apply on the right (full width on a phone).
  const footer = results ? (
    <Button variant="primary" onClick={props.onClose}>Close</Button>
  ) : (
    <div className="flex basis-full flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <p className="grid min-w-0 flex-[1_1_18rem] gap-0.5 text-[13px] leading-snug text-ink-2">
        <span>{REVIEW_FOOT}</span>
        {footNote ? <span>{footNote}</span> : null}
        <strong role="status" className="text-[14px] font-semibold text-ink tabular-nums">{readyLine(counts)}</strong>
      </p>
      <div className="flex flex-wrap gap-2 max-sm:w-full">
        <Button variant="ghost" className="max-sm:flex-1" onClick={props.onClose} disabled={apply.isPending}>Cancel</Button>
        <Button variant="primary" className="max-sm:flex-1" title={REVIEW_SUB} disabled={!counts.total} loading={apply.isPending} onClick={() => apply.mutate()}>{applyLabel(counts.total)}</Button>
      </div>
    </div>
  );

  return (
    <Dialog open onClose={props.onClose} size="lg" title="Review and apply" footer={footer}>
      {results ? (
        <div className="grid gap-4">
          <Alert tone="info">{results.words} {appliedNote(results)}</Alert>
          <ul className="list-card divide-y divide-line overflow-hidden">
            {results.results.map((r) => (
              <li key={r.applicationId} className="flex items-start gap-3 px-4 py-3 text-[14px] leading-snug">
                <Chip tone={r.ok ? "good" : "caution"} icon={r.ok ? "check" : "alert"}>{r.ok ? "Done" : "Not applied"}</Chip>
                <span className="min-w-0"><strong>{r.name}</strong>: {r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-ink-2">Nobody waits to be sorted right now.</p>
      ) : (
        <div className="grid gap-6">
          {preview.isLoading ? <p className="small muted" role="status">Checking each person against the same rules as their own page…</p> : null}
          {preview.error ? <p className="small muted">The check before applying did not load; each person is still checked when you apply.</p> : null}
          {left ? <Alert tone="info">Review and apply takes up to 50 people at a time. {left === 1 ? "1 more person waits" : `${left} more people wait`} for the next round.</Alert> : null}
          {BOARD_COLUMNS.map((c) => {
            const group = rows.filter((r) => r.column === c.id);
            if (!group.length) return null;
            const n = groupCount(rows, c.id, state);
            return (
              <section key={c.id} className="grid gap-2.5" aria-labelledby={`review-group-${c.id}`}>
                <div className="flex items-center justify-between gap-3">
                  {/* where the group goes, privately, on hover: the footer says it for everyone ticked */}
                  <h3 id={`review-group-${c.id}`} className="text-[17px] font-bold tracking-[-0.015em]" title={GROUP_WORDS[c.id]}>{c.title}</h3>
                  <span className="inline-flex min-h-6 items-center rounded-full bg-surface-2 px-2.5 text-[12.5px] font-semibold text-ink-2 tabular-nums"><span aria-hidden="true">{n.ticked}/{n.total}</span><span className="sr-only">{n.ticked} of {n.total} ticked</span></span>
                </div>
                {/* the kit's list card (screenshot 6), divided; overflow-hidden keeps a ticked row's lavender inside its corners */}
                <ul className="list-card divide-y divide-line overflow-hidden">
                  {group.map((row) => <ReviewRowView key={row.applicationId} row={row} state={state} warnings={fromPreview.warnings[row.applicationId]} onTick={(on) => tick(row.applicationId, on)} onReason={(r) => choose(row.applicationId, r)} onOpen={() => props.onOpen(row.applicationId)} />)}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

/** One person: the tick, the name (opens their panel), band and score, the reason, what to know first, and for a not-moving-forward the reason they are filed with. */
function ReviewRowView(props: { row: ReviewRow; state: ReviewState; warnings: string[] | undefined; onTick: (on: boolean) => void; onReason: (reason: RejectReason) => void; onOpen: () => void }) {
  const { row, state } = props;
  const id = `review-${row.applicationId}`;
  const can = tickable(row, state);
  const blocked = state.refused[row.applicationId] ?? row.locked;
  const reason = reasonOf(row, state);
  const extra = extraWarnings(row, props.warnings);
  return (
    // the tick first, then the initials, as in a table of people; the tick's own markup stays bare (tests read it)
    <li className="flex items-start gap-3 px-4 py-3.5 transition-colors duration-150 ease-soft data-[applied=true]:bg-tint/70 sm:px-5 [&>input]:mt-[3px] sm:[&>input]:mt-[9px]" data-applied={isTicked(row, state)}>
      <input id={id} type="checkbox" checked={can && !!state.ticks[row.applicationId]} disabled={!can} onChange={(e) => props.onTick(e.target.checked)} aria-describedby={`${id}-why`} />
      <span className="max-sm:hidden"><Avatar name={row.name} /></span>
      <div className="grid min-w-0 flex-1 gap-1 sm:pt-1.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <label htmlFor={id} className="cursor-pointer text-[15px] font-semibold text-ink">{row.name}</label>
          <span className="text-[13px] text-ink-2 tabular-nums">{row.scoreText}</span>
          <button type="button" className="link-btn small ms-auto inline-flex items-center pointer-coarse:min-h-10" onClick={props.onOpen}>Open<span className="sr-only"> {row.name}</span></button>
        </div>
        <p id={`${id}-why`} className="text-[14px] leading-snug text-ink-2">{row.reason}</p>
        {rowWarnings(row).map((w) => <p key={w.text} className={cn("flex items-start gap-1.5 text-[13px] font-medium leading-snug", WARN_TONE[w.tone])}><Icon name="alert" size={14} className="mt-[2px] shrink-0" />{w.text}</p>)}
        {row.needsYourEye && !row.locked ? <p className="text-[13px] leading-snug text-ink-3">{row.needsYourEye}</p> : null}
        {extra.map((w) => <p key={w} className="text-[13px] leading-snug text-ink-3">{w}</p>)}
        {blocked ? <p className="text-[13px] leading-snug text-ink-3"><strong className="text-ink-2">Not included:</strong> {blocked}</p> : null}
        {row.action === "not_moving_forward" && !blocked ? (
          <div className="mt-2 grid max-w-md gap-1.5">
            <label htmlFor={`${id}-reason`} className="text-[13px] font-semibold text-ink">Reason<span className="sr-only"> for {row.name} (change it if you disagree)</span></label>
            <select id={`${id}-reason`} className="select" value={reason ?? ""} onChange={(e) => props.onReason(e.target.value as RejectReason)}>
              {reason ? null : <option value="" disabled>Choose a reason</option>}
              {DECLINE_CHOICES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            {row.declineReason?.note ? <span className="text-[13px] leading-snug text-ink-3">From their evidence: {row.declineReason.note}</span> : null}
            {needsReason(row, state) ? <span className="text-[13px] font-medium text-caution">Choose a reason to include them.</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

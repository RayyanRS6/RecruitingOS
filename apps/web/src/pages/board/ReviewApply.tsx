"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Chip, Dialog, Icon } from "@ros/ui";
import type { RejectReason } from "@ros/contracts";
import { api, ApiError, type BatchPreview, type BatchResult, type BoardView } from "../../api/client";
import { toast } from "../../toast";
import { BOARD_COLUMNS, DECLINE_CHOICES, GROUP_WORDS, REVIEW_FOOT, REVIEW_SUB, applyLabel, appliedToast, batchItems, extraWarnings, groupCount, initialReview, isTicked, needsReason, previewByPerson, previewItems, readyCounts, readyLine, reasonOf, reviewRows, rowWarnings, tickable, type ReviewRow, type ReviewState } from "./board-model";

/**
 * Review and apply (plan F8; plan-adjustments section 3; founder decisions B4 and B6): the board's suggestions in three
 * groups, Shortlist, Longlist and Not moving forward, each person with a tick, their score, the reason, and what to know
 * first. People the board placed with confidence start ticked; anyone who needs your eye starts unticked with the
 * reason. Each not-moving-forward row carries a reason from the fixed list, pre-filled from their own evidence and
 * changeable here. A preview from the API (nothing changes) says who cannot be included and why, before anything is
 * applied. Apply files everyone ticked privately, each in their own step: nobody is emailed, and the decision message is
 * sent later by a person, from the Talent page.
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

  const footer = results ? (
    <Button variant="primary" onClick={props.onClose}>Close</Button>
  ) : (
    <div className="review-foot">
      <p className="review-foot-text">
        <span>{REVIEW_FOOT}</span>
        <strong role="status">{readyLine(counts)}</strong>
      </p>
      <div className="review-foot-buttons">
        <Button variant="ghost" onClick={props.onClose} disabled={apply.isPending}>Cancel</Button>
        <Button variant="primary" disabled={!counts.total} loading={apply.isPending} onClick={() => apply.mutate()}>{applyLabel(counts.total)}</Button>
      </div>
    </div>
  );

  return (
    <Dialog open onClose={props.onClose} size="lg" title="Review and apply" sub={REVIEW_SUB} footer={footer}>
      {results ? (
        <div className="stack">
          <Alert tone="info">{results.words} Nobody was emailed.</Alert>
          <ul className="review-rows">
            {results.results.map((r) => (
              <li key={r.applicationId} className="review-result">
                <Chip tone={r.ok ? "good" : "caution"} icon={r.ok ? "check" : "alert"}>{r.ok ? "Done" : "Not applied"}</Chip>
                <span><strong>{r.name}</strong>: {r.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : rows.length === 0 ? (
        <p>Nobody waits to be sorted right now. Everyone on the board is already sorted, decided or still being read.</p>
      ) : (
        <>
          {preview.isLoading ? <p className="small muted" role="status">Checking each person against the same rules as their own page…</p> : null}
          {preview.error ? <p className="small muted">The check before applying did not load; each person is still checked when you apply.</p> : null}
          {left ? <Alert tone="info">Review and apply takes up to 50 people at a time. {left === 1 ? "1 more person waits" : `${left} more people wait`} for the next round.</Alert> : null}
          {BOARD_COLUMNS.map((c) => {
            const group = rows.filter((r) => r.column === c.id);
            if (!group.length) return null;
            const n = groupCount(rows, c.id, state);
            return (
              <section key={c.id} className="review-group" aria-labelledby={`review-group-${c.id}`}>
                <div className="review-group-head">
                  <h3 id={`review-group-${c.id}`}>{c.title}</h3>
                  <span className="review-group-count"><span aria-hidden="true">{n.ticked}/{n.total}</span><span className="sr-only">{n.ticked} of {n.total} ticked</span></span>
                </div>
                <p className="review-group-where">{GROUP_WORDS[c.id]}</p>
                <ul className="review-rows">
                  {group.map((row) => <ReviewRowView key={row.applicationId} row={row} state={state} warnings={fromPreview.warnings[row.applicationId]} onTick={(on) => tick(row.applicationId, on)} onReason={(r) => choose(row.applicationId, r)} onOpen={() => props.onOpen(row.applicationId)} />)}
                </ul>
              </section>
            );
          })}
        </>
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
    <li className="review-row" data-applied={isTicked(row, state)}>
      <input id={id} type="checkbox" checked={can && !!state.ticks[row.applicationId]} disabled={!can} onChange={(e) => props.onTick(e.target.checked)} aria-describedby={`${id}-why`} />
      <div className="review-row-main">
        <div className="review-row-name">
          <label htmlFor={id}>{row.name}</label>
          <span className="review-row-score">{row.scoreText}</span>
          <button type="button" className="link-btn small" onClick={props.onOpen}>Open<span className="sr-only"> {row.name}</span></button>
        </div>
        <p id={`${id}-why`} className="review-row-reason">{row.reason}</p>
        {rowWarnings(row).map((w) => <p key={w.text} className={`review-warn ${w.tone}`}><Icon name="alert" size={14} />{w.text}</p>)}
        {row.needsYourEye && !row.locked ? <p className="review-row-note">{row.needsYourEye}</p> : null}
        {extra.map((w) => <p key={w} className="review-row-note">{w}</p>)}
        {blocked ? <p className="review-row-note"><strong>Not included:</strong> {blocked}</p> : null}
        {row.action === "not_moving_forward" && !blocked ? (
          <div className="review-reason">
            <label htmlFor={`${id}-reason`}>Reason<span className="sr-only"> for {row.name} (change it if you disagree)</span></label>
            <select id={`${id}-reason`} className="select" value={reason ?? ""} onChange={(e) => props.onReason(e.target.value as RejectReason)}>
              {reason ? null : <option value="" disabled>Choose a reason</option>}
              {DECLINE_CHOICES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            {row.declineReason?.note ? <span className="review-row-note">From their evidence: {row.declineReason.note}</span> : null}
            {needsReason(row, state) ? <span className="review-warn caution">Choose a reason to include them.</span> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

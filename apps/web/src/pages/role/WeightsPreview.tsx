"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Chip, Drawer, EmptyState, ErrorState, Skeleton } from "@ros/ui";
import { api, type BoardView, type RolePacket } from "../../api/client";
import type { EditorFocus } from "../../skills-form";
import { INTERVIEW_ONLY_LINE, NOBODY_SCORED, PREVIEW_LABEL, USE_WEIGHTS_LINE, WEIGHT_LEVEL_LABEL, changeWords, changedRows, focusFor, jobLevels, movedWords, placeWords, previewOrder, previewStatus, scoreWords, unscoredWords, weightFieldId, weightRows, type WeightLevel, type WeightRow } from "../../weights-preview";

/**
 * "Try different weights" (founder decision L-07 A, preview only), opened from the job's Scoring tab and the More menu
 * on the job and its Candidates page. On the left, each must-have and scored skill with how much it counts; on the
 * right, the candidates in the order those weights give, each with the preview's number beside today's. The numbers are
 * worked out here from the board the Candidates page also reads (the same request, shared through its key), with the
 * real score's own sums (weights-preview.ts). Nothing is posted, stored or logged, and the real scores never change.
 * "Use these weights" closes this and opens the job's editor, where saving makes a new version of the job.
 *
 * Fewer words (23 Oct 2026): no line under the title (the banner says it is a preview that saves nothing), the
 * interview-only note only when a skill is left out for that reason, and what "Use these weights" does under it.
 */
export function WeightsPreview(props: { roleId: string; packet: RolePacket; onClose: () => void; onUse: (focus: EditorFocus) => void }) {
  const { roleId } = props;
  // the board's own key and request (People.tsx), so an open board is not asked for again
  const board = useQuery({ queryKey: ["applications", roleId, "board"], queryFn: () => api.get<BoardView>(`/api/v1/roles/${roleId}/board`) });
  const rows = weightRows(props.packet);
  const [levels, setLevels] = useState(() => jobLevels(rows));
  const changed = changedRows(rows, levels);
  const words = changeWords(rows, levels);
  const order = board.data ? previewOrder(board.data, rows, levels) : null;
  const pick = (row: WeightRow, level: WeightLevel) => setLevels((now) => ({ ...now, [row.id]: level }));
  // one weight: its name over the native choice (the label names the select; e2e picks options from it)
  const field = (row: WeightRow) => (
    <div key={row.id} className="grid gap-1.5 border-t border-line pt-3 first-of-type:border-t-0 [&>label]:text-[14px] [&>label]:font-medium [&>label]:text-ink">
      <label htmlFor={weightFieldId(row)}>{row.label}</label>
      <select id={weightFieldId(row)} className="select" value={levels[row.id] ?? row.level} onChange={(e) => pick(row, e.target.value as WeightLevel)}>
        {row.choices.map((c) => <option key={c} value={c}>{WEIGHT_LEVEL_LABEL[c]}</option>)}
      </select>
    </div>
  );
  const musts = rows.filter((r) => r.mustHave);
  const skills = rows.filter((r) => !r.mustHave);
  // A skill checked only in the team's own interviews is not in the score, so it is not listed: said only when one is.
  const interviewOnly = props.packet.competencies.some((c) => c.evaluatedIn === "interview");
  return (
    <Drawer open size="lg" title="Try different weights" banner={<Alert tone="info">{PREVIEW_LABEL}</Alert>} onClose={props.onClose}>
      {/* Two panes on a desk (the drawer is wide enough from md): the weights on the left, the order they give on the right. */}
      <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-2">
        <div className="stack gap-4">
          {/* each group a card of its own, the kit's eyebrow naming it (`weights-set`: a hook the tests find the groups by) */}
          {musts.length ? <div className="card p-4"><fieldset className="weights-set grid gap-3"><legend className="eyebrow">Must-haves</legend>{musts.map(field)}</fieldset></div> : null}
          {skills.length ? <div className="card p-4"><fieldset className="weights-set grid gap-3"><legend className="eyebrow">Skills we look for</legend>{skills.map(field)}</fieldset></div> : null}
          {interviewOnly ? <p className="small muted">{INTERVIEW_ONLY_LINE}</p> : null}
          <div className="row"><Button size="sm" disabled={!changed.length} onClick={() => setLevels(jobLevels(rows))}>Back to the job's weights</Button></div>
          {changed.length ? (
            <ul className="small grid list-disc gap-1 rounded-xl border border-line-tint bg-tint py-3.5 pr-3.5 pl-8">{changed.map((r, i) => <li key={r.id}>{words[i]}</li>)}</ul>
          ) : null}
          <div className="row"><Button size="sm" variant="primary" disabled={!changed.length} title={changed.length ? undefined : "Change a weight first"} onClick={() => props.onUse(focusFor(rows, levels))}>Use these weights</Button></div>
          <p className="small muted">{USE_WEIGHTS_LINE}</p>
        </div>
        {/* `weights-status` and `weights-order` are hooks the tests pin byte for byte, so the status line is styled from here */}
        <div className="stack gap-3 [&>.weights-status]:text-[14px] [&>.weights-status]:text-ink-2">
          {board.isLoading ? <Skeleton lines={5} /> : board.error || !order ? (
            <ErrorState message="Could not load the candidates' scores just now." onRetry={() => board.refetch()} />
          ) : !order.rows.length ? (
            <EmptyState icon="talent" title={NOBODY_SCORED.title} body={NOBODY_SCORED.body} />
          ) : (
            <>
              <p role="status" className="weights-status">{previewStatus(changed.length, order)}</p>
              {/* the order as rows (screenshot 1's "Applications to pick up"): place, then the name and where they are with
                  the numbers beside them, or under the name when the pane is narrow (always lined up with the name) */}
              <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-xs">
                <ol className="weights-order">
                  {order.rows.map((p) => (
                    <li key={p.applicationId} className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 border-t border-line px-4 py-3 first:border-t-0">
                      <span className="inline-flex size-8 flex-none items-center justify-center rounded-full border border-line-tint bg-tint-2 font-mono text-[12px] text-primary tabular-nums">{p.rank}</span>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span className="grid min-w-0 flex-[1_1_9rem] gap-0.5">
                          <strong className="truncate text-[15px]">{p.name}</strong>
                          <span className="text-[13px] text-ink-3">{placeWords(p)}</span>
                        </span>
                        <span className="flex flex-wrap items-center gap-2 text-[13px] text-ink-2 tabular-nums">
                          {scoreWords(p)}
                          {p.moved ? <Chip tone={p.moved > 0 ? "good" : "neutral"}>{movedWords(p.moved)}</Chip> : null}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              {order.unscored ? <p className="small muted">{unscoredWords(order.unscored)}</p> : null}
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}

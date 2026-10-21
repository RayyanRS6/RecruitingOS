"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Chip, Drawer, EmptyState, ErrorState, Skeleton } from "@ros/ui";
import { api, type BoardView, type RolePacket } from "../../api/client";
import type { EditorFocus } from "../../skills-form";
import { INTERVIEW_ONLY_LINE, INTRO, LEAVE_OUT_HINT, NOBODY_SCORED, PREVIEW_LABEL, USE_WEIGHTS_LINE, WEIGHT_LEVEL_LABEL, changeWords, changedRows, focusFor, jobLevels, movedWords, placeWords, previewOrder, previewStatus, scoreWords, unscoredWords, weightFieldId, weightRows, type WeightLevel, type WeightRow } from "../../weights-preview";

/**
 * "Try different weights" (founder decision L-07 A, preview only), opened from the job's Scoring tab and the More menu
 * on the job and its Candidates page. On the left, each must-have and scored skill with how much it counts; on the
 * right, the candidates in the order those weights give, each with the preview's number beside today's. The numbers are
 * worked out here from the board the Candidates page also reads (the same request, shared through its key), with the
 * real score's own sums (weights-preview.ts). Nothing is posted, stored or logged, and the real scores never change.
 * "Use these weights" closes this and opens the job's editor, where saving makes a new version of the job.
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
  const field = (row: WeightRow) => (
    <div key={row.id} className="weights-row">
      <label htmlFor={weightFieldId(row)}>{row.label}</label>
      <select id={weightFieldId(row)} className="select" value={levels[row.id] ?? row.level} onChange={(e) => pick(row, e.target.value as WeightLevel)}>
        {row.choices.map((c) => <option key={c} value={c}>{WEIGHT_LEVEL_LABEL[c]}</option>)}
      </select>
    </div>
  );
  const musts = rows.filter((r) => r.mustHave);
  const skills = rows.filter((r) => !r.mustHave);
  return (
    <Drawer open size="lg" title="Try different weights" sub={INTRO} banner={<Alert tone="info">{PREVIEW_LABEL}</Alert>} onClose={props.onClose}>
      <div className="weights-preview">
        <div className="weights-pick">
          {musts.length ? <fieldset className="weights-set"><legend>Must-haves</legend>{musts.map(field)}</fieldset> : null}
          {skills.length ? <fieldset className="weights-set"><legend>Skills we look for</legend>{skills.map(field)}</fieldset> : null}
          <p className="small muted">{INTERVIEW_ONLY_LINE}</p>
          <div className="row"><Button size="sm" disabled={!changed.length} onClick={() => setLevels(jobLevels(rows))}>Back to the job's weights</Button></div>
          {changed.length ? (
            <div className="weights-changes">
              <ul className="small">{changed.map((r, i) => <li key={r.id}>{words[i]}</li>)}</ul>
              <p className="small muted">{LEAVE_OUT_HINT}</p>
            </div>
          ) : null}
          <div className="row"><Button size="sm" variant="primary" disabled={!changed.length} title={changed.length ? undefined : "Change a weight first"} onClick={() => props.onUse(focusFor(rows, levels))}>Use these weights</Button></div>
          <p className="small muted">{USE_WEIGHTS_LINE}</p>
        </div>
        <div className="weights-result">
          {board.isLoading ? <Skeleton lines={5} /> : board.error || !order ? (
            <ErrorState message="Could not load the candidates' scores just now." onRetry={() => board.refetch()} />
          ) : !order.rows.length ? (
            <EmptyState icon="talent" title={NOBODY_SCORED.title} body={NOBODY_SCORED.body} />
          ) : (
            <>
              <p role="status" className="weights-status">{previewStatus(changed.length, order)}</p>
              <ol className="weights-order">
                {order.rows.map((p) => (
                  <li key={p.applicationId} className="weights-person">
                    <span className="weights-rank">{p.rank}</span>
                    <span className="weights-who">
                      <strong>{p.name}</strong>
                      <span className="weights-meta">{placeWords(p)}</span>
                    </span>
                    <span className="weights-score">
                      {scoreWords(p)}
                      {p.moved ? <Chip tone={p.moved > 0 ? "good" : "neutral"}>{movedWords(p.moved)}</Chip> : null}
                    </span>
                  </li>
                ))}
              </ol>
              {order.unscored ? <p className="small muted">{unscoredWords(order.unscored)}</p> : null}
            </>
          )}
        </div>
      </div>
    </Drawer>
  );
}

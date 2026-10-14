"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Card, Chip, ErrorState, ScoreBadge, ScoreBar, Segmented, Skeleton, StatusChip, Table } from "@ros/ui";
import { api, type NoteView } from "../../api/client";
import { Link } from "../../nav";
import { noteExcerpt } from "../../notes";
import { overallLabel } from "../candidate-panel/assessment";
import { REC_LABEL } from "../candidate-panel/helpers";
import { COMPARE_MAX, COMPARE_ORDERS, cellFigures, criterionCell, hasTeamNotes, orderCandidates, orderLine, scoreSummary, skillTag, togglePick, versionNotes, type CompareCandidateView, type CompareOrder, type CompareView } from "./compare-view";

/**
 * Compare (docs/spec/21 F10; founder decision B2): tick up to five people, then see them side by side: each one's
 * match score with what it rests on, then every must-have and skill as a line with what was found, how much of it was
 * met and the points it cost, their words one click away. Columns stay in the order chosen unless "Highest score first"
 * is picked. Opened from the Talent page's Compare and from the board's "Compare these" (`initial`).
 */
export function ComparePanel({ roleId, candidates, initial }: { roleId: string; candidates: Array<{ id: string; name: string; stageLabel: string; score?: number | null }>; initial?: string[] }) {
  const start = (initial ?? []).slice(0, COMPARE_MAX);
  const [picked, setPicked] = useState<string[]>(start);
  const [ids, setIds] = useState<string[] | null>(start.length ? start : null);
  const q = useQuery({ queryKey: ["compare", roleId, (ids ?? []).join(",")], queryFn: () => api.get<CompareView>(`/api/v1/roles/${roleId}/compare?ids=${(ids ?? []).join(",")}`), enabled: !!ids?.length });
  return (
    <Card title="Compare candidates" aside={<span className="small muted">{picked.length} of {COMPARE_MAX} chosen</span>}>
      <p className="small muted" style={{ margin: 0 }}>Tick up to five people, then compare.</p>
      <div className="row" style={{ flexWrap: "wrap", gap: 12, marginTop: 8 }}>
        {candidates.map((c) => (
          <label key={c.id} className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={picked.includes(c.id)} disabled={!picked.includes(c.id) && picked.length >= COMPARE_MAX} onChange={(e) => setPicked((p) => togglePick(p, c.id, e.target.checked))} />
            {c.name} <span className="muted">({c.stageLabel})</span>
            {c.score !== undefined && c.score !== null ? <ScoreBadge score={c.score} size="sm" /> : null}
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

/** One requirement for one person: the finding, a small bar, % met and the points it cost, and their words behind a click. */
function Cell({ c, keyName, mustHave }: { c: CompareCandidateView; keyName: string; mustHave: boolean }) {
  const cell = criterionCell(c, keyName, mustHave);
  if (cell.state !== "judged") return <span className="small muted">{cell.words}{cell.state === "raw" && cell.quote ? ` ("${cell.quote}")` : ""}</span>;
  return (
    <div className="cmp-cell">
      <span className="small">{cell.words}</span>
      <ScoreBar pctMet={cell.pctMet} mustHave={cell.mustHave} size="sm" />
      <span className="cmp-figures">{cellFigures(cell)}</span>
      {cell.quote ? (
        <details className="small">
          <summary>Their words</summary>
          <span className="muted">"{cell.quote}"</span>
        </details>
      ) : null}
    </div>
  );
}

/** One person's team notes in a cell: who wrote each, a line of it, and the whole note one click away. */
function NotesCell({ notes }: { notes: NoteView[] }) {
  if (!notes.length) return <span className="small muted">No notes yet</span>;
  return (
    <div className="cmp-cell">
      {notes.map((n) => (
        <details key={n.id} className="small">
          <summary><strong>{n.mine ? "You" : n.author.name}</strong>{n.starterLabel ? ` · ${n.starterLabel}` : ""}: {noteExcerpt(n.body, 80)}</summary>
          <p className="note-body">{n.body}</p>
        </details>
      ))}
    </div>
  );
}

/** People as columns, their scores on top, then must-haves and skills as rows; a link back to each person's panel. */
export function CompareTable({ data }: { data: CompareView }) {
  const [order, setOrder] = useState<CompareOrder>("chosen");
  const cands = orderCandidates(data.candidates, order);
  const notes = versionNotes(cands);
  const withNotes = hasTeamNotes(cands);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <span className="small muted">{orderLine(order, cands.length)}</span>
        {cands.length > 1 ? <Segmented value={order} onChange={setOrder} options={COMPARE_ORDERS.map((o) => ({ value: o.value, label: o.label }))} ariaLabel="Order of the columns" /> : null}
      </div>
      <Table head={["What we checked", ...cands.map((c) => c.name)]} label="Candidates compared" pinFirst>
        <tr>
          <th scope="row" className="small muted">Match score</th>
          {cands.map((c) => {
            const s = scoreSummary(c);
            return (
              <td key={c.applicationId}>
                <div className="cmp-cell">
                  <span className="row" style={{ gap: 6 }}><ScoreBadge score={s.score} size="sm" />{s.band ? <span className="small">{s.band}</span> : null}</span>
                  {s.coverage ? <span className="cmp-figures">{s.coverage}</span> : null}
                  {s.missing.map((x) => <Chip key={x} tone="critical">{x}</Chip>)}
                </div>
              </td>
            );
          })}
        </tr>
        <tr><th scope="row" className="small muted">Where they are</th>{cands.map((c) => <td key={c.applicationId}><StatusChip stage={c.stage} label={c.ownerStageLabel ?? c.stageLabel} group={c.group} /></td>)}</tr>
        {data.mustHaves.map((m) => <tr key={`mh:${m.key}`}><th scope="row" className="small"><span className="sbar-tag must">Must-have</span> {m.text}</th>{cands.map((c) => <td key={c.applicationId}><Cell c={c} keyName={m.key} mustHave /></td>)}</tr>)}
        {data.competencies.map((x) => {
          const tag = skillTag(cands, x.key);
          return <tr key={`sk:${x.key}`}><th scope="row" className="small" title={x.definition}>{tag ? <><span className="sbar-tag">{tag}</span> </> : null}{x.name}</th>{cands.map((c) => <td key={c.applicationId}><Cell c={c} keyName={x.key} mustHave={false} /></td>)}</tr>;
        })}
        <tr><th scope="row" className="small muted">Screening chat</th>{cands.map((c) => <td key={c.applicationId} className="small">{c.screen ? REC_LABEL[c.screen.recommendation] ?? c.screen.recommendation.replace(/_/g, " ") : <span className="muted">no screening chat yet</span>}</td>)}</tr>
        <tr><th scope="row" className="small muted">AI review of the résumé</th>{cands.map((c) => <td key={c.applicationId} className="small">{c.resume ? overallLabel(c.resume.overall) : <span className="muted">not reviewed yet</span>}</td>)}</tr>
        <tr><th scope="row" className="small muted">Still unknown</th>{cands.map((c) => <td key={c.applicationId} className="small">{c.unknownCount}</td>)}</tr>
        {/* The team's private notes (plan H3), for those who read notes; never the candidate's, never the AI's. */}
        {withNotes ? <tr><th scope="row" className="small muted">Team notes <span className="sr-only">(private)</span></th>{cands.map((c) => <td key={c.applicationId}><NotesCell notes={c.notes ?? []} /></td>)}</tr> : null}
        <tr><th scope="row" className="small muted">Their panel</th>{cands.map((c) => <td key={c.applicationId}><Link to={c.open} className="btn quiet sm">Open</Link></td>)}</tr>
      </Table>
      {notes.length ? <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--caution)" }}>{notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
      <p className="small muted" style={{ marginTop: 8 }}>{data.reminder}</p>
    </div>
  );
}

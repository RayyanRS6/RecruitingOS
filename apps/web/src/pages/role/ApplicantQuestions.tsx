"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CHOICE_OPTIONS_MAX, COMPANY_QUESTIONS_LABEL, PACKET_VISIBILITY_LABEL, QUICK_QUESTIONS_LABEL, QUICK_QUESTIONS_MAX, WRITTEN_QUESTIONS_LABEL, WRITTEN_QUESTIONS_MAX } from "@ros/contracts";
import { Alert, Button, Card, Chip, Field, IconButton } from "@ros/ui";
import { api, ApiError, type NewVersionResponse, type WhoPosts } from "../../api/client";
import { savedVersionToast } from "../../publishing";
import { toast } from "../../toast";
import { moveRow } from "../new-role/packet-form";
import {
  APPLICANT_QUESTIONS_LEDE, FAIRNESS_LINE, QUICK_HINT, QUICK_KINDS, SCREENING_FALLBACK_LINE, WRITTEN_HINT,
  eligibilityList, newQuickRow, newWrittenRow, questionsOf, questionsPayload, questionsProblem, quickAnswerWords, quickRowsFrom, refusalsByRow, withKind, writtenList, writtenRowsFrom, writtenSource,
  type PacketWithQuestions, type QuickKind, type QuickRow, type WrittenRow,
} from "./applicant-questions";

/**
 * "Questions every applicant answers" (Wave S7) on the job's Scoring tab: the quick questions on the application form
 * (the yes/no questions that may hold an application first, then the company's own choice and number questions) and the
 * written questions the chat asks, whose answers are written up from the applicant's own words. Anyone who may edit the
 * job changes them here; a save is a new version, through the fairness check and the approval rules like every edit.
 * The yes/no questions that may hold an application are changed in the job editor (`onEditEligibility`).
 */
export function ApplicantQuestions(props: {
  roleId: string;
  /** The version the tab shows. */
  packet: PacketWithQuestions;
  /** The newest version, which a change starts from; null when the job cannot be changed here. */
  editBase: { version: number; packet: PacketWithQuestions } | null;
  whoPosts: WhoPosts;
  onEditEligibility?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const p = props.packet;
  const eligibility = eligibilityList(p);
  const quick = questionsOf(p).quick;
  const written = writtenList(p);
  const source = writtenSource(p);
  const base = props.editBase;
  return (
    <Card title={COMPANY_QUESTIONS_LABEL} aside={<Chip>{PACKET_VISIBILITY_LABEL.asked}</Chip>}>
      <div className="stack" style={{ gap: 14 }}>
        <p className="small muted" style={{ margin: 0 }}>{APPLICANT_QUESTIONS_LEDE}</p>
        {editing && base ? (
          <QuestionsEditor key={base.version} roleId={props.roleId} baseVersion={base.version} packet={base.packet} whoPosts={props.whoPosts} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="stack" style={{ gap: 6 }}>
              <h3 style={{ fontSize: 13.5, margin: 0 }}>{QUICK_QUESTIONS_LABEL}</h3>
              {eligibility.length || quick.length ? (
                <ol style={{ paddingLeft: 18, margin: 0 }}>
                  {eligibility.map((e) => (
                    <li key={e.key}>{e.question} <Chip>Yes or no</Chip> {e.holds ? <Chip tone="needs">A "no" holds it for your decision</Chip> : null}</li>
                  ))}
                  {quick.map((q) => (
                    <li key={q.key}>
                      {q.question} <Chip>{quickAnswerWords(q)}</Chip> {q.required ? null : <Chip>They may skip it</Chip>}
                      {q.help ? <><br /><span className="small muted">{q.help}</span></> : null}
                    </li>
                  ))}
                </ol>
              ) : <p className="small muted" style={{ margin: 0 }}>None yet. Applicants send their details and go straight to the chat.</p>}
            </div>
            <div className="stack" style={{ gap: 6 }}>
              <h3 style={{ fontSize: 13.5, margin: 0 }}>{WRITTEN_QUESTIONS_LABEL}</h3>
              {source === "screening" ? <p className="small muted" style={{ margin: 0 }}>{SCREENING_FALLBACK_LINE}</p> : null}
              {written.length ? (
                <ol style={{ paddingLeft: 18, margin: 0 }}>
                  {written.map((q) => (
                    <li key={q.key}>
                      {q.question} {q.required ? null : <Chip>They may skip it</Chip>}
                      {q.lookFor ? <><br /><span className="small muted">What a good answer shows ({PACKET_VISIBILITY_LABEL.internal.toLowerCase()}): {q.lookFor}</span></> : null}
                    </li>
                  ))}
                </ol>
              ) : <p className="small muted" style={{ margin: 0 }}>None yet.</p>}
            </div>
            <p className="small muted" style={{ margin: 0 }}>{FAIRNESS_LINE}</p>
            {base || props.onEditEligibility ? (
              <div className="row">
                {base ? <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Change these questions</Button> : null}
                {props.onEditEligibility ? <Button size="sm" variant="quiet" onClick={props.onEditEligibility}>Change the yes/no questions that may hold an application</Button> : null}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Card>
  );
}

/**
 * The two lists as rows, seeded once from the newest version (mounted only while editing, keyed by that version). Only a
 * list that was touched is sent, so saving the quick questions never turns the screening questions into written ones.
 */
export function QuestionsEditor(props: { roleId: string; baseVersion: number; packet: PacketWithQuestions; whoPosts: WhoPosts; onDone: () => void }) {
  const qc = useQueryClient();
  const [quick, setQuickRows] = useState<QuickRow[]>(() => quickRowsFrom(props.packet));
  const [written, setWrittenRows] = useState<WrittenRow[]>(() => writtenRowsFrom(props.packet));
  const [changed, setChanged] = useState({ quick: false, written: false });
  const [problem, setProblem] = useState<string | null>(null);
  const setQuick = (rows: QuickRow[]) => { setQuickRows(rows); setChanged((c) => ({ ...c, quick: true })); };
  const setWritten = (rows: WrittenRow[]) => { setWrittenRows(rows); setChanged((c) => ({ ...c, written: true })); };
  const save = useMutation({
    mutationFn: () => api.put<NewVersionResponse>(`/api/v1/roles/${props.roleId}/company-questions`, questionsPayload({ baseVersion: props.baseVersion, quick, written, quickChanged: changed.quick, writtenChanged: changed.written })),
    onSuccess: async (r) => {
      const t = savedVersionToast(r, props.whoPosts);
      toast(t.title, t.detail);
      props.onDone();
      await qc.invalidateQueries({ queryKey: ["role", props.roleId] });
      await qc.invalidateQueries({ queryKey: ["roles"] });
      await qc.invalidateQueries({ queryKey: ["brief"] });
    },
  });
  const refusals = save.error instanceof ApiError && save.error.code === "question_not_allowed" ? refusalsByRow(save.error.details, { quick, written }) : new Map<string, string>();
  const submit = () => {
    if (!changed.quick && !changed.written) {
      setProblem("Nothing was changed.");
      return;
    }
    const p = questionsProblem(quick, written);
    setProblem(p);
    if (!p) save.mutate();
  };
  const quickFilled = quick.filter((r) => r.question.trim()).length;
  const writtenFilled = written.filter((r) => r.question.trim()).length;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend style={{ fontWeight: 600, fontSize: 13.5, padding: 0, marginBottom: 6 }}>{`${QUICK_QUESTIONS_LABEL} (up to ${QUICK_QUESTIONS_MAX})`}</legend>
        <span className="hint">{QUICK_HINT}</span>
        <QuickRows rows={quick} onChange={setQuick} refusals={refusals} />
        <span className="small muted">{quickFilled >= QUICK_QUESTIONS_MAX ? `That is the most there can be (${QUICK_QUESTIONS_MAX}).` : null}</span>
      </fieldset>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend style={{ fontWeight: 600, fontSize: 13.5, padding: 0, marginBottom: 6 }}>{`${WRITTEN_QUESTIONS_LABEL} (up to ${WRITTEN_QUESTIONS_MAX})`}</legend>
        <span className="hint">{WRITTEN_HINT}</span>
        {writtenSource(props.packet) === "screening" ? <p className="small muted" style={{ margin: "0 0 6px" }}>{SCREENING_FALLBACK_LINE}</p> : null}
        <WrittenRows rows={written} onChange={setWritten} refusals={refusals} />
        <span className="small muted">{writtenFilled > WRITTEN_QUESTIONS_MAX ? `Keep at most ${WRITTEN_QUESTIONS_MAX}; take ${writtenFilled - WRITTEN_QUESTIONS_MAX} out.` : null}</span>
      </fieldset>
      <p className="small muted" style={{ margin: 0 }}>{FAIRNESS_LINE}</p>
      {problem ? <Alert tone="caution">{problem}</Alert> : null}
      {save.error ? <Alert tone="critical">{save.error instanceof ApiError ? save.error.message : "Could not save."}</Alert> : null}
      <div className="row">
        <Button variant="primary" loading={save.isPending} onClick={submit}>Save as a new version</Button>
        <Button variant="ghost" disabled={save.isPending} onClick={props.onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function QuickRows({ rows, onChange, refusals }: { rows: QuickRow[]; onChange: (rows: QuickRow[]) => void; refusals: Map<string, string> }) {
  const update = (i: number, patch: Partial<QuickRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.length ? null : <p className="small muted" style={{ margin: 0 }}>None yet.</p>}
      {rows.map((r, i) => {
        const refused = refusals.get(`quick:${i}`);
        return (
          <div key={r.key ?? `new-${i}`} className="stack" style={{ gap: 6, padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
            <Field label={`${i + 1}. Question`} htmlFor={`cq-q-${i}`}><input id={`cq-q-${i}`} className="input" value={r.question} maxLength={200} onChange={(e) => update(i, { question: e.target.value })} placeholder="e.g. How will you get to work?" /></Field>
            {refused ? <Alert tone="critical">{refused}</Alert> : null}
            <div className="grid-2">
              <Field label="Answered with" htmlFor={`cq-kind-${i}`}>
                <select id={`cq-kind-${i}`} className="select" value={r.kind} onChange={(e) => onChange(rows.map((x, j) => (j === i ? withKind(x, e.target.value as QuickKind) : x)))}>
                  {QUICK_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </Field>
              <Field label="Help line (optional)" htmlFor={`cq-help-${i}`}><input id={`cq-help-${i}`} className="input" value={r.help} maxLength={200} onChange={(e) => update(i, { help: e.target.value })} placeholder="e.g. We start at 7am." /></Field>
            </div>
            {r.kind === "choice" ? (
              <Field label={`The answers to choose from, one a line (2 to ${CHOICE_OPTIONS_MAX})`} htmlFor={`cq-opts-${i}`}><textarea id={`cq-opts-${i}`} className="textarea" style={{ minHeight: 80 }} value={r.options} onChange={(e) => update(i, { options: e.target.value })} placeholder={"My own car\nPublic transport\nBike or on foot"} /></Field>
            ) : null}
            {r.kind === "number" ? (
              <div className="grid-2">
                <Field label="Unit (optional)" htmlFor={`cq-unit-${i}`}><input id={`cq-unit-${i}`} className="input" value={r.unit} maxLength={30} onChange={(e) => update(i, { unit: e.target.value })} placeholder="e.g. years" /></Field>
                <div className="row" style={{ flexWrap: "nowrap", alignItems: "flex-end" }}>
                  <Field label="Smallest" htmlFor={`cq-min-${i}`}><input id={`cq-min-${i}`} className="input" inputMode="decimal" value={r.min} onChange={(e) => update(i, { min: e.target.value })} /></Field>
                  <Field label="Largest" htmlFor={`cq-max-${i}`}><input id={`cq-max-${i}`} className="input" inputMode="decimal" value={r.max} onChange={(e) => update(i, { max: e.target.value })} /></Field>
                </div>
              </div>
            ) : null}
            <div className="row">
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={r.required} onChange={(e) => update(i, { required: e.target.checked })} /> Every applicant must answer it</label>
              <span style={{ marginLeft: "auto" }} className="row">
                <IconButton icon="chevron-up" size="sm" label={`Move quick question ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveRow(rows, i, -1))} />
                <IconButton icon="chevron-down" size="sm" label={`Move quick question ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => onChange(moveRow(rows, i, 1))} />
                <Button size="sm" variant="quiet" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
              </span>
            </div>
          </div>
        );
      })}
      <div className="row"><Button size="sm" disabled={rows.length >= QUICK_QUESTIONS_MAX} onClick={() => onChange([...rows, newQuickRow()])}>Add a quick question</Button></div>
    </div>
  );
}

function WrittenRows({ rows, onChange, refusals }: { rows: WrittenRow[]; onChange: (rows: WrittenRow[]) => void; refusals: Map<string, string> }) {
  const update = (i: number, patch: Partial<WrittenRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack" style={{ gap: 8 }}>
      {rows.length ? null : <p className="small muted" style={{ margin: 0 }}>None yet.</p>}
      {rows.map((r, i) => {
        const refused = refusals.get(`written:${i}`);
        return (
          <div key={r.key ?? `new-${i}`} className="stack" style={{ gap: 6, padding: 10, border: "1px solid var(--line)", borderRadius: 8 }}>
            <Field label={`${i + 1}. Question`} htmlFor={`wq-q-${i}`}><input id={`wq-q-${i}`} className="input" value={r.question} maxLength={400} onChange={(e) => update(i, { question: e.target.value })} placeholder="e.g. Tell us about a time you calmed a nervous patient." /></Field>
            <Field label={`What a good answer shows (${PACKET_VISIBILITY_LABEL.internal.toLowerCase()})`} htmlFor={`wq-look-${i}`}><input id={`wq-look-${i}`} className="input" value={r.lookFor} maxLength={400} onChange={(e) => update(i, { lookFor: e.target.value })} placeholder="e.g. A real example: what they noticed, what they did, how it ended" /></Field>
            {refused ? <Alert tone="critical">{refused}</Alert> : null}
            <div className="row">
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={r.required} onChange={(e) => update(i, { required: e.target.checked })} /> Every applicant must answer it (they can still skip, and say why)</label>
              <span style={{ marginLeft: "auto" }} className="row">
                <IconButton icon="chevron-up" size="sm" label={`Move written question ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveRow(rows, i, -1))} />
                <IconButton icon="chevron-down" size="sm" label={`Move written question ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => onChange(moveRow(rows, i, 1))} />
                <Button size="sm" variant="quiet" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
              </span>
            </div>
          </div>
        );
      })}
      <div className="row"><Button size="sm" disabled={rows.length >= WRITTEN_QUESTIONS_MAX} onClick={() => onChange([...rows, newWrittenRow()])}>Add a written question</Button></div>
    </div>
  );
}

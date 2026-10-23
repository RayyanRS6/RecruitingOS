"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CHOICE_OPTIONS_MAX, COMPANY_QUESTIONS_LABEL, PACKET_VISIBILITY_LABEL, QUICK_QUESTIONS_LABEL, QUICK_QUESTIONS_MAX, WRITTEN_QUESTIONS_LABEL, WRITTEN_QUESTIONS_MAX } from "@ros/contracts";
import { Alert, Button, Card, Chip, Field, IconButton, IconLabel } from "@ros/ui";
import { api, ApiError, type NewVersionResponse, type WhoPosts } from "../../api/client";
import { savedVersionToast } from "../../publishing";
import { toast } from "../../toast";
import { moveRow } from "../new-role/packet-form";
import {
  APPLICANT_QUESTIONS_LEDE, FAIRNESS_LINE, LOOK_FOR_USE, QUICK_HINT, QUICK_KINDS, SCREENING_FALLBACK_LINE,
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
    // the eye: candidates are asked these (its words are its accessible name and tooltip, as on the job's other cards;
    // the kit centres it in the title row)
    <Card title={COMPANY_QUESTIONS_LABEL} aside={<IconLabel icon="eye" label={PACKET_VISIBILITY_LABEL.asked} />}>
      <div className="stack gap-5">
        <p className="small muted max-w-[80ch]">{APPLICANT_QUESTIONS_LEDE}</p>
        {editing && base ? (
          <QuestionsEditor key={base.version} roleId={props.roleId} baseVersion={base.version} packet={base.packet} whoPosts={props.whoPosts} onDone={() => setEditing(false)} />
        ) : (
          <>
            <div className="stack gap-2">
              <h3 className={LIST_HEADING}>{QUICK_QUESTIONS_LABEL}</h3>
              {eligibility.length || quick.length ? (
                // the questions as rows in one bordered box (screenshot 6's table rows), numbered as the form asks them
                <ol className={QUESTION_LIST}>
                  {eligibility.map((e, i) => (
                    <li key={e.key} className={QUESTION_ROW}>
                      <span className="ordinal mt-px">{i + 1}</span>
                      <span className="min-w-0 flex-1"><span className="mr-1">{e.question}</span> <Chip>Yes or no</Chip> {e.holds ? <Chip tone="needs">A "no" holds it for your decision</Chip> : null}</span>
                    </li>
                  ))}
                  {quick.map((q, i) => (
                    <li key={q.key} className={QUESTION_ROW}>
                      <span className="ordinal mt-px">{eligibility.length + i + 1}</span>
                      <span className="grid min-w-0 flex-1 gap-1">
                        <span><span className="mr-1">{q.question}</span> <Chip>{quickAnswerWords(q)}</Chip> {q.required ? null : <Chip>They may skip it</Chip>}</span>
                        {q.help ? <span className="small muted">{q.help}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : <p className="small muted">None yet.</p>}
            </div>
            <div className="stack gap-2">
              <h3 className={LIST_HEADING}>{WRITTEN_QUESTIONS_LABEL}</h3>
              {source === "screening" ? <p className="small muted">{SCREENING_FALLBACK_LINE}</p> : null}
              {written.length ? (
                <ol className={QUESTION_LIST}>
                  {written.map((q, i) => (
                    <li key={q.key} className={QUESTION_ROW}>
                      <span className="ordinal mt-px">{i + 1}</span>
                      <span className="grid min-w-0 flex-1 gap-1">
                        <span><span className="mr-1">{q.question}</span> {q.required ? null : <Chip>They may skip it</Chip>}</span>
                        {q.lookFor ? <span className="small muted">What a good answer shows ({PACKET_VISIBILITY_LABEL.internal.toLowerCase()}): {q.lookFor}</span> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : <p className="small muted">None yet.</p>}
            </div>
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
    <div className="stack gap-6">
      <fieldset className="field gap-2">
        <legend className={LEGEND}>{`${QUICK_QUESTIONS_LABEL} (up to ${QUICK_QUESTIONS_MAX})`}</legend>
        <span className="hint">{QUICK_HINT}</span>
        <QuickRows rows={quick} onChange={setQuick} refusals={refusals} />
        {quickFilled >= QUICK_QUESTIONS_MAX ? <span className="small muted">{`That is the most there can be (${QUICK_QUESTIONS_MAX}).`}</span> : null}
      </fieldset>
      {/* "What a good answer shows" says in its own label that only the team sees it, and in its tooltip that the chat
          reads it (LOOK_FOR_USE) */}
      <fieldset className="field gap-2">
        <legend className={LEGEND}>{`${WRITTEN_QUESTIONS_LABEL} (up to ${WRITTEN_QUESTIONS_MAX})`}</legend>
        {writtenSource(props.packet) === "screening" ? <p className="small muted">{SCREENING_FALLBACK_LINE}</p> : null}
        <WrittenRows rows={written} onChange={setWritten} refusals={refusals} />
        {writtenFilled > WRITTEN_QUESTIONS_MAX ? <span className="small muted">{`Keep at most ${WRITTEN_QUESTIONS_MAX}; take ${writtenFilled - WRITTEN_QUESTIONS_MAX} out.`}</span> : null}
      </fieldset>
      <p className="small muted">{FAIRNESS_LINE}</p>
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
    <div className="stack gap-3">
      {rows.length ? null : <p className="small muted">None yet.</p>}
      {rows.map((r, i) => {
        const refused = refusals.get(`quick:${i}`);
        return (
          <div key={r.key ?? `new-${i}`} className={EDIT_ROW}>
            <Field label={`${i + 1}. Question`} htmlFor={`cq-q-${i}`}><input id={`cq-q-${i}`} className="input" value={r.question} maxLength={200} onChange={(e) => update(i, { question: e.target.value })} placeholder="e.g. How will you get to work?" /></Field>
            {refused ? <Alert tone="critical">{refused}</Alert> : null}
            <div className={PAIR}>
              <Field label="Answered with" htmlFor={`cq-kind-${i}`}>
                <select id={`cq-kind-${i}`} className="select" value={r.kind} onChange={(e) => onChange(rows.map((x, j) => (j === i ? withKind(x, e.target.value as QuickKind) : x)))}>
                  {QUICK_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </select>
              </Field>
              <Field label="Help line (optional)" htmlFor={`cq-help-${i}`}><input id={`cq-help-${i}`} className="input" value={r.help} maxLength={200} onChange={(e) => update(i, { help: e.target.value })} placeholder="e.g. We start at 7am." /></Field>
            </div>
            {r.kind === "choice" ? (
              <Field label={`The answers to choose from, one a line (2 to ${CHOICE_OPTIONS_MAX})`} htmlFor={`cq-opts-${i}`}><textarea id={`cq-opts-${i}`} className="textarea min-h-20" value={r.options} onChange={(e) => update(i, { options: e.target.value })} placeholder={"My own car\nPublic transport\nBike or on foot"} /></Field>
            ) : null}
            {r.kind === "number" ? (
              <div className={PAIR}>
                <Field label="Unit (optional)" htmlFor={`cq-unit-${i}`}><input id={`cq-unit-${i}`} className="input" value={r.unit} maxLength={30} onChange={(e) => update(i, { unit: e.target.value })} placeholder="e.g. years" /></Field>
                <div className="grid grid-cols-2 items-end gap-3">
                  <Field label="Smallest" htmlFor={`cq-min-${i}`}><input id={`cq-min-${i}`} className="input" inputMode="decimal" value={r.min} onChange={(e) => update(i, { min: e.target.value })} /></Field>
                  <Field label="Largest" htmlFor={`cq-max-${i}`}><input id={`cq-max-${i}`} className="input" inputMode="decimal" value={r.max} onChange={(e) => update(i, { max: e.target.value })} /></Field>
                </div>
              </div>
            ) : null}
            <div className={ROW_FOOT}>
              <label className={REQUIRED}><input type="checkbox" checked={r.required} onChange={(e) => update(i, { required: e.target.checked })} /> Every applicant must answer it</label>
              <span className="row ml-auto gap-1.5">
                <IconButton icon="chevron-up" size="sm" label={`Move quick question ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveRow(rows, i, -1))} />
                <IconButton icon="chevron-down" size="sm" label={`Move quick question ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => onChange(moveRow(rows, i, 1))} />
                <Button size="sm" variant="quiet" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
              </span>
            </div>
          </div>
        );
      })}
      <div className="row"><Button size="sm" icon="plus" disabled={rows.length >= QUICK_QUESTIONS_MAX} onClick={() => onChange([...rows, newQuickRow()])}>Add a quick question</Button></div>
    </div>
  );
}

function WrittenRows({ rows, onChange, refusals }: { rows: WrittenRow[]; onChange: (rows: WrittenRow[]) => void; refusals: Map<string, string> }) {
  const update = (i: number, patch: Partial<WrittenRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack gap-3">
      {rows.length ? null : <p className="small muted">None yet.</p>}
      {rows.map((r, i) => {
        const refused = refusals.get(`written:${i}`);
        return (
          <div key={r.key ?? `new-${i}`} className={EDIT_ROW}>
            <Field label={`${i + 1}. Question`} htmlFor={`wq-q-${i}`}><input id={`wq-q-${i}`} className="input" value={r.question} maxLength={400} onChange={(e) => update(i, { question: e.target.value })} placeholder="e.g. Tell us about a time you calmed a nervous patient." /></Field>
            <Field label={`What a good answer shows (${PACKET_VISIBILITY_LABEL.internal.toLowerCase()})`} htmlFor={`wq-look-${i}`}><input id={`wq-look-${i}`} className="input" title={LOOK_FOR_USE} value={r.lookFor} maxLength={400} onChange={(e) => update(i, { lookFor: e.target.value })} placeholder="e.g. A real example: what they noticed, what they did, how it ended" /></Field>
            {refused ? <Alert tone="critical">{refused}</Alert> : null}
            <div className={ROW_FOOT}>
              <label className={REQUIRED}><input type="checkbox" checked={r.required} onChange={(e) => update(i, { required: e.target.checked })} /> Every applicant must answer it (they can still skip, and say why)</label>
              <span className="row ml-auto gap-1.5">
                <IconButton icon="chevron-up" size="sm" label={`Move written question ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moveRow(rows, i, -1))} />
                <IconButton icon="chevron-down" size="sm" label={`Move written question ${i + 1} down`} disabled={i === rows.length - 1} onClick={() => onChange(moveRow(rows, i, 1))} />
                <Button size="sm" variant="quiet" onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</Button>
              </span>
            </div>
          </div>
        );
      })}
      <div className="row"><Button size="sm" icon="plus" disabled={rows.length >= WRITTEN_QUESTIONS_MAX} onClick={() => onChange([...rows, newWrittenRow()])}>Add a written question</Button></div>
    </div>
  );
}

/** The card's two lists: a small heading over the questions as numbered rows in one bordered box (screenshot 6); the
 * number beside each is the kit's `ordinal`, as on the job page's other lists. */
const LIST_HEADING = "text-[14px] font-semibold";
const QUESTION_LIST = "overflow-hidden rounded-xl border border-line bg-surface";
const QUESTION_ROW = "flex items-start gap-3 border-t border-line px-4 py-3 text-[14.5px] first:border-t-0";
/** The editor: each question a quiet card of its own (the application form's look, screenshot 5), its controls at its foot. */
const LEGEND = "mb-1 text-[14px] font-semibold text-ink";
const EDIT_ROW = "stack gap-3 rounded-xl border border-line bg-surface p-4";
const PAIR = "grid grid-cols-1 gap-3 sm:grid-cols-2";
const ROW_FOOT = "flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3";
const REQUIRED = "flex min-h-10 cursor-pointer items-center gap-2 text-[14px]";

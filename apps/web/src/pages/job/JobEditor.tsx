"use client";

import { type ReactNode, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  EMPLOYMENT_TYPE_LABEL, FORM_QUESTION_KIND_LABEL, FORM_QUESTIONS_MAX, IMPORTANCE_LABEL, MUST_HAVES_MAX, REMOTE_POLICY_LABEL, SCREENING_QUESTIONS_MAX, COMPETENCIES_MAX,
  type DraftFieldEdit, type DraftRolePacket, type DraftSaved, type EmploymentType, type FormQuestionKind, type Importance, type IntakeSessionResponse, type PacketFieldEdit, type PacketSaved,
  type RemotePolicy, type RolePacket,
} from "@ros/contracts";
import { Alert, Button, cn, Drawer, Field, IconButton, Segmented } from "@ros/ui";
import { api, errorCode, errorWords } from "../../api/client";
import { sessionKey } from "../../builder";
import {
  flagsOf, hasChanges, jobEdit, jobFormFrom, jobFormProblem, keepFlagsOf, moveRow, newFormRow, newInterviewRow, newPlace, newSkill, newTextRow, questionRefusalsOf,
  type FormRow, type InterviewRow, type JobForm, type PlaceRow, type SkillRow, type TextRow,
} from "../../job-editor";
import { SeenBy } from "./JobRecord";

/** What is being edited: a published job (its newest version, which must still be the newest when the save arrives), or a written draft. */
export type EditTarget = { kind: "job"; roleId: string; baseVersion: number; live: boolean } | { kind: "draft"; sessionId: string };

/** One group of fields: a bordered card on the drawer's paper. */
const GROUP = "field gap-3 rounded-2xl border border-line bg-surface p-4 shadow-xs sm:p-5";
/** A group's name: a legend floated so it sits inside the card, not across its border. */
const LEGEND = "float-left col-span-full flex w-full items-center gap-2 p-0 font-display text-[17px] font-bold leading-tight tracking-[-0.02em] text-ink";
/** One row inside a group (a skill, a question): a quieter box. */
const ROW_BOX = "grid gap-3 rounded-xl border border-line bg-ground/60 p-3.5";

const EMPLOYMENT = Object.keys(EMPLOYMENT_TYPE_LABEL) as EmploymentType[];
const ARRANGEMENTS = Object.keys(REMOTE_POLICY_LABEL) as RemotePolicy[];
const IMPORTANCES = Object.keys(IMPORTANCE_LABEL) as Importance[];
const KINDS = Object.keys(FORM_QUESTION_KIND_LABEL) as FormQuestionKind[];

const updateAt = <T,>(rows: readonly T[], i: number, patch: Partial<T>): T[] => rows.map((r, j) => (j === i ? { ...r, ...patch } : r));
const removeAt = <T,>(rows: readonly T[], i: number): T[] => rows.filter((_, j) => j !== i);

/**
 * The one editor of a job: every part of the record a person may change, as plain fields. On a published job a save
 * makes a new version that is live at once; on a written draft it is simply saved. Only what changed is sent. Wording
 * the fairness check flags on a published job holds the save until it is changed, or kept with a reason typed here.
 */
export function JobEditor({ packet, target, onClose, onSaved }: { packet: RolePacket | DraftRolePacket; target: EditTarget; onClose: () => void; onSaved: (guardChanges: string[]) => void }) {
  const qc = useQueryClient();
  const [base] = useState(() => jobFormFrom(packet));
  const [form, setForm] = useState(base);
  const [problem, setProblem] = useState<string | null>(null);
  const [keep, setKeep] = useState<Record<string, string>>({});
  const set = (patch: Partial<JobForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setProblem(null);
  };
  const edit: DraftFieldEdit = jobEdit(base, form);
  const save = useMutation({
    mutationFn: async (): Promise<string[]> => {
      if (target.kind === "draft") {
        const r = await api.patch<DraftSaved>(`/api/v1/intake/sessions/${target.sessionId}/draft`, edit);
        qc.setQueryData<IntakeSessionResponse>(sessionKey(target.sessionId), { session: r.session, timeZone: r.timeZone });
        return r.guardChanges;
      }
      const keepFlags = keepFlagsOf(keep);
      const body: PacketFieldEdit = { baseVersion: target.baseVersion, ...edit, ...(keepFlags.length ? { keepFlags } : {}) };
      const r = await api.patch<PacketSaved>(`/api/v1/roles/${target.roleId}/packet`, body);
      qc.setQueryData(["role", target.roleId], r.role);
      for (const key of [["roles"], ["home"], ["share", target.roleId], ["candidates", target.roleId]]) qc.invalidateQueries({ queryKey: key });
      return r.guardChanges;
    },
    onSuccess: onSaved,
  });
  const submit = () => {
    const p = jobFormProblem(form);
    setProblem(p);
    if (!p) save.mutate();
  };
  const flags = flagsOf(save.error);
  const refusals = questionRefusalsOf(save.error);
  const stale = errorCode(save.error) === "stale_version";
  const reload = () => {
    if (target.kind === "job") qc.invalidateQueries({ queryKey: ["role", target.roleId] });
    onClose();
  };
  return (
    <Drawer open onClose={onClose} title="Edit the job" size="lg">
      <div className="stack gap-4">
        <Group legend="The job" seen={<SeenBy v="public" />}>
          <Field label="Job title" htmlFor="ed-title"><input id="ed-title" className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} /></Field>
          <Places rows={form.places} onChange={(places) => set({ places })} />
          <div className="grid-2">
            <Field label="Work arrangement" htmlFor="ed-arrangement">
              <select id="ed-arrangement" className="select" value={form.remotePolicy} onChange={(e) => set({ remotePolicy: e.target.value as RemotePolicy })}>
                {ARRANGEMENTS.map((v) => <option key={v} value={v}>{REMOTE_POLICY_LABEL[v]}</option>)}
              </select>
            </Field>
            <Field label="Type" htmlFor="ed-type">
              <select id="ed-type" className="select" value={form.employmentType} onChange={(e) => set({ employmentType: e.target.value as EmploymentType })}>
                {EMPLOYMENT.map((v) => <option key={v} value={v}>{EMPLOYMENT_TYPE_LABEL[v]}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Schedule" htmlFor="ed-schedule"><input id="ed-schedule" className="input" value={form.schedule} onChange={(e) => set({ schedule: e.target.value })} placeholder="e.g. Monday to Thursday, 8 to 5" /></Field>
          <Field label="Department (optional)" htmlFor="ed-department" aside={<SeenBy v="internal" />}><input id="ed-department" className="input" value={form.department} onChange={(e) => set({ department: e.target.value })} /></Field>
        </Group>

        <Group legend="Pay" seen={<SeenBy v="public" />}>
          <Field label="Paid" htmlFor="ed-basis">
            <select id="ed-basis" className="select" value={form.basis} onChange={(e) => set({ basis: e.target.value as JobForm["basis"] })}>
              {form.basis ? null : <option value="">Choose</option>}
              <option value="hourly">By the hour</option>
              <option value="salary">A yearly salary</option>
            </select>
          </Field>
          <div className="grid-2">
            <Field label="Lowest" htmlFor="ed-pay-min"><input id="ed-pay-min" className="input" inputMode="decimal" value={form.payMin} onChange={(e) => set({ payMin: e.target.value })} /></Field>
            <Field label="Highest" htmlFor="ed-pay-max"><input id="ed-pay-max" className="input" inputMode="decimal" value={form.payMax} onChange={(e) => set({ payMax: e.target.value })} /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={form.showPay} onChange={(e) => set({ showPay: e.target.checked })} /> Show the pay range on the job page</label>
          <Field label="Benefits" htmlFor="ed-benefits"><input id="ed-benefits" className="input" value={form.benefits} onChange={(e) => set({ benefits: e.target.value })} placeholder="e.g. Health, dental, 401(k), paid time off" /></Field>
        </Group>

        <Group legend="Job description" seen={<SeenBy v="public" />}>
          <label htmlFor="ed-description" className="sr-only">Job description</label>
          <textarea id="ed-description" className="textarea min-h-[200px]" value={form.description} onChange={(e) => set({ description: e.target.value })} />
        </Group>

        <Group legend={`Must-haves (up to ${MUST_HAVES_MAX})`} seen={<SeenBy v="public" />}>
          <TextRows rows={form.mustHaves} onChange={(mustHaves) => set({ mustHaves })} idPrefix="ed-must" name="must-have" max={MUST_HAVES_MAX} placeholder="e.g. Active California RDA license" />
        </Group>

        <Group legend="Nice-to-haves" seen={<SeenBy v="public" />}>
          <TextRows rows={form.niceToHaves} onChange={(niceToHaves) => set({ niceToHaves })} idPrefix="ed-nice" name="nice-to-have" max={10} placeholder="e.g. Experience with Dentrix" />
        </Group>

        <Group legend={`Skills (up to ${COMPETENCIES_MAX})`} seen={<SeenBy v="reviewed" />}>
          <Skills rows={form.skills} onChange={(skills) => set({ skills })} />
        </Group>

        <Group legend={`Screening questions (up to ${FORM_QUESTIONS_MAX})`} seen={<SeenBy v="asked" />}>
          <FormQuestions rows={form.formQuestions} onChange={(formQuestions) => set({ formQuestions })} />
        </Group>

        <Group legend="AI interview" seen={<SeenBy v="asked" />}>
          <div className="max-w-[220px]"><Field label="Length in minutes" htmlFor="ed-minutes"><input id="ed-minutes" className="input" type="number" min={5} max={30} step={1} value={form.minutes} onChange={(e) => set({ minutes: e.target.value })} /></Field></div>
          <InterviewQuestions rows={form.interview} onChange={(interview) => set({ interview })} />
        </Group>

        <div className={cn(GROUP, "grid")}>
          {target.kind === "job" && target.live ? <p className="small text-ink-2">Saved changes show on the job page at once.</p> : null}
          {problem ? <Alert tone="caution">{problem}</Alert> : null}
          {flags.length ? (
            <section className="alert caution" aria-label="Wording to check">
              <div className="stack gap-3">
                <strong>Change this wording, or keep it and say why</strong>
                {flags.map((f) => (
                  <div key={f.id} className="grid gap-1.5">
                    <p className="wrap-anywhere"><strong>"{f.text}"</strong> {f.reason}</p>
                    {f.alternative ? <p className="small">Instead: {f.alternative}</p> : null}
                    <Field label="Why keep it" htmlFor={`ed-keep-${f.id}`}><input id={`ed-keep-${f.id}`} className="input" value={keep[f.id] ?? ""} onChange={(e) => setKeep({ ...keep, [f.id]: e.target.value })} placeholder="e.g. Required by our state licence board" /></Field>
                  </div>
                ))}
              </div>
            </section>
          ) : refusals.length ? (
            <Alert tone="critical">
              <div className="stack gap-2">
                <strong>{errorWords(save.error)}</strong>
                <ul className="grid list-disc gap-1 pl-[18px]">{refusals.map((r) => <li key={`${r.index}-${r.part}-${r.text}`}>"{r.text}": {r.reason} {r.alternative}</li>)}</ul>
              </div>
            </Alert>
          ) : stale ? (
            <Alert tone="caution">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>{errorWords(save.error)}</span>
                <Button size="sm" onClick={reload}>Reload the job</Button>
              </div>
            </Alert>
          ) : save.error ? <Alert tone="critical">{errorWords(save.error, "Could not save. Try again.")}</Alert> : null}
          <div className="row justify-end">
            <Button variant="ghost" disabled={save.isPending} onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} disabled={!hasChanges(edit)} onClick={submit}>Save</Button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}

/** A group of fields: a fieldset named by its legend; `seen` says who sees the group's words, as an icon after it. */
function Group({ legend, seen, children }: { legend: string; seen?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className={GROUP}>
      <legend className={LEGEND}>{legend}{seen}</legend>
      {children}
    </fieldset>
  );
}

/** Up, down and remove for one row of a list that keeps its order. */
function RowTools({ index, total, what, onMove, onRemove }: { index: number; total: number; what: string; onMove?: (by: -1 | 1) => void; onRemove: () => void }) {
  return (
    <span className="row justify-end gap-1.5">
      {onMove ? <IconButton icon="chevron-up" size="sm" label={`Move ${what} ${index + 1} up`} disabled={index === 0} onClick={() => onMove(-1)} /> : null}
      {onMove ? <IconButton icon="chevron-down" size="sm" label={`Move ${what} ${index + 1} down`} disabled={index === total - 1} onClick={() => onMove(1)} /> : null}
      <IconButton icon="x" size="sm" label={`Remove ${what} ${index + 1}`} onClick={onRemove} />
    </span>
  );
}

/** Where the job is: one row per place, a city and a state; at least one is kept. */
function Places({ rows, onChange }: { rows: PlaceRow[]; onChange: (rows: PlaceRow[]) => void }) {
  return (
    <div className="stack gap-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-end gap-2">
          <div className="min-w-0 flex-[2]"><Field label={i === 0 ? "City" : `City (place ${i + 1})`} htmlFor={`ed-city-${i}`}><input id={`ed-city-${i}`} className="input" value={r.city} onChange={(e) => onChange(updateAt(rows, i, { city: e.target.value }))} /></Field></div>
          <div className="min-w-0 flex-1"><Field label="State" htmlFor={`ed-region-${i}`}><input id={`ed-region-${i}`} className="input" value={r.region} maxLength={2} onChange={(e) => onChange(updateAt(rows, i, { region: e.target.value }))} placeholder="CA" /></Field></div>
          {rows.length > 1 ? <IconButton icon="x" label={`Remove place ${i + 1}`} onClick={() => onChange(removeAt(rows, i))} /> : null}
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= 20} onClick={() => onChange([...rows, newPlace()])}>Add a place</Button></div>
    </div>
  );
}

/** A list of one-line requirements, in order: reword, move, remove, add. */
function TextRows({ rows, onChange, idPrefix, name, max, placeholder }: { rows: TextRow[]; onChange: (rows: TextRow[]) => void; idPrefix: string; name: string; max: number; placeholder: string }) {
  return (
    <div className="stack gap-2">
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className="flex items-center gap-2">
          <label htmlFor={`${idPrefix}-${i}`} className="sr-only">{`${name} ${i + 1}`}</label>
          <input id={`${idPrefix}-${i}`} className="input min-w-0 flex-1" value={r.text} placeholder={placeholder} onChange={(e) => onChange(updateAt(rows, i, { text: e.target.value }))} />
          <RowTools index={i} total={rows.length} what={name} onMove={(by) => onChange(moveRow(rows, i, by))} onRemove={() => onChange(removeAt(rows, i))} />
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= max} onClick={() => onChange([...rows, newTextRow()])}>{`Add a ${name}`}</Button></div>
    </div>
  );
}

/** The skills the resume score counts beside the must-haves: what each is, how much it counts, and what it means. */
function Skills({ rows, onChange }: { rows: SkillRow[]; onChange: (rows: SkillRow[]) => void }) {
  return (
    <div className="stack gap-2.5">
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className={ROW_BOX}>
          <Field label={`${i + 1}. Skill`} htmlFor={`ed-skill-${i}`}><input id={`ed-skill-${i}`} className="input" value={r.name} onChange={(e) => onChange(updateAt(rows, i, { name: e.target.value }))} placeholder="e.g. Putting patients at ease" /></Field>
          <Field label="How much it counts">
            <Segmented value={r.importance} onChange={(importance) => onChange(updateAt(rows, i, { importance }))} ariaLabel={`How much ${r.name.trim() || `skill ${i + 1}`} counts`} options={IMPORTANCES.map((v) => ({ value: v, label: IMPORTANCE_LABEL[v] }))} />
          </Field>
          <Field label="What it means (optional)" htmlFor={`ed-skill-def-${i}`}><input id={`ed-skill-def-${i}`} className="input" value={r.definition} onChange={(e) => onChange(updateAt(rows, i, { definition: e.target.value }))} /></Field>
          <RowTools index={i} total={rows.length} what="skill" onMove={(by) => onChange(moveRow(rows, i, by))} onRemove={() => onChange(removeAt(rows, i))} />
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= COMPETENCIES_MAX} onClick={() => onChange([...rows, newSkill()])}>Add a skill</Button></div>
    </div>
  );
}

/** The application form's questions: a yes or no, a choice or a number, in the order candidates answer them. */
function FormQuestions({ rows, onChange }: { rows: FormRow[]; onChange: (rows: FormRow[]) => void }) {
  return (
    <div className="stack gap-2.5">
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className={ROW_BOX}>
          <Field label={`${i + 1}. Question`} htmlFor={`ed-form-${i}`}><input id={`ed-form-${i}`} className="input" value={r.question} onChange={(e) => onChange(updateAt(rows, i, { question: e.target.value }))} placeholder="e.g. Can you work Saturdays?" /></Field>
          <div className="grid-2">
            <Field label="Answered with" htmlFor={`ed-form-kind-${i}`}>
              <select id={`ed-form-kind-${i}`} className="select" value={r.kind} onChange={(e) => onChange(updateAt(rows, i, { kind: e.target.value as FormQuestionKind }))}>
                {KINDS.map((k) => <option key={k} value={k}>{FORM_QUESTION_KIND_LABEL[k]}</option>)}
              </select>
            </Field>
            <Field label="A line under the question (optional)" htmlFor={`ed-form-help-${i}`}><input id={`ed-form-help-${i}`} className="input" value={r.help} onChange={(e) => onChange(updateAt(rows, i, { help: e.target.value }))} /></Field>
          </div>
          {r.kind === "choice" ? <Field label="Choices, one per line" htmlFor={`ed-form-options-${i}`}><textarea id={`ed-form-options-${i}`} className="textarea" rows={3} value={r.options} onChange={(e) => onChange(updateAt(rows, i, { options: e.target.value }))} /></Field> : null}
          {r.kind === "number" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Unit (optional)" htmlFor={`ed-form-unit-${i}`}><input id={`ed-form-unit-${i}`} className="input" value={r.unit} onChange={(e) => onChange(updateAt(rows, i, { unit: e.target.value }))} placeholder="years" /></Field>
              <Field label="Lowest (optional)" htmlFor={`ed-form-min-${i}`}><input id={`ed-form-min-${i}`} className="input" inputMode="decimal" value={r.min} onChange={(e) => onChange(updateAt(rows, i, { min: e.target.value }))} /></Field>
              <Field label="Highest (optional)" htmlFor={`ed-form-max-${i}`}><input id={`ed-form-max-${i}`} className="input" inputMode="decimal" value={r.max} onChange={(e) => onChange(updateAt(rows, i, { max: e.target.value }))} /></Field>
            </div>
          ) : null}
          <div className="row justify-between">
            <label className="inline-flex min-h-10 cursor-pointer items-center gap-2.5 text-[14px]"><input type="checkbox" checked={r.required} onChange={(e) => onChange(updateAt(rows, i, { required: e.target.checked }))} /> Must be answered</label>
            <RowTools index={i} total={rows.length} what="question" onMove={(by) => onChange(moveRow(rows, i, by))} onRemove={() => onChange(removeAt(rows, i))} />
          </div>
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= FORM_QUESTIONS_MAX} onClick={() => onChange([...rows, newFormRow()])}>Add a question</Button></div>
    </div>
  );
}

/** The AI interview's questions in the order they are asked, each with what a good answer shows (never shown to a candidate). */
function InterviewQuestions({ rows, onChange }: { rows: InterviewRow[]; onChange: (rows: InterviewRow[]) => void }) {
  return (
    <div className="stack gap-2.5">
      {rows.map((r, i) => (
        <div key={r.key ?? `new-${i}`} className={ROW_BOX}>
          <Field label={`${i + 1}. Question`} htmlFor={`ed-ask-${i}`}><input id={`ed-ask-${i}`} className="input" value={r.question} onChange={(e) => onChange(updateAt(rows, i, { question: e.target.value }))} /></Field>
          <Field label="What a good answer shows (optional)" htmlFor={`ed-ask-model-${i}`} aside={<SeenBy v="reviewed" />}><input id={`ed-ask-model-${i}`} className="input" value={r.modelAnswer} onChange={(e) => onChange(updateAt(rows, i, { modelAnswer: e.target.value }))} /></Field>
          <RowTools index={i} total={rows.length} what="question" onMove={(by) => onChange(moveRow(rows, i, by))} onRemove={() => onChange(removeAt(rows, i))} />
        </div>
      ))}
      <div className="row"><Button size="sm" disabled={rows.length >= SCREENING_QUESTIONS_MAX} onClick={() => onChange([...rows, newInterviewRow()])}>Add a question</Button></div>
    </div>
  );
}

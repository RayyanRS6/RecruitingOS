"use client";

import { useState } from "react";
import type { IntakeFacts, IntakeFactsPatch, PacketVisibility } from "@ros/contracts";
import { Alert, Avatar, Button, Field, Icon } from "@ros/ui";
import { TEAM_CHIP } from "./look";
import { SeenBy } from "./marks";
import { EMPLOYMENT_WORD, REASON_WORD, WORK_MODEL_WORD } from "./rules";
import { factsFormFrom, factsPatch, type FactsForm, type ListField, type TextField } from "./facts-form";

/** A team member as the panel offers them: deciders may have the final say (owner, admin, hiring manager). */
export type TeamPick = { userId: string; name: string; role: string };
const DECIDERS = ["owner", "admin", "hiring_manager"];
/** The choice "Someone not on the team yet" in the final-say list. */
const NEW = "__someone_new";

/**
 * The lists, one item at a time. A hint is kept only where it says how the list is used to judge or to ask candidates
 * (fewer words, 23 October 2026); who sees each list is the mark beside its label.
 */
const LISTS: Array<{ field: ListField; label: string; hint?: string; seen: PacketVisibility; max: number; placeholder: string }> = [
  { field: "responsibilities", label: "What they would own", seen: "public", max: 10, placeholder: "e.g. Keep the schedule full and patients reminded" },
  { field: "mustHaves", label: "Must-haves (up to 6)", hint: "Listed on the job page, and applications are reviewed against them.", seen: "public", max: 6, placeholder: "e.g. Active California RDH license" },
  { field: "niceToHaves", label: "Nice to have", hint: "Helpful, never a reason to turn anyone away.", seen: "public", max: 10, placeholder: "e.g. Experience with Dentrix" },
  { field: "screeningQuestions", label: "Screening questions", hint: "Asked in a short conversation marked as AI, with a person available.", seen: "asked", max: 12, placeholder: "e.g. Which days can you work?" },
  { field: "dealBreakers", label: "Deal-breakers, in your words", hint: "Used only once they are turned into visible must-haves.", seen: "internal", max: 10, placeholder: "e.g. Cannot work Saturdays" },
];

/**
 * Edit mode of the draft panel (plan C7): the answers as plain fields, each marked with who sees it (an eye or a lock
 * beside its label: the kit's Field `aside`). Save sends only what changed, as one quiet edit: it goes into the
 * conversation as a short summary, the assistant does not reply, and the fairness check still applies to everything
 * typed (anything refused is said, with the reason).
 */
export function FactsEditor(props: { facts: IntakeFacts; team: TeamPick[]; onSave: (patch: IntakeFactsPatch) => void; saving: boolean; error: string | null; onCancel: () => void }) {
  const [start] = useState<FactsForm>(() => factsFormFrom(props.facts, props.team));
  const [form, setForm] = useState<FactsForm>(start);
  const [newDecider, setNewDecider] = useState(!start.decisionMakerUserId && !!start.decisionMakerName);
  const patch = factsPatch(start, form);
  const text = (k: TextField, v: string) => setForm({ ...form, text: { ...form.text, [k]: v } });
  const deciders = props.team.filter((m) => DECIDERS.includes(m.role));
  return (
    <div className="grid min-w-0 gap-4">
      <Field label="Job title" htmlFor="ed-title" aside={<SeenBy v="public" />}><input id="ed-title" className="input" value={form.text.title} onChange={(e) => text("title", e.target.value)} /></Field>
      <div className="grid-2">
        <Field label="Where the job is" htmlFor="ed-where" aside={<SeenBy v="public" />}><input id="ed-where" className="input" value={form.text.locationText} onChange={(e) => text("locationText", e.target.value)} placeholder="City, state" /></Field>
        <Field label="Schedule" htmlFor="ed-schedule" aside={<SeenBy v="public" />}><input id="ed-schedule" className="input" value={form.text.schedule} onChange={(e) => text("schedule", e.target.value)} placeholder="e.g. Mon to Thu, 8 to 5" /></Field>
        <Field label="Full or part time" htmlFor="ed-type" aside={<SeenBy v="public" />}>
          <select id="ed-type" className="select" value={form.text.employmentType} onChange={(e) => text("employmentType", e.target.value)}>
            <option value="">Not set yet</option>
            {Object.entries(EMPLOYMENT_WORD).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Work model" htmlFor="ed-model" aside={<SeenBy v="public" />}>
          <select id="ed-model" className="select" value={form.text.remotePolicy} onChange={(e) => text("remotePolicy", e.target.value)}>
            <option value="">Not set yet</option>
            {Object.entries(WORK_MODEL_WORD).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>

      {LISTS.map((l) => (
        <ListEditor key={l.field} id={`ed-${l.field}`} label={l.label} hint={l.hint} seen={l.seen} max={l.max} placeholder={l.placeholder} items={form.lists[l.field]} onChange={(items) => setForm({ ...form, lists: { ...form.lists, [l.field]: items } })} />
      ))}

      {/* why, when and what would not work out stay with the team; the benefits are on the job page */}
      <div className="grid-2">
        <Field label="Why you're hiring" htmlFor="ed-reason" aside={<SeenBy v="internal" />}>
          <select id="ed-reason" className="select" value={form.text.reason} onChange={(e) => text("reason", e.target.value)}>
            <option value="">Not said yet</option>
            {Object.entries(REASON_WORD).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="In a few words (optional)" htmlFor="ed-reason-detail" aside={<SeenBy v="internal" />}><input id="ed-reason-detail" className="input" value={form.text.reasonDetail} onChange={(e) => text("reasonDetail", e.target.value)} placeholder="e.g. Maria is moving away in December" /></Field>
        <Field label="Start by" htmlFor="ed-start" aside={<SeenBy v="internal" />}><input id="ed-start" type="date" className="input" value={form.text.targetStartDate} onChange={(e) => text("targetStartDate", e.target.value)} /></Field>
        <Field label="Benefits" htmlFor="ed-benefits" aside={<SeenBy v="public" />}><input id="ed-benefits" className="input" value={form.text.benefits} onChange={(e) => text("benefits", e.target.value)} placeholder="e.g. Health, dental, 401(k), paid time off" /></Field>
      </div>
      <Field label="What would not work out" htmlFor="ed-failure" aside={<SeenBy v="internal" />}><input id="ed-failure" className="input" value={form.text.whatFailureLooksLike} onChange={(e) => text("whatFailureLooksLike", e.target.value)} placeholder="e.g. Someone who needs a lot of direction" /></Field>

      <fieldset className="grid min-w-0 gap-2.5">
        <legend className="mb-2 p-0 text-[13px] font-semibold text-ink">Who interviews</legend>
        <div className="flex flex-wrap gap-2">
          {props.team.map((m) => {
            const on = form.interviewerUserIds.includes(m.userId);
            return (
              <label key={m.userId} className={TEAM_CHIP} data-checked={on ? "true" : undefined}>
                <input type="checkbox" checked={on} onChange={() => setForm({ ...form, interviewerUserIds: on ? form.interviewerUserIds.filter((id) => id !== m.userId) : [...form.interviewerUserIds, m.userId] })} />
                <Avatar name={m.name} size="sm" />
                <span>{m.name}</span>
              </label>
            );
          })}
        </div>
        <ListEditor id="ed-other-interviewers" label="Someone not on the team yet" seen="internal" max={6} placeholder="Name" items={form.otherInterviewers} onChange={(items) => setForm({ ...form, otherInterviewers: items })} />
      </fieldset>

      <Field label="Who has the final say" htmlFor="ed-decider" aside={<SeenBy v="internal" />} hint="Their approval opens the role.">
        <select id="ed-decider" className="select" value={form.decisionMakerUserId || (newDecider ? NEW : "")} onChange={(e) => {
          const v = e.target.value;
          setNewDecider(v === NEW);
          setForm({ ...form, decisionMakerUserId: v === NEW ? "" : v, decisionMakerName: v === NEW ? form.decisionMakerName : "" });
        }}>
          <option value="">Not chosen yet</option>
          {deciders.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          <option value={NEW}>Someone not on the team yet</option>
        </select>
      </Field>
      {newDecider ? (
        <Field label="Their name" htmlFor="ed-decider-name" aside={<SeenBy v="internal" />} hint="Invite them to the team later and approvals will go to them."><input id="ed-decider-name" className="input" value={form.decisionMakerName} onChange={(e) => setForm({ ...form, decisionMakerName: e.target.value })} /></Field>
      ) : null}

      {props.error ? <Alert tone="critical">{props.error}</Alert> : null}
      {/* Save is greyed until something changed */}
      <div className="sticky bottom-0 -mx-4 -mb-4 flex flex-wrap items-center gap-2 border-t border-line bg-surface px-4 py-3 sm:-mx-5 sm:-mb-5 sm:px-5">
        <Button variant="primary" disabled={!patch} loading={props.saving} onClick={() => patch && props.onSave(patch)}>Save changes</Button>
        <Button variant="ghost" onClick={props.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

/** One list of answers: each line with Remove, and a box to add one more. A full list says so where the hint was. */
function ListEditor(props: { id: string; label: string; hint?: string; seen: PacketVisibility; max: number; placeholder: string; items: string[]; onChange: (items: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t || props.items.length >= props.max || props.items.some((x) => x.trim().toLowerCase() === t.toLowerCase())) return;
    props.onChange([...props.items, t]);
    setDraft("");
  };
  const hint = props.items.length >= props.max ? `That is the most this list can hold (${props.max}).` : props.hint;
  return (
    <Field label={props.label} htmlFor={props.id} aside={<SeenBy v={props.seen} />} hint={hint}>
      <div className="grid min-w-0 gap-2">
        {props.items.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {props.items.map((t, i) => (
              <li key={`${i}-${t}`} className="flex min-w-0 items-center justify-between gap-3 py-1.5 pl-3.5 pr-1.5 text-[14px]">
                <span className="min-w-0 wrap-anywhere">{t}</span>
                <button type="button" className="icon-btn sm border-transparent bg-transparent hover:bg-tint" aria-label={`Remove: ${t}`} title="Remove" onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <input id={props.id} className="input" value={draft} maxLength={500} placeholder={props.placeholder} disabled={props.items.length >= props.max} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
          <Button size="sm" disabled={!draft.trim() || props.items.length >= props.max} onClick={add}>Add</Button>
        </div>
      </div>
    </Field>
  );
}

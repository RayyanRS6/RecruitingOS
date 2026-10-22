"use client";

import { useEffect, useRef } from "react";
import type { IntakePayCard, IntakeQuestion } from "@ros/contracts";
import { AutoTextarea, Avatar, Button, Icon, IconButton } from "@ros/ui";
import { OPTION_LABEL, OPTION_ROW, OPTION_TAG, OPTIONS, OWN_CHIP, OWN_CHIP_X, OWN_CHIPS, TEAM_CHIP } from "./look";
import { PayFields } from "./PayCard";
import {
  SOMEONE_NEW, addOwn, answerOf, goTo, isAnswered, nextLabel, payFormFrom, pickHint, picksOne, removeOwn, setDraft, setPayForm, togglePick,
  type CardState,
} from "./rules";

/** Where an offered answer came from, said quietly beside it: the assistant's own ideas are marked as suggestions. */
const ORIGIN: Record<string, string> = { playbook: "Our hiring guide", benchmark: "Market data", owner: "Your words", assistant: "Suggestion", team: "" };

/**
 * The question card docked where the message box is (plan C6, C15): one question at a time with "1 of 3" and arrows,
 * the answers as rows to tick, "Add your own…", a "Why we ask" line, and Next (Send on the last card). Team questions
 * offer the team as chips, plus "Someone not on the team yet" with a box for their name. "Or type your own answer…"
 * puts the message box back. Every answer is the person's choice; nothing is ticked for them.
 */
export function QuestionCard(props: {
  questions: IntakeQuestion[];
  state: CardState;
  onState: (state: CardState) => void;
  onSend: () => void;
  onClose: () => void;
  /** Absent once the draft is written: typed words then ask for a change to the draft, not an answer. */
  onTypeInstead?: () => void;
  sending: boolean;
  pay: IntakePayCard;
}) {
  const { questions, state, onState } = props;
  const total = questions.length;
  const index = Math.max(0, Math.min(state.index, total - 1));
  const q = questions[index] as IntakeQuestion | undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  // Moving to another card takes the reader to its question.
  const moved = useRef(false);
  const shownId = q?.id;
  useEffect(() => {
    if (!shownId) return;
    if (moved.current) heading.current?.focus();
    moved.current = true;
  }, [shownId]);
  if (!q) return null;
  const a = answerOf(state, q);
  const next = () => (index >= total - 1 ? props.onSend() : onState(goTo(state, index + 1, total)));
  const name = `card-${q.id}`;
  const one = picksOne(q);
  const answeredCount = questions.filter((x) => isAnswered(x, answerOf(state, x))).length;

  return (
    <section className="grid min-w-0 gap-3 rounded-2xl border border-line-tint bg-surface p-4 shadow-xs motion-safe:animate-enter sm:p-5" aria-label="Questions from the assistant">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="eyebrow live mr-auto min-w-0">{pickHint(q)}</span>
        <span className="inline-flex items-center gap-1 text-[13px] font-medium tabular-nums text-ink-2">
          <IconButton icon="chevron-left" label="Previous question" size="sm" disabled={index === 0} onClick={() => onState(goTo(state, index - 1, total))} />
          <span className="min-w-12 text-center" aria-live="polite">{index + 1} of {total}</span>
          <IconButton icon="chevron-right" label="Next question" size="sm" disabled={index >= total - 1} onClick={() => onState(goTo(state, index + 1, total))} />
        </span>
        <IconButton icon="x" label="Close the questions" size="sm" onClick={props.onClose} />
      </div>
      {/* a new question fades in where the last one was */}
      <div key={q.id} className="grid min-w-0 gap-3 motion-safe:animate-fade">
        <h2 ref={heading} tabIndex={-1} className="qcard-prompt font-display text-[19px] font-bold leading-snug tracking-[-0.02em] focus:outline-none">{q.prompt}</h2>
        {q.mode === "pay" ? (
          <PayFields form={a.pay ?? payFormFrom(props.pay)} onChange={(f) => onState(setPayForm(state, q, f))} card={props.pay} idBase={name} />
        ) : q.mode === "free" ? (
          <AutoTextarea className="textarea" value={a.draft} onChange={(v) => onState(setDraft(state, q, v))} ariaLabel={q.prompt} placeholder="Type your answer" maxLength={500} rows={2} />
        ) : q.mode === "team" ? (
          <fieldset className="grid min-w-0 gap-3">
            <legend className="sr-only">{q.prompt}</legend>
            <div className="flex flex-wrap gap-2">
              {q.options.map((o) => {
                const checked = a.selected.includes(o.value);
                const isNew = o.value === SOMEONE_NEW;
                return (
                  <label key={o.value} className={TEAM_CHIP} data-checked={checked ? "true" : undefined}>
                    {/* named by its option, so a screen reader never reads the input's default value ("on") */}
                    <input type={one ? "radio" : "checkbox"} name={name} value={o.value} aria-label={o.label} checked={checked} onChange={() => onState(togglePick(state, q, o.value))} />
                    {isNew ? <span className="avatar sm border-dashed bg-surface" aria-hidden="true"><Icon name="plus" size={14} /></span> : <Avatar name={o.label} size="sm" />}
                    <span>{o.label}</span>
                  </label>
                );
              })}
            </div>
            {a.selected.includes(SOMEONE_NEW) ? (
              <OwnBox
                id={`${name}-new`}
                label={one ? "Their name" : "Their names"}
                placeholder="Name, and their role if you like"
                value={a.draft}
                items={one ? [] : a.own}
                single={one}
                onValue={(v) => onState(setDraft(state, q, v))}
                onAdd={() => onState(addOwn(state, q))}
                onRemove={(t) => onState(removeOwn(state, q, t))}
                onEnter={next}
              />
            ) : null}
            <p className="small muted">You can invite them to the team later from Setup; they are not told anything now.</p>
          </fieldset>
        ) : (
          <fieldset className="grid min-w-0 gap-3">
            <legend className="sr-only">{q.prompt}</legend>
            <div className={OPTIONS}>
              {q.options.map((o) => {
                const checked = a.selected.includes(o.value);
                return (
                  <label key={o.value} className={OPTION_ROW} data-checked={checked ? "true" : undefined}>
                    <input type={one ? "radio" : "checkbox"} name={name} value={o.value} aria-label={o.label} checked={checked} onChange={() => onState(togglePick(state, q, o.value))} />
                    <span className={OPTION_LABEL}>{o.label}</span>
                    {ORIGIN[o.origin] ? <span className={OPTION_TAG}>{ORIGIN[o.origin]}</span> : null}
                  </label>
                );
              })}
            </div>
            {q.allowOwn ? (
              <OwnBox
                id={`${name}-own`}
                label="Add your own"
                placeholder="Add your own…"
                value={a.draft}
                items={one ? [] : a.own}
                single={one}
                onValue={(v) => onState(setDraft(state, q, v))}
                onAdd={() => onState(addOwn(state, q))}
                onRemove={(t) => onState(removeOwn(state, q, t))}
                onEnter={next}
              />
            ) : null}
          </fieldset>
        )}

        {q.why ? (
          <details className="more">
            <summary>Why we ask</summary>
            <p className="text-[14px] text-ink-2">{q.why}</p>
          </details>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {props.onTypeInstead ? <Button variant="ghost" size="sm" onClick={props.onTypeInstead}>Or type your own answer…</Button> : null}
        <span className="ml-auto text-[12.5px] tabular-nums text-ink-3">{answeredCount ? `${answeredCount} answered` : ""}</span>
        <Button variant="primary" loading={props.sending} onClick={next} iconEnd={index >= total - 1 ? "send" : "arrow-right"}>{nextLabel(index, total)}</Button>
      </div>
    </section>
  );
}

/** "Add your own…": one box for a pick-one card (the words are the answer), a box and Add for a pick-any card. */
function OwnBox(props: { id: string; label: string; placeholder: string; value: string; items: string[]; single: boolean; onValue: (v: string) => void; onAdd: () => void; onRemove: (t: string) => void; onEnter: () => void }) {
  return (
    <div className="grid min-w-0 gap-2">
      {props.items.length ? (
        <ul className={OWN_CHIPS} aria-label="Added by you">
          {props.items.map((t) => (
            <li key={t} className={OWN_CHIP}>
              {t}
              <button type="button" className={OWN_CHIP_X} aria-label={`Remove ${t}`} onClick={() => props.onRemove(t)}><Icon name="x" size={12} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={props.id} className="sr-only">{props.label}</label>
        <input
          id={props.id}
          className="input"
          value={props.value}
          maxLength={500}
          placeholder={props.placeholder}
          onChange={(e) => props.onValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (props.single || !props.value.trim()) props.onEnter();
            else props.onAdd();
          }}
        />
        {props.single ? null : <Button size="sm" disabled={!props.value.trim()} onClick={props.onAdd}>Add</Button>}
      </div>
    </div>
  );
}

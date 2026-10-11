"use client";

import { useEffect, useRef } from "react";
import type { IntakePayCard, IntakeQuestion } from "@ros/contracts";
import { AutoTextarea, Avatar, Button, Icon, IconButton } from "@ros/ui";
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
    <section className="qcard" aria-label="Questions from the assistant">
      <div className="qcard-top">
        <span className="qcard-hint">{pickHint(q)}</span>
        <span className="qcard-pager">
          <IconButton icon="chevron-left" label="Previous question" size="sm" disabled={index === 0} onClick={() => onState(goTo(state, index - 1, total))} />
          <span aria-live="polite">{index + 1} of {total}</span>
          <IconButton icon="chevron-right" label="Next question" size="sm" disabled={index >= total - 1} onClick={() => onState(goTo(state, index + 1, total))} />
        </span>
        <IconButton icon="x" label="Close the questions" size="sm" onClick={props.onClose} />
      </div>
      <h2 ref={heading} tabIndex={-1} className="qcard-prompt">{q.prompt}</h2>

      {q.mode === "pay" ? (
        <PayFields form={a.pay ?? payFormFrom(props.pay)} onChange={(f) => onState(setPayForm(state, q, f))} card={props.pay} idBase={name} />
      ) : q.mode === "free" ? (
        <AutoTextarea className="textarea" value={a.draft} onChange={(v) => onState(setDraft(state, q, v))} ariaLabel={q.prompt} placeholder="Type your answer" maxLength={500} rows={2} />
      ) : q.mode === "team" ? (
        <fieldset className="qfield">
          <legend className="sr-only">{q.prompt}</legend>
          <div className="team-chips">
            {q.options.map((o) => {
              const checked = a.selected.includes(o.value);
              const isNew = o.value === SOMEONE_NEW;
              return (
                <label key={o.value} className="team-chip" data-checked={checked ? "true" : undefined}>
                  {/* named by its option, so a screen reader never reads the input's default value ("on") */}
                  <input type={one ? "radio" : "checkbox"} name={name} value={o.value} aria-label={o.label} checked={checked} onChange={() => onState(togglePick(state, q, o.value))} />
                  {isNew ? <span className="avatar sm" aria-hidden="true"><Icon name="plus" size={12} /></span> : <Avatar name={o.label} size="sm" />}
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
        <fieldset className="qfield">
          <legend className="sr-only">{q.prompt}</legend>
          <div className="qopts">
            {q.options.map((o) => {
              const checked = a.selected.includes(o.value);
              return (
                <label key={o.value} className="qopt" data-checked={checked ? "true" : undefined}>
                  <input type={one ? "radio" : "checkbox"} name={name} value={o.value} aria-label={o.label} checked={checked} onChange={() => onState(togglePick(state, q, o.value))} />
                  <span className="qopt-label">{o.label}</span>
                  {ORIGIN[o.origin] ? <span className="qopt-origin">{ORIGIN[o.origin]}</span> : null}
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
        <details className="qcard-why">
          <summary>Why we ask</summary>
          <p>{q.why}</p>
        </details>
      ) : null}
      <div className="qcard-foot">
        {props.onTypeInstead ? <Button variant="ghost" size="sm" onClick={props.onTypeInstead}>Or type your own answer…</Button> : null}
        <span className="small muted qcard-count">{answeredCount ? `${answeredCount} answered` : ""}</span>
        <Button variant="primary" loading={props.sending} onClick={next} iconEnd={index >= total - 1 ? "send" : "arrow-right"}>{nextLabel(index, total)}</Button>
      </div>
    </section>
  );
}

/** "Add your own…": one box for a pick-one card (the words are the answer), a box and Add for a pick-any card. */
function OwnBox(props: { id: string; label: string; placeholder: string; value: string; items: string[]; single: boolean; onValue: (v: string) => void; onAdd: () => void; onRemove: (t: string) => void; onEnter: () => void }) {
  return (
    <div className="own-box">
      {props.items.length ? (
        <ul className="own-items" aria-label="Added by you">
          {props.items.map((t) => (
            <li key={t} className="chip accent">
              {t}
              <button type="button" className="chip-x" aria-label={`Remove ${t}`} onClick={() => props.onRemove(t)}><Icon name="x" size={12} /></button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row" style={{ flexWrap: "nowrap" }}>
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

"use client";

import { useEffect, useRef, useState } from "react";
import type { IntakePayCard, IntakeQuestion } from "@ros/contracts";
import { Alert, AutoTextarea, Button, Eyebrow, Field, Icon, IconButton, IconLabel, Segmented } from "@ros/ui";
import {
  addOwn, answerOf, goTo, isAnswered, nextLabel, payCardProblem, payFormShown, pickHint, picksOne, removeOwn, setDraft, setPayForm, togglePick,
  type CardState, type PayForm,
} from "../../builder";
import { OPTION_WORDS, OPTIONS, OWN_CHIP, OWN_CHIP_X, OWN_CHIPS } from "./look";

const UNIT = { hourly: "an hour", salary: "a year" } as const;

/** The pay boxes on the pay card: by the hour or a yearly salary, then the range candidates will see. */
export function PayFields({ form, onChange, idBase }: { form: PayForm; onChange: (form: PayForm) => void; idBase: string }) {
  const unit = form.basis ? ` (${UNIT[form.basis]})` : "";
  return (
    <div className="grid min-w-0 gap-3 [&>.segmented]:justify-self-start">
      <Segmented value={form.basis} onChange={(basis) => onChange({ ...form, basis })} ariaLabel="How the job is paid" options={[{ value: "hourly", label: "By the hour" }, { value: "salary", label: "A yearly salary" }]} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={`Lowest${unit}`} htmlFor={`${idBase}-min`}>
          <input id={`${idBase}-min`} className="input" inputMode="decimal" value={form.min} onChange={(e) => onChange({ ...form, min: e.target.value })} placeholder={form.basis === "salary" ? "e.g. 60,000" : "e.g. 24"} />
        </Field>
        <Field label={`Highest${unit}`} htmlFor={`${idBase}-max`}>
          <input id={`${idBase}-max`} className="input" inputMode="decimal" value={form.max} onChange={(e) => onChange({ ...form, max: e.target.value })} placeholder={form.basis === "salary" ? "e.g. 70,000" : "e.g. 28"} />
        </Field>
      </div>
    </div>
  );
}

/**
 * The question card docked where the message box is: one question at a time with "1 of 3" and arrows, the answers as
 * rows to tick (the assistant's own ideas carry a sparkle), "Add your own…", a "Why we ask" line, and Next (Send on the
 * last card). "Or type your own answer…" puts the message box back. Every answer is the person's choice; nothing is
 * ticked for them. The pay card draws the pay the draft already states (`pay`), and what its boxes show is what Send
 * sends: left as drawn, the person sending confirms those figures.
 */
export function QuestionCard(props: {
  questions: IntakeQuestion[];
  state: CardState;
  onState: (state: CardState) => void;
  onSend: () => void;
  onClose: () => void;
  onTypeInstead: () => void;
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
  // Pay figures that cannot be sent: said on their card, and nothing goes until they are right.
  const [payWords, setPayWords] = useState<string | null>(null);
  if (!q) return null;
  const a = answerOf(state, q);
  const next = () => {
    if (index < total - 1) {
      const here = payCardProblem([q], state, props.pay);
      setPayWords(here?.words ?? null);
      if (!here) onState(goTo(state, index + 1, total));
      return;
    }
    const wrong = payCardProblem(questions, state, props.pay);
    setPayWords(wrong?.words ?? null);
    if (!wrong) props.onSend();
    else if (wrong.index !== index) onState(goTo(state, wrong.index, total));
  };
  const name = `card-${q.id}`;
  const one = picksOne(q);
  const answeredCount = questions.filter((x) => isAnswered(x, answerOf(state, x))).length;

  return (
    <section className="grid min-w-0 gap-3 rounded-2xl border border-line-tint bg-surface p-4 shadow-xs motion-safe:animate-enter sm:p-5" aria-label="Questions from the assistant">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Eyebrow as="span" className="live mr-auto min-w-0">{pickHint(q)}</Eyebrow>
        <span className="inline-flex items-center gap-1 text-[13px] font-medium tabular-nums text-ink-2">
          <IconButton icon="chevron-left" label="Previous question" size="sm" disabled={index === 0} onClick={() => onState(goTo(state, index - 1, total))} />
          <span className="min-w-12 text-center" aria-live="polite">{index + 1} of {total}</span>
          <IconButton icon="chevron-right" label="Next question" size="sm" disabled={index >= total - 1} onClick={() => onState(goTo(state, index + 1, total))} />
        </span>
        <IconButton icon="x" label="Close the questions" size="sm" onClick={props.onClose} />
      </div>
      {/* a new question fades in where the last one was; .qcard-prompt is a hook only: the builder moves the focus to it */}
      <div key={q.id} className="grid min-w-0 gap-3 motion-safe:animate-fade">
        <h2 ref={heading} tabIndex={-1} className="qcard-prompt font-display text-[19px] font-bold leading-snug tracking-[-0.02em] focus:outline-none">{q.prompt}</h2>
        {q.mode === "pay" ? (
          <>
            <PayFields form={payFormShown(a, props.pay)} onChange={(f) => { setPayWords(null); onState(setPayForm(state, q, f)); }} idBase={name} />
            {payWords ? <Alert tone="caution">{payWords}</Alert> : null}
          </>
        ) : q.mode === "free" ? (
          <AutoTextarea className="textarea" value={a.draft} onChange={(v) => onState(setDraft(state, q, v))} ariaLabel={q.prompt} placeholder="Type your answer" maxLength={500} rows={2} />
        ) : (
          <fieldset className="grid min-w-0 gap-3">
            <legend className="sr-only">{q.prompt}</legend>
            <div className={OPTIONS}>
              {q.options.map((o) => (
                <label key={o.value} className="option-row">
                  {/* named by its option, so a screen reader never reads the input's default value ("on") */}
                  <input type={one ? "radio" : "checkbox"} name={name} value={o.value} aria-label={o.label} checked={a.selected.includes(o.value)} onChange={() => onState(togglePick(state, q, o.value))} />
                  <span className={OPTION_WORDS}>{o.label}</span>
                  {o.origin === "assistant" ? <IconLabel icon="sparkle" label="Suggested by the AI assistant" /> : null}
                </label>
              ))}
            </div>
            {q.allowOwn ? (
              <OwnBox
                id={`${name}-own`}
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
        <Button variant="ghost" size="sm" onClick={props.onTypeInstead}>Or type your own answer…</Button>
        <span className="ml-auto text-[12.5px] tabular-nums text-ink-3">{answeredCount ? `${answeredCount} answered` : ""}</span>
        <Button variant="primary" loading={props.sending} onClick={next} iconEnd={index >= total - 1 ? "send" : "arrow-right"}>{nextLabel(index, total)}</Button>
      </div>
    </section>
  );
}

/** "Add your own…": one box for a pick-one card (the words are the answer), a box and Add for a pick-any card. */
function OwnBox(props: { id: string; value: string; items: string[]; single: boolean; onValue: (v: string) => void; onAdd: () => void; onRemove: (t: string) => void; onEnter: () => void }) {
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
        <label htmlFor={props.id} className="sr-only">Add your own</label>
        <input
          id={props.id}
          className="input"
          value={props.value}
          maxLength={500}
          placeholder="Add your own…"
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

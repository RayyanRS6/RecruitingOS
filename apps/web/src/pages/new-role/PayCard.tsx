"use client";

import { useState } from "react";
import type { IntakePayCard } from "@ros/contracts";
import { Alert, Button, Field, Icon, Segmented } from "@ros/ui";
import { SeenBy } from "./marks";
import { marketRange, marketSource, payFormFrom, payPayload, payProblem, type PayForm } from "./rules";

const UNIT = { hourly: "an hour", salary: "a year" } as const;
const VIA: Record<string, string> = { typed: "typed in the conversation", pay_card: "set on the pay card", edited: "changed in the draft", confirmed: "confirmed as still right" };

/**
 * The pay boxes (plan C8), on a question card, a quick start step and the draft's pay card: hourly or salary, the market
 * figure for the job and place with its source and year (or a plain line saying there is none), the range candidates
 * see, and the most the owner would pay, which only the team sees (the eye and the lock beside each box's label, the
 * kit's Field `aside`).
 */
export function PayFields({ form, onChange, card, idBase }: { form: PayForm; onChange: (form: PayForm) => void; card: IntakePayCard; idBase: string }) {
  const range = marketRange(card);
  const source = marketSource(card);
  const comparable = !!card.benchmark && (!form.basis || card.benchmark.basis === form.basis);
  const unit = form.basis ? UNIT[form.basis] : "";
  return (
    // a size container: the three boxes sit in a row once their own box is wide enough (the dock, the draft, a step)
    <div className="@container grid min-w-0 gap-3 [&>.segmented]:justify-self-start">
      <Segmented value={form.basis} onChange={(basis) => onChange({ ...form, basis })} ariaLabel="How the job is paid" options={[{ value: "hourly", label: "By the hour" }, { value: "salary", label: "A yearly salary" }]} />
      {/* the market figure, when there is one: a soft lavender note above the boxes */}
      <div className="grid gap-0.5 rounded-xl border border-line-tint bg-tint/70 px-3.5 py-2.5 text-[14px] empty:hidden">
        {comparable && range ? (
          <>
            <p><strong>Market pay here:</strong> {range}</p>
            {source ? <p className="small muted">{source}</p> : null}
          </>
        ) : card.gap ? (
          <p className="small muted">{card.gap.message}</p>
        ) : card.benchmark ? (
          <p className="small muted">The market figure we have is {card.benchmark.basis === "hourly" ? "hourly" : "a yearly salary"}; choose the same to compare.</p>
        ) : null}
      </div>
      <div className="grid gap-3 @md:grid-cols-3">
        <Field label={`Lowest${unit ? ` (${unit})` : ""}`} htmlFor={`${idBase}-min`} aside={<SeenBy v="public" />}>
          <input id={`${idBase}-min`} className="input" inputMode="decimal" value={form.min} onChange={(e) => onChange({ ...form, min: e.target.value })} placeholder={form.basis === "salary" ? "e.g. 60,000" : "e.g. 24"} />
        </Field>
        <Field label={`Highest${unit ? ` (${unit})` : ""}`} htmlFor={`${idBase}-max`} aside={<SeenBy v="public" />}>
          <input id={`${idBase}-max`} className="input" inputMode="decimal" value={form.max} onChange={(e) => onChange({ ...form, max: e.target.value })} placeholder={form.basis === "salary" ? "e.g. 70,000" : "e.g. 28"} />
        </Field>
        <Field label="The most you would pay" htmlFor={`${idBase}-ceiling`} aside={<SeenBy v="internal" />} hint="Optional.">
          <input id={`${idBase}-ceiling`} className="input" inputMode="decimal" value={form.ceiling} onChange={(e) => onChange({ ...form, ceiling: e.target.value })} />
        </Field>
      </div>
    </div>
  );
}

/**
 * The draft's pay card: who set or confirmed the pay and how, the market comparison, and the boxes to set or confirm it.
 * A range read from a pasted ad or an earlier role waits here until a person confirms it is still right.
 */
export function PayCard({ card, onSave, saving, error }: { card: IntakePayCard; onSave: (pay: NonNullable<ReturnType<typeof payPayload>>) => void; saving: boolean; error?: string | null }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PayForm>(() => payFormFrom(card));
  const [problem, setProblem] = useState<string | null>(null);
  const open = editing || !card.confirmed;
  const unchanged = JSON.stringify(form) === JSON.stringify(payFormFrom(card));
  const save = () => {
    const p = payProblem(form);
    setProblem(p);
    const pay = payPayload(form);
    if (!p && pay) {
      onSave(pay);
      setEditing(false);
    }
  };
  return (
    <div className="grid min-w-0 gap-3">
      {card.confirmed ? (
        <p className="small text-ink-2">
          <Icon name="check-circle" size={16} className="mr-0.5 text-good" /> {card.confirmed.byName ? `${card.confirmed.byName} ` : "Pay "}{VIA[card.confirmed.via] ?? "set"} on {new Date(card.confirmed.at).toLocaleDateString()}.
        </p>
      ) : card.stated.min !== null ? (
        <p className="small font-medium text-caution">Is this still right? Pay read from an ad or an earlier role is used only once you confirm it.</p>
      ) : (
        // pay transparency (a required notice; founder decision Q9), said before any pay is set
        <p className="small muted">Pay is always shown on the job ad.</p>
      )}
      {/* Below a figure for a broader group of jobs is worth knowing, not a warning (polish list). */}
      {card.belowMarket ? <Alert tone={card.benchmark?.approximate ? "info" : "caution"}>{card.summary}</Alert> : null}
      {open ? (
        <>
          <PayFields form={form} onChange={(f) => { setForm(f); setProblem(null); }} card={card} idBase="draft-pay" />
          {problem ? <Alert tone="caution">{problem}</Alert> : null}
          {error ? <Alert tone="critical">{error}</Alert> : null}
          <div className="row">
            <Button variant="primary" size="sm" loading={saving} onClick={save}>{card.stated.min !== null && unchanged && !card.confirmed ? "Confirm the pay" : "Set the pay"}</Button>
            {editing ? <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setForm(payFormFrom(card)); setProblem(null); }}>Cancel</Button> : null}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {marketRange(card) ? <span className="small muted">Market pay here: {marketRange(card)}</span> : card.gap ? <span className="small muted">{card.gap.message}</span> : null}
          <Button size="sm" variant="secondary" onClick={() => { setForm(payFormFrom(card)); setEditing(true); }}>Change the pay</Button>
        </div>
      )}
    </div>
  );
}

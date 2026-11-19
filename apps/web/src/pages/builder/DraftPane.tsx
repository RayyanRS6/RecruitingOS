"use client";

import { useState } from "react";
import type { IntakeSessionView, PacketFlag } from "@ros/contracts";
import { Alert, Button, cn, Eyebrow, Field, Icon } from "@ros/ui";
import { essentialsList, publishHelp, redraftWarning } from "../../builder";
import { calendarDay, todayIn } from "../../dates";
import { KEEP_REASON_MIN, openFlags } from "../../job-editor";
import { closingDateProblem } from "../../jobs";
import { JobRecord } from "../job/JobRecord";
import { LegalCheckCard } from "../job/LegalCheck";
import { BULLETS, SUBHEAD } from "../look";
import { PANE_HEIGHT } from "./look";

/**
 * The job beside the conversation. Until the job is written: what is known and what is still needed, in the server's
 * words. Once it is written: anything that still holds publishing (answers changed since, wording to check, what the
 * server lists), the closing date, the legal check, and the job itself as candidates and the team will read it, with one
 * Edit. Nothing here decides a rule: every list is the server's.
 */
export function DraftPane(props: {
  view: IntakeSessionView;
  guardChanges: string[];
  /** The address of the job page as candidates will see it. */
  previewHref: string;
  onEdit: () => void;
  onRewrite: () => void;
  rewriting: boolean;
  onKeepFlag: (flagId: string, reason: string) => void;
  keepingFlag: string | null;
  /** The closing date, for someone who may set it; null shows the date without a field. */
  closing: { onSave: (closesOn: string | null) => void; saving: boolean; error: string | null } | null;
}) {
  const { view } = props;
  const written = view.draft;
  const checklist = essentialsList(view.readiness);
  const flags = openFlags(view.flags);
  const publish = publishHelp(view.readiness);
  return (
    <div className={cn("relative overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface shadow-xs", PANE_HEIGHT)}>
      <div className="sticky top-0 z-[5] flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 sm:px-5">
        <Eyebrow as="span">Job</Eyebrow>
        {written ? (
          <span className="row">
            <a href={props.previewHref} target="_blank" rel="noopener noreferrer" className="text-link"><Icon name="eye" size={16} />See the job page<span className="sr-only"> (opens in a new tab)</span></a>
            <Button size="sm" icon="edit" onClick={props.onEdit}>Edit</Button>
          </span>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-4 p-4 sm:p-5">
        {!written ? (
          <section className="grid gap-4" aria-label="What is known and what is still needed">
            {checklist.known.length ? (
              <div className="grid gap-1">
                <Eyebrow as="h2">What we know</Eyebrow>
                <ul className="divide-y divide-line">{checklist.known.map((i) => <li key={i.key} className="flex items-start gap-2.5 py-2 text-[14px]"><Icon name="check-circle" size={16} className="mt-0.5 shrink-0 text-good" /><span className="min-w-0 wrap-anywhere"><strong>{i.label}</strong>{i.value ? `: ${i.value}` : ""}</span></li>)}</ul>
              </div>
            ) : null}
            {checklist.missing.length ? (
              <div className="grid gap-1">
                <Eyebrow as="h2">Still needed</Eyebrow>
                <ul className="divide-y divide-line">{checklist.missing.map((i) => <li key={i.key} className="flex items-start gap-2.5 py-2 text-[14px]"><span className="mt-[3px] size-4 shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong" aria-hidden="true" /><span className="min-w-0 wrap-anywhere"><strong>{i.label}</strong>{i.value ? `: ${i.value}` : ""}{i.note ? <span className="muted"> {i.note}</span> : null}</span></li>)}</ul>
              </div>
            ) : null}
          </section>
        ) : (
          <>
            {view.readiness.draftOutOfDate ? <RewriteAlert warning={redraftWarning(view.readiness)} busy={props.rewriting} onRewrite={props.onRewrite} /> : null}
            {flags.length ? (
              <section className="grid gap-3 rounded-xl border border-caution-dot/50 bg-caution-soft p-4" aria-label="Wording to check before publishing">
                <h2 className="flex items-center gap-2 font-display text-[16px] font-bold text-caution"><Icon name="flag" size={16} />Check this wording before publishing</h2>
                {flags.map((f) => <WordingFlag key={f.id} flag={f} onEdit={props.onEdit} onKeep={props.onKeepFlag} keeping={props.keepingFlag === f.id} />)}
              </section>
            ) : null}
            {!publish.ready ? (
              <Alert tone="caution">
                <strong>Before you can publish</strong>
                <ul className="mt-1.5 grid list-disc gap-0.5 pl-[18px]">{publish.lines.map((l) => <li key={l}>{l}</li>)}</ul>
              </Alert>
            ) : null}
            {props.guardChanges.length ? (
              <Alert tone="info">
                <strong>Changed on saving</strong>
                <ul className="mt-1.5 grid list-disc gap-0.5 pl-[18px]">{props.guardChanges.map((g) => <li key={g}>{g}</li>)}</ul>
              </Alert>
            ) : null}
            <ClosingDate key={view.closesOn ?? "none"} closesOn={view.closesOn} closing={props.closing} />
            {view.legalCheck ? <LegalCheckCard check={view.legalCheck} /> : null}
            <JobRecord packet={written} />
            {written.provenance.assumptions.length ? (
              <details className="more">
                <summary>{`What the assistant assumed (${written.provenance.assumptions.length})`}</summary>
                <ul className={BULLETS}>{written.provenance.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
              </details>
            ) : null}
          </>
        )}
        {view.facts.declinedCriteria.length ? (
          <details className="more">
            <summary>{`Not used, and why (${view.facts.declinedCriteria.length})`}</summary>
            <ul className={BULLETS}>{view.facts.declinedCriteria.map((d) => <li key={d.requested}><strong>"{d.requested}"</strong>: {d.reason}{d.alternative ? ` ${d.alternative}` : ""}</li>)}</ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** Answers changed after the job was written: it must be written again. Edits a person saved on it since would be replaced, so that asks first. */
function RewriteAlert(props: { warning: string | null; busy: boolean; onRewrite: () => void }) {
  const [asking, setAsking] = useState(false);
  return (
    <Alert tone="info">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span>Your answers changed after the job was written.</span>
          {asking ? null : <Button size="sm" variant="primary" loading={props.busy} onClick={() => (props.warning ? setAsking(true) : props.onRewrite())}>Write the job again</Button>}
        </div>
        {asking && props.warning ? (
          <>
            <span>{props.warning}</span>
            <div className="row">
              <Button size="sm" variant="primary" loading={props.busy} onClick={() => { setAsking(false); props.onRewrite(); }}>Write the job again</Button>
              <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>Not now</Button>
            </div>
          </>
        ) : null}
      </div>
    </Alert>
  );
}

/** A phrase the fairness check flagged: change the words in the editor, or keep them with a reason, which is recorded. */
function WordingFlag(props: { flag: PacketFlag; onEdit: () => void; onKeep: (flagId: string, reason: string) => void; keeping: boolean }) {
  const { flag } = props;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const id = `keep-${flag.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  return (
    <div className="grid min-w-0 gap-2 rounded-xl border border-line bg-surface p-3.5 text-[14px] text-ink">
      <p className="wrap-anywhere"><strong>"{flag.text}"</strong> {flag.reason}</p>
      {flag.alternative ? <p className="small text-ink-2">Instead: {flag.alternative}</p> : null}
      {open ? (
        <div className="grid gap-1.5">
          <Field label="Why keep it" htmlFor={id}><input id={id} className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Required by our state licence board" /></Field>
          <div className="row">
            <Button size="sm" variant="primary" disabled={reason.trim().length < KEEP_REASON_MIN} loading={props.keeping} onClick={() => props.onKeep(flag.id, reason.trim())}>Keep it, with this reason</Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button size="sm" variant="primary" onClick={props.onEdit}>Change the wording</Button>
          <Button size="sm" onClick={() => setOpen(true)}>Keep it…</Button>
        </div>
      )}
    </div>
  );
}

/** The closing date chosen for the job before it exists: a field for an owner or an admin, the date alone for anyone else. */
function ClosingDate({ closesOn, closing }: { closesOn: string | null; closing: { onSave: (closesOn: string | null) => void; saving: boolean; error: string | null } | null }) {
  const [value, setValue] = useState(closesOn ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  if (!closing) return closesOn ? <p className="small text-ink-2">Last day to apply: {calendarDay(closesOn)}</p> : null;
  const today = todayIn(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const save = () => {
    const p = closingDateProblem(value, today);
    setProblem(p);
    if (!p) closing.onSave(value);
  };
  return (
    <section className="grid gap-2 rounded-xl border border-line p-4" aria-labelledby="draft-closes-h">
      <h2 id="draft-closes-h" className={SUBHEAD}>Closing date</h2>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Last day to apply (optional)" htmlFor="draft-closes-on"><input id="draft-closes-on" className="input max-w-[220px]" type="date" min={today} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Button size="sm" variant="primary" loading={closing.saving} disabled={!value || value === closesOn} onClick={save}>Save the date</Button>
        {closesOn ? <Button size="sm" variant="ghost" disabled={closing.saving} onClick={() => closing.onSave(null)}>Take the date off</Button> : null}
      </div>
      {problem || closing.error ? <p className="small font-medium text-caution">{problem ?? closing.error}</p> : null}
    </section>
  );
}

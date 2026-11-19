"use client";

import { Fragment } from "react";
import { IMPORTANCE_LABEL, PACKET_VISIBILITY_LABEL, type DraftRolePacket, type PacketVisibility, type RolePacket } from "@ros/contracts";
import { Card, IconLabel } from "@ros/ui";
import { formQuestionFacts, recordFacts } from "../../jobs";
import { BULLETS, SUBHEAD } from "../look";

/**
 * Who sees a part of the job: the eye when candidates see it or are asked it, the lock otherwise. An icon whose words a
 * screen reader reads and a mouse sees as a tooltip, so the same is said without the words on screen.
 */
export function SeenBy({ v }: { v: PacketVisibility }) {
  return <IconLabel icon={v === "public" || v === "asked" ? "eye" : "lock"} label={PACKET_VISIBILITY_LABEL[v]} />;
}

/** Rows inside a card, divided by hairlines. */
const ROWS = "grid divide-y divide-line [&>li]:py-2.5 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0";

/**
 * The job record as a person reads it, on a job's Job tab and in the job builder once the job is written: the
 * description, the facts, the requirements, the skills, the screening questions of the application form and the AI
 * interview's questions. `pay`: whether candidates see the range, as a job's page knows it; a draft says what was chosen.
 * `extra`: facts the record does not hold (the closing date). `wide`: on a wide screen the details and the skills sit in
 * a narrower column beside the rest; left out, everything is one column (the job builder's pane).
 */
export function JobRecord({ packet: p, pay, extra = [], wide }: { packet: RolePacket | DraftRolePacket; pay?: { shown: boolean; requiredByLaw: boolean }; extra?: Array<{ label: string; value: string }>; wide?: boolean }) {
  const details = (
    <Card title="Details" aside={<SeenBy v="public" />}>
      <dl className="glance">
        {[...recordFacts(p, pay), ...extra].map((f) => <Fragment key={f.label}><dt>{f.label}</dt><dd>{f.value}</dd></Fragment>)}
      </dl>
    </Card>
  );
  const skills = p.competencies.length ? (
    <Card title="Skills" aside={<SeenBy v="reviewed" />}>
      <ul className={ROWS}>
        {p.competencies.map((c) => (
          <li key={c.key} className="grid gap-0.5">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong>{c.name}</strong><span className="inline-tag">{IMPORTANCE_LABEL[c.importance]}</span></span>
            {c.definition ? <span className="small muted">{c.definition}</span> : null}
          </li>
        ))}
      </ul>
    </Card>
  ) : null;
  return (
    <div className={wide ? "grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]" : "grid min-w-0 gap-5"}>
      <div className="grid min-w-0 gap-5">
      <Card title="Job description" aside={<SeenBy v="public" />}>
        <p className="whitespace-pre-wrap text-ink-2 wrap-anywhere">{p.description.publicJobDescription}</p>
      </Card>
      {wide ? null : details}
      <Card title="Requirements" aside={<SeenBy v="public" />}>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <h3 className={SUBHEAD}>Must-haves</h3>
            <ul className={BULLETS}>{p.requirements.mustHaves.map((m) => <li key={m.key}>{m.text}</li>)}</ul>
          </div>
          {p.requirements.niceToHaves.length ? (
            <div className="grid gap-1.5">
              <h3 className={SUBHEAD}>Nice-to-haves</h3>
              <ul className={BULLETS}>{p.requirements.niceToHaves.map((m) => <li key={m.key}>{m.text}</li>)}</ul>
            </div>
          ) : null}
        </div>
      </Card>
      {wide ? null : skills}
      <Card title="Screening questions" aside={<SeenBy v="asked" />}>
        {p.formQuestions.length ? (
          <ul className={ROWS}>
            {p.formQuestions.map((q) => (
              <li key={q.key} className="grid gap-0.5">
                <span>{q.question}</span>
                <span className="small muted">{formQuestionFacts(q)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="small muted">None.</p>}
      </Card>
      <Card title={`AI interview (about ${p.screening.maxMinutes} minutes)`} aside={<SeenBy v="asked" />}>
        <ol className={ROWS}>
          {p.screening.questions.map((q, i) => (
            <li key={q.key} className="flex items-start gap-3"><span className="ordinal mt-px">{i + 1}</span><span className="min-w-0 flex-1">{q.question}</span></li>
          ))}
        </ol>
      </Card>
      </div>
      {wide ? <div className="grid min-w-0 gap-5">{details}{skills}</div> : null}
    </div>
  );
}

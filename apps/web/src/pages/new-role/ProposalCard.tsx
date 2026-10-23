"use client";

import type { PacketRevisionProposal } from "@ros/contracts";
import { Button, Icon } from "@ros/ui";
import { SeenBy } from "./marks";
import { changeLine, proposalSections, takesEffectWords } from "./refine-api";
import type { SectionId } from "./rules";

/** The panel's name for each part a change can touch, as the proposal card lists them. */
const PART_NAME: Record<SectionId, string> = {
  basics: "the basics",
  about: "What you'll do",
  must: "What we're looking for",
  nice: "Nice to have",
  screening: "the screening questions",
  eligibility: "the application form's questions",
  why: "why you're hiring",
  team: "who interviews and decides",
  start: "the start date",
  dealbreakers: "the deal-breakers",
};

/** "Changes What you'll do and Nice to have." */
export function partsLine(ids: readonly SectionId[]): string {
  const names = ids.map((id) => PART_NAME[id]);
  if (!names.length) return "";
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Changes ${list}.`;
}

/** How many changed fields the card lists before saying how many more there are. */
const SHOWN = 8;

/**
 * A change the assistant proposes (plan C10): its summary, every changed field with what it was and what it would be
 * (and who sees it), anything it would not do and why, what the wording check would flag, and what Confirm does. Nothing
 * changes until the person presses Confirm or Keep as is. `onShow` takes the reader to the changed parts of the draft.
 * The changed fields are rows like a table's (screenshot 4): the field, what changes, and who sees it (the eye or the lock).
 */
export function ProposalCard(props: { proposal: PacketRevisionProposal; onConfirm: () => void; onKeep: () => void; onShow?: () => void; confirming: boolean; keeping?: boolean }) {
  const p = props.proposal;
  const ids = proposalSections(p);
  const changes = p.diff.sections.flatMap((s) => s.changes.map((c) => ({ ...c, section: s.label })));
  return (
    <section className="grid min-w-0 gap-3 rounded-2xl border border-line-tint bg-surface p-4 shadow-sm motion-safe:animate-enter sm:p-5" aria-label="Proposed change">
      <p className="eyebrow live">Proposed change, not saved yet</p>
      <p className="text-[15px] font-medium leading-snug text-ink">{p.summary}</p>
      {changes.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label="What would change">
          {changes.slice(0, SHOWN).map((c) => (
            // on a phone the field and its eye or lock share the first line, the change goes under them
            <li key={`${c.path}-${c.kind}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3.5 py-3 text-[14px] sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_auto] sm:gap-4">
              <span className="min-w-0 font-semibold text-ink wrap-anywhere">{c.label}</span>
              <span className="min-w-0 text-ink-2 wrap-anywhere max-sm:col-span-full">{changeLine(c)}</span>
              <SeenBy v={c.visibility} className="justify-self-end max-sm:col-start-2 max-sm:row-start-1" />
            </li>
          ))}
          {changes.length > SHOWN ? <li className="px-3.5 py-2.5 text-[13px] text-ink-3">and {changes.length - SHOWN} more {changes.length - SHOWN === 1 ? "change" : "changes"}</li> : null}
        </ul>
      ) : null}
      {p.notChanged.length ? (
        <ul className="grid list-disc gap-1 pl-[18px] text-[13px] text-ink-2" aria-label="Not done">
          {p.notChanged.map((n) => <li key={n.request}>Not done: {n.request}. {n.reason}</li>)}
        </ul>
      ) : null}
      {p.newFlags.length ? <p className="small inline-flex items-start gap-1.5 text-caution"><Icon name="flag" size={13} className="mt-[3px] shrink-0" />The wording check would flag {p.newFlags.map((f) => `"${f.text}"`).join(", ")}; if you confirm, it asks you about it before approval.</p> : null}
      {p.guardChanges.length ? <p className="small muted">{p.guardChanges.join(" ")}</p> : null}
      <p className="small muted">
        {ids.length ? `${partsLine(ids)} ` : ""}{takesEffectWords(p.takesEffect)}{" "}
        {props.onShow && ids.length ? <button type="button" className="link-btn" onClick={props.onShow}>Show me</button> : null}
      </p>
      <div className="row">
        <Button variant="primary" size="sm" loading={props.confirming} disabled={!p.sections.length || props.keeping} onClick={props.onConfirm}>Confirm</Button>
        <Button size="sm" loading={props.keeping} disabled={props.confirming} onClick={props.onKeep}>Keep as is</Button>
      </div>
    </section>
  );
}

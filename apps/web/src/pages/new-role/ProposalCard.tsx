"use client";

import { PACKET_VISIBILITY_LABEL, type PacketRevisionProposal } from "@ros/contracts";
import { Button, Icon } from "@ros/ui";
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
 */
export function ProposalCard(props: { proposal: PacketRevisionProposal; onConfirm: () => void; onKeep: () => void; onShow?: () => void; confirming: boolean; keeping?: boolean }) {
  const p = props.proposal;
  const ids = proposalSections(p);
  const changes = p.diff.sections.flatMap((s) => s.changes.map((c) => ({ ...c, section: s.label })));
  return (
    <section className="proposal" aria-label="Proposed change">
      <p className="proposal-head"><Icon name="sparkle" size={14} /> Proposed change, not saved yet</p>
      <p>{p.summary}</p>
      {changes.length ? (
        <ul className="proposal-changes" aria-label="What would change">
          {changes.slice(0, SHOWN).map((c) => (
            <li key={`${c.path}-${c.kind}`}>
              <span className="proposal-field">{c.label}</span>
              <span className="proposal-change">{changeLine(c)}</span>
              <span className="seen-by">{PACKET_VISIBILITY_LABEL[c.visibility]}</span>
            </li>
          ))}
          {changes.length > SHOWN ? <li className="small muted">and {changes.length - SHOWN} more {changes.length - SHOWN === 1 ? "change" : "changes"}</li> : null}
        </ul>
      ) : null}
      {p.notChanged.length ? (
        <ul className="small" style={{ margin: 0, paddingLeft: 18, color: "var(--ink-2)" }} aria-label="Not done">
          {p.notChanged.map((n) => <li key={n.request}>Not done: {n.request}. {n.reason}</li>)}
        </ul>
      ) : null}
      {p.newFlags.length ? <p className="small" style={{ color: "var(--caution)" }}>The wording check would flag {p.newFlags.map((f) => `"${f.text}"`).join(", ")}; if you confirm, it asks you about it before approval.</p> : null}
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

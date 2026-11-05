"use client";

import { LOCKED_WORD, MORE_CANDIDATES_LINE, MORE_CANDIDATES_UPGRADE_QUESTION, type LockedApplicants } from "@ros/contracts";
import { IconChip } from "@ros/ui";
import { appliedWhen } from "../talent-list";
import { moreLockedWords } from "../upgrade";
import { Upgrade } from "./Upgrade";

/** How many locked people show as cards of their own before the rest fold into one line. */
const CARDS_SHOWN = 3;

/**
 * A person past the plan's candidates per job (the plans of 5 November 2026, Rule 3): a lock, the word, when they applied, the
 * line and the way on. Never a name, initials, a score, a stage or a source: the server sends none of them. `what` takes the
 * place of the word for a group folded into one card. locked-card is a hook for tests and e2e (no CSS).
 */
function LockedRow({ when, what = LOCKED_WORD }: { when?: string; what?: string }) {
  return (
    <li className="locked-card flex flex-wrap items-center gap-x-3 gap-y-2.5 px-4 py-3.5 sm:px-5">
      <IconChip icon="lock" size="sm" />
      <span className="grid min-w-0 flex-[1_1_12rem] gap-0.5">
        <strong className="text-[15px] font-semibold leading-snug text-ink">{what}</strong>
        <span className="text-[13px] text-ink-3">{when ? `${when} · ` : ""}{MORE_CANDIDATES_LINE}</span>
      </span>
      <Upgrade size="sm" reason={MORE_CANDIDATES_UPGRADE_QUESTION} />
    </li>
  );
}

/** The locked people of one job, after its list and its board: one card each, the rest in one line. */
export function LockedCandidates({ locked }: { locked: LockedApplicants | null | undefined }) {
  if (!locked?.count) return null;
  const cards = locked.cards.slice(0, CARDS_SHOWN);
  const rest = locked.count - cards.length;
  return (
    <ul className="list-card divide-y divide-line" aria-label="Locked candidates">
      {cards.map((c) => <LockedRow key={c.position} when={appliedWhen(c.appliedAt)} />)}
      {rest > 0 ? <LockedRow what={moreLockedWords(rest)} /> : null}
    </ul>
  );
}

/** A direct link to someone locked: the same card in the panel, not an error. */
export function LockedCard() {
  return <ul className="list-card" aria-label="Locked candidate"><LockedRow /></ul>;
}

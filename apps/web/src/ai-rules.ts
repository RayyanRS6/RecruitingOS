import { LEVELS, type PolicyLevel } from "./policy-levels";

/**
 * "What the AI may do on its own" in Setup (plan B7), the pure parts: which rules the product acts on today, and the
 * question asked before a rule is loosened.
 */

const RANK: Record<PolicyLevel, number> = { auto: 0, auto_notify: 1, approval: 2, human_only: 3 };

/** The "still reviewing" note (plan G10) as Settings names it: short, since the note under it says what it does. */
export const STILL_REVIEWING_LABEL = "Send a \"still reviewing\" note to anyone waiting 30 days after applying";

/**
 * What each level does for the "still reviewing" note, said under the rule: only "Do it" and "Do it and tell me" send it,
 * once per application, never to someone set aside as not a fit for now; any other choice sends none. It starts off
 * ("Only a person"; founder decision of 9 October 2026): a team with many applicants picks the best few and tells the
 * rest itself, so nothing goes unless the company switches it on.
 */
const STILL_REVIEWING_SENDS = "One short, courteous email per applicant, once: their application is still being reviewed, no decision has been made, and people on your team decide. It carries the same AI notice as every automatic email, and says nothing about how they are doing.";
const STILL_REVIEWING_NONE = "Off: no note goes by itself, so keep in touch with people who have waited a long time yourself. It starts off; choose \"Do it\" if you want the note sent for you.";
export const STILL_REVIEWING_NOTE: Record<PolicyLevel, string> = { auto: STILL_REVIEWING_SENDS, auto_notify: STILL_REVIEWING_SENDS, approval: STILL_REVIEWING_NONE, human_only: STILL_REVIEWING_NONE };

/** Loosening: a level that leaves more to happen without a person (Only a person, Ask me first, Do it and tell me, Do it). */
export function loosens(from: PolicyLevel, to: PolicyLevel): boolean {
  return RANK[to] < RANK[from];
}

const levelWord = (l: PolicyLevel) => LEVELS.find((x) => x.value === l)?.label ?? l;

/** What each level means once chosen, true for every action on the list. */
const EFFECT: Record<PolicyLevel, string> = {
  auto: "it goes ahead without waiting for a person to approve it, and you are not told each time",
  auto_notify: "it goes ahead without waiting for a person to approve it, and you are told afterwards",
  approval: "it waits until a person approves it",
  human_only: "only a person does it",
};

/** The question Setup asks before saving a looser rule. Tightening a rule saves at once. */
export function looseningQuestion(action: string, from: PolicyLevel, to: PolicyLevel): string {
  return `Change "${action}" from "${levelWord(from)}" to "${levelWord(to)}"? From now on ${EFFECT[to]}. You can change it back at any time, and the change is recorded.`;
}

/**
 * Whether a rule offers a choice of levels: one the product reads (`settable`), or an "always a person" guarantee
 * (shown with its one level). Work the product does the same way for everyone is shown with what it does instead, so
 * nobody picks a level that changes nothing. A list from an API that does not say (no `settable`) offers every choice.
 */
export function hasChoice(row: { settable?: boolean; locked: boolean }): boolean {
  return row.settable !== false || row.locked;
}

/**
 * The list in two parts: what the product does today, with every "always a person" guarantee kept in view; and what is
 * planned, folded under "Coming later" with no choice to make. A list from an API that does not say (no `available`)
 * is shown whole.
 */
export function splitRules<T extends { available?: boolean; locked: boolean }>(rows: readonly T[]): { now: T[]; later: T[] } {
  return { now: rows.filter((r) => r.available !== false || r.locked), later: rows.filter((r) => r.available === false && !r.locked) };
}

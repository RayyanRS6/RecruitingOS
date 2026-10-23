import { IMPORTANCE_LABEL, type MatchScore, type ReadingVersion } from "@ros/contracts";
import type { CompareCandidate, CompareResponse } from "../../api/client";
import { scoreBasis, scoreRank } from "../../talent-list";

/**
 * The comparison view (docs/spec/21 F10; founder decision B2): up to five people side by side, each one's match score
 * on top, then one line per must-have and per skill with how much of it was met and the points it cost. Kept free of
 * React so it can be tested (tests/web/compare-view.test.ts). The columns stay in the order the person chose unless
 * they ask for the highest score first; people decide either way.
 */
export const COMPARE_MAX = 5;

/** GET /roles/:id/compare since Wave F: each person's match score and version label, and the role's current version. */
export type CompareCandidateView = CompareCandidate & { score?: MatchScore | null; readingVersion?: ReadingVersion | null };
export type CompareView = Omit<CompareResponse, "candidates"> & { version?: number | null; candidates: CompareCandidateView[] };

export type CompareOrder = "chosen" | "score";
export const COMPARE_ORDERS: ReadonlyArray<{ value: CompareOrder; label: string }> = [
  { value: "chosen", label: "As you chose them" },
  { value: "score", label: "Highest score first" },
];

/**
 * The columns: as chosen, or the highest score first, like with like as "Sort: Score" on the list (R20-9, `scoreRank`):
 * scores that count the AI interview (or an older answer that does not say) first, then résumé-only scores, then no
 * score yet; within each, the highest first, the chosen order among equals.
 */
export function orderCandidates<T extends { score?: MatchScore | null }>(cands: readonly T[], order: CompareOrder): T[] {
  if (order === "chosen") return [...cands];
  const rank = (c: T) => scoreRank({ score: c.score?.score ?? null, interview: c.score?.interview ?? null });
  const value = (c: T) => c.score?.score ?? -1;
  return cands.map((c, i) => ({ c, i })).sort((x, y) => rank(x.c) - rank(y.c) || value(y.c) - value(x.c) || x.i - y.i).map((x) => x.c);
}

/**
 * What the top line of a column says: the number and its band, what it rests on (the coverage, and the label, R20-9:
 * "Résumé only: AI interview not done yet" beside an interviewed person's "From the résumé and the AI interview"), and
 * any missing must-have.
 */
export function scoreSummary(c: CompareCandidateView): { score: number | null; band: string | null; coverage: string | null; basis: string | null; missing: string[] } {
  const m = c.score;
  if (!m) return { score: null, band: null, coverage: "No AI review yet", basis: null, missing: [] };
  return { score: m.score, band: m.bandLabel, coverage: m.coverage.words, basis: scoreBasis(m), missing: m.missingMustHave.map((x) => `Missing must-have: ${x.label}`) };
}

/**
 * One cell: what the score counted for this requirement (`judged`, with % met and the points it cost), a requirement
 * the evidence says nothing about (`unknown`, left out of the score), a finding the score could not use because the
 * reading was made against an earlier version of the role (`raw`, the words only), or nothing at all (`none`).
 */
export type CompareCell =
  | { state: "judged"; words: string; pctMet: number; pointsLost: number; mustHave: boolean; quote: string | null }
  | { state: "unknown"; words: string }
  | { state: "raw"; words: string; quote: string | null }
  | { state: "none"; words: string };

const RAW_WORDS: Record<string, string> = { yes: "Shown", partially: "Partly shown", no: "Not met", unknown: "Not known yet", evidenced: "Shown", partially_evidenced: "Partly shown", not_evidenced: "Not shown yet", contradicted: "Goes against it" };

export function criterionCell(c: CompareCandidateView, key: string, mustHave: boolean): CompareCell {
  const judged = c.score?.breakdown.find((b) => b.key === key && b.mustHave === mustHave);
  if (judged) return { state: "judged", words: judged.finding, pctMet: judged.pctMet, pointsLost: judged.pointsLost, mustHave, quote: judged.quote };
  if (c.score?.unknown.some((u) => u.key === key && u.mustHave === mustHave)) return { state: "unknown", words: "Not known yet, left out of the score" };
  const raw = mustHave ? c.mustHaves[key]?.met : c.competencies[key]?.finding;
  if (raw) return { state: "raw", words: RAW_WORDS[raw] ?? raw.replace(/_/g, " "), quote: mustHave ? (c.mustHaves[key]?.quote ?? null) : null };
  return { state: "none", words: "No evidence yet" };
}

/** A skill row's tag (Essential, Important, Helpful), from whichever column's score knows it; null when none does. */
export function skillTag(cands: readonly CompareCandidateView[], key: string): string | null {
  for (const c of cands) {
    const imp = c.score?.breakdown.find((b) => b.key === key && !b.mustHave)?.importance ?? c.score?.unknown.find((u) => u.key === key && !u.mustHave)?.importance;
    if (imp) return IMPORTANCE_LABEL[imp];
  }
  return null;
}

/** "50% met · 6 points lost", under a judged cell's bar. */
export function cellFigures(cell: Extract<CompareCell, { state: "judged" }>): string {
  return `${cell.pctMet}% met · ${cell.pointsLost > 0 ? `${cell.pointsLost} ${cell.pointsLost === 1 ? "point" : "points"} lost` : cell.pctMet >= 100 ? "full marks" : "under 1 point lost"}`;
}

/**
 * The people whose reading was made against an earlier version of the role (plan F4): their score uses the requirements
 * as they were then, and a requirement that has changed since shows only the words, or nothing.
 */
export function versionNotes(cands: readonly CompareCandidateView[]): string[] {
  return cands.filter((c) => c.readingVersion).map((c) => `${c.name}: ${c.readingVersion!.label}`);
}

/**
 * Whether the table shows the team's private notes (plan H3): when anyone compared has one. The API sends notes only to
 * those who read them (an empty list to everyone else), so nobody else ever sees the row.
 */
export function hasTeamNotes(cands: ReadonlyArray<Pick<CompareCandidateView, "notes">>): boolean {
  return cands.some((c) => Array.isArray(c.notes) && c.notes.length > 0);
}

/**
 * The line beside the order switch while "Highest score first" is on: how the columns are ranked, and that people
 * decide. The order as chosen needs no line (the switch shows it). `mixed`: some scores count the AI interview and some
 * are résumé-only (`mixedScores`), so the line says why a lower number can come first (R20-9).
 */
export function orderLine(count: number, mixed = false): string {
  const who = count === 1 ? "1 person" : `${count} people`;
  return `${who}, the highest match score first${mixed ? ", scores with the AI interview in them before résumé-only ones" : ""}. A score helps you read; it never decides.`;
}

/** Whether the people compared have both kinds of score: one that counts the AI interview and one from the résumé only. */
export function mixedScores(cands: ReadonlyArray<{ score?: MatchScore | null }>): boolean {
  const ranks = new Set(cands.filter((c) => c.score?.score !== null && c.score?.score !== undefined).map((c) => scoreRank({ score: c.score!.score, interview: c.score!.interview ?? null })));
  return ranks.size > 1;
}

/** The picker: tick up to five; once five are ticked the rest wait until one is unticked. */
export function togglePick(picked: readonly string[], id: string, on: boolean): string[] {
  if (!on) return picked.filter((x) => x !== id);
  if (picked.includes(id) || picked.length >= COMPARE_MAX) return [...picked];
  return [...picked, id];
}

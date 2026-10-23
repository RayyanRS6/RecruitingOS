import { MATCH_WEIGHT, importanceOf, matchWeightOf, previewMatch, type Importance, type MatchCriterion } from "@ros/contracts";
import type { BoardCard, BoardView, RolePacket } from "./api/client";
import { READ_FROM_NOW_ON, type EditorFocus } from "./skills-form";

/**
 * "Try different weights" (founder decision L-07 A, preview only): the owner, or whoever may edit the job, changes how
 * much each must-have and each scored skill counts and watches the candidates' order change. Every number here is worked
 * out in the browser from the scores GET /roles/:id/board already sent (each card's breakdown), with the same sums as
 * the real score (packages/contracts previewMatch). Nothing is read again, no AI is asked, nothing is saved, stored or
 * sent, and the real scores and order never change. "Use these weights" opens the job's own editor, where saving makes
 * a new version of the job. Pure, so tests/web/weights-preview.test.ts checks it without a page.
 */

/** How much a requirement counts in the preview: the job's own levels, and "Leave out of the score". */
export type WeightLevel = "must_have" | Importance | "off";
export const WEIGHT_LEVEL_LABEL: Record<WeightLevel, string> = { must_have: "Must-have", essential: "Essential", important: "Important", helpful: "Helpful", off: "Leave out of the score" };
/** The weight of each level, the real score's own (MATCH_WEIGHT); left out counts nothing. */
export const LEVEL_WEIGHT: Record<WeightLevel, number> = { must_have: MATCH_WEIGHT.must_have, essential: MATCH_WEIGHT.essential, important: MATCH_WEIGHT.important, helpful: MATCH_WEIGHT.helpful, off: 0 };

export const PREVIEW_LABEL = "Preview — nothing is saved; candidates and the team never see these numbers.";
export const INTERVIEW_ONLY_LINE = "Skills checked only in your own interviews are not part of the match score, so they are not listed here.";
export const USE_WEIGHTS_LINE = `"Use these weights" opens the job's editor; saving there makes a new version of the job. ${READ_FROM_NOW_ON}`;
export const NOBODY_SCORED = { title: "Nobody has a match score yet", body: "Scores come once applications are read. Come back when someone has one." } as const;

/** One must-have or scored skill to weigh. `id` is `m:<key>` or `s:<key>`, so a must-have and a skill with the same key never clash. */
export type WeightRow = { id: string; key: string; label: string; mustHave: boolean; level: WeightLevel; choices: WeightLevel[] };
/** The level picked for each row, by row id. */
export type WeightLevels = Record<string, WeightLevel>;

const MUST_HAVE_CHOICES: WeightLevel[] = ["must_have", "off"];
const SKILL_CHOICES: WeightLevel[] = ["essential", "important", "helpful", "off"];

/**
 * The rows to weigh, from the version the job runs on: its must-haves first (a must-have, or left out), then the skills
 * the score counts (Essential, Important, Helpful, or left out). A skill checked only in your own interviews is not in the
 * score, so it is not here (INTERVIEW_ONLY_LINE says so).
 */
export function weightRows(packet: Pick<RolePacket, "requirements" | "competencies">): WeightRow[] {
  const must = packet.requirements.mustHaves.map((m): WeightRow => ({ id: `m:${m.key}`, key: m.key, label: m.text, mustHave: true, level: "must_have", choices: MUST_HAVE_CHOICES }));
  const skills = packet.competencies.filter((c) => c.evaluatedIn !== "interview").map((c): WeightRow => ({ id: `s:${c.key}`, key: c.key, label: c.name, mustHave: false, level: importanceOf(c), choices: SKILL_CHOICES }));
  return [...must, ...skills];
}

/** The page's id for a row's select: weights-m-<key> or weights-s-<key>. */
export const weightFieldId = (row: Pick<WeightRow, "key" | "mustHave">): string => `weights-${row.mustHave ? "m" : "s"}-${row.key}`;

/** The job's own levels: where the preview starts, and where "Back to the job's weights" returns. */
export function jobLevels(rows: readonly WeightRow[]): WeightLevels {
  return Object.fromEntries(rows.map((r) => [r.id, r.level]));
}

const levelOf = (row: WeightRow, levels: WeightLevels): WeightLevel => levels[row.id] ?? row.level;

/** The rows set to something other than the job's own level. */
export function changedRows(rows: readonly WeightRow[], levels: WeightLevels): WeightRow[] {
  return rows.filter((r) => levelOf(r, levels) !== r.level);
}

/**
 * One scored person in the preview's order: the real score now, the preview's, their place in it and how far they moved.
 * `resumeOnly` (R20-9): their score does not count an AI interview yet (any `interview` but `done`; an older answer
 * without it reads as not résumé only), marked "résumé only" on the row.
 */
export type PreviewRow = { applicationId: string; name: string; place: string; now: number; preview: number | null; rank: number; moved: number; readAgainst: number | null; resumeOnly: boolean };
export type PreviewOrder = { rows: PreviewRow[]; unscored: number; moved: number };

type Person = Omit<PreviewRow, "rank" | "moved">;

// Highest first, no score last; then by name and the application, so equal scores always stand in the same order.
const byScore = (score: (p: Person) => number | null) => (a: Person, b: Person): number => {
  const x = score(a);
  const y = score(b);
  if (x !== y) {
    if (x === null) return 1;
    if (y === null) return -1;
    return y - x;
  }
  return a.name.localeCompare(b.name) || a.applicationId.localeCompare(b.applicationId);
};

type Scored = BoardCard & { score: NonNullable<BoardCard["score"]> & { score: number } };
const hasScore = (c: BoardCard): c is Scored => typeof c.score?.score === "number";

/**
 * Everyone on the board with a match score (the three columns and the lane "No AI interview yet"), in the order the preview
 * gives them, beside the order their real scores give them today. A level applies only where it was changed: a reading
 * made against an earlier version of the job keeps that version's weights for everything left as it is (so with the job's
 * own levels, every preview equals the real score), and a requirement the job no longer has keeps its own weight.
 */
export function previewOrder(board: Pick<BoardView, "columns"> & Partial<Pick<BoardView, "noAiInterview" | "stillApplying">>, rows: readonly WeightRow[], levels: WeightLevels): PreviewOrder {
  const changed = new Map(changedRows(rows, levels).map((r) => [r.id, levelOf(r, levels)]));
  const weightOf = (c: MatchCriterion): number => {
    const level = changed.get(`${c.mustHave ? "m" : "s"}:${c.key}`);
    return level === undefined ? matchWeightOf(c) : LEVEL_WEIGHT[level];
  };
  const seen = new Set<string>();
  const cards: BoardCard[] = [];
  for (const c of [...board.columns.shortlist, ...board.columns.longlist, ...board.columns.not_moving_forward, ...(board.noAiInterview ?? board.stillApplying ?? [])]) {
    if (seen.has(c.applicationId)) continue;
    seen.add(c.applicationId);
    cards.push(c);
  }
  const scored = cards.filter(hasScore);
  const people = scored.map((c): Person => ({ applicationId: c.applicationId, name: c.name, place: c.ownerStageLabel, now: c.score.score, preview: previewMatch(c.score, weightOf).score, readAgainst: c.readingVersion?.readAgainst ?? null, resumeOnly: !!c.score.interview && c.score.interview !== "done" }));
  const today = new Map([...people].sort(byScore((p) => p.now)).map((p, i) => [p.applicationId, i + 1]));
  const ordered = [...people].sort(byScore((p) => p.preview)).map((p, i): PreviewRow => ({ ...p, rank: i + 1, moved: (today.get(p.applicationId) ?? i + 1) - (i + 1) }));
  return { rows: ordered, unscored: cards.length - scored.length, moved: ordered.filter((p) => p.moved !== 0).length };
}

/** "Up 2 places", "Down 1 place", or nothing when they stay where they are. */
export function movedWords(n: number): string {
  if (!n) return "";
  const places = Math.abs(n) === 1 ? "place" : "places";
  return `${n > 0 ? "Up" : "Down"} ${Math.abs(n)} ${places}`;
}

/** The line over the order, read out when it changes. `changed` is how many rows differ from the job's own levels. */
export function previewStatus(changed: number, order: Pick<PreviewOrder, "moved">): string {
  if (!changed) return "These are the job's own weights: this is the order today.";
  if (!order.moved) return "With these weights, nobody changes place.";
  return order.moved === 1 ? "With these weights, 1 person changes place." : `With these weights, ${order.moved} people change place.`;
}

/** Each change in words: "Chairside skill: from Essential to Helpful", or "…: from Must-have to left out of the score". */
export function changeWords(rows: readonly WeightRow[], levels: WeightLevels): string[] {
  return changedRows(rows, levels).map((r) => {
    const to = levelOf(r, levels);
    return `${r.label}: from ${WEIGHT_LEVEL_LABEL[r.level]} to ${to === "off" ? "left out of the score" : WEIGHT_LEVEL_LABEL[to]}`;
  });
}

/**
 * Where "Use these weights" opens the editor: at the skills when any skill changed, otherwise at the must-haves. Named
 * focusFor, not useFocus: it is not a React hook, and a `use` name would read as one to the hook rules.
 */
export function focusFor(rows: readonly WeightRow[], levels: WeightLevels): EditorFocus {
  return changedRows(rows, levels).some((r) => !r.mustHave) ? "skills" : "must-haves";
}

/** The small line under a name: where they are, "résumé only" when no AI interview is in their score (R20-9), and an earlier version of the job. */
export function placeWords(row: Pick<PreviewRow, "place" | "readAgainst" | "resumeOnly">): string {
  return `${row.place}${row.resumeOnly ? " · résumé only" : ""}${row.readAgainst ? ` · Read against version ${row.readAgainst}` : ""}`;
}

/** "Preview 88 · now 91": plain numbers, never the score badge, so they never pass for real scores. */
export function scoreWords(row: Pick<PreviewRow, "now" | "preview">): string {
  return row.preview === null ? `No score with these weights · now ${row.now}` : `Preview ${row.preview} · now ${row.now}`;
}

/** The people on the board with no match score yet, who are not in the order. */
export function unscoredWords(n: number): string {
  if (!n) return "";
  return n === 1 ? "1 person has no match score yet, so they are not in this order." : `${n} people have no match score yet, so they are not in this order.`;
}

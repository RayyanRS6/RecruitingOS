import { IMPORTANCE_LABEL, IMPORTANCE_WEIGHT, MISSING_MUST_HAVE_CAP, importanceOf, type Importance } from "@ros/contracts";
import type { RolePacket } from "./api/client";

/**
 * The plain rubric editor (plan F3, F12; founder decision B2): the role's skills as form rows, each with what it means,
 * how much it counts in the match score (Essential, Important or Helpful) and where it is checked. Pure, so
 * tests/web/skills-form.test.ts can check that a save keeps what the form does not show (each skill's indicators), keeps
 * the screening questions and interview rounds pointing at skills that exist, and respects the packet's limits (3 to 8
 * skills). Used by apps/web/src/pages/RoleEditor.tsx.
 */

export const SKILLS_MIN = 3;
export const SKILLS_MAX = 8;

export const IMPORTANCE_CHOICES: ReadonlyArray<{ value: Importance; label: string }> = (["essential", "important", "helpful"] as const).map((value) => ({ value, label: IMPORTANCE_LABEL[value] }));

/** How each choice counts, in words the editor shows under the choice. Must-haves always count most. */
export const IMPORTANCE_HINT: Record<Importance, string> = {
  essential: "Counts the most of the skills.",
  important: "Counts, less than an essential skill.",
  helpful: "Counts a little.",
};

export const CHECKED_IN: ReadonlyArray<{ value: SkillRow["evaluatedIn"]; label: string }> = [
  { value: "screen", label: "The screening chat" },
  { value: "interview", label: "The interviews" },
  { value: "both", label: "Both" },
];

export type SkillRow = { key: string | null; name: string; definition: string; importance: Importance; evaluatedIn: "screen" | "interview" | "both" };

/** A skill as the packet holds it; the web's RolePacket type names only what the pages read. */
type PacketSkill = RolePacket["competencies"][number] & { importance?: Importance; indicators?: string[] };
type PacketQuestion = RolePacket["screening"]["questions"][number] & { competencyKey?: string };

const EVALUATED: ReadonlyArray<SkillRow["evaluatedIn"]> = ["screen", "interview", "both"];

export function skillRowsFrom(p: RolePacket): SkillRow[] {
  return (p.competencies as PacketSkill[]).map((c) => ({ key: c.key, name: c.name, definition: c.definition, importance: importanceOf(c), evaluatedIn: EVALUATED.includes(c.evaluatedIn as SkillRow["evaluatedIn"]) ? (c.evaluatedIn as SkillRow["evaluatedIn"]) : "both" }));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "skill";
}

/** What leans on a skill: the screening questions that ask about it and the interview rounds that check it. */
export type SkillUses = { questions: string[]; rounds: Array<{ title: string; only: boolean }> };

/**
 * What uses the skill `key`, with whether a round checks it alone among the skills still kept (`kept`): such a round
 * would be left checking nothing, so that skill cannot be removed until the round checks another.
 */
export function skillUses(p: RolePacket, key: string, kept: ReadonlyArray<string | null> = []): SkillUses {
  const keep = new Set(kept.filter((k): k is string => !!k && k !== key));
  const questions = (p.screening.questions as PacketQuestion[]).filter((q) => q.competencyKey === key).map((q) => q.question);
  const rounds = p.interviews.plan.filter((r) => r.competencyKeys.includes(key)).map((r) => ({ title: r.title, only: !r.competencyKeys.some((k) => keep.has(k)) }));
  return { questions, rounds };
}

/**
 * What the editor says before a skill is removed: what leans on it and what happens to that, or why it cannot go yet.
 * Null when nothing uses it (it simply goes).
 */
export function removalWords(name: string, uses: SkillUses): { text: string; blocked: boolean } | null {
  const lonely = uses.rounds.find((r) => r.only);
  const label = name.trim() || "This skill";
  if (lonely) return { text: `${label} is the only skill the interview round "${lonely.title}" checks, so it cannot be removed yet. Rename it instead, or give that round another skill on the Interview plan tab first.`, blocked: true };
  if (!uses.questions.length && !uses.rounds.length) return null;
  const parts: string[] = [];
  if (uses.questions.length) parts.push(uses.questions.length === 1 ? `the screening question "${uses.questions[0]}" asks about it` : `${uses.questions.length} screening questions ask about it`);
  if (uses.rounds.length) parts.push(uses.rounds.length === 1 ? `the interview round "${uses.rounds[0].title}" checks it` : `${uses.rounds.length} interview rounds check it`);
  return { text: `${label}: ${parts.join(", and ")}. Removing it unlinks them; the questions and rounds themselves stay as they are.`, blocked: false };
}

/** The first thing wrong with the skills, in the owner's words, or null when they can be saved. */
export function skillsProblem(rows: readonly SkillRow[], p: RolePacket): string | null {
  const filled = rows.filter((r) => r.name.trim());
  if (filled.length < SKILLS_MIN) return `Keep at least ${SKILLS_MIN} skills: the match score and the interviews are built on them.`;
  if (filled.length > SKILLS_MAX) return `At most ${SKILLS_MAX} skills.`;
  if (filled.some((r) => !r.definition.trim())) return "Every skill needs a line on what it means.";
  const names = filled.map((r) => r.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Two skills have the same name. Give each its own.";
  const kept = new Set(filled.map((r) => r.key).filter((k): k is string => !!k));
  const known = new Set(p.competencies.map((c) => c.key));
  const empty = p.interviews.plan.find((r) => r.competencyKeys.some((k) => known.has(k)) && !r.competencyKeys.some((k) => kept.has(k)));
  if (empty) return `The interview round "${empty.title}" would check no skill. Keep one of the skills it checks.`;
  return null;
}

/**
 * Writes the skills into `next` (a copy of the packet being edited): an existing row keeps its key and everything the
 * form does not show (its indicators); a new one gets a readable key and its meaning as its first indicator. A changed
 * importance is saved with the weight that goes with it (the API's packet guard does the same). A removed skill is
 * unlinked from the screening questions and interview rounds that pointed at it. Empty rows are dropped.
 */
export function applySkills(next: RolePacket, rows: readonly SkillRow[]): void {
  const before = new Map((next.competencies as PacketSkill[]).map((c) => [c.key, c]));
  const filled = rows.filter((r) => r.name.trim());
  // existing keys never change (readings and rounds refer to them); a new skill's key steers clear of all of them
  const used = new Set(filled.map((r) => r.key).filter((k): k is string => !!k && before.has(k)));
  const skills = filled.map((r, i): PacketSkill => {
    const was = r.key ? before.get(r.key) : undefined;
    let key = was ? was.key : `comp_${i + 1}_${slug(r.name)}`;
    if (!was) {
      while (used.has(key)) key = `${key}_${i + 1}`;
      used.add(key);
    }
    const definition = r.definition.trim();
    // an importance left as it was keeps the weight it had, so saving without touching a skill changes nothing
    const weighting = was && importanceOf(was) === r.importance ? {} : { importance: r.importance, weight: IMPORTANCE_WEIGHT[r.importance] };
    return { ...(was ?? { weight: IMPORTANCE_WEIGHT[r.importance] }), key, name: r.name.trim(), definition, evaluatedIn: r.evaluatedIn, indicators: was?.indicators?.length ? was.indicators : [definition], ...weighting };
  });
  next.competencies = skills;
  // only the skills taken out are unlinked; anything else a question or round points at is left as it was
  const keys = new Set(skills.map((s) => s.key));
  const removed = (k: string) => before.has(k) && !keys.has(k);
  for (const q of next.screening.questions as PacketQuestion[]) if (q.competencyKey && removed(q.competencyKey)) delete q.competencyKey;
  for (const r of next.interviews.plan) r.competencyKeys = r.competencyKeys.filter((k) => !removed(k));
}

/** A new, empty skill row: Important until someone says otherwise, checked in both. */
export function newSkillRow(): SkillRow {
  return { key: null, name: "", definition: "", importance: "important", evaluatedIn: "both" };
}

/** The sections a link can open the role editor at (`?edit=must-haves` or `?edit=skills` on the role page). */
export type EditorFocus = "must-haves" | "skills";
export function editorFocusFrom(value: string | null | undefined): EditorFocus | null {
  return value === "must-haves" || value === "skills" ? value : null;
}

/** How each kind of requirement counts in the match score, in one line for the editor and the role page. */
export const SCORE_WEIGHTS_LINE = "In the match score, must-haves count the most, then Essential skills, then Important, then Helpful. Anything the evidence does not show either way is left out, never counted against anyone.";

/**
 * What a saved change does to the scores: each person is scored against the version of the role their reading was made
 * against (plan F4), so a change counts for people read from now on, and the panel labels anyone read before it.
 */
export const READ_FROM_NOW_ON = "A change counts for people read from now on; anyone already read keeps the version they were read against, and their page says which.";

/** Under the must-haves on the role page: what they do to the match score. */
export const MUST_HAVES_SCORE_LINE = `Must-haves count the most in each applicant's match score. One their own words show is missing holds the score at ${MISSING_MUST_HAVE_CAP} at most and is named on their card; one the evidence does not mention is left out, never counted against them.`;

/** A skill's importance in words (Essential, Important, Helpful): the one a person picked, or the one its weight stands for. */
export function importanceLabel(c: { weight: number; importance?: Importance | null }): string {
  return IMPORTANCE_LABEL[importanceOf(c)];
}

/** Where a skill is checked, in words. */
export function checkedInLabel(value: string): string {
  return { screen: "screening chat", interview: "interviews", both: "screening chat and interviews" }[value] ?? value.replace(/_/g, " ");
}

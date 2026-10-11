/**
 * The four levels of "What the AI may do on its own", and which of them Setup offers for one action. The API sends each
 * action's floor and ceiling (MIN_LEVELS and MAX_LEVELS in packages/core/src/policy.ts) and refuses anything outside
 * them, so the page never offers a choice that would be refused.
 */
export type PolicyLevel = "auto" | "auto_notify" | "approval" | "human_only";

export const LEVELS: ReadonlyArray<{ value: PolicyLevel; label: string }> = [
  { value: "auto", label: "Do it" },
  { value: "auto_notify", label: "Do it and tell me" },
  { value: "approval", label: "Ask me first" },
  { value: "human_only", label: "Only a person" },
];

const RANK: Record<PolicyLevel, number> = { auto: 0, auto_notify: 1, approval: 2, human_only: 3 };

export function allowedLevels(row: { locked: boolean; minLevel?: PolicyLevel | null; maxLevel?: PolicyLevel | null }): Array<{ value: PolicyLevel; label: string }> {
  if (row.locked) return LEVELS.filter((l) => l.value === "human_only");
  const min = row.minLevel ? RANK[row.minLevel] : 0;
  const max = row.maxLevel ? RANK[row.maxLevel] : 3;
  return LEVELS.filter((l) => RANK[l.value] >= min && RANK[l.value] <= max);
}

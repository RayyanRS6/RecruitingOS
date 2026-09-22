import type { Playbook, PlaybookRole } from "@ros/contracts";
import { dentalPlaybook } from "./dental.v1";
import { consumerPlaybook } from "./consumer.v1";

export { dentalPlaybook, consumerPlaybook };

export const ALL_PLAYBOOKS: Playbook[] = [consumerPlaybook, dentalPlaybook];

/**
 * Which playbook serves which company vertical. The consumer playbook is the launch wedge (docs/FOUNDER-CONTEXT.md §06):
 * consumer, beauty, retail and e-commerce, creative and marketing, and tech-enabled services share hiring patterns.
 */
export const VERTICAL_TO_PLAYBOOK: Record<string, string> = {
  consumer: "consumer",
  beauty: "consumer",
  ecommerce: "consumer",
  retail: "consumer",
  marketing: "consumer",
  creative: "consumer",
  agency: "consumer",
  saas: "consumer",
  tech_services: "consumer",
  professional_services: "consumer",
  dental: "dental",
};

export function findPlaybook(vertical: string): Playbook | null {
  const v = vertical.trim().toLowerCase();
  const key = VERTICAL_TO_PLAYBOOK[v] ?? v;
  return ALL_PLAYBOOKS.find((p) => p.vertical === key) ?? null;
}

/** Matches a free-text title to a playbook role by title and aliases. */
export function matchPlaybookRole(playbook: Playbook, titleText: string): PlaybookRole | null {
  const t = titleText.toLowerCase();
  let best: { role: PlaybookRole; score: number } | null = null;
  for (const role of playbook.roles) {
    const names = [role.title, ...role.aliases].map((n) => n.toLowerCase());
    for (const n of names) {
      if (t.includes(n)) {
        const score = n.length;
        if (!best || score > best.score) best = { role, score };
      }
    }
  }
  return best?.role ?? null;
}

/** Picks the compensation row whose metro best matches the location text, else the national row, else the first. */
export function compensationFor(role: PlaybookRole, locationText: string | undefined) {
  const loc = (locationText ?? "").toLowerCase();
  const tokens = loc.split(/[^a-z]+/).filter((s) => s.length > 2);
  let best: (typeof role.compensation)[number] | null = null;
  let bestScore = 0;
  for (const row of role.compensation) {
    const metro = row.metro.toLowerCase();
    let score = 0;
    for (const tk of tokens) if (metro.includes(tk)) score += 1;
    if (loc.includes("orange county") && metro.includes("anaheim")) score += 2;
    if (loc.includes("irvine") && metro.includes("anaheim")) score += 2;
    if ((loc.includes("brooklyn") || loc.includes("manhattan") || loc.includes(" ny")) && metro.includes("new york")) score += 2;
    if (score > bestScore) { best = row; bestScore = score; }
  }
  return best ?? role.compensation.find((r) => r.metro.toLowerCase().includes("national")) ?? role.compensation[0] ?? null;
}

import type { PublicPlan } from "@ros/contracts";

/**
 * The upgrade sheet's words and rules (the plans of 5 November 2026, Rule 5), kept free of React so they can be tested
 * (tests/web/upgrade.test.ts). A customer reads prices in dollars, and the AI help in words, never in dollars. Nothing here
 * compares a plan's name: what a plan offers comes with it from GET /api/v1/plans.
 */

/** "$49 a month", or "$0" for a plan that costs nothing: the sheet's price line. */
export function priceWords(monthlyUsd: number): string {
  return monthlyUsd > 0 ? `$${monthlyUsd.toLocaleString("en-US")} a month` : "$0";
}

/** What a plan includes, in the sheet's order: jobs, candidates per job, people, AI help. A null number means no limit. */
export function planFacts(plan: PublicPlan): Array<{ label: string; value: string }> {
  const count = (n: number | null) => (n === null ? "No limit" : String(n));
  return [
    { label: "Jobs", value: plan.jobsTotal !== null ? String(plan.jobsTotal) : plan.activeRoles !== null ? `${plan.activeRoles} at a time` : "No limit" },
    { label: "Candidates per job", value: count(plan.candidatesPerJob) },
    { label: "People", value: count(plan.seats) },
    { label: "AI help", value: plan.aiHelp },
  ];
}

/** The plan already chosen when the sheet opens: the next one above the company's, or the first it is not on. */
export function firstChoice(plans: readonly PublicPlan[]): PublicPlan | null {
  const at = plans.findIndex((p) => p.current);
  return plans[at + 1] ?? plans.find((p) => !p.current) ?? null;
}

/** An action the API offers (a card's, a refusal's) that is a request about the plan: it opens the upgrade sheet, never sends in one click. */
export function isPlanAsk(action: { path?: string; body?: Record<string, unknown> | null }): boolean {
  return !!action.path?.includes("/escalations") && action.body?.topic === "plan";
}

/** Why the request is being made, from such an action's body: goes after the plan's name in the question. */
export function reasonOf(body: Record<string, unknown> | null | undefined): string | undefined {
  return typeof body?.question === "string" ? body.question : undefined;
}

/** A group of locked people folded into one line on the list and the board. */
export function moreLockedWords(n: number): string {
  return `${n} more ${n === 1 ? "candidate is" : "candidates are"} locked`;
}

/** Beside the board's counts. */
export function boardLockedWords(n: number): string {
  return `${n} more ${n === 1 ? "is" : "are"} locked`;
}

/** Beside the report's applicant total. */
export function reportLockedLabel(n: number): string {
  return n === 1 ? "person is locked" : "people are locked";
}

/** Under a list of names that leaves out the people the team cannot read. */
export function cannotSeeYetWords(n: number): string {
  return `and ${n} more you cannot see yet`;
}

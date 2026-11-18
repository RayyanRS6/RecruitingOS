import { AI_HELP_UPGRADE_QUESTION, MORE_JOBS_UPGRADE_QUESTION, type PlanRoom, type PublicPlan } from "@ros/contracts";
import { longDay } from "./dates";
import { TRIAL_ASK } from "./trial";

/**
 * The upgrade sheet's words and rules, kept free of React so they can be tested. A customer reads prices in dollars and
 * the AI help in words, never in dollars. Nothing here compares a plan's name: what a plan offers comes with it from
 * GET /api/v1/plans.
 */

/** The sheet's price line: "$49" and "a month", or "$0" alone for a plan that costs nothing. */
export function priceWords(monthlyUsd: number): { amount: string; per: string | null } {
  return { amount: `$${monthlyUsd.toLocaleString("en-US")}`, per: monthlyUsd > 0 ? "a month" : null };
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

/**
 * The plan already chosen when the sheet opens: the next one above the company's. None on the last plan, and none on a
 * plan that is not in the list (the private pilot, Trial), where the first of the list would be a plan below theirs.
 */
export function firstChoice(plans: readonly PublicPlan[]): PublicPlan | null {
  const at = plans.findIndex((p) => p.current);
  return at < 0 ? null : plans[at + 1] ?? null;
}

/** What stands in place of the Upgrade button while a request is with ITS: "Request sent on November 18, 2026". */
export function requestSentWords(requestedAt: string): string {
  return `Request sent on ${longDay(requestedAt)}`;
}

/** A group of locked people folded into one line under a job's candidates. */
export function moreLockedWords(n: number): string {
  return `${n} more ${n === 1 ? "candidate is" : "candidates are"} locked`;
}

/**
 * The request about the plan to offer when it has no room for another job: the button's words and the reason sent
 * with the request. A refusal by the API carries its own (`PlanLimitDetails.ask`); the room read with a list of drafts
 * or with Home carries none, so it is worked out from what ran out.
 */
export function roomAsk(room: Pick<PlanRoom, "trialEnded" | "upgrade" | "aiHelp" | "nothingAbove">): { label: string; reason: string } {
  if (room.trialEnded) return { label: "Ask ITS to choose a plan", reason: TRIAL_ASK };
  const label = room.nothingAbove ? "Talk to ITS" : "Upgrade";
  return { label, reason: room.aiHelp ? AI_HELP_UPGRADE_QUESTION : MORE_JOBS_UPGRADE_QUESTION };
}

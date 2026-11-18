import type { TrialStanding } from "@ros/contracts";

/**
 * The Trial plan's 30 days as the pages say them, kept free of React so the words can be tested. Dates are on the
 * company's own calendar, as the server's notices say them.
 */

/** The zone a company has when it never chose one (the database's default). */
const DEFAULT_ZONE = "America/Los_Angeles";

/** A trial date in words on the company's calendar: "October 30" (`short`: "Oct 30"). */
export function trialDate(iso: string, timeZone?: string | null, opts: { short?: boolean } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const words = (zone: string) => d.toLocaleDateString("en-US", { timeZone: zone, month: opts.short ? "short" : "long", day: "numeric" });
  try {
    return words(timeZone || DEFAULT_ZONE);
  } catch {
    return words(DEFAULT_ZONE);
  }
}

/** What Settings says after the plan's name on the Trial plan: "Trial until October 30", or that it ended. Null on another plan. */
export function trialPlanLine(trial: TrialStanding | null | undefined, timeZone?: string | null): string | null {
  if (!trial?.started || !trial.endsAt) return null;
  return trial.ended ? `Trial ended on ${trialDate(trial.endsAt, timeZone)}` : `Trial until ${trialDate(trial.endsAt, timeZone)}`;
}

/** Why ITS is asked to choose a plan once a trial has ended: sent with the request from the upgrade sheet. */
export const TRIAL_ASK = "We would like to choose a plan to keep hiring after our trial.";

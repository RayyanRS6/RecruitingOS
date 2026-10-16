import { TRIAL_DAYS, TRIAL_ENDED_LINE, seatsFullLine, type TrialStanding } from "@ros/contracts";

/**
 * The Trial plan's 30 days and its 3 people (founder decision L-02 B) as the team's pages say them, kept free of React
 * so the words can be tested (tests/web/trial.test.ts). GET /companies/current carries `trial` (where the 30 days
 * stand, null on another plan) and `usage.seats` (people in use, counting invitations not yet answered). Dates are on
 * the company's own calendar, as the server's notices say them.
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

export type TrialRowWords = { level: "ending" | "ended"; title: string; body: string };

/** The one row owners and admins see on Home and Settings: in the trial's last 7 days, and once it has ended; otherwise none. */
export function trialRow(trial: TrialStanding | null | undefined, timeZone?: string | null): TrialRowWords | null {
  if (!trial?.started || !trial.endsAt) return null;
  if (trial.ended) return { level: "ended", title: "Your trial has ended", body: TRIAL_ENDED_LINE };
  if (trial.endingSoon) return { level: "ending", title: `Your trial ends on ${trialDate(trial.endsAt, timeZone)}`, body: "Contact ITS to choose a plan before then; nothing stops until it ends." };
  return null;
}

/** What the Plan line adds after the plan's name: "trial until October 30", or that the 30 days wait for the ITS check. */
export function trialPlanLine(trial: TrialStanding | null | undefined, timeZone?: string | null): string | null {
  if (!trial) return null;
  if (!trial.started || !trial.endsAt) return `your ${TRIAL_DAYS}-day trial starts when ITS confirms your company`;
  if (trial.ended) return `trial ended on ${trialDate(trial.endsAt, timeZone)}`;
  return `trial until ${trialDate(trial.endsAt, timeZone)}`;
}

export type SeatUsage = { used: number; limit: number | null };

/** The people line above the invite form: "Your trial includes 3 people: 2 in use, counting invitations not yet answered." */
export function seatLine(seats: SeatUsage | null | undefined): string | null {
  if (!seats || seats.limit === null) return null;
  return `Your trial includes ${seats.limit} people: ${seats.used} in use, counting invitations not yet answered.`;
}

/** Whether every place is in use, so a new invitation would be refused (the API's 409 `seats_full` says the same). */
export function seatsAllUsed(seats: SeatUsage | null | undefined): boolean {
  return !!seats && seats.limit !== null && seats.used >= seats.limit;
}

/** What the invite form says when every place is in use; the same words as the API's refusal. */
export function seatsFullWords(seats: SeatUsage): string {
  return seatsFullLine(seats.limit ?? 0);
}

/** The request to ITS about choosing a plan, opened in the request form first (never sent in one click). */
export const TRIAL_ASK = { kind: "ask" as const, about: "all" as const, topic: "plan" as const, question: "We would like to choose a plan to keep hiring after our trial." };

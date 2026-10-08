import type { ClosingDateView } from "@ros/contracts";
import { BUSINESS_TIMEZONE, dayKeyIn, zonedToUtc } from "./business-hours";

/**
 * A role's closing date (founder decision Q12, plan D7). The owner picks the last day new applications are taken; at the
 * end of that day, in the company's own time zone, the accepting switch turns off with this reason. Nobody is rejected:
 * people part-way through the form may finish for a while (`CLOSING_GRACE_HOURS`), screens already started go on, and
 * closing the role stays a person's decision. Colorado expects the date on the job ad, so a Colorado (or remote) role
 * that opens without one gets `DEFAULT_CLOSING_DAYS` from the day it opens, which the owner can change.
 */
export const CLOSING_DATE_REASON = "closing date";
export const DEFAULT_CLOSING_DAYS = 30;
/** How long after the closing moment a form opened before it is still accepted. */
export const CLOSING_GRACE_HOURS = 24;

/** The zone the company's days are cut in; one the runtime does not know falls back to the business default. */
export function companyTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return BUSINESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return BUSINESS_TIMEZONE;
  }
}

function dayParts(day: string): [number, number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [y, m, d];
}

/** The moment applications stop: the end of `closesOn` (the midnight that starts the next day) in the company's zone. */
export function closingMoment(closesOn: string, timeZone: string | null | undefined): Date {
  const [y, m, d] = dayParts(closesOn.slice(0, 10));
  return zonedToUtc(y, m, d + 1, 0, 0, companyTimeZone(timeZone));
}

/** A calendar day `days` after `day` (both YYYY-MM-DD). */
export function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = dayParts(day.slice(0, 10));
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today's date in the company's zone. */
export function companyToday(now: Date, timeZone: string | null | undefined): string {
  return dayKeyIn(now, companyTimeZone(timeZone));
}

/** The date a role that needs one gets when it opens without one: thirty days from today, in the company's zone. */
export function defaultClosingDate(now: Date, timeZone: string | null | undefined): string {
  return addCalendarDays(companyToday(now, timeZone), DEFAULT_CLOSING_DAYS);
}

/** "Apply by Friday, October 30, 2026": the line the job and careers pages show (the date itself, never shifted by a zone). */
export function applyByLabel(closesOn: string): string {
  const day = new Date(`${closesOn.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return `Apply by ${day}`;
}

/** The date in words, for messages: "Friday, October 30". */
export function closingDayWords(closesOn: string): string {
  return new Date(`${closesOn.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}

/** Why a closing date cannot be used, or null: it must be today or later in the company's zone. */
export function closingDateProblem(closesOn: string, now: Date, timeZone: string | null | undefined): string | null {
  if (closesOn.slice(0, 10) < companyToday(now, timeZone)) return "Choose today or a later date. A closing date in the past would stop applications at once.";
  return null;
}

/** What the role page, the Posting tab and the job pages need to know about the date. */
export function closingDateView(input: {
  role: { applicationsCloseOn: string | null; acceptingApplications: boolean; applicationsClosedReason: string | null; status: string };
  timeZone: string | null | undefined;
  requiredByLaw: boolean;
  now: Date;
}): ClosingDateView {
  const tz = companyTimeZone(input.timeZone);
  const closesOn = input.role.applicationsCloseOn ? input.role.applicationsCloseOn.slice(0, 10) : null;
  const closesAt = closesOn ? closingMoment(closesOn, tz) : null;
  return {
    closesOn,
    closesAt: closesAt ? closesAt.toISOString() : null,
    applyBy: closesOn ? applyByLabel(closesOn) : null,
    timeZone: tz,
    requiredByLaw: input.requiredByLaw,
    defaultIfMissing: input.requiredByLaw && !closesOn ? defaultClosingDate(input.now, tz) : null,
    passed: !!closesAt && closesAt.getTime() <= input.now.getTime(),
    applicationsClosedByDate: input.role.status !== "closed" && !input.role.acceptingApplications && input.role.applicationsClosedReason === CLOSING_DATE_REASON,
  };
}

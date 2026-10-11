import { BUSINESS_TIMEZONE, zonedParts, zonedToUtc } from "./business-hours";

/**
 * When email summaries go out (plan B3; timed work runs on the worker, decision D20): at 8:00 in the morning in the
 * company's own time zone (`companies.timezone`), every day for the groups a person gets daily, and on Monday mornings
 * for the ones they get weekly. A summary covers what arrived before its own time and was not emailed yet, so a
 * summary that runs late never includes what came in after 8:00, and one that was missed is caught up by the next.
 */
export const DIGEST_HOUR = 8;
/** Weekly summaries go out on this day (0 is Sunday). */
export const WEEKLY_DIGEST_WEEKDAY = 1;
export const WEEKLY_DIGEST_DAY_NAME = "Monday";
/** How far past its own window a summary reaches for updates a missed summary never sent. */
export const DIGEST_CATCH_UP_DAYS = 7;

export type DigestCadence = "daily" | "weekly";

/** A zone the runtime does not know falls back to the business default instead of failing. */
export function digestTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return BUSINESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return BUSINESS_TIMEZONE;
  }
}

/** The summary time on the local day `offsetDays` from the one `at` falls on. */
function digestTimeOn(at: Date, tz: string, offsetDays: number): Date {
  const p = zonedParts(at, tz);
  return zonedToUtc(p.year, p.month, p.day + offsetDays, DIGEST_HOUR, 0, tz);
}

/** The most recent summary time at or before `now`: today's 8:00 once it has come, otherwise yesterday's. */
export function lastDigestAt(now: Date, timeZone: string | null | undefined): Date {
  const tz = digestTimeZone(timeZone);
  const today = digestTimeOn(now, tz, 0);
  return today.getTime() <= now.getTime() ? today : digestTimeOn(now, tz, -1);
}

/** The next summary time strictly after `now`. */
export function nextDigestAt(now: Date, timeZone: string | null | undefined): Date {
  const tz = digestTimeZone(timeZone);
  const today = digestTimeOn(now, tz, 0);
  return today.getTime() > now.getTime() ? today : digestTimeOn(now, tz, 1);
}

/** The cadences a summary at `at` serves: daily always, weekly too on Monday morning (company time). */
export function digestCadencesDue(at: Date, timeZone: string | null | undefined): DigestCadence[] {
  return zonedParts(at, digestTimeZone(timeZone)).weekday === WEEKLY_DIGEST_WEEKDAY ? ["daily", "weekly"] : ["daily"];
}

/**
 * What a summary at `at` covers for one cadence: from the previous summary of that cadence (8:00 the day before, or the
 * Monday before) up to its own time, in local wall-clock time, so a day across a daylight-saving change is 23 or 25
 * hours long and every summary still arrives at 8:00.
 */
export function digestWindow(at: Date, timeZone: string | null | undefined, cadence: DigestCadence): { from: Date; to: Date } {
  const tz = digestTimeZone(timeZone);
  return { from: digestTimeOn(at, tz, cadence === "daily" ? -1 : -7), to: digestTimeOn(at, tz, 0) };
}

import { BUSINESS_TIMEZONE, dayKeyIn, zonedParts, zonedToUtc } from "@ros/core";

/** Applications per day above which the owner is told (docs/spec/20 item 16); `roles.volume_alert_per_day` overrides it per role. */
export const DEFAULT_VOLUME_ALERT_PER_DAY = 100;

export type LocalDays = {
  /** The zone the days are cut in. */
  timeZone: string;
  /** The instant a calendar day begins, `offsetDays` days from today (0 = today, -1 = yesterday). */
  start(offsetDays: number): Date;
  /** The YYYY-MM-DD an instant falls on. */
  key(at: Date): string;
};

/**
 * "A day" for the volume alert and the "Applications by source" report is a calendar day in the company's own time
 * zone (`companies.timezone`), never a UTC day: an owner in California reads "yesterday" as the day that ended at
 * their midnight, so an evening's applications are not split across two labelled days. The daily check and the
 * report cut days with this one helper so they agree. A zone the runtime does not know falls back to the business
 * default instead of failing.
 */
export function localDays(now: Date, timeZone: string | null | undefined): LocalDays {
  const tz = knownTimeZone(timeZone);
  const today = zonedParts(now, tz);
  return {
    timeZone: tz,
    start: (offsetDays) => zonedToUtc(today.year, today.month, today.day + offsetDays, 0, 0, tz),
    key: (at) => dayKeyIn(at, tz),
  };
}

function knownTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return BUSINESS_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return BUSINESS_TIMEZONE;
  }
}

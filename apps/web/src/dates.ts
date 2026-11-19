/**
 * Dates as the signed-in pages say them. Pure, so the words can be tested. A moment is said on the reader's own
 * calendar; a calendar day (a closing date, YYYY-MM-DD) is the same day for everyone. `timeZone` is for tests.
 */

const DAY_MS = 86_400_000;

function moment(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Nov 3", with the year when it is not this year's ("Nov 3, 2025"). Empty for a moment that cannot be read. */
export function shortDay(iso: string | null | undefined, now: Date = new Date(), timeZone?: string): string {
  const d = moment(iso);
  if (!d) return "";
  const year = (x: Date) => x.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year(d) === year(now) ? {} : { year: "numeric" }), timeZone });
}

/** "November 3, 2026". */
export function longDay(iso: string | null | undefined, timeZone?: string): string {
  const d = moment(iso);
  return d ? d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }) : "";
}

/** "Nov 3, 9:14 AM". */
export function dayAndTime(iso: string | null | undefined, timeZone?: string): string {
  const d = moment(iso);
  return d ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }) : "";
}

/** A calendar day (YYYY-MM-DD) in words, "November 30, 2026"; as it was given when it is not a day. */
export function calendarDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return day ?? "";
  const d = new Date(`${day.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { timeZone: "UTC", month: "long", day: "numeric", year: "numeric" });
}

/** How long ago someone applied: "Applied today", "Applied yesterday", "Applied 3 days ago", then "Applied Nov 3". */
export function appliedWhen(iso: string | null | undefined, now: Date = new Date()): string {
  const at = moment(iso);
  if (!at) return "Applied";
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) return "Applied today";
  if (days === 1) return "Applied yesterday";
  if (days < 7) return `Applied ${days} days ago`;
  return `Applied ${shortDay(iso, now)}`;
}

/** A date in the reader's own calendar as YYYY-MM-DD, the form a date field reads and writes. */
export function dayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Pacific Time": a time zone in words; its id when the browser cannot name it. */
export function zoneWords(timeZone: string): string {
  for (const style of ["longGeneric", "long"] as const) {
    try {
      const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: style }).formatToParts(new Date(Date.UTC(2026, 0, 15))).find((p) => p.type === "timeZoneName")?.value;
      if (name) return name;
    } catch {
      // an older browser without this style: try the next one
    }
  }
  return timeZone;
}

/** Today's date in a time zone, as YYYY-MM-DD (the earliest a closing date may be). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Wall-clock arithmetic in a time zone: which calendar day an instant falls on in a company's own zone, and the instant
 * of a wall-clock time there. Daylight saving is handled by asking the runtime for the zone's offset at that moment.
 */

/** The zone used when a company's own is missing or one the runtime does not know. */
export const BUSINESS_TIMEZONE = "America/Los_Angeles";

type Parts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(date: Date, timeZone: string): Parts {
  const map: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(date)) map[p.type] = p.value;
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour);
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), weekday: weekdays[map.weekday] ?? 0, hour, minute: Number(map.minute) };
}

function dateKey(p: Parts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** YYYY-MM-DD of an instant in a time zone. */
export function dayKeyIn(date: Date, timeZone: string): string {
  return dateKey(parts(date, timeZone));
}

/** Wall-clock parts of an instant in a zone; `weekday` is 0 (Sunday) to 6. */
export function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number; dayKey: string } {
  const p = parts(date, timeZone);
  return { ...p, dayKey: dateKey(p) };
}

/** The UTC instant of a wall-clock time in a time zone (two-step offset correction handles daylight saving). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - asUtc;
  }
  return new Date(guess);
}

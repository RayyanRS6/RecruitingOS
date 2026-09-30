/**
 * TCPA-style quiet hours (docs/08): no automated texts before 8:00 or after 21:00 in the recipient's local time.
 * The company's timezone stands in for the candidate's until a candidate timezone is known. A company may narrow the
 * window further with its own business hours (Setup, audit finding J16): days it contacts people and local start and
 * end times. Business hours never widen the legal window.
 */
export const CONTACT_HOURS = { start: 8, end: 21 };

/** The company's preference as stored in companies.settings.businessHours: days 0 (Sunday) to 6, local times "HH:MM". */
export type BusinessHours = { days: number[]; start: string; end: string };

function localParts(now: Date, timezone: string): { day: number; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
    const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")?.value ?? "");
    return { day: day < 0 ? now.getUTCDay() : day, minutes: (h === 24 ? 0 : h) * 60 + m };
  } catch {
    return { day: now.getUTCDay(), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() };
  }
}

export function localHour(now: Date, timezone: string): number {
  return Math.floor(localParts(now, timezone).minutes / 60);
}

function toMinutes(hhmm: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return fallback;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(v) ? v : fallback;
}

/** The window in force: the legal one, narrowed by the company's hours when it has any. */
export function effectiveContactWindow(hours?: BusinessHours | null): { days: Set<number>; startMinutes: number; endMinutes: number } {
  const legalStart = CONTACT_HOURS.start * 60;
  const legalEnd = CONTACT_HOURS.end * 60;
  if (!hours || !Array.isArray(hours.days) || hours.days.length === 0) return { days: new Set([0, 1, 2, 3, 4, 5, 6]), startMinutes: legalStart, endMinutes: legalEnd };
  const start = Math.max(legalStart, toMinutes(hours.start, legalStart));
  const end = Math.min(legalEnd, toMinutes(hours.end, legalEnd));
  const days = new Set(hours.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6));
  // hours that leave no room at all (an end before the start) fall back to the legal window on the chosen days
  return { days: days.size ? days : new Set([0, 1, 2, 3, 4, 5, 6]), startMinutes: end > start ? start : legalStart, endMinutes: end > start ? end : legalEnd };
}

export function withinContactHours(now: Date, timezone: string, hours?: BusinessHours | null): boolean {
  const w = effectiveContactWindow(hours);
  const { day, minutes } = localParts(now, timezone);
  return w.days.has(day) && minutes >= w.startMinutes && minutes < w.endMinutes;
}

/** The next moment texting is allowed: now if inside the window, else the next local opening (to the quarter hour), up to a week ahead. */
export function nextContactWindow(now: Date, timezone: string, hours?: BusinessHours | null): Date {
  if (withinContactHours(now, timezone, hours)) return now;
  let t = new Date(Math.ceil(now.getTime() / 900_000) * 900_000);
  for (let i = 0; i < 7 * 24 * 4; i++) {
    if (withinContactHours(t, timezone, hours)) return t;
    t = new Date(t.getTime() + 900_000);
  }
  return t;
}

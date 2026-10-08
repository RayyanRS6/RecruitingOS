/**
 * ITS business hours (founder decision F12; correction 12 of 18 September 2026 makes them an editable calendar).
 * Service-level clocks count only open hours; candidate-facing copy sets expectations from them.
 *
 * Every function takes a calendar source. Without one it uses the built-in default (Monday to Friday, 9:00 to 17:00
 * Pacific, US federal holidays), which is also what the product falls back to before an administrator has published a
 * calendar version. A source may resolve a different calendar per day so that a version with a future effective date
 * applies exactly from that date, even inside one deadline computation.
 */

export type HoursWindow = { start: string; end: string }; // "HH:MM" wall-clock, end exclusive
export type WeekdayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAY_KEYS: readonly WeekdayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export type WeeklyHours = Record<WeekdayKey, HoursWindow[]>;
export type CalendarHoliday = { date: string; name: string };
export type CalendarClosure = { from: string; to: string; name: string };
/** A temporary change of coverage: different hours, or none (`hours: null`), for every day in the range. */
export type CoverageChange = { from: string; to: string; reason: string; hours: HoursWindow[] | null };
export type BusinessCalendar = { timeZone: string; hours: WeeklyHours; holidays: CalendarHoliday[]; closures: CalendarClosure[]; coverageChanges: CoverageChange[] };
/** A fixed calendar, or a resolver that returns the calendar in force on a given day (YYYY-MM-DD in `timeZone`). */
export type CalendarSource = BusinessCalendar | { timeZone: string; forDay(dayKey: string): BusinessCalendar };

export const BUSINESS_TIMEZONE = "America/Los_Angeles";
export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 17;

/** Observed US federal holidays. The default calendar carries these; administrators maintain the live list. */
export const DEFAULT_US_FEDERAL_HOLIDAYS: readonly CalendarHoliday[] = [
  { date: "2026-01-01", name: "New Year's Day" }, { date: "2026-01-19", name: "Birthday of Martin Luther King, Jr." }, { date: "2026-02-16", name: "Washington's Birthday" },
  { date: "2026-05-25", name: "Memorial Day" }, { date: "2026-06-19", name: "Juneteenth National Independence Day" }, { date: "2026-07-03", name: "Independence Day (observed)" },
  { date: "2026-09-07", name: "Labor Day" }, { date: "2026-10-12", name: "Columbus Day" }, { date: "2026-11-11", name: "Veterans Day" }, { date: "2026-11-26", name: "Thanksgiving Day" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" }, { date: "2027-01-18", name: "Birthday of Martin Luther King, Jr." }, { date: "2027-02-15", name: "Washington's Birthday" },
  { date: "2027-05-31", name: "Memorial Day" }, { date: "2027-06-18", name: "Juneteenth National Independence Day (observed)" }, { date: "2027-07-05", name: "Independence Day (observed)" },
  { date: "2027-09-06", name: "Labor Day" }, { date: "2027-10-11", name: "Columbus Day" }, { date: "2027-11-11", name: "Veterans Day" }, { date: "2027-11-25", name: "Thanksgiving Day" },
  { date: "2027-12-24", name: "Christmas Day (observed)" }, { date: "2027-12-31", name: "New Year's Day 2028 (observed)" },
];
export const US_FEDERAL_HOLIDAYS: ReadonlySet<string> = new Set(DEFAULT_US_FEDERAL_HOLIDAYS.map((h) => h.date));

const WEEKDAY_WINDOW: HoursWindow[] = [{ start: "09:00", end: "17:00" }];
export const DEFAULT_BUSINESS_CALENDAR: BusinessCalendar = {
  timeZone: BUSINESS_TIMEZONE,
  hours: { sun: [], mon: WEEKDAY_WINDOW, tue: WEEKDAY_WINDOW, wed: WEEKDAY_WINDOW, thu: WEEKDAY_WINDOW, fri: WEEKDAY_WINDOW, sat: [] },
  holidays: [...DEFAULT_US_FEDERAL_HOLIDAYS],
  closures: [],
  coverageChanges: [],
};

type Parts = { year: number; month: number; day: number; weekday: number; hour: number; minute: number };
type Window = { start: string; end: string; startMin: number; endMin: number };

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

/** The UTC instant of a wall-clock time in a time zone (two-step offset correction handles daylight saving). */
function fromZoned(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - asUtc;
  }
  return new Date(guess);
}

function dateKey(p: Parts): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** YYYY-MM-DD of an instant in the calendar's time zone. */
export function dayKeyIn(date: Date, timeZone: string): string {
  return dateKey(parts(date, timeZone));
}
/** Wall-clock parts of an instant in a zone (scheduling reuses the same daylight-saving-safe arithmetic). */
export function zonedParts(date: Date, timeZone: string): { year: number; month: number; day: number; weekday: number; hour: number; minute: number; dayKey: string } {
  const p = parts(date, timeZone);
  return { ...p, dayKey: dateKey(p) };
}
/** The instant of a wall-clock time in a zone. */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  return fromZoned(year, month, day, hour, minute, timeZone);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function calendarFor(src: CalendarSource, dayKey: string): BusinessCalendar {
  return "forDay" in src ? src.forDay(dayKey) : src;
}

/** The open windows on a day, after holidays, closures and coverage changes. Empty means closed. */
export function windowsForDay(src: CalendarSource, dayKey: string, weekday: number): { windows: Window[]; reason: string | null } {
  const cal = calendarFor(src, dayKey);
  const holiday = cal.holidays.find((h) => h.date === dayKey);
  if (holiday) return { windows: [], reason: holiday.name };
  const closure = cal.closures.find((c) => c.from <= dayKey && dayKey <= c.to);
  if (closure) return { windows: [], reason: closure.name };
  const changes = cal.coverageChanges.filter((c) => c.from <= dayKey && dayKey <= c.to);
  const change = changes[changes.length - 1];
  const raw = change ? change.hours ?? [] : cal.hours[WEEKDAY_KEYS[weekday]] ?? [];
  const windows = raw.map((w) => ({ ...w, startMin: toMinutes(w.start), endMin: toMinutes(w.end) })).filter((w) => w.endMin > w.startMin).sort((a, b) => a.startMin - b.startMin);
  return { windows, reason: change ? change.reason : null };
}

function windowEndContaining(date: Date, src: CalendarSource): Date | null {
  const tz = src.timeZone;
  const p = parts(date, tz);
  const nowMin = p.hour * 60 + p.minute;
  for (const w of windowsForDay(src, dateKey(p), p.weekday).windows) {
    if (nowMin >= w.startMin && nowMin < w.endMin) return fromZoned(p.year, p.month, p.day, Math.floor(w.endMin / 60), w.endMin % 60, tz);
  }
  return null;
}

export function isBusinessDay(date: Date, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): boolean {
  const p = parts(date, src.timeZone);
  return windowsForDay(src, dateKey(p), p.weekday).windows.length > 0;
}

export function isBusinessTime(date: Date, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): boolean {
  return windowEndContaining(date, src) !== null;
}

/** The next moment the business is open: `date` itself when already open. */
export function nextBusinessOpen(date: Date, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): Date {
  const tz = src.timeZone;
  const p = parts(date, tz);
  const nowMin = p.hour * 60 + p.minute;
  for (const w of windowsForDay(src, dateKey(p), p.weekday).windows) {
    if (nowMin >= w.startMin && nowMin < w.endMin) return date;
    if (nowMin < w.startMin) return fromZoned(p.year, p.month, p.day, Math.floor(w.startMin / 60), w.startMin % 60, tz);
  }
  for (let i = 1; i <= 400; i++) {
    const q = parts(fromZoned(p.year, p.month, p.day + i, 12, 0, tz), tz);
    const ws = windowsForDay(src, dateKey(q), q.weekday).windows;
    if (ws.length) return fromZoned(q.year, q.month, q.day, Math.floor(ws[0].startMin / 60), ws[0].startMin % 60, tz);
  }
  return date; // a calendar with no open day in 400 days is misconfigured; do not spin
}

/** Adds business hours to an instant, counting only open minutes. */
export function addBusinessHours(from: Date, hours: number, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): Date {
  let remaining = Math.round(hours * 60);
  let cursor = nextBusinessOpen(from, src);
  for (let guard = 0; guard < 4000 && remaining > 0; guard++) {
    const end = windowEndContaining(cursor, src);
    if (!end) return cursor; // never open (misconfigured calendar)
    const minutesLeft = Math.round((end.getTime() - cursor.getTime()) / 60_000);
    if (remaining <= minutesLeft) return new Date(cursor.getTime() + remaining * 60_000);
    remaining -= minutesLeft;
    cursor = nextBusinessOpen(end, src);
  }
  return cursor;
}

/** Open minutes between two instants; negative when `b` is before `a`. */
export function businessMinutesBetween(a: Date, b: Date, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): number {
  if (b.getTime() < a.getTime()) return -businessMinutesBetween(b, a, src);
  let total = 0;
  let cursor = nextBusinessOpen(a, src);
  for (let guard = 0; guard < 4000 && cursor.getTime() < b.getTime(); guard++) {
    const end = windowEndContaining(cursor, src);
    if (!end) break;
    const segmentEnd = Math.min(end.getTime(), b.getTime());
    total += (segmentEnd - cursor.getTime()) / 60_000;
    cursor = nextBusinessOpen(end, src);
  }
  return Math.round(total);
}

/**
 * Business hours per escalation kind (decision D26). One business day is eight business hours. Urgency never changes
 * them (founder decision Q32, option A): an urgent request goes to the front of the ITS queue with the same reply-by time.
 */
export function slaBusinessHours(kind: string): number {
  switch (kind) {
    case "candidate_issue": return 4;
    case "negotiation": return 2;
    case "platform_blocking": return 2;
    case "ask": case "review": case "search_support": case "stuck_role": case "takeover": case "data_request": return 8;
    default: return 8;
  }
}

/** When a recruiter request of this kind, raised (or reopened) at `from`, is due an answer. The form shows it before sending. */
export function escalationReplyBy(kind: string, from: Date, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): Date {
  return addBusinessHours(from, slaBusinessHours(kind), src);
}

const ZONE_NAMES: Record<string, string> = {
  "America/Los_Angeles": "Pacific", "America/Denver": "Mountain", "America/Phoenix": "Arizona", "America/Chicago": "Central", "America/New_York": "Eastern",
  "America/Anchorage": "Alaska", "Pacific/Honolulu": "Hawaii", UTC: "UTC",
};
const DAY_NAMES: Record<WeekdayKey, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

function clockWord(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${hour12}:${String(m).padStart(2, "0")}` : String(hour12);
}
function windowsText(ws: HoursWindow[]): string {
  return ws.map((w) => `${clockWord(w.start)} to ${clockWord(w.end)}`).join(" and ");
}

/** Plain-language hours for customer and candidate copy, e.g. "Monday to Friday, 9 to 5 Pacific". */
export function describeHours(src: CalendarSource = DEFAULT_BUSINESS_CALENDAR, at: Date = new Date()): string {
  const cal = calendarFor(src, dayKeyIn(at, src.timeZone));
  const zone = ZONE_NAMES[cal.timeZone] ?? cal.timeZone;
  const key = (d: WeekdayKey) => JSON.stringify(cal.hours[d] ?? []);
  const weekdays: WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri"];
  const sameWeek = weekdays.every((d) => key(d) === key("mon")) && (cal.hours.mon ?? []).length > 0 && (cal.hours.sat ?? []).length === 0 && (cal.hours.sun ?? []).length === 0;
  if (sameWeek) return `Monday to Friday, ${windowsText(cal.hours.mon)} ${zone}`;
  const open = WEEKDAY_KEYS.filter((d) => (cal.hours[d] ?? []).length > 0);
  if (!open.length) return `by appointment (${zone})`;
  return `${open.map((d) => `${DAY_NAMES[d]} ${windowsText(cal.hours[d])}`).join(", ")} ${zone}`;
}

/** A deadline in words for the people waiting on it, in the calendar's own zone: "Tuesday, October 13 at 2:00 PM Pacific". */
export function deadlineWords(due: Date, src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): string {
  const zone = ZONE_NAMES[src.timeZone] ?? src.timeZone;
  return `${due.toLocaleString("en-US", { timeZone: src.timeZone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} ${zone}`;
}

/** Candidate-facing expectation that is true at the moment it is written (founder decision F12). */
export function humanResponseExpectation(now: Date = new Date(), src: CalendarSource = DEFAULT_BUSINESS_CALENDAR): string {
  return isBusinessTime(now, src)
    ? `within four business hours (we are available ${describeHours(src, now)})`
    : `on the next business day (we are available ${describeHours(src, now)})`;
}

/** A day-by-day view for administrators: what is open, and why a day is closed or different. */
export function previewCalendarDays(src: CalendarSource, from: Date, days: number): Array<{ date: string; weekday: WeekdayKey; open: HoursWindow[]; reason: string | null }> {
  const tz = src.timeZone;
  const p = parts(from, tz);
  const out: Array<{ date: string; weekday: WeekdayKey; open: HoursWindow[]; reason: string | null }> = [];
  for (let i = 0; i < days; i++) {
    const q = parts(fromZoned(p.year, p.month, p.day + i, 12, 0, tz), tz);
    const { windows, reason } = windowsForDay(src, dateKey(q), q.weekday);
    out.push({ date: dateKey(q), weekday: WEEKDAY_KEYS[q.weekday], open: windows.map((w) => ({ start: w.start, end: w.end })), reason });
  }
  return out;
}

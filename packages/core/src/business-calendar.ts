import { eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { businessCalendarVersions, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { DEFAULT_BUSINESS_CALENDAR, dayKeyIn, type BusinessCalendar, type CalendarSource } from "./business-hours";

/**
 * The stored ITS business calendar (correction 12 of 18 September 2026). Each change is a new immutable version with an
 * effective date; the clock functions read the version in force on each day.
 */
export const CALENDAR_KEY = "its";

export type CalendarVersionRow = typeof businessCalendarVersions.$inferSelect;
export type LoadedCalendar = CalendarSource & { current: BusinessCalendar; version: number | null; effectiveFrom: string | null; versions: CalendarVersionRow[] };

export function calendarFromRow(row: CalendarVersionRow): BusinessCalendar {
  const hours = row.hours as BusinessCalendar["hours"];
  return { timeZone: row.timeZone, hours: { sun: hours.sun ?? [], mon: hours.mon ?? [], tue: hours.tue ?? [], wed: hours.wed ?? [], thu: hours.thu ?? [], fri: hours.fri ?? [], sat: hours.sat ?? [] }, holidays: row.holidays, closures: row.closures, coverageChanges: row.coverageChanges };
}

/** All versions, oldest first. The version in force on a day is the latest whose effective date is on or before it. */
export async function listBusinessCalendarVersions(q: Queryable): Promise<CalendarVersionRow[]> {
  const rows = await q.select().from(businessCalendarVersions).where(eq(businessCalendarVersions.calendarKey, CALENDAR_KEY));
  return rows.sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.version - b.version : a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

export function calendarSourceFromVersions(versions: CalendarVersionRow[], at: Date = new Date()): LoadedCalendar {
  const referenceZone = versions.length ? versions[versions.length - 1].timeZone : DEFAULT_BUSINESS_CALENDAR.timeZone;
  const forDay = (dayKey: string): BusinessCalendar => {
    let chosen: CalendarVersionRow | null = null;
    for (const v of versions) if (v.effectiveFrom <= dayKey) chosen = v;
    return chosen ? calendarFromRow(chosen) : DEFAULT_BUSINESS_CALENDAR;
  };
  const todayKey = dayKeyIn(at, referenceZone);
  let currentRow: CalendarVersionRow | null = null;
  for (const v of versions) if (v.effectiveFrom <= todayKey) currentRow = v;
  const current = currentRow ? calendarFromRow(currentRow) : DEFAULT_BUSINESS_CALENDAR;
  return { timeZone: current.timeZone, forDay, current, version: currentRow?.version ?? null, effectiveFrom: currentRow?.effectiveFrom ?? null, versions };
}

export async function loadBusinessCalendar(q: Queryable, at: Date = new Date()): Promise<LoadedCalendar> {
  return calendarSourceFromVersions(await listBusinessCalendarVersions(q), at);
}

/** Publishes a new version. Audited (who, when, what changed, effective from). Never edits an existing version. */
export async function saveBusinessCalendarVersion(
  q: Queryable,
  input: { calendar: BusinessCalendar; effectiveFrom: string; note?: string; actor: Actor },
): Promise<CalendarVersionRow> {
  const existing = await listBusinessCalendarVersions(q);
  const version = existing.reduce((m, v) => Math.max(m, v.version), 0) + 1;
  const [row] = await q
    .insert(businessCalendarVersions)
    .values({ calendarKey: CALENDAR_KEY, version, effectiveFrom: input.effectiveFrom, timeZone: input.calendar.timeZone, hours: input.calendar.hours, holidays: input.calendar.holidays, closures: input.calendar.closures, coverageChanges: input.calendar.coverageChanges, note: input.note ?? "", createdBy: input.actor })
    .returning();
  await audit(q, {
    companyId: null, actor: input.actor, action: "calendar.changed", target: { type: "business_calendar", id: row.id }, reason: input.note ?? "calendar updated",
    details: { version, effectiveFrom: input.effectiveFrom, timeZone: input.calendar.timeZone, hours: input.calendar.hours, holidays: input.calendar.holidays.length, closures: input.calendar.closures.length, coverageChanges: input.calendar.coverageChanges.length },
  });
  return row;
}

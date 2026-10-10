import { and, eq, inArray } from "drizzle-orm";
import { activeMarksFor, effectiveContactWindow, newTimesSettingOf, roleTakenOver, zonedParts, zonedToUtc } from "@ros/core";
import { companies, interviewFollowups, type Queryable } from "@ros/db";
import { companyConfirmed } from "./outbox";
import { workingDayRulesFor, type WorkingDayRules } from "./orchestrator";

/**
 * The one automatic set of new interview times (founder decisions 2A and 3A, 9 October 2026): whether a candidate who
 * cancels a booked interview and asks for new times gets it, and when. It goes N working days after the cancel (3 unless
 * the company chose 1 to 10 in Setup), in the morning of that day in the company's time zone. The day is promised to the
 * candidate at the moment they cancel, so it is worked out once here and stored; nothing recomputes it later.
 */

/** The candidate's own "Ask for a different time" presses (apps/api pages/schedule.tsx): after both, a person arranges the next time. */
export const MAX_CANDIDATE_RESCHEDULES = 2;
/** The automatic email never goes before 09:00 company time, nor before the company's contact hours open. */
const EARLIEST_MINUTES = 9 * 60;
/** Far more calendar days than ten working days can span, holidays included: a safety stop, never reached. */
const MAX_CALENDAR_DAYS = 120;

/**
 * N working days after `from`, one calendar day at a time in the rules' time zone: the company's contact days (Monday to
 * Friday unless it chose fewer), without the ITS calendar's holidays. Each day is read at noon through `zonedToUtc`, so a
 * daylight-saving change can never skip or repeat a day.
 */
export function workingDaysLater(from: Date, rules: WorkingDayRules, days: number): { day: string } {
  const zone = rules.timeZone || "UTC";
  const work = rules.workDays?.length ? rules.workDays : [1, 2, 3, 4, 5];
  const start = zonedParts(from, zone);
  let day = start.dayKey;
  for (let n = 0, i = 1; n < days && i <= MAX_CALENDAR_DAYS; i++) {
    const p = zonedParts(zonedToUtc(start.year, start.month, start.day + i, 12, 0, zone), zone);
    if (!work.includes(p.weekday) || rules.holidays?.has(p.dayKey)) continue;
    n += 1;
    day = p.dayKey;
  }
  return { day };
}

/** The promised moment: 09:00 company time on that day, or the start of the company's contact hours if later. */
export async function newTimesDue(q: Queryable, input: { companyId: string; from: Date; workingDays: number }): Promise<{ at: string; day: string }> {
  const rules = await workingDayRulesFor(q, input.companyId, input.from);
  const [company] = await q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const { day } = workingDaysLater(input.from, rules, input.workingDays);
  const minutes = Math.max(EARLIEST_MINUTES, effectiveContactWindow(company?.settings.businessHours).startMinutes);
  const [y, m, d] = day.split("-").map(Number);
  return { at: zonedToUtc(y, m, d, Math.floor(minutes / 60), minutes % 60, rules.timeZone || "UTC").toISOString(), day };
}

/** Why no automatic set is armed for someone who asked for new times. */
export type AutoPlanReason = "switched_off" | "company_not_checked" | "already_used" | "reschedules_used" | "takeover" | "was_on_hold";
export type AutoPlan = { arm: true; dueAt: string; day: string; workingDays: number } | { arm: false; reason: AutoPlanReason };

/**
 * Whether a candidate who cancels now and asks for new times gets the one automatic set, and its day. Read before the
 * cancel is written, so it says what was true when they chose. In this order:
 * - the company switched automatic new times off in Setup;
 * - ITS has not confirmed the company (founder decision B7): every email to its candidates waits, so no day is promised;
 * - they already had their one automatic set (being prepared, or sent);
 * - they used both "Ask for a different time" presses, so a person arranges the time, as the page promised;
 * - an ITS recruiter is running the role (founder question 7);
 * - a person had put them on hold (founder question 6); the cancel ends the hold, and nothing goes automatically.
 *
 * `lock`: the cancel itself reads the setting under a share lock on the company row, held until it commits. Switching
 * automatic times off locks that row too (apps/api company-settings.ts), so the two take turns: a cancel either armed its
 * set before the switch (and Setup asks about it) or reads the setting as switched off.
 */
export async function autoNewTimesPlan(q: Queryable, input: { companyId: string; roleId: string; applicationId: string; rescheduleCount: number; now: Date; lock?: boolean }): Promise<AutoPlan> {
  const read = q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const [company] = input.lock ? await read.for("share") : await read;
  const setting = newTimesSettingOf(company?.settings);
  if (!setting.auto) return { arm: false, reason: "switched_off" };
  if (!(await companyConfirmed(q, input.companyId))) return { arm: false, reason: "company_not_checked" };
  const [used] = await q.select({ id: interviewFollowups.id }).from(interviewFollowups).where(and(eq(interviewFollowups.applicationId, input.applicationId), inArray(interviewFollowups.autoState, ["preparing", "sent"]))).limit(1);
  if (used) return { arm: false, reason: "already_used" };
  if (input.rescheduleCount >= MAX_CANDIDATE_RESCHEDULES) return { arm: false, reason: "reschedules_used" };
  if (await roleTakenOver(q, input.companyId, input.roleId)) return { arm: false, reason: "takeover" };
  const marks = await activeMarksFor(q, [input.applicationId]);
  if (marks.get(input.applicationId)?.mark === "on_hold") return { arm: false, reason: "was_on_hold" };
  const due = await newTimesDue(q, { companyId: input.companyId, from: input.now, workingDays: setting.workingDays });
  return { arm: true, dueAt: due.at, day: due.day, workingDays: setting.workingDays };
}

/** "Thursday, October 15" in the given zone: the day the candidate is told their new times come. */
export function newTimesDayWords(at: string | Date, timeZone: string): string {
  return new Date(at).toLocaleDateString("en-US", { timeZone, weekday: "long", month: "long", day: "numeric" });
}

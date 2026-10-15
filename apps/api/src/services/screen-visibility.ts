import { inArray, or } from "drizzle-orm";
import { unsentScreenReadings, withoutUnsentScreenEvents } from "@ros/core";
import { assessments, screens, type Tx } from "@ros/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What an activity entry needs for the rule: what it is about, and the reading its payload may name. */
export type ActivityEntry = { type: string; subjectType: string; subjectId: string; payload: Record<string, unknown> };

/**
 * The activity entries as the team may see them (founder decision of 9 October 2026), one rule for every list of them:
 * the activity list (GET /events) and a job's Activity tab (GET /roles/:id/timeline). The screens the entries are about,
 * and the readings they name with the screens of those readings' applications, decide what is held back: nothing about
 * a screening chat the candidate has not sent, no count of what was answered, and no entry about a reading the team may
 * not see (`withoutUnsentScreenEvents`).
 */
export async function withoutUnsentChats<E extends ActivityEntry>(tx: Tx, found: E[]): Promise<E[]> {
  const screenIds = [...new Set(found.filter((e) => e.subjectType === "screen").map((e) => e.subjectId))];
  const readingIds = [...new Set(found.map((e) => (e.payload as { assessmentId?: unknown } | null)?.assessmentId).filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  const readings = readingIds.length ? await tx.select({ id: assessments.id, kind: assessments.kind, result: assessments.result, applicationId: assessments.applicationId }).from(assessments).where(inArray(assessments.id, readingIds)) : [];
  const readingApps = [...new Set(readings.map((r) => r.applicationId))];
  if (!screenIds.length && !readingApps.length) return found;
  const scr = await tx.select({ id: screens.id, status: screens.status, progress: screens.progress, assessmentId: screens.assessmentId }).from(screens).where(or(screenIds.length ? inArray(screens.id, screenIds) : undefined, readingApps.length ? inArray(screens.applicationId, readingApps) : undefined));
  return scr.length || readings.length ? withoutUnsentScreenEvents(found, scr, unsentScreenReadings(scr, readings)) : found;
}

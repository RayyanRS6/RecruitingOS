import { asc, eq, inArray, sql } from "drizzle-orm";
import type { LockedApplicants } from "@ros/contracts";
import { companyHasLocked, lockedAmong, lockedAndWaiting } from "@ros/core";
import { applications, communications, screens, workflowRuns, type Tx } from "@ros/db";

/**
 * What the wall of Rule 3 (the plans of 5 November 2026) does to words already stored: an entry on the activity list, a
 * job's list. The path guard (middleware/candidate-lock.ts) stops the ids in a path; these are for the lists that
 * span many people.
 */

/**
 * The locked people of one job as the team may read them, in arrival order: where they came in, and when. Someone who
 * withdrew or was deleted while locked has no card (`lockedAndWaiting`), and still holds their place in the order.
 */
export async function lockedCardsOf(tx: Tx, roleId: string): Promise<LockedApplicants> {
  const rows = await tx.select({ createdAt: applications.createdAt, waiting: sql<boolean>`${lockedAndWaiting()}` }).from(applications).where(eq(applications.roleId, roleId)).orderBy(asc(applications.createdAt), asc(applications.id));
  const cards = rows.flatMap((r, i) => (r.waiting ? [{ position: i + 1, appliedAt: new Date(r.createdAt).toISOString() }] : []));
  return { count: cards.length, cards };
}

type EventRow = { id: number; subjectType: string; subjectId: string; payload: Record<string, unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only well-formed ids are looked up or compared; anything else in a payload names nothing. */
const str = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

/**
 * The application each event is about: its subject (looked up for screens and messages), or the one its payload names.
 * An event that names none has no entry.
 */
async function applicationOfEvents(tx: Tx, rows: EventRow[]): Promise<Map<number, string>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.subjectType === type).map((r) => r.subjectId).filter((id) => UUID.test(id)))];
  const scr = ids("screen").length ? await tx.select({ id: screens.id, applicationId: screens.applicationId }).from(screens).where(inArray(screens.id, ids("screen"))) : [];
  const comms = ids("communication").length ? await tx.select({ id: communications.id, applicationId: communications.applicationId }).from(communications).where(inArray(communications.id, ids("communication"))) : [];
  const bySubject: Record<string, Array<{ id: string; applicationId: string | null }>> = { screen: scr, communication: comms };
  const out = new Map<number, string>();
  for (const r of rows) {
    const applicationId = r.subjectType === "application" ? r.subjectId : bySubject[r.subjectType]?.find((x) => x.id === r.subjectId)?.applicationId ?? str(r.payload.applicationId);
    if (applicationId) out.set(r.id, applicationId);
  }
  return out;
}

/** Subjects of stored entries whose person cannot be looked up. */
const UNPLACED_SUBJECTS = new Set(["escalation", "interview", "approval_request"]);

/**
 * The activity entries the team may see: one rule for every list of them. An entry is held
 * back when it is about someone locked, whichever way it says so: its subject (an application, or a screen or message
 * of one), the application its payload names, the workflow run working on them, or the person
 * themselves when everything they have here is locked (someone also visible on another job shows through that job).
 * `application.received` is why this looks at the subject and not at the words: a stored entry of someone who applied by
 * email, which an earlier release took, carries their address and a subject line that is often their name. A stored entry
 * about a recruiter request, an in-person interview or an approval can hold words about someone locked, and nothing read
 * here says which was about whom, so none of them is shown. Costs one query for a company with nobody locked.
 */
export async function withoutLockedEvents<E extends EventRow>(tx: Tx, companyId: string, all: E[]): Promise<E[]> {
  if (!all.length || !(await companyHasLocked(tx, companyId))) return all;
  const found = all.filter((e) => !UNPLACED_SUBJECTS.has(e.subjectType));
  const targets = await applicationOfEvents(tx, found);
  const ids = (type: string) => [...new Set(found.filter((e) => e.subjectType === type).map((e) => e.subjectId).filter((id) => UUID.test(id)))];
  const runs = ids("workflow_run").length ? await tx.select({ id: workflowRuns.id, applicationId: sql<string | null>`${workflowRuns.state}->>'applicationId'` }).from(workflowRuns).where(inArray(workflowRuns.id, ids("workflow_run"))) : [];
  // A message about no application in particular (a privacy request's acknowledgment) is about the person.
  const messages = ids("communication").length ? await tx.select({ id: communications.id, applicationId: communications.applicationId, candidateId: communications.candidateId }).from(communications).where(inArray(communications.id, ids("communication"))) : [];
  const personOfMessage = new Map(messages.flatMap((m) => (!m.applicationId && m.candidateId ? [[m.id, m.candidateId] as const] : [])));
  const candidateIds = [...new Set([...ids("candidate"), ...personOfMessage.values()])];
  const people = candidateIds.length ? await tx.select({ candidateId: applications.candidateId, id: applications.id }).from(applications).where(inArray(applications.candidateId, candidateIds)) : [];
  const runOf = new Map<string, string | null>(runs.map((r) => [r.id, r.applicationId] as const));
  const hidden = await lockedAmong(tx, [
    ...targets.values(),
    ...[...runOf.values()].map((id) => id ?? ""),
    ...people.map((p) => p.id),
  ]);
  if (!hidden.size) return found;
  return found.filter((e) => {
    const target = targets.get(e.id);
    if (target && hidden.has(target)) return false;
    const about = e.subjectType === "workflow_run" ? runOf.get(e.subjectId) : null;
    if (about && hidden.has(about)) return false;
    const person = e.subjectType === "candidate" ? e.subjectId : e.subjectType === "communication" ? personOfMessage.get(e.subjectId) : null;
    if (!person) return true;
    const theirs = people.filter((p) => p.candidateId === person);
    return !theirs.length || theirs.some((p) => !hidden.has(p.id));
  });
}

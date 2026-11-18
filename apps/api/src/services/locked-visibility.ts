import { asc, eq, inArray, sql } from "drizzle-orm";
import type { LockedApplicants } from "@ros/contracts";
import { companyHasLocked, lockedAmong, lockedAndWaiting } from "@ros/core";
import { applications, approvalRequests, communications, interviews, screens, workflowRuns, type Tx } from "@ros/db";

/**
 * What the wall of Rule 3 (the plans of 5 November 2026) does to words already stored: an entry on the activity list, an
 * approval, a job's list. The path guard (middleware/candidate-lock.ts) stops the ids in a path; these are for the lists that
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
 * The application each event is about: its subject (looked up for interviews, screens, messages and approval requests),
 * or the one its payload names. An event that names none has no entry.
 */
async function applicationOfEvents(tx: Tx, rows: EventRow[]): Promise<Map<number, string>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.subjectType === type).map((r) => r.subjectId).filter((id) => UUID.test(id)))];
  const ivs = ids("interview").length ? await tx.select({ id: interviews.id, applicationId: interviews.applicationId }).from(interviews).where(inArray(interviews.id, ids("interview"))) : [];
  const scr = ids("screen").length ? await tx.select({ id: screens.id, applicationId: screens.applicationId }).from(screens).where(inArray(screens.id, ids("screen"))) : [];
  const comms = ids("communication").length ? await tx.select({ id: communications.id, applicationId: communications.applicationId }).from(communications).where(inArray(communications.id, ids("communication"))) : [];
  const reqs = ids("approval_request").length ? await tx.select({ id: approvalRequests.id, applicationId: approvalRequests.applicationId }).from(approvalRequests).where(inArray(approvalRequests.id, ids("approval_request"))) : [];
  const bySubject: Record<string, Array<{ id: string; applicationId: string | null }>> = { interview: ivs, screen: scr, communication: comms, approval_request: reqs };
  const out = new Map<number, string>();
  for (const r of rows) {
    const applicationId = r.subjectType === "application" ? r.subjectId : bySubject[r.subjectType]?.find((x) => x.id === r.subjectId)?.applicationId ?? str(r.payload.applicationId);
    if (applicationId) out.set(r.id, applicationId);
  }
  return out;
}

/**
 * The activity entries the team may see: one rule for every list of them, built like `withoutUnsentChats`. An entry is held
 * back when it is about someone locked, whichever way it says so: its subject (an application, or an interview, screen,
 * message or approval of one), the application its payload names, the workflow run working on them, or the person
 * themselves when everything they have here is locked (someone also visible on another job shows through that job).
 * `application.received` is why this looks at the subject and not at the words: an emailed-in applicant's note carries their
 * address and a subject line that is often their name. A stored entry about a recruiter request can hold a recruiter's
 * own words about someone locked, and nothing says which request was about whom, so none of them is shown. Costs one
 * query for a company with nobody locked.
 */
export async function withoutLockedEvents<E extends EventRow>(tx: Tx, companyId: string, all: E[]): Promise<E[]> {
  if (!all.length || !(await companyHasLocked(tx, companyId))) return all;
  const found = all.filter((e) => e.subjectType !== "escalation");
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

/**
 * The approval requests the team may see. A request about someone locked is left out. A closing message's one request
 * names many: anyone locked among them comes off its list, and its count stands, because they hear too.
 */
export async function withoutLockedApprovals<R extends { applicationId: string | null; proposal: unknown }>(tx: Tx, rows: R[]): Promise<R[]> {
  const named = (r: R): string[] => { const ids = (r.proposal as { applicationIds?: unknown } | null)?.applicationIds; return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []; };
  const hidden = await lockedAmong(tx, rows.flatMap((r) => [...(r.applicationId ? [r.applicationId] : []), ...named(r)]));
  if (!hidden.size) return rows;
  return rows.filter((r) => !r.applicationId || !hidden.has(r.applicationId)).map((r) => (named(r).some((id) => hidden.has(id)) ? { ...r, proposal: { ...(r.proposal as object), applicationIds: named(r).filter((id) => !hidden.has(id)) } } : r));
}

import { asc, eq, inArray, sql } from "drizzle-orm";
import type { LockedApplicants } from "@ros/contracts";
import { companyHasLocked, hiddenAmong, type LockReader } from "@ros/core";
import { applications, communications, recruiterEscalations, workflowRuns, type Tx } from "@ros/db";
import { eventTargets } from "./staff-scope";

/**
 * What the wall of Rule 3 (the plans of 5 November 2026) does to words already stored: an entry on the activity list, an
 * approval, a job's list. The path guard (middleware/candidate-lock.ts) stops the ids in a path; these are for the lists that
 * span many people. `LockReader` says who may read past the lock: break glass, and a grant naming exactly that application.
 */

const NO_ONE: LockedApplicants = { count: 0, cards: [] };

/**
 * The locked people of one job as the team may read them, in arrival order: where they came in, and when. A list for a grant
 * about one candidate says nothing of anyone else, as that list always did, and break glass reads them as rows.
 */
export async function lockedCardsOf(tx: Tx, roleId: string, reader: LockReader): Promise<LockedApplicants> {
  if (reader?.staff?.kind === "break_glass" || reader?.staff?.scope.applicationId) return NO_ONE;
  const rows = await tx.select({ createdAt: applications.createdAt, lockedAt: applications.lockedAt }).from(applications).where(eq(applications.roleId, roleId)).orderBy(asc(applications.createdAt), asc(applications.id));
  const cards = rows.flatMap((r, i) => (r.lockedAt ? [{ position: i + 1, appliedAt: new Date(r.createdAt).toISOString() }] : []));
  return { count: cards.length, cards };
}

type EventRow = { id: number; subjectType: string; subjectId: string; payload: Record<string, unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The activity entries this reader may see: one rule for every list of them, built like `withoutUnsentChats`. An entry is held
 * back when it is about someone they may not read, whichever way it says so: its subject (an application, or an interview,
 * screen, message or approval of one), the application its payload names, the request it was recorded on (a request about
 * someone locked: a recruiter's answer is on such an entry in their own words), the workflow run working on them, or the
 * person themselves when everything they have here is locked (someone also visible on another job shows through that job).
 * `application.received` is why this looks at the subject and not at the words: an emailed-in applicant's note carries their
 * address and a subject line that is often their name. Costs one query for a company with nobody locked.
 */
export async function withoutLockedEvents<E extends EventRow>(tx: Tx, input: { companyId: string; reader: LockReader }, found: E[]): Promise<E[]> {
  if (!found.length || !(await companyHasLocked(tx, input.companyId))) return found;
  const targets = await eventTargets(tx, found);
  const ids = (type: string) => [...new Set(found.filter((e) => e.subjectType === type).map((e) => e.subjectId).filter((id) => UUID.test(id)))];
  const requests = ids("escalation").length ? await tx.select({ id: recruiterEscalations.id, applicationId: recruiterEscalations.applicationId }).from(recruiterEscalations).where(inArray(recruiterEscalations.id, ids("escalation"))) : [];
  const runs = ids("workflow_run").length ? await tx.select({ id: workflowRuns.id, applicationId: sql<string | null>`${workflowRuns.state}->>'applicationId'` }).from(workflowRuns).where(inArray(workflowRuns.id, ids("workflow_run"))) : [];
  // A message about no application in particular (a privacy request's acknowledgment) is about the person.
  const messages = ids("communication").length ? await tx.select({ id: communications.id, applicationId: communications.applicationId, candidateId: communications.candidateId }).from(communications).where(inArray(communications.id, ids("communication"))) : [];
  const personOfMessage = new Map(messages.flatMap((m) => (!m.applicationId && m.candidateId ? [[m.id, m.candidateId] as const] : [])));
  const candidateIds = [...new Set([...ids("candidate"), ...personOfMessage.values()])];
  const people = candidateIds.length ? await tx.select({ candidateId: applications.candidateId, id: applications.id }).from(applications).where(inArray(applications.candidateId, candidateIds)) : [];
  const aboutOf = new Map<string, string | null>([...requests.map((r) => [r.id, r.applicationId] as const), ...runs.map((r) => [r.id, r.applicationId] as const)]);
  const hidden = await hiddenAmong(tx, input.reader, [
    ...[...targets.values()].map((t) => t.applicationId ?? ""),
    ...[...aboutOf.values()].map((id) => id ?? ""),
    ...people.map((p) => p.id),
  ]);
  if (!hidden.size) return found;
  return found.filter((e) => {
    const target = targets.get(e.id)?.applicationId;
    if (target && hidden.has(target)) return false;
    const about = e.subjectType === "escalation" || e.subjectType === "workflow_run" ? aboutOf.get(e.subjectId) : null;
    if (about && hidden.has(about)) return false;
    const person = e.subjectType === "candidate" ? e.subjectId : e.subjectType === "communication" ? personOfMessage.get(e.subjectId) : null;
    if (!person) return true;
    const theirs = people.filter((p) => p.candidateId === person);
    return !theirs.length || theirs.some((p) => !hidden.has(p.id));
  });
}

/**
 * The approval requests this reader may see. A request about someone they may not read is left out. A closing message's one
 * request names many: anyone among them they may not read comes off its list, and its count stands, because they hear too.
 */
export async function withoutLockedApprovals<R extends { applicationId: string | null; proposal: unknown }>(tx: Tx, reader: LockReader, rows: R[]): Promise<R[]> {
  const named = (r: R): string[] => { const ids = (r.proposal as { applicationIds?: unknown } | null)?.applicationIds; return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []; };
  const hidden = await hiddenAmong(tx, reader, rows.flatMap((r) => [...(r.applicationId ? [r.applicationId] : []), ...named(r)]));
  if (!hidden.size) return rows;
  return rows.filter((r) => !r.applicationId || !hidden.has(r.applicationId)).map((r) => (named(r).some((id) => hidden.has(id)) ? { ...r, proposal: { ...(r.proposal as object), applicationIds: named(r).filter((id) => !hidden.has(id)) } } : r));
}

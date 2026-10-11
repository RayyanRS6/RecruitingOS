import { inArray } from "drizzle-orm";
import { applications, approvalRequests, communications, interviews, postings, screens, type Tx } from "@ros/db";
import type { Tenant } from "../middleware/session";

/**
 * What an ITS recruiter under a grant may see in the lists that span the company (the Today brief, the activity list,
 * the request list). Members and a grant for all of the company's hiring see everything (null). A grant for one role
 * sees that role and its candidates; a grant for one candidate sees that candidate and their role's own facts.
 *
 * Stricter than `scopeAllows` (packages/core/src/staff-access.ts), which lets a company-wide item through a role grant
 * so a route can serve it: here an item that names neither a role nor a candidate is left out for a scoped grant,
 * except the request the grant was given for.
 */
export type StaffScope = { roleId: string | null; applicationId: string | null; escalationId: string | null };
export type ScopeTarget = { roleId?: string | null; applicationId?: string | null; escalationId?: string | null };

export function staffScopeOf(t: Tenant): StaffScope | null {
  if (!t.staff) return null;
  const { roleId, applicationId, escalationId } = t.staff.scope;
  return roleId || applicationId ? { roleId, applicationId, escalationId } : null;
}

export function inStaffScope(scope: StaffScope | null, target: ScopeTarget): boolean {
  if (!scope) return true;
  if (target.escalationId && target.escalationId === scope.escalationId) return true;
  if (scope.applicationId) {
    if (target.applicationId) return target.applicationId === scope.applicationId;
    return !!target.roleId && target.roleId === scope.roleId;
  }
  return !!target.roleId && target.roleId === scope.roleId;
}

/**
 * What a recruiter under a grant may ask for: never more than the grant itself, since claiming a request grants what it
 * covers. A grant for one candidate asks only about that candidate; a grant for one role, about that role or one of its
 * candidates; neither may ask about all of the company's hiring. Stricter than `inStaffScope`, which lets a candidate's
 * grant read the role's own facts.
 */
export function staffMayAsk(scope: StaffScope | null, target: { roleId: string | null; applicationId: string | null }): boolean {
  if (!scope) return true;
  if (scope.applicationId) return target.applicationId === scope.applicationId;
  return !!target.roleId && target.roleId === scope.roleId;
}

/** A recruiter given one candidate sees requests about that candidate, and the request they accepted; never the role's others. */
export function escalationInScope(scope: StaffScope | null, e: { id: string; roleId: string | null; applicationId: string | null }): boolean {
  if (scope?.applicationId && !e.applicationId) return e.id === scope.escalationId;
  return inStaffScope(scope, { roleId: e.roleId, applicationId: e.applicationId, escalationId: e.id });
}

type EventRow ={ id: number; subjectType: string; subjectId: string; payload: Record<string, unknown> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Only well-formed ids are looked up or compared; anything else in a payload names nothing. */
const str = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);

/**
 * The role and candidate each event is about: from its subject (looked up for interviews, screens, postings,
 * messages and approval requests) and from the ids its payload carries. An event that names neither has no target.
 */
export async function eventTargets(tx: Tx, rows: EventRow[]): Promise<Map<number, ScopeTarget>> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.subjectType === type).map((r) => r.subjectId).filter((id) => UUID.test(id)))];
  const appIds = new Set([...ids("application"), ...rows.map((r) => str(r.payload.applicationId)).filter((x): x is string => !!x)]);
  const ivs = ids("interview").length ? await tx.select({ id: interviews.id, applicationId: interviews.applicationId }).from(interviews).where(inArray(interviews.id, ids("interview"))) : [];
  const scr = ids("screen").length ? await tx.select({ id: screens.id, applicationId: screens.applicationId }).from(screens).where(inArray(screens.id, ids("screen"))) : [];
  const comms = ids("communication").length ? await tx.select({ id: communications.id, applicationId: communications.applicationId }).from(communications).where(inArray(communications.id, ids("communication"))) : [];
  const posts = ids("posting").length ? await tx.select({ id: postings.id, roleId: postings.roleId }).from(postings).where(inArray(postings.id, ids("posting"))) : [];
  const reqs = ids("approval_request").length ? await tx.select({ id: approvalRequests.id, roleId: approvalRequests.roleId, applicationId: approvalRequests.applicationId }).from(approvalRequests).where(inArray(approvalRequests.id, ids("approval_request"))) : [];
  for (const x of [...ivs, ...scr, ...comms, ...reqs]) if (x.applicationId) appIds.add(x.applicationId);
  const apps = appIds.size ? await tx.select({ id: applications.id, roleId: applications.roleId }).from(applications).where(inArray(applications.id, [...appIds])) : [];
  const roleOfApp = new Map(apps.map((a) => [a.id, a.roleId]));
  const out = new Map<number, ScopeTarget>();
  for (const r of rows) {
    let roleId = str(r.payload.roleId);
    let applicationId = str(r.payload.applicationId);
    let escalationId: string | null = null;
    if (r.subjectType === "application") applicationId = r.subjectId;
    else if (r.subjectType === "role") roleId = r.subjectId;
    else if (r.subjectType === "role_packet") roleId = r.subjectId.split(":")[0];
    else if (r.subjectType === "escalation") escalationId = r.subjectId;
    else if (r.subjectType === "interview") applicationId = ivs.find((x) => x.id === r.subjectId)?.applicationId ?? applicationId;
    else if (r.subjectType === "screen") applicationId = scr.find((x) => x.id === r.subjectId)?.applicationId ?? applicationId;
    else if (r.subjectType === "communication") applicationId = comms.find((x) => x.id === r.subjectId)?.applicationId ?? applicationId;
    else if (r.subjectType === "posting") roleId = posts.find((x) => x.id === r.subjectId)?.roleId ?? roleId;
    else if (r.subjectType === "approval_request") {
      const req = reqs.find((x) => x.id === r.subjectId);
      roleId = req?.roleId ?? roleId;
      applicationId = req?.applicationId ?? applicationId;
    }
    if (applicationId) roleId = roleOfApp.get(applicationId) ?? roleId;
    out.set(r.id, { roleId, applicationId, escalationId });
  }
  return out;
}

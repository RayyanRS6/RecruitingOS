import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { applications, candidates, communications, dataRequests, documents, events, screens, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { emit } from "./events";
import { raiseAlert, resolveAlertsFor } from "./alerts";
import { createEscalation } from "./escalations";
import { normalizeEmail } from "./auth";

/**
 * Candidate privacy requests (correction 7, docs/runbooks/privacy-requests.md). Everything here is the recorded,
 * deadline-tracked, audited workflow the runbook describes. Two rules never bend: the customer's users never see a
 * request's content, and nothing is deleted automatically; an anonymization runs only after a recorded counsel decision
 * and an administrator's explicit confirmation, while retention rules are under counsel review.
 */
export const PRIVACY_REQUEST_SLA_DAYS = 45; // proposed pending counsel (register item 6)
export const PRIVACY_DEADLINE_ALERT_KIND = "privacy_request.deadline";
export type DataRequestRow = typeof dataRequests.$inferSelect;

export async function createDataRequest(
  q: Queryable,
  input: { companyId: string; kind: string; requesterEmail: string; details?: string | null; candidateId?: string | null; applicationId?: string | null; channel: "status_page" | "email" | "admin"; verified: boolean; verificationNote?: string; actor: Actor; now?: Date },
): Promise<DataRequestRow> {
  const now = input.now ?? new Date();
  const [row] = await q.insert(dataRequests).values({
    companyId: input.companyId, candidateId: input.candidateId ?? null, applicationId: input.applicationId ?? null, kind: input.kind, details: input.details ?? null,
    requesterEmail: normalizeEmail(input.requesterEmail), channel: input.channel,
    verificationStatus: input.verified ? "verified_by_link" : "pending", verificationNote: input.verificationNote ?? (input.verified ? "the request came through the candidate's own status link" : null), verifiedAt: input.verified ? now.toISOString() : null,
    status: input.verified ? "in_progress" : "received", slaDueAt: new Date(now.getTime() + PRIVACY_REQUEST_SLA_DAYS * 86_400_000).toISOString(),
  }).returning();
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "data_request.created", target: { type: "candidate", id: input.candidateId ?? row.id }, reason: input.kind, details: { requestId: row.id, kind: input.kind, channel: input.channel, verified: input.verified, slaDueAt: row.slaDueAt } });
  // The customer learns that a request exists and what kind; never its content or the requester's words.
  await emit(q, { type: "candidate.data_request", companyId: input.companyId, actor: input.actor, subject: { type: "candidate", id: input.candidateId ?? row.id }, payload: { kind: input.kind, requestId: row.id, dueAt: row.slaDueAt } });
  return row;
}

async function touch(q: Queryable, row: DataRequestRow, patch: Partial<typeof dataRequests.$inferInsert>, actor: Actor, reason: string, details: Record<string, unknown> = {}): Promise<DataRequestRow> {
  const [u] = await q.update(dataRequests).set(patch).where(eq(dataRequests.id, row.id)).returning();
  await audit(q, { companyId: row.companyId, actor, action: "data_request.updated", target: { type: "candidate", id: row.candidateId ?? row.id }, reason, details: { requestId: row.id, ...details } });
  return u;
}

export async function assignDataRequest(q: Queryable, row: DataRequestRow, userId: string | null, actor: Actor): Promise<DataRequestRow> {
  return touch(q, row, { assignedTo: userId, status: row.status === "received" ? "in_progress" : row.status }, actor, "assigned", { assignedTo: userId });
}

export async function addDataRequestNote(q: Queryable, row: DataRequestRow, text: string, actor: Actor, now: Date = new Date()): Promise<DataRequestRow> {
  return touch(q, row, { notes: [...row.notes, { at: now.toISOString(), by: actor.name ?? actor.id, text }] }, actor, "note added");
}

export async function verifyDataRequest(q: Queryable, row: DataRequestRow, input: { method: string; outcome: "verified" | "failed"; actor: Actor; now?: Date }): Promise<DataRequestRow> {
  const now = input.now ?? new Date();
  return touch(q, row, { verificationStatus: input.outcome === "verified" ? "verified_manual" : "failed", verificationNote: input.method, verifiedAt: input.outcome === "verified" ? now.toISOString() : null, verifiedBy: input.actor.kind === "user" ? input.actor.id : null, status: input.outcome === "verified" ? "in_progress" : row.status }, input.actor, `verification ${input.outcome}`, { method: input.method });
}

export async function escalateDataRequestToCounsel(q: Queryable, row: DataRequestRow, note: string | undefined, actor: Actor, now: Date = new Date()): Promise<DataRequestRow> {
  const u = await touch(q, row, { status: "awaiting_counsel", counselEscalatedAt: now.toISOString(), counselDecision: "pending", counselNote: note ?? row.counselNote }, actor, "escalated to counsel");
  await raiseAlert(q, { kind: "privacy_request.counsel", severity: "high", title: `Privacy request awaits counsel: ${row.kind}`, body: note ?? "A privacy request needs a counsel decision before it can be fulfilled.", companyId: row.companyId, target: { type: "candidate", id: row.candidateId ?? row.id }, details: { requestId: row.id, kind: row.kind } });
  return u;
}

export async function recordCounselDecision(q: Queryable, row: DataRequestRow, input: { decision: "pending" | "approved" | "declined"; note?: string; actor: Actor }): Promise<DataRequestRow> {
  const u = await touch(q, row, { counselDecision: input.decision, counselNote: input.note ?? row.counselNote, status: input.decision === "pending" ? "awaiting_counsel" : "in_progress" }, input.actor, `counsel decision: ${input.decision}`);
  if (input.decision !== "pending") await resolveAlertsFor(q, "privacy_request.counsel", row.candidateId ?? row.id);
  return u;
}

/** Everything the person gave us or we sent them; never the assessment's internal rationale, never anyone else's data. */
export async function exportCandidateData(q: Queryable, companyId: string, candidateId: string): Promise<Record<string, unknown>> {
  const [cand] = await q.select().from(candidates).where(and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId))).limit(1);
  if (!cand) throw new Error("candidate not found");
  const apps = await q.select().from(applications).where(eq(applications.candidateId, cand.id));
  const docs = await q.select({ id: documents.id, kind: documents.kind, filename: documents.filename, mime: documents.mime, sizeBytes: documents.sizeBytes, textExtracted: documents.textExtracted, createdAt: documents.createdAt }).from(documents).where(eq(documents.candidateId, cand.id));
  const scr = await q.select({ applicationId: screens.applicationId, channel: screens.channel, status: screens.status, transcript: screens.transcript, answers: screens.answers, createdAt: screens.createdAt }).from(screens).where(inArray(screens.applicationId, apps.map((a) => a.id).concat(["00000000-0000-0000-0000-000000000000"])));
  const comms = await q.select({ direction: communications.direction, channel: communications.channel, subject: communications.subject, bodyText: communications.bodyText, createdAt: communications.createdAt }).from(communications).where(eq(communications.candidateId, cand.id)).orderBy(desc(communications.createdAt));
  const history = await q.select({ type: events.type, occurredAt: events.occurredAt, subjectId: events.subjectId }).from(events).where(and(eq(events.companyId, companyId), inArray(events.subjectId, apps.map((a) => a.id).concat([cand.id]))));
  return {
    exportedAt: new Date().toISOString(),
    person: { firstName: cand.firstName, lastName: cand.lastName, email: cand.email, phone: cand.phone, location: cand.locationText, consent: cand.consent, preferences: cand.preferences, createdAt: cand.createdAt },
    applications: apps.map((a) => ({ id: a.id, roleId: a.roleId, stage: a.stage, source: a.source, answers: a.answers, eligibility: a.eligibility ? { passed: a.eligibility.passed, failedRules: a.eligibility.failedRules } : null, appliedAt: a.createdAt, rejectReason: a.rejectReason ?? null })),
    documents: docs,
    screens: scr,
    messagesWeSent: comms.filter((c) => c.direction === "outbound"),
    messagesYouSent: comms.filter((c) => c.direction === "inbound"),
    stageHistory: history.filter((e) => e.type === "application.stage_changed" || e.type.startsWith("interview.")).map((e) => ({ type: e.type, at: e.occurredAt })),
  };
}

export async function fulfilAccessRequest(q: Queryable, row: DataRequestRow, input: { resolution: string; actor: Actor; now?: Date }): Promise<{ row: DataRequestRow; bundle: Record<string, unknown> }> {
  if (!row.candidateId) throw new Error("no candidate is linked to this request");
  const bundle = await exportCandidateData(q, row.companyId, row.candidateId);
  await audit(q, { companyId: row.companyId, actor: input.actor, action: "data.exported", target: { type: "candidate", id: row.candidateId }, reason: `access request ${row.id}`, details: { requestId: row.id, applications: (bundle.applications as unknown[]).length } });
  const u = await resolve(q, row, input.resolution, input.actor, "fulfilled", input.now);
  return { row: u, bundle };
}

export async function fulfilCorrectionRequest(q: Queryable, row: DataRequestRow, input: { field: "firstName" | "lastName" | "email" | "phone" | "locationText"; value: string; resolution: string; actor: Actor; now?: Date }): Promise<DataRequestRow> {
  if (!row.candidateId) throw new Error("no candidate is linked to this request");
  const [cand] = await q.select().from(candidates).where(eq(candidates.id, row.candidateId)).limit(1);
  const before = cand[input.field];
  await q.update(candidates).set({ [input.field]: input.field === "email" ? normalizeEmail(input.value) : input.value }).where(eq(candidates.id, cand.id));
  await audit(q, { companyId: row.companyId, actor: input.actor, action: "data.corrected", target: { type: "candidate", id: cand.id }, reason: `correction request ${row.id}`, details: { requestId: row.id, field: input.field, changed: before !== input.value } });
  return resolve(q, { ...row, notes: [...row.notes, { at: (input.now ?? new Date()).toISOString(), by: input.actor.name ?? input.actor.id, text: `corrected ${input.field}` }] }, input.resolution, input.actor, "fulfilled", input.now);
}

/**
 * Anonymization in place of deletion (runbook step 5): identity fields become tokens; resumes and their text, screening
 * transcripts and answers, and message bodies are removed; stage history, audit records and aggregate counts stay.
 * Refused unless counsel recorded an approval on this request and the administrator confirmed.
 */
export async function anonymizeCandidate(
  q: Queryable,
  input: { companyId: string; candidateId: string; actor: Actor; deleteFile: (storageKey: string) => Promise<void>; now?: Date },
): Promise<{ documents: number; screens: number; communications: number }> {
  const now = input.now ?? new Date();
  const [cand] = await q.select().from(candidates).where(and(eq(candidates.id, input.candidateId), eq(candidates.companyId, input.companyId))).limit(1);
  if (!cand) throw new Error("candidate not found");
  const token = `anon-${cand.id.slice(0, 8)}`;
  const docs = await q.select().from(documents).where(eq(documents.candidateId, cand.id));
  for (const d of docs) {
    await input.deleteFile(d.storageKey);
    await q.update(documents).set({ textExtracted: null, filename: `${token}.removed`, storageKey: `removed/${token}/${d.id}`, sizeBytes: 0, sha256: "removed", status: "deleted", rejectedReason: null }).where(eq(documents.id, d.id));
    await audit(q, { companyId: input.companyId, actor: input.actor, action: "document.deleted", target: { type: "document", id: d.id }, reason: "deletion request fulfilled", details: { candidateId: cand.id, applicationId: d.applicationId } });
    await emit(q, { type: "document.deleted", companyId: input.companyId, actor: input.actor, subject: { type: "candidate", id: cand.id }, payload: { documentId: d.id } });
  }
  const apps = await q.select({ id: applications.id }).from(applications).where(eq(applications.candidateId, cand.id));
  const appIds = apps.map((a) => a.id);
  let scrCount = 0;
  if (appIds.length) {
    const scr = await q.select({ id: screens.id }).from(screens).where(inArray(screens.applicationId, appIds));
    scrCount = scr.length;
    for (const s of scr) await q.update(screens).set({ transcript: [], answers: {} }).where(eq(screens.id, s.id));
    for (const a of appIds) await q.update(applications).set({ answers: { noticeVersionsShown: [] }, extraction: null, rejectNote: null }).where(eq(applications.id, a));
  }
  const comms = await q.select({ id: communications.id }).from(communications).where(eq(communications.candidateId, cand.id));
  for (const c of comms) await q.update(communications).set({ bodyText: "[removed at the candidate's request]", bodyHtml: null, subject: "[removed]", toAddress: null }).where(eq(communications.id, c.id));
  await q.update(candidates).set({ firstName: "Removed", lastName: token, email: null, phone: null, location: null, locationText: null, dedupeKey: `removed:${cand.id}`, tags: [], embedding: null, anonymizedAt: now.toISOString(), consent: {}, preferences: { smsOptOut: true } }).where(eq(candidates.id, cand.id));
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "data.anonymized", target: { type: "candidate", id: cand.id }, reason: "deletion request fulfilled by anonymization after a counsel decision", details: { documents: docs.length, screens: scrCount, communications: comms.length } });
  await emit(q, { type: "candidate.anonymized", companyId: input.companyId, actor: input.actor, subject: { type: "candidate", id: cand.id }, payload: { documents: docs.length } });
  return { documents: docs.length, screens: scrCount, communications: comms.length };
}

export class CounselDecisionRequired extends Error {
  constructor() {
    super("A deletion or anonymization runs only after counsel records an approval on this request and the administrator confirms; retention rules are under counsel review.");
  }
}

export async function fulfilDeletionRequest(q: Queryable, row: DataRequestRow, input: { resolution: string; confirm: boolean; actor: Actor; deleteFile: (key: string) => Promise<void>; now?: Date }): Promise<DataRequestRow> {
  if (row.counselDecision !== "approved" || !input.confirm) throw new CounselDecisionRequired();
  if (!row.candidateId) throw new Error("no candidate is linked to this request");
  const counts = await anonymizeCandidate(q, { companyId: row.companyId, candidateId: row.candidateId, actor: input.actor, deleteFile: input.deleteFile, now: input.now });
  return resolve(q, row, `${input.resolution} (anonymized: ${counts.documents} documents, ${counts.screens} screens, ${counts.communications} messages)`, input.actor, "fulfilled", input.now);
}

/** Text-message opt-out: applied at once; the record exists so the deadline and the confirmation are tracked like any other request. */
export async function fulfilSmsOptOut(q: Queryable, row: DataRequestRow, actor: Actor, now: Date = new Date()): Promise<DataRequestRow> {
  if (row.candidateId) {
    const [cand] = await q.select().from(candidates).where(eq(candidates.id, row.candidateId)).limit(1);
    if (cand) {
      await q.update(candidates).set({ preferences: { ...cand.preferences, smsOptOut: true }, consent: { ...cand.consent, sms: { ...(cand.consent.sms ?? { at: now.toISOString(), source: "status_page" }), granted: false, at: now.toISOString() } } }).where(eq(candidates.id, cand.id));
      await emit(q, { type: "candidate.opted_out", companyId: row.companyId, actor, subject: { type: "candidate", id: cand.id }, payload: { channel: "sms", requestId: row.id } });
    }
  }
  return resolve(q, row, "Text messages stopped.", actor, "fulfilled", now);
}

/** "Ask a person to review my application": a recruiter escalation carries it; the request closes when the escalation resolves. */
export async function openHumanReview(q: Queryable, row: DataRequestRow, input: { roleId: string | null; actor: Actor }): Promise<DataRequestRow> {
  const esc = await createEscalation(q, { companyId: row.companyId, roleId: input.roleId, applicationId: row.applicationId ?? null, kind: "candidate_issue", question: "A candidate asked for a person to review their application. Their words are on the privacy request in the ITS console, not here.", requestedBy: input.actor, summaryOrigin: "candidate" });
  return touch(q, row, { escalationId: esc.id, status: "in_progress" }, input.actor, "human review escalated", { escalationId: esc.id });
}

/** A withdrawal from the status page is applied at once and closed like any other request: resolution audit, event, confirmation. */
export async function fulfilWithdrawal(q: Queryable, row: DataRequestRow, actor: Actor, now: Date = new Date()): Promise<DataRequestRow> {
  return resolve(q, row, "Application withdrawn at the candidate's request.", actor, "fulfilled", now);
}

export async function declineDataRequest(q: Queryable, row: DataRequestRow, resolution: string, actor: Actor, now: Date = new Date()): Promise<DataRequestRow> {
  return resolve(q, row, resolution, actor, "declined", now);
}

async function resolve(q: Queryable, row: DataRequestRow, resolution: string, actor: Actor, status: "fulfilled" | "declined", now: Date = new Date()): Promise<DataRequestRow> {
  const [u] = await q.update(dataRequests).set({ status, resolution, resolvedAt: now.toISOString(), resolvedBy: actor.kind === "user" ? actor.id : null, notes: row.notes }).where(eq(dataRequests.id, row.id)).returning();
  await audit(q, { companyId: row.companyId, actor, action: "data_request.resolved", target: { type: "candidate", id: row.candidateId ?? row.id }, reason: status, details: { requestId: row.id, kind: row.kind } });
  if (status === "fulfilled") await emit(q, { type: "candidate.data_request_fulfilled", companyId: row.companyId, actor, subject: { type: "candidate", id: row.candidateId ?? row.id }, payload: { kind: row.kind, requestId: row.id } });
  await resolveAlertsFor(q, PRIVACY_DEADLINE_ALERT_KIND, row.id, now);
  return u;
}

export async function markConfirmationSent(q: Queryable, row: DataRequestRow, now: Date = new Date()): Promise<void> {
  await q.update(dataRequests).set({ confirmationSentAt: now.toISOString() }).where(eq(dataRequests.id, row.id));
}

/** Deadline tracking: an alert ten days before the due date and another when overdue, once each. */
export async function checkPrivacyRequestDeadlines(q: Queryable, now: Date = new Date()): Promise<{ soon: number; overdue: number }> {
  const open = await q.select().from(dataRequests).where(and(inArray(dataRequests.status, ["received", "in_progress", "awaiting_counsel"]), lte(dataRequests.slaDueAt, new Date(now.getTime() + 10 * 86_400_000).toISOString())));
  let soon = 0;
  let overdue = 0;
  for (const r of open) {
    const due = Date.parse(r.slaDueAt);
    const key = due < now.getTime() ? "overdue" : "soon";
    if (r.deadlineAlerts[key]) continue;
    if (key === "overdue") overdue++; else soon++;
    await raiseAlert(q, { kind: PRIVACY_DEADLINE_ALERT_KIND, severity: key === "overdue" ? "critical" : "high", title: key === "overdue" ? `Privacy request overdue: ${r.kind}` : `Privacy request due within ten days: ${r.kind}`, body: `Request ${r.id} (${r.kind}) is due ${new Date(r.slaDueAt).toLocaleDateString("en-US")}. ${r.assignedTo ? "" : "Nobody is assigned."}`, companyId: r.companyId, target: { type: "candidate", id: r.id }, details: { requestId: r.id, kind: r.kind, dueAt: r.slaDueAt } });
    await q.update(dataRequests).set({ deadlineAlerts: { ...r.deadlineAlerts, [key]: now.toISOString() } }).where(eq(dataRequests.id, r.id));
  }
  return { soon, overdue };
}

export function publicDataRequest(row: DataRequestRow) {
  return { id: row.id, companyId: row.companyId, candidateId: row.candidateId, applicationId: row.applicationId, kind: row.kind, details: row.details, requesterEmail: row.requesterEmail, channel: row.channel, verificationStatus: row.verificationStatus, verificationNote: row.verificationNote, verifiedAt: row.verifiedAt, status: row.status, slaDueAt: row.slaDueAt, assignedTo: row.assignedTo, notes: row.notes, counselEscalatedAt: row.counselEscalatedAt, counselDecision: row.counselDecision, counselNote: row.counselNote, resolution: row.resolution, resolvedAt: row.resolvedAt, confirmationSentAt: row.confirmationSentAt, escalationId: row.escalationId, createdAt: row.createdAt };
}

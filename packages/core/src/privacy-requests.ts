import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { applicationMarks, applications, approvalRequests, candidates, communications, dataRequests, documents, escalationMessages, events, interviewParticipants, interviews, jobs, notifications, recruiterEscalations, screens, unconfirmedScreens, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { emit } from "./events";
import { raiseAlert, resolveAlertsFor } from "./alerts";
import { createEscalation } from "./escalations";
import { normalizeEmail } from "./auth";
import { notify } from "./notifications";
import { openingQuestionsOf, screenAnswersOf, withoutFocusAnswers } from "./screen-answers";
import { DECISION_STAGES, canTransition, transition } from "./stages";

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
  input: { /** a caller that promised a reference before the row existed (the public form's confirmation link) supplies it */ id?: string; companyId: string; kind: string; requesterEmail: string; details?: string | null; candidateId?: string | null; applicationId?: string | null; channel: "status_page" | "email" | "admin" | "email_form"; verified: boolean; verificationNote?: string; actor: Actor; now?: Date },
): Promise<DataRequestRow> {
  const now = input.now ?? new Date();
  const [row] = await q.insert(dataRequests).values({
    ...(input.id ? { id: input.id } : {}),
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
  // A screen's answers live in two places (screen-answers.ts): the export carries every one of them, with the opening questions in the words they were asked.
  const scrRows = await q.select({ applicationId: screens.applicationId, channel: screens.channel, status: screens.status, transcript: screens.transcript, answers: screens.answers, progress: screens.progress, createdAt: screens.createdAt }).from(screens).where(inArray(screens.applicationId, apps.map((a) => a.id).concat(["00000000-0000-0000-0000-000000000000"])));
  const scr = scrRows.map((s) => ({ applicationId: s.applicationId, channel: s.channel, status: s.status, transcript: s.transcript, answers: screenAnswersOf(s), openingQuestions: openingQuestionsOf(s.progress), createdAt: s.createdAt }));
  const comms = await q.select({ direction: communications.direction, channel: communications.channel, subject: communications.subject, bodyText: communications.bodyText, createdAt: communications.createdAt }).from(communications).where(eq(communications.candidateId, cand.id)).orderBy(desc(communications.createdAt));
  const history = await q.select({ type: events.type, occurredAt: events.occurredAt, subjectId: events.subjectId }).from(events).where(and(eq(events.companyId, companyId), inArray(events.subjectId, apps.map((a) => a.id).concat([cand.id]))));
  return {
    exportedAt: new Date().toISOString(),
    person: { firstName: cand.firstName, lastName: cand.lastName, email: cand.email, phone: cand.phone, location: cand.locationText, consent: cand.consent, preferences: cand.preferences, createdAt: cand.createdAt },
    // A decision is in the export whether or not the person was told it yet (plan G1), with whether and when they were.
    applications: apps.map((a) => ({ id: a.id, roleId: a.roleId, stage: a.stage, source: a.source, answers: a.answers, eligibility: a.eligibility ? { passed: a.eligibility.passed, failedRules: a.eligibility.failedRules } : null, appliedAt: a.createdAt, rejectReason: a.rejectReason ?? null, ...(DECISION_STAGES.includes(a.stage) ? { decisionTold: a.toldState, decisionToldAt: a.candidateToldAt ?? null } : {}) })),
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

const DELETION_REASON = "the candidate asked for their information to be deleted";

/**
 * A deletion ends the person's part in every process (plan A9): their interviews still to come are cancelled (the
 * interviewers are told, the calendar events are queued for removal; nobody writes to the candidate, whose address goes
 * in the same transaction), their open screens close, the assistant's waiting suggestions and any decision message
 * waiting for approval are withdrawn, and an application still in the process is withdrawn. Private marks lose their
 * notes. The scheduling and screening runs end on their own at their next step, since what they wait on is gone.
 */
async function closeProcessOnDeletion(q: Queryable, input: { companyId: string; appIds: string[]; actor: Actor; now: Date }): Promise<void> {
  const { companyId, appIds, actor, now } = input;
  if (!appIds.length) return;
  const open = await q.select().from(interviews).where(and(inArray(interviews.applicationId, appIds), inArray(interviews.status, ["proposed", "scheduling", "scheduled"])));
  for (const iv of open) {
    if (iv.status === "scheduled" && iv.startsAt && Date.parse(iv.startsAt) <= now.getTime()) continue; // it took place, or is taking place
    const hadEvents = Object.keys((iv.calendarRefs ?? {}) as Record<string, unknown>).length > 0;
    await q.update(interviews).set({ status: "cancelled", cancelReason: DELETION_REASON, attempt: iv.attempt + 1 }).where(eq(interviews.id, iv.id));
    await emit(q, { type: "interview.cancelled", companyId, actor, subject: { type: "interview", id: iv.id }, payload: { reason: "deletion_request", byCandidate: false, hadEvents, candidateTold: false, cause: "deletion_request" } });
    const parts = await q.select({ userId: interviewParticipants.userId }).from(interviewParticipants).where(eq(interviewParticipants.interviewId, iv.id));
    if (parts.length) await notify(q, { companyId, kind: "interview.cancelled", title: `Interview cancelled: ${iv.title}`, body: "The candidate asked for their information to be deleted, so this interview is off.", action: { label: "Open interviews", href: "/interviews" }, userIds: parts.map((p) => p.userId) });
    if (hadEvents) await q.insert(jobs).values({ kind: "interview.cancel_events", payload: { interviewId: iv.id, companyId, actor }, runAt: now.toISOString(), maxAttempts: 5 });
  }
  const scr = await q.select({ id: screens.id }).from(screens).where(and(inArray(screens.applicationId, appIds), inArray(screens.status, ["invited", "reminded", "in_progress", "paused"])));
  for (const s of scr) {
    await q.update(screens).set({ status: "cancelled" }).where(eq(screens.id, s.id));
    await emit(q, { type: "screen.cancelled", companyId, actor, subject: { type: "screen", id: s.id }, payload: { reason: "deletion_request" } });
  }
  const waiting = await q.select({ id: approvalRequests.id, actionType: approvalRequests.actionType, applicationId: approvalRequests.applicationId }).from(approvalRequests).where(and(inArray(approvalRequests.applicationId, appIds), inArray(approvalRequests.actionType, ["application.invite_screen", "application.recommend_interview", "disposition.send"]), eq(approvalRequests.status, "pending")));
  for (const p of waiting) {
    await q.update(approvalRequests).set({ status: "cancelled", decidedAt: now.toISOString(), decisionNote: DELETION_REASON }).where(eq(approvalRequests.id, p.id));
    await emit(q, { type: "approval.cancelled", companyId, actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType, applicationId: p.applicationId, by: "deletion_request" } });
  }
  const apps = await q.select({ id: applications.id, stage: applications.stage }).from(applications).where(inArray(applications.id, appIds));
  for (const a of apps) if (canTransition(a.stage, "withdrawn", "system")) await transition(q, { applicationId: a.id, companyId, to: "withdrawn", by: "system", actor, reason: DELETION_REASON });
  await q.update(applicationMarks).set({ note: null }).where(inArray(applicationMarks.applicationId, appIds));
  // The team's free-text notes were copied into the history as it happened (a mark, a decline, "I told them myself", a
  // decision after an interview): they are blanked there too. What happened, who did it and when stay.
  await q.update(events).set({ payload: sql`jsonb_set(${events.payload}, '{note}', 'null'::jsonb)` }).where(and(eq(events.subjectType, "application"), inArray(events.subjectId, appIds), sql`${events.payload}->>'note' is not null`));
}

/**
 * Anonymization in place of deletion (runbook step 5): identity fields become tokens; resumes and their text, screening
 * transcripts and answers (the answers to a screen's opening questions included), and message bodies are removed, and so
 * is everything about them in a recruiter's copy and in requests and notices that name them; stage history, audit
 * records and aggregate counts stay. The person's part in every process ends first (`closeProcessOnDeletion`).
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
  await closeProcessOnDeletion(q, { companyId: input.companyId, appIds, actor: input.actor, now });
  let scrCount = 0;
  if (appIds.length) {
    const scr = await q.select({ id: screens.id, progress: screens.progress }).from(screens).where(inArray(screens.applicationId, appIds));
    scrCount = scr.length;
    for (const s of scr) await q.update(screens).set({ transcript: [], answers: {}, progress: withoutFocusAnswers(s.progress) }).where(eq(screens.id, s.id));
    // A repeat submission's conversation waiting for the address owner to confirm it (plan E1) goes too, confirmed or not.
    await q.update(unconfirmedScreens).set({ transcript: [], answers: {}, firstName: "", confirmTokenHash: null, discardedAt: now.toISOString(), confirmation: "discarded" }).where(inArray(unconfirmedScreens.applicationId, appIds));
    // The reply address of every old email is retired with a fresh random token: a reply to one of them no longer names
    // this application, so it cannot write an address or a message back onto the removed record (the webhook also refuses
    // a reply to an anonymized candidate). The status link keeps its token: its page already says the record is gone.
    for (const a of appIds) await q.update(applications).set({ answers: { noticeVersionsShown: [] }, extraction: null, rejectNote: null, replyToken: randomBytes(8).toString("hex") }).where(eq(applications.id, a));
  }
  const comms = await q.select({ id: communications.id }).from(communications).where(eq(communications.candidateId, cand.id));
  for (const c of comms) await q.update(communications).set({ bodyText: "[removed at the candidate's request]", bodyHtml: null, subject: "[removed]", toAddress: null }).where(eq(communications.id, c.id));
  const scrubbed = await scrubRecruiterCopies(q, { companyId: input.companyId, appIds, candidate: cand, now });
  await q.update(candidates).set({ firstName: "Removed", lastName: token, email: null, phone: null, location: null, locationText: null, dedupeKey: `removed:${cand.id}`, tags: [], embedding: null, anonymizedAt: now.toISOString(), consent: {}, preferences: { smsOptOut: true } }).where(eq(candidates.id, cand.id));
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "data.anonymized", target: { type: "candidate", id: cand.id }, reason: "deletion request fulfilled by anonymization after a counsel decision", details: { documents: docs.length, screens: scrCount, communications: comms.length, escalations: scrubbed.escalations, notifications: scrubbed.notifications } });
  await emit(q, { type: "candidate.anonymized", companyId: input.companyId, actor: input.actor, subject: { type: "candidate", id: cand.id }, payload: { documents: docs.length } });
  return { documents: docs.length, screens: scrCount, communications: comms.length };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type IdentifyingPatterns = { name: RegExp[]; contact: RegExp[] };

/**
 * The patterns that identify the person in free text: their full name, and their email and phone (any spacing, an
 * optional area-code bracket). A first name on its own is not matched: it would rewrite ordinary words and other people.
 */
export function identifyingPatterns(person: { firstName: string; lastName: string; email: string | null; phone: string | null }): IdentifyingPatterns {
  const out: IdentifyingPatterns = { name: [], contact: [] };
  const first = person.firstName.trim();
  const last = person.lastName.trim();
  if (first && last) out.name.push(new RegExp(`${escapeRegExp(first)}\\s+${escapeRegExp(last)}`, "gi"));
  if (person.email) out.contact.push(new RegExp(escapeRegExp(person.email.trim()), "gi"));
  const digits = (person.phone ?? "").replace(/\D/g, "").slice(-10);
  if (digits.length === 10) out.contact.push(new RegExp(`\\(?${digits.split("").join("[\\s().+-]*")}`, "g"));
  return out;
}

/** The name becomes `nameWord` ("a candidate") so a sentence still reads; an email or phone becomes "[removed]". */
export function redactPerson(text: string, patterns: IdentifyingPatterns, nameWord: string): string {
  const named = patterns.name.reduce((t, p) => t.replace(p, nameWord), text);
  return patterns.contact.reduce((t, p) => t.replace(p, "[removed]"), named);
}

/**
 * A deletion reaches the recruiter's copy too (Q31 family, step 13): a request about one of the person's applications
 * keeps the company and role context but loses everything about the candidate, and its question is removed; any other
 * request, recruiter answer or in-app notice that names them has the name, email and phone replaced.
 */
async function scrubRecruiterCopies(q: Queryable, input: { companyId: string; appIds: string[]; candidate: { firstName: string; lastName: string; email: string | null; phone: string | null }; now: Date }): Promise<{ escalations: number; notifications: number }> {
  const patterns = identifyingPatterns(input.candidate);
  const removed = "[removed at the candidate's request]";
  let escalationCount = 0;
  const escs = await q.select({ id: recruiterEscalations.id, applicationId: recruiterEscalations.applicationId, question: recruiterEscalations.question, resolution: recruiterEscalations.resolution, contextSnapshot: recruiterEscalations.contextSnapshot }).from(recruiterEscalations).where(eq(recruiterEscalations.companyId, input.companyId));
  for (const e of escs) {
    if (e.applicationId && input.appIds.includes(e.applicationId)) {
      const { company, role, packet } = e.contextSnapshot as { company?: unknown; role?: unknown; packet?: unknown };
      await q.update(recruiterEscalations).set({ question: removed, resolution: e.resolution === null ? null : redactPerson(e.resolution, patterns, "the candidate"), contextSnapshot: { capturedAt: (e.contextSnapshot as { capturedAt?: string }).capturedAt ?? null, company: company ?? null, role: role ?? null, packet: packet ?? null, candidateRemovedAt: input.now.toISOString() } }).where(eq(recruiterEscalations.id, e.id));
      escalationCount++;
      continue;
    }
    if (!patterns.name.length && !patterns.contact.length) continue;
    const question = redactPerson(e.question, patterns, "a candidate");
    const resolution = e.resolution === null ? null : redactPerson(e.resolution, patterns, "a candidate");
    if (question !== e.question || resolution !== e.resolution) {
      await q.update(recruiterEscalations).set({ question, resolution }).where(eq(recruiterEscalations.id, e.id));
      escalationCount++;
    }
  }
  // The threads on those requests (migration 0029): on a request about one of the person's applications the team's own
  // notes go, like its question, and the recruiter's words lose what names them; elsewhere every message loses it.
  const aboutThem = new Set(escs.filter((e) => e.applicationId && input.appIds.includes(e.applicationId)).map((e) => e.id));
  for (const m of await q.select({ id: escalationMessages.id, escalationId: escalationMessages.escalationId, side: escalationMessages.side, body: escalationMessages.body }).from(escalationMessages).where(eq(escalationMessages.companyId, input.companyId))) {
    const about = aboutThem.has(m.escalationId);
    const body = about && m.side === "customer" ? removed : redactPerson(m.body, patterns, about ? "the candidate" : "a candidate");
    if (body !== m.body) await q.update(escalationMessages).set({ body }).where(eq(escalationMessages.id, m.id));
  }
  let notificationCount = 0;
  if (patterns.name.length || patterns.contact.length) {
    const notes = await q.select({ id: notifications.id, title: notifications.title, body: notifications.body }).from(notifications).where(eq(notifications.companyId, input.companyId));
    for (const n of notes) {
      const title = redactPerson(n.title, patterns, "A candidate");
      const body = redactPerson(n.body, patterns, "a candidate");
      if (title === n.title && body === n.body) continue;
      await q.update(notifications).set({ title, body }).where(eq(notifications.id, n.id));
      notificationCount++;
    }
  }
  return { escalations: escalationCount, notifications: notificationCount };
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

/**
 * Text-message opt-out: applied at once; the record exists so the deadline and the confirmation are tracked like any
 * other request. Any text to them still waiting (queued for a later hour, or held for the ITS company check) is withdrawn
 * now; the outbox checks again before every send.
 */
export async function fulfilSmsOptOut(q: Queryable, row: DataRequestRow, actor: Actor, now: Date = new Date()): Promise<DataRequestRow> {
  if (row.candidateId) {
    const [cand] = await q.select().from(candidates).where(eq(candidates.id, row.candidateId)).limit(1);
    if (cand) {
      await q.update(candidates).set({ preferences: { ...cand.preferences, smsOptOut: true }, consent: { ...cand.consent, sms: { ...(cand.consent.sms ?? { at: now.toISOString(), source: "status_page" }), granted: false, at: now.toISOString() } } }).where(eq(candidates.id, cand.id));
      await emit(q, { type: "candidate.opted_out", companyId: row.companyId, actor, subject: { type: "candidate", id: cand.id }, payload: { channel: "sms", requestId: row.id } });
      const reason = "the candidate stopped text messages";
      const waiting = await q.update(communications).set({ status: "cancelled", error: reason }).where(and(eq(communications.candidateId, cand.id), eq(communications.channel, "sms"), inArray(communications.status, ["queued", "held"]))).returning({ id: communications.id, templateKey: communications.templateKey, applicationId: communications.applicationId });
      for (const c of waiting) await emit(q, { type: "message.cancelled", companyId: row.companyId, actor, subject: { type: "communication", id: c.id }, payload: { template: c.templateKey, channel: "sms", applicationId: c.applicationId, reason } });
    }
  }
  return resolve(q, row, "Text messages stopped.", actor, "fulfilled", now);
}

/**
 * "Ask a person to review my application": a recruiter escalation carries it; the request closes when the escalation
 * resolves. A request that names no application and no role would give the recruiter the whole company, so it goes to
 * ITS administrators instead (Q31): an admin alert, and a note on the request, which the privacy console lists with its
 * deadline. Privacy requests are platform records, so this always runs in a platform transaction, where alerts can be
 * written.
 */
export async function openHumanReview(q: Queryable, row: DataRequestRow, input: { roleId: string | null; actor: Actor; now?: Date }): Promise<DataRequestRow> {
  if (!input.roleId && !row.applicationId) {
    await raiseAlert(q, { kind: "privacy_request.human_review", severity: "high", title: "A candidate asked for a person to review their application", body: "The request names no role or application, so no recruiter was brought in. Find the application from the privacy request and arrange the review.", companyId: row.companyId, target: { type: "candidate", id: row.candidateId ?? row.id }, details: { requestId: row.id } });
    const note = { at: (input.now ?? new Date()).toISOString(), by: "system", text: "Human review requested with no application attached: no recruiter was brought in; ITS administrators arrange it." };
    return touch(q, row, { status: "in_progress", notes: [...row.notes, note] }, input.actor, "human review sent to ITS administrators");
  }
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

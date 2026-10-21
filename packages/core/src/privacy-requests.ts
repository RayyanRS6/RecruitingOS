import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, notLike, or, sql, type SQL } from "drizzle-orm";
import { RejectReason, type Actor } from "@ros/contracts";
import { aiRuns, applicationMarks, applicationNotes, applications, approvalRequests, assessments, candidates, communications, dataRequests, documents, escalationMessages, events, hiringOutcomes, inboundEmails, interviewFollowups, interviewParticipants, interviews, jobs, notifications, recruiterEscalations, screens, unconfirmedScreens, workflowRuns, workflowSteps, rowsOf, type Queryable } from "@ros/db";
import { audit } from "./audit";
import { SYSTEM_ACTOR, emit } from "./events";
import { raiseAlert, resolveAlertsFor } from "./alerts";
import { createEscalation } from "./escalations";
import { normalizeEmail } from "./auth";
import { dedupeKey } from "./dedupe";
import { notify } from "./notifications";
import { openingQuestionsOf, screenAnswersOf, withoutCandidateWords } from "./screen-answers";
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

/** Message statuses that mean it left us (handed to the email or text provider; `unknown` and `sending` may have gone). */
const LEFT_US = new Set(["sent", "delivered", "bounced", "complained", "unknown", "sending"]);
/** A message that left us but may not have reached them, in the words the export uses. */
const DID_NOT_ARRIVE: Record<string, string> = { bounced: "sent, but it did not arrive", complained: "sent; marked as unwanted", unknown: "sent, but we could not confirm it arrived", sending: "being sent" };
/** What became of a message that never left us. */
const NOT_SENT: Record<string, string> = { cancelled: "not sent: withdrawn before it was sent", held: "not sent: waiting for the company to be confirmed", queued: "not sent yet", failed: "not sent: it could not be sent" };

/**
 * Everything the person gave us or we sent them; never the assessment's internal rationale, never anyone else's data.
 * Messages that never left us (taken back, withdrawn, held, failed) are listed apart from those sent, each with what
 * happened to it. The team's private notes (application_notes, plan H3) are left out: the counsel default until register
 * item 25 is answered.
 */
export async function exportCandidateData(q: Queryable, companyId: string, candidateId: string): Promise<Record<string, unknown>> {
  const [cand] = await q.select().from(candidates).where(and(eq(candidates.id, candidateId), eq(candidates.companyId, companyId))).limit(1);
  if (!cand) throw new Error("candidate not found");
  const apps = await q.select().from(applications).where(eq(applications.candidateId, cand.id));
  const docs = await q.select({ id: documents.id, kind: documents.kind, filename: documents.filename, mime: documents.mime, sizeBytes: documents.sizeBytes, textExtracted: documents.textExtracted, createdAt: documents.createdAt }).from(documents).where(eq(documents.candidateId, cand.id));
  // A screen's answers live in two places (screen-answers.ts): the export carries every one of them, with the opening questions in the words they were asked.
  const scrRows = await q.select({ applicationId: screens.applicationId, channel: screens.channel, status: screens.status, transcript: screens.transcript, answers: screens.answers, progress: screens.progress, createdAt: screens.createdAt }).from(screens).where(inArray(screens.applicationId, apps.map((a) => a.id).concat(["00000000-0000-0000-0000-000000000000"])));
  // The written-up answers of Review & send (Wave S7) are their words condensed: in the export when there are any.
  const scr = scrRows.map((s) => ({ applicationId: s.applicationId, channel: s.channel, status: s.status, transcript: s.transcript, answers: screenAnswersOf(s), openingQuestions: openingQuestionsOf(s.progress), ...(s.progress?.writeup ? { writtenUp: s.progress.writeup.answers } : {}), createdAt: s.createdAt }));
  const comms = await q.select({ direction: communications.direction, channel: communications.channel, subject: communications.subject, bodyText: communications.bodyText, status: communications.status, deliveredAt: communications.deliveredAt, createdAt: communications.createdAt }).from(communications).where(eq(communications.candidateId, cand.id)).orderBy(desc(communications.createdAt));
  const outbound = comms.filter((c) => c.direction === "outbound");
  const history = await q.select({ type: events.type, occurredAt: events.occurredAt, subjectId: events.subjectId }).from(events).where(and(eq(events.companyId, companyId), inArray(events.subjectId, apps.map((a) => a.id).concat([cand.id]))));
  // The choice they made when they cancelled an interview (founder decision 2A). A no-show is the team's record, not theirs.
  const cancellations = apps.length ? await q.select({ applicationId: interviewFollowups.applicationId, at: interviewFollowups.createdAt, choice: interviewFollowups.choice }).from(interviewFollowups).where(and(inArray(interviewFollowups.applicationId, apps.map((a) => a.id)), eq(interviewFollowups.kind, "candidate_cancelled"))).orderBy(asc(interviewFollowups.createdAt)) : [];
  return {
    exportedAt: new Date().toISOString(),
    person: { firstName: cand.firstName, lastName: cand.lastName, email: cand.email, phone: cand.phone, location: cand.locationText, consent: cand.consent, preferences: cand.preferences, createdAt: cand.createdAt },
    // A decision is in the export whether or not the person was told it yet (plan G1), with whether and when they were.
    applications: apps.map((a) => ({ id: a.id, roleId: a.roleId, stage: a.stage, source: a.source, answers: a.answers, eligibility: a.eligibility ? { passed: a.eligibility.passed, failedRules: a.eligibility.failedRules } : null, appliedAt: a.createdAt, rejectReason: a.rejectReason ?? null, ...(DECISION_STAGES.includes(a.stage) ? { decisionTold: a.toldState, decisionToldAt: a.candidateToldAt ?? null } : {}) })),
    documents: docs,
    screens: scr,
    // Only what actually left us is "sent"; one that may not have arrived says so.
    messagesWeSent: outbound.filter((c) => LEFT_US.has(c.status)).map(({ status, direction: _d, ...c }) => ({ ...c, ...(DID_NOT_ARRIVE[status] ? { delivery: DID_NOT_ARRIVE[status] } : {}) })),
    // Written but never sent (taken back with Undo, withdrawn when the decision changed, held, failed): listed apart, with
    // what happened to each, since they still hold the person's data.
    messagesWeDidNotSend: outbound.filter((c) => !LEFT_US.has(c.status)).map(({ status, direction: _d, deliveredAt: _a, ...c }) => ({ ...c, whatHappened: NOT_SENT[status] ?? "not sent" })),
    messagesYouSent: comms.filter((c) => c.direction === "inbound").map(({ status: _s, deliveredAt: _a, ...c }) => c),
    interviewCancellations: cancellations.map((c) => ({ applicationId: c.applicationId, at: new Date(c.at).toISOString(), choice: c.choice })),
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
  const value = input.field === "email" ? normalizeEmail(input.value) : input.value;
  // A corrected address (or number) is also the key the person is found by (known-bugs row 71): "Lost your link?" and a
  // new application from the new address find this record. If another record of the company already uses that key, the
  // key stays as it was and the request's notes say so; the two records are never merged here.
  const rekey = await rekeyAfterCorrection(q, { candidate: cand, field: input.field, value });
  await q.update(candidates).set({ [input.field]: value, ...(rekey.key ? { dedupeKey: rekey.key } : {}) }).where(eq(candidates.id, cand.id));
  await audit(q, { companyId: row.companyId, actor: input.actor, action: "data.corrected", target: { type: "candidate", id: cand.id }, reason: `correction request ${row.id}`, details: { requestId: row.id, field: input.field, changed: before !== input.value, rekeyed: !!rekey.key, ...(rekey.clash ? { keyInUse: true } : {}) } });
  const at = (input.now ?? new Date()).toISOString();
  const by = input.actor.name ?? input.actor.id;
  const notes = [...row.notes, { at, by, text: `corrected ${input.field}` }, ...(rekey.clash ? [{ at, by, text: "another record of this company already uses the corrected address or number, so the record is still found by the old one; the two records were not merged" }] : [])];
  return resolve(q, { ...row, notes }, input.resolution, input.actor, "fulfilled", input.now);
}

/** The new key after an email or phone correction, or why it stays (another record holds it). Never the person's words. */
async function rekeyAfterCorrection(q: Queryable, input: { candidate: typeof candidates.$inferSelect; field: string; value: string }): Promise<{ key: string | null; clash: boolean }> {
  if (input.field !== "email" && input.field !== "phone") return { key: null, clash: false };
  const { candidate } = input;
  if (candidate.anonymizedAt) return { key: null, clash: false };
  const key = dedupeKey(input.field === "email" ? input.value : candidate.email, input.field === "phone" ? input.value : candidate.phone);
  if (!key || key === candidate.dedupeKey) return { key: null, clash: false };
  const [other] = await q.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.companyId, candidate.companyId), eq(candidates.dedupeKey, key))).limit(1);
  if (other && other.id !== candidate.id) return { key: null, clash: true };
  return { key, clash: false };
}

const DELETION_REASON = "the candidate asked for their information to be deleted";
const REMOVED = "[removed at the candidate's request]";

/** Reasons a stage move records that are fixed codes, never anyone's words: a deletion keeps them in the history. */
const CODED_REASONS: string[] = [...RejectReason.options, "hired_externally", "candidate_withdrew", "employer_declined", "offer_declined_externally", "no_hire", DELETION_REASON];

/**
 * A deletion ends the person's part in every process (plan A9): their interviews still to come are cancelled (the
 * interviewers are told, the calendar events are queued for removal; nobody writes to the candidate, whose address goes
 * in the same transaction), their open screens close, the assistant's waiting suggestions and any message to them
 * waiting for approval are withdrawn (and a closed role's closing message no longer names them), and an application
 * still in the process is withdrawn. Private marks lose their notes, and so do outcomes and the history (a move's own
 * reason, when it was a person's words rather than a fixed one). A decision nobody told them stays untold: nothing
 * is ever sent to them, and nobody is reminded or asked to (decision-messages.ts). The workflow runs about them that are
 * still going (scheduling, screening, new times) are cancelled afterwards by `scrubCandidateWorkflowData`, before their
 * records are scrubbed.
 */
async function closeProcessOnDeletion(q: Queryable, input: { companyId: string; appIds: string[]; actor: Actor; now: Date }): Promise<void> {
  const { companyId, appIds, actor, now } = input;
  if (!appIds.length) return;
  // The applications first, in one order, then their interviews: the order every path that changes both takes (a
  // booking, a cancel, a send of new times), so a deletion and one of those at the same moment take turns.
  await q.select({ id: applications.id }).from(applications).where(inArray(applications.id, appIds)).orderBy(asc(applications.id)).for("update");
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
  const waiting = await q.select({ id: approvalRequests.id, actionType: approvalRequests.actionType, applicationId: approvalRequests.applicationId }).from(approvalRequests).where(and(inArray(approvalRequests.applicationId, appIds), inArray(approvalRequests.actionType, ["application.invite_screen", "application.recommend_interview", "disposition.send", "message.send_freeform"]), eq(approvalRequests.status, "pending")));
  for (const p of waiting) {
    await q.update(approvalRequests).set({ status: "cancelled", decidedAt: now.toISOString(), decisionNote: DELETION_REASON }).where(eq(approvalRequests.id, p.id));
    await emit(q, { type: "approval.cancelled", companyId, actor, subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType, applicationId: p.applicationId, by: "deletion_request" } });
  }
  // A message kept on an approval request, waiting or decided, carries the team's words about them (a decision
  // message's personal line, Q28; a message someone wrote them, F11): the words and their name go. Who asked, and what
  // was decided, stay.
  const worded = await q.select({ id: approvalRequests.id, proposal: approvalRequests.proposal }).from(approvalRequests).where(and(inArray(approvalRequests.applicationId, appIds), inArray(approvalRequests.actionType, ["disposition.send", "message.send_freeform"])));
  for (const r of worded) {
    const p = (r.proposal ?? {}) as Record<string, unknown>;
    const scrubbed = { ...p, ...("personalLine" in p ? { personalLine: null } : {}), ...("text" in p ? { text: "[removed at the candidate's request]" } : {}), ...("subject" in p ? { subject: null } : {}), ...("candidateName" in p ? { candidateName: "a candidate" } : {}) };
    await q.update(approvalRequests).set({ proposal: scrubbed, rationale: null }).where(eq(approvalRequests.id, r.id));
  }
  // A closed role's one closing message (Q30) names everyone it is for: they come off it, and a request left with
  // nobody on it is cancelled.
  const batches = await q.select({ id: approvalRequests.id, proposal: approvalRequests.proposal }).from(approvalRequests).where(and(eq(approvalRequests.companyId, companyId), isNull(approvalRequests.applicationId), eq(approvalRequests.actionType, "disposition.send"), eq(approvalRequests.status, "pending")));
  for (const b of batches) {
    const p = (b.proposal ?? {}) as { kind?: unknown; applicationIds?: unknown };
    if (p.kind !== "role_closed" || !Array.isArray(p.applicationIds)) continue;
    const left = p.applicationIds.filter((id) => !appIds.includes(String(id)));
    if (left.length === p.applicationIds.length) continue;
    if (left.length) {
      await q.update(approvalRequests).set({ proposal: { ...p, applicationIds: left, count: left.length } }).where(eq(approvalRequests.id, b.id));
      continue;
    }
    await q.update(approvalRequests).set({ status: "cancelled", decidedAt: now.toISOString(), decisionNote: DELETION_REASON }).where(eq(approvalRequests.id, b.id));
    await emit(q, { type: "approval.cancelled", companyId, actor, subject: { type: "approval_request", id: b.id }, payload: { actionType: "disposition.send", applicationId: null, by: "deletion_request" } });
  }
  const apps = await q.select({ id: applications.id, stage: applications.stage }).from(applications).where(inArray(applications.id, appIds));
  for (const a of apps) if (canTransition(a.stage, "withdrawn", "system")) await transition(q, { applicationId: a.id, companyId, to: "withdrawn", by: "system", actor, reason: DELETION_REASON });
  await q.update(applicationMarks).set({ note: null }).where(inArray(applicationMarks.applicationId, appIds));
  // The team's private notes (plan H3) lose their words, earlier versions included (the counsel default, register item
  // 25), and so does the note recorded with each decision after an interview. Who wrote a note, and when, stays.
  await q.update(applicationNotes).set({ body: "", previousVersions: [], deletedAt: sql`coalesce(${applicationNotes.deletedAt}, ${now.toISOString()}::timestamptz)` }).where(inArray(applicationNotes.applicationId, appIds));
  await q.update(interviews).set({ decisionNote: null }).where(inArray(interviews.applicationId, appIds));
  // The team's free-text notes were copied into the history as it happened (a mark, a decline, "I told them myself", a
  // decision after an interview): they are blanked there too. What happened, who did it and when stay.
  await q.update(events).set({ payload: sql`jsonb_set(${events.payload}, '{note}', 'null'::jsonb)` }).where(and(eq(events.subjectType, "application"), inArray(events.subjectId, appIds), sql`${events.payload}->>'note' is not null`));
  // A move's reason can be a person's own words too ("Keep them in" with why, a move to the talent pool with a note): any
  // reason that is not one of the fixed ones is blanked. The fixed reasons stay, so the history and the reports still read.
  await q.update(events).set({ payload: sql`jsonb_set(${events.payload}, '{reason}', 'null'::jsonb)` }).where(and(
    eq(events.type, "application.stage_changed"),
    eq(events.subjectType, "application"),
    inArray(events.subjectId, appIds),
    sql`${events.payload}->>'reason' is not null`,
    notInArray(sql`${events.payload}->>'reason'`, CODED_REASONS),
    notLike(sql`${events.payload}->>'reason'`, "role closed: %"),
  ));
  // The words recorded with an outcome (why they were declined, a note with a hire) are the team's about them; so is an
  // administrator's reason for correcting one. The outcome itself, who recorded it and when stay.
  await q.update(hiringOutcomes).set({ notes: null }).where(and(eq(hiringOutcomes.companyId, companyId), inArray(hiringOutcomes.applicationId, appIds)));
  await q.update(hiringOutcomes).set({ correctionReason: REMOVED, details: sql`${hiringOutcomes.details} - 'correctionReason'` }).where(and(eq(hiringOutcomes.companyId, companyId), inArray(hiringOutcomes.applicationId, appIds), sql`(${hiringOutcomes.correctionReason} is not null or ${hiringOutcomes.details}->>'correctionReason' is not null)`));
}

/**
 * Anonymization in place of deletion (runbook step 5): identity fields become tokens; resumes and their text, screening
 * transcripts and answers (the answers to a screen's opening questions included), message bodies and the team's private
 * notes are removed, and so is everything about them in a recruiter's copy and in requests and notices that name them;
 * the AI's readings of them and the AI run log about them keep only their bookkeeping (`scrubCandidateAiData`), and so do
 * the workflow engine's copies (`scrubCandidateWorkflowData`: run state and step records; a run still going is cancelled
 * first, through `cancelRun` when the caller has the engine); stage history, audit records and aggregate counts stay. The
 * person's part in every process ends first (`closeProcessOnDeletion`).
 * Refused unless counsel recorded an approval on this request and the administrator confirmed.
 * `deleteFile` is called for each stored file; a caller inside a transaction should only collect the keys and remove the
 * files once the transaction has committed (apps/api/src/routes/privacy-requests.ts does).
 */
export async function anonymizeCandidate(
  q: Queryable,
  input: { companyId: string; candidateId: string; actor: Actor; deleteFile: (storageKey: string) => Promise<void>; now?: Date; cancelRun?: CancelWorkflowRun },
): Promise<{ documents: number; screens: number; communications: number; assessments: number; aiRuns: number; workflowRuns: number; workflowSteps: number }> {
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
    for (const s of scr) await q.update(screens).set({ transcript: [], answers: {}, progress: withoutCandidateWords(s.progress) }).where(eq(screens.id, s.id));
    // A repeat submission's conversation waiting for the address owner to confirm it (plan E1) goes too, confirmed or not,
    // with everything of theirs in its progress (`withoutCandidateWords`): the written-up answers (Wave S7), the open
    // questions' answers, and what that visit typed for the chat (`typedFacts`: their CV lines and form answers).
    const unconfirmed = await q.select({ id: unconfirmedScreens.id, progress: unconfirmedScreens.progress }).from(unconfirmedScreens).where(inArray(unconfirmedScreens.applicationId, appIds));
    for (const u of unconfirmed) await q.update(unconfirmedScreens).set({ transcript: [], answers: {}, progress: withoutCandidateWords(u.progress), firstName: "", confirmTokenHash: null, discardedAt: now.toISOString(), confirmation: "discarded" }).where(eq(unconfirmedScreens.id, u.id));
    // The reply address of every old email is retired with a fresh random token: a reply to one of them no longer names
    // this application, so it cannot write an address or a message back onto the removed record (the webhook also refuses
    // a reply to an anonymized candidate). The status link keeps its token: its page already says the record is gone.
    for (const a of appIds) await q.update(applications).set({ answers: { noticeVersionsShown: [] }, extraction: null, rejectNote: null, replyToken: randomBytes(8).toString("hex") }).where(eq(applications.id, a));
  }
  const comms = await q.select({ id: communications.id }).from(communications).where(eq(communications.candidateId, cand.id));
  for (const c of comms) await q.update(communications).set({ bodyText: "[removed at the candidate's request]", bodyHtml: null, subject: "[removed]", toAddress: null }).where(eq(communications.id, c.id));
  // Applications they emailed in that were never admitted (a failed or held email, Wave S5 review): no candidate row
  // links to them, so they are found by the application they became or by the address in them, and lose the file too.
  await purgeInboundEmailsOf(q, { companyId: input.companyId, email: cand.email, appIds, deleteFile: input.deleteFile });
  const scrubbed = await scrubRecruiterCopies(q, { companyId: input.companyId, appIds, candidate: cand, now });
  // The workflow engine's copies (run state, step records) lose every word too (Wave S3 G1); a run still going is
  // cancelled first, so nothing it does next can write them back or break on a scrubbed state.
  const wf = await scrubCandidateWorkflowData(q, { companyId: input.companyId, candidateId: cand.id, actor: input.actor, cancelRun: input.cancelRun });
  // The AI's readings of them and the AI run log about them lose every word (founder brief S2, F3): only the bookkeeping stays.
  const ai = await scrubCandidateAiData(q, { companyId: input.companyId, candidateId: cand.id });
  await q.update(candidates).set({ firstName: "Removed", lastName: token, email: null, phone: null, location: null, locationText: null, dedupeKey: `removed:${cand.id}`, tags: [], embedding: null, anonymizedAt: now.toISOString(), consent: {}, preferences: { smsOptOut: true } }).where(eq(candidates.id, cand.id));
  await audit(q, { companyId: input.companyId, actor: input.actor, action: "data.anonymized", target: { type: "candidate", id: cand.id }, reason: "deletion request fulfilled by anonymization after a counsel decision", details: { documents: docs.length, screens: scrCount, communications: comms.length, escalations: scrubbed.escalations, notifications: scrubbed.notifications, assessments: ai.assessments, aiRuns: ai.aiRuns, workflowRunsCancelled: wf.cancelledRuns, workflowRuns: wf.workflowRuns, workflowSteps: wf.workflowSteps, workflowEvents: wf.workflowEvents } });
  await emit(q, { type: "candidate.anonymized", companyId: input.companyId, actor: input.actor, subject: { type: "candidate", id: cand.id }, payload: { documents: docs.length } });
  return { documents: docs.length, screens: scrCount, communications: comms.length, assessments: ai.assessments, aiRuns: ai.aiRuns, workflowRuns: wf.workflowRuns, workflowSteps: wf.workflowSteps };
}

/** What an emailed-in application keeps once its contents are removed: nothing that names or reaches the person. */
export const REMOVED_INBOUND_EMAIL = { rawStorageKey: null, parsed: {}, subject: "[removed]", fromAddress: "[removed]" } as const;

/**
 * Emailed-in applications of one person in one company (inbound_emails): the ones that became one of their applications
 * (`appIds`), and the ones whose sender or contents name their address as a whole address. The stored file is removed
 * (`deleteFile`) and the email's words, sender and subject go. Returns how many were cleared.
 */
export async function purgeInboundEmailsOf(q: Queryable, input: { companyId: string; email: string | null; appIds: readonly string[]; deleteFile: (storageKey: string) => Promise<void> }): Promise<number> {
  const address = input.email?.trim().toLowerCase() ?? "";
  const escaped = address.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const whole = address ? `(^|[^a-z0-9._%+-])${escaped}($|[^a-z0-9._-])` : null;
  const matches = [
    ...(input.appIds.length ? [inArray(inboundEmails.applicationId, [...input.appIds])] : []),
    ...(whole ? [sql`lower(${inboundEmails.fromAddress}) ~ ${whole}`, sql`lower(${inboundEmails.parsed}::text) ~ ${whole}`] : []),
  ];
  if (!matches.length) return 0;
  const rows = await q.select({ id: inboundEmails.id, rawStorageKey: inboundEmails.rawStorageKey }).from(inboundEmails).where(and(eq(inboundEmails.companyId, input.companyId), or(...matches), notLike(inboundEmails.fromAddress, "[removed]")));
  for (const r of rows) {
    if (r.rawStorageKey) await input.deleteFile(r.rawStorageKey);
    await q.update(inboundEmails).set({ ...REMOVED_INBOUND_EMAIL }).where(eq(inboundEmails.id, r.id));
  }
  return rows.length;
}

/** What an AI run about a deleted candidate shows in place of what the model read and wrote. */
export const REMOVED_RUN_OUTPUT: Readonly<Record<string, string>> = { removed: "This AI run was about a candidate whose information was deleted at their request." };

/** Lists in a reading that hold nothing but words about the person (strengths, concerns, résumé facts): emptied. */
const WORDED_LISTS = new Set(["strengths", "concerns", "unknowns", "anomalies", "confidenceReasons", "positions", "education", "licenses", "certifications", "skills", "languages"]);
/** Optional fields that only ever hold the person's words or contact details: dropped. */
const WORDED_OPTIONAL = new Set(["quote", "context", "ref", "note", "stated", "earliestStart", "fullName", "email", "phone", "locationText", "headline"]);
/** Fields whose value is a fixed code (an enum or a packet key), kept so the score, the band and the reports still read. */
const CODE_FIELDS = new Set(["overall", "confidence", "finding", "met", "source", "competencyKey", "requirementKey", "questionKey", "key", "kind", "recommendation", "meetsModelAnswer", "withinRange", "matchesSchedule", "confirmed", "status", "candidateAskedAbout", "sentiment"]);
const CODE_VALUE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;

/**
 * An AI reading (an assessment's result, or a model's structured output) without the person in it: every free-text
 * field becomes "[removed at the candidate's request]", quotes, notes and contact fields go, and lists of findings are
 * emptied. Numbers, yes/no values and fixed codes (the band, the confidence, which must-have was met) stay, so the
 * shape still reads and the counts still add up. Pure and idempotent: scrubbing a scrubbed reading changes nothing.
 */
export function scrubReading(value: unknown, field: string | null = null): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return field && CODE_FIELDS.has(field) && CODE_VALUE.test(value) ? value : REMOVED;
  if (Array.isArray(value)) return field && WORDED_LISTS.has(field) ? [] : value.map((v) => scrubReading(v, field));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (WORDED_OPTIONAL.has(k)) continue;
      out[k] = scrubReading(v, k);
    }
    return out;
  }
  return REMOVED;
}

const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An AI run's input reference keeps ids, counts and codes (what it was about), never words. */
function scrubInputRef(ref: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ref)) {
    if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
    else if (typeof v === "string" && (UUID_VALUE.test(v) || CODE_VALUE.test(v))) out[k] = v;
  }
  return out;
}

type AiRunRow = typeof aiRuns.$inferSelect;

/** An AI run with only its bookkeeping (ids, task, model, prompt, tokens, cost, timings, status): what it read and wrote goes. */
export function scrubAiRun(run: Pick<AiRunRow, "inputRef" | "toolCalls" | "structuredOutput" | "policyDecision" | "humanOverride" | "finalOutcome" | "error">): Pick<AiRunRow, "inputRef" | "toolCalls" | "structuredOutput" | "policyDecision" | "humanOverride" | "finalOutcome" | "error"> {
  const override = run.humanOverride ? { ...run.humanOverride, ...("note" in run.humanOverride ? { note: null } : {}) } : null;
  return {
    inputRef: scrubInputRef(run.inputRef ?? {}),
    toolCalls: [],
    structuredOutput: { ...REMOVED_RUN_OUTPUT },
    policyDecision: run.policyDecision ? (scrubReading(run.policyDecision) as Record<string, unknown>) : null,
    humanOverride: override,
    finalOutcome: run.finalOutcome ? (scrubReading(run.finalOutcome) as Record<string, unknown>) : null,
    error: run.error === null ? null : REMOVED,
  };
}

const NO_ID = "00000000-0000-0000-0000-000000000000";
const anyOf = (ids: string[]) => (ids.length ? ids : [NO_ID]);

/**
 * Scrubs the AI's readings of one candidate (assessments) and the AI run log about them (`ai_runs`: résumé reading,
 * scoring readings, screening chat turns and scorecards, suggested message lines), found by the application, screen,
 * document and workflow they were about, or by the assessment that points at them. Only rows that still hold words are
 * written, so it is safe to run again: the deletion runs it, and the daily maintenance repeats it for every anonymized
 * candidate (`scrubAnonymizedCandidatesAiData`), which catches a run that finished after the deletion.
 */
export async function scrubCandidateAiData(q: Queryable, input: { companyId: string; candidateId: string }): Promise<{ assessments: number; aiRuns: number }> {
  const { companyId, candidateId } = input;
  const refs = await candidateRefs(q, companyId, candidateId);
  const { appIds, docIds, screenIds, unconfirmedIds } = refs;
  const wfRuns = await workflowRunsAbout(q, companyId, candidateId, refs);
  const wfIds = wfRuns.map((w) => w.id);
  // The apply form's reading of the upload they sent (20 Oct, R20-1), also one never tied to the application: it carries
  // only the upload, which their intake run names.
  const uploadIds = wfRuns.map((w) => w.formUploadId).filter((u): u is string => !!u);

  let assessmentCount = 0;
  const runIds: string[] = [];
  if (appIds.length) {
    const rows = await q.select({ id: assessments.id, result: assessments.result, aiRunId: assessments.aiRunId }).from(assessments).where(inArray(assessments.applicationId, appIds));
    for (const a of rows) {
      if (a.aiRunId) runIds.push(a.aiRunId);
      const result = scrubReading(a.result) as typeof a.result;
      if (JSON.stringify(result) === JSON.stringify(a.result)) continue;
      await q.update(assessments).set({ result }).where(eq(assessments.id, a.id));
      assessmentCount++;
    }
  }

  const about: SQL[] = [
    inArray(aiRuns.id, anyOf(runIds)),
    inArray(sql`${aiRuns.inputRef}->>'applicationId'`, anyOf(appIds)),
    inArray(sql`${aiRuns.inputRef}->>'screenId'`, anyOf([...screenIds, ...unconfirmedIds])),
    // the one-visit apply chat records its turns against the unconfirmed screen, with no workflow run (apply-conversation.ts)
    inArray(sql`${aiRuns.inputRef}->>'unconfirmedScreenId'`, anyOf(unconfirmedIds)),
    inArray(sql`${aiRuns.inputRef}->>'documentId'`, anyOf(docIds)),
    inArray(sql`${aiRuns.inputRef}->>'candidateId'`, [candidateId]),
    inArray(aiRuns.workflowRunId, anyOf(wfIds)),
    inArray(sql`${aiRuns.inputRef}->>'uploadId'`, anyOf(uploadIds)),
  ];
  const runs = await q.select({ id: aiRuns.id, inputRef: aiRuns.inputRef, toolCalls: aiRuns.toolCalls, structuredOutput: aiRuns.structuredOutput, policyDecision: aiRuns.policyDecision, humanOverride: aiRuns.humanOverride, finalOutcome: aiRuns.finalOutcome, error: aiRuns.error }).from(aiRuns).where(and(eq(aiRuns.companyId, companyId), or(...about)));
  let runCount = 0;
  for (const r of runs) {
    const { id, ...before } = r;
    const after = scrubAiRun(before);
    if (JSON.stringify(after) === JSON.stringify(before)) continue;
    await q.update(aiRuns).set(after).where(eq(aiRuns.id, id));
    runCount++;
  }
  return { assessments: assessmentCount, aiRuns: runCount };
}

/**
 * The candidates anonymized so far, or only those anonymized since a time (the daily clean-up's window: a run that
 * finishes late lands within days of the deletion). Cheap: one indexed-by-company read of ids.
 */
export async function anonymizedCandidates(q: Queryable, opts: { since?: Date } = {}): Promise<Array<{ id: string; companyId: string }>> {
  const where = opts.since ? and(isNotNull(candidates.anonymizedAt), gte(candidates.anonymizedAt, opts.since.toISOString())) : isNotNull(candidates.anonymizedAt);
  return q.select({ id: candidates.id, companyId: candidates.companyId }).from(candidates).where(where);
}

/**
 * The clean-up (apps/api/src/maintenance.ts): every candidate anonymized so far (or since `since`) has their AI readings
 * and AI run log scrubbed, which covers deletions made before this existed and any model run that finished after a
 * deletion. Idempotent: a second run writes nothing. The daily maintenance calls scrubCandidateAiData itself, one short
 * transaction per candidate; this all-in-one form stays for callers that already hold a transaction.
 */
export async function scrubAnonymizedCandidatesAiData(q: Queryable, opts: { since?: Date } = {}): Promise<{ candidates: number; assessments: number; aiRuns: number }> {
  const gone = await anonymizedCandidates(q, opts);
  const total = { candidates: 0, assessments: 0, aiRuns: 0 };
  for (const c of gone) {
    const n = await scrubCandidateAiData(q, { companyId: c.companyId, candidateId: c.id });
    if (n.assessments || n.aiRuns) total.candidates++;
    total.assessments += n.assessments;
    total.aiRuns += n.aiRuns;
  }
  return total;
}

/** What a candidate's records are found by: their applications in the company and what hangs off them. */
type CandidateRefs = { appIds: string[]; docIds: string[]; screenIds: string[]; unconfirmedIds: string[]; interviewIds: string[] };

async function candidateRefs(q: Queryable, companyId: string, candidateId: string): Promise<CandidateRefs> {
  const appIds = (await q.select({ id: applications.id }).from(applications).where(and(eq(applications.companyId, companyId), eq(applications.candidateId, candidateId)))).map((a) => a.id);
  const docIds = (await q.select({ id: documents.id }).from(documents).where(eq(documents.candidateId, candidateId))).map((d) => d.id);
  const screenIds = appIds.length ? (await q.select({ id: screens.id }).from(screens).where(inArray(screens.applicationId, appIds))).map((s) => s.id) : [];
  const unconfirmedIds = appIds.length ? (await q.select({ id: unconfirmedScreens.id }).from(unconfirmedScreens).where(inArray(unconfirmedScreens.applicationId, appIds))).map((s) => s.id) : [];
  const interviewIds = appIds.length ? (await q.select({ id: interviews.id }).from(interviews).where(inArray(interviews.applicationId, appIds))).map((i) => i.id) : [];
  return { appIds, docIds, screenIds, unconfirmedIds, interviewIds };
}

/**
 * The workflow runs about a candidate: those whose subject is one of their applications, screens or interviews (or the
 * candidate), and those whose state names one of them (a scheduling run is about an interview, and carries the
 * application; a new-times run carries both).
 */
async function workflowRunsAbout(q: Queryable, companyId: string, candidateId: string, refs: CandidateRefs): Promise<Array<{ id: string; status: string; formUploadId: string | null }>> {
  const subjects = [...refs.appIds, ...refs.screenIds, ...refs.unconfirmedIds, ...refs.interviewIds, candidateId];
  return q.select({ id: workflowRuns.id, status: workflowRuns.status, formUploadId: sql<string | null>`${workflowRuns.state}->>'formUploadId'` }).from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), or(
    inArray(sql`${workflowRuns.subject}->>'id'`, subjects),
    inArray(sql`${workflowRuns.state}->>'applicationId'`, anyOf(refs.appIds)),
    inArray(sql`${workflowRuns.state}->>'interviewId'`, anyOf(refs.interviewIds)),
    inArray(sql`${workflowRuns.state}->>'screenId'`, anyOf(refs.screenIds)),
  )));
}

/** Run statuses the engine never moves on from (WorkflowEngine.tick returns at once for them). */
const ENDED_RUN = new Set(["completed", "failed", "cancelled"]);

/** Cancels one workflow run with a reason; WorkflowEngine.cancel (packages/workflows) has this shape once bound to an actor. */
export type CancelWorkflowRun = (q: Queryable, runId: string, reason: string) => Promise<void>;

/**
 * The engine's cancel path for a caller that does not hold the engine (core cannot import packages/workflows, which
 * imports core): the same writes as WorkflowEngine.cancel (cancelled, no wait, the reason as its last error) and the same
 * `workflow.cancelled` event. Callers that hold the engine pass `engine.cancel` instead (the admin console's deletion and
 * the worker's daily clean-up both do); this copy is for callers without it (tests, scripts). Keep it in step with the
 * engine's cancel if that ever changes.
 */
export function cancelRunAsEngineDoes(actor: Actor): CancelWorkflowRun {
  return async (q, runId, reason) => {
    const [run] = await q.select({ status: workflowRuns.status, companyId: workflowRuns.companyId }).from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
    if (!run || ENDED_RUN.has(run.status)) return;
    await q.update(workflowRuns).set({ status: "cancelled", wait: null, lastError: reason }).where(eq(workflowRuns.id, runId));
    await emit(q, { type: "workflow.cancelled", companyId: run.companyId, actor, subject: { type: "workflow_run", id: runId }, payload: { reason }, correlationId: runId });
  };
}

/** Keys in a run's state or a step's record that only ever hold the person's words or contact details: dropped. */
const WORKFLOW_WORDED_KEYS = new Set([...WORDED_OPTIONAL, "invitationNote", "personalLine", "message", "messageToCandidate", "text", "body", "html", "answers", "answer", "transcript", "resumeText", "summary", "name", "firstName", "lastName", "candidateName", "senderName", "address", "toAddress"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** Digits with a phone number's separators: never a code, whatever its shape. */
const PHONE_LIKE = /^[\d\s().+-]+$/;

/**
 * Keys whose short lowercase values are fixed codes in the engine and the workflow definitions (a step, a status, a
 * signal key, a decision). Under any other key a single lowercase word ("jane"), a slug or a run of digits (a zip code)
 * could be the person, so it goes.
 */
const WORKFLOW_CODE_KEYS = new Set([
  ...CODE_FIELDS,
  "step", "nextStep", "resumeStep", "currentStep", "next", "result", "outcome", "decision", "choice", "action", "reason",
  "via", "channel", "medium", "mode", "flow", "variant", "type", "tier", "task", "purpose", "stage", "fromStage", "toStage",
  "roundKey", "offerKind", "invitedBy", "invitedVia", "workflowKey", "keys", "eventTypes", "subjectId", "subjectType", "token", "code",
]);
/** A code with its own structure (`slot_1`, `first_round`, `<id>:message.received`) reads as bookkeeping under any key. */
const STRUCTURED_CODE = /[_:]/;

/**
 * A string that is bookkeeping, not words: an id, a time, or a fixed code (a step name, a status, a signal key). A code
 * counts only with structure of its own or under a key that holds codes; a phone-like or zip-like run of digits never does.
 */
function isBookkeeping(s: string, key?: string): boolean {
  if (UUID_VALUE.test(s) || ISO_TIME.test(s)) return true;
  if (PHONE_LIKE.test(s) && s.replace(/\D/g, "").length >= 5) return false;
  if (!CODE_VALUE.test(s)) return false;
  return STRUCTURED_CODE.test(s) || (key !== undefined && WORKFLOW_CODE_KEYS.has(key));
}

/**
 * A workflow run's state, wait or a step's record without the person in it: ids, times, numbers, yes/no values and
 * fixed codes stay (so the run still reads: which application, which interview, which attempt, which step came next);
 * every other string becomes "[removed at the candidate's request]", and keys that only hold words or contact details
 * (a note to them, their name, an answer) go. Pure and idempotent.
 */
export function scrubWorkflowRecord(value: unknown): unknown {
  return scrubWorkflowValue(value, undefined);
}

/** `key` is the field the value sits under (an array's elements sit under the array's field). */
function scrubWorkflowValue(value: unknown, key: string | undefined): unknown {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return isBookkeeping(value, key) ? value : REMOVED;
  if (Array.isArray(value)) return value.map((v) => scrubWorkflowValue(v, key));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (WORKFLOW_WORDED_KEYS.has(k)) continue;
      out[k] = scrubWorkflowValue(v, k);
    }
    return out;
  }
  return REMOVED;
}

/** An error kept with a run or a step: a code, or the deletion's own reason, stays; a message (which can quote what the model read) does not. */
export function scrubWorkflowError(error: string | null): string | null {
  if (error === null) return null;
  return error === DELETION_REASON || isBookkeeping(error, "code") ? error : REMOVED;
}

/**
 * The workflow engine's copies of one candidate (Wave S3 G1): the state of every run about their applications (a note to
 * them, carried answers, what a model read) and every step's record (what woke it, what it returned, its error) keep only
 * the bookkeeping: ids, status, timings, step names, codes; the copies of a step's error in the run's events and its
 * queued job go the same way. A run still going is cancelled first through `cancelRun` (the engine's cancel;
 * `cancelRunAsEngineDoes` without it), since a running step must never meet a scrubbed state: the engine re-reads the
 * run's status under a row lock before it writes a step's result, so a step in flight stands down once the run is
 * cancelled. A run that would not stop is left whole for the next clean-up. Only rows that still hold words are written,
 * so it is safe to run again: the deletion runs it, and the daily maintenance repeats it for every anonymized candidate.
 */
export async function scrubCandidateWorkflowData(q: Queryable, input: { companyId: string; candidateId: string; actor?: Actor; cancelRun?: CancelWorkflowRun }): Promise<{ cancelledRuns: number; workflowRuns: number; workflowSteps: number; workflowEvents: number }> {
  const { companyId, candidateId } = input;
  const found = await workflowRunsAbout(q, companyId, candidateId, await candidateRefs(q, companyId, candidateId));
  const result = { cancelledRuns: 0, workflowRuns: 0, workflowSteps: 0, workflowEvents: 0 };
  if (!found.length) return result;
  const cancel = input.cancelRun ?? cancelRunAsEngineDoes(input.actor ?? SYSTEM_ACTOR);
  for (const r of found) {
    if (ENDED_RUN.has(r.status)) continue;
    await cancel(q, r.id, DELETION_REASON);
    result.cancelledRuns++;
  }
  const runs = await q.select({ id: workflowRuns.id, status: workflowRuns.status, state: workflowRuns.state, wait: workflowRuns.wait, lastError: workflowRuns.lastError }).from(workflowRuns).where(inArray(workflowRuns.id, found.map((r) => r.id)));
  const ended = runs.filter((r) => ENDED_RUN.has(r.status));
  for (const r of ended) {
    const after = { state: scrubWorkflowRecord(r.state) as typeof r.state, wait: (r.wait === null ? null : scrubWorkflowRecord(r.wait)) as typeof r.wait, lastError: scrubWorkflowError(r.lastError) };
    if (JSON.stringify(after) === JSON.stringify({ state: r.state, wait: r.wait, lastError: r.lastError })) continue;
    await q.update(workflowRuns).set(after).where(eq(workflowRuns.id, r.id));
    result.workflowRuns++;
  }
  if (!ended.length) return result;
  const steps = await q.select({ id: workflowSteps.id, input: workflowSteps.input, output: workflowSteps.output, error: workflowSteps.error }).from(workflowSteps).where(inArray(workflowSteps.runId, ended.map((r) => r.id)));
  for (const s of steps) {
    const after = { input: scrubWorkflowRecord(s.input) as typeof s.input, output: scrubWorkflowRecord(s.output) as typeof s.output, error: scrubWorkflowError(s.error) };
    if (JSON.stringify(after) === JSON.stringify({ input: s.input, output: s.output, error: s.error })) continue;
    await q.update(workflowSteps).set(after).where(eq(workflowSteps.id, s.id));
    result.workflowSteps++;
  }
  // The engine writes a step's error to two more places at the same moment: the run's events (workflow.retried,
  // workflow.failed) and the queued job's last error. They get the same treatment as the run's own last error.
  const endedIds = ended.map((r) => r.id);
  const evs = await q.select({ id: events.id, payload: events.payload }).from(events).where(and(eq(events.companyId, companyId), eq(events.subjectType, "workflow_run"), inArray(events.subjectId, endedIds), sql`${events.payload}->>'error' is not null`));
  for (const e of evs) {
    const before = typeof e.payload.error === "string" ? e.payload.error : null;
    const after = scrubWorkflowError(before);
    if (after === before) continue;
    await q.update(events).set({ payload: sql`jsonb_set(${events.payload}, '{error}', to_jsonb(${after}::text))` }).where(eq(events.id, e.id));
    result.workflowEvents++;
  }
  // The queue belongs to the platform: a tenant transaction may add a job but not read one, so a deletion made in one
  // leaves the job's copy to the daily clean-up, which runs as the platform.
  const [grant] = rowsOf<{ ok: boolean }>(await q.execute(sql`SELECT has_table_privilege('jobs', 'SELECT') AND has_table_privilege('jobs', 'UPDATE') AS ok`));
  const queued = grant?.ok ? await q.select({ id: jobs.id, lastError: jobs.lastError }).from(jobs).where(and(inArray(sql`${jobs.payload}->>'runId'`, endedIds), isNotNull(jobs.lastError))) : [];
  for (const j of queued) {
    const after = scrubWorkflowError(j.lastError);
    if (after === j.lastError) continue;
    await q.update(jobs).set({ lastError: after }).where(eq(jobs.id, j.id));
    result.workflowEvents++;
  }
  return result;
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

type SnapshotRef = { applicationId?: unknown; name?: unknown };
type SnapshotBoard = { people?: SnapshotRef[]; summary?: { longestWaiting?: SnapshotRef | null; nextSteps?: SnapshotRef[]; sentences?: unknown[] } & Record<string, unknown> } & Record<string, unknown>;

/**
 * The pool board kept on a role review (`contextSnapshot.board`, plan F9) without the person: their row (name, score,
 * reason, what needed an eye) and their next step go, "longest waiting" no longer points at them, and the summary's
 * sentences lose their name. Counts stay, as numbers. `changed` is false when the snapshot never held them.
 */
export function scrubBoardSnapshot(board: unknown, appIds: readonly string[], patterns: IdentifyingPatterns): { changed: boolean; value: unknown } {
  if (!board || typeof board !== "object") return { changed: false, value: board };
  const b = board as SnapshotBoard;
  const theirs = (x: SnapshotRef | null | undefined) => typeof x?.applicationId === "string" && appIds.includes(x.applicationId);
  const longest = b.summary?.longestWaiting ?? null;
  const longestName = theirs(longest) && typeof longest?.name === "string" ? longest.name : null;
  const people = Array.isArray(b.people) ? b.people.filter((p) => !theirs(p)) : b.people;
  const summary = b.summary
    ? {
        ...b.summary,
        longestWaiting: theirs(longest) ? null : longest,
        nextSteps: Array.isArray(b.summary.nextSteps) ? b.summary.nextSteps.filter((s) => !theirs(s)) : b.summary.nextSteps,
        sentences: Array.isArray(b.summary.sentences) ? b.summary.sentences.filter((s) => !(longestName && typeof s === "string" && s.startsWith(`${longestName} has waited longest`))).map((s) => (typeof s === "string" ? redactPerson(s, patterns, "a candidate") : s)) : b.summary.sentences,
      }
    : b.summary;
  const value = { ...b, people, summary };
  return { changed: JSON.stringify(value) !== JSON.stringify(board), value };
}

/**
 * A deletion reaches the recruiter's copy too (Q31 family, step 13): a request about one of the person's applications
 * keeps the company and role context but loses everything about the candidate, and its question is removed; any other
 * request, recruiter answer, in-app notice or team email that names them has the name, email and phone replaced, and a
 * role review's board snapshot loses them too (`scrubBoardSnapshot`).
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
    // A review of a whole role carries the pool board as it stood (plan F9): the person's own row goes, and the summary
    // loses their name wherever it named them.
    const board = scrubBoardSnapshot((e.contextSnapshot as { board?: unknown } | null)?.board, input.appIds, patterns);
    if (!board.changed && !patterns.name.length && !patterns.contact.length) continue;
    const question = redactPerson(e.question, patterns, "a candidate");
    const resolution = e.resolution === null ? null : redactPerson(e.resolution, patterns, "a candidate");
    if (question !== e.question || resolution !== e.resolution || board.changed) {
      await q.update(recruiterEscalations).set({ question, resolution, ...(board.changed ? { contextSnapshot: { ...e.contextSnapshot, board: board.value } } : {}) }).where(eq(recruiterEscalations.id, e.id));
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
    // Mail kept with no candidate on it (the team's alerts and summaries, the ITS queue's notices) should never name
    // anyone; any that did loses the name, email and phone here too. A copy already sent stays with the email provider.
    const teamMail = await q.select({ id: communications.id, subject: communications.subject, bodyText: communications.bodyText, bodyHtml: communications.bodyHtml }).from(communications).where(and(eq(communications.companyId, input.companyId), isNull(communications.candidateId)));
    for (const m of teamMail) {
      const subject = m.subject === null ? null : redactPerson(m.subject, patterns, "A candidate");
      const bodyText = redactPerson(m.bodyText, patterns, "a candidate");
      const bodyHtml = m.bodyHtml === null ? null : redactPerson(m.bodyHtml, patterns, "a candidate");
      if (subject === m.subject && bodyText === m.bodyText && bodyHtml === m.bodyHtml) continue;
      await q.update(communications).set({ subject, bodyText, bodyHtml }).where(eq(communications.id, m.id));
    }
  }
  return { escalations: escalationCount, notifications: notificationCount };
}

export class CounselDecisionRequired extends Error {
  constructor() {
    super("A deletion or anonymization runs only after counsel records an approval on this request and the administrator confirms; retention rules are under counsel review.");
  }
}

export async function fulfilDeletionRequest(q: Queryable, row: DataRequestRow, input: { resolution: string; confirm: boolean; actor: Actor; deleteFile: (key: string) => Promise<void>; now?: Date; cancelRun?: CancelWorkflowRun }): Promise<DataRequestRow> {
  if (row.counselDecision !== "approved" || !input.confirm) throw new CounselDecisionRequired();
  if (!row.candidateId) throw new Error("no candidate is linked to this request");
  const counts = await anonymizeCandidate(q, { companyId: row.companyId, candidateId: row.candidateId, actor: input.actor, deleteFile: input.deleteFile, now: input.now, cancelRun: input.cancelRun });
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

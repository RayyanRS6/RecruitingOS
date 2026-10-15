import { and, asc, desc, eq, inArray, isNull, like, lt, sql } from "drizzle-orm";
import type { Actor, EscalationThreadEntry } from "@ros/contracts";
import {
  adminAlerts, applications, assessments, candidates, communications, companies, documents, escalationMessages, events, intakeSessions, interviews, jobs, recruiterEscalations,
  rolePackets, roles, scorecards, screens, staffAccessGrants, users, type EscalationMessageKind, type EscalationMessageSide, type Queryable,
} from "@ros/db";
import { raiseAlert } from "./alerts";
import { emit } from "./events";
import { escalationReplyBy, type CalendarSource } from "./business-hours";
import { loadBusinessCalendar } from "./business-calendar";
import { ESCALATION_ACCESS_DAYS, endStaffGrant, grantStaffAccess, type StaffGrant } from "./staff-access";
import { defaultUrgency, genericSummary, requestOrigin, requiredExpertise, servedSummary, type EscalationUrgency } from "./escalation-preview";
import { screenAnswersOf, teamScreenView, unsentScreenReadings, withoutUnsentConversation, withoutUnsentScreenEvents } from "./screen-answers";

/**
 * The queued job that emails the ITS queue mailbox about a request the system raised (Wave S5 C2, audit row 36): a
 * candidate who asked for a person, a screening hand-off, a stopped workflow, an eligibility hold, a privacy review, a
 * scheduling problem, a decision nobody sent. Requests a person on the team raises are emailed by the route that takes
 * them, as before. The job is written in the request's own transaction, so a request that rolls back emails nobody; the
 * email itself goes through the outbox under the key `escalation:<id>`, so a caller that already queued its own notice
 * under that key (the stuck-role ladder) is never doubled.
 */
export const ESCALATION_QUEUE_EMAIL_JOB_KIND = "escalation.queue_email";

/**
 * Whether system-raised requests queue that email, and on which clock the job is due. The process that registers the
 * job's handler switches it on (apps/api/src/container.ts), like `setAlertEmails`, so a process or a test without the
 * handler never queues a job nobody can run.
 */
let queueEmailClock: (() => Date) | null = null;
export function setEscalationQueueEmails(clock: (() => Date) | null): void {
  queueEmailClock = clock;
}

/**
 * Whether a new request is the system's own (or a candidate's, through the product), as opposed to one a person on the
 * team or an ITS recruiter raised: only those are emailed from here. ITS posting tasks are ITS's own board work, listed
 * in the queue and on the job's Share tab, and are not emailed.
 */
export function raisedWithoutAPerson(input: { requestedBy: Actor; postingId?: string | null }): boolean {
  return !input.postingId && input.requestedBy.kind !== "user" && input.requestedBy.kind !== "recruiter";
}

/**
 * "Ask a recruiter." Captures the complete context so the recruiter never has to ask
 * "what is this role?" or "what happened with this candidate?".
 */
export async function createEscalation(
  q: Queryable,
  input: {
    companyId: string; roleId?: string | null; applicationId?: string | null; kind: string; question: string; requestedBy: Actor; workflowRunId?: string | null; now?: Date;
    /** Pre-acceptance preview (correction 11). Defaults come from the category; a caller may only pass template text, never a person's words. */
    urgency?: EscalationUrgency; summaryOrigin?: "customer" | "system" | "candidate";
    /** A role still being drafted (C12): its whole conversation and the current draft go into the context. The caller checked access. */
    intakeSessionId?: string | null;
    /**
     * An ITS posting task (plan D3, packages/core/src/posting-tasks.ts): the posting it is about, its template summary
     * (a board's name from a fixed list, never a person's words) and the little context it needs in place of the whole
     * role record, since posting a job needs the job ad and nothing about candidates.
     */
    postingId?: string | null;
    summary?: string;
    context?: Record<string, unknown>;
    /** Email the ITS queue mailbox from here; by default only for a request no person raised (`raisedWithoutAPerson`). */
    tellQueue?: boolean;
  },
): Promise<{ id: string; slaDueAt: string }> {
  const now = input.now ?? new Date();
  const snapshot = input.context ?? await buildEscalationContext(q, input.companyId, input.roleId ?? null, input.applicationId ?? null, input.intakeSessionId ?? null);
  // Founder decision F12: SLAs count business hours on the ITS calendar (correction 12: the calendar is editable and versioned).
  const calendar = await loadBusinessCalendar(q, now);
  const slaDueAt = escalationReplyBy(input.kind, now, calendar).toISOString();
  const company = snapshot.company as { vertical?: string | null } | null;
  const [row] = await q
    .insert(recruiterEscalations)
    .values({
      companyId: input.companyId,
      roleId: input.roleId ?? null,
      applicationId: input.applicationId ?? null,
      kind: input.kind,
      question: input.question,
      urgency: input.urgency ?? defaultUrgency(input.kind),
      requiredExpertise: requiredExpertise(input.kind, company?.vertical ?? null),
      summary: input.summary ?? genericSummary(input.kind, { hasRole: !!input.roleId, hasApplication: !!input.applicationId, origin: input.summaryOrigin ?? (input.requestedBy.kind === "system" ? "system" : input.requestedBy.kind === "candidate" ? "candidate" : "customer") }),
      requestedBy: input.requestedBy,
      contextSnapshot: snapshot,
      slaDueAt,
      postingId: input.postingId ?? null,
    })
    .returning({ id: recruiterEscalations.id });
  await emit(q, {
    type: "recruiter.requested",
    companyId: input.companyId,
    actor: input.requestedBy,
    subject: { type: "escalation", id: row.id },
    payload: { kind: input.kind, roleId: input.roleId ?? null, applicationId: input.applicationId ?? null, ...(input.intakeSessionId ? { intakeSessionId: input.intakeSessionId } : {}), ...(input.postingId ? { postingId: input.postingId } : {}) },
    correlationId: input.workflowRunId ?? null,
  });
  if (queueEmailClock && (input.tellQueue ?? raisedWithoutAPerson(input))) {
    await q.insert(jobs).values({ kind: ESCALATION_QUEUE_EMAIL_JOB_KIND, payload: { escalationId: row.id, companyId: input.companyId }, runAt: queueEmailClock().toISOString(), maxAttempts: 5 });
  }
  return { id: row.id, slaDueAt };
}

/** The alert a request raises once its reply-by time has passed with nobody on it (audit row 38). */
export const ESCALATION_OVERDUE_ALERT_KIND = "escalation.overdue";
/** The one alert emailed when more than `OVERDUE_EMAILS_AT_ONCE` requests are found late in the same check. */
export const ESCALATION_OVERDUE_BACKLOG_ALERT_KIND = "escalation.overdue_backlog";
export const OVERDUE_EMAILS_AT_ONCE = 5;

/**
 * Requests past their reply-by time that nobody has picked up (still `open`) raise one alert each, once for each
 * reply-by time (a reopened request has a new one, and is alerted again if that passes too). The alert names the
 * category, urgency and how late it is, never the request's words. An alert whose request has since been picked up,
 * answered or cancelled is resolved. Platform side: run it in a platform transaction (the hourly check does).
 */
export async function alertOverdueEscalations(q: Queryable, now: Date = new Date()): Promise<{ raised: number; resolved: number }> {
  // Only requests not yet alerted for this reply-by time, in SQL: however many old ones stay open, a request that goes
  // late later is always among those read.
  const notYetAlerted = sql`NOT EXISTS (SELECT 1 FROM ${adminAlerts} WHERE ${adminAlerts.kind} = ${ESCALATION_OVERDUE_ALERT_KIND} AND ${adminAlerts.target}->>'id' = ${recruiterEscalations.id}::text AND (${adminAlerts.details}->>'slaDueAt')::timestamptz = ${recruiterEscalations.slaDueAt})`;
  const overdue = await q
    .select({ id: recruiterEscalations.id, companyId: recruiterEscalations.companyId, kind: recruiterEscalations.kind, urgency: recruiterEscalations.urgency, slaDueAt: recruiterEscalations.slaDueAt, createdAt: recruiterEscalations.createdAt })
    .from(recruiterEscalations)
    .where(and(eq(recruiterEscalations.status, "open"), lt(recruiterEscalations.slaDueAt, now.toISOString()), notYetAlerted))
    .orderBy(asc(recruiterEscalations.slaDueAt))
    .limit(500);
  // A backlog found at once (the first run after a deploy, or after the check could not run): each request is listed in
  // the console, and one summary alert is the only one emailed, instead of an email per critical request.
  const backlog = overdue.length > OVERDUE_EMAILS_AT_ONCE;
  if (backlog) {
    await raiseAlert(q, {
      kind: ESCALATION_OVERDUE_BACKLOG_ALERT_KIND,
      severity: "critical",
      title: `${overdue.length} recruiter requests are past their reply-by time`,
      body: `${overdue.length} open requests have waited past their reply-by time with nobody on them (${overdue.filter((e) => e.urgency === "critical").length} of them critical). Each is listed in the console; open the recruiter queue and accept them, or tell the customers when someone will.`,
      details: { count: overdue.length },
    });
  }
  let raised = 0;
  for (const e of overdue) {
    if (!e.slaDueAt) continue;
    const lateHours = Math.max(0, Math.round((now.getTime() - Date.parse(e.slaDueAt)) / 3_600_000));
    await raiseAlert(q, {
      kind: ESCALATION_OVERDUE_ALERT_KIND,
      severity: e.urgency === "critical" && !backlog ? "critical" : "high",
      title: `A recruiter request is past its reply-by time: ${e.kind}`,
      body: `A ${e.urgency} urgency ${e.kind} request has waited past its reply-by time (${lateHours < 1 ? "less than an hour" : `${lateHours} hour${lateHours === 1 ? "" : "s"}`} late) and nobody has picked it up. Open the recruiter queue and accept it, or tell the customer when someone will.`,
      companyId: e.companyId,
      target: { type: "escalation", id: e.id },
      details: { slaDueAt: e.slaDueAt, kind: e.kind, urgency: e.urgency },
    });
    raised += 1;
  }
  // Alerts about requests someone has picked up (or that were answered or cancelled) since are over.
  const standing = await q.select({ id: adminAlerts.id, target: adminAlerts.target }).from(adminAlerts).where(and(eq(adminAlerts.kind, ESCALATION_OVERDUE_ALERT_KIND), inArray(adminAlerts.status, ["open", "acknowledged"])));
  const ids = [...new Set(standing.map((a) => a.target?.id).filter((x): x is string => !!x))];
  const stillOpen = new Set(ids.length ? (await q.select({ id: recruiterEscalations.id }).from(recruiterEscalations).where(and(inArray(recruiterEscalations.id, ids), eq(recruiterEscalations.status, "open")))).map((r) => r.id) : []);
  const over = standing.filter((a) => a.target?.id && !stillOpen.has(a.target.id)).map((a) => a.id);
  if (over.length) await q.update(adminAlerts).set({ status: "resolved", resolvedAt: now.toISOString() }).where(inArray(adminAlerts.id, over));
  return { raised, resolved: over.length };
}

const URGENCY_RANK: Record<string, number> = { critical: 3, high: 2, normal: 1, low: 0 };

/**
 * The ITS queue's order (founder decision Q32, option A): urgent requests first, then the soonest reply-by time, then
 * the oldest. Urgency moves a request up the queue and never changes its reply-by time.
 */
export function queueOrder<T extends { urgency: string; slaDueAt: string | null; createdAt: string }>(rows: readonly T[]): T[] {
  const due = (r: T) => (r.slaDueAt ? Date.parse(r.slaDueAt) : Number.POSITIVE_INFINITY);
  return [...rows].sort((a, b) => (URGENCY_RANK[b.urgency] ?? 1) - (URGENCY_RANK[a.urgency] ?? 1) || due(a) - due(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export type EscalationRow = typeof recruiterEscalations.$inferSelect;
export type EscalationMessageRow = typeof escalationMessages.$inferSelect;

/**
 * One note on a request's thread (plan B5): from the team while a recruiter works on it, or from the recruiter holding
 * it. The caller has checked who may write and that the request belongs to their company. The event names the message,
 * never its words (they can name a candidate; the thread is where they live, and a deletion request rewrites them).
 */
export async function addEscalationReply(q: Queryable, input: { escalation: Pick<EscalationRow, "id" | "companyId">; side: EscalationMessageSide; author: Actor; body: string; now?: Date }): Promise<EscalationMessageRow> {
  const row = await insertMessage(q, { ...input, kind: "reply" });
  await emit(q, { type: input.side === "customer" ? "customer.replied" : "recruiter.replied", companyId: input.escalation.companyId, actor: input.author, subject: { type: "escalation", id: input.escalation.id }, payload: { messageId: row.id } });
  return row;
}

/** The recruiter's answer, kept on the thread as well as on the request, so a reopened request keeps every answer it was given. */
export async function recordEscalationAnswer(q: Queryable, input: { escalation: Pick<EscalationRow, "id" | "companyId">; author: Actor; body: string; now?: Date }): Promise<EscalationMessageRow> {
  return insertMessage(q, { ...input, side: "recruiter", kind: "answer" });
}

async function insertMessage(q: Queryable, input: { escalation: Pick<EscalationRow, "id" | "companyId">; side: EscalationMessageSide; kind: EscalationMessageKind; author: Actor; body: string; now?: Date }): Promise<EscalationMessageRow> {
  const [row] = await q
    .insert(escalationMessages)
    .values({ companyId: input.escalation.companyId, escalationId: input.escalation.id, side: input.side, kind: input.kind, author: input.author, body: input.body, createdAt: (input.now ?? new Date()).toISOString() })
    .returning();
  return row;
}

/**
 * "This didn't solve it" (plan B5). An answered request opens again with the team's reason on its thread and a reply-by
 * time counted afresh from now. The access given for the answered round ends, and fresh access is given and recorded
 * like any other: at once to the recruiter who answered, when they can take it back (they still hold an ITS role and
 * the company did not end their access to this request), or else to whoever picks it up from the queue. A request that
 * names no role or candidate and that nobody at the company chose to share goes back to the queue, where picking it up
 * grants nothing (as at claim). Runs on the platform side, scoped by the caller to the company: the tenant role cannot
 * write grants.
 */
export async function reopenEscalation(
  q: Queryable,
  input: { escalation: EscalationRow; actor: Actor; note: string; calendar: CalendarSource; now?: Date },
): Promise<{ status: "claimed" | "open"; slaDueAt: string; grant: StaffGrant | null; recruiter: { id: string; name: string; email: string } | null; messageId: string }> {
  const now = input.now ?? new Date();
  const e = input.escalation;
  const message = await insertMessage(q, { escalation: e, side: "customer", kind: "reopen", author: input.actor, body: input.note, now });
  const running = await q.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, e.id), isNull(staffAccessGrants.endedAt)));
  for (const g of running) await endStaffGrant(q, g, "resolved", now);
  const slaDueAt = escalationReplyBy(e.kind, now, input.calendar).toISOString();
  const recruiter = await recruiterWhoCanReturn(q, e);
  let grant: StaffGrant | null = null;
  if (recruiter) {
    grant = await grantStaffAccess(q, {
      userId: recruiter.id, userName: recruiter.name, companyId: e.companyId, kind: "escalation",
      scope: { escalationId: e.id, roleId: e.roleId, applicationId: e.applicationId },
      purpose: `${e.kind}: ${servedSummary(e) || "customer request"} Reopened by the team.`, grantedBy: input.actor, expiresAt: new Date(now.getTime() + ESCALATION_ACCESS_DAYS * 86_400_000), now,
    });
    await q.update(recruiterEscalations).set({ status: "claimed", resolvedAt: null, slaDueAt, accessExpiresAt: grant.expiresAt }).where(eq(recruiterEscalations.id, e.id));
  } else {
    await q.update(recruiterEscalations).set({ status: "open", assignedToUserId: null, resolvedAt: null, slaDueAt, accessExpiresAt: null }).where(eq(recruiterEscalations.id, e.id));
  }
  await emit(q, { type: "recruiter.reopened", companyId: e.companyId, actor: input.actor, subject: { type: "escalation", id: e.id }, payload: { messageId: message.id, slaDueAt, grantId: grant?.id ?? null, recruiterUserId: recruiter?.id ?? null, roleId: e.roleId, applicationId: e.applicationId } });
  return { status: recruiter ? "claimed" : "open", slaDueAt, grant, recruiter, messageId: message.id };
}

async function recruiterWhoCanReturn(q: Queryable, e: EscalationRow): Promise<{ id: string; name: string; email: string } | null> {
  if (!e.assignedToUserId) return null;
  // All of a company's hiring is shared only when someone at the company chose it (Q31), exactly as at claim.
  if (!e.roleId && !e.applicationId && e.requestedBy.kind !== "user") return null;
  const [u] = await q.select({ id: users.id, name: users.name, email: users.email, platformRole: users.platformRole }).from(users).where(eq(users.id, e.assignedToUserId)).limit(1);
  if (!u || !["its_recruiter", "platform_admin"].includes(u.platformRole)) return null;
  const removed = await q.select({ id: staffAccessGrants.id }).from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, e.id), eq(staffAccessGrants.userId, u.id), like(staffAccessGrants.revokeReason, "revoked by the customer:%"))).limit(1);
  if (removed.length) return null;
  return { id: u.id, name: u.name ?? u.email, email: u.email };
}

/**
 * A request's thread as the team reads it: the question, then every note, answer and reopening in order. A request
 * answered before the thread existed (migration 0029) shows its one answer. For the recruiter (`forRecruiter`), the
 * customer's side carries no names: the names of the company's team stay with the company, as the queue screen says.
 * A request nobody on the team raised says who did on its question (`raisedBy`: Recruiting OS on its own, or a
 * candidate), so neither side reads it as the customer asking (15 October 2026).
 */
export function escalationThread(
  e: Pick<EscalationRow, "id" | "question" | "createdAt" | "requestedBy" | "resolution" | "resolvedAt"> & Partial<Pick<EscalationRow, "kind" | "summary" | "roleId" | "applicationId">>,
  messages: ReadonlyArray<Pick<EscalationMessageRow, "id" | "side" | "kind" | "author" | "body" | "createdAt">>,
  recruiterName: string | null,
  opts: { forRecruiter?: boolean } = {},
): EscalationThreadEntry[] {
  const named = (side: EscalationThreadEntry["side"], name: string | null | undefined) => (opts.forRecruiter && side === "customer" ? null : name ?? null);
  const askedBy = e.requestedBy.kind === "recruiter" ? "recruiter" : "customer";
  const asker = e.requestedBy.kind === "user" || e.requestedBy.kind === "recruiter" ? named(askedBy, e.requestedBy.name) : null;
  const origin = requestOrigin({ kind: e.kind ?? "", summary: e.summary ?? "", requestedBy: e.requestedBy, roleId: e.roleId ?? null, applicationId: e.applicationId ?? null });
  const question: EscalationThreadEntry = { id: `${e.id}:question`, side: askedBy, kind: "question", body: e.question, by: asker, at: e.createdAt };
  if (origin === "system" || origin === "candidate") question.raisedBy = origin;
  const out: EscalationThreadEntry[] = [question];
  const ordered = [...messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  for (const m of ordered) out.push({ id: m.id, side: m.side, kind: m.kind, body: m.body, by: named(m.side, m.author.name), at: m.createdAt });
  if (e.resolution && !ordered.some((m) => m.kind === "answer")) out.push({ id: `${e.id}:answer`, side: "recruiter", kind: "answer", body: e.resolution, by: recruiterName, at: e.resolvedAt ?? e.createdAt });
  return out;
}

export async function buildEscalationContext(q: Queryable, companyId: string, roleId: string | null, applicationId: string | null, intakeSessionId: string | null = null): Promise<Record<string, unknown>> {
  const [company] = await q.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const ctx: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    company: company ? { id: company.id, name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, locations: company.locations } : null,
  };
  if (intakeSessionId) {
    // The draft the request is about: who started it, the whole conversation, what is known, and the draft beside it.
    const [s] = await q.select().from(intakeSessions).where(and(eq(intakeSessions.id, intakeSessionId), eq(intakeSessions.companyId, companyId))).limit(1);
    ctx.intakeSession = s ? { id: s.id, status: s.status, startedBy: s.createdBy.name ?? null, messages: s.messages, facts: s.facts, missingFacts: s.missingFacts, draftPacket: s.draftPacket ?? null, createdAt: s.createdAt, updatedAt: s.updatedAt } : null;
  }
  if (roleId) {
    const [role] = await q.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    const packet = role?.currentPacketVersion
      ? (await q.select().from(rolePackets).where(eq(rolePackets.roleId, roleId)).orderBy(desc(rolePackets.version)).limit(1))[0]
      : null;
    ctx.role = role ? { id: role.id, title: role.title, status: role.status, openedAt: role.openedAt, currentPacketVersion: role.currentPacketVersion } : null;
    ctx.packet = packet ? { version: packet.version, status: packet.status, packet: packet.packet } : null;
  }
  if (applicationId) {
    const [app] = await q.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
    if (app) {
      const [cand] = await q.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
      const docs = await q.select().from(documents).where(eq(documents.applicationId, applicationId));
      const asmts = await q.select().from(assessments).where(eq(assessments.applicationId, applicationId)).orderBy(desc(assessments.createdAt));
      const scr = await q.select().from(screens).where(eq(screens.applicationId, applicationId));
      const ivs = await q.select().from(interviews).where(eq(interviews.applicationId, applicationId));
      const cards = await q.select().from(scorecards).where(eq(scorecards.applicationId, applicationId));
      const comms = await q.select().from(communications).where(eq(communications.applicationId, applicationId)).orderBy(desc(communications.createdAt)).limit(50);
      const evs = await q.select().from(events).where(eq(events.subjectId, applicationId)).orderBy(desc(events.occurredAt)).limit(100);
      ctx.application = { id: app.id, stage: app.stage, source: app.source, packetVersion: app.packetVersion, answers: app.answers, eligibility: app.eligibility };
      ctx.candidate = cand ? { id: cand.id, name: `${cand.firstName} ${cand.lastName}`, email: cand.email, phone: cand.phone, locationText: cand.locationText, consent: cand.consent, preferences: cand.preferences } : null;
      ctx.resumeText = docs.find((d) => d.kind === "resume")?.textExtracted ?? null;
      // "Hide them until they send" (9 October 2026): the recruiter reads what the team may read. A conversation the
      // candidate has not sent (or never will) shows a recruiter's call notes alone, with no reading built on it and
      // none of the messages they typed in it; nor does the history say a reading of it was written.
      const hiddenReadings = unsentScreenReadings(scr, asmts);
      ctx.assessments = asmts.filter((a) => !hiddenReadings.has(a.id)).map((a) => ({ kind: a.kind, overall: a.overall, confidence: a.confidence, result: a.result, createdAt: a.createdAt }));
      ctx.screens = scr.map(teamScreenView).map((s) => ({ channel: s.channel, status: s.status, transcript: s.transcript, answers: screenAnswersOf(s), answersShared: s.answersShared }));
      ctx.interviews = ivs.map((i) => ({ roundKey: i.roundKey, title: i.title, status: i.status, startsAt: i.startsAt }));
      ctx.scorecards = cards.map((c) => ({ interviewId: c.interviewId, status: c.status, entries: c.entries, recommendation: c.recommendation }));
      ctx.communications = withoutUnsentConversation(comms, scr).map((c) => ({ direction: c.direction, channel: c.channel, subject: c.subject, body: c.bodyText, status: c.status, at: c.createdAt }));
      ctx.timeline = withoutUnsentScreenEvents(evs, scr, hiddenReadings).map((e) => ({ type: e.type, at: e.occurredAt, actor: e.actor, payload: e.payload }));
    }
  }
  return ctx;
}

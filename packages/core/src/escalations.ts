import { and, desc, eq, isNull, like } from "drizzle-orm";
import type { Actor, EscalationThreadEntry } from "@ros/contracts";
import {
  applications, assessments, candidates, communications, companies, documents, escalationMessages, events, intakeSessions, interviews, recruiterEscalations,
  rolePackets, roles, scorecards, screens, staffAccessGrants, users, type EscalationMessageKind, type EscalationMessageSide, type Queryable,
} from "@ros/db";
import { emit } from "./events";
import { escalationReplyBy, type CalendarSource } from "./business-hours";
import { loadBusinessCalendar } from "./business-calendar";
import { ESCALATION_ACCESS_DAYS, endStaffGrant, grantStaffAccess, type StaffGrant } from "./staff-access";
import { defaultUrgency, genericSummary, requiredExpertise, type EscalationUrgency } from "./escalation-preview";
import { screenAnswersOf } from "./screen-answers";

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
  return { id: row.id, slaDueAt };
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
      purpose: `${e.kind}: ${e.summary || "customer request"} Reopened by the team.`, grantedBy: input.actor, expiresAt: new Date(now.getTime() + ESCALATION_ACCESS_DAYS * 86_400_000), now,
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
 */
export function escalationThread(
  e: Pick<EscalationRow, "id" | "question" | "createdAt" | "requestedBy" | "resolution" | "resolvedAt">,
  messages: ReadonlyArray<Pick<EscalationMessageRow, "id" | "side" | "kind" | "author" | "body" | "createdAt">>,
  recruiterName: string | null,
  opts: { forRecruiter?: boolean } = {},
): EscalationThreadEntry[] {
  const named = (side: EscalationThreadEntry["side"], name: string | null | undefined) => (opts.forRecruiter && side === "customer" ? null : name ?? null);
  const askedBy = e.requestedBy.kind === "recruiter" ? "recruiter" : "customer";
  const asker = e.requestedBy.kind === "user" || e.requestedBy.kind === "recruiter" ? named(askedBy, e.requestedBy.name) : null;
  const out: EscalationThreadEntry[] = [{ id: `${e.id}:question`, side: askedBy, kind: "question", body: e.question, by: asker, at: e.createdAt }];
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
      ctx.assessments = asmts.map((a) => ({ kind: a.kind, overall: a.overall, confidence: a.confidence, result: a.result, createdAt: a.createdAt }));
      ctx.screens = scr.map((s) => ({ channel: s.channel, status: s.status, transcript: s.transcript, answers: screenAnswersOf(s) }));
      ctx.interviews = ivs.map((i) => ({ roundKey: i.roundKey, title: i.title, status: i.status, startsAt: i.startsAt }));
      ctx.scorecards = cards.map((c) => ({ interviewId: c.interviewId, status: c.status, entries: c.entries, recommendation: c.recommendation }));
      ctx.communications = comms.map((c) => ({ direction: c.direction, channel: c.channel, subject: c.subject, body: c.bodyText, status: c.status, at: c.createdAt }));
      ctx.timeline = evs.map((e) => ({ type: e.type, at: e.occurredAt, actor: e.actor, payload: e.payload }));
    }
  }
  return ctx;
}

import { desc, eq } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import {
  applications, assessments, candidates, communications, companies, documents, events, interviews, recruiterEscalations,
  rolePackets, roles, scorecards, screens, type Queryable,
} from "@ros/db";
import { emit } from "./events";
import { addBusinessHours, slaBusinessHours } from "./business-hours";
import { loadBusinessCalendar } from "./business-calendar";
import { defaultUrgency, genericSummary, requiredExpertise, type EscalationUrgency } from "./escalation-preview";

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
  },
): Promise<{ id: string; slaDueAt: string }> {
  const now = input.now ?? new Date();
  const snapshot = await buildEscalationContext(q, input.companyId, input.roleId ?? null, input.applicationId ?? null);
  // Founder decision F12: SLAs count business hours on the ITS calendar (correction 12: the calendar is editable and versioned).
  const calendar = await loadBusinessCalendar(q, now);
  const slaDueAt = addBusinessHours(now, slaBusinessHours(input.kind), calendar).toISOString();
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
      summary: genericSummary(input.kind, { hasRole: !!input.roleId, hasApplication: !!input.applicationId, origin: input.summaryOrigin ?? (input.requestedBy.kind === "system" ? "system" : input.requestedBy.kind === "candidate" ? "candidate" : "customer") }),
      requestedBy: input.requestedBy,
      contextSnapshot: snapshot,
      slaDueAt,
    })
    .returning({ id: recruiterEscalations.id });
  await emit(q, {
    type: "recruiter.requested",
    companyId: input.companyId,
    actor: input.requestedBy,
    subject: { type: "escalation", id: row.id },
    payload: { kind: input.kind, roleId: input.roleId ?? null, applicationId: input.applicationId ?? null },
    correlationId: input.workflowRunId ?? null,
  });
  return { id: row.id, slaDueAt };
}

export async function buildEscalationContext(q: Queryable, companyId: string, roleId: string | null, applicationId: string | null): Promise<Record<string, unknown>> {
  const [company] = await q.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const ctx: Record<string, unknown> = {
    capturedAt: new Date().toISOString(),
    company: company ? { id: company.id, name: company.name, vertical: company.vertical, sizeBand: company.sizeBand, locations: company.locations } : null,
  };
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
      ctx.screens = scr.map((s) => ({ channel: s.channel, status: s.status, transcript: s.transcript, answers: s.answers }));
      ctx.interviews = ivs.map((i) => ({ roundKey: i.roundKey, title: i.title, status: i.status, startsAt: i.startsAt }));
      ctx.scorecards = cards.map((c) => ({ interviewId: c.interviewId, status: c.status, entries: c.entries, recommendation: c.recommendation }));
      ctx.communications = comms.map((c) => ({ direction: c.direction, channel: c.channel, subject: c.subject, body: c.bodyText, status: c.status, at: c.createdAt }));
      ctx.timeline = evs.map((e) => ({ type: e.type, at: e.occurredAt, actor: e.actor, payload: e.payload }));
    }
  }
  return ctx;
}

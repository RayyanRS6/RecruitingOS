import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, isNull, like } from "drizzle-orm";
import { CreateEscalation, DecideApproval, ResolveEscalation } from "@ros/contracts";
import { ESCALATION_ACCESS_DAYS, activeStaffGrant, assertCan, audit, businessMinutesBetween, createEscalation, describeHours, emit, endStaffGrant, grantStaffAccess, limitGrantAfterResolution, loadBusinessCalendar, notify, recordStaffAccess, toEscalationPreview, transition, type EscalationPreview } from "@ros/core";
import { applications, approvalRequests, companies, events, recruiterEscalations, roles, staffAccessGrants, withPlatform, withTenant } from "@ros/db";
import { actorOf, clientIp, requireRecruiterOrAdmin, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { composeBrief } from "../services/brief";

export const approvalRoutes = new Hono<Vars>();

approvalRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const status = c.req.query("status") ?? "pending";
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, t.companyId), eq(approvalRequests.status, status))).orderBy(desc(approvalRequests.createdAt)));
  return c.json(rows);
});

approvalRoutes.post("/:id/decide", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = DecideApproval.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [req] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, c.req.param("id"))).limit(1);
    if (!req) throw new HttpError(404, "not_found", "Approval request not found.");
    if (req.status !== "pending") throw new HttpError(409, "decided", `This request is already ${req.status}.`);
    if (!req.requiredRoles.includes(t.role)) throw new HttpError(403, "forbidden", `This decision needs one of: ${req.requiredRoles.join(", ")}.`);
    const status = body.decision === "approve" ? "approved" : "rejected";
    await tx.update(approvalRequests).set({ status, decidedBy: t.userId, decidedAt: new Date().toISOString(), decisionNote: body.note ?? null, decisionEdits: body.edits ?? null }).where(eq(approvalRequests.id, req.id));
    await emit(tx, { type: body.decision === "approve" ? "approval.granted" : "approval.denied", companyId: t.companyId, actor: actorOf(c), subject: { type: "approval_request", id: req.id }, payload: { actionType: req.actionType, note: body.note ?? null }, correlationId: req.workflowRunId });
    await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${req.id}`, payload: { decision: status } });
    if (status === "approved" && req.applicationId) {
      const [app] = await tx.select().from(applications).where(eq(applications.id, req.applicationId)).limit(1);
      if (app && req.actionType === "application.invite_screen") {
        await container.engine.start(tx, { workflowKey: "screen", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId, invitedBy: t.userId }, idempotencyKey: `screen:${app.id}`, actor: actorOf(c) });
      }
      if (app && req.actionType === "application.recommend_interview" && app.stage === "screen_complete") {
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by: t.role, actor: actorOf(c), reason: body.note ?? "approved the recommendation" });
        await emit(tx, { type: "candidate.recommended", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { by: "approval", approvalRequestId: req.id } });
      }
    }
    return { ok: true, status };
  });
  await container.kick();
  return c.json(result);
});

export const escalationRoutes = new Hono<Vars>();

/** "Bring in a recruiter." The customer's request; the SLA counts business hours (founder decision F12). */
escalationRoutes.post("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "escalation.create");
  const body = CreateEscalation.parse(await c.req.json());
  const container = c.get("container");
  const { created, preview, hours, timeZone } = await withTenant(container.db, t.companyId, async (tx) => {
    const created = await createEscalation(tx, { companyId: t.companyId, roleId: body.roleId ?? null, applicationId: body.applicationId ?? null, kind: body.kind, question: body.question, requestedBy: actorOf(c), urgency: body.urgency });
    const [row] = await tx.select({ urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary }).from(recruiterEscalations).where(eq(recruiterEscalations.id, created.id)).limit(1);
    const calendar = await loadBusinessCalendar(tx);
    return { created, preview: row, hours: describeHours(calendar), timeZone: calendar.timeZone };
  });
  // The queue notification is pre-acceptance context (correction 11): category, urgency, expertise and the generic summary. Never the customer's words.
  await container.integrations.email.send({
    to: container.env.ITS_QUEUE_EMAIL,
    from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
    subject: `[${body.kind}] ${preview.urgency} urgency: respond by ${new Date(created.slaDueAt).toLocaleString("en-US", { timeZone })} (${timeZone})`,
    text: `A customer asked for a recruiter.\n\nCategory: ${body.kind}\nUrgency: ${preview.urgency}\nNeeds: ${preview.requiredExpertise}\nSummary: ${preview.summary}\n\nAccept it in the queue to open the full request: ${container.env.WEB_BASE_URL}/recruiter/queue/${created.id}`,
    idempotencyKey: `escalation:${created.id}`,
    tags: { template: "escalation" },
  });
  const due = new Date(created.slaDueAt);
  return c.json({ id: created.id, slaDueAt: created.slaDueAt, message: `A recruiter has everything about this role and candidate and will respond by ${due.toLocaleString("en-US", { timeZone, weekday: "long", hour: "numeric", minute: "2-digit" })} (business hours are ${hours}).` }, 201);
});

/** The customer's own requests, with who is on them and when their access ends. */
escalationRoutes.get("/mine", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) =>
    tx.select({ id: recruiterEscalations.id, kind: recruiterEscalations.kind, status: recruiterEscalations.status, urgency: recruiterEscalations.urgency, summary: recruiterEscalations.summary, question: recruiterEscalations.question, createdAt: recruiterEscalations.createdAt, resolution: recruiterEscalations.resolution, slaDueAt: recruiterEscalations.slaDueAt, firstResponseAt: recruiterEscalations.firstResponseAt, accessExpiresAt: recruiterEscalations.accessExpiresAt })
      .from(recruiterEscalations).where(eq(recruiterEscalations.companyId, t.companyId)).orderBy(desc(recruiterEscalations.createdAt)),
  );
  return c.json(rows);
});

const PREVIEW_COLUMNS = {
  id: recruiterEscalations.id, companyId: recruiterEscalations.companyId, companyName: companies.name, roleTitle: roles.title, kind: recruiterEscalations.kind, status: recruiterEscalations.status,
  urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary, slaDueAt: recruiterEscalations.slaDueAt,
  createdAt: recruiterEscalations.createdAt, assignedToUserId: recruiterEscalations.assignedToUserId,
};
type PreviewRow = { id: string; companyId: string; companyName: string; roleTitle: string | null; kind: string; status: string; urgency: string; requiredExpertise: string; summary: string; slaDueAt: string | null; createdAt: string; assignedToUserId: string | null };

/**
 * The ITS queue (founder decision F10, D24; correction 11 of 18 September 2026). Before a recruiter accepts an
 * assignment they see only: customer name, role title, category, urgency, required expertise, remaining service-level
 * time, and a generic summary. Never the customer's words, never anything from a candidate record. Every preview view is
 * audited for the customer. The full context opens after claim, under a grant.
 */
async function previewRows(c: Context<Vars>, rows: PreviewRow[], reason: string): Promise<EscalationPreview[]> {
  const s = c.get("session")!;
  const now = new Date();
  const container = c.get("container");
  const calendar = await loadBusinessCalendar(container.db, now);
  const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  const byCompany = new Map<string, string[]>();
  for (const r of rows) byCompany.set(r.companyId, [...(byCompany.get(r.companyId) ?? []), r.id]);
  for (const [companyId, ids] of byCompany) {
    await audit(container.db, { companyId, actor, action: "escalation.preview_viewed", reason, ip: clientIp(c), details: { escalationIds: ids, fields: "preview" } });
  }
  return rows.map((r) => toEscalationPreview({ ...r, viewerUserId: s.user.id, now, businessMinutesRemaining: r.slaDueAt ? businessMinutesBetween(now, new Date(r.slaDueAt), calendar) : null }));
}

escalationRoutes.get("/", requireRecruiterOrAdmin, async (c) => {
  const status = c.req.query("status");
  const rows = await withPlatform(c.get("container").db, (tx) =>
    tx.select(PREVIEW_COLUMNS)
      .from(recruiterEscalations)
      .innerJoin(companies, eq(companies.id, recruiterEscalations.companyId))
      .leftJoin(roles, eq(roles.id, recruiterEscalations.roleId))
      .where(status ? eq(recruiterEscalations.status, status) : inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"]))
      .orderBy(recruiterEscalations.slaDueAt),
  );
  return c.json(await previewRows(c, rows, "recruiter queue list"));
});

escalationRoutes.get("/:id", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) return null;
    const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, e.companyId)).limit(1);
    const role = e.roleId ? (await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, e.roleId)).limit(1))[0] : null;
    const previewRow: PreviewRow = { id: e.id, companyId: e.companyId, companyName: co?.name ?? "", roleTitle: role?.title ?? null, kind: e.kind, status: e.status, urgency: e.urgency, requiredExpertise: e.requiredExpertise, summary: e.summary, slaDueAt: e.slaDueAt, createdAt: e.createdAt, assignedToUserId: e.assignedToUserId };
    if (e.assignedToUserId !== s.user.id) return { previewRow, full: null as null | Record<string, unknown>, why: e.assignedToUserId ? "claimed by another recruiter" : "claim it to open the full context" };
    const grant = await activeStaffGrant(tx, s.user.id, e.companyId);
    if (!grant) return { previewRow, full: null as null | Record<string, unknown>, why: "your access to this customer has ended" };
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    await audit(tx, { companyId: e.companyId, actor, action: "escalation.context_viewed", target: { type: "escalation", id: e.id }, reason: "recruiter queue", details: { grantId: grant.id, expiresAt: grant.expiresAt } });
    await recordStaffAccess(tx, { grant, userName: actor.name, method: "GET", path: `/api/v1/escalations/${e.id}`, ip: clientIp(c) });
    const full = { companyId: e.companyId, roleId: e.roleId, applicationId: e.applicationId, firstResponseAt: e.firstResponseAt, accessExpiresAt: e.accessExpiresAt, resolution: e.resolution, resolvedAt: e.resolvedAt, minutesSpent: e.minutesSpent, question: e.question, contextSnapshot: e.contextSnapshot, grant: { id: grant.id, purpose: grant.purpose, expiresAt: grant.expiresAt, scope: { roleId: grant.roleId, applicationId: grant.applicationId } } };
    return { previewRow, full, why: null as string | null };
  });
  if (!row) throw new HttpError(404, "not_found", "Escalation not found.");
  if (!row.full) {
    const [preview] = await previewRows(c, [row.previewRow], "recruiter queue detail");
    return c.json({ ...preview, accessGranted: false, why: row.why });
  }
  const now = new Date();
  const calendar = await loadBusinessCalendar(container.db, now);
  const preview = toEscalationPreview({ ...row.previewRow, viewerUserId: s.user.id, now, businessMinutesRemaining: row.previewRow.slaDueAt ? businessMinutesBetween(now, new Date(row.previewRow.slaDueAt), calendar) : null });
  return c.json({ ...preview, ...row.full, accessGranted: true });
});

/** Accepting the assignment creates the scoped, time-limited grant and starts the response clock. */
escalationRoutes.post("/:id/claim", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const now = new Date();
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.status === "resolved" || e.status === "cancelled") throw new HttpError(409, "closed", `This request is already ${e.status}.`);
    if (e.assignedToUserId && e.assignedToUserId !== s.user.id) throw new HttpError(409, "claimed", "Another recruiter has this request.");
    // 21 Sep, item 1: when the customer ended this recruiter's access to this request, the same recruiter cannot take it back.
    const removedByCustomer = await tx.select({ id: staffAccessGrants.id }).from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, e.id), eq(staffAccessGrants.userId, s.user.id), like(staffAccessGrants.revokeReason, "revoked by the customer:%"))).limit(1);
    if (removedByCustomer.length) throw new HttpError(403, "revoked_by_customer", "The customer ended your access to this request. Another recruiter must take it.");
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    const existing = await activeStaffGrant(tx, s.user.id, e.companyId, now);
    const grant = existing && existing.escalationId === e.id ? existing : await grantStaffAccess(tx, {
      userId: s.user.id, userName: actor.name, companyId: e.companyId, kind: "escalation",
      scope: { escalationId: e.id, roleId: e.roleId, applicationId: e.applicationId },
      purpose: `${e.kind}: ${e.summary || "customer request"}`, grantedBy: actor, expiresAt: new Date(now.getTime() + ESCALATION_ACCESS_DAYS * 86_400_000), now,
    });
    const [u] = await tx.update(recruiterEscalations).set({ status: "claimed", assignedToUserId: s.user.id, claimedAt: e.claimedAt ?? now.toISOString(), firstResponseAt: e.firstResponseAt ?? now.toISOString(), accessExpiresAt: grant.expiresAt }).where(eq(recruiterEscalations.id, e.id)).returning();
    await emit(tx, { type: "recruiter.claimed", companyId: e.companyId, actor, subject: { type: "escalation", id: e.id }, payload: { grantId: grant.id, expiresAt: grant.expiresAt } });
    await notify(tx, { companyId: e.companyId, kind: "recruiter.claimed", title: `${actor.name} (ITS recruiter) picked up your request`, body: `They can see this role and candidate until ${new Date(grant.expiresAt).toLocaleDateString()}; every page they open is recorded in your activity.`, action: { label: "See requests", href: "/" } });
    return { escalation: u, grant: { id: grant.id, purpose: grant.purpose, expiresAt: grant.expiresAt, scope: { roleId: grant.roleId, applicationId: grant.applicationId } } };
  });
  return c.json(row);
});

/** Resolution records the recruiter's effort and shortens the grant to a day after resolution. */
escalationRoutes.post("/:id/resolve", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const body = ResolveEscalation.parse(await c.req.json());
  const container = c.get("container");
  const now = new Date();
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.assignedToUserId !== s.user.id && s.user.platformRole !== "platform_admin") throw new HttpError(403, "not_assigned", "Claim the request before resolving it.");
    const accessUntil = await limitGrantAfterResolution(tx, e.id, now);
    const [u] = await tx.update(recruiterEscalations).set({ status: "resolved", resolvedAt: now.toISOString(), resolution: body.resolution, minutesSpent: body.minutesSpent ?? e.minutesSpent ?? null, firstResponseAt: e.firstResponseAt ?? now.toISOString(), accessExpiresAt: accessUntil ?? e.accessExpiresAt }).where(eq(recruiterEscalations.id, e.id)).returning();
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    await emit(tx, { type: "recruiter.resolved", companyId: e.companyId, actor, subject: { type: "escalation", id: e.id }, payload: { resolution: body.resolution, minutesSpent: body.minutesSpent ?? null, responseMinutes: e.firstResponseAt ? Math.round((Date.parse(e.firstResponseAt) - Date.parse(e.createdAt)) / 60_000) : null } });
    await notify(tx, { companyId: e.companyId, kind: "recruiter.resolved", title: `${actor.name} (ITS recruiter) responded`, body: body.resolution.slice(0, 300), action: { label: "See requests", href: "/" } });
    await container.engine.signal(tx, { companyId: e.companyId, key: `escalation:${e.id}`, payload: { resolved: true } });
    return u;
  });
  await container.kick();
  return c.json(row);
});

/** Handing a request back to the queue ends the recruiter's access immediately. */
escalationRoutes.post("/:id/release", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const now = new Date();
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.assignedToUserId !== s.user.id && s.user.platformRole !== "platform_admin") throw new HttpError(403, "not_assigned", "Only the assigned recruiter can release this request.");
    const grants = await tx.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, e.id), isNull(staffAccessGrants.endedAt)));
    for (const g of grants) await endStaffGrant(tx, g, "released", now);
    const [u] = await tx.update(recruiterEscalations).set({ status: e.status === "resolved" ? "resolved" : "open", assignedToUserId: null, accessExpiresAt: now.toISOString() }).where(eq(recruiterEscalations.id, e.id)).returning();
    return u;
  });
  return c.json(row);
});

export const eventRoutes = new Hono<Vars>();

eventRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "events.read");
  const subjectType = c.req.query("subjectType");
  const subjectId = c.req.query("subjectId");
  const type = c.req.query("type");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => {
    const conds = [eq(events.companyId, t.companyId)];
    if (subjectType) conds.push(eq(events.subjectType, subjectType));
    if (subjectId) conds.push(eq(events.subjectId, subjectId));
    if (type) conds.push(eq(events.type, type));
    return tx.select().from(events).where(and(...conds)).orderBy(desc(events.occurredAt)).limit(200);
  });
  return c.json(rows);
});

export const briefRoutes = new Hono<Vars>();

briefRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const brief = await withTenant(c.get("container").db, t.companyId, (tx) => composeBrief(tx, t.companyId));
  return c.json(brief);
});

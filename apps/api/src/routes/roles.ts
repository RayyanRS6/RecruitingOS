import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { ApproveRole, CreatePacketVersion, RoleStatusChange, ApplicationAction, OwnerGroupQuery, FlagAssessment, RecordApplicationOutcome, RecordRoleOutcome } from "@ros/contracts";
import { OUTCOME_STATEMENT, OutcomeError, STAGE_LABEL, assertCan, audit, emit, gate, listOutcomes, openEscalationsFor, ownerGroup, recordApplicationOutcome, recordRoleOutcome, transition } from "@ros/core";
import { users } from "@ros/db";
import { sendDisposition } from "@ros/agents";
import { aiRuns, applications, approvalRequests, assessments, candidates, communications, companies, documents, events, interviews, postings, rolePackets, roles, screens, withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, clientIp, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { DOWNLOAD_URL_TTL_SECONDS, safeFilename } from "../uploads";
import type { Container } from "../container";

/** Founder decision (correction 6): candidate-facing decline communication only after the human decision is recorded. */
async function sendDeclineAfterHumanDecision(tx: Parameters<Parameters<typeof withTenant>[2]>[0], container: Container, input: { companyId: string; app: typeof applications.$inferSelect; actor: ReturnType<typeof actorOf>; reason: string }): Promise<boolean> {
  const { companyId, app, actor, reason } = input;
  const d = await gate(tx, { companyId, roleId: app.roleId, applicationId: app.id, actionType: "disposition.send", subject: { type: "application", id: app.id }, proposal: { reason }, requestedBy: actor });
  if (d.outcome !== "execute") return false;
  const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!cand || !role || !company || !pv) return false;
  const res = await sendDisposition(tx, container.integrations, { application: app, candidate: cand, role, company, packet: pv.packet, actor, reason: reason === "eligibility" ? "eligibility" : "human" });
  return res.status === "sent" || res.status === "pending";
}

export const roleRoutes = new Hono<Vars>();
roleRoutes.use("/:id", roleScopeGuard);
roleRoutes.use("/:id/*", roleScopeGuard);

roleRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const status = c.req.query("status");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const list = await tx.select().from(roles).where(status ? and(eq(roles.companyId, t.companyId), eq(roles.status, status)) : eq(roles.companyId, t.companyId)).orderBy(desc(roles.createdAt));
    const out = [];
    for (const r of t.staff?.scope.roleId ? list.filter((x) => x.id === t.staff!.scope.roleId) : list) {
      const apps = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.roleId, r.id));
      const counts: Record<string, number> = {};
      for (const a of apps) counts[ownerGroup(a.stage)] = (counts[ownerGroup(a.stage)] ?? 0) + 1;
      const pending = await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(and(eq(approvalRequests.roleId, r.id), eq(approvalRequests.status, "pending")));
      out.push({ ...r, counts: { total: apps.length, ...counts }, needsYou: pending.length, daysOpen: r.openedAt ? Math.floor((Date.now() - Date.parse(r.openedAt)) / 86_400_000) : null });
    }
    return out;
  });
  return c.json(rows);
});

roleRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const canSeeComp = ["owner", "admin", "hiring_manager", "hr", "recruiter"].includes(t.role);
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) return null;
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const current = packets.find((p) => p.version === (role.currentPacketVersion ?? packets[0]?.version)) ?? packets[0] ?? null;
    const posts = await tx.select().from(postings).where(eq(postings.roleId, role.id));
    const apps = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.roleId, role.id));
    const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.status, "pending")));
    const counts: Record<string, number> = {};
    for (const a of apps) counts[a.stage] = (counts[a.stage] ?? 0) + 1;
    const redact = (p: typeof current) => (p && !canSeeComp ? { ...p, packet: { ...p.packet, compensation: { ...p.packet.compensation, min: 0, max: 0, mid: 0, ceiling: 0 } } } : p);
    return { ...role, currentPacket: redact(current), packetVersions: packets.map((p) => ({ id: p.id, version: p.version, status: p.status, source: p.source, changeSummary: p.changeSummary, createdAt: p.createdAt, createdBy: p.createdBy })), postings: posts, counts, pendingApprovals: pending };
  });
  if (!row) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(row);
});

roleRoutes.get("/:id/packets", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(rolePackets).where(eq(rolePackets.roleId, c.req.param("id"))).orderBy(desc(rolePackets.version)));
  return c.json(rows);
});

/** A human edit creates a new version; nothing is overwritten. If the role is open, the new version becomes current and postings refresh. */
roleRoutes.post("/:id/packets", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = CreatePacketVersion.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const versions = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const next = (versions[0]?.version ?? 0) + 1;
    const [pv] = await tx.insert(rolePackets).values({ companyId: t.companyId, roleId: role.id, version: next, packet: body.packet, status: role.status === "open" ? "approved" : "proposed", source: "human_edit", changeSummary: body.changeSummary, createdBy: actorOf(c), approvedBy: role.status === "open" ? t.userId : null, approvedAt: role.status === "open" ? new Date().toISOString() : null }).returning();
    await emit(tx, { type: "role_packet.edited", companyId: t.companyId, actor: actorOf(c), subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { version: next, changeSummary: body.changeSummary } });
    if (role.status === "open") {
      for (const v of versions) if (v.status === "approved") await tx.update(rolePackets).set({ status: "superseded" }).where(eq(rolePackets.id, v.id));
      await tx.update(roles).set({ currentPacketVersion: next, title: body.packet.identity.title }).where(eq(roles.id, role.id));
      await emit(tx, { type: "role_packet.approved", companyId: t.companyId, actor: actorOf(c), subject: { type: "role_packet", id: `${role.id}:${next}` }, payload: { version: next, via: "edit_while_open" } });
    } else if (role.status === "pending_approval") {
      // Cancel the pending approval for the older version and request approval for the new one.
      const pend = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.status, "pending")));
      for (const p of pend) await tx.update(approvalRequests).set({ status: "cancelled", decisionNote: `superseded by version ${next}` }).where(eq(approvalRequests.id, p.id));
      await tx.update(roles).set({ title: body.packet.identity.title }).where(eq(roles.id, role.id));
      await container.engine.start(tx, { workflowKey: "role_approval", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: next }, idempotencyKey: `role_approval:${role.id}:${next}`, actor: actorOf(c) });
    }
    return pv;
  });
  await container.kick();
  return c.json(result, 201);
});

/** Approving resolves the pending approval request; the role_approval workflow opens and publishes the role. */
roleRoutes.post("/:id/approve", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.approve");
  const body = ApproveRole.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const [req] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending"))).limit(1);
    if (!req) throw new HttpError(409, "nothing_pending", "There is no pending approval for this role.");
    const proposedVersion = Number((req.proposal as { version?: number }).version);
    if (proposedVersion !== body.version) throw new HttpError(409, "version_mismatch", `The pending approval is for version ${proposedVersion}.`);
    if (!req.requiredRoles.includes(t.role)) throw new HttpError(403, "forbidden", `This approval needs one of: ${req.requiredRoles.join(", ")}.`);
    await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: new Date().toISOString(), decisionNote: body.note ?? null }).where(eq(approvalRequests.id, req.id));
    await tx.update(rolePackets).set({ approvedBy: t.userId, approvedAt: new Date().toISOString() }).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, body.version)));
    await emit(tx, { type: "approval.granted", companyId: t.companyId, actor: actorOf(c), subject: { type: "approval_request", id: req.id }, payload: { actionType: req.actionType, note: body.note ?? null }, correlationId: req.workflowRunId });
    await emit(tx, { type: "role.approved", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { version: body.version } });
    await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${req.id}`, payload: { decision: "approved" } });
    return { ok: true, approvalRequestId: req.id };
  });
  await container.kick();
  return c.json(result);
});

// Closing a role records its outcome through POST /:id/outcome (21 Sep, item 4); the old unconfirmed close is gone.
for (const action of ["pause", "resume"] as const) {
  roleRoutes.post(`/:id/${action}`, requireTenant, async (c) => {
    const t = c.get("tenant")!;
    assertCan(t.role, "role.manage");
    const body = RoleStatusChange.parse(await c.req.json().catch(() => ({})));
    const container = c.get("container");
    const row = await withTenant(container.db, t.companyId, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
      if (!role) throw new HttpError(404, "not_found", "Role not found.");
      const now = new Date().toISOString();
      const patch = action === "pause" ? { status: "paused", pausedAt: now } : { status: "open", pausedAt: null };
      const [updated] = await tx.update(roles).set(patch).where(eq(roles.id, role.id)).returning();
      await emit(tx, { type: action === "pause" ? "role.paused" : "role.resumed", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { reason: body.reason ?? null } });
      if (action === "resume") await container.engine.start(tx, { workflowKey: "publish_role", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: role.currentPacketVersion }, actor: actorOf(c) });
      return updated;
    });
    await container.kick();
    return c.json(row);
  });
}

roleRoutes.get("/:id/postings", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(postings).where(eq(postings.roleId, c.req.param("id"))));
  return c.json(rows);
});

roleRoutes.post("/:id/postings/:channel/retry", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const container = c.get("container");
  await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role || role.status !== "open") throw new HttpError(409, "not_open", "The role must be open to post.");
    await tx.update(postings).set({ status: "pending", error: null }).where(and(eq(postings.roleId, role.id), eq(postings.channel, c.req.param("channel"))));
    await container.engine.start(tx, { workflowKey: "publish_role", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: role.currentPacketVersion }, actor: actorOf(c) });
  });
  await container.kick();
  return c.json({ ok: true });
});

roleRoutes.get("/:id/applications", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const q = OwnerGroupQuery.parse({ group: c.req.query("group"), stage: c.req.query("stage") });
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const apps = (await tx.select().from(applications).where(eq(applications.roleId, c.req.param("id"))).orderBy(desc(applications.createdAt))).filter((a) => !t.staff?.scope.applicationId || a.id === t.staff.scope.applicationId);
    const ids = apps.map((a) => a.candidateId);
    const cands = ids.length ? await tx.select().from(candidates).where(inArray(candidates.id, ids)) : [];
    const latest = apps.filter((a) => a.latestAssessmentId).map((a) => a.latestAssessmentId!);
    const asmts = latest.length ? await tx.select().from(assessments).where(inArray(assessments.id, latest)) : [];
    return apps
      .filter((a) => (!q.group || ownerGroup(a.stage) === q.group) && (!q.stage || a.stage === q.stage))
      .map((a) => {
        const cand = cands.find((x) => x.id === a.candidateId);
        const asmt = asmts.find((x) => x.id === a.latestAssessmentId);
        return {
          id: a.id,
          stage: a.stage,
          stageLabel: STAGE_LABEL[a.stage],
          group: ownerGroup(a.stage),
          source: a.source,
          createdAt: a.createdAt,
          candidate: cand ? { id: cand.id, name: `${cand.firstName} ${cand.lastName}`, email: cand.email, phone: cand.phone, locationText: cand.locationText } : null,
          eligibility: a.eligibility,
          extractionSummary: a.extraction ? { positions: a.extraction.positions.slice(0, 3).map((p) => `${p.title}${p.employer ? ` at ${p.employer}` : ""}`), licenses: a.extraction.licenses.map((l) => l.name), years: a.extraction.yearsOfExperienceEstimate ?? null, anomalies: a.extraction.anomalies } : null,
          assessment: asmt ? { overall: asmt.overall, confidence: asmt.confidence, summary: asmt.result.summary, strengths: asmt.result.strengths.slice(0, 2), concerns: asmt.result.concerns.slice(0, 1) } : null,
        };
      });
  });
  return c.json(rows);
});

/** Application detail and actions live here too, keyed by application id. */
export const applicationRoutes = new Hono<Vars>();
applicationRoutes.use("/:id", applicationScopeGuard);
applicationRoutes.use("/:id/*", applicationScopeGuard);

applicationRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    if (!app) return null;
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const docs = await tx.select({ id: documents.id, kind: documents.kind, filename: documents.filename, mime: documents.mime, sizeBytes: documents.sizeBytes, hasText: documents.textExtracted, status: documents.status, uploadedVia: documents.uploadedVia, rejectedReason: documents.rejectedReason, validatedAt: documents.validatedAt }).from(documents).where(eq(documents.applicationId, app.id));
    const asmts = await tx.select().from(assessments).where(eq(assessments.applicationId, app.id)).orderBy(desc(assessments.createdAt));
    const comms = await tx.select().from(communications).where(eq(communications.applicationId, app.id)).orderBy(desc(communications.createdAt));
    const timeline = await tx.select().from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, app.id))).orderBy(desc(events.occurredAt)).limit(100);
    const scr = await tx.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt));
    const ivs = await tx.select({ id: interviews.id, roundKey: interviews.roundKey, title: interviews.title, status: interviews.status, startsAt: interviews.startsAt, endsAt: interviews.endsAt, timezone: interviews.timezone, meetingUrl: interviews.meetingUrl, attempt: interviews.attempt, outcome: interviews.outcome, decision: interviews.decision, offeredSlots: interviews.offeredSlots, createdAt: interviews.createdAt }).from(interviews).where(eq(interviews.applicationId, app.id)).orderBy(desc(interviews.createdAt));
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    const packetLabels = pv ? { mustHaves: pv.packet.requirements.mustHaves.map((m) => ({ key: m.key, text: m.text })), competencies: pv.packet.competencies.map((c) => ({ key: c.key, name: c.name })), questions: pv.packet.screening.questions.map((q) => ({ key: q.key, question: q.question })) } : { mustHaves: [], competencies: [], questions: [] };
    const pendingApprovals = await tx.select({ id: approvalRequests.id, actionType: approvalRequests.actionType, rationale: approvalRequests.rationale, createdAt: approvalRequests.createdAt }).from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.status, "pending")));
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "candidate.viewed", target: { type: "application", id: app.id } });
    return { ...app, stageLabel: STAGE_LABEL[app.stage], group: ownerGroup(app.stage), candidate: cand, interviews: ivs, interviewPlan: pv?.packet.interviews.plan.map((r) => ({ key: r.key, title: r.title, durationMinutes: r.durationMinutes, format: r.format, interviewerUserIds: r.interviewerUserIds, purpose: r.purpose })) ?? [], documents: docs.map((d) => ({ ...d, hasText: !!d.hasText })), assessments: asmts, communications: comms, timeline, screens: scr.map((s) => ({ id: s.id, channel: s.channel, status: s.status, invitedAt: s.invitedAt, startedAt: s.startedAt, completedAt: s.completedAt, remindedAt: s.remindedAt, transcript: s.transcript, answers: s.answers, progress: s.progress, assessmentId: s.assessmentId })), pendingApprovals, packetLabels };
  });
  if (!row) throw new HttpError(404, "not_found", "Application not found.");
  return c.json(row);
});

/**
 * The file itself (decision 2): only a checked and scanned document, only to a member who may read the application,
 * only through a short-lived single-object link, and every read is audited with who, which file and why not more.
 */
applicationRoutes.get("/:id/documents/:documentId/file", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const found = await withTenant(container.db, t.companyId, async (tx) => {
    const [doc] = await tx.select().from(documents).where(and(eq(documents.id, c.req.param("documentId")), eq(documents.applicationId, c.req.param("id")))).limit(1);
    if (!doc) return null;
    if (doc.status !== "clean") return { doc, url: null };
    const link = await container.integrations.storage.createDownloadUrl(doc.storageKey, { expiresSeconds: DOWNLOAD_URL_TTL_SECONDS, filename: safeFilename(doc.filename), contentType: doc.mime });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "document.read", target: { type: "document", id: doc.id }, ip: clientIp(c), details: { applicationId: doc.applicationId, filename: safeFilename(doc.filename), expiresAt: link.expiresAt } });
    return { doc, url: link.url };
  });
  if (!found) throw new HttpError(404, "not_found", "Document not found.");
  if (!found.url) throw new HttpError(409, "not_available", found.doc.status === "quarantined" ? "This file is still being checked." : "This file was refused or removed and cannot be opened.");
  return c.redirect(found.url, 302);
});

applicationRoutes.post("/:id/actions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = ApplicationAction.parse(await c.req.json());
  const container = c.get("container");
  const by = t.role;
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    switch (body.action) {
      case "reject": {
        assertCan(t.role, "application.reject");
        if (!body.reason) throw new HttpError(400, "reason_required", "A reason is required to decline a candidate.");
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "rejected", by, actor: actorOf(c), reason: body.reason, payload: { note: body.note ?? null } });
        await tx.update(applications).set({ rejectNote: body.note ?? null }).where(eq(applications.id, app.id));
        await emit(tx, { type: "application.rejected", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { reason: body.reason, byHuman: true } });
        await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { action: "reject", reason: body.reason } });
        const dispositionSent = await sendDeclineAfterHumanDecision(tx, container, { companyId: t.companyId, app, actor: actorOf(c), reason: body.reason });
        return { ok: true, stage: "rejected", dispositionSent };
      }
      case "override_eligibility": {
        assertCan(t.role, "application.act");
        if (app.stage !== "ineligible") throw new HttpError(409, "invalid", "Only ineligible applications can be overridden.");
        if (!body.note?.trim()) throw new HttpError(400, "reason_required", "Say why you are keeping them in; it is recorded so the system can learn.");
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "eligible", by, actor: actorOf(c), reason: body.note });
        await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { action: "override_eligibility", note: body.note } });
        return { ok: true, stage: "eligible" };
      }
      case "review_anyway": {
        // The exclusion view's "review anyway" (docs/FOUNDER-CONTEXT.md §10): reopen an application that an owner-authored eligibility rule declined.
        assertCan(t.role, "application.act");
        if (app.stage !== "rejected" || app.rejectReason !== "eligibility") throw new HttpError(409, "invalid", "Only applications declined on an eligibility answer can be reopened here.");
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "eligible", by, actor: actorOf(c), reason: body.note ?? "review anyway" });
        await tx.update(applications).set({ rejectedAt: null, rejectReason: null, rejectNote: null }).where(eq(applications.id, app.id));
        await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { action: "review_anyway", note: body.note ?? null } });
        const { runId } = await container.engine.start(tx, { workflowKey: "application_intake", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId }, idempotencyKey: `application_intake:${app.id}:reopen:${Date.now()}`, actor: actorOf(c) });
        return { ok: true, stage: "eligible", workflowRunId: runId };
      }
      case "move_to_talent_pool": {
        assertCan(t.role, "application.act");
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "talent_pool", by, actor: actorOf(c), reason: body.note });
        await tx.update(candidates).set({ inTalentPool: true }).where(eq(candidates.id, app.candidateId));
        await emit(tx, { type: "application.moved_to_talent_pool", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: {} });
        return { ok: true, stage: "talent_pool" };
      }
      case "hold": {
        assertCan(t.role, "application.act");
        await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { action: "hold", note: body.note ?? null } });
        return { ok: true, stage: app.stage };
      }
      case "invite_screen": {
        assertCan(t.role, "application.act");
        if (!["triaged", "eligible", "received", "screen_invited", "screening"].includes(app.stage)) throw new HttpError(409, "invalid", `Cannot invite someone who is ${STAGE_LABEL[app.stage].toLowerCase()}.`);
        const open = await tx.select({ id: screens.id }).from(screens).where(and(eq(screens.applicationId, app.id), inArray(screens.status, ["invited", "reminded", "in_progress"]))).limit(1);
        if (open[0]) throw new HttpError(409, "already_invited", "They already have an open screening invitation.");
        // The owner's click is the approval when a policy asked for one.
        const pend = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.invite_screen"), eq(approvalRequests.status, "pending")));
        for (const p of pend) {
          await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: new Date().toISOString(), decisionNote: body.note ?? "invited from the candidate page" }).where(eq(approvalRequests.id, p.id));
          await emit(tx, { type: "approval.granted", companyId: t.companyId, actor: actorOf(c), subject: { type: "approval_request", id: p.id }, payload: { actionType: p.actionType }, correlationId: p.workflowRunId });
          await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${p.id}`, payload: { decision: "approved" } });
        }
        const { runId } = await container.engine.start(tx, { workflowKey: "screen", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId, channel: body.channel, invitedBy: t.userId }, idempotencyKey: `screen:${app.id}:${Date.now()}`, actor: actorOf(c) });
        await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { action: "invite_screen", channel: body.channel ?? "auto", note: body.note ?? null, workflowRunId: runId } });
        return { ok: true, stage: app.stage, workflowRunId: runId };
      }
      case "advance_to_interview": {
        assertCan(t.role, "application.act");
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by, actor: actorOf(c), reason: body.note ?? "owner decision" });
        const pend = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.actionType, "application.recommend_interview"), eq(approvalRequests.status, "pending")));
        for (const p of pend) {
          await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: new Date().toISOString(), decisionNote: body.note ?? "advanced from the candidate page" }).where(eq(approvalRequests.id, p.id));
          await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${p.id}`, payload: { decision: "approved" } });
        }
        await emit(tx, { type: "candidate.recommended", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { by: "human" } });
        await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { action: "advance_to_interview", note: body.note ?? null } });
        return { ok: true, stage: "interview_recommended", next: "Marked as recommended for interview. Open the candidate and choose \"Interview\" to pick the round and interviewers; times go out to the candidate from there." };
      }
    }
  });
  await container.kick();
  return c.json(result);
});

/** One-click flag on an AI assessment (docs/FOUNDER-CONTEXT.md §23). Stored against the AI run, emitted as a human override, audited. Never retrains anything by itself. */
applicationRoutes.post("/:id/assessments/:assessmentId/flag", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const body = FlagAssessment.parse(await c.req.json());
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [asmt] = await tx.select().from(assessments).where(and(eq(assessments.id, c.req.param("assessmentId")), eq(assessments.applicationId, c.req.param("id")))).limit(1);
    if (!asmt) throw new HttpError(404, "not_found", "Assessment not found.");
    const flag = { kind: body.kind, note: body.note ?? null, by: actorOf(c), at: new Date().toISOString() };
    if (asmt.aiRunId) await tx.update(aiRuns).set({ humanOverride: flag }).where(eq(aiRuns.id, asmt.aiRunId));
    await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: asmt.applicationId }, payload: { action: "flag_assessment", assessmentId: asmt.id, kind: body.kind, note: body.note ?? null, aiRunId: asmt.aiRunId } });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "assessment.flagged", target: { type: "ai_run", id: asmt.aiRunId ?? asmt.id }, reason: `${body.kind}${body.note ? `: ${body.note}` : ""}` });
    return { ok: true, assessmentId: asmt.id, kind: body.kind };
  });
  return c.json(row);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Human-recorded hiring outcomes (21 Sep, item 4). Recording only: no offer is generated, approved or sent here. */
/* ------------------------------------------------------------------------------------------------------------ */

function outcomeHttpError(e: unknown): never {
  if (e instanceof OutcomeError) throw new HttpError(e.code === "not_found" ? 404 : ["already_closed", "already_corrected", "already_recorded", "not_active"].includes(e.code) ? 409 : 400, e.code, e.message);
  throw e;
}

/** Tells the ITS recruiter working on this role or candidate. Names the role, never the candidate. */
async function tellRecruiterAboutOutcome(container: Container, companyId: string, roleId: string, applicationId: string | null, what: string, key: string) {
  const escalations = await openEscalationsFor(container.db, companyId, roleId, applicationId);
  if (!escalations.length) return;
  const [company] = await container.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const [role] = await container.db.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)).limit(1);
  const from = `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`;
  const told = new Set<string>();
  for (const e of escalations) {
    const to = e.assignedToUserId ? (await container.db.select({ email: users.email }).from(users).where(eq(users.id, e.assignedToUserId)).limit(1))[0]?.email : container.env.ITS_QUEUE_EMAIL;
    if (!to || told.has(to)) continue;
    told.add(to);
    await container.integrations.email.send({ to, from, subject: `${company?.name ?? "A customer"} recorded an outcome for ${role?.title ?? "a role"}`, text: `${what}\n\nThe customer recorded this themselves; the decision was made outside Recruiting OS. Your open request: ${container.env.WEB_BASE_URL}/recruiter/queue/${e.id}`, idempotencyKey: `${key}:${to}`, tags: { template: "outcome_recorded" } });
  }
}

applicationRoutes.get("/:id/outcomes", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => listOutcomes(tx, { companyId: t.companyId, applicationId: c.req.param("id") }));
  return c.json({ statement: OUTCOME_STATEMENT, outcomes: rows });
});

applicationRoutes.post("/:id/outcome", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "outcome.record");
  const body = RecordApplicationOutcome.parse(await c.req.json());
  if (body.outcome === "employer_declined") assertCan(t.role, "application.reject"); // a decline is a decline, whoever records it
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    try {
      const r = await recordApplicationOutcome(tx, { companyId: t.companyId, applicationId: c.req.param("id") ?? "", outcome: body.outcome, by: t.role, actor, hireDate: body.hireDate, offerAcceptedAt: body.offerAcceptedAt, reason: body.reason, note: body.note, now: container.engine.clock() });
      // the candidate hears about a decline the same way as from the Decline button: after the human decision, gated
      const dispositionSent = body.outcome === "employer_declined" ? await sendDeclineAfterHumanDecision(tx, container, { companyId: t.companyId, app: r.app, actor, reason: body.reason ?? "employer_declined" }) : false;
      return { ...r, dispositionSent };
    } catch (e) { outcomeHttpError(e); }
  });
  const label: Record<string, string> = { hired_externally: "recorded a hire (offer accepted outside the platform)", candidate_withdrew: "recorded that the candidate withdrew", employer_declined: "declined the candidate", offer_declined_externally: "recorded that the candidate declined an offer made outside the platform", no_hire: "closed the process for this candidate without a hire" };
  await tellRecruiterAboutOutcome(container, t.companyId, result.roleId, c.req.param("id") ?? null, `${actor.name ?? "The customer"} ${label[body.outcome]}.`, `outcome:${result.row.id}`);
  await container.kick();
  return c.json({ ok: true, outcomeId: result.row.id, stage: result.to, roleId: result.roleId, roleStillOpen: result.roleStillOpen, dispositionSent: result.dispositionSent, movedToTalentPool: 0, statement: OUTCOME_STATEMENT, next: result.roleStillOpen ? "The role is still open. Close it with its outcome when you are ready; that is a separate confirmation." : null }, 201);
});

roleRoutes.post("/:id/outcome", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "outcome.record");
  const body = RecordRoleOutcome.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    try {
      return await recordRoleOutcome(tx, { companyId: t.companyId, roleId: c.req.param("id") ?? "", outcome: body.outcome, by: t.role, actor, reason: body.reason, now: container.engine.clock() });
    } catch (e) { outcomeHttpError(e); }
  });
  const label: Record<string, string> = { filled: "closed the role as filled", filled_outside_platform: "closed the role: filled outside the platform", role_cancelled: "cancelled the role", no_hire: "closed the role without a hire" };
  await tellRecruiterAboutOutcome(container, t.companyId, result.role.id, null, `${actor.name ?? "The customer"} ${label[body.outcome]}.`, `role_outcome:${result.row.id}`);
  await container.kick();
  return c.json({ ok: true, outcomeId: result.row.id, role: result.role, movedToTalentPool: result.movedToTalentPool, statement: OUTCOME_STATEMENT });
});

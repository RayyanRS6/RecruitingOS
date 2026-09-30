import { Hono } from "hono";
import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { BREAK_GLASS_MAX_MINUTES, REVOKE_JOB_KIND, acknowledgeAlert, audit, emit, entitlements, grantStaffAccess, listBusinessCalendarVersions, listSuppressions, loadBusinessCalendar, openAlerts, pendingCredentialDeletions, previewCalendarDays, recalculateEscalationDeadlines, releaseSuppression, saveBusinessCalendarVersion, suppressAddress, describeHours } from "@ros/core";
import { BreakGlass, BusinessCalendarInput, PlanChange, RecalculateDeadlines } from "@ros/contracts";
import { aiRuns, applications, companies, events, integrations, jobs, recruiterEscalations, roles, staffAccessGrants, users, workflowRuns, workflowSteps, withPlatform } from "@ros/db";
import { requirePlatformAdmin, type Vars } from "../middleware/session";
import { OUTCOME_STATEMENT, OutcomeError, PlatformRoleError, raiseAlert, correctOutcome, countActiveAdmins, grantPlatformRole, listPlatformRoleGrants, revokeAllSessions, revokePlatformRole, type PlatformRole } from "@ros/core";
import { CorrectOutcome } from "@ros/contracts";
import { listCspReports, reviewCspReport } from "@ros/core";
import { hiringOutcomes } from "@ros/db";
import { adminAlerts } from "@ros/db";
import { and } from "drizzle-orm";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import { customerReport } from "../services/role-report";

/** Platform admin console API (docs/16). Every read is audited with the reason the admin supplies. */
export const adminRoutes = new Hono<Vars>();

adminRoutes.use("*", requirePlatformAdmin, async (c, next) => {
  const s = c.get("session")!;
  const reason = c.req.header("x-admin-reason") ?? "admin console";
  await audit(c.get("container").db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "admin.bypass", reason: `${c.req.method} ${c.req.path}: ${reason}` });
  await next();
});

adminRoutes.get("/customers", async (c) => {
  const db = c.get("container").db;
  const rows = await db.select().from(companies).orderBy(desc(companies.createdAt));
  // Five queries for the whole list, however many customers there are.
  const byCompany = <T extends { companyId: string | null }>(list: T[]) => new Map(list.map((r) => [r.companyId, r]));
  const roleCounts = byCompany(await db.select({ companyId: roles.companyId, n: sql<number>`count(*)` }).from(roles).groupBy(roles.companyId));
  const appCounts = byCompany(await db.select({ companyId: applications.companyId, n: sql<number>`count(*)` }).from(applications).groupBy(applications.companyId));
  const costs = byCompany(await db.select({ companyId: aiRuns.companyId, usd: sql<string>`coalesce(sum(cost_usd), 0)` }).from(aiRuns).groupBy(aiRuns.companyId));
  const lastActivity = byCompany(await db.select({ companyId: events.companyId, at: sql<string>`max(occurred_at)` }).from(events).groupBy(events.companyId));
  const escalationCounts = byCompany(await db.select({ companyId: recruiterEscalations.companyId, n: sql<number>`count(*)` }).from(recruiterEscalations).groupBy(recruiterEscalations.companyId));
  return c.json(rows.map((co) => ({
    ...co,
    roles: Number(roleCounts.get(co.id)?.n ?? 0),
    applications: Number(appCounts.get(co.id)?.n ?? 0),
    aiCostUsd: Number(costs.get(co.id)?.usd ?? 0),
    lastActivityAt: lastActivity.get(co.id)?.at ?? null,
    escalations: Number(escalationCounts.get(co.id)?.n ?? 0),
  })));
});

/**
 * The customer's report (docs/spec/21 section 7, P1): the ten figures of the role report over every role of the
 * company, plus one line per role. Counts only; never a candidate's name. The reason header is audited by the
 * middleware above, like every other read here.
 */
adminRoutes.get("/customers/:id/report", async (c) => {
  const container = c.get("container");
  const companyId = c.req.param("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new HttpError(404, "not_found", "Company not found.");
  const result = await withPlatform(container.db, async (tx) => {
    const [co] = await tx.select({ id: companies.id, name: companies.name, status: companies.status, planKey: companies.planKey }).from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!co) return null;
    const { report, roles: roleLines } = await customerReport(tx, { companyId, now: container.engine.clock() });
    return { company: co, roles: roleLines, report };
  });
  if (!result) throw new HttpError(404, "not_found", "Company not found.");
  return c.json(result);
});

adminRoutes.get("/runs", async (c) => {
  const status = c.req.query("status");
  const db = c.get("container").db;
  const rows = await db.select().from(workflowRuns).where(status ? eq(workflowRuns.status, status) : undefined).orderBy(desc(workflowRuns.updatedAt)).limit(200);
  return c.json(rows);
});

adminRoutes.get("/runs/:id", async (c) => {
  const db = c.get("container").db;
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, c.req.param("id"))).limit(1);
  if (!run) throw new HttpError(404, "not_found", "Run not found.");
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.runId, run.id)).orderBy(workflowSteps.seq);
  const runAi = await db.select().from(aiRuns).where(eq(aiRuns.workflowRunId, run.id)).orderBy(aiRuns.createdAt);
  const evs = await db.select().from(events).where(eq(events.correlationId, run.id)).orderBy(events.occurredAt);
  return c.json({ run, steps, aiRuns: runAi, events: evs });
});

adminRoutes.post("/runs/:id/retry", async (c) => {
  const container = c.get("container");
  const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, c.req.param("id"))).limit(1);
  if (!run) throw new HttpError(404, "not_found", "Run not found.");
  await container.db.update(workflowRuns).set({ status: "running", attempts: 0, wait: null, lastError: null }).where(eq(workflowRuns.id, run.id));
  await container.db.insert(jobs).values({ kind: "workflow.tick", payload: { runId: run.id, wake: { kind: "manual" } } });
  await container.kick();
  return c.json({ ok: true });
});

adminRoutes.get("/ai-runs", async (c) => {
  const db = c.get("container").db;
  const rows = await db.select().from(aiRuns).orderBy(desc(aiRuns.createdAt)).limit(200);
  return c.json(rows);
});

adminRoutes.get("/ai-runs/:id", async (c) => {
  const db = c.get("container").db;
  const [row] = await db.select().from(aiRuns).where(eq(aiRuns.id, c.req.param("id"))).limit(1);
  if (!row) throw new HttpError(404, "not_found", "AI run not found.");
  const related = row.workflowRunId ? await db.select().from(events).where(eq(events.correlationId, row.workflowRunId)).orderBy(events.occurredAt) : [];
  return c.json({ run: row, events: related });
});

adminRoutes.get("/failures", async (c) => {
  const db = c.get("container").db;
  const failedRuns = await db.select().from(workflowRuns).where(eq(workflowRuns.status, "failed")).orderBy(desc(workflowRuns.updatedAt)).limit(100);
  const failedJobs = await db.select().from(jobs).where(eq(jobs.status, "failed")).orderBy(desc(jobs.createdAt)).limit(100);
  const failedAi = await db.select().from(aiRuns).where(sql`${aiRuns.status} <> 'ok'`).orderBy(desc(aiRuns.createdAt)).limit(100);
  const alerts = await openAlerts(db);
  const pendingDeletions = await pendingCredentialDeletions(db);
  return c.json({ failedRuns, failedJobs, failedAi, alerts, pendingDeletions });
});

/** The email do-not-send list (item 5): what is suppressed, why, and a release once a person has confirmed the address. */
adminRoutes.get("/email-suppressions", async (c) => c.json((await listSuppressions(c.get("container").db, c.req.query("all") !== "1")).map((s) => ({ id: s.id, address: s.address, reason: s.reason, source: s.source, active: s.active, count: s.count, firstAt: s.firstAt, lastAt: s.lastAt, details: s.details, releasedAt: s.releasedAt, releaseReason: s.releaseReason }))));
adminRoutes.post("/email-suppressions", async (c) => {
  const s = c.get("session")!;
  const body = (await c.req.json()) as { address?: string; reason?: string };
  if (!body.address || !/@/.test(body.address)) throw new HttpError(400, "invalid_request", "An email address is required.");
  const row = await suppressAddress(c.get("container").db, { address: body.address, reason: "manual", source: "admin", details: { note: body.reason ?? "" }, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email } });
  return c.json({ id: row.id, address: row.address, reason: row.reason, active: row.active }, 201);
});
adminRoutes.post("/email-suppressions/:id/release", async (c) => {
  const s = c.get("session")!;
  const body = (await c.req.json()) as { reason?: string };
  if (!body.reason || body.reason.length < 5) throw new HttpError(400, "reason_required", "Say how you confirmed the address is deliverable again.");
  const row = await releaseSuppression(c.get("container").db, { id: c.req.param("id"), reason: body.reason, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email } });
  if (!row) throw new HttpError(404, "not_found", "No active suppression with that id.");
  return c.json({ ok: true, address: row.address });
});

/** Operator alerts (correction 10): a failed credential deletion is never silent. */
adminRoutes.get("/alerts", async (c) => c.json(await openAlerts(c.get("container").db)));

adminRoutes.post("/alerts/:id/acknowledge", async (c) => {
  const s = c.get("session")!;
  // Two-person visibility (21 Sep, item 2): the administrator who changed a platform role cannot be the one who closes the alert about it.
  const [alert] = await c.get("container").db.select({ kind: adminAlerts.kind, details: adminAlerts.details, target: adminAlerts.target }).from(adminAlerts).where(eq(adminAlerts.id, c.req.param("id") ?? "")).limit(1);
  if (alert?.kind.startsWith("platform_role.") && (alert.details?.actorId === s.user.id || alert.target?.id === s.user.id)) throw new HttpError(403, "second_person_required", "Another administrator must acknowledge a change to platform roles that you made or that concerns you.");
  const ok = await acknowledgeAlert(c.get("container").db, { id: c.req.param("id"), actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email } });
  if (!ok) throw new HttpError(404, "not_found", "Alert not found or already acknowledged.");
  return c.json({ ok: true });
});

/**
 * Retries a credential deletion by hand. The retry is queued for the worker rather than run here: only the worker's
 * database role may read a stored credential (packages/db/scripts/vault-grants.sql), so the API process could never
 * revoke it at the provider itself. The queue runs within seconds when a worker is up; the alert stays open until the
 * deletion is confirmed.
 */
adminRoutes.post("/integrations/:id/retry-deletion", async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  const integrationId = c.req.param("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(integrationId)) throw new HttpError(404, "not_found", "Connection not found.");
  const [row] = await container.db.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
  if (!row) throw new HttpError(404, "not_found", "Connection not found.");
  if (!row.secretRef) return c.json({ ok: true, queued: false, deleted: true, status: row.status });
  const now = container.engine.clock();
  await container.db.insert(jobs).values({ kind: REVOKE_JOB_KIND, payload: { integrationId: row.id, companyId: row.companyId, actor }, runAt: now.toISOString(), maxAttempts: 8 });
  await audit(container.db, { companyId: row.companyId, actor, action: "admin.bypass", target: { type: "integration", id: row.id }, reason: "credential deletion retried from the console; queued for the worker" });
  await container.kick();
  const [after] = await container.db.select({ secretRef: integrations.secretRef, status: integrations.status, lastError: integrations.lastError }).from(integrations).where(eq(integrations.id, row.id)).limit(1);
  return c.json({ ok: true, queued: true, deleted: !after?.secretRef, status: after?.status ?? row.status, lastError: after?.lastError ?? null });
});

adminRoutes.get("/costs", async (c) => {
  const db = c.get("container").db;
  const rows = await db
    .select({ companyId: aiRuns.companyId, task: aiRuns.task, model: aiRuns.model, runs: sql<number>`count(*)`, inputTokens: sql<number>`sum(input_tokens)`, outputTokens: sql<number>`sum(output_tokens)`, costUsd: sql<string>`sum(cost_usd)` })
    .from(aiRuns)
    .groupBy(aiRuns.companyId, aiRuns.task, aiRuns.model);
  return c.json(rows.map((r) => ({ ...r, runs: Number(r.runs), inputTokens: Number(r.inputTokens), outputTokens: Number(r.outputTokens), costUsd: Number(r.costUsd) })));
});

/** Operational view only (correction 11): category, urgency, expertise, generic summary, timing and assignment. Never the request text, the context snapshot, or the resolution text. */
adminRoutes.get("/escalations", async (c) => {
  const db = c.get("container").db;
  const rows = await db
    .select({ id: recruiterEscalations.id, companyName: companies.name, roleTitle: roles.title, kind: recruiterEscalations.kind, status: recruiterEscalations.status, urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary, slaDueAt: recruiterEscalations.slaDueAt, createdAt: recruiterEscalations.createdAt, claimedAt: recruiterEscalations.claimedAt, firstResponseAt: recruiterEscalations.firstResponseAt, resolvedAt: recruiterEscalations.resolvedAt, minutesSpent: recruiterEscalations.minutesSpent, assignedTo: users.email, accessExpiresAt: recruiterEscalations.accessExpiresAt })
    .from(recruiterEscalations)
    .innerJoin(companies, eq(companies.id, recruiterEscalations.companyId))
    .leftJoin(roles, eq(roles.id, recruiterEscalations.roleId))
    .leftJoin(users, eq(users.id, recruiterEscalations.assignedToUserId))
    .orderBy(desc(recruiterEscalations.createdAt))
    .limit(200);
  const s = c.get("session")!;
  const byCompany = new Map<string, string[]>();
  for (const r of rows) byCompany.set(r.companyName, [...(byCompany.get(r.companyName) ?? []), r.id]);
  await audit(db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "escalation.preview_viewed", reason: "admin console", details: { escalationIds: rows.map((r) => r.id), fields: "preview" } });
  return c.json(rows);
});

/**
 * The ITS business calendar (correction 12): editable standard hours, time zone, holidays, closures and temporary
 * coverage changes, each change a new version with an effective date. Existing deadlines keep their values unless an
 * administrator recalculates them explicitly, with a reason.
 */
adminRoutes.get("/calendar", async (c) => {
  const db = c.get("container").db;
  const now = new Date();
  const loaded = await loadBusinessCalendar(db, now);
  const versions = await listBusinessCalendarVersions(db);
  return c.json({
    current: loaded.current,
    version: loaded.version,
    effectiveFrom: loaded.effectiveFrom,
    description: describeHours(loaded, now),
    upcoming: versions.filter((v) => v.effectiveFrom > (loaded.effectiveFrom ?? "")).map((v) => ({ id: v.id, version: v.version, effectiveFrom: v.effectiveFrom, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt })),
    versions: versions.map((v) => ({ id: v.id, version: v.version, effectiveFrom: v.effectiveFrom, timeZone: v.timeZone, note: v.note, createdBy: v.createdBy, createdAt: v.createdAt, holidays: v.holidays.length, closures: v.closures.length, coverageChanges: v.coverageChanges.length })),
    preview: previewCalendarDays(loaded, now, 28),
  });
});

adminRoutes.post("/calendar", async (c) => {
  const s = c.get("session")!;
  const body = BusinessCalendarInput.parse(await c.req.json());
  const db = c.get("container").db;
  const row = await saveBusinessCalendarVersion(db, {
    calendar: { timeZone: body.timeZone, hours: body.hours, holidays: body.holidays, closures: body.closures, coverageChanges: body.coverageChanges },
    effectiveFrom: body.effectiveFrom,
    note: body.note,
    actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email },
  });
  const loaded = await loadBusinessCalendar(db);
  return c.json({ id: row.id, version: row.version, effectiveFrom: row.effectiveFrom, inForceNow: loaded.version === row.version, description: describeHours(loaded) }, 201);
});

adminRoutes.post("/calendar/recalculate", async (c) => {
  const s = c.get("session")!;
  const body = RecalculateDeadlines.parse(await c.req.json());
  const db = c.get("container").db;
  const results = await withPlatform(db, (tx) => recalculateEscalationDeadlines(tx, { escalationIds: body.escalationIds, reason: body.reason, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email } }));
  return c.json({ considered: results.length, changed: results.filter((r) => r.changed).length, results });
});

adminRoutes.get("/queue", async (c) => {
  const db = c.get("container").db;
  const [q] = await db.select({ queued: sql<number>`count(*) filter (where status = 'queued')`, failed: sql<number>`count(*) filter (where status = 'failed')`, oldest: sql<string | null>`min(run_at) filter (where status = 'queued')` }).from(jobs);
  const waiting = await db.select({ n: sql<number>`count(*)` }).from(workflowRuns).where(eq(workflowRuns.status, "waiting"));
  return c.json({ queued: Number(q.queued), failed: Number(q.failed), oldestQueuedAt: q.oldest, waitingRuns: Number(waiting[0].n), definitions: c.get("container").engine.definitions() });
});

/**
 * Emergency access (founder decision F10): MFA, a recorded reason, a short expiry, immutable audit. Until Supabase Auth
 * with a second factor exists (decision D25) this endpoint refuses every request; there is no interim bypass.
 */
adminRoutes.post("/break-glass", async (c) => {
  const s = c.get("session")!;
  const body = BreakGlass.parse(await c.req.json());
  const freshMfa = s.mfaVerifiedAt && Date.now() - Date.parse(s.mfaVerifiedAt) < 15 * 60_000;
  if (!freshMfa) throw new HttpError(403, "mfa_required", "Break-glass access requires a second factor verified in the last 15 minutes. Multi-factor sign-in arrives with the authentication migration; there is no interim bypass.");
  const minutes = Math.min(body.minutes, BREAK_GLASS_MAX_MINUTES);
  const now = new Date();
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  const grant = await withPlatform(c.get("container").db, async (tx) => {
    const g = await grantStaffAccess(tx, { userId: s.user.id, userName: actor.name, companyId: body.companyId, kind: "break_glass", scope: {}, purpose: `break-glass: ${body.reason}`, grantedBy: actor, expiresAt: new Date(now.getTime() + minutes * 60_000), mfaVerified: true, now });
    await audit(tx, { companyId: body.companyId, actor, action: "admin.break_glass", target: { type: "company", id: body.companyId }, reason: body.reason, details: { grantId: g.id, minutes, expiresAt: g.expiresAt } });
    return g;
  });
  return c.json({ grantId: grant.id, expiresAt: grant.expiresAt }, 201);
});

/** Every grant ever issued, newest first: who, which customer, why, scope, when it ended. */
adminRoutes.get("/staff-access", async (c) => {
  const db = c.get("container").db;
  const rows = await db
    .select({ id: staffAccessGrants.id, userEmail: users.email, companyId: staffAccessGrants.companyId, companyName: companies.name, kind: staffAccessGrants.kind, escalationId: staffAccessGrants.escalationId, roleId: staffAccessGrants.roleId, applicationId: staffAccessGrants.applicationId, purpose: staffAccessGrants.purpose, mfaVerified: staffAccessGrants.mfaVerified, startsAt: staffAccessGrants.startsAt, expiresAt: staffAccessGrants.expiresAt, revokedAt: staffAccessGrants.revokedAt, endedAt: staffAccessGrants.endedAt })
    .from(staffAccessGrants)
    .innerJoin(users, eq(users.id, staffAccessGrants.userId))
    .innerJoin(companies, eq(companies.id, staffAccessGrants.companyId))
    .orderBy(desc(staffAccessGrants.createdAt))
    .limit(200);
  return c.json(rows);
});

/** Founder decision F8: a platform admin puts a customer on the Design Partner plan (or another plan). Pilot term 90 days, extendable. */
adminRoutes.post("/customers/:id/plan", async (c) => {
  const s = c.get("session")!;
  const body = PlanChange.parse(await c.req.json());
  const companyId = c.req.param("id");
  const now = new Date();
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  const result = await withPlatform(c.get("container").db, async (tx) => {
    const [co] = await tx.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    if (!co) throw new HttpError(404, "not_found", "Company not found.");
    await entitlements.applyPlan(tx, companyId, body.planKey, "plan");
    const pilot = body.planKey === "design_partner"
      ? { startedAt: co.settings.pilot?.startedAt ?? now.toISOString(), endsAt: co.settings.pilot?.endsAt ?? new Date(now.getTime() + (body.pilotDays ?? 90) * 86_400_000).toISOString(), ...(body.extendUntil ? { extendedUntil: body.extendUntil } : {}) }
      : co.settings.pilot;
    const [updated] = await tx.update(companies).set({ status: body.planKey === "design_partner" ? "design_partner" : co.status === "trial" ? "active" : co.status, settings: { ...co.settings, pilot } }).where(eq(companies.id, companyId)).returning();
    await emit(tx, { type: "plan.changed", companyId, actor, subject: { type: "company", id: companyId }, payload: { from: co.planKey, to: body.planKey, pilot } });
    await audit(tx, { companyId, actor, action: "plan.changed", target: { type: "company", id: companyId }, reason: body.reason ?? `plan ${co.planKey} → ${body.planKey}`, details: { pilot } });
    return updated;
  });
  return c.json(result);
});

/**
 * Platform roles (21 Sep, item 2): a ledger of named people, granted and revoked by administrators with a second factor
 * and a reason; never by configuration. The bootstrap list is reported so a forgotten variable is visible.
 */
adminRoutes.get("/platform-roles", async (c) => {
  const container = c.get("container");
  const grants = await listPlatformRoleGrants(container.db);
  const activeAdmins = await countActiveAdmins(container.db);
  return c.json({ grants, activeAdmins, bootstrap: { configured: container.env.BOOTSTRAP_ADMIN_EMAILS.length, ignored: container.env.BOOTSTRAP_ADMIN_EMAILS.length > 0 && activeAdmins > 0 } });
});

adminRoutes.post("/platform-roles", async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; role?: string; reason?: string; confirm?: boolean };
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm the grant.");
  const role = body.role as PlatformRole;
  if (!["its_recruiter", "platform_admin"].includes(role)) throw new HttpError(400, "bad_role", "Role must be its_recruiter or platform_admin.");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Give the reason for the grant; every administrator will see it.");
  const email = (body.email ?? "").trim().toLowerCase();
  const domain = email.split("@")[1] ?? "";
  if (!container.env.ITS_STAFF_EMAIL_DOMAINS.includes(domain)) throw new HttpError(400, "not_staff_domain", "Platform roles are only for ITS staff accounts on a staff email domain.");
  const [grantee] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!grantee) throw new HttpError(404, "unknown_user", "That person has not signed in yet. They must sign in with Microsoft 365 and a second factor first.");
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  try {
    const grant = await withPlatform(container.db, (tx) => grantPlatformRole(tx, { userId: grantee.id, role, actor, reason, source: "console", requireStaffProvider: "azure" }));
    const delivery = await notifyOtherAdmins(container, s.user.id, `Platform role granted: ${email} is now ${role.replace("_", " ")}`, `${actor.name} granted ${role.replace("_", " ")} to ${email}.\nReason: ${reason}\n\nIf you did not expect this, revoke it in the admin console and tell the founder.`, `role_granted:${grant.id}`);
    return c.json({ ok: true, grantId: grant.id, ...delivery }, 201);
  } catch (e) {
    if (e instanceof PlatformRoleError) throw new HttpError(e.code === "unknown_user" ? 404 : e.code === "self_grant" ? 403 : 409, e.code, e.message);
    throw e;
  }
});

adminRoutes.post("/platform-roles/:grantId/revoke", async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string; confirm?: boolean };
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm the revocation.");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Give the reason for the revocation; every administrator will see it.");
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  try {
    const grant = await withPlatform(container.db, (tx) => revokePlatformRole(tx, { grantId: c.req.param("grantId") ?? "", actor, reason }));
    const [who] = await container.db.select({ email: users.email }).from(users).where(eq(users.id, grant.userId)).limit(1);
    const delivery = await notifyOtherAdmins(container, s.user.id, `Platform role revoked: ${who?.email ?? grant.userId} is no longer ${grant.role.replace("_", " ")}`, `${actor.name} revoked ${grant.role.replace("_", " ")} from ${who?.email ?? grant.userId}.\nReason: ${reason}`, `role_revoked:${grant.id}`);
    return c.json({ ok: true, grantId: grant.id, ...delivery });
  } catch (e) {
    if (e instanceof PlatformRoleError) throw new HttpError(e.code === "not_found" ? 404 : 409, e.code, e.message);
    throw e;
  }
});

/**
 * Every other administrator, and the ITS queue mailbox, hear about a platform-role change (two-person visibility). A
 * message that cannot be delivered is never silent: it is audited and raised as an alert, and the caller learns how
 * many recipients were not reached.
 */
async function notifyOtherAdmins(container: Container, actorUserId: string, subject: string, text: string, key: string): Promise<{ notified: number; failed: number }> {
  const others = await container.db.select({ email: users.email }).from(users).where(and(eq(users.platformRole, "platform_admin"), sql`${users.id} <> ${actorUserId}`));
  const recipients = new Set<string>([...others.map((o) => o.email), container.env.ITS_QUEUE_EMAIL]);
  const from = `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`;
  let notified = 0;
  let failed = 0;
  for (const to of recipients) {
    const sent = await container.integrations.email.send({ to, from, subject, text, idempotencyKey: `${key}:${to}`, tags: { template: "platform_role_changed" } });
    if (sent.status === "failed") {
      failed += 1;
      await audit(container.db, { companyId: null, actor: { kind: "system", id: "email" }, action: "platform_role.changed", reason: `notification failed: ${sent.error}`, details: { key, recipientHash: createHash("sha256").update(to).digest("hex").slice(0, 16) } });
      await raiseAlert(container.db, { kind: "platform_role.notify_failed", severity: "high", title: "An administrator was not told about a platform-role change", body: `${subject}. The email to one administrator failed (${sent.error}); tell them another way and check the suppression list.`, details: { key, recipientHash: createHash("sha256").update(to).digest("hex").slice(0, 16) } });
    } else notified += 1;
  }
  return { notified, failed };
}

/** Recorded hiring outcomes across customers, newest first, for correction (21 Sep, item 4). */
/**
 * Sign a person out everywhere (22 Sep 2026, staff second factor): after a lost device and the owner's reset at the
 * identity service, an application session on that device must not outlive the reset. Audited with the reason.
 */
adminRoutes.post("/users/:userId/sessions/revoke", async (c) => {
  const container = c.get("container");
  const s = c.get("session")!;
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string; confirm?: boolean };
  const reason = String(body.reason ?? "").trim();
  if (body.confirm !== true) return c.json({ error: { code: "confirmation_required", message: "Confirm that every session of this person should end." } }, 400);
  if (reason.length < 5) return c.json({ error: { code: "reason_required", message: "Give a reason of at least five characters." } }, 400);
  const userId = c.req.param("userId") ?? "";
  const [who] = await container.db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!who) return c.json({ error: { code: "not_found", message: "No such person." } }, 404);
  const ended = await revokeAllSessions(container.db, who.id, { now: container.engine.clock() });
  await audit(container.db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "session.revoked", target: { type: "user", id: who.id }, reason, details: { email: who.email, sessionsEnded: ended, by: "administrator" } });
  return c.json({ ok: true, sessionsEnded: ended });
});

adminRoutes.get("/outcomes", async (c) => {
  const db = c.get("container").db;
  const rows = await db.select({ id: hiringOutcomes.id, companyId: hiringOutcomes.companyId, companyName: companies.name, applicationId: hiringOutcomes.applicationId, roleId: hiringOutcomes.roleId, milestone: hiringOutcomes.milestone, outcome: hiringOutcomes.outcome, hireDate: hiringOutcomes.hireDate, offerAcceptedAt: hiringOutcomes.offerAcceptedAt, recordedBy: hiringOutcomes.recordedBy, recordedAt: hiringOutcomes.recordedAt, correctionOf: hiringOutcomes.correctionOf, correctedAt: hiringOutcomes.correctedAt, correctionReason: hiringOutcomes.correctionReason })
    .from(hiringOutcomes).innerJoin(companies, eq(companies.id, hiringOutcomes.companyId)).orderBy(desc(hiringOutcomes.recordedAt)).limit(200);
  return c.json({ statement: OUTCOME_STATEMENT, outcomes: rows });
});

adminRoutes.post("/outcomes/:id/correct", async (c) => {
  const s = c.get("session")!;
  const body = CorrectOutcome.parse(await c.req.json());
  const container = c.get("container");
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  try {
    const result = await withPlatform(container.db, (tx) => correctOutcome(tx, { outcomeId: c.req.param("id") ?? "", actor, reason: body.reason, outcome: body.outcome, hireDate: body.hireDate, offerAcceptedAt: body.offerAcceptedAt, now: container.engine.clock() }));
    return c.json({ ok: true, originalId: result.original.id, correctionId: result.correction.id, outcome: result.correction.outcome });
  } catch (e) {
    if (e instanceof OutcomeError) throw new HttpError(e.code === "not_found" ? 404 : ["bad_outcome", "hire_date_required"].includes(e.code) ? 400 : 409, e.code, e.message);
    throw e;
  }
});

/** Content-security-policy violation reports (21 Sep, item 6): reviewed before any enforcement. */
adminRoutes.get("/csp-reports", async (c) => c.json({ mode: c.get("container").env.CSP_MODE, reports: await listCspReports(c.get("container").db) }));

adminRoutes.post("/csp-reports/:id/review", async (c) => {
  const s = c.get("session")!;
  const body = (await c.req.json().catch(() => ({}))) as { disposition?: string };
  if (!body.disposition || body.disposition.trim().length < 3) throw new HttpError(400, "disposition_required", "Say what this report means (expected, fix needed, policy change).");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.req.param("id") ?? "")) throw new HttpError(404, "not_found", "Report not found.");
  const ok = await reviewCspReport(c.get("container").db, { id: c.req.param("id") ?? "", reviewedBy: s.user.id, disposition: body.disposition.trim() });
  if (!ok) throw new HttpError(404, "not_found", "Report not found.");
  await audit(c.get("container").db, { companyId: null, actor: { kind: "user", id: s.user.id, name: s.user.name ?? s.user.email }, action: "admin.bypass", reason: `csp report reviewed: ${body.disposition.trim()}`, target: { type: "integration", id: c.req.param("id") ?? "" } });
  return c.json({ ok: true });
});

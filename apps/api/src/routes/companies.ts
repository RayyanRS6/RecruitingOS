import { Hono, type Context } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { CreateCompany, InviteMember, UpdateCompany, UpdateMember } from "@ros/contracts";
import { assertCan, audit, emit, raiseAlert, setActiveCompany, revokeStaffGrant } from "@ros/core";
import { auditRecords, companies, entitlements as entitlementRows, plans, recruiterEscalations, roles, staffAccessGrants, users, withPlatform, withTenant } from "@ros/db";
import { actorOf, requireTenant, requireUser, type Vars } from "../middleware/session";
import { createCompany } from "../services/companies";
import { inviteMember, listInvitations, listTeam, resendMemberInvitation, revokeMemberInvitation, updateMember } from "../services/team";
import { HttpError } from "../middleware/errors";

export const companyRoutes = new Hono<Vars>();

companyRoutes.post("/", requireUser, async (c) => {
  const body = CreateCompany.parse(await c.req.json());
  const s = c.get("session")!;
  const container = c.get("container");
  const company = await createCompany(container.db, body, s.user.id, actorOf(c));
  await setActiveCompany(container.db, s.sessionId, company.id);
  await withTenant(container.db, company.id, (tx) => container.engine.start(tx, { workflowKey: "stuck_role_detector", companyId: company.id, subject: { type: "company", id: company.id }, state: { companyId: company.id }, idempotencyKey: `stuck_role_detector:${company.id}`, actor: actorOf(c) }));
  await container.kick();
  return c.json(company, 201);
});

companyRoutes.get("/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const [co] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const [plan] = await tx.select().from(plans).where(eq(plans.key, co.planKey)).limit(1);
    const ents = await tx.select().from(entitlementRows).where(eq(entitlementRows.companyId, t.companyId));
    const usage = Object.fromEntries(ents.map((e) => [e.key, { used: e.used, limit: e.limit }]));
    return { ...co, plan: plan ? { key: plan.key, name: plan.name, limits: plan.limits } : null, usage };
  });
  return c.json({ ...row, integrations: container.integrations.statuses(), ai: { provider: container.ai.provider.id } });
});

companyRoutes.patch("/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.update");
  const body = UpdateCompany.parse(await c.req.json());
  const container = c.get("container");
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const [existing] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1);
    const patch: Partial<typeof companies.$inferInsert> = {};
    if (body.name) patch.name = body.name;
    if (body.timezone) patch.timezone = body.timezone;
    if (body.locations) patch.locations = body.locations;
    if (body.sizeBand) patch.sizeBand = body.sizeBand;
    if (body.vertical) patch.vertical = body.vertical.toLowerCase();
    if (body.settings || body.website) patch.settings = { ...existing.settings, ...(body.settings ?? {}), ...(body.website ? { website: body.website } : {}) };
    const [updated] = await tx.update(companies).set(patch).where(eq(companies.id, t.companyId)).returning();
    await emit(tx, { type: "company.updated", companyId: t.companyId, actor: actorOf(c), subject: { type: "company", id: t.companyId }, payload: { fields: Object.keys(patch) } });
    return updated;
  });
  return c.json(row);
});

/** The team (docs/spec/21, area A): active members with their scheduling readiness; never a credential or its reference. */
companyRoutes.get("/current/members", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  return c.json(await listTeam({ tenant: t, container: c.get("container") }));
});

/** Open invitations: who was asked, as what, by whom, and until when. Everyone on the team may see them. */
companyRoutes.get("/current/invitations", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  return c.json(await listInvitations({ tenant: t, container: c.get("container") }));
});

const teamOf = (c: Context<Vars>) => ({ tenant: c.get("tenant")!, actor: actorOf(c), container: c.get("container") });
const inviterNameOf = (c: Context<Vars>) => c.get("session")!.user.name ?? c.get("session")!.user.email;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A path id that is not even a uuid names nothing: a 404 in the route's own words, never a database error. */
function idParam(c: Context<Vars>, name: string, message: string): string {
  const value = c.req.param(name) ?? "";
  if (!UUID.test(value)) throw new HttpError(404, "not_found", message);
  return value;
}

/**
 * Invites someone by email: one message through the outbox with a link to the invitation page, where they sign in with
 * Google or Microsoft using the invited address. Mounted on both spellings of the path.
 */
async function invite(c: Context<Vars>) {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  const body = InviteMember.parse(await c.req.json());
  return c.json(await inviteMember(teamOf(c), { body, inviterName: inviterNameOf(c) }), 201);
}
companyRoutes.post("/current/members/invite", requireTenant, invite);
companyRoutes.post("/current/invites", requireTenant, invite);

companyRoutes.post("/current/invitations/:id/resend", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  return c.json(await resendMemberInvitation(teamOf(c), { invitationId: idParam(c, "id", "No open invitation with that id."), inviterName: inviterNameOf(c) }));
});

companyRoutes.post("/current/invitations/:id/revoke", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  return c.json(await revokeMemberInvitation(teamOf(c), { invitationId: idParam(c, "id", "No open invitation with that id.") }));
});

/** A role change or a removal; the rules live in services/team.ts. Either ends the person's sessions so it applies at once. */
companyRoutes.patch("/current/members/:userId", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  const body = UpdateMember.parse(await c.req.json());
  return c.json(await updateMember(teamOf(c), { userId: idParam(c, "userId", "That person is not an active member of your team."), body }));
});

/** ITS recruiter access to this company: who, why, what it covers, when it ends. Everyone on the team can see it. */
companyRoutes.get("/current/staff-access", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const container = c.get("container");
  const grants = await withTenant(container.db, t.companyId, async (tx) => {
    const list = await tx.select({ id: staffAccessGrants.id, userId: staffAccessGrants.userId, kind: staffAccessGrants.kind, purpose: staffAccessGrants.purpose, escalationId: staffAccessGrants.escalationId, roleId: staffAccessGrants.roleId, applicationId: staffAccessGrants.applicationId, startsAt: staffAccessGrants.startsAt, expiresAt: staffAccessGrants.expiresAt, endedAt: staffAccessGrants.endedAt, revokedAt: staffAccessGrants.revokedAt, revokeReason: staffAccessGrants.revokeReason })
      .from(staffAccessGrants).where(eq(staffAccessGrants.companyId, t.companyId)).orderBy(desc(staffAccessGrants.createdAt)).limit(100);
    const out = [];
    for (const g of list) {
      const role = g.roleId ? (await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, g.roleId)).limit(1))[0] : null;
      out.push({ ...g, roleTitle: role?.title ?? null, active: !g.endedAt && Date.parse(g.expiresAt) > Date.now() });
    }
    return out;
  });
  // Recruiters are not members, so the tenant role cannot see their user rows; name them from the platform side (name and email only).
  const rows = [];
  for (const g of grants) {
    const [u] = await container.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, g.userId)).limit(1);
    const { userId: _omit, ...rest } = g;
    rows.push({ ...rest, recruiterName: u?.name ?? null, recruiterEmail: u?.email ?? "" });
  }
  return c.json(rows);
});

/**
 * Ends a recruiter's access now (item 1 of the 21 Sep instruction): owner or admin only, confirmation and a reason
 * required, the recruiter told, the request returned to the queue, everything recorded in the customer's own history.
 */
companyRoutes.post("/current/staff-access/:grantId/revoke", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "staff_access.revoke");
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string; confirm?: boolean };
  if (body.confirm !== true) throw new HttpError(400, "confirmation_required", "Confirm that you want to end this recruiter's access now.");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 5) throw new HttpError(400, "reason_required", "Say why you are ending the access; the recruiter and your activity log will show it.");
  const container = c.get("container");
  const now = container.engine.clock();
  const actor = actorOf(c);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.req.param("grantId") ?? "")) throw new HttpError(404, "not_found", "No active recruiter access with that id.");
  // The tenant role may read grants but never write them (migration 0004); the revocation runs on the platform side,
  // scoped to the signed-in customer's own company (the company id comes from the session, never from the request).
  const result = await withPlatform(container.db, async (tx) => {
    const r = await revokeStaffGrant(tx, { grantId: c.req.param("grantId") ?? "", companyId: t.companyId, actor, reason, now });
    if (!r) throw new HttpError(404, "not_found", "No active recruiter access with that id.");
    if (r.escalationId) {
      const [esc] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, r.escalationId)).limit(1);
      if (esc && esc.assignedToUserId === r.recruiterUserId && !["resolved", "cancelled"].includes(esc.status)) {
        await tx.update(recruiterEscalations).set({ assignedToUserId: null, status: "open", accessExpiresAt: null }).where(eq(recruiterEscalations.id, esc.id));
      }
    }
    const [recruiter] = await tx.select({ email: users.email, name: users.name }).from(users).where(eq(users.id, r.recruiterUserId)).limit(1);
    const [company] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
    return { ...r, recruiter, companyName: company?.name ?? "the customer" };
  });
  // Tell the recruiter and the queue. Neither message carries candidate data.
  const from = `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`;
  let recruiterNotified = false;
  if (result.recruiter?.email) {
    const sent = await container.integrations.email.send({ to: result.recruiter.email, from, subject: `Your access to ${result.companyName} was ended by the customer`, text: `${actor.name ?? "The customer"} at ${result.companyName} ended your access just now.\nReason: ${reason}\n\n${result.escalationId ? "The request is back in the queue, unassigned. " : ""}Do not keep or use any copies of the customer's information.`, idempotencyKey: `grant_revoked:${result.grant.id}`, tags: { template: "staff_access_revoked" } });
    recruiterNotified = sent.status !== "failed";
    if (sent.status === "failed") {
      // Never tell the customer the recruiter was told when they were not: record it and put it in front of ITS.
      await raiseAlert(container.db, { kind: "recruiter.notify_failed", severity: "high", title: "A recruiter was not told their access ended", body: `The customer ended a recruiter's access but the email to the recruiter failed (${sent.error}). Tell them another way.`, companyId: t.companyId, target: { type: "user", id: result.recruiterUserId }, details: { grantId: result.grant.id, error: sent.error } });
      await audit(container.db, { companyId: t.companyId, actor: { kind: "system", id: "email" }, action: "staff.access_revoked", target: { type: "user", id: result.recruiterUserId }, reason: "recruiter notification failed", details: { grantId: result.grant.id, error: sent.error } });
    }
  }
  await container.integrations.email.send({ to: container.env.ITS_QUEUE_EMAIL, from, subject: `[access ended] ${result.companyName} ended a recruiter's access`, text: `Recruiter: ${result.recruiter?.name ?? result.recruiter?.email ?? result.recruiterUserId}\nReason given by the customer: ${reason}\n${result.escalationId ? `The request is open again in the queue: ${container.env.APP_BASE_URL}/recruiter/queue/${result.escalationId}` : ""}`, idempotencyKey: `grant_revoked_queue:${result.grant.id}`, tags: { template: "staff_access_revoked_queue" } });
  return c.json({ ok: true, grantId: result.grant.id, endedAt: now.toISOString(), escalationId: result.escalationId, recruiterNotified });
});

/**
 * The customer's own audit history for recruiter access (21 Sep, item 1): who was granted what, when it ended and why,
 * with the person who acted. Members with events.read; never ITS staff acting under a grant.
 */
const CUSTOMER_AUDIT_ACTIONS = new Set(["staff.access_granted", "staff.access_ended", "staff.access_revoked", "admin.break_glass"]);
companyRoutes.get("/current/audit", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  if (t.staff) throw new HttpError(403, "forbidden", "Staff cannot read the customer's audit history.");
  assertCan(t.role, "events.read");
  const wanted = (c.req.query("actions") ?? "").split(",").map((a) => a.trim()).filter((a) => CUSTOMER_AUDIT_ACTIONS.has(a));
  const actions = wanted.length ? wanted : [...CUSTOMER_AUDIT_ACTIONS];
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? "50") || 50));
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select({ id: auditRecords.id, action: auditRecords.action, actor: auditRecords.actor, reason: auditRecords.reason, target: auditRecords.target, details: auditRecords.details, createdAt: auditRecords.createdAt }).from(auditRecords).where(and(eq(auditRecords.companyId, t.companyId), inArray(auditRecords.action, actions))).orderBy(desc(auditRecords.createdAt)).limit(limit));
  return c.json(rows.map((r) => ({ id: r.id, action: r.action, actor: { kind: r.actor.kind, name: r.actor.name ?? null }, reason: r.reason, target: r.target, at: r.createdAt, details: { grantId: (r.details as { grantId?: string }).grantId ?? null, scope: (r.details as { scope?: unknown }).scope ?? null, kind: (r.details as { kind?: string }).kind ?? null } })));
});

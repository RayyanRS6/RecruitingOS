import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { RecruiterCallNotes } from "@ros/contracts";
import { assertCan } from "@ros/core";
import { applications, roles, withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { addRecruiterCallNotes, roleScreeningFunnel } from "../services/screens";

/**
 * The screening conversation's team-facing routes (plan Wave E): how the conversation goes for a role (E13), and a
 * recruiter's notes from a call with a candidate who asked for a person (E3).
 */
export const screenRoleRoutes = new Hono<Vars>();
screenRoleRoutes.use("/:id/*", roleScopeGuard);

/**
 * GET /api/v1/roles/:id/screening: offered, started, finished, median minutes, the drop-off question, who chose a person,
 * skips. Counted over the role's whole group, so an ITS grant about one candidate is refused, as for the closing message.
 */
screenRoleRoutes.get("/:id/screening", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  if (t.staff?.scope.applicationId) throw new HttpError(403, "staff_scope", "Your access covers one candidate, so you can't see how the screening chat goes for the role's whole group.");
  const funnel = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, c.req.param("id") ?? "")).limit(1);
    return role ? roleScreeningFunnel(tx, role.id) : null;
  });
  if (!funnel) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(funnel);
});

export const screenApplicationRoutes = new Hono<Vars>();
screenApplicationRoutes.use("/:id/*", applicationScopeGuard);

/**
 * POST /api/v1/applications/:id/screen/recruiter-notes (E3): the recruiter who called the candidate adds what they
 * learned, per question where it fits, and (by default) closes the conversation as complete so the scorecard is written.
 * For whoever works recruiter requests (an ITS recruiter under their grant, or the company's own recruiter).
 */
screenApplicationRoutes.post("/:id/screen/recruiter-notes", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "escalation.work");
  const body = RecruiterCallNotes.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id") ?? "")).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    return addRecruiterCallNotes(tx, container, { app, notes: body.notes, complete: body.complete, actor: actorOf(c) });
  });
  await container.kick();
  return c.json({ ok: true, ...result });
});

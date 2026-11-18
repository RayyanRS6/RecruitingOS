import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { assertCan } from "@ros/core";
import { roles, withTenant } from "@ros/db";
import { requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { roleScreeningFunnel } from "../services/screens";

/** The screening conversation's team-facing route (plan Wave E): how the conversation goes for a role (E13). */
export const screenRoleRoutes = new Hono<Vars>();
screenRoleRoutes.use("/:id/*", roleScopeGuard);

/**
 * GET /api/v1/roles/:id/screening: offered, started, finished, median minutes, the drop-off question, who chose a person,
 * skips. Counted over the role's whole group.
 */
screenRoleRoutes.get("/:id/screening", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const funnel = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, c.req.param("id") ?? "")).limit(1);
    return role ? roleScreeningFunnel(tx, role.id) : null;
  });
  if (!funnel) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(funnel);
});

import { Hono } from "hono";
import { z } from "zod";
import { SendNewTimesBatch } from "@ros/contracts";
import { assertCan } from "@ros/core";
import { withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { sendNewTimes, sendNewTimesBatch, stopNewTimes } from "../services/new-times";

/**
 * New times for people under Cancelled (the Cancelled column, founder decisions 2A and 4A): "Send new times" to one
 * person, "Don't send automatically" for one person's automatic set, and "Send new times" to several people of a role.
 * Under `interview.manage`; a new interview for someone who did not come also needs `interview.request` (services/new-times.ts).
 */
const NoBody = z.object({}).strict();

export const applicationNewTimesRoutes = new Hono<Vars>();
applicationNewTimesRoutes.use("/:id/*", applicationScopeGuard);

applicationNewTimesRoutes.post("/:id/new-times", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  NoBody.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, (tx) => sendNewTimes(tx, container, { companyId: t.companyId, applicationId: c.req.param("id"), actor: actorOf(c), role: t.role, approvedBy: t.userId, via: "person", now: container.engine.clock() }));
  await container.kick();
  return c.json(result);
});

applicationNewTimesRoutes.post("/:id/new-times/stop", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  NoBody.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, (tx) => stopNewTimes(tx, container, { companyId: t.companyId, applicationId: c.req.param("id"), actor: actorOf(c), role: t.role, now: container.engine.clock() }));
  await container.kick();
  return c.json(result);
});

export const roleNewTimesRoutes = new Hono<Vars>();
roleNewTimesRoutes.use("/:id/*", roleScopeGuard);

roleNewTimesRoutes.post("/:id/new-times", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "interview.manage");
  const body = SendNewTimesBatch.parse(await c.req.json());
  const container = c.get("container");
  const result = await sendNewTimesBatch(container, { roleId: c.req.param("id"), tenant: t, actor: actorOf(c), body });
  await container.kick();
  return c.json(result);
});

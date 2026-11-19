import { Hono } from "hono";
import { assertCan } from "@ros/core";
import { withTenant } from "@ros/db";
import { requireTenant, type Vars } from "../middleware/session";
import { homeView } from "../services/home";

/** Home, under /api/v1/home: one call for the whole page. */
export const homeRoutes = new Hono<Vars>();

homeRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const container = c.get("container");
  return c.json(await withTenant(container.db, t.companyId, (tx) => homeView(tx, container, t)));
});

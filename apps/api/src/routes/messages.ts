import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { SendCandidateMessage } from "@ros/contracts";
import { assertCan } from "@ros/core";
import { applications, withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { composeMessagePreview, sendCandidateMessage } from "../services/messages";

/**
 * Writing to a candidate from their sheet (docs/spec/21 F11). Mounted under /api/v1/applications beside the
 * application routes; the scope guard keeps ITS staff inside their grant like everywhere else.
 */
export const messageRoutes = new Hono<Vars>();
messageRoutes.use("/:id/*", applicationScopeGuard);

/** Who the message goes to, the footer that follows it, and whether this person's message would wait for an approval. */
messageRoutes.get("/:id/messages/preview", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const container = c.get("container");
  const actor = actorOf(c);
  const row = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    if (!app) return null;
    return composeMessagePreview(tx, container, { app, tenant: t, senderName: actor.name ?? "A member of the hiring team" });
  });
  if (!row) throw new HttpError(404, "not_found", "Application not found.");
  return c.json(row);
});

/** 201 when the message is queued for sending; 202 when it waits for an owner or admin. */
messageRoutes.post("/:id/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const body = SendCandidateMessage.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    return sendCandidateMessage(tx, container, { app, tenant: t, actor: actorOf(c), body });
  });
  await container.kick();
  return c.json(result, result.status === "queued" ? 201 : 202);
});

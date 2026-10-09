import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { SendCandidateMessage, SuggestMessageLine } from "@ros/contracts";
import { assertCan, can } from "@ros/core";
import { applications, communications, withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { composeMessagePreview, sendCandidateMessage, suggestLine, undoMessage } from "../services/messages";

/**
 * Writing to a candidate from their sheet (docs/spec/21 F11). Mounted under /api/v1/applications beside the
 * application routes; the scope guard keeps ITS staff inside their grant like everywhere else.
 */
export const messageRoutes = new Hono<Vars>();
messageRoutes.use("/:id/*", applicationScopeGuard);

/** Who the message goes to, the footer that follows it (and `aiFooter`), whether this person's message would wait for an approval, and `undoSeconds`. */
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

/**
 * 201 when the message is in the outbox: queued for sending (with `undoUntil` while the Undo window holds it, plan G9),
 * or held until ITS confirms the company (`status: "held"`, founder decision B7); 202 when it waits for an owner or admin.
 * `aiHelped: true` when the person kept a line the assistant suggested: the footer then says so (Q28).
 */
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
  return c.json(result, result.status === "pending_approval" ? 202 : 201);
});

/**
 * The assistant's suggested line for an interview invitation or an update (`SuggestMessageLine` → `SuggestedLine`, Q28).
 * Never for a decision message. The page shows it as a suggestion; nothing is sent from here.
 */
messageRoutes.post("/:id/messages/suggest", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const body = SuggestMessageLine.parse(await c.req.json().catch(() => ({})));
  return c.json(await suggestLine(c.get("container"), { tenant: t, applicationId: c.req.param("id") ?? "", body }));
});

/**
 * Undo (plan G9): takes back a message someone on the team sent, while it still waits in the outbox. A decision or
 * closing message needs the right to tell candidates decisions; a written message, the right to write to them. Answers
 * `{ ok, communicationId, toldState }` (the told state after taking back a decision message: not told again). 409
 * `already_sent` once it has gone; 404 for a message that is not this candidate's.
 */
messageRoutes.post("/:id/messages/:communicationId/undo", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.req.param("communicationId") ?? "")) throw new HttpError(404, "not_found", "That message was not found.");
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    const [msg] = await tx.select({ templateKey: communications.templateKey }).from(communications).where(eq(communications.id, c.req.param("communicationId"))).limit(1);
    if (msg?.templateKey?.startsWith("disposition:") && !can(t.role, "application.reject")) throw new HttpError(403, "forbidden", "Your role can't tell candidates about a decision, so it can't take a decision message back either.");
    return undoMessage(tx, container, { app, communicationId: c.req.param("communicationId") ?? "", tenant: t, actor: actorOf(c) });
  });
  return c.json(result);
});

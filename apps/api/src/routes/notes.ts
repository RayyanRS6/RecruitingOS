import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { WriteNote } from "@ros/contracts";
import { applications, withTenant, type Tx } from "@ros/db";
import { actorOf, applicationScopeGuard, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { notesView, removeOwnNote, writeOwnNote } from "../services/notes";

/**
 * Private team notes on a candidate (founder decision Q24; plan H3), under /applications/:id. Who may read and write is
 * decided in services/notes.ts: the note permissions, or an interviewer's own note on someone they interviewed. An ITS
 * recruiter under a grant reaches only the candidates the grant names (applicationScopeGuard).
 */
export const noteRoutes = new Hono<Vars>();
noteRoutes.use("/:id/*", applicationScopeGuard);

async function applicationIn(tx: Tx, companyId: string, id: string) {
  const [app] = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? await tx.select({ id: applications.id, companyId: applications.companyId }).from(applications).where(and(eq(applications.id, id), eq(applications.companyId, companyId))).limit(1) : [];
  if (!app) throw new HttpError(404, "not_found", "Application not found.");
  return app;
}

/** The notes this person may read (everyone's, or an interviewer's own), their own note, and whether they may write one. */
noteRoutes.get("/:id/notes", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const view = await withTenant(container.db, t.companyId, async (tx) => {
    const app = await applicationIn(tx, t.companyId, c.req.param("id"));
    return notesView(tx, { applicationId: app.id, tenant: t, now: container.engine.clock() });
  });
  return c.json(view);
});

/** Writes or changes the person's own note (one each per candidate). 201 when it is new, 200 when it changed or was the same. */
noteRoutes.put("/:id/notes/mine", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = WriteNote.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const app = await applicationIn(tx, t.companyId, c.req.param("id"));
    return writeOwnNote(tx, { companyId: t.companyId, applicationId: app.id, tenant: t, actor: actorOf(c), note: body, now: container.engine.clock() });
  });
  return c.json({ note: result.note, changed: result.changed }, result.created ? 201 : 200);
});

/** Removes the person's own note. */
noteRoutes.delete("/:id/notes/mine", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const app = await applicationIn(tx, t.companyId, c.req.param("id"));
    return removeOwnNote(tx, { companyId: t.companyId, applicationId: app.id, tenant: t, actor: actorOf(c), now: container.engine.clock() });
  });
  return c.json({ ok: true, removed: result.noteId });
});

import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { ApplicationAction, BulkApplicationAction, CV_FILE_STATUS_LABEL, CandidateListQuery, type CvFileStatus } from "@ros/contracts";
import { assertCan, audit } from "@ros/core";
import { documents, withTenant } from "@ros/db";
import { actorOf, clientIp, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { DOWNLOAD_URL_TTL_SECONDS, safeFilename } from "../uploads";
import { decisionPreview, performAction, performBulkAction } from "../services/application-actions";
import { candidateList, candidatePanel } from "../services/candidates";

/** The candidates of one job, under /api/v1/roles/:id. */
export const candidateRoleRoutes = new Hono<Vars>();
candidateRoleRoutes.use("/:id/*", roleScopeGuard);

/** One tab of a job's Candidates list (`?tab=`, New when left out), with the counts of every tab and the locked cards. */
candidateRoleRoutes.get("/:id/applications", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const { tab } = CandidateListQuery.parse({ tab: c.req.query("tab") });
  const container = c.get("container");
  const list = await withTenant(container.db, t.companyId, (tx) => candidateList(tx, container, { roleId: c.req.param("id"), tab }));
  if (!list) throw new HttpError(404, "not_found", "Job not found.");
  return c.json(list);
});

/** The same action for several ticked people of this job: one result for each, a refusal never blocking the rest. */
candidateRoleRoutes.post("/:id/applications/actions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const body = BulkApplicationAction.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const out = await performBulkAction(container, { tenant: t, actor: actorOf(c) }, c.req.param("id"), body);
  await container.kick();
  return c.json(out);
});

/** One candidate, under /api/v1/applications/:id. */
export const applicationRoutes = new Hono<Vars>();

/** The candidate panel. Opening it is recorded in the audit history. */
applicationRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const panel = await withTenant(container.db, t.companyId, (tx) => candidatePanel(tx, container, { applicationId: c.req.param("id"), companyId: t.companyId, actor: actorOf(c) }));
  if (!panel) throw new HttpError(404, "not_found", "Application not found.");
  return c.json(panel);
});

/** One action for one person: 409 `action_not_allowed` with the reason, or 402 `limit_reached` when the plan stops it. */
applicationRoutes.post("/:id/actions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const body = ApplicationAction.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const { result } = await withTenant(container.db, t.companyId, (tx) => performAction(tx, container, { tenant: t, actor: actorOf(c) }, { applicationId: c.req.param("id"), action: body.action }));
  await container.kick();
  return c.json(result);
});

/** The exact email "Email the decision" sends to this person. 404 when they are not marked Not selected. */
applicationRoutes.get("/:id/decision-message", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const preview = await withTenant(c.get("container").db, t.companyId, (tx) => decisionPreview(tx, c.req.param("id")));
  if (!preview) throw new HttpError(404, "not_found", "There is no decision to tell this candidate about.");
  return c.json(preview);
});

/** Why a CV file that is not clean cannot be opened, in the words the panel shows in its place. */
const notAvailable = (status: string): HttpError => new HttpError(409, "not_available", CV_FILE_STATUS_LABEL[(status in CV_FILE_STATUS_LABEL ? status : "deleted") as CvFileStatus]);

/**
 * The CV file itself: only a checked and scanned document, only to a member who may read the application, only through
 * a short-lived single-object link, and every read is audited with who and which file.
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
  if (!found.url) throw notAvailable(found.doc.status);
  return c.redirect(found.url, 302);
});

/**
 * The CV inside the candidate panel: the same checks and the same `document.read` audit as the file itself, served from
 * this origin with an inline disposition so the panel can show it in a frame of its own page. A PDF comes back as
 * itself; a Word or text file, which browsers do not show as it is, comes back as its extracted text (`?as=text` asks
 * for the text of a PDF too). Never cached; only this origin's own pages may frame it.
 */
applicationRoutes.get("/:id/documents/:documentId/inline", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const wantsText = c.req.query("as") === "text";
  const found = await withTenant(container.db, t.companyId, async (tx) => {
    const [doc] = await tx.select().from(documents).where(and(eq(documents.id, c.req.param("documentId")), eq(documents.applicationId, c.req.param("id")))).limit(1);
    if (!doc) return null;
    if (doc.status !== "clean") throw notAvailable(doc.status);
    const asText = wantsText || doc.mime !== "application/pdf";
    if (asText && !doc.textExtracted) throw new HttpError(409, "no_text", "We could not read the text of this file. Open it in a new tab instead.");
    const bytes = asText ? null : await container.integrations.storage.get(doc.storageKey);
    if (!asText && !bytes) throw new HttpError(409, "not_available", "This file could not be found. Open it in a new tab, or ask the candidate to send it again.");
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "document.read", target: { type: "document", id: doc.id }, ip: clientIp(c), details: { applicationId: doc.applicationId, filename: safeFilename(doc.filename), view: asText ? "text" : "inline" } });
    return { doc, text: asText ? doc.textExtracted : null, bytes };
  });
  if (!found) throw new HttpError(404, "not_found", "Document not found.");
  const name = safeFilename(found.doc.filename);
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "SAMEORIGIN");
  if (found.text !== null) {
    // Plain text runs nothing; the policy says so anyway, and the frame may only be this origin's.
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
    c.header("Content-Disposition", `inline; filename="${name.replace(/\.[a-z0-9]+$/i, "")}.txt"`);
    return c.body(found.text, 200, { "Content-Type": "text/plain; charset=utf-8" });
  }
  // A browser's PDF viewer does not run in a sandboxed frame, so the policy limits who may frame it and nothing more.
  c.header("Content-Security-Policy", "frame-ancestors 'self'");
  c.header("Content-Disposition", `inline; filename="${name}"`);
  return c.body(found.bytes!.slice().buffer as ArrayBuffer, 200, { "Content-Type": "application/pdf" });
});

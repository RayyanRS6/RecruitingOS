import { Hono } from "hono";
import { assertCan, audit } from "@ros/core";
import { withTenant } from "@ros/db";
import { actorOf, clientIp, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { APPLICANT_COLUMNS, SUMMARY_COLUMNS, applicantRows, csvFilename, roleReport, summaryRows, toCsv } from "../services/role-report";

/**
 * The role report for the customer (docs/spec/21 section 7, P1): the ten figures as JSON for the Report tab, the
 * applicant list as a CSV file, and the figures as a CSV file. Mounted under /api/v1/roles next to the role routes.
 * Interviewers hold role.read but not application.read; the figures come from the applications, so they are refused.
 * ITS staff under a grant reach only the grant's role (roleScopeGuard), and when the grant names one candidate the
 * figures (JSON and summary CSV) count that candidate alone and the applicant list holds their row alone, as the role's
 * applications list does: no other applicant's id or count.
 */
export const reportRoutes = new Hono<Vars>();
reportRoutes.use("/:id/*", roleScopeGuard);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleIdOf(id: string | undefined): string {
  if (!id || !UUID.test(id)) throw new HttpError(404, "not_found", "Role not found.");
  return id;
}

function csvResponse(body: string, filename: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
}

reportRoutes.get("/:id/report", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const roleId = roleIdOf(c.req.param("id"));
  const report = await withTenant(container.db, t.companyId, (tx) => roleReport(tx, { companyId: t.companyId, roleId, now: container.engine.clock(), onlyApplicationId: t.staff?.scope.applicationId ?? null }));
  if (!report) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(report);
});

/** The applicant list. Names are in the file, so every download is audited with who, which role and how many rows. */
reportRoutes.get("/:id/report.csv", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const roleId = roleIdOf(c.req.param("id"));
  const now = container.engine.clock();
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const list = await applicantRows(tx, { companyId: t.companyId, roleId, now, onlyApplicationId: t.staff?.scope.applicationId ?? null });
    if (!list) return null;
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "report.exported", target: { type: "role", id: roleId }, ip: clientIp(c), details: { kind: "applicants", rows: list.rows.length } });
    return list;
  });
  if (!result) throw new HttpError(404, "not_found", "Role not found.");
  const body = toCsv([[...APPLICANT_COLUMNS], ...result.rows.map((r) => APPLICANT_COLUMNS.map((col) => r[col]))]);
  return csvResponse(body, csvFilename(result.role.title, "applicants", now));
});

/** The figures as rows: the same numbers as the Report tab, for a spreadsheet or the weekly summary. */
reportRoutes.get("/:id/report/summary.csv", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const roleId = roleIdOf(c.req.param("id"));
  const now = container.engine.clock();
  const report = await withTenant(container.db, t.companyId, async (tx) => {
    const r = await roleReport(tx, { companyId: t.companyId, roleId, now, onlyApplicationId: t.staff?.scope.applicationId ?? null });
    if (!r) return null;
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "report.exported", target: { type: "role", id: roleId }, ip: clientIp(c), details: { kind: "summary" } });
    return r;
  });
  if (!report) throw new HttpError(404, "not_found", "Role not found.");
  const body = toCsv([[...SUMMARY_COLUMNS], ...summaryRows(report)]);
  return csvResponse(body, csvFilename(report.role?.title ?? "role", "summary", now));
});

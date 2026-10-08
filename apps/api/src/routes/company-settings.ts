import { Hono, type Context } from "hono";
import { and, desc, eq, gte, inArray, lt, lte, or } from "drizzle-orm";
import { GettingStartedRequest, UpdateCompany } from "@ros/contracts";
import { DEFAULT_NOTICES, applyNoticeOverrides, assertCan, audit, emit, revokeAllSessions } from "@ros/core";
import { auditRecords, companies, memberships, withPlatform, withTenant } from "@ros/db";
import { actorOf, clientIp, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { assertRecentAuth } from "../middleware/reauth";
import { CUSTOMER_AUDIT_ACTIONS, auditCsv, customerAuditRow, isoTime } from "../services/audit-history";
import { dismissGettingStarted, markPoliciesReviewed } from "../services/company-trust";

/**
 * Company preferences, the customer's audit history and member sign-out (audit findings A8, A9, A11, J16). Mounted
 * under /api/v1/companies next to routes/companies.ts, which keeps the company itself, the team and recruiter access.
 */
export const companySettingsRoutes = new Hono<Vars>();

/** Keys a customer may never set here; naming them gives a plain answer instead of a generic validation error. */
const ADMIN_ONLY_COMPANY_KEYS: Record<string, string> = {
  planKey: "the plan", plan: "the plan", status: "the account status", slug: "the careers page address", vertical: "the kind of business", id: "the company id", entitlements: "the allowances", usage: "the allowances",
};
const ADMIN_ONLY_SETTINGS_KEYS: Record<string, string> = { pilot: "the pilot term", retention: "the retention periods", brief: "the daily brief settings", entitlements: "the allowances", plan: "the plan", verifiedAt: "the ITS company check", verifiedBy: "the ITS company check", onboarding: "the getting-started checklist" };

function refuseAdminOnlyKeys(raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) if (ADMIN_ONLY_COMPANY_KEYS[k]) throw new HttpError(400, "not_yours_to_change", `You cannot change ${ADMIN_ONLY_COMPANY_KEYS[k]} here. Identified Talent Solutions sets it; ask them.`, { field: k });
  const settings = body.settings;
  if (settings && typeof settings === "object") for (const k of Object.keys(settings as Record<string, unknown>)) if (ADMIN_ONLY_SETTINGS_KEYS[k]) throw new HttpError(400, "not_yours_to_change", `You cannot change ${ADMIN_ONLY_SETTINGS_KEYS[k]} here. Identified Talent Solutions sets it; ask them.`, { field: `settings.${k}` });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Preferences owners and admins change themselves: name, website, locations, time zone, size, careers-page intro,
 * benefits summary, logo, contact hours and the wording of the candidate notices. Every change is audited with the
 * keys that changed and emitted; a reworded notice gets a new version (the date) that the candidate pages show from
 * then on. Rewording a notice needs a fresh sign-in (audit finding A12).
 */
companySettingsRoutes.patch("/current", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.update");
  if (t.staff) throw new HttpError(403, "forbidden", "Recruiters cannot change a customer's company settings.");
  const raw = await c.req.json().catch(() => { throw new HttpError(400, "invalid_request", "Send the changes as JSON."); });
  refuseAdminOnlyKeys(raw);
  const body = UpdateCompany.parse(raw);
  if (body.settings?.notices) assertRecentAuth(c);
  const container = c.get("container");
  const now = container.engine.clock();
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    // Locked: the settings are written back whole, so an ITS confirmation made meanwhile (services/company-trust.ts) is kept.
    const [existing] = await tx.select().from(companies).where(eq(companies.id, t.companyId)).limit(1).for("update");
    if (!existing) throw new HttpError(404, "not_found", "Company not found.");
    const patch: Partial<typeof companies.$inferInsert> = {};
    const fields: string[] = [];
    if (body.name !== undefined && body.name !== existing.name) { patch.name = body.name; fields.push("name"); }
    if (body.timezone !== undefined && body.timezone !== existing.timezone) { patch.timezone = body.timezone; fields.push("timezone"); }
    if (body.sizeBand !== undefined && body.sizeBand !== existing.sizeBand) { patch.sizeBand = body.sizeBand; fields.push("sizeBand"); }
    if (body.locations !== undefined && !sameJson(body.locations, existing.locations)) { patch.locations = body.locations; fields.push("locations"); }
    const settings = { ...existing.settings };
    const s = body.settings ?? {};
    const website = body.website ?? s.website;
    if (website !== undefined && (website || "") !== (existing.settings.website ?? "")) { if (website) settings.website = website; else delete settings.website; fields.push("website"); }
    if (s.logoUrl !== undefined && (s.logoUrl || "") !== (existing.settings.logoUrl ?? "")) { if (s.logoUrl) settings.logoUrl = s.logoUrl; else delete settings.logoUrl; fields.push("logoUrl"); }
    if (s.benefitsSummary !== undefined && (s.benefitsSummary || "") !== (existing.settings.benefitsSummary ?? "")) { if (s.benefitsSummary) settings.benefitsSummary = s.benefitsSummary; else delete settings.benefitsSummary; fields.push("benefitsSummary"); }
    if (s.careersPage?.intro !== undefined && (s.careersPage.intro || "") !== (existing.settings.careersPage?.intro ?? "")) {
      settings.careersPage = { enabled: existing.settings.careersPage?.enabled ?? true, ...(s.careersPage.intro ? { intro: s.careersPage.intro } : {}) };
      fields.push("careersPage");
    }
    if (s.businessHours !== undefined && !sameJson(s.businessHours, existing.settings.businessHours ?? null)) {
      if (s.businessHours) settings.businessHours = { days: [...new Set(s.businessHours.days)].sort((a, b) => a - b), start: s.businessHours.start, end: s.businessHours.end }; else delete settings.businessHours;
      fields.push("businessHours");
    }
    let noticeChanges: ReturnType<typeof applyNoticeOverrides>["changed"] = [];
    if (s.notices) {
      const applied = applyNoticeOverrides(existing.settings.notices, s.notices, now);
      if (applied.changed.length) { settings.notices = applied.notices; fields.push("notices"); noticeChanges = applied.changed; }
    }
    if (fields.some((f) => !["name", "timezone", "sizeBand", "locations"].includes(f))) patch.settings = settings;
    if (!fields.length) return { row: existing, fields, noticeChanges };
    const [updated] = await tx.update(companies).set(patch).where(eq(companies.id, t.companyId)).returning();
    await audit(tx, { companyId: t.companyId, actor, action: "company.updated", target: { type: "company", id: t.companyId }, reason: "company settings changed", ip: clientIp(c), details: { fields, notices: noticeChanges.map((n) => n.key) } });
    for (const n of noticeChanges) await audit(tx, { companyId: t.companyId, actor, action: "notice.changed", target: { type: "company", id: t.companyId }, reason: n.version ? `reworded ${n.key}` : `standard text restored for ${n.key}`, ip: clientIp(c), details: { key: n.key, version: n.version, previousVersion: n.previousVersion } });
    await emit(tx, { type: "company.updated", companyId: t.companyId, actor, subject: { type: "company", id: t.companyId }, payload: { fields, notices: noticeChanges.map((n) => ({ key: n.key, version: n.version })) } });
    return { row: updated, fields, noticeChanges };
  });
  return c.json({ ...result.row, changed: result.fields, notices: noticesView(result.row.settings.notices) });
});

/** Every notice with the text in force for this company, the standard text, and whether the company reworded it. */
function noticesView(overrides: Record<string, { version: string; text: string; jurisdictions: string[] }> | undefined) {
  return DEFAULT_NOTICES.map((n) => {
    const o = overrides?.[n.key];
    return { key: n.key, version: o?.version ?? n.version, text: o?.text ?? n.text, jurisdictions: o?.jurisdictions ?? n.jurisdictions, overridden: !!o, defaultText: n.text, defaultVersion: n.version };
  });
}

companySettingsRoutes.get("/current/notices", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  const [co] = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, t.companyId)).limit(1));
  return c.json(noticesView(co?.settings.notices));
});

/**
 * The getting-started card on Today (plan B2): anyone on the team hides it for themselves ("dismiss"); an owner or
 * admin records that the AI rules were reviewed ("policies_reviewed", audited). Never ITS staff under a grant.
 */
companySettingsRoutes.post("/current/getting-started", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "company.read");
  if (t.staff) throw new HttpError(403, "forbidden", "The getting-started card belongs to the company's own team.");
  const body = GettingStartedRequest.parse(await c.req.json().catch(() => ({})));
  if (body.action === "policies_reviewed") assertCan(t.role, "policy.manage");
  const container = c.get("container");
  const now = container.engine.clock();
  await withTenant(container.db, t.companyId, (tx) => body.action === "dismiss"
    ? dismissGettingStarted(tx, { companyId: t.companyId, userId: t.userId, now })
    : markPoliciesReviewed(tx, { companyId: t.companyId, actor: actorOf(c), now, ip: clientIp(c) ?? undefined }));
  return c.json({ ok: true, action: body.action });
});

/* ---------------------------------------------------------------------------------------------------------- */
/* The customer's own audit history (A9): filters, pagination, and the same rows as a file.                    */
/* ---------------------------------------------------------------------------------------------------------- */

const WHEN = /^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
/** A date (2026-09-01, the whole day) or a time as the rows themselves print it; anything else is a 400 in plain words. */
function parseWhen(value: string | undefined, name: string, endOfDay = false): string | null {
  if (!value) return null;
  const iso = value.length === 10 ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : isoTime(value);
  if (!WHEN.test(value) || Number.isNaN(Date.parse(iso))) throw new HttpError(400, "invalid_request", `"${name}" must be a date like 2026-09-01.`);
  return new Date(iso).toISOString();
}

type AuditQuery = { actions: string[]; from: string | null; to: string | null; before: string | null; limit: number; exclude: string[] };

/** actions= (exact names), prefix= (for example staff.), exclude=, from=, to=, before= (a cursor: the id of the last row seen; rows after it in this order), limit=. */
function auditQueryOf(c: Context<Vars>, maxLimit: number, defaultLimit: number): AuditQuery {
  const list = (v: string | undefined) => (v ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  const prefix = (c.req.query("prefix") ?? "").trim();
  // a list that names only actions the customer may not see is honoured as an empty list, never widened to everything
  const requested = list(c.req.query("actions"));
  let actions = requested.length ? requested.filter((a) => CUSTOMER_AUDIT_ACTIONS.includes(a)) : [...CUSTOMER_AUDIT_ACTIONS];
  if (prefix) actions = actions.filter((a) => a.startsWith(prefix));
  const exclude = list(c.req.query("exclude"));
  actions = actions.filter((a) => !exclude.includes(a));
  const from = parseWhen(c.req.query("from"), "from");
  const to = parseWhen(c.req.query("to"), "to", true);
  const before = (c.req.query("before") ?? "").trim() || null;
  if (before && !UUID.test(before)) throw new HttpError(400, "invalid_request", "\"before\" must be the id of a row from this list.");
  const limit = Math.min(maxLimit, Math.max(1, Number(c.req.query("limit") ?? String(defaultLimit)) || defaultLimit));
  return { actions, from, to, before, limit, exclude };
}

async function customerAudit(c: Context<Vars>, q: AuditQuery) {
  const t = c.get("tenant")!;
  if (t.staff) throw new HttpError(403, "forbidden", "Staff cannot read the customer's audit history.");
  assertCan(t.role, "events.read");
  if (!q.actions.length) return [];
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const where = [eq(auditRecords.companyId, t.companyId), inArray(auditRecords.action, q.actions), ...(q.from ? [gte(auditRecords.createdAt, q.from)] : []), ...(q.to ? [lte(auditRecords.createdAt, q.to)] : [])];
    if (q.before) {
      // The cursor is a row, not a time: rows written in one transaction share created_at to the microsecond, and the
      // time the list prints is rounded to the millisecond, so paging on the time alone would skip siblings. The page
      // continues exactly where the order (created_at, then id, both descending) left off.
      const [cursor] = await tx.select({ id: auditRecords.id, createdAt: auditRecords.createdAt }).from(auditRecords).where(and(eq(auditRecords.companyId, t.companyId), eq(auditRecords.id, q.before))).limit(1);
      if (!cursor) throw new HttpError(400, "invalid_request", "\"before\" must be the id of a row from this list.");
      where.push(or(lt(auditRecords.createdAt, cursor.createdAt), and(eq(auditRecords.createdAt, cursor.createdAt), lt(auditRecords.id, cursor.id)))!);
    }
    return tx.select().from(auditRecords).where(and(...where)).orderBy(desc(auditRecords.createdAt), desc(auditRecords.id)).limit(q.limit);
  });
  return rows.map(customerAuditRow);
}

/**
 * Everything a customer may see of the ledger, newest first: recruiter access, team changes, rule and company changes,
 * candidate views, outcomes and exports. Members with events.read; never ITS staff acting under a grant. Page with
 * `before=<id of the last row>`.
 */
companySettingsRoutes.get("/current/audit", requireTenant, async (c) => c.json(await customerAudit(c, auditQueryOf(c, 200, 50))));

/** The same history as a spreadsheet, up to five thousand rows; the download is itself recorded. */
companySettingsRoutes.get("/current/audit.csv", requireTenant, async (c) => {
  const q = auditQueryOf(c, 5000, 5000);
  const rows = await customerAudit(c, q);
  const t = c.get("tenant")!;
  await withTenant(c.get("container").db, t.companyId, (tx) => audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "audit.exported", target: { type: "company", id: t.companyId }, ip: clientIp(c), details: { rows: rows.length, filters: { actions: q.actions.length === CUSTOMER_AUDIT_ACTIONS.length - q.exclude.length ? "all" : q.actions, from: q.from, to: q.to } } }));
  const day = c.get("container").engine.clock().toISOString().slice(0, 10);
  return c.body(auditCsv(rows), 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="activity-${day}.csv"`, "cache-control": "no-store" });
});

/* ---------------------------------------------------------------------------------------------------------- */
/* Sign a member out everywhere (A11): owners and admins, audited.                                            */
/* ---------------------------------------------------------------------------------------------------------- */

companySettingsRoutes.post("/current/members/:userId/sign-out", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "members.manage");
  if (t.staff) throw new HttpError(403, "forbidden", "Recruiters cannot sign a customer's team out.");
  const userId = c.req.param("userId") ?? "";
  if (!UUID.test(userId)) throw new HttpError(404, "not_found", "That person is not an active member of your team.");
  if (userId === t.userId) throw new HttpError(400, "self_sign_out", "To sign yourself out everywhere, use \"Sign out everywhere else\" under Your sessions.");
  const container = c.get("container");
  const [member] = await withTenant(container.db, t.companyId, (tx) => tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.companyId, t.companyId), eq(memberships.userId, userId), eq(memberships.status, "active"))).limit(1));
  if (!member) throw new HttpError(404, "not_found", "That person is not an active member of your team.");
  const now = container.engine.clock();
  // sessions are a platform table: the tenant role cannot write them
  const ended = await withPlatform(container.db, async (tx) => {
    const n = await revokeAllSessions(tx, userId, { now });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "session.revoked", target: { type: "user", id: userId }, reason: "signed out everywhere by an owner or admin", ip: clientIp(c), details: { sessionsEnded: n, scope: "all" } });
    return n;
  });
  return c.json({ ok: true, userId, sessionsEnded: ended });
});

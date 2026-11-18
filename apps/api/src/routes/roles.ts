import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { RoleStatusChange, OwnerStage, SetClosingDate, ApplyModeChange } from "@ros/contracts";
import { resolveApplyMode } from "@ros/core";
import { withPlatform, type Tx } from "@ros/db";
import { CLOSING_DATE_REASON, assertCan, audit, can, closingDateProblem, closingDateRequired, closingDayWords, closingMoment, emit, followUpStripOf, groupFor, IN_MOTION_SQL, jobNoticesFor, lockedAndWaiting, notLocked, notify, ownerStage, payShown, payTransparencyApplies, showsOldVersion } from "@ros/core";
import { armClosingDate } from "@ros/workflows";
import { closingDateFor } from "../services/closing-date";
import { publishRole } from "../services/publish";
import { withEmptyPay } from "../services/pay-redaction";
import { assertNoNewWork } from "../services/trial";
import { currentVersionOf } from "../services/packet-versions";
import { applicationMarks, applications, approvalRequests, companies, interviewFollowups, postings, rolePackets, roles, withTenant } from "@ros/db";
import { actorOf, requirePlatformAdmin, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const roleRoutes = new Hono<Vars>();
roleRoutes.use("/:id", roleScopeGuard);
roleRoutes.use("/:id/*", roleScopeGuard);

/**
 * When anything last happened on a role, for the Jobs page's "Recent activity" order (Wave S2, additive): the latest of
 * its own changes (created, edited, opened, paused, closed) and, for those who may see applicants, its newest application.
 * An ISO time; the dates the database hands back are read with Date.parse, as `daysOpen` reads `openedAt`.
 */
export function lastActivityOf(role: { createdAt: string; updatedAt?: string | null; openedAt?: string | null; pausedAt?: string | null; closedAt?: string | null }, newestApplication?: string | null): string {
  const times = [role.createdAt, role.updatedAt, role.openedAt, role.pausedAt, role.closedAt, newestApplication].map((x) => (x ? Date.parse(x) : Number.NaN)).filter((n) => Number.isFinite(n));
  return times.length ? new Date(Math.max(...times)).toISOString() : role.createdAt;
}

roleRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const status = c.req.query("status");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const list = await tx.select().from(roles).where(status ? and(eq(roles.companyId, t.companyId), eq(roles.status, status)) : eq(roles.companyId, t.companyId)).orderBy(desc(roles.createdAt));
    const visible = list;
    if (!visible.length) return [];
    // An interviewer holds role.read but not application.read: the list names only the roles they interview for, the
    // same rule as their interviews list and the role page (roleScopeGuard), and carries no applicant counts or waiting
    // decisions (countsHidden).
    if (t.role === "interviewer") {
      const ids = await rolesInterviewedBy(tx, t.userId);
      return visible.filter((r) => ids.has(r.id)).map((r) => ({ ...r, counts: { total: 0 }, countsHidden: true, needsYou: 0, daysOpen: r.openedAt ? Math.floor((Date.now() - Date.parse(r.openedAt)) / 86_400_000) : null, lastActivityAt: lastActivityOf(r) }));
    }
    // Three queries for the whole list, whatever its length: the roles, their applicants by stage, private mark and open
    // follow-up (a running hold does not wait on you, nor does someone under Cancelled with new times promised, being
    // prepared or out; `stageCounts` is the stage strip), their open decisions. `interviewOpen` is the condition the
    // talent list and the report read through `activeFollowUpsFor`, so the three agree (J18).
    const roleIds = visible.map((r) => r.id);
    const interviewOpen = sql<boolean>`EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = ${applications.id} AND i.status IN ('proposed','scheduling'))`;
    // An interview booked or with times out waits on nobody at the company (6 November 2026; `interviewsInMotionFor`).
    const interviewInMotion = IN_MOTION_SQL;
    // Past the plan's candidates per job (Rule 3) nobody counts toward a stage, a group or a decision waiting: only the total
    // and `lockedCount` say more people applied, which names nobody and shows what an upgrade opens.
    const stageCounts = await tx
      .select({ roleId: applications.roleId, stage: applications.stage, mark: applicationMarks.mark, remindAt: applicationMarks.remindAt, kind: interviewFollowups.kind, choice: interviewFollowups.choice, autoState: interviewFollowups.autoState, interviewOpen, interviewInMotion, n: count() })
      .from(applications)
      .leftJoin(applicationMarks, and(eq(applicationMarks.applicationId, applications.id), isNull(applicationMarks.clearedAt)))
      .leftJoin(interviewFollowups, and(eq(interviewFollowups.applicationId, applications.id), isNull(interviewFollowups.resolvedAt)))
      .where(and(inArray(applications.roleId, roleIds), notLocked()))
      .groupBy(applications.roleId, applications.stage, applicationMarks.mark, applicationMarks.remindAt, interviewFollowups.kind, interviewFollowups.choice, interviewFollowups.autoState, interviewOpen, interviewInMotion);
    const lockedCounts = await tx.select({ roleId: applications.roleId, n: count() }).from(applications).where(and(inArray(applications.roleId, roleIds), lockedAndWaiting())).groupBy(applications.roleId);
    const pendingCounts = await tx.select({ roleId: approvalRequests.roleId, n: count() }).from(approvalRequests).leftJoin(applications, eq(applications.id, approvalRequests.applicationId)).where(and(inArray(approvalRequests.roleId, roleIds), eq(approvalRequests.status, "pending"), or(isNull(approvalRequests.applicationId), notLocked()))).groupBy(approvalRequests.roleId);
    // The newest application per role, for `lastActivityAt` (the Jobs page's "Recent activity" order).
    const newest = await tx.select({ roleId: applications.roleId, at: sql<string | null>`max(${applications.createdAt})` }).from(applications).where(inArray(applications.roleId, roleIds)).groupBy(applications.roleId);
    const now = c.get("container").engine.clock();
    return visible.map((r) => {
      const counts: Record<string, number> = {};
      const stageStrip: Record<string, number> = Object.fromEntries(OwnerStage.options.map((s) => [s, 0]));
      let total = 0;
      for (const row of stageCounts) {
        if (row.roleId !== r.id) continue;
        const n = Number(row.n);
        const mark = row.mark ? { mark: row.mark, remindAt: row.remindAt } : null;
        const followUp = followUpStripOf(row);
        total += n;
        const g = groupFor({ stage: row.stage }, mark, now, followUp, !!row.interviewInMotion);
        counts[g] = (counts[g] ?? 0) + n;
        stageStrip[ownerStage({ stage: row.stage }, mark, followUp)] += n;
      }
      const needsYou = Number(pendingCounts.find((p) => p.roleId === r.id)?.n ?? 0);
      // a raw max() may come back from the driver as a Date or as text
      const at = newest.find((x) => x.roleId === r.id)?.at as string | Date | null | undefined;
      const newestApplication = at instanceof Date ? at.toISOString() : at ? String(at) : null;
      const lockedCount = Number(lockedCounts.find((l) => l.roleId === r.id)?.n ?? 0);
      return { ...r, counts: { total: total + lockedCount, ...counts }, lockedCount, stageCounts: stageStrip, needsYou, daysOpen: r.openedAt ? Math.floor((Date.now() - Date.parse(r.openedAt)) / 86_400_000) : null, lastActivityAt: lastActivityOf(r, newestApplication) };
    });
  });
  return c.json(rows);
});

roleRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  // An id that is not one names no role: a plain 404, never a database error (an interviewer's is answered by roleScopeGuard).
  const id = c.req.param("id");
  if (!UUID.test(id)) throw new HttpError(404, "not_found", "Role not found.");
  const canSeeComp = can(t.role, "compensation.read");
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, id)).limit(1);
    if (!role) return null;
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const current = currentVersionOf(role, packets);
    const posts = await tx.select().from(postings).where(eq(postings.roleId, role.id));
    // Applicants by stage, for those who read applications (an interviewer gets none, as on the roles list).
    const apps = !can(t.role, "application.read") ? [] : await tx.select({ stage: applications.stage }).from(applications).where(and(eq(applications.roleId, role.id), notLocked()));
    const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.status, "pending")));
    const counts: Record<string, number> = {};
    for (const a of apps) counts[a.stage] = (counts[a.stage] ?? 0) + 1;
    // Past the plan's candidates per job (Rule 3): a number for the Candidates tab, beside stages that cover those the team can read.
    const [lockedRow] = can(t.role, "application.read") ? await tx.select({ n: count() }).from(applications).where(and(eq(applications.roleId, role.id), lockedAndWaiting())) : [];
    const lockedCount = Number(lockedRow?.n ?? 0);
    // Without compensation.read the pay section keeps its shape but carries no figure anywhere (services/pay-redaction.ts).
    const redact = (p: typeof current) => (p && !canSeeComp ? withEmptyPay(p) : p);
    // Whether candidates see the range, by the public pages' rule: the owner's choice, or a pay transparency law where the job is (plan 0.8).
    const [company] = await tx.select({ name: companies.name, locations: companies.locations, settings: companies.settings, timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const withPayView = (p: typeof current) => {
      const shown = redact(p);
      if (!p || !shown) return shown;
      const notices = jobNoticesFor({ jobLocations: p.packet.identity.locations, companyLocations: company?.locations ?? [], overrides: company?.settings.notices });
      return { ...shown, payShown: payShown(p.packet.compensation, notices), payRequiredByLaw: payTransparencyApplies(notices) };
    };
    // Waiting requests can carry a candidate's name and a message written to them (F11): only for those who read
    // applications. The approval card below reads them all.
    const visiblePending = !can(t.role, "application.read") ? [] : await withoutLockedApprovals(tx, pending);
    // A version proposed while the role runs (an edit waiting for approval): shown beside the current one, never in its place.
    const proposed = current && ["open", "paused"].includes(role.status) ? packets.find((p) => p.status === "proposed" && p.version > current.version) ?? null : null;
    const now = c.get("container").engine.clock();
    const approval = await packetApprovalView(tx, { tenant: t, role, packets, pending, now });
    // Wave D: what starts on its own once the job is live (D9), the board ticks (D6), the closing date (D7).
    const publishing = {
      autoActionsOnOpen: autoActionsOnOpen(),
      boards: boardChoices(role, current?.packet ?? null, company?.settings),
      closingDate: closingDateFor(role, company ?? null, current?.packet ?? null, now),
      boardsShowingOldVersion: posts.filter((p) => showsOldVersion(p, role.currentPacketVersion)).map((p) => p.channel),
    };
    return { ...role, currentPacket: withPayView(current), proposedPacket: withPayView(proposed), packetVersions: packets.map((p) => ({ id: p.id, version: p.version, status: p.status, source: p.source, changeSummary: p.changeSummary, createdAt: p.createdAt, createdBy: p.createdBy })), postings: posts, boardsStillUp: posts.filter((p) => p.closureRequired && !p.closureConfirmedAt).map((p) => p.channel), counts, lockedCount, pendingApprovals: visiblePending, packetApproval: approval.packetApproval, decisionMaker: approval.decisionMaker, ...publishing };
  });
  if (!row) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(row);
});

/**
 * "Publish job" on a job that is a draft: anyone on the team who may publish opens it with one press (services/publish.ts
 * runs the checks: the person's role, the plan, the wording flags, the legal check). Answers `PublishResult`.
 */
roleRoutes.post("/:id/publish", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, (tx) => publishRole(tx, container, { tenant: t, actor: actorOf(c), roleId: c.req.param("id") ?? "" }));
  await container.kick();
  return c.json(result);
});

// Pause only from open and resume only from paused (Wave 0 item 0.8): a resume must never reopen a closed role or
// open a draft, and a second click changes nothing.
for (const action of ["pause", "resume"] as const) {
  roleRoutes.post(`/:id/${action}`, requireTenant, async (c) => {
    const t = c.get("tenant")!;
    assertCan(t.role, "role.manage");
    const body = RoleStatusChange.parse(await c.req.json().catch(() => ({})));
    const container = c.get("container");
    const row = await withTenant(container.db, t.companyId, async (tx) => {
      const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
      if (!role) throw new HttpError(404, "not_found", "Role not found.");
      if (action === "pause" && role.status !== "open") throw new HttpError(409, "not_open", role.status === "paused" ? "This role is already paused." : `Only an open role can be paused. This role is ${role.status === "closed" ? "closed" : "not open yet"}.`);
      if (action === "resume" && role.status !== "paused") throw new HttpError(409, "not_paused", role.status === "closed" ? "This role is closed, so it cannot be resumed. Open a new role to hire again." : role.status === "open" ? "This role is already open." : "Only a paused role can be resumed.");
      // A trial that has ended takes no new applications (founder decision L-02 B): a paused job waits for a plan. Pausing never does.
      if (action === "resume") await assertNoNewWork(tx, t.companyId, container.engine.clock());
      const now = new Date().toISOString();
      const patch = action === "pause" ? { status: "paused", pausedAt: now } : { status: "open", pausedAt: null };
      // the state is checked again in the write itself, so two clicks at once pause (or resume) once
      const [updated] = await tx.update(roles).set(patch).where(and(eq(roles.id, role.id), eq(roles.status, action === "pause" ? "open" : "paused"))).returning();
      if (!updated) throw new HttpError(409, action === "pause" ? "not_open" : "not_paused", "Someone changed this role a moment ago. Refresh to see where it is now.");
      await emit(tx, { type: action === "pause" ? "role.paused" : "role.resumed", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { reason: body.reason ?? null } });
      return updated;
    });
    await container.kick();
    return c.json(row);
  });
}

/**
 * The closing date (founder decision Q12, plan D7): the last day new applications are taken, in the company's time
 * zone, or null to take it off. For an open or paused role the timer is set again (packages/workflows closing-date.ts);
 * a draft gets its timer when it is published. A later date on a role whose date already stopped applications takes
 * applications again ("Extend the date"). Colorado (and remote) roles keep a date: 409 `closing_date_required`. Answers `{ ok, closingDate, reopened }`.
 */
roleRoutes.post("/:id/closing-date", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.manage");
  const body = SetClosingDate.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    if (role.status === "closed") throw new HttpError(409, "role_closed", "The role is closed, so it has no closing date to change.");
    const [company] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const packet = currentVersionOf(role, packets)?.packet ?? null;
    const now = container.engine.clock();
    if (body.closesOn) {
      const problem = closingDateProblem(body.closesOn, now, company?.timezone);
      if (problem) throw new HttpError(400, "bad_closing_date", problem);
    } else if (packet && closingDateRequired({ jobLocations: packet.identity.locations, remotePolicy: packet.identity.remotePolicy })) {
      throw new HttpError(409, "closing_date_required", "The law in Colorado asks the job ad to say when applications close, and this job is there (or remote). Choose a later date instead of taking it off.");
    }
    const previous = role.applicationsCloseOn ? role.applicationsCloseOn.slice(0, 10) : null;
    const [updated] = await tx.update(roles).set({ applicationsCloseOn: body.closesOn }).where(eq(roles.id, role.id)).returning();
    await emit(tx, { type: "role.closing_date_set", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { closesOn: body.closesOn, previous } });
    await audit(tx, { companyId: t.companyId, actor, action: "role.closing_date_changed", target: { type: "role", id: role.id }, reason: body.closesOn ? `closes on ${body.closesOn}` : "closing date removed", details: { closesOn: body.closesOn, previous } });
    if (["open", "paused"].includes(role.status)) await armClosingDate(tx, container.engine, { companyId: t.companyId, roleId: role.id, closesOn: body.closesOn, actor });
    // "Extend the date": applications the old date stopped open again when the new date is still ahead. Once a trial has
    // ended that reopening is new work and waits for a plan (founder decision L-02 B, 402 `trial_ended`); a plain date
    // change is still taken.
    let reopened = false;
    let row = updated;
    if (body.closesOn && !role.acceptingApplications && role.applicationsClosedReason === CLOSING_DATE_REASON && closingMoment(body.closesOn, company?.timezone).getTime() > now.getTime()) {
      await assertNoNewWork(tx, t.companyId, now);
      [row] = await tx.update(roles).set({ acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null }).where(eq(roles.id, role.id)).returning();
      await emit(tx, { type: "role.applications_reopened", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { reason: "closing date extended", closesOn: body.closesOn } });
      await notify(tx, { companyId: t.companyId, kind: "applications.reopened", title: `${role.title} is taking applications again`, body: `${actor.name ?? "A team member"} moved the closing date to ${closingDayWords(body.closesOn)}. The job page shows the apply button again.`, action: { label: "Open the Share tab", href: `/roles/${role.id}?tab=posting` } });
      reopened = true;
    }
    return { ok: true, reopened, roleId: role.id, closingDate: closingDateFor(row, company ?? null, packet, now) };
  });
  await container.kick();
  return c.json({ ok: result.ok, reopened: result.reopened, closingDate: result.closingDate });
});

/**
 * ITS's old "apply and talk in one visit" switch for a role (plan E1, founder decision B1): "one_visit", "form_then_screen",
 * or null to follow the company's default. Since 20 October 2026 (R20-12) it is ignored and hidden: every applicant waits
 * on the page for their AI interview and gets its link by email, so `effective` is always "one_visit". The saved setting
 * stays readable (and writable, changing nothing) for a platform administrator only, with a second factor. A reason is
 * required and recorded. GET answers `{ roleId, applyMode, companyDefault, effective }`; PUT answers the same after the
 * change.
 */
async function applyModeView(tx: Tx, roleId: string) {
  const [role] = await tx.select({ id: roles.id, companyId: roles.companyId, applyMode: roles.applyMode }).from(roles).where(eq(roles.id, roleId)).limit(1);
  if (!role) throw new HttpError(404, "not_found", "Role not found.");
  const [company] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, role.companyId)).limit(1);
  return { role, view: { roleId: role.id, applyMode: role.applyMode ?? null, companyDefault: resolveApplyMode({ applyMode: null }, company?.settings), effective: "one_visit" as const } };
}

roleRoutes.get("/:id/apply-mode", requirePlatformAdmin, async (c) => {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) throw new HttpError(404, "not_found", "Role not found.");
  return c.json((await withPlatform(c.get("container").db, (tx) => applyModeView(tx, id))).view);
});

roleRoutes.put("/:id/apply-mode", requirePlatformAdmin, async (c) => {
  const id = c.req.param("id") ?? "";
  if (!UUID.test(id)) throw new HttpError(404, "not_found", "Role not found.");
  const body = ApplyModeChange.parse(await c.req.json().catch(() => ({})));
  const s = c.get("session")!;
  const actor = { kind: "user" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  const view = await withPlatform(c.get("container").db, async (tx) => {
    const { role, view: before } = await applyModeView(tx, id);
    if (before.applyMode === body.applyMode) return before;
    await tx.update(roles).set({ applyMode: body.applyMode }).where(eq(roles.id, role.id));
    await emit(tx, { type: "role.apply_mode_changed", companyId: role.companyId, actor, subject: { type: "role", id: role.id }, payload: { from: before.applyMode, to: body.applyMode } });
    await audit(tx, { companyId: role.companyId, actor, action: "role.apply_mode_changed", target: { type: "role", id: role.id }, reason: body.reason, details: { from: before.applyMode, to: body.applyMode } });
    return (await applyModeView(tx, id)).view;
  });
  return c.json(view);
});

// The posting routes (GET /:id/postings, the per-channel actions, links, volume, the accepting switch) live in routes/postings.ts.

import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { RoleStatusChange, ApplicationAction, OwnerGroupQuery, OwnerGroup, OwnerStage, SendDecisionMessages, SetClosingDate, ApplyModeChange, DecisionMessagePreviewRequest, AiInterviewGroup, importanceOf, scoreRank, type ActiveMark, type CancelledReason, type CandidateNotice, type DecisionMessagePreview } from "@ros/contracts";
import { applicationAnswerSentences, hiddenTextNoteOf, inCancelled, maskCandidateLinks, resolveApplyMode, teamScreenView, unsentScreenReadings, withoutUnsentConversation, withoutUnsentScreenEvents, writtenQuestionsOf } from "@ros/core";
import { withPlatform, type Tx } from "@ros/db";
import { aiInterviewsFor } from "../services/screens";
import { CLOSER_LOOK_LABEL, CLOSING_DATE_REASON, DECISION_STAGES, STAGE_LABEL, activeFollowUpsFor, activeMarksFor, assertCan, audit, can, cancelledView, closingDateProblem, closingDateRequired, closingDayWords, closingMoment, emit, followUpStripOf, groupFor, IN_MOTION_SQL, interviewsInMotionFor, holdEnded, jobNoticesFor, lockedAndWaiting, notLocked, notify, ownerStage, ownerStageLabel, ownerTags, payShown, payTransparencyApplies, showsOldVersion } from "@ros/core";
import { lockedCardsOf } from "../services/locked-visibility";
import { boardView, concernsAsRead, loadPool, openPath, packetsOf, poolPersonOf, scoreFields, scorePerson, shownReadings } from "../services/pool";
import { readingWontCome } from "../services/application-record";
import { armClosingDate, interviewsBeingPrepared, interviewsLapsedOnAllowance } from "@ros/workflows";
import { closingDateFor } from "../services/closing-date";
import { publishRole } from "../services/publish";
import { withEmptyPay, withoutPay } from "../services/pay-redaction";
import { assertNoNewWork } from "../services/trial";
import { currentVersionOf } from "../services/packet-versions";
import { applicationMarks, applications, approvalRequests, assessments, candidates, communications, companies, documents, events, interviewFollowups, interviews, postings, rolePackets, roles, screens, withTenant } from "@ros/db";
import { actorOf, clientIp, requirePlatformAdmin, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { DOWNLOAD_URL_TTL_SECONDS, safeFilename } from "../uploads";
import { SCREEN_OPEN_STATUSES, applicationActionState, applicationFactsFrom, declineMessagePolicy, decisionMessagePreview, pendingDecisionMessages, performApplicationAction, sendDecisionMessages, stageMoves, undoFacts, untoldFallbackDayOf } from "../services/application-actions";
import { screenScorecards, screensForScore } from "../services/screen-scorecards";

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

/** A time in ISO form whatever the driver hands back, so the page can sort and compare it as text. */
const iso = (value: string) => new Date(value).toISOString();

/**
 * The stage strip's counts over every applicant the caller may see (founder decision B3). `cancelled`: the people under
 * Cancelled by why they are there, for the column's chips (founder decisions 1A to 4A). `aiInterview`: the people under
 * "No AI interview yet" by where they stand with it (R20-7), for that column's chips; never how far anyone got.
 * `stillApplying`: the same people as `byOwnerStage.no_ai_interview`, kept one release for older pages.
 */
export type StageStripCounts = { total: number; byOwnerStage: Record<OwnerStage, number>; byGroup: Record<OwnerGroup, number>; notTold: number; holdsEnded: number; stillApplying: number; cancelled: { askedNewTimes: number; notInterested: number; noShow: number }; aiInterview: Record<AiInterviewGroup, number> };

/** Which count of `StageStripCounts.cancelled` each reason adds to. */
const CANCELLED_COUNT_KEY: Record<CancelledReason, keyof StageStripCounts["cancelled"]> = { asked_new_times: "askedNewTimes", not_interested: "notInterested", no_show: "noShow" };

/** The company's time zone, in which a promised day of new times is named. */
async function companyTimeZone(tx: Tx, companyId: string): Promise<string> {
  const [co] = await tx.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId)).limit(1);
  return co?.timezone ?? "UTC";
}

/**
 * The role's applicants. Each row carries, beside the evidence view: where the person sits on the stage strip
 * (`ownerStage`, `ownerStageLabel`: under Cancelled, why they are there), with `cancelled` (why, and where their new
 * times stand; null for everyone not under Cancelled), their active private mark (`mark`: kind, label, `remindAt`, note, who set it),
 * small `tags` ("Check eligibility", "Hold ended"), `stageChangedAt` and `appliedAt` with `daysInStage`, the day the offer
 * someone at Offer waits on was made (`offerMadeOn`, the newest offers row's `made_on`; null for everyone else), the told state
 * of a decision (`toldState`: null for someone whose details were deleted, who cannot be told; `candidateToldAt`,
 * `decisionMessageWaiting`), and the stage button (`stageMoves`). The match
 * score (founder decision B2), worked out on read from the stored findings: `score`, `band`, `bandLabel`, `coverage`,
 * `missingMustHave`, whether the AI interview is in it and the label (`interview`, `basis`; R20-9), the must-have line
 * (`mustHaves`), where the pool board puts them (`placement`) and its `nextStep`, and `readingVersion` when the reading
 * was made against an earlier version of the role. One query per kind of fact for the whole list, never one per row.
 * Ordered newest first, by the longest wait, by name, or by score (`order=score`, or `sort=score`): people whose score
 * counts the AI interview first, then résumé-only scores, each highest first, no score last. `?counts=1` answers
 * `{ applications, counts, locked }`, the counts covering every visible applicant whatever the filters.
 *
 * Past the plan's candidates per job (Rule 3) nobody is a row. They are left out in the query, before anything reads a name, a
 * score or a stage, so where a row sorts or which filter finds it says nothing about them. `locked` is all there is:
 * `{ count, cards: [{ position, appliedAt }] }`, and `counts.total` includes them; every other count is the people shown.
 */
roleRoutes.get("/:id/applications", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const q = OwnerGroupQuery.parse({ group: c.req.query("group"), stage: c.req.query("stage"), ownerStage: c.req.query("ownerStage"), told: c.req.query("told"), aiInterview: c.req.query("aiInterview"), order: c.req.query("order") ?? c.req.query("sort"), counts: c.req.query("counts") });
  const now = c.get("container").engine.clock();
  const result = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const apps = await tx.select().from(applications).where(and(eq(applications.roleId, c.req.param("id")), notLocked())).orderBy(desc(applications.createdAt));
    const locked = q.counts ? await lockedCardsOf(tx, c.req.param("id")) : { count: 0, cards: [] };
    // For the close card's "and N more you cannot see yet" under who is still in process: fewer than the cards when someone locked was decided or moved on.
    const lockedInProcess = locked.count ? await lockedStillInProcess(tx, c.req.param("id")) : 0;
    const ids = apps.map((a) => a.candidateId);
    const appIds = apps.map((a) => a.id);
    const cands = ids.length ? await tx.select().from(candidates).where(inArray(candidates.id, ids)) : [];
    // Every reading of every applicant (the score takes the scorecard's finding where it has one, the résumé's otherwise) and the role's packets by version.
    const asmts = appIds.length ? await tx.select().from(assessments).where(inArray(assessments.applicationId, appIds)).orderBy(desc(assessments.createdAt)) : [];
    const [roleRow] = await tx.select({ id: roles.id, currentPacketVersion: roles.currentPacketVersion }).from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    const packets = roleRow ? await packetsOf(tx, roleRow) : { byVersion: new Map(), currentVersion: null };
    // Whether each résumé file had text to read (a clean scan without a text layer has none): one query, no text pulled.
    const docIds = apps.filter((a) => a.resumeDocumentId).map((a) => a.resumeDocumentId!);
    const docs = docIds.length ? await tx.select({ id: documents.id, status: documents.status, hasText: sql<boolean>`${documents.textExtracted} is not null` }).from(documents).where(inArray(documents.id, docIds)) : [];
    // What the stage button needs, for every row at once: marks, open follow-ups (the Cancelled column), screens,
    // interviews, decision messages waiting for approval.
    const marks = await activeMarksFor(tx, appIds);
    const followUps = await activeFollowUpsFor(tx, appIds);
    const timeZone = followUps.size ? await companyTimeZone(tx, t.companyId) : "UTC";
    // With whether each sent one's scorecard waits for the AI credit or could not be written (`screensForScore`), for the score's label.
    const scr = await screensForScore(tx, appIds);
    // Never a reading of a conversation the candidate did not send ("hide them until they send", 9 October 2026).
    const hiddenReadings = unsentScreenReadings(scr, asmts);
    const ivs = appIds.length ? await tx.select({ applicationId: interviews.applicationId, status: interviews.status, decision: interviews.decision }).from(interviews).where(inArray(interviews.applicationId, appIds)) : [];
    // An interview booked or with times out waits on nobody at the company (6 November 2026): not "Waiting on you".
    const inMotion = await interviewsInMotionFor(tx, appIds);
    const waitingToTell = await pendingDecisionMessages(tx, appIds);
    // "No AI interview yet" (R20-7): where each person in that column stands with it (the latest screen's times).
    const aiInterviews = await aiInterviewsFor(tx, apps, now);
    // Whose AI interview is still being prepared: a person's own link waits for it (`interviewPreparing`).
    const preparing = await interviewsBeingPrepared(tx, appIds);
    // Whose AI interview never came because the month's allowance stayed used up (Q17): their score's label says so.
    const lapsed = await interviewsLapsedOnAllowance(tx, appIds.filter((id) => !scr.some((s) => s.applicationId === id)));
    // The day the offer each person at Offer waits on was made, so the row says the day the panel says (`offerMadeOn`).
    const offerDays = await openOfferDays(tx, apps.filter((a) => a.stage === "offer_sent").map((a) => a.id));
    const rows = apps.map((loaded) => {
      const cand = cands.find((x) => x.id === loaded.candidateId);
      const { app: a, assessments: own } = shownReadings(loaded, asmts.filter((x) => x.applicationId === loaded.id), hiddenReadings);
      const asmt = own.find((x) => x.id === a.latestAssessmentId);
      const doc = docs.find((d) => d.id === a.resumeDocumentId);
      const mark: ActiveMark | null = marks.get(a.id) ?? null;
      // Insufficient evidence as a state the owner can see, and the match score: derived here and on the candidate page from the same assessments, never stored.
      // The screens come unordered: where the AI interview stands for the score's label reads them in any order (R20-9).
      const ownScreens = scr.filter((s) => s.applicationId === a.id);
      const scored = scorePerson({ app: a, assessments: own, screens: ownScreens, allowanceLapsed: lapsed.has(a.id), packets: packets.byVersion, currentVersion: packets.currentVersion, mark, resumeUnreadable: !!doc && doc.status === "clean" && !doc.hasText && !a.extraction, openScreen: ownScreens.some((s) => SCREEN_OPEN_STATUSES.includes(s.status)) });
      const evidence = scored.evidence;
      const followUp = followUps.get(a.id) ?? null;
      const strip = ownerStage(a, mark, followUp);
      const aiInterview = strip === "no_ai_interview" ? aiInterviews.get(a.id) ?? null : null;
      const facts = applicationFactsFrom(a, ownScreens.map((s) => s.status), ivs.filter((i) => i.applicationId === a.id), t.role, asmt?.kind === "triage" ? asmt : null, { mark, decisionMessagePending: waitingToTell.has(a.id), followUp, interviewPreparing: preparing.has(a.id), aiInterview: aiInterviews.get(a.id) ?? null });
      return {
        id: a.id,
        stage: a.stage,
        stageLabel: evidence.needsCloserLook ? CLOSER_LOOK_LABEL : STAGE_LABEL[a.stage],
        group: groupFor(a, mark, now, followUp, inMotion.has(a.id)),
        ownerStage: strip,
        ownerStageLabel: ownerStageLabel(strip, mark, followUp, aiInterview, a.stage),
        cancelled: strip === "cancelled" && followUp ? cancelledView(followUp, { timeZone }) : null,
        aiInterview,
        mark,
        tags: ownerTags(a, mark, now),
        source: a.source,
        createdAt: a.createdAt,
        appliedAt: iso(a.createdAt),
        stageChangedAt: iso(a.stageChangedAt),
        daysInStage: Math.max(0, Math.floor((now.getTime() - Date.parse(a.stageChangedAt)) / 86_400_000)),
        offerMadeOn: a.stage === "offer_sent" ? offerDays.get(a.id) ?? null : null,
        // Someone whose details were deleted at their request cannot be told anything: no told state, so the Talent list's
        // "Not told yet" count and list leave them out, as Today and the daily check do (polish list).
        toldState: DECISION_STAGES.includes(a.stage) && !cand?.anonymizedAt ? a.toldState : null,
        candidateToldAt: a.candidateToldAt ? iso(a.candidateToldAt) : null,
        decisionMessageWaiting: waitingToTell.has(a.id),
        // Kept one release for older pages: the same people as the column.
        stillApplying: strip === "no_ai_interview",
        candidate: cand ? { id: cand.id, name: `${cand.firstName} ${cand.lastName}`, email: cand.email, phone: cand.phone, locationText: cand.locationText } : null,
        eligibility: a.eligibility,
        extractionSummary: a.extraction ? { positions: a.extraction.positions.slice(0, 3).map((p) => `${p.title}${p.employer ? ` at ${p.employer}` : ""}`), licenses: a.extraction.licenses.map((l) => l.name), years: a.extraction.yearsOfExperienceEstimate ?? null, anomalies: a.extraction.anomalies } : null,
        assessment: asmt ? { overall: asmt.overall, confidence: asmt.confidence, summary: asmt.result.summary, strengths: asmt.result.strengths.slice(0, 2), concerns: asmt.result.concerns.slice(0, 1) } : null,
        evidence,
        ...scoreFields(scored.match),
        mustHaves: scored.mustHaves,
        placement: scored.placement,
        nextStep: scored.placement.nextStep,
        readingVersion: scored.readingVersion,
        stageMoves: stageMoves(facts),
      };
    });
    const counts: StageStripCounts = { total: rows.length + locked.count, byOwnerStage: Object.fromEntries(OwnerStage.options.map((s) => [s, 0])) as Record<OwnerStage, number>, byGroup: Object.fromEntries(OwnerGroup.options.map((g) => [g, 0])) as Record<OwnerGroup, number>, notTold: 0, holdsEnded: 0, stillApplying: 0, cancelled: { askedNewTimes: 0, notInterested: 0, noShow: 0 }, aiInterview: Object.fromEntries(AiInterviewGroup.options.map((g) => [g, 0])) as Record<AiInterviewGroup, number> };
    for (const r of rows) {
      counts.byOwnerStage[r.ownerStage] += 1;
      counts.byGroup[r.group] += 1;
      if (r.toldState === "not_told") counts.notTold += 1;
      if (holdEnded(r.mark, now)) counts.holdsEnded += 1;
      if (r.stillApplying) counts.stillApplying += 1;
      if (r.cancelled) counts.cancelled[CANCELLED_COUNT_KEY[r.cancelled.reason]] += 1;
      if (r.aiInterview) counts.aiInterview[r.aiInterview.group] += 1;
    }
    const nameOf = (r: (typeof rows)[number]) => r.candidate?.name.toLowerCase() ?? "";
    // By score (`scoreRank`, 6 November 2026): final numbers first, then people whose AI interview is still coming, then no
    // score; highest first, and among equals the longest wait. The same rule as the page's own sort (apps/web/src/talent-list.ts).
    const byScore = (x: (typeof rows)[number], y: (typeof rows)[number]) => scoreRank(x) - scoreRank(y) || (y.score ?? -1) - (x.score ?? -1) || Date.parse(x.stageChangedAt) - Date.parse(y.stageChangedAt);
    const ordered = q.order === "waiting" ? [...rows].sort((x, y) => Date.parse(x.stageChangedAt) - Date.parse(y.stageChangedAt)) : q.order === "name" ? [...rows].sort((x, y) => nameOf(x).localeCompare(nameOf(y))) : q.order === "score" ? [...rows].sort(byScore) : rows;
    const shown = ordered.filter((r) => (!q.group || r.group === q.group) && (!q.stage || r.stage === q.stage) && (!q.ownerStage || r.ownerStage === q.ownerStage) && (!q.told || r.toldState === q.told) && (!q.aiInterview || r.aiInterview?.group === q.aiInterview));
    return { shown, counts, locked, lockedInProcess };
  });
  return c.json(q.counts ? { applications: result.shown, counts: result.counts, locked: result.locked, lockedInProcess: result.lockedInProcess } : result.shown);
});

/**
 * "Send the decision message" to several people of this role at once (the Talent page's and Today's "not told yet"):
 * the same Send as on each person's page, one result per person, so one refusal never blocks the rest. `held` counts
 * the messages saved to go out once ITS confirms the company (founder decision B7). `wording` picks one approved wording
 * for all (Q28); each result carries `communicationId` and `undoUntil` while the message waits out its Undo window.
 */
roleRoutes.post("/:id/decision-messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.reject");
  const body = SendDecisionMessages.parse(await c.req.json());
  const container = c.get("container");
  const results = await withTenant(container.db, t.companyId, (tx) => sendDecisionMessages(tx, container, { roleId: c.req.param("id") ?? "", applicationIds: body.applicationIds, tenant: t, actor: actorOf(c), wording: body.wording ?? null }));
  await container.kick();
  const tally = (n: CandidateNotice) => results.filter((r) => r.candidateNotice === n).length;
  return c.json({ results, queued: tally("queued"), held: tally("held"), waitingApproval: tally("waiting_approval"), notSent: results.length - tally("queued") - tally("held") - tally("waiting_approval") });
});

/** Application detail and actions live here too, keyed by application id. */
export const applicationRoutes = new Hono<Vars>();

applicationRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  // An interviewer holds no application.read but may open the candidates they are interviewing (F8): they get the
  // brief with pay and internal rationale left out (services/interviewer-view.ts), and a 403 for anyone else.
  const interviewerOnly = t.role === "interviewer";
  if (!interviewerOnly) assertCan(t.role, "application.read");
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    if (!app) return null;
    if (interviewerOnly) return interviewerApplicationView(tx, { app, tenant: t, actor: actorOf(c) });
    const [cand] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
    const docs = await tx.select({ id: documents.id, kind: documents.kind, filename: documents.filename, mime: documents.mime, sizeBytes: documents.sizeBytes, hasText: documents.textExtracted, status: documents.status, uploadedVia: documents.uploadedVia, rejectedReason: documents.rejectedReason, validatedAt: documents.validatedAt }).from(documents).where(eq(documents.applicationId, app.id));
    const scr = await tx.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt));
    // "Hide them until they send" (founder decision of 9 October 2026): while they are still in the conversation, and for
    // good when it closed without being sent, the team gets none of what they said in it: no answer or transcript line
    // (a recruiter's call notes excepted), no message they typed in it, no reading of it, and no history entry about a
    // single answer, nor one about a reading of it ("scorecard written", its recommendation, a flag on it). A reading of
    // a conversation nobody sent stays hidden however it is reached (`unsentScreenReadings` with the readings: one a
    // recruiter's call notes unlinked from its screen too). `screens[].answersShared` says which.
    const readings = await tx.select().from(assessments).where(eq(assessments.applicationId, app.id)).orderBy(desc(assessments.createdAt));
    const hiddenReadings = unsentScreenReadings(scr, readings);
    const shown = shownReadings(app, readings, hiddenReadings);
    const asmts = shown.assessments;
    const comms = withoutUnsentConversation(await tx.select().from(communications).where(eq(communications.applicationId, app.id)).orderBy(desc(communications.createdAt)), scr);
    const own = await tx.select().from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, app.id))).orderBy(desc(events.occurredAt)).limit(100);
    // History (plan A10) also tells what happened to the assistant's suggestions about them (asked, approved by whom,
    // "Not now", closed) and to their screens, which are recorded on the request and the screen, not the application.
    const requestIds = (await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.applicationId, app.id))).map((r) => r.id);
    const related = requestIds.length || scr.length ? await tx.select().from(events).where(or(and(eq(events.subjectType, "approval_request"), inArray(events.subjectId, requestIds.length ? requestIds : [""])), and(eq(events.subjectType, "screen"), inArray(events.subjectId, scr.length ? scr.map((s) => s.id) : [""])))).orderBy(desc(events.occurredAt)).limit(100) : [];
    const timeline = withoutUnsentScreenEvents([...own, ...related], scr, hiddenReadings).sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt));
    const ivs = await tx.select({ id: interviews.id, roundKey: interviews.roundKey, title: interviews.title, format: interviews.format, durationMinutes: interviews.durationMinutes, status: interviews.status, startsAt: interviews.startsAt, endsAt: interviews.endsAt, timezone: interviews.timezone, meetingUrl: interviews.meetingUrl, linkSource: interviews.linkSource, attempt: interviews.attempt, outcome: interviews.outcome, decision: interviews.decision, offeredSlots: interviews.offeredSlots, selectedSlot: interviews.selectedSlot, createdAt: interviews.createdAt }).from(interviews).where(eq(interviews.applicationId, app.id)).orderBy(desc(interviews.createdAt));
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    // `written` (Wave S7, additive): the written questions the chat asks and Review & send writes up, in order, keyed like
    // the write-up's answers (`writtenQuestionsOf`: never what the company looks for in them); the candidate panel labels them.
    const packetLabels = pv ? { mustHaves: pv.packet.requirements.mustHaves.map((m) => ({ key: m.key, text: m.text })), competencies: pv.packet.competencies.map((c) => ({ key: c.key, name: c.name, importance: importanceOf(c) })), questions: pv.packet.screening.questions.map((q) => ({ key: q.key, question: q.question })), written: writtenQuestionsOf(pv.packet) } : { mustHaves: [], competencies: [], questions: [], written: [] };
    // `formAnswers` (Wave S7, additive): every answer to the form's questions (eligibility and the company's own quick
    // questions) as the sentence the candidate's record and the AI read (`applicationAnswerSentences`), each marked when
    // it was suggested from the résumé and left as it was (`answers.fromCv`); `workSummary`: the summary they checked.
    const fromCv = new Set(app.answers.fromCv ?? []);
    const formAnswers = pv ? applicationAnswerSentences(pv.packet, app.answers).map((s) => ({ key: s.key, source: s.source, sentence: s.sentence, fromCv: fromCv.has(s.source === "eligibility" ? `elig_${s.key}` : `q_${s.key}`) || fromCv.has(s.key) })) : [];
    const workSummary = typeof app.answers.workSummary === "string" && app.answers.workSummary.trim() ? { text: app.answers.workSummary, fromCv: fromCv.has("workSummary") } : null;
    // `keptFacts` (Wave S8, additive): the facts from their earlier chats here that they kept on this application's form
    // (opened from the emailed reuse link, which tells them the company sees what they keep), in the words their record
    // holds now. The words only: not the chat, job or application they came from.
    const keptFacts = (Array.isArray(app.answers.kept) ? app.answers.kept : []).map((k) => ({ id: k.id, kind: k.kind, text: k.text, keptAt: k.keptAt, editedAt: k.editedAt ?? null }));
    // `proposal` carries a waiting message's text (F11), so the sheet can show it to the approver; `requiredRoles` says who may decide.
    const pendingApprovals = await tx.select({ id: approvalRequests.id, actionType: approvalRequests.actionType, rationale: approvalRequests.rationale, createdAt: approvalRequests.createdAt, proposal: approvalRequests.proposal, requiredRoles: approvalRequests.requiredRoles }).from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.status, "pending")));
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "candidate.viewed", target: { type: "application", id: app.id } });
    // The latest résumé assessment (rows are newest first) is what offers "ask about this in a screen", the same rule the action route applies.
    // Every choice the page shows but cannot take comes with the reason (plan 0.5), and the decline step says before the click what the candidate will get.
    // The private mark and the stage button (founder decision B3), and whether a decision was told (B6).
    const mark = (await activeMarksFor(tx, [app.id])).get(app.id) ?? null;
    // Under Cancelled (founder decisions 1A to 4A): why, and where their new times stand.
    const followUp = (await activeFollowUpsFor(tx, [app.id])).get(app.id) ?? null;
    // Their own decision message waiting for an approver, or a closed role's one closing message that names them (Q30).
    const decisionMessageWaiting = (await pendingDecisionMessages(tx, [app.id])).has(app.id);
    // A decision nobody told can be taken back (plan G1): where it was made from, and whether the role has closed.
    const now = c.get("container").engine.clock();
    // Under "No AI interview yet" (R20-7): where they stand with it, and whether "Send a reminder" is offered now.
    const aiInterview = (await aiInterviewsFor(tx, [app], now)).get(app.id) ?? null;
    // Under Cancelled with someone on the interview who has no hours to offer: "Send new times" would be refused (10 November 2026).
    const noHours = !!followUp && inCancelled(app.stage, followUp) && (await interviewHasNoHours(tx, { companyId: t.companyId, interviewId: followUp.currentInterviewId ?? followUp.interviewId }));
    const facts = applicationFactsFrom(app, scr.map((s) => s.status), ivs, t.role, asmts.find((x) => x.kind === "triage") ?? null, { mark, decisionMessagePending: decisionMessageWaiting, followUp, interviewPreparing: (await interviewsBeingPrepared(tx, [app.id])).has(app.id), aiInterview, noHours, ...(await undoFacts(tx, app)) });
    // What became of the email about a booked time: the panel says when they have not been told. And whether they heard of each
    // interview at all, as a cancellation decides whom to tell, so the decline steps never promise a note that will not go.
    const emailStates = await candidateEmailStates(tx, { interviews: ivs, hasEmail: !!cand?.email });
    const heard = ivs.length ? await candidatesHeard(tx, app.id) : new Map<string, boolean>();
    const { allowed: allowedActions, blockedReasons } = applicationActionState(facts);
    // What a Send of the decision message does under the company's settings: it goes, waits for approval, or is not sent.
    const declineMessage = await declineMessagePolicy(tx, { companyId: t.companyId, roleId: app.roleId });
    // A scorecard only for a complete conversation: one closed without being sent has none to show.
    const shownScorecard = (s: { status: string; assessmentId: string | null }) => s.status === "completed" && !(s.assessmentId && hiddenReadings.has(s.assessmentId));
    const scorecards = await screenScorecards(tx, scr.map((s) => (shownScorecard(s) ? s : { ...s, assessmentId: null })));
    // The day the untold safety net acts on a decision nobody has told (Q27), in the company's calendar: its time zone,
    // its working days and the ITS holidays, as the daily check counts them: from the unlock, for someone a change of plan
    // opened. The answer to the decision named the same day (`untoldFallbackDayOf`).
    const untoldFallbackOn = DECISION_STAGES.includes(app.stage) && app.toldState === "not_told" && !decisionMessageWaiting && !cand?.anonymizedAt ? await untoldFallbackDayOf(tx, app, now) : null;
    const strip = ownerStage(app, mark, followUp);
    const cancelled = strip === "cancelled" && followUp ? { ...cancelledView(followUp, { timeZone: await companyTimeZone(tx, app.companyId) }), noHours } : null;
    // The match score with its breakdown (founder decision B2), the must-have line, where the pool board puts them and
    // the version label, from the same assessments and rules as the list and the board.
    const [roleRow] = await tx.select({ id: roles.id, currentPacketVersion: roles.currentPacketVersion }).from(roles).where(eq(roles.id, app.roleId)).limit(1);
    const packets = roleRow ? await packetsOf(tx, roleRow) : { byVersion: new Map(), currentVersion: null };
    const resumeDoc = docs.find((d) => d.id === app.resumeDocumentId);
    const scored = scorePerson({ app: shown.app, assessments: asmts, screens: scr.map((s) => ({ ...s, scoreFailed: scorecards.get(s.id)?.scorecard === "unavailable" })), allowanceLapsed: !scr.length && (await interviewsLapsedOnAllowance(tx, [app.id])).has(app.id), packets: packets.byVersion, currentVersion: packets.currentVersion, mark, resumeUnreadable: !!resumeDoc && resumeDoc.status === "clean" && !resumeDoc.hasText && !app.extraction, openScreen: scr.some((s) => SCREEN_OPEN_STATUSES.includes(s.status)) });
    // L-08 B (founder, 16 Oct 2026): one neutral line when the résumé or the written answers the reading used held text aimed at the AI. Worked out from the stored words on every read; never stored, never given to the reading or the score, never sent to the candidate.
    const hiddenTextNote = hiddenTextNoteOf({ resumeText: resumeDoc?.status === "clean" ? resumeDoc.hasText : null, answers: shown.app.answers, extraction: shown.app.extraction, readings: asmts });
    // `noReading` (10 November 2026, additive): why no AI review of the résumé will come by itself, so the panel never promises one.
    const noReading = await readingWontCome(tx, app.id);
    // The status token opens the candidate's status page and the reply token is all that authenticates a reply, so neither leaves the server.
    const { statusToken: _statusToken, replyToken: _replyToken, ...appOut } = shown.app;
    // Nor does any other candidate link in the messages we sent them (status, conversation, scheduling, confirming the
    // answers given after applying again): each body is shown with the tokens hidden, without the reply address (it
    // carries the reply token) and with attachments named only. Links outlive any team member's access.
    const thread = comms.map(({ replyTo: _replyTo, attachments, ...m }) => ({ ...m, bodyText: maskCandidateLinks(m.bodyText), bodyHtml: maskCandidateLinks(m.bodyHtml), attachments: attachments ? attachments.map((a) => ({ filename: a.filename, contentType: a.contentType })) : null }));
    // An interview booked, or with times out whose email did not fail, waits on nobody at the company (6 November 2026;
    // the same rule as `interviewsInMotionFor`, from the rows already read).
    const inMotion = ivs.some((i) => i.status === "scheduled" || (i.status === "scheduling" && i.offeredSlots.length > 0 && emailStates.get(i.id) !== "failed" && emailStates.get(i.id) !== "no_email"));
    // The newest scorecard with the newest résumé reading, as the score pairs them, and the conversation it read: a concern
    // that is only the AI interview's silence about what the résumé shows is left out here (the Overview's Concerns, the
    // AI review under Full breakdown), never in the stored row (`concernsAsRead`).
    const asRead = concernsAsRead(asmts, { packets: packets.byVersion, fallback: pv?.packet ?? null, chats: new Map(scr.flatMap((s) => (s.assessmentId ? [[s.assessmentId, teamScreenView(s).transcript] as const] : []))) });
    return { ...appOut, stageLabel: STAGE_LABEL[app.stage], group: groupFor(app, mark, now, followUp, inMotion), ownerStage: strip, ownerStageLabel: ownerStageLabel(strip, mark, followUp, strip === "no_ai_interview" ? aiInterview : null, app.stage), cancelled, aiInterview: strip === "no_ai_interview" ? aiInterview : null, mark, tags: ownerTags(app, mark, now), stageMoves: stageMoves(facts), toldState: DECISION_STAGES.includes(app.stage) ? app.toldState : null, decisionMessageWaiting, untoldFallbackOn, allowedActions, blockedReasons, declineMessage, candidate: cand, interviews: ivs.map((i) => ({ ...i, candidateEmail: emailStates.get(i.id) ?? null, candidateHeard: heard.get(i.id) ?? false })), interviewPlan: pv?.packet.interviews.plan.map((r) => ({ key: r.key, title: r.title, durationMinutes: r.durationMinutes, format: r.format, interviewerUserIds: r.interviewerUserIds, purpose: r.purpose })) ?? [], documents: docs.map((d) => ({ ...d, hasText: !!d.hasText })), assessments: asRead, communications: thread, timeline, screens: scr.map(teamScreenView).map((s) => ({ id: s.id, channel: s.channel, status: s.status, invitedVia: s.invitedVia ?? null, invitedAt: s.invitedAt, startedAt: s.startedAt, completedAt: s.completedAt, remindedAt: s.remindedAt, idleRemindedAt: s.idleRemindedAt, expiresAt: s.expiresAt, transcript: s.transcript, answers: s.answers, progress: s.progress, answersShared: s.answersShared, assessmentId: shownScorecard(s) ? s.assessmentId : null, ...scorecards.get(s.id) })), pendingApprovals, packetLabels, formAnswers, workSummary, keptFacts, matchScore: scored.match, mustHaves: scored.mustHaves, placement: scored.placement, readingVersion: scored.readingVersion, hiddenTextNote, noReading };
  });
  if (!row) throw new HttpError(404, "not_found", "Application not found.");
  return c.json(row);
});

/**
 * The preview before "Send the decision message" (founder decision B6; `DecisionMessagePreview`): the exact words the
 * candidate will get in the suggested wording (the fitting one, marked `suggested`: the Send screen starts on it), the
 * address, the approved wordings on offer (Q28; POST .../preview shows another), whether Colorado's
 * line is in it, what the Send does under the company's settings (`policy`: sends, needs_approval, not_sent) and how
 * long the Undo lasts. 404 when there is no decision to tell (they are still in the process).
 */
applicationRoutes.get("/:id/decision-message", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.reject");
  const container = c.get("container");
  const preview = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    return app ? decisionMessagePreview(tx, container, app, { senderName: actorOf(c).name ?? undefined }) : null;
  });
  if (!preview) throw new HttpError(404, "not_found", "There is no decision to tell this candidate about.");
  return c.json(preview);
});

/**
 * The same preview with a chosen wording and a personal line (`DecisionMessagePreviewRequest`), checked exactly as the
 * Send checks them: 400 `personal_line_refused` says what to take out (`details.problems`), 400 `wording_not_allowed`
 * names a wording this decision cannot use. The personal line travels in the body, never in the address.
 */
applicationRoutes.post("/:id/decision-message/preview", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.reject");
  const body = DecisionMessagePreviewRequest.parse(await c.req.json().catch(() => ({})));
  const container = c.get("container");
  const preview: DecisionMessagePreview | null = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    return app ? decisionMessagePreview(tx, container, app, { wording: body.wording ?? null, personalLine: body.personalLine ?? null, senderName: actorOf(c).name ?? undefined }) : null;
  });
  if (!preview) throw new HttpError(404, "not_found", "There is no decision to tell this candidate about.");
  return c.json(preview);
});

/**
 * The file itself (decision 2): only a checked and scanned document, only to a member who may read the application,
 * only through a short-lived single-object link, and every read is audited with who, which file and why not more.
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
  if (!found.url) throw new HttpError(409, "not_available", found.doc.status === "quarantined" ? "This file is still being checked." : "This file was refused or removed and cannot be opened.");
  return c.redirect(found.url, 302);
});

/**
 * The résumé inside the candidate panel (plan H5): the same checks and the same `document.read` audit as the file
 * itself, served from this origin with an inline disposition so the panel can show it in a frame of its own page. A PDF
 * comes back as itself; a Word or text file, which browsers do not show as it is, comes back as its extracted text
 * (`?as=text` asks for the text of a PDF too). Never cached; only this application's own pages may frame it.
 */
applicationRoutes.get("/:id/documents/:documentId/inline", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const container = c.get("container");
  const wantsText = c.req.query("as") === "text";
  const found = await withTenant(container.db, t.companyId, async (tx) => {
    const [doc] = await tx.select().from(documents).where(and(eq(documents.id, c.req.param("documentId")), eq(documents.applicationId, c.req.param("id")))).limit(1);
    if (!doc) return null;
    if (doc.status !== "clean") throw new HttpError(409, "not_available", doc.status === "quarantined" ? "This file is still being checked." : "This file was refused or removed and cannot be opened.");
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

applicationRoutes.post("/:id/actions", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = ApplicationAction.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    // The row is locked for the decision, so two people acting on the same candidate at once take turns: the second
    // sees what the first did (a mark already replaced, a decision already told) instead of colliding with it.
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1).for("update");
    if (!app) throw new HttpError(404, "not_found", "Application not found.");
    return performApplicationAction(tx, container, { app, body, tenant: t, actor: actorOf(c) });
  });
  await container.kick();
  return c.json(result);
});

import { Hono } from "hono";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { ApproveRole, CreatePacketVersion, RoleStatusChange, ApplicationAction, OwnerGroupQuery, FlagAssessment, RecordApplicationOutcome, RecordRoleOutcome, OwnerGroup, OwnerStage, SendDecisionMessages, SetClosingDate, type ActiveMark, type CandidateNotice } from "@ros/contracts";
import { CLOSER_LOOK_LABEL, CLOSING_DATE_REASON, DECISION_STAGES, OUTCOME_STATEMENT, OutcomeError, STAGE_LABEL, activeMarksFor, assertCan, audit, boardPostingOf, can, closingDateProblem, closingDateRequired, closingDayWords, closingMoment, emit, evidenceView, groupFor, holdEnded, jobNoticesFor, listOutcomes, notify, openEscalationsFor, ownerStage, ownerStageLabel, ownerTags, payShown, payTransparencyApplies, recordApplicationOutcome, recordRoleOutcome, scopeAllows, showsOldVersion } from "@ros/core";
import { armClosingDate } from "@ros/workflows";
import { autoActionsOnOpen, boardChoices, closingDateFor } from "../services/publishing";
import { withEmptyPay, withoutPay } from "../services/pay-redaction";
import { users } from "@ros/db";
import { assertMayApprovePacket, packetApprovalView } from "../services/packet-approval";
import { createPacketVersion, currentVersionOf } from "../services/packet-versions";
import { aiRuns, applicationMarks, applications, approvalRequests, assessments, candidates, communications, companies, documents, events, interviewParticipants, interviews, postings, rolePackets, roles, screens, withTenant } from "@ros/db";
import { actorOf, applicationScopeGuard, clientIp, requireTenant, roleScopeGuard, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { DOWNLOAD_URL_TTL_SECONDS, safeFilename } from "../uploads";
import type { Container } from "../container";
import { applicationActionState, applicationFactsFrom, declineMessagePolicy, decisionMessagePreview, pendingDecisionMessages, performApplicationAction, sendDecisionMessages, stageMoves } from "../services/application-actions";
import { exitCleanup, type ExitCandidateEmail } from "../services/exit-cleanup";
import { screenScorecards } from "../services/screen-scorecards";
import { replayHeldEmails, settleHeldEmailsOnClose } from "../webhooks/postmark";
import { interviewerApplicationView } from "../services/interviewer-view";

export const roleRoutes = new Hono<Vars>();
roleRoutes.use("/:id", roleScopeGuard);
roleRoutes.use("/:id/*", roleScopeGuard);

roleRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const status = c.req.query("status");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const list = await tx.select().from(roles).where(status ? and(eq(roles.companyId, t.companyId), eq(roles.status, status)) : eq(roles.companyId, t.companyId)).orderBy(desc(roles.createdAt));
    const visible = t.staff?.scope.roleId ? list.filter((x) => x.id === t.staff!.scope.roleId) : list;
    if (!visible.length) return [];
    // An interviewer holds role.read but not application.read: the list names only the roles they interview for, the
    // same rule as their interviews list, and carries no applicant counts or waiting decisions (countsHidden).
    if (t.role === "interviewer") {
      const mine = await tx.select({ roleId: applications.roleId }).from(interviewParticipants).innerJoin(interviews, eq(interviews.id, interviewParticipants.interviewId)).innerJoin(applications, eq(applications.id, interviews.applicationId)).where(eq(interviewParticipants.userId, t.userId));
      const ids = new Set(mine.map((m) => m.roleId));
      return visible.filter((r) => ids.has(r.id)).map((r) => ({ ...r, counts: { total: 0 }, countsHidden: true, needsYou: 0, daysOpen: r.openedAt ? Math.floor((Date.now() - Date.parse(r.openedAt)) / 86_400_000) : null }));
    }
    // Three queries for the whole list, whatever its length: the roles, their applicants by stage and private mark (a
    // running hold does not wait on you; `stageCounts` is the stage strip), their open decisions.
    const roleIds = visible.map((r) => r.id);
    const stageCounts = await tx.select({ roleId: applications.roleId, stage: applications.stage, mark: applicationMarks.mark, remindAt: applicationMarks.remindAt, n: count() }).from(applications).leftJoin(applicationMarks, and(eq(applicationMarks.applicationId, applications.id), isNull(applicationMarks.clearedAt))).where(inArray(applications.roleId, roleIds)).groupBy(applications.roleId, applications.stage, applicationMarks.mark, applicationMarks.remindAt);
    const pendingCounts = await tx.select({ roleId: approvalRequests.roleId, n: count() }).from(approvalRequests).where(and(inArray(approvalRequests.roleId, roleIds), eq(approvalRequests.status, "pending"))).groupBy(approvalRequests.roleId);
    const now = c.get("container").engine.clock();
    return visible.map((r) => {
      const counts: Record<string, number> = {};
      const stageStrip: Record<string, number> = Object.fromEntries(OwnerStage.options.map((s) => [s, 0]));
      let total = 0;
      for (const row of stageCounts) {
        if (row.roleId !== r.id) continue;
        const n = Number(row.n);
        const mark = row.mark ? { mark: row.mark, remindAt: row.remindAt } : null;
        total += n;
        const g = groupFor({ stage: row.stage }, mark, now);
        counts[g] = (counts[g] ?? 0) + n;
        stageStrip[ownerStage({ stage: row.stage }, mark)] += n;
      }
      const needsYou = Number(pendingCounts.find((p) => p.roleId === r.id)?.n ?? 0);
      return { ...r, counts: { total, ...counts }, stageCounts: stageStrip, needsYou, daysOpen: r.openedAt ? Math.floor((Date.now() - Date.parse(r.openedAt)) / 86_400_000) : null };
    });
  });
  return c.json(rows);
});

roleRoutes.get("/:id", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const canSeeComp = can(t.role, "compensation.read");
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) return null;
    const packets = await tx.select().from(rolePackets).where(eq(rolePackets.roleId, role.id)).orderBy(desc(rolePackets.version));
    const current = currentVersionOf(role, packets);
    const posts = await tx.select().from(postings).where(eq(postings.roleId, role.id));
    const apps = await tx.select({ stage: applications.stage }).from(applications).where(eq(applications.roleId, role.id));
    const pending = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.status, "pending")));
    const counts: Record<string, number> = {};
    for (const a of apps) counts[a.stage] = (counts[a.stage] ?? 0) + 1;
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
    // applications, and for ITS staff only the requests their grant covers. The approval card below reads them all.
    const scope = t.staff ? { roleId: t.staff.scope.roleId, applicationId: t.staff.scope.applicationId } : null;
    const visiblePending = !can(t.role, "application.read") ? [] : scope ? pending.filter((p) => scopeAllows(scope, { roleId: p.roleId, applicationId: p.applicationId })) : pending;
    // A version proposed while the role runs (an edit waiting for approval): shown beside the current one, never in its place.
    const proposed = current && ["open", "paused"].includes(role.status) ? packets.find((p) => p.status === "proposed" && p.version > current.version) ?? null : null;
    const now = c.get("container").engine.clock();
    const approval = await packetApprovalView(tx, { tenant: t, role, packets, pending, now });
    // Wave D: what starts on its own once the job is live (D9), the board ticks and who posts them (D3, D6), the closing date (D7).
    const publishing = {
      autoActionsOnOpen: await autoActionsOnOpen(tx, role.companyId, role.id),
      boards: boardChoices(role, current?.packet ?? null, company?.settings),
      whoPosts: boardPostingOf(company?.settings),
      closingDate: closingDateFor(role, company ?? null, current?.packet ?? null, now),
      boardsShowingOldVersion: posts.filter((p) => showsOldVersion(p, role.currentPacketVersion)).map((p) => p.channel),
    };
    return { ...role, currentPacket: withPayView(current), proposedPacket: withPayView(proposed), packetVersions: packets.map((p) => ({ id: p.id, version: p.version, status: p.status, source: p.source, changeSummary: p.changeSummary, createdAt: p.createdAt, createdBy: p.createdBy })), postings: posts, boardsStillUp: posts.filter((p) => p.closureRequired && !p.closureConfirmedAt).map((p) => p.channel), counts, pendingApprovals: visiblePending, packetApproval: approval.packetApproval, decisionMaker: approval.decisionMaker, ...publishing };
  });
  if (!row) throw new HttpError(404, "not_found", "Role not found.");
  return c.json(row);
});

roleRoutes.get("/:id/packets", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(rolePackets).where(eq(rolePackets.roleId, c.req.param("id"))).orderBy(desc(rolePackets.version)));
  if (can(t.role, "compensation.read")) return c.json(rows);
  // Interviewers never see pay (docs/spec/21, area A): only the basis, the currency and whether the range is shown to
  // candidates; the figures, the bonus, the benefits and the sources that quote the figures are left out, never zeroed.
  return c.json(rows.map((p) => withoutPay(p)));
});

/**
 * A human edit creates a new version; nothing is overwritten. What happens next depends on the role and the editor
 * (services/packet-versions.ts): an approver's edit to an open role is current at once; anyone else's waits for
 * approval while the role keeps running on the approved version; an edit to a pending role replaces its approval request.
 */
roleRoutes.post("/:id/packets", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "packet.edit");
  const body = CreatePacketVersion.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const made = await createPacketVersion(tx, container, { tenant: t, actor: actorOf(c), role, packet: body.packet, changeSummary: body.changeSummary });
    // `guardChanges` says what the packet guard changed on its own (a must-have it took out, the ceiling it raised), so the page can tell the person.
    // `needsApproval` says why an approver's change to a live job waits (Q10) and whether they may confirm it themselves;
    // `boardsShowingOldVersion` names the boards still showing the earlier version once a change is live (D4).
    return { ...made.version, outcome: made.outcome, approvalRunId: made.approvalRunId, guardChanges: made.guardChanges, needsApproval: made.needsApproval, boardsShowingOldVersion: made.boardsShowingOldVersion };
  });
  await container.kick();
  return c.json(result, 201);
});

/**
 * Approving resolves the pending approval request; the role_approval workflow opens and publishes the role (or, for a
 * version proposed while the role was open, makes it current). Refused for the person who started the role or wrote
 * the version unless they are the company's only owner, and reserved for the named decision maker when there is one.
 * Refused with 409 `legal_check` while the law of the job's places asks for something the version lacks (plan D5:
 * `details.missing` lists each item with what to do).
 */
roleRoutes.post("/:id/approve", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.approve");
  const body = ApproveRole.parse(await c.req.json());
  const container = c.get("container");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, c.req.param("id"))).limit(1);
    if (!role) throw new HttpError(404, "not_found", "Role not found.");
    const [req] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, role.id), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending"))).limit(1);
    if (!req) throw new HttpError(409, "nothing_pending", "There is no pending approval for this role.");
    const proposedVersion = Number((req.proposal as { version?: number }).version);
    if (proposedVersion !== body.version) throw new HttpError(409, "version_mismatch", `The pending approval is for version ${proposedVersion}.`);
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, body.version))).limit(1);
    await assertMayApprovePacket(tx, { tenant: t, req, role, version: pv ?? null, now: container.engine.clock() });
    // On the engine's clock, like POST /approvals/:id/decide: the waiting workflow judges expiry on that clock.
    const decidedAt = container.engine.clock().toISOString();
    await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt, decisionNote: body.note ?? null }).where(eq(approvalRequests.id, req.id));
    await tx.update(rolePackets).set({ approvedBy: t.userId, approvedAt: decidedAt }).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, body.version)));
    await emit(tx, { type: "approval.granted", companyId: t.companyId, actor: actorOf(c), subject: { type: "approval_request", id: req.id }, payload: { actionType: req.actionType, roleId: role.id, version: body.version, note: body.note ?? null }, correlationId: req.workflowRunId });
    await emit(tx, { type: "role.approved", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { version: body.version } });
    await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${req.id}`, payload: { decision: "approved" } });
    return { ok: true, approvalRequestId: req.id };
  });
  await container.kick();
  return c.json(result);
});

// Closing a role records its outcome through POST /:id/outcome (21 Sep, item 4); the old unconfirmed close is gone.
// Pause only from open and resume only from paused (Wave 0 item 0.8): a resume must never reopen a closed role or
// restart publishing for a draft, and a second click changes nothing.
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
      const now = new Date().toISOString();
      const patch = action === "pause" ? { status: "paused", pausedAt: now } : { status: "open", pausedAt: null };
      // the state is checked again in the write itself, so two clicks at once pause (or resume) once
      const [updated] = await tx.update(roles).set(patch).where(and(eq(roles.id, role.id), eq(roles.status, action === "pause" ? "open" : "paused"))).returning();
      if (!updated) throw new HttpError(409, action === "pause" ? "not_open" : "not_paused", "Someone changed this role a moment ago. Refresh to see where it is now.");
      await emit(tx, { type: action === "pause" ? "role.paused" : "role.resumed", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { reason: body.reason ?? null } });
      if (action === "resume") await container.engine.start(tx, { workflowKey: "publish_role", companyId: t.companyId, subject: { type: "role", id: role.id }, state: { roleId: role.id, packetVersion: role.currentPacketVersion }, actor: actorOf(c) });
      return updated;
    });
    await container.kick();
    // Applications that arrived by email while the role was paused were held (C19); resuming adds them to the role.
    if (action === "resume") await replayHeldEmails(container, { companyId: t.companyId, roleId: row.id });
    return c.json(row);
  });
}

/**
 * The closing date (founder decision Q12, plan D7): the last day new applications are taken, in the company's time
 * zone, or null to take it off. For an open or paused role the timer is set again (packages/workflows closing-date.ts);
 * a draft or pending role gets its timer when it opens. A later date on a role whose date already stopped applications
 * takes applications again ("Extend the date"), and the emails held meanwhile are added. Colorado (and remote) roles
 * keep a date: 409 `closing_date_required`. Answers `{ ok, closingDate, reopened }`.
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
    // "Extend the date": applications the old date stopped open again when the new date is still ahead.
    let reopened = false;
    let row = updated;
    if (body.closesOn && !role.acceptingApplications && role.applicationsClosedReason === CLOSING_DATE_REASON && closingMoment(body.closesOn, company?.timezone).getTime() > now.getTime()) {
      [row] = await tx.update(roles).set({ acceptingApplications: true, applicationsClosedAt: null, applicationsClosedReason: null }).where(eq(roles.id, role.id)).returning();
      await emit(tx, { type: "role.applications_reopened", companyId: t.companyId, actor, subject: { type: "role", id: role.id }, payload: { reason: "closing date extended", closesOn: body.closesOn } });
      await notify(tx, { companyId: t.companyId, kind: "applications.reopened", title: `${role.title} is taking applications again`, body: `${actor.name ?? "A team member"} moved the closing date to ${closingDayWords(body.closesOn)}. The job page shows the apply button again.`, action: { label: "Open the Posting tab", href: `/roles/${role.id}?tab=posting` } });
      reopened = true;
    }
    return { ok: true, reopened, roleId: role.id, closingDate: closingDateFor(row, company ?? null, packet, now) };
  });
  await container.kick();
  // Applications that arrived by email while applications were stopped were held (C19); reopening adds them to the role.
  if (result.reopened) await replayHeldEmails(container, { companyId: t.companyId, roleId: result.roleId });
  return c.json({ ok: result.ok, reopened: result.reopened, closingDate: result.closingDate });
});

// The posting routes (GET /:id/postings, the per-channel actions, links, volume, the accepting switch) live in routes/postings.ts.

/** A time in ISO form whatever the driver hands back, so the page can sort and compare it as text. */
const iso = (value: string) => new Date(value).toISOString();

/** The stage strip's counts over every applicant the caller may see (founder decision B3). */
export type StageStripCounts = { total: number; byOwnerStage: Record<OwnerStage, number>; byGroup: Record<OwnerGroup, number>; notTold: number; holdsEnded: number };

/**
 * The role's applicants. Each row carries, beside the evidence view: where the person sits on the stage strip
 * (`ownerStage`, `ownerStageLabel`), their active private mark (`mark`: kind, label, `remindAt`, note, who set it),
 * small `tags` ("Check eligibility", "Hold ended"), `stageChangedAt` and `appliedAt` with `daysInStage`, the told state
 * of a decision (`toldState`, `candidateToldAt`, `decisionMessageWaiting`), and the stage button (`stageMoves`). One
 * query per kind of fact for the whole list, never one per row. Ordered newest first, by the longest wait or by name;
 * never by an AI reading. `?counts=1` answers `{ applications, counts }`, the counts covering every visible applicant
 * whatever the filters.
 */
roleRoutes.get("/:id/applications", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const q = OwnerGroupQuery.parse({ group: c.req.query("group"), stage: c.req.query("stage"), ownerStage: c.req.query("ownerStage"), told: c.req.query("told"), order: c.req.query("order"), counts: c.req.query("counts") });
  const now = c.get("container").engine.clock();
  const result = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const apps = (await tx.select().from(applications).where(eq(applications.roleId, c.req.param("id"))).orderBy(desc(applications.createdAt))).filter((a) => !t.staff?.scope.applicationId || a.id === t.staff.scope.applicationId);
    const ids = apps.map((a) => a.candidateId);
    const appIds = apps.map((a) => a.id);
    const cands = ids.length ? await tx.select().from(candidates).where(inArray(candidates.id, ids)) : [];
    const latest = apps.filter((a) => a.latestAssessmentId).map((a) => a.latestAssessmentId!);
    const asmts = latest.length ? await tx.select().from(assessments).where(inArray(assessments.id, latest)) : [];
    // Whether each résumé file had text to read (a clean scan without a text layer has none): one query, no text pulled.
    const docIds = apps.filter((a) => a.resumeDocumentId).map((a) => a.resumeDocumentId!);
    const docs = docIds.length ? await tx.select({ id: documents.id, status: documents.status, hasText: sql<boolean>`${documents.textExtracted} is not null` }).from(documents).where(inArray(documents.id, docIds)) : [];
    // What the stage button needs, for every row at once: marks, screens, interviews, decision messages waiting for approval.
    const marks = await activeMarksFor(tx, appIds);
    const scr = appIds.length ? await tx.select({ applicationId: screens.applicationId, status: screens.status }).from(screens).where(inArray(screens.applicationId, appIds)) : [];
    const ivs = appIds.length ? await tx.select({ applicationId: interviews.applicationId, status: interviews.status, decision: interviews.decision }).from(interviews).where(inArray(interviews.applicationId, appIds)) : [];
    const waitingToTell = await pendingDecisionMessages(tx, appIds);
    const rows = apps.map((a) => {
      const cand = cands.find((x) => x.id === a.candidateId);
      const asmt = asmts.find((x) => x.id === a.latestAssessmentId);
      const doc = docs.find((d) => d.id === a.resumeDocumentId);
      const mark: ActiveMark | null = marks.get(a.id) ?? null;
      // Insufficient evidence as a state the owner can see: derived here and on the candidate page from the same assessment, never stored.
      const evidence = evidenceView({ stage: a.stage, latest: asmt ?? null, resumeUnreadable: !!doc && doc.status === "clean" && !doc.hasText && !a.extraction });
      const strip = ownerStage(a, mark);
      const facts = applicationFactsFrom(a, scr.filter((s) => s.applicationId === a.id).map((s) => s.status), ivs.filter((i) => i.applicationId === a.id), t.role, asmt?.kind === "triage" ? asmt : null, { mark, decisionMessagePending: waitingToTell.has(a.id) });
      return {
        id: a.id,
        stage: a.stage,
        stageLabel: evidence.needsCloserLook ? CLOSER_LOOK_LABEL : STAGE_LABEL[a.stage],
        group: groupFor(a, mark, now),
        ownerStage: strip,
        ownerStageLabel: ownerStageLabel(strip, mark),
        mark,
        tags: ownerTags(a, mark, now),
        source: a.source,
        createdAt: a.createdAt,
        appliedAt: iso(a.createdAt),
        stageChangedAt: iso(a.stageChangedAt),
        daysInStage: Math.max(0, Math.floor((now.getTime() - Date.parse(a.stageChangedAt)) / 86_400_000)),
        toldState: DECISION_STAGES.includes(a.stage) ? a.toldState : null,
        candidateToldAt: a.candidateToldAt ? iso(a.candidateToldAt) : null,
        decisionMessageWaiting: waitingToTell.has(a.id),
        candidate: cand ? { id: cand.id, name: `${cand.firstName} ${cand.lastName}`, email: cand.email, phone: cand.phone, locationText: cand.locationText } : null,
        eligibility: a.eligibility,
        extractionSummary: a.extraction ? { positions: a.extraction.positions.slice(0, 3).map((p) => `${p.title}${p.employer ? ` at ${p.employer}` : ""}`), licenses: a.extraction.licenses.map((l) => l.name), years: a.extraction.yearsOfExperienceEstimate ?? null, anomalies: a.extraction.anomalies } : null,
        assessment: asmt ? { overall: asmt.overall, confidence: asmt.confidence, summary: asmt.result.summary, strengths: asmt.result.strengths.slice(0, 2), concerns: asmt.result.concerns.slice(0, 1) } : null,
        evidence,
        stageMoves: stageMoves(facts),
      };
    });
    const counts: StageStripCounts = { total: rows.length, byOwnerStage: Object.fromEntries(OwnerStage.options.map((s) => [s, 0])) as Record<OwnerStage, number>, byGroup: Object.fromEntries(OwnerGroup.options.map((g) => [g, 0])) as Record<OwnerGroup, number>, notTold: 0, holdsEnded: 0 };
    for (const r of rows) {
      counts.byOwnerStage[r.ownerStage] += 1;
      counts.byGroup[r.group] += 1;
      if (r.toldState === "not_told") counts.notTold += 1;
      if (holdEnded(r.mark, now)) counts.holdsEnded += 1;
    }
    const nameOf = (r: (typeof rows)[number]) => r.candidate?.name.toLowerCase() ?? "";
    const ordered = q.order === "waiting" ? [...rows].sort((x, y) => Date.parse(x.stageChangedAt) - Date.parse(y.stageChangedAt)) : q.order === "name" ? [...rows].sort((x, y) => nameOf(x).localeCompare(nameOf(y))) : rows;
    const shown = ordered.filter((r) => (!q.group || r.group === q.group) && (!q.stage || r.stage === q.stage) && (!q.ownerStage || r.ownerStage === q.ownerStage) && (!q.told || r.toldState === q.told));
    return { shown, counts };
  });
  return c.json(q.counts ? { applications: result.shown, counts: result.counts } : result.shown);
});

/**
 * "Send the decision message" to several people of this role at once (the Talent page's and Today's "not told yet"):
 * the same Send as on each person's page, one result per person, so one refusal never blocks the rest. `held` counts
 * the messages saved to go out once ITS confirms the company (founder decision B7).
 */
roleRoutes.post("/:id/decision-messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.reject");
  const body = SendDecisionMessages.parse(await c.req.json());
  const container = c.get("container");
  const results = await withTenant(container.db, t.companyId, (tx) => sendDecisionMessages(tx, container, { roleId: c.req.param("id") ?? "", applicationIds: body.applicationIds, tenant: t, actor: actorOf(c) }));
  await container.kick();
  const tally = (n: CandidateNotice) => results.filter((r) => r.candidateNotice === n).length;
  return c.json({ results, queued: tally("queued"), held: tally("held"), waitingApproval: tally("waiting_approval"), notSent: results.length - tally("queued") - tally("held") - tally("waiting_approval") });
});

/** Application detail and actions live here too, keyed by application id. */
export const applicationRoutes = new Hono<Vars>();
applicationRoutes.use("/:id", applicationScopeGuard);
applicationRoutes.use("/:id/*", applicationScopeGuard);

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
    const asmts = await tx.select().from(assessments).where(eq(assessments.applicationId, app.id)).orderBy(desc(assessments.createdAt));
    const comms = await tx.select().from(communications).where(eq(communications.applicationId, app.id)).orderBy(desc(communications.createdAt));
    const own = await tx.select().from(events).where(and(eq(events.subjectType, "application"), eq(events.subjectId, app.id))).orderBy(desc(events.occurredAt)).limit(100);
    const scr = await tx.select().from(screens).where(eq(screens.applicationId, app.id)).orderBy(desc(screens.createdAt));
    // History (plan A10) also tells what happened to the assistant's suggestions about them (asked, approved by whom,
    // "Not now", closed) and to their screens, which are recorded on the request and the screen, not the application.
    const requestIds = (await tx.select({ id: approvalRequests.id }).from(approvalRequests).where(eq(approvalRequests.applicationId, app.id))).map((r) => r.id);
    const related = requestIds.length || scr.length ? await tx.select().from(events).where(or(and(eq(events.subjectType, "approval_request"), inArray(events.subjectId, requestIds.length ? requestIds : [""])), and(eq(events.subjectType, "screen"), inArray(events.subjectId, scr.length ? scr.map((s) => s.id) : [""])))).orderBy(desc(events.occurredAt)).limit(100) : [];
    const timeline = [...own, ...related].sort((x, y) => Date.parse(y.occurredAt) - Date.parse(x.occurredAt));
    const ivs = await tx.select({ id: interviews.id, roundKey: interviews.roundKey, title: interviews.title, status: interviews.status, startsAt: interviews.startsAt, endsAt: interviews.endsAt, timezone: interviews.timezone, meetingUrl: interviews.meetingUrl, attempt: interviews.attempt, outcome: interviews.outcome, decision: interviews.decision, offeredSlots: interviews.offeredSlots, createdAt: interviews.createdAt }).from(interviews).where(eq(interviews.applicationId, app.id)).orderBy(desc(interviews.createdAt));
    const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
    const packetLabels = pv ? { mustHaves: pv.packet.requirements.mustHaves.map((m) => ({ key: m.key, text: m.text })), competencies: pv.packet.competencies.map((c) => ({ key: c.key, name: c.name })), questions: pv.packet.screening.questions.map((q) => ({ key: q.key, question: q.question })) } : { mustHaves: [], competencies: [], questions: [] };
    // `proposal` carries a waiting message's text (F11), so the sheet can show it to the approver; `requiredRoles` says who may decide.
    const pendingApprovals = await tx.select({ id: approvalRequests.id, actionType: approvalRequests.actionType, rationale: approvalRequests.rationale, createdAt: approvalRequests.createdAt, proposal: approvalRequests.proposal, requiredRoles: approvalRequests.requiredRoles }).from(approvalRequests).where(and(eq(approvalRequests.applicationId, app.id), eq(approvalRequests.status, "pending")));
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "candidate.viewed", target: { type: "application", id: app.id } });
    // The latest résumé assessment (rows are newest first) is what offers "ask about this in a screen", the same rule the action route applies.
    // Every choice the page shows but cannot take comes with the reason (plan 0.5), and the decline step says before the click what the candidate will get.
    // The private mark and the stage button (founder decision B3), and whether a decision was told (B6).
    const mark = (await activeMarksFor(tx, [app.id])).get(app.id) ?? null;
    const facts = applicationFactsFrom(app, scr.map((s) => s.status), ivs, t.role, asmts.find((x) => x.kind === "triage") ?? null, { mark, decisionMessagePending: pendingApprovals.some((p) => p.actionType === "disposition.send") });
    const { allowed: allowedActions, blockedReasons } = applicationActionState(facts);
    // What a Send of the decision message does under the company's settings: it goes, waits for approval, or is not sent.
    const declineMessage = await declineMessagePolicy(tx, { companyId: t.companyId, roleId: app.roleId });
    const scorecards = await screenScorecards(tx, scr);
    const now = c.get("container").engine.clock();
    const strip = ownerStage(app, mark);
    // The status token opens the candidate's status page and the reply token is all that authenticates a reply, so neither leaves the server.
    const { statusToken: _statusToken, replyToken: _replyToken, ...appOut } = app;
    return { ...appOut, stageLabel: STAGE_LABEL[app.stage], group: groupFor(app, mark, now), ownerStage: strip, ownerStageLabel: ownerStageLabel(strip, mark), mark, tags: ownerTags(app, mark, now), stageMoves: stageMoves(facts), toldState: DECISION_STAGES.includes(app.stage) ? app.toldState : null, allowedActions, blockedReasons, declineMessage, candidate: cand, interviews: ivs, interviewPlan: pv?.packet.interviews.plan.map((r) => ({ key: r.key, title: r.title, durationMinutes: r.durationMinutes, format: r.format, interviewerUserIds: r.interviewerUserIds, purpose: r.purpose })) ?? [], documents: docs.map((d) => ({ ...d, hasText: !!d.hasText })), assessments: asmts, communications: comms, timeline, screens: scr.map((s) => ({ id: s.id, channel: s.channel, status: s.status, invitedAt: s.invitedAt, startedAt: s.startedAt, completedAt: s.completedAt, remindedAt: s.remindedAt, transcript: s.transcript, answers: s.answers, progress: s.progress, assessmentId: s.assessmentId, ...scorecards.get(s.id) })), pendingApprovals, packetLabels };
  });
  if (!row) throw new HttpError(404, "not_found", "Application not found.");
  return c.json(row);
});

/**
 * The preview before "Send the decision message" (founder decision B6): the exact words the candidate will get, the
 * address, and what the Send does under the company's settings (`policy`: sends, needs_approval, not_sent). 404 when
 * there is no decision to tell (they are still in the process).
 */
applicationRoutes.get("/:id/decision-message", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.reject");
  const container = c.get("container");
  const preview = await withTenant(container.db, t.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, c.req.param("id"))).limit(1);
    return app ? decisionMessagePreview(tx, container, app) : null;
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

/** One-click flag on an AI assessment (docs/FOUNDER-CONTEXT.md §23). Stored against the AI run, emitted as a human override, audited. Never retrains anything by itself. */
applicationRoutes.post("/:id/assessments/:assessmentId/flag", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.act");
  const body = FlagAssessment.parse(await c.req.json());
  const row = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const [asmt] = await tx.select().from(assessments).where(and(eq(assessments.id, c.req.param("assessmentId")), eq(assessments.applicationId, c.req.param("id")))).limit(1);
    if (!asmt) throw new HttpError(404, "not_found", "Assessment not found.");
    const flag = { kind: body.kind, note: body.note ?? null, by: actorOf(c), at: new Date().toISOString() };
    if (asmt.aiRunId) await tx.update(aiRuns).set({ humanOverride: flag }).where(eq(aiRuns.id, asmt.aiRunId));
    await emit(tx, { type: "human.override", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: asmt.applicationId }, payload: { action: "flag_assessment", assessmentId: asmt.id, kind: body.kind, note: body.note ?? null, aiRunId: asmt.aiRunId } });
    await audit(tx, { companyId: t.companyId, actor: actorOf(c), action: "assessment.flagged", target: { type: "ai_run", id: asmt.aiRunId ?? asmt.id }, reason: `${body.kind}${body.note ? `: ${body.note}` : ""}` });
    return { ok: true, assessmentId: asmt.id, kind: body.kind };
  });
  return c.json(row);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* Human-recorded hiring outcomes (21 Sep, item 4). Recording only: no offer is generated, approved or sent here. */
/* ------------------------------------------------------------------------------------------------------------ */

function outcomeHttpError(e: unknown): never {
  if (e instanceof OutcomeError) throw new HttpError(e.code === "not_found" ? 404 : ["already_closed", "already_corrected", "already_recorded", "not_active"].includes(e.code) ? 409 : 400, e.code, e.message);
  throw e;
}

/** Tells the ITS recruiter working on this role or candidate. Names the role, never the candidate. */
async function tellRecruiterAboutOutcome(container: Container, companyId: string, roleId: string, applicationId: string | null, what: string, key: string) {
  const escalations = await openEscalationsFor(container.db, companyId, roleId, applicationId);
  if (!escalations.length) return;
  const [company] = await container.db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1);
  const [role] = await container.db.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)).limit(1);
  const from = `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`;
  const told = new Set<string>();
  for (const e of escalations) {
    const to = e.assignedToUserId ? (await container.db.select({ email: users.email }).from(users).where(eq(users.id, e.assignedToUserId)).limit(1))[0]?.email : container.env.ITS_QUEUE_EMAIL;
    if (!to || told.has(to)) continue;
    told.add(to);
    await container.integrations.email.send({ to, from, subject: `${company?.name ?? "A customer"} recorded an outcome for ${role?.title ?? "a role"}`, text: `${what}\n\nThe customer recorded this themselves; the decision was made outside Recruiting OS. Your open request: ${container.env.APP_BASE_URL}/recruiter/queue/${e.id}`, idempotencyKey: `${key}:${to}`, tags: { template: "outcome_recorded" } });
  }
}

applicationRoutes.get("/:id/outcomes", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const rows = await withTenant(c.get("container").db, t.companyId, (tx) => listOutcomes(tx, { companyId: t.companyId, applicationId: c.req.param("id") }));
  return c.json({ statement: OUTCOME_STATEMENT, outcomes: rows });
});

applicationRoutes.post("/:id/outcome", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "outcome.record");
  const body = RecordApplicationOutcome.parse(await c.req.json());
  if (body.outcome === "employer_declined") assertCan(t.role, "application.reject"); // a decline is a decline, whoever records it
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    try {
      const r = await recordApplicationOutcome(tx, { companyId: t.companyId, applicationId: c.req.param("id") ?? "", outcome: body.outcome, by: t.role, actor, hireDate: body.hireDate, offerAcceptedAt: body.offerAcceptedAt, reason: body.reason, note: body.note, now: container.engine.clock() });
      // The candidate's own news (a withdrawal, a hire, an offer they declined) may be confirmed with the cancellation; the
      // team's decisions (declined, no hire) are private like the Decline button's (founder decision B6): the decision is
      // not sent, but a candidate who held a booked time or was offered times is told at once, with no reason, that the
      // interview is off, and the decision message sent later leaves it out.
      const privateDecision = body.outcome === "employer_declined" || body.outcome === "no_hire";
      const candidateEmail: ExitCandidateEmail = privateDecision ? "private_decision" : "send_cancellation";
      const cleaned = r.to !== "hired" ? await exitCleanup(tx, container, { companyId: t.companyId, applicationId: r.app.id, reason: `outcome: ${body.outcome}`, actor, candidateEmail }) : null;
      const candidateNotice: CandidateNotice | null = privateDecision ? "not_told" : null;
      return { ...r, dispositionSent: false, candidateNotice, interviewsCancelled: cleaned?.interviewsCancelled ?? 0, interviewOffNotes: cleaned?.candidateNotes ?? 0 };
    } catch (e) { outcomeHttpError(e); }
  });
  const label: Record<string, string> = { hired_externally: "recorded a hire (offer accepted outside the platform)", candidate_withdrew: "recorded that the candidate withdrew", employer_declined: "declined the candidate", offer_declined_externally: "recorded that the candidate declined an offer made outside the platform", no_hire: "closed the process for this candidate without a hire" };
  await tellRecruiterAboutOutcome(container, t.companyId, result.roleId, c.req.param("id") ?? null, `${actor.name ?? "The customer"} ${label[body.outcome]}.`, `outcome:${result.row.id}`);
  await container.kick();
  return c.json({ ok: true, outcomeId: result.row.id, stage: result.to, roleId: result.roleId, roleStillOpen: result.roleStillOpen, dispositionSent: result.dispositionSent, ...(result.candidateNotice ? { candidateNotice: result.candidateNotice, interviewsCancelled: result.interviewsCancelled, interviewOffNotes: result.interviewOffNotes } : {}), movedToTalentPool: 0, statement: OUTCOME_STATEMENT, next: result.roleStillOpen ? "The role is still open. Close it with its outcome when you are ready; that is a separate confirmation." : null }, 201);
});

roleRoutes.post("/:id/outcome", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "outcome.record");
  const body = RecordRoleOutcome.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    try {
      const closed = await recordRoleOutcome(tx, { companyId: t.companyId, roleId: c.req.param("id") ?? "", outcome: body.outcome, by: t.role, actor, reason: body.reason, now: container.engine.clock() });
      // Everyone still in the process left it with the role: their interviews and screens end. The decision stays private
      // (founder decision B6) until someone sends the decision message, but a candidate who held a booked time or was
      // offered times is told at once, with no reason, that the interview is off; the decision message leaves it out.
      let interviewsCancelled = 0;
      let interviewOffNotes = 0;
      for (const applicationId of closed.movedApplicationIds) {
        const cleaned = await exitCleanup(tx, container, { companyId: t.companyId, applicationId, reason: `role closed: ${body.outcome}`, actor, candidateEmail: "private_decision" });
        interviewsCancelled += cleaned.interviewsCancelled;
        interviewOffNotes += cleaned.candidateNotes;
      }
      return { ...closed, interviewsCancelled, interviewOffNotes };
    } catch (e) { outcomeHttpError(e); }
  });
  const label: Record<string, string> = { filled: "closed the role as filled", filled_outside_platform: "closed the role: filled outside the platform", role_cancelled: "cancelled the role", no_hire: "closed the role without a hire" };
  await tellRecruiterAboutOutcome(container, t.companyId, result.role.id, null, `${actor.name ?? "The customer"} ${label[body.outcome]}.`, `role_outcome:${result.row.id}`);
  // Applications emailed while the role was paused or closed to applications were held with a promise to add them (C19); a close keeps it by putting them in the talent pool.
  const held = await settleHeldEmailsOnClose(container, { companyId: t.companyId, roleId: result.role.id });
  await container.kick();
  return c.json({ ok: true, outcomeId: result.row.id, role: result.role, movedToTalentPool: result.movedToTalentPool + held.addedToTalentPool, heldEmailsAddedToTalentPool: held.addedToTalentPool, interviewsCancelled: result.interviewsCancelled, interviewOffNotes: result.interviewOffNotes, statement: OUTCOME_STATEMENT });
});

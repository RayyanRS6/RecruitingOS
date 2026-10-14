import { Hono, type Context } from "hono";
import { and, desc, eq, inArray, isNull, like, notInArray } from "drizzle-orm";
import { ConfirmBoardUpdated, CreateEscalation, DecideApproval, EscalationEstimateQuery, EscalationReply, RecordPostingUrl, ReopenEscalation, ResolveEscalation, VerifyPosting, type Actor, type CandidateNotice, type EscalationScope, type InterviewDraft, type RecruiterRequestView } from "@ros/contracts";
import { BOARD_NAME, ESCALATION_ACCESS_DAYS, POSTING_STATE_LABEL, POSTING_TASK_KINDS, activeStaffGrant, addEscalationReply, assertCan, audit, can, raiseAlert, businessMinutesBetween, confirmBoardRemoved, confirmBoardUpdated, createEscalation, deadlineWords, describeHours, emit, endStaffGrant, entitlements, escalationReplyBy, escalationThread, grantStaffAccess, isBoardChannel, isPostingTask, limitGrantAfterResolution, loadBusinessCalendar, mayDecideApproval, notify, postingTaskLabel, postingTaskWorkDone, queueOrder, recordEscalationAnswer, recordStaffAccess, reopenEscalation, showsOldVersion, slaBusinessHours, toEscalationPreview, transition, withoutSentimentWords, withoutUnsentInContext, type EscalationPreview, type EscalationRow, type PostingState } from "@ros/core";
import { applications, approvalRequests, candidates, companies, escalationMessages, events, memberships, postings, recruiterEscalations, rolePackets, roles, staffAccessGrants, users, withPlatform, withTenant, type Db, type Tx } from "@ros/db";
import { confirmPostingByHand, postingTaskDetail, queuePostingCheck, recordBoardAddress } from "./postings";
import { actorOf, clientIp, requireRecruiterOrAdmin, requireTenant, type Vars } from "../middleware/session";
import { HttpError } from "../middleware/errors";
import { briefViewerOf, composeBrief } from "../services/brief";
import { escalationInScope, eventTargets, inStaffScope, staffMayAsk, staffScopeOf } from "../services/staff-scope";
import { assertMayApprovePacket } from "../services/packet-approval";
import { withoutUnsentChats } from "../services/screen-visibility";
import { assertMayShareDraft } from "./intake";
import { settleMessageApproval } from "../services/messages";
import { declineSent, sendApprovedDecline } from "../services/application-actions";
import { sendApprovedClosingMessages } from "../services/closing-messages";
import { approverRolesOf, mayDecideByRole } from "../services/approvers";
import { attachBoardSnapshot, emailItsQueue, sendToIts } from "../services/escalation-queue";
import { interviewDraftFor } from "./interviews";

export const approvalRoutes = new Hono<Vars>();

/**
 * The approval requests themselves. A request's proposal can carry a candidate's name and a message written to them
 * (F11), so the list needs application.read (an interviewer sees only their own interviews, F9), and ITS staff under a
 * scoped grant see only the requests they may decide (`staffMayAsk`, the rule POST /:id/decide applies): a role grant
 * those about its role or one of its candidates, a grant about one candidate only that candidate's. A request about a
 * whole role (the closing message lists every untold applicant) or about the whole company is left out for them.
 */
approvalRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const status = c.req.query("status") ?? "pending";
  const scope = staffScopeOf(t);
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const all = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, t.companyId), eq(approvalRequests.status, status))).orderBy(desc(approvalRequests.createdAt));
    if (!scope) return all;
    // A request about a candidate may carry only the application: its role comes from the application, as on decide.
    const appIds = [...new Set(all.filter((r) => r.applicationId && !r.roleId).map((r) => r.applicationId as string))];
    const apps = appIds.length ? await tx.select({ id: applications.id, roleId: applications.roleId }).from(applications).where(inArray(applications.id, appIds)) : [];
    const roleOfApp = new Map(apps.map((a) => [a.id, a.roleId]));
    return all.filter((r) => staffMayAsk(scope, { roleId: r.roleId ?? (r.applicationId ? roleOfApp.get(r.applicationId) ?? null : null), applicationId: r.applicationId ?? null }));
  });
  return c.json(rows);
});

approvalRoutes.post("/:id/decide", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = DecideApproval.parse(await c.req.json());
  const container = c.get("container");
  // Stamped on the engine's clock, the one the waiting workflow compares against (expiry, the decision after the request).
  const decidedAt = container.engine.clock().toISOString();
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [req] = await tx.select().from(approvalRequests).where(eq(approvalRequests.id, c.req.param("id"))).limit(1);
    if (!req) throw new HttpError(404, "not_found", "Approval request not found.");
    // ITS staff under a grant decide only what the grant covers, as on every route that takes an id: a request about
    // their role or one of its candidates (a grant about one candidate: that candidate). Deciding acts for the whole of
    // what a request is about, so a request about the role's whole group, or the company's, is not theirs to decide under
    // a narrower grant, even where the list shows it. The same refusal as the role and application guards.
    const scope = staffScopeOf(t);
    if (scope) {
      const [app] = req.applicationId && !req.roleId ? await tx.select({ roleId: applications.roleId }).from(applications).where(eq(applications.id, req.applicationId)).limit(1) : [];
      if (!staffMayAsk(scope, { roleId: req.roleId ?? app?.roleId ?? null, applicationId: req.applicationId ?? null })) throw new HttpError(403, "staff_scope", "Your access is limited to the role and candidate of the escalation you accepted.");
    }
    if (req.status !== "pending") throw new HttpError(409, "decided", `This request is already ${req.status}.`);
    const status = body.decision === "approve" ? "approved" : "rejected";
    const proposedVersion = Number((req.proposal as { version?: number }).version);
    if (req.actionType === "role_packet.approve") {
      // The same rules as POST /roles/:id/approve: the approver roles, the named decision maker, and no self-approval (a rejection may come from anyone who could decide).
      assertCan(t.role, "role.approve");
      const [role] = req.roleId ? await tx.select().from(roles).where(eq(roles.id, req.roleId)).limit(1) : [];
      if (!role) throw new HttpError(404, "not_found", "Role not found.");
      const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, proposedVersion))).limit(1);
      if (status === "approved") await assertMayApprovePacket(tx, { tenant: t, req, role, version: pv ?? null, now: container.engine.clock() });
      else {
        // Sending back is reserved the same way as approving (the named decision maker, or an owner); only the self-approval rule is waived.
        const decide = mayDecideApproval(req, { userId: t.userId, role: t.role });
        if (!decide.ok) throw new HttpError(403, decide.code, decide.message);
      }
      if (status === "approved") {
        await tx.update(rolePackets).set({ approvedBy: t.userId, approvedAt: decidedAt }).where(and(eq(rolePackets.roleId, role.id), eq(rolePackets.version, proposedVersion)));
        // The same domain fact as POST /roles/:id/approve, so the role's history reads the same whichever button approved it.
        await emit(tx, { type: "role.approved", companyId: t.companyId, actor: actorOf(c), subject: { type: "role", id: role.id }, payload: { version: proposedVersion } });
      }
    } else if (!mayDecideByRole(req.requiredRoles, t.role)) throw new HttpError(403, "forbidden", `This decision needs one of: ${approverRolesOf(req.requiredRoles).join(", ")}.`);
    await tx.update(approvalRequests).set({ status, decidedBy: t.userId, decidedAt, decisionNote: body.note ?? null, decisionEdits: body.edits ?? null }).where(eq(approvalRequests.id, req.id));
    await emit(tx, { type: body.decision === "approve" ? "approval.granted" : "approval.denied", companyId: t.companyId, actor: actorOf(c), subject: { type: "approval_request", id: req.id }, payload: { actionType: req.actionType, roleId: req.roleId, applicationId: req.applicationId ?? null, version: Number.isFinite(proposedVersion) ? proposedVersion : null, note: body.note ?? null }, correlationId: req.workflowRunId });
    await container.engine.signal(tx, { companyId: t.companyId, key: `approval:${req.id}`, payload: { decision: status } });
    // A message a team member wrote to a candidate (F11): approved, it goes out under their name (or waits for the ITS
    // company check, which the answer says); declined, they are told.
    const messageStatus = req.actionType === "message.send_freeform" ? await settleMessageApproval(tx, container, { req, status, actor: actorOf(c), tenant: t, note: body.note ?? null }) : null;
    // A decision message held for approval (a Send under "ask me first"): no workflow waits on it, so approving it sends
    // it here; "Do not send" leaves the candidate not told, and the team can send it again or tell them themselves.
    let decisionMessage: { dispositionSent: boolean; candidateNotice: CandidateNotice } | undefined;
    if (req.actionType === "disposition.send" && status === "approved" && req.applicationId) {
      // The wording and personal line the Send chose travel on the request (Q28).
      const sent = await sendApprovedDecline(tx, container, { applicationId: req.applicationId, actor: actorOf(c), proposal: req.proposal });
      decisionMessage = sent ? { dispositionSent: declineSent(sent.notice), candidateNotice: sent.notice } : { dispositionSent: false, candidateNotice: "not_told" };
    }
    // A closed role's one closing message, approved once for everyone (Q30): each person still untold gets it now.
    const closing = req.actionType === "disposition.send" && status === "approved" && !req.applicationId ? await sendApprovedClosingMessages(tx, container, { req, actor: actorOf(c) }) : null;
    let interviewDraft: InterviewDraft | null = null;
    if (status === "approved" && req.applicationId) {
      const [app] = await tx.select().from(applications).where(eq(applications.id, req.applicationId)).limit(1);
      if (app && req.actionType === "application.invite_screen") {
        await container.engine.start(tx, { workflowKey: "screen", companyId: t.companyId, subject: { type: "application", id: app.id }, state: { applicationId: app.id, roleId: app.roleId, invitedBy: t.userId }, idempotencyKey: `screen:${app.id}`, actor: actorOf(c) });
      }
      if (app && req.actionType === "application.recommend_interview" && app.stage === "screen_complete") {
        await transition(tx, { applicationId: app.id, companyId: t.companyId, to: "interview_recommended", by: t.role, actor: actorOf(c), reason: body.note ?? "approved the recommendation" });
        await emit(tx, { type: "candidate.recommended", companyId: t.companyId, actor: actorOf(c), subject: { type: "application", id: app.id }, payload: { by: "approval", approvalRequestId: req.id } });
      }
      // "Yes, interview" (plan H4): the answer carries the interview approval card filled in, so the next click books it.
      if (app && req.actionType === "application.recommend_interview" && can(t.role, "interview.request")) interviewDraft = await interviewDraftFor(tx, { app, now: container.engine.clock() });
    }
    return { ok: true, status, ...(decisionMessage ?? {}), ...(messageStatus ? { messageStatus } : {}), ...(closing ? { closingMessage: closing } : {}), ...(interviewDraft ? { interviewDraft } : {}) };
  });
  await container.kick();
  return c.json(result);
});

export const escalationRoutes = new Hono<Vars>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the recruiter sees, in the words every message about their access uses (Q31: say the real access). */
function accessWords(scope: EscalationScope): string {
  if (scope === "application") return "this candidate and the role they applied for";
  if (scope === "role") return "this role and its candidates";
  return "all of your hiring: every role and every candidate";
}
// Said to whoever asked: hiring managers and HR may ask, but only owners and admins hold staff_access.revoke.
const ACCESS_LIMITS = `Their access starts when they pick the request up and ends a day after it is resolved, or after ${ESCALATION_ACCESS_DAYS} days at most. An owner or admin can end it sooner in Settings, and every page they open is recorded.`;

/**
 * Settles what a request covers before it is created. The ids decide it; a request with neither a role nor a candidate
 * covers the whole company only when the person said so (`scope: "company"`), never by leaving the ids out. A candidate
 * brings their role along, so the recruiter can read the role they applied for.
 */
async function settleScope(tx: Tx, body: CreateEscalation): Promise<{ scope: EscalationScope; roleId: string | null; applicationId: string | null }> {
  const scope: EscalationScope | undefined = body.scope ?? (body.applicationId ? "application" : body.roleId ? "role" : undefined);
  if (!scope) throw new HttpError(400, "scope_required", "Say which hire this is about, or choose all of your hiring.");
  if (scope === "company") {
    if (body.roleId || body.applicationId) throw new HttpError(400, "scope_mismatch", "A request about all of your hiring does not name a role or a candidate.");
    return { scope, roleId: null, applicationId: null };
  }
  if (scope === "role" && (!body.roleId || body.applicationId)) throw new HttpError(400, "scope_mismatch", "A request about a role names that role and no single candidate.");
  if (scope === "application" && !body.applicationId) throw new HttpError(400, "scope_mismatch", "A request about a candidate names that candidate.");
  if (body.applicationId) {
    const [app] = UUID.test(body.applicationId) ? await tx.select({ id: applications.id, roleId: applications.roleId }).from(applications).where(eq(applications.id, body.applicationId)).limit(1) : [];
    if (!app) throw new HttpError(404, "not_found", "That candidate is not in your company.");
    if (body.roleId && body.roleId !== app.roleId) throw new HttpError(400, "scope_mismatch", "That candidate applied to a different role.");
    return { scope, roleId: app.roleId, applicationId: app.id };
  }
  const [role] = UUID.test(body.roleId!) ? await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, body.roleId!)).limit(1) : [];
  if (!role) throw new HttpError(404, "not_found", "That role is not in your company.");
  return { scope, roleId: role.id, applicationId: null };
}

/** Said with every request marked urgent (founder decision Q32, option A): what urgency does, and what it does not. */
const URGENT_WORDS = "It is marked urgent, so it goes to the front of the ITS queue; the reply-by time is the same as for any request.";
const isUrgent = (urgency: string) => urgency === "high" || urgency === "critical";

/** "Bring in a recruiter." The customer's request; the SLA counts business hours (founder decision F12). */
escalationRoutes.post("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "escalation.create");
  const body = CreateEscalation.parse(await c.req.json());
  const container = c.get("container");
  const actor = actorOf(c);
  const { created, preview, calendar, scope, allowance, companyName } = await withTenant(container.db, t.companyId, async (tx) => {
    const { scope, roleId, applicationId } = await settleScope(tx, body);
    // A recruiter under a grant asks only about what that grant covers, never wider: claiming the request would grant it.
    if (!staffMayAsk(staffScopeOf(t), { roleId, applicationId })) throw new HttpError(403, "staff_scope", "Your access is limited to the role or candidate of the request you accepted, so you can only ask about that.");
    // A draft still being written (C12) has no role yet: the request covers the company, and carries the draft's conversation.
    if (body.intakeSessionId) {
      if (scope !== "company") throw new HttpError(400, "scope_mismatch", "A request about a draft covers all of your hiring, since the role does not exist yet.");
      await assertMayShareDraft(tx, t, body.intakeSessionId);
    }
    const created = await createEscalation(tx, { companyId: t.companyId, roleId, applicationId, kind: body.kind, question: body.question, requestedBy: actor, urgency: body.urgency, intakeSessionId: body.intakeSessionId ?? null });
    // "Have a recruiter check this" from the pool board (plan F9): the recruiter opens the board as it stood when asked,
    // with the summary and where each person was placed and why, beside the role's own record.
    if (body.kind === "review" && roleId && !applicationId) await attachBoardSnapshot(tx, { escalationId: created.id, roleId, tenant: t, now: container.engine.clock() });
    // The plan's recruiter requests count only what the team itself asks for, and going over never refuses one (Q33). A
    // talk about the plan itself (more roles) is not recruiting help and is never counted.
    const allowance = actor.kind === "user" && body.topic !== "plan" ? await entitlements.recordRecruiterAsk(tx, t.companyId, { escalationId: created.id }) : null;
    if (allowance) await tx.update(recruiterEscalations).set({ billing: { countsTowardAllowance: true, used: allowance.used, limit: allowance.limit, overAllowance: allowance.over } }).where(eq(recruiterEscalations.id, created.id));
    else if (body.topic === "plan") await tx.update(recruiterEscalations).set({ billing: { countsTowardAllowance: false, topic: "plan" } }).where(eq(recruiterEscalations.id, created.id));
    const [row] = await tx.select({ urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary }).from(recruiterEscalations).where(eq(recruiterEscalations.id, created.id)).limit(1);
    const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, t.companyId)).limit(1);
    return { created, preview: row, calendar: await loadBusinessCalendar(tx), scope, allowance, companyName: co?.name ?? "A customer" };
  });
  // Past the allowance: ITS is told, for billing; the request itself went ahead like any other.
  if (allowance?.over) await withPlatform(container.db, (tx) => entitlements.flagRecruiterAsksOver(tx, { companyId: t.companyId, companyName, standing: allowance, escalationId: created.id }));
  await emailItsQueue(container, { id: created.id, companyId: t.companyId, kind: body.kind, slaDueAt: created.slaDueAt, urgency: preview.urgency, requiredExpertise: preview.requiredExpertise, summary: preview.summary, timeZone: calendar.timeZone });
  const over = allowance?.over && allowance.limit !== null ? ` Your plan includes ${allowance.limit} recruiter ${allowance.limit === 1 ? "request" : "requests"} and this is number ${allowance.used}. It goes ahead as usual; ITS will talk with you about the extra.` : "";
  return c.json({ id: created.id, slaDueAt: created.slaDueAt, scope, message: `A recruiter will respond by ${deadlineWords(new Date(created.slaDueAt), calendar)} (business hours are ${describeHours(calendar)}).${isUrgent(preview.urgency) ? ` ${URGENT_WORDS}` : ""} They will see ${accessWords(scope)}. ${ACCESS_LIMITS}${over}` }, 201);
});

/**
 * The reply-by time a request would get if it were sent now (plan B6), so the form can say it before anything is sent,
 * and where it stands against the plan's recruiter requests (Q33): which one this would be, or that a talk about the
 * plan is not counted. Urgency is not an input: it changes the order of the queue, never the time.
 */
escalationRoutes.get("/estimate", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "escalation.create");
  const { kind, topic } = EscalationEstimateQuery.parse({ kind: c.req.query("kind") || undefined, topic: c.req.query("topic") || undefined });
  const now = new Date();
  const { calendar, standing } = await withTenant(c.get("container").db, t.companyId, async (tx) => ({ calendar: await loadBusinessCalendar(tx, now), standing: await entitlements.recruiterAskStanding(tx, t.companyId) }));
  const due = escalationReplyBy(kind, now, calendar);
  // An ITS recruiter asking from inside a customer's workspace is never counted either, and is not told about the plan.
  const counted = topic !== "plan" && !t.staff;
  const allowance = topic === "plan" ? "Talking with ITS about your plan does not use one of your plan's recruiter requests."
    : !counted || standing.limit === null ? ""
    : standing.used < standing.limit ? (standing.limit === 1 ? "Your plan includes 1 recruiter request, and this would use it." : `This uses one of the ${standing.limit} recruiter requests your plan includes; ${standing.used} used so far.`)
    : `Your plan includes ${standing.limit} recruiter ${standing.limit === 1 ? "request" : "requests"}, and ${standing.used === standing.limit ? (standing.limit === 1 ? "it has" : "all have") : `${standing.used} have`} been used. This one still goes ahead as usual; ITS will talk with you about the extra.`;
  return c.json({ kind, slaDueAt: due.toISOString(), businessHours: slaBusinessHours(kind), hours: describeHours(calendar), allowance: { counted, used: standing.used, limit: standing.limit, message: allowance }, message: `If you send it now, a recruiter will respond by ${deadlineWords(due, calendar)}. Business hours are ${describeHours(calendar)}.` });
});

/**
 * The customer's own requests (plan B4, "Your recruiter requests" on Today): each with its state, the reply-by time,
 * who picked it up, the full answer and the whole thread. The words in them can name candidates, so the list needs
 * escalation.create (an interviewer sees only their own interviews), and a recruiter under a scoped grant sees only the
 * requests about what the grant covers.
 */
escalationRoutes.get("/mine", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "escalation.create");
  const scope = staffScopeOf(t);
  const container = c.get("container");
  const found = await withTenant(container.db, t.companyId, async (tx) => {
    // ITS posting tasks (plan D3) are ITS's own work, shown with each board on the role's Posting tab, not as the team's requests.
    const rows = (await tx.select({ id: recruiterEscalations.id, kind: recruiterEscalations.kind, status: recruiterEscalations.status, urgency: recruiterEscalations.urgency, summary: recruiterEscalations.summary, question: recruiterEscalations.question, requestedBy: recruiterEscalations.requestedBy, assignedToUserId: recruiterEscalations.assignedToUserId, createdAt: recruiterEscalations.createdAt, resolvedAt: recruiterEscalations.resolvedAt, resolution: recruiterEscalations.resolution, slaDueAt: recruiterEscalations.slaDueAt, firstResponseAt: recruiterEscalations.firstResponseAt, accessExpiresAt: recruiterEscalations.accessExpiresAt, roleId: recruiterEscalations.roleId, applicationId: recruiterEscalations.applicationId })
      .from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, t.companyId), notInArray(recruiterEscalations.kind, [...POSTING_TASK_KINDS]))).orderBy(desc(recruiterEscalations.createdAt))).filter((r) => escalationInScope(scope, r));
    const ids = rows.map((r) => r.id);
    const messages = ids.length ? await tx.select().from(escalationMessages).where(inArray(escalationMessages.escalationId, ids)) : [];
    const roleIds = [...new Set(rows.map((r) => r.roleId).filter((x): x is string => !!x))];
    const titles = new Map((roleIds.length ? await tx.select({ id: roles.id, title: roles.title }).from(roles).where(inArray(roles.id, roleIds)) : []).map((r) => [r.id, r.title]));
    const appIds = [...new Set(rows.map((r) => r.applicationId).filter((x): x is string => !!x))];
    const people = new Map((appIds.length ? await tx.select({ id: applications.id, firstName: candidates.firstName, lastName: candidates.lastName, anonymizedAt: candidates.anonymizedAt }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(inArray(applications.id, appIds)) : []).map((p) => [p.id, p.anonymizedAt ? null : `${p.firstName} ${p.lastName}`.trim() || null]));
    return { rows, messages, titles, people };
  });
  const names = await recruiterNames(container.db, found.rows.map((r) => r.assignedToUserId));
  return c.json(found.rows.map((row): RecruiterRequestView => {
    // A hand-over reason from before 9 October 2026 in today's words: never how the candidate sounded.
    const r = { ...row, question: withoutSentimentWords(row.question) };
    const own = found.messages.filter((m) => m.escalationId === r.id);
    const recruiterName = r.assignedToUserId ? names.get(r.assignedToUserId) ?? null : [...own].reverse().find((m) => m.side === "recruiter")?.author.name ?? null;
    return {
      id: r.id, kind: r.kind, status: r.status, urgency: r.urgency, summary: r.summary, question: r.question,
      scope: r.applicationId ? "application" : r.roleId ? "role" : "company", roleId: r.roleId, roleTitle: r.roleId ? found.titles.get(r.roleId) ?? null : null, applicationId: r.applicationId, candidateName: r.applicationId ? found.people.get(r.applicationId) ?? null : null,
      askedBy: askedByOf(r.requestedBy, t.userId),
      createdAt: r.createdAt, slaDueAt: r.slaDueAt, firstResponseAt: r.firstResponseAt, resolvedAt: r.resolvedAt, resolution: r.resolution, accessExpiresAt: r.accessExpiresAt,
      recruiterName, reopenedCount: own.filter((m) => m.kind === "reopen").length, thread: escalationThread(r, own, recruiterName),
    };
  }));
});

/** Who asked, as the team reads it: "you", someone on the team, an ITS recruiter, a candidate, or the system on its own. */
function askedByOf(requestedBy: Actor, viewerId: string): RecruiterRequestView["askedBy"] {
  if (requestedBy.kind === "user") return { kind: requestedBy.id === viewerId ? "you" : "team", name: requestedBy.name ?? null };
  if (requestedBy.kind === "recruiter") return { kind: "recruiter", name: requestedBy.name ?? null };
  if (requestedBy.kind === "candidate") return { kind: "candidate", name: null };
  return { kind: "system", name: null };
}

/** Recruiters are not members, so the tenant role cannot read their user rows; they are named from the platform side (name only). */
async function recruiterNames(db: Db, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await withPlatform(db, (tx) => tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, wanted)));
  return new Map(rows.map((u) => [u.id, u.name ?? u.email]));
}

/** The request as the signed-in team member may act on it: in their company, inside a recruiter's grant if they are one. */
async function ownRequest(c: Context<Vars>): Promise<EscalationRow> {
  const t = c.get("tenant")!;
  assertCan(t.role, "escalation.create");
  // The recruiter's side of the thread is the queue, under the grant they were given for it.
  if (t.staff) throw new HttpError(403, "staff_reply", "Reply to the customer from the recruiter queue.");
  const id = c.req.param("id") ?? "";
  const [e] = UUID.test(id) ? await withTenant(c.get("container").db, t.companyId, (tx) => tx.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.id, id), eq(recruiterEscalations.companyId, t.companyId))).limit(1)) : [];
  // An ITS posting task (plan D3) is not one of the team's requests: it carries no thread, and reopening it must never
  // give anyone access to the company's records.
  if (!e || isPostingTask(e.kind)) throw new HttpError(404, "not_found", "That request is not in your company.");
  return e;
}

/**
 * A note from the team to the recruiter while the request is open (plan B5). The recruiter holding it is emailed that
 * there is a note, never its words; they read it in the queue under their grant.
 */
escalationRoutes.post("/mine/:id/messages", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const e = await ownRequest(c);
  const body = EscalationReply.parse(await c.req.json());
  if (e.status === "resolved") throw new HttpError(409, "resolved", "This request was answered. If the answer did not solve it, reopen the request and say what is still missing.");
  if (e.status === "cancelled") throw new HttpError(409, "cancelled", "This request was cancelled. Bring in a recruiter again if you still need help.");
  const container = c.get("container");
  const message = await withTenant(container.db, t.companyId, (tx) => addEscalationReply(tx, { escalation: e, side: "customer", author: actorOf(c), body: body.body }));
  // The recruiter is not a member, so their address is read on the platform side (email only).
  const holderId = e.assignedToUserId;
  const [holder] = holderId ? await withPlatform(container.db, (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, holderId)).limit(1)) : [];
  const sent = holder?.email ? await container.integrations.email.send({
    to: holder.email,
    from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
    subject: `[${e.kind}] The customer added a note to a request you hold`,
    text: `The customer added a note to a request you are working on. Read it in the queue: ${container.env.APP_BASE_URL}/recruiter/queue/${e.id}`,
    idempotencyKey: `escalation-message:${message.id}`,
    tags: { template: "escalation_note" },
  }) : null;
  // Never say the recruiter was told when the email did not go: the note is on the request either way.
  const told = !!sent && sent.status !== "failed";
  return c.json({ id: message.id, recruiterTold: told, message: told ? "Sent. The recruiter on it has been told there is a new note." : holder ? "Sent. The recruiter on it could not be emailed just now; the note is with your request, where they will read it." : "Sent. The recruiter who picks the request up will read it with your request." }, 201);
});

/**
 * "This didn't solve it" (plan B5): an answered request opens again. The recruiter who answered gets fresh access at
 * once when they can take it back; otherwise it goes back to the ITS queue. Either way the reply-by time starts again,
 * the fresh access is recorded like any other, and the team is told what the recruiter will see and until when.
 */
escalationRoutes.post("/mine/:id/reopen", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const e = await ownRequest(c);
  const body = ReopenEscalation.parse(await c.req.json());
  if (e.status !== "resolved") throw new HttpError(409, "not_resolved", "This request is still open. Add a note for the recruiter instead.");
  const container = c.get("container");
  const now = new Date();
  const actor = actorOf(c);
  const scope: EscalationScope = e.applicationId ? "application" : e.roleId ? "role" : "company";
  // The tenant role cannot write grants: this runs on the platform side, scoped to the signed-in member's own company.
  // The request is locked, so a double click or two people reopening at once give one fresh access, not two.
  const done = await withPlatform(container.db, async (tx) => {
    const [fresh] = await tx.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.id, e.id), eq(recruiterEscalations.companyId, t.companyId))).limit(1).for("update");
    if (fresh?.status !== "resolved") throw new HttpError(409, "not_resolved", "This request is no longer answered; refresh the page.");
    const r = await reopenEscalation(tx, { escalation: fresh, actor, note: body.note, calendar: await loadBusinessCalendar(tx, now), now });
    // Fresh access for someone outside the company is always told at once, to the whole team that hears about recruiters
    // (Q31), not only to the person who reopened it.
    if (r.recruiter && r.grant) {
      await notify(tx, { companyId: t.companyId, kind: "recruiter.access_granted", title: `${r.recruiter.name} (ITS recruiter) has access again for a reopened request`, body: `${actor.name ?? "Someone on your team"} reopened a request ${r.recruiter.name} answered, so it is theirs again. They can see ${accessWords(scope)} until ${new Date(r.grant.expiresAt).toLocaleDateString("en-US")}, or until a day after the request is resolved if that is sooner. Every page they open is recorded in your activity, and an owner or admin can end their access in Settings.`, action: { label: "Recruiter access", href: "/setup#setup-recruiters" } });
    }
    return r;
  });
  const calendar = await loadBusinessCalendar(container.db, now);
  const due = deadlineWords(new Date(done.slaDueAt), calendar);
  if (done.recruiter && done.grant) {
    const sent = await container.integrations.email.send({
      to: done.recruiter.email,
      from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
      subject: `[${e.kind}] A customer reopened a request you answered: respond by ${new Date(done.slaDueAt).toLocaleString("en-US", { timeZone: calendar.timeZone })} (${calendar.timeZone})`,
      text: `The customer says your answer did not solve it, and the request is yours again. Your access is back until ${new Date(done.grant.expiresAt).toLocaleDateString("en-US")}. Read why in the queue: ${container.env.APP_BASE_URL}/recruiter/queue/${e.id}`,
      idempotencyKey: `escalation-reopen:${done.messageId}`,
      tags: { template: "escalation_reopened" },
    });
    // The request waits on them: when the email did not go, ITS is put in front of it to tell them another way.
    if (sent.status === "failed") await raiseAlert(container.db, { kind: "recruiter.notify_failed", severity: "high", title: "A recruiter was not told a request was reopened", body: `A customer reopened a request ${done.recruiter.name} answered, and the email to them failed (${sent.error ?? "no reason given"}). Tell them another way; it is due by ${due}.`, companyId: t.companyId, target: { type: "escalation", id: e.id }, details: { recruiterUserId: done.recruiter.id, error: sent.error ?? null } });
    return c.json({ status: done.status, slaDueAt: done.slaDueAt, message: `Reopened. ${done.recruiter.name} (ITS recruiter) has it again and will respond by ${due}. They can see ${accessWords(scope)} until ${new Date(done.grant.expiresAt).toLocaleDateString("en-US")}, or until a day after it is resolved if that is sooner; this fresh access is recorded in your activity like any other.` });
  }
  // Through the outbox, so a failure is recorded, retried and alerted (audit row 125).
  await sendToIts(container, {
    companyId: t.companyId,
    subject: `[${e.kind}] ${e.urgency} urgency, reopened: respond by ${new Date(done.slaDueAt).toLocaleString("en-US", { timeZone: calendar.timeZone })} (${calendar.timeZone})`,
    text: `A customer reopened a request: the answer did not solve it.\n\nCategory: ${e.kind}\nUrgency: ${e.urgency}\nNeeds: ${e.requiredExpertise}\nSummary: ${e.summary}\n\nAccept it in the queue to open the full request: ${container.env.APP_BASE_URL}/recruiter/queue/${e.id}`,
    idempotencyKey: `escalation-reopen:${done.messageId}`,
    template: "escalation",
  });
  return c.json({ status: done.status, slaDueAt: done.slaDueAt, message: `Reopened and back in the ITS queue. A recruiter will respond by ${due}. Whoever picks it up will see ${accessWords(scope)}. ${ACCESS_LIMITS}` });
});

const PREVIEW_COLUMNS = {
  id: recruiterEscalations.id, companyId: recruiterEscalations.companyId, companyName: companies.name, roleTitle: roles.title, kind: recruiterEscalations.kind, status: recruiterEscalations.status,
  urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary, slaDueAt: recruiterEscalations.slaDueAt,
  createdAt: recruiterEscalations.createdAt, assignedToUserId: recruiterEscalations.assignedToUserId,
};
type PreviewRow = { id: string; companyId: string; companyName: string; roleTitle: string | null; kind: string; status: string; urgency: string; requiredExpertise: string; summary: string; slaDueAt: string | null; createdAt: string; assignedToUserId: string | null };

/**
 * The ITS queue (founder decision F10, D24; correction 11 of 18 September 2026). Before a recruiter accepts an
 * assignment they see only: customer name, role title, category, urgency, required expertise, remaining service-level
 * time, and a generic summary. Never the customer's words, never anything from a candidate record. Every preview view is
 * audited for the customer. The full context opens after claim, under a grant.
 */
async function previewRows(c: Context<Vars>, rows: PreviewRow[], reason: string): Promise<EscalationPreview[]> {
  const s = c.get("session")!;
  const now = new Date();
  const container = c.get("container");
  const calendar = await loadBusinessCalendar(container.db, now);
  const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  const byCompany = new Map<string, string[]>();
  for (const r of rows) byCompany.set(r.companyId, [...(byCompany.get(r.companyId) ?? []), r.id]);
  for (const [companyId, ids] of byCompany) {
    await audit(container.db, { companyId, actor, action: "escalation.preview_viewed", reason, ip: clientIp(c), details: { escalationIds: ids, fields: "preview" } });
  }
  return rows.map((r) => toEscalationPreview({ ...r, viewerUserId: s.user.id, now, businessMinutesRemaining: r.slaDueAt ? businessMinutesBetween(now, new Date(r.slaDueAt), calendar) : null }));
}

/** Urgent requests first, then the soonest reply-by time (founder decision Q32, option A; `queueOrder` in packages/core). */
escalationRoutes.get("/", requireRecruiterOrAdmin, async (c) => {
  const status = c.req.query("status");
  const rows = await withPlatform(c.get("container").db, (tx) =>
    tx.select(PREVIEW_COLUMNS)
      .from(recruiterEscalations)
      .innerJoin(companies, eq(companies.id, recruiterEscalations.companyId))
      .leftJoin(roles, eq(roles.id, recruiterEscalations.roleId))
      .where(status ? eq(recruiterEscalations.status, status) : inArray(recruiterEscalations.status, ["open", "claimed", "in_progress"])),
  );
  return c.json(await previewRows(c, queueOrder(rows), "recruiter queue list"));
});

escalationRoutes.get("/:id", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) return null;
    const [co] = await tx.select({ name: companies.name }).from(companies).where(eq(companies.id, e.companyId)).limit(1);
    const role = e.roleId ? (await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, e.roleId)).limit(1))[0] : null;
    const previewRow: PreviewRow = { id: e.id, companyId: e.companyId, companyName: co?.name ?? "", roleTitle: role?.title ?? null, kind: e.kind, status: e.status, urgency: e.urgency, requiredExpertise: e.requiredExpertise, summary: e.summary, slaDueAt: e.slaDueAt, createdAt: e.createdAt, assignedToUserId: e.assignedToUserId };
    if (e.assignedToUserId !== s.user.id) return { previewRow, full: null as null | Record<string, unknown>, why: e.assignedToUserId ? "claimed by another recruiter" : "claim it to open the full context" };
    // A posting task (plan D3) opens the job ad and the posting only, read below in the customer's own scope; no grant.
    if (isPostingTask(e.kind)) return { previewRow, full: null as null | Record<string, unknown>, why: null as string | null, task: e };
    const grant = await activeStaffGrant(tx, s.user.id, e.companyId);
    if (!grant) return { previewRow, full: null as null | Record<string, unknown>, why: "your access to this customer has ended" };
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    await audit(tx, { companyId: e.companyId, actor, action: "escalation.context_viewed", target: { type: "escalation", id: e.id }, reason: "recruiter queue", details: { grantId: grant.id, expiresAt: grant.expiresAt } });
    await recordStaffAccess(tx, { grant, userName: actor.name, method: "GET", path: `/api/v1/escalations/${e.id}`, ip: clientIp(c) });
    // The thread (plan B5): the team's notes, the recruiter's replies, every answer and why it was reopened.
    const messages = await tx.select().from(escalationMessages).where(eq(escalationMessages.escalationId, e.id));
    // A hand-over reason from before 9 October 2026 in today's words: never how the candidate sounded.
    const question = withoutSentimentWords(e.question);
    const thread = escalationThread({ ...e, question }, messages, actor.name, { forRecruiter: true });
    const full = { companyId: e.companyId, roleId: e.roleId, applicationId: e.applicationId, firstResponseAt: e.firstResponseAt, accessExpiresAt: e.accessExpiresAt, resolution: e.resolution, resolvedAt: e.resolvedAt, minutesSpent: e.minutesSpent, question, contextSnapshot: withoutUnsentInContext(e.contextSnapshot), thread, reopenedCount: messages.filter((m) => m.kind === "reopen").length, grant: { id: grant.id, purpose: grant.purpose, expiresAt: grant.expiresAt, scope: { roleId: grant.roleId, applicationId: grant.applicationId } } };
    return { previewRow, full, why: null as string | null };
  });
  if (!row) throw new HttpError(404, "not_found", "Escalation not found.");
  if ("task" in row && row.task) {
    const [preview] = await previewRows(c, [row.previewRow], "recruiter queue detail");
    return c.json({ ...preview, accessGranted: false, why: null, postingTask: await openPostingTaskDetail(c, row.task, "GET") });
  }
  if (!row.full) {
    const [preview] = await previewRows(c, [row.previewRow], "recruiter queue detail");
    return c.json({ ...preview, accessGranted: false, why: row.why });
  }
  const now = new Date();
  const calendar = await loadBusinessCalendar(container.db, now);
  const preview = toEscalationPreview({ ...row.previewRow, viewerUserId: s.user.id, now, businessMinutesRemaining: row.previewRow.slaDueAt ? businessMinutesBetween(now, new Date(row.previewRow.slaDueAt), calendar) : null });
  return c.json({ ...preview, ...row.full, accessGranted: true });
});

/** Accepting the assignment creates the scoped, time-limited grant and starts the response clock. */
escalationRoutes.post("/:id/claim", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const now = new Date();
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.status === "resolved" || e.status === "cancelled") throw new HttpError(409, "closed", `This request is already ${e.status}.`);
    if (e.assignedToUserId && e.assignedToUserId !== s.user.id) throw new HttpError(409, "claimed", "Another recruiter has this request.");
    // 21 Sep, item 1: when the customer ended this recruiter's access to this request, the same recruiter cannot take it back.
    const removedByCustomer = await tx.select({ id: staffAccessGrants.id }).from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, e.id), eq(staffAccessGrants.userId, s.user.id), like(staffAccessGrants.revokeReason, "revoked by the customer:%"))).limit(1);
    if (removedByCustomer.length) throw new HttpError(403, "revoked_by_customer", "The customer ended your access to this request. Another recruiter must take it.");
    // A posting task (plan D3) needs the job ad, never the customer's records: taking it gives no access at all, so
    // there is no grant to record and nothing to tell the customer about who can see their hiring.
    if (isPostingTask(e.kind)) {
      const recruiter = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
      const [u] = await tx.update(recruiterEscalations).set({ status: "claimed", assignedToUserId: s.user.id, claimedAt: e.claimedAt ?? now.toISOString(), firstResponseAt: e.firstResponseAt ?? now.toISOString() }).where(eq(recruiterEscalations.id, e.id)).returning();
      await emit(tx, { type: "recruiter.claimed", companyId: e.companyId, actor: recruiter, subject: { type: "escalation", id: e.id }, payload: { grantId: null, postingTask: e.kind, postingId: e.postingId } });
      return { escalation: u, grant: null };
    }
    // All of a company's hiring is shared only when someone at the company chose it (Q31). A request that names no role
    // and no candidate and was raised by anyone else (made before that rule, or by ITS staff) grants nothing; an ITS
    // administrator resolves it from the console without opening the company's records.
    if (!e.roleId && !e.applicationId && e.requestedBy.kind !== "user") throw new HttpError(409, "company_access_not_chosen", "This request names no role or candidate, and nobody at the company chose to share all of their hiring. An ITS administrator can resolve it from the console without opening the company's records.");
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    const existing = await activeStaffGrant(tx, s.user.id, e.companyId, now);
    const grant = existing && existing.escalationId === e.id ? existing : await grantStaffAccess(tx, {
      userId: s.user.id, userName: actor.name, companyId: e.companyId, kind: "escalation",
      scope: { escalationId: e.id, roleId: e.roleId, applicationId: e.applicationId },
      purpose: `${e.kind}: ${e.summary || "customer request"}`, grantedBy: actor, expiresAt: new Date(now.getTime() + ESCALATION_ACCESS_DAYS * 86_400_000), now,
    });
    const [u] = await tx.update(recruiterEscalations).set({ status: "claimed", assignedToUserId: s.user.id, claimedAt: e.claimedAt ?? now.toISOString(), firstResponseAt: e.firstResponseAt ?? now.toISOString(), accessExpiresAt: grant.expiresAt }).where(eq(recruiterEscalations.id, e.id)).returning();
    await emit(tx, { type: "recruiter.claimed", companyId: e.companyId, actor, subject: { type: "escalation", id: e.id }, payload: { grantId: grant.id, expiresAt: grant.expiresAt } });
    // Told at once, in the real terms (Q31): who, why, what they can see and until when. A request the team did not make
    // (an ITS recruiter asked while working on another request, a candidate asked for a person, or something got stuck)
    // says how it came about.
    const scope: EscalationScope = e.applicationId ? "application" : e.roleId ? "role" : "company";
    const byTeam = e.requestedBy.kind === "user";
    const why = byTeam ? ""
      : e.requestedBy.kind === "recruiter" ? `${e.requestedBy.name ?? "An ITS recruiter"} (ITS recruiter) asked for this while working on another of your requests, so a recruiter was brought in. `
      : e.requestedBy.kind === "candidate" || e.kind === "candidate_issue" ? "A candidate needed a person, so a recruiter was brought in. "
      : "Something got stuck and needs a person, so a recruiter was brought in. ";
    await notify(tx, { companyId: e.companyId, kind: "recruiter.claimed", title: byTeam ? `${actor.name} (ITS recruiter) picked up your request` : `${actor.name} (ITS recruiter) was brought in`, body: `${why}They can see ${accessWords(scope)} until ${new Date(grant.expiresAt).toLocaleDateString("en-US")}, or until a day after the request is resolved if that is sooner. Every page they open is recorded in your activity, and an owner or admin can end their access in Settings.`, action: { label: "Recruiter access", href: "/setup" } });
    return { escalation: u, grant: { id: grant.id, purpose: grant.purpose, expiresAt: grant.expiresAt, scope: { roleId: grant.roleId, applicationId: grant.applicationId } } };
  });
  return c.json(row);
});

/** Where a notice about a request takes the reader: Today, with that request open in "Your recruiter requests". */
const requestLink = (id: string) => `/?request=${id}`;

/**
 * Who hears about the recruiter's words on a request (plan B4): the person who asked, when someone on the team did, and
 * the owners, in full. Active members only.
 */
async function requestReaders(tx: Tx, e: Pick<EscalationRow, "companyId" | "requestedBy">): Promise<string[]> {
  const owners = await tx.select({ userId: memberships.userId }).from(memberships).where(and(eq(memberships.companyId, e.companyId), eq(memberships.role, "owner"), eq(memberships.status, "active")));
  return [...new Set([...(e.requestedBy.kind === "user" ? [e.requestedBy.id] : []), ...owners.map((m) => m.userId)])];
}

/** What a request is about, for a notice's title: never a candidate's name. */
async function aboutWords(tx: Tx, e: Pick<EscalationRow, "roleId" | "applicationId">): Promise<string> {
  const [role] = e.roleId ? await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, e.roleId)).limit(1) : [];
  if (e.applicationId) return role ? `a candidate for ${role.title}` : "a candidate";
  return role ? role.title : "all of your hiring";
}

/** Where a posting task's work stands as it is closed: the board, the role, and whether the work still waits. */
async function postingTaskState(tx: Tx, e: EscalationRow): Promise<{ notDone: boolean; board: string; roleId: string; roleTitle: string } | null> {
  if (!e.postingId) return null;
  const [p] = await tx.select().from(postings).where(eq(postings.id, e.postingId)).limit(1);
  if (!p || !isBoardChannel(p.channel)) return null;
  const [role] = await tx.select({ title: roles.title, version: roles.currentPacketVersion }).from(roles).where(eq(roles.id, p.roleId)).limit(1);
  return { notDone: !postingTaskWorkDone(e.kind, p, role?.version ?? null), board: BOARD_NAME[p.channel], roleId: p.roleId, roleTitle: role?.title ?? "A role" };
}

/** What the team does when ITS could not do a posting task, after the recruiter's own words. */
const POSTING_NOT_DONE_NEXT: Record<string, (board: string) => string> = {
  post_job: (board) => `Nothing is on ${board} yet. Ask ITS again from the Share tab once that is sorted out, or post it from your company's own account and record the address there.`,
  update_job: (board) => `${board} still shows the earlier version. Ask ITS again from the Share tab, or update the listing from your company's own account and confirm it there.`,
  take_down_job: (board) => `${board} may still show the job. Ask ITS again from the Share tab, or take it down from your company's own account and tick it off there.`,
};

/**
 * Resolution records the recruiter's effort and shortens the grant to a day after resolution. The answer is kept on the
 * thread too, and reaches the person who asked and the owners in full, with a link to the request (plan B4).
 *
 * A job board posting task (plan D3) settles on its own once the work shows on the posting; closing one here ("Cannot
 * do it?" in the queue) while the work still waits means ITS could not do it. The posting stays exactly as it is, the
 * fact is recorded (`notDone` on the event), and the owners and admins are told with the recruiter's words and a link to
 * the role's Posting tab, where the board says so; never a link to a request they cannot open.
 */
escalationRoutes.post("/:id/resolve", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const body = ResolveEscalation.parse(await c.req.json());
  const container = c.get("container");
  const now = new Date();
  const row = await withPlatform(container.db, async (tx) => {
    // Locked and checked, so a double submit or a retry neither adds the answer twice nor tells the team twice.
    const [e] = UUID.test(c.req.param("id") ?? "") ? await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id") ?? "")).limit(1).for("update") : [];
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.assignedToUserId !== s.user.id && s.user.platformRole !== "platform_admin") throw new HttpError(403, "not_assigned", "Claim the request before resolving it.");
    if (e.status === "resolved" || e.status === "cancelled") throw new HttpError(409, "closed", `This request is already ${e.status}.`);
    const accessUntil = await limitGrantAfterResolution(tx, e.id, now);
    const [u] = await tx.update(recruiterEscalations).set({ status: "resolved", resolvedAt: now.toISOString(), resolution: body.resolution, minutesSpent: body.minutesSpent ?? e.minutesSpent ?? null, firstResponseAt: e.firstResponseAt ?? now.toISOString(), accessExpiresAt: accessUntil ?? e.accessExpiresAt }).where(eq(recruiterEscalations.id, e.id)).returning();
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    await recordEscalationAnswer(tx, { escalation: e, author: actor, body: body.resolution, now });
    const task = isPostingTask(e.kind) ? await postingTaskState(tx, e) : null;
    await emit(tx, { type: "recruiter.resolved", companyId: e.companyId, actor, subject: { type: "escalation", id: e.id }, payload: { resolution: body.resolution, minutesSpent: body.minutesSpent ?? null, responseMinutes: e.firstResponseAt ? Math.round((Date.parse(e.firstResponseAt) - Date.parse(e.createdAt)) / 60_000) : null, ...(task ? { postingTask: e.kind, postingId: e.postingId, notDone: task.notDone } : {}) } });
    if (!isPostingTask(e.kind)) {
      await notify(tx, { companyId: e.companyId, kind: "recruiter.resolved", title: `${actor.name} (ITS recruiter) answered the request about ${await aboutWords(tx, e)}`, body: body.resolution, action: { label: "Read the answer", href: requestLink(e.id) }, userIds: await requestReaders(tx, e) });
    } else if (task?.notDone) {
      const label = postingTaskLabel(e.kind, task.board);
      await notify(tx, { companyId: e.companyId, kind: "recruiter.posting_not_done", title: `${task.roleTitle}: ITS could not ${label.charAt(0).toLowerCase()}${label.slice(1)}`, body: `${actor.name} at ITS wrote: "${body.resolution}" ${POSTING_NOT_DONE_NEXT[e.kind](task.board)}`, action: { label: "Open the Share tab", href: `/roles/${task.roleId}?tab=posting` }, roles: ["owner", "admin"] });
    }
    await container.engine.signal(tx, { companyId: e.companyId, key: `escalation:${e.id}`, payload: { resolved: true } });
    return u;
  });
  await container.kick();
  return c.json(row);
});

/**
 * The recruiter writes to the team without resolving the request (plan B5): a question back, or progress. Only the
 * recruiter holding it, under their grant; the words reach the person who asked and the owners in full.
 */
escalationRoutes.post("/:id/messages", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const body = EscalationReply.parse(await c.req.json());
  const container = c.get("container");
  const now = new Date();
  const out = await withPlatform(container.db, async (tx) => {
    const [e] = UUID.test(c.req.param("id") ?? "") ? await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id") ?? "")).limit(1) : [];
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.assignedToUserId !== s.user.id) throw new HttpError(403, "not_assigned", "Accept the request before writing to the customer.");
    if (e.status === "resolved" || e.status === "cancelled") throw new HttpError(409, "closed", `This request is already ${e.status}.`);
    if (isPostingTask(e.kind)) throw new HttpError(409, "posting_task", "A posting task has no conversation with the customer. Record the work on the task; if it cannot be done, resolve it and say why.");
    const grant = await activeStaffGrant(tx, s.user.id, e.companyId, now);
    if (!grant) throw new HttpError(403, "no_access", "Your access to this customer has ended.");
    const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
    await recordStaffAccess(tx, { grant, userName: actor.name, method: "POST", path: `/api/v1/escalations/${e.id}/messages`, ip: clientIp(c) });
    const message = await addEscalationReply(tx, { escalation: e, side: "recruiter", author: actor, body: body.body, now });
    if (e.status === "claimed") await tx.update(recruiterEscalations).set({ status: "in_progress" }).where(eq(recruiterEscalations.id, e.id));
    const told = await notify(tx, { companyId: e.companyId, kind: "recruiter.replied", title: `${actor.name} (ITS recruiter) wrote to you about ${await aboutWords(tx, e)}`, body: body.body, action: { label: "Open the request", href: requestLink(e.id) }, userIds: await requestReaders(tx, e) });
    return { id: message.id, told };
  });
  return c.json(out, 201);
});

/** Handing a request back to the queue ends the recruiter's access immediately. */
escalationRoutes.post("/:id/release", requireRecruiterOrAdmin, async (c) => {
  const s = c.get("session")!;
  const container = c.get("container");
  const now = new Date();
  const row = await withPlatform(container.db, async (tx) => {
    const [e] = await tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, c.req.param("id"))).limit(1);
    if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
    if (e.assignedToUserId !== s.user.id && s.user.platformRole !== "platform_admin") throw new HttpError(403, "not_assigned", "Only the assigned recruiter can release this request.");
    const grants = await tx.select().from(staffAccessGrants).where(and(eq(staffAccessGrants.escalationId, e.id), isNull(staffAccessGrants.endedAt)));
    for (const g of grants) await endStaffGrant(tx, g, "released", now);
    const [u] = await tx.update(recruiterEscalations).set({ status: e.status === "resolved" ? "resolved" : "open", assignedToUserId: null, accessExpiresAt: now.toISOString() }).where(eq(recruiterEscalations.id, e.id)).returning();
    return u;
  });
  return c.json(row);
});

/* ------------------------------------------------------------------------------------------------------------ */
/* ITS posting tasks (plan D3): post the job on a board, bring it up to date, take it down. No access grant.      */
/* ------------------------------------------------------------------------------------------------------------ */

/**
 * The posting task as its recruiter sees it, read in the customer's own scope. Each opening is recorded where the
 * customer sees ITS's activity, like any other look at their company, though only the job ad is in it.
 */
async function openPostingTaskDetail(c: Context<Vars>, task: EscalationRow, method: string) {
  const s = c.get("session")!;
  const container = c.get("container");
  const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  return withTenant(container.db, task.companyId, async (tx) => {
    await audit(tx, { companyId: task.companyId, actor, action: "escalation.context_viewed", target: { type: "escalation", id: task.id }, reason: "posting task", ip: clientIp(c), details: { postingId: task.postingId, kind: task.kind, method, grant: null } });
    return { question: task.question, ...(await postingTaskDetail(tx, container, task)) };
  });
}

/** The posting task the signed-in recruiter holds, still open; refused otherwise, in plain words. */
async function heldPostingTask(c: Context<Vars>, kinds: readonly string[]): Promise<EscalationRow> {
  const s = c.get("session")!;
  const id = c.req.param("id") ?? "";
  const [e] = UUID.test(id) ? await withPlatform(c.get("container").db, (tx) => tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, id)).limit(1)) : [];
  if (!e) throw new HttpError(404, "not_found", "Escalation not found.");
  if (!isPostingTask(e.kind) || !e.postingId) throw new HttpError(409, "not_a_posting_task", "This request is not a job board posting task.");
  if (!kinds.includes(e.kind)) throw new HttpError(409, "wrong_task", "That step does not belong to this kind of posting task.");
  if (e.assignedToUserId !== s.user.id) throw new HttpError(403, "not_assigned", "Accept the task before working on it.");
  if (e.status === "resolved" || e.status === "cancelled") throw new HttpError(409, "closed", `This task is already ${e.status}.`);
  return e;
}

/** Runs one step of a posting task in the customer's scope, on the posting the task names, then answers with the task as it now stands. */
async function postingTaskStep(c: Context<Vars>, kinds: readonly string[], step: (tx: Tx, posting: typeof postings.$inferSelect, actor: { kind: "recruiter"; id: string; name: string }) => Promise<void>) {
  const e = await heldPostingTask(c, kinds);
  const s = c.get("session")!;
  const container = c.get("container");
  const actor = { kind: "recruiter" as const, id: s.user.id, name: s.user.name ?? s.user.email };
  await withTenant(container.db, e.companyId, async (tx) => {
    const [posting] = await tx.select().from(postings).where(eq(postings.id, e.postingId!)).limit(1);
    if (!posting) throw new HttpError(404, "not_found", "The posting this task is about no longer exists.");
    await step(tx, posting, actor);
  });
  await container.kick();
  const [fresh] = await withPlatform(container.db, (tx) => tx.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, e.id)).limit(1));
  return c.json({ status: fresh?.status ?? e.status, postingTask: await openPostingTaskDetail(c, fresh ?? e, "POST") });
}

/** The listing is up: its public address, checked by the worker; the task closes once the check finds the job. */
escalationRoutes.post("/:id/posting/url", requireRecruiterOrAdmin, async (c) => {
  const body = RecordPostingUrl.parse(await c.req.json());
  return postingTaskStep(c, ["post_job", "update_job"], async (tx, posting, actor) => {
    if (!["ready_to_post", "posted_manually", "failed", "live_verified"].includes(posting.status)) throw new HttpError(409, "not_postable", `The listing is "${POSTING_STATE_LABEL[posting.status as PostingState] ?? posting.status}", so no address can be recorded now.`);
    // The same step as the team's own (routes/postings.ts): a listing already live that moved (an update gave it a new
    // address) is "Posted" again, nothing of the earlier check is kept, and it is live again only once the new address
    // is checked.
    await recordBoardAddress(tx, c.get("container"), { posting, url: body.url, actor });
  });
});

/** "I checked it myself": the recruiter saw the listing live; the task closes with their note. */
escalationRoutes.post("/:id/posting/verify", requireRecruiterOrAdmin, async (c) => {
  const body = VerifyPosting.parse(await c.req.json());
  return postingTaskStep(c, ["post_job"], async (tx, posting, actor) => {
    await confirmPostingByHand(tx, c.get("container"), { posting, note: body.note, actor });
  });
});

/** The listing now shows the approved version; the address is checked again, since the title may have changed. */
escalationRoutes.post("/:id/posting/updated", requireRecruiterOrAdmin, async (c) => {
  const body = ConfirmBoardUpdated.parse(await c.req.json().catch(() => ({})));
  return postingTaskStep(c, ["update_job"], async (tx, posting, actor) => {
    const [role] = await tx.select({ version: roles.currentPacketVersion }).from(roles).where(eq(roles.id, posting.roleId)).limit(1);
    if (!role?.version || !showsOldVersion(posting, role.version)) throw new HttpError(409, "up_to_date", "This listing does not show an earlier version of the job.");
    const row = await confirmBoardUpdated(tx, { posting, version: role.version, actor, note: body.note ?? null, now: c.get("container").engine.clock() });
    if (row.externalUrl && ["posted_manually", "live_verified"].includes(row.status)) await queuePostingCheck(tx, c.get("container"), row);
  });
});

/** The listing is gone from the board; the take-down task closes. */
escalationRoutes.post("/:id/posting/removed", requireRecruiterOrAdmin, async (c) => {
  return postingTaskStep(c, ["take_down_job"], async (tx, posting, actor) => {
    if (!posting.closureRequired) throw new HttpError(409, "not_required", "This listing was not up when it closed, so there is nothing to take down.");
    await confirmBoardRemoved(tx, { posting, actor, now: c.get("container").engine.clock() });
  });
});

export const eventRoutes = new Hono<Vars>();

/**
 * The activity list. A recruiter under a grant for one role or one candidate reads only the events about it. A screening
 * conversation the candidate has not sent (or never did) shows no entry about a single answer and no count of what was
 * answered, and no entry about a reading written of one before 9 October 2026 ("scorecard written", its recommendation)
 * (founder decision of 9 October 2026, `withoutUnsentScreenEvents`).
 */
eventRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "events.read");
  const subjectType = c.req.query("subjectType");
  const subjectId = c.req.query("subjectId");
  const type = c.req.query("type");
  const scope = staffScopeOf(t);
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const conds = [eq(events.companyId, t.companyId)];
    if (subjectType) conds.push(eq(events.subjectType, subjectType));
    if (subjectId) conds.push(eq(events.subjectId, subjectId));
    if (type) conds.push(eq(events.type, type));
    // Scoped: read further back, keep what the grant covers, and answer with the same 200 at most.
    const found = await tx.select().from(events).where(and(...conds)).orderBy(desc(events.occurredAt)).limit(scope ? 2000 : 200);
    // The same rule as a job's Activity tab (`withoutUnsentChats`).
    const shown = await withoutUnsentChats(tx, found);
    if (!scope) return shown;
    const targets = await eventTargets(tx, shown);
    return shown.filter((e) => inStaffScope(scope, targets.get(e.id) ?? {})).slice(0, 200);
  });
  return c.json(rows);
});

export const briefRoutes = new Hono<Vars>();

briefRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "role.read");
  const brief = await withTenant(c.get("container").db, t.companyId, (tx) => composeBrief(tx, t.companyId, briefViewerOf(t)));
  return c.json(brief);
});

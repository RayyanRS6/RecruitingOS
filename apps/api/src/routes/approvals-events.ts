import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { DecideApproval, type CandidateNotice, type InterviewDraft } from "@ros/contracts";
import { assertCan, can, companyHasLocked, emit, mayDecideApproval, transition } from "@ros/core";
import { applications, approvalRequests, events, rolePackets, roles, withTenant } from "@ros/db";
import { actorOf, requireTenant, type Vars } from "../middleware/session";
import { assertNotLocked } from "../middleware/candidate-lock";
import { withoutLockedApprovals, withoutLockedEvents } from "../services/locked-visibility";
import { HttpError } from "../middleware/errors";
import { briefViewerOf, composeBrief } from "../services/brief";
import { assertMayApprovePacket } from "../services/packet-approval";
import { CLOSED_ROLE_MESSAGE } from "../services/packet-versions";
import { withoutUnsentChats } from "../services/screen-visibility";
import { settleMessageApproval } from "../services/messages";
import { declineSent, sendApprovedDecline } from "../services/application-actions";
import { sendApprovedClosingMessages } from "../services/closing-messages";
import { approverRolesOf, mayDecideByRole } from "../services/approvers";
import { interviewDraftFor } from "./interviews";
import { assertNoNewWork } from "../services/trial";

export const approvalRoutes = new Hono<Vars>();

/** An id in a path that is not a uuid names nothing: a plain 404 in the route's words, never a database error (10 November 2026). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The approval requests themselves. A request's proposal can carry a candidate's name and a message written to them
 * (F11), so the list needs application.read (an interviewer sees only their own interviews, F9). A request about
 * someone past the plan's candidates per job (Rule 3) is left out.
 */
approvalRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "application.read");
  const status = c.req.query("status") ?? "pending";
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => withoutLockedApprovals(tx, await tx.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, t.companyId), eq(approvalRequests.status, status))).orderBy(desc(approvalRequests.createdAt))));
  return c.json(rows);
});

approvalRoutes.post("/:id/decide", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  const body = DecideApproval.parse(await c.req.json());
  const container = c.get("container");
  // Stamped on the engine's clock, the one the waiting workflow compares against (expiry, the decision after the request).
  const decidedAt = container.engine.clock().toISOString();
  const id = c.req.param("id");
  const result = await withTenant(container.db, t.companyId, async (tx) => {
    const [req] = UUID.test(id) ? await tx.select().from(approvalRequests).where(eq(approvalRequests.id, id)).limit(1) : [];
    if (!req) throw new HttpError(404, "not_found", "Approval request not found.");
    // The approval's id is in the path, not the person's: nobody decides about someone they cannot read (Rule 3).
    await assertNotLocked(tx, t, req.applicationId);
    if (req.status !== "pending") throw new HttpError(409, "decided", `This request is already ${req.status}.`);
    const status = body.decision === "approve" ? "approved" : "rejected";
    const proposedVersion = Number((req.proposal as { version?: number }).version);
    if (req.actionType === "role_packet.approve") {
      // The same rules as POST /roles/:id/approve: the approver roles, the named decision maker, and no self-approval (a rejection may come from anyone who could decide).
      assertCan(t.role, "role.approve");
      const [role] = req.roleId ? await tx.select().from(roles).where(eq(roles.id, req.roleId)).limit(1) : [];
      if (!role) throw new HttpError(404, "not_found", "Role not found.");
      // A closed role is never opened or sent back by a decision (closing one withdraws its request); only ITS reopens one.
      if (role.status === "closed") throw new HttpError(409, "role_closed", CLOSED_ROLE_MESSAGE);
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
    // Approving "Invite to a screen?" starts a new screening chat: new work, which waits for a plan once a trial has ended
    // (founder decision L-02 B), as the invite button does. Refused before anything is written, so the suggestion stays
    // waiting and can be approved once a plan is chosen; "Not now" is never refused.
    if (status === "approved" && req.actionType === "application.invite_screen") await assertNoNewWork(tx, t.companyId, container.engine.clock());
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
      // "Yes, interview" (plan H4): the answer carries the "Set a date and time" form's defaults, so the next click books it.
      if (app && req.actionType === "application.recommend_interview" && can(t.role, "interview.request")) interviewDraft = await interviewDraftFor(tx, { app, now: container.engine.clock() });
    }
    return { ok: true, status, ...(decisionMessage ?? {}), ...(messageStatus ? { messageStatus } : {}), ...(closing ? { closingMessage: closing } : {}), ...(interviewDraft ? { interviewDraft } : {}) };
  });
  await container.kick();
  return c.json(result);
});

export const eventRoutes = new Hono<Vars>();

/**
 * The activity list. A screening
 * conversation the candidate has not sent (or never did) shows no entry about a single answer and no count of what was
 * answered, and no entry about a reading written of one before 9 October 2026 ("scorecard written", its recommendation)
 * (founder decision of 9 October 2026, `withoutUnsentScreenEvents`). Nothing about anyone past the plan's candidates per job
 * (Rule 3, `withoutLockedEvents`): an entry can carry their address.
 */
eventRoutes.get("/", requireTenant, async (c) => {
  const t = c.get("tenant")!;
  assertCan(t.role, "events.read");
  const subjectType = c.req.query("subjectType");
  const subjectId = c.req.query("subjectId");
  const type = c.req.query("type");
  const rows = await withTenant(c.get("container").db, t.companyId, async (tx) => {
    const conds = [eq(events.companyId, t.companyId)];
    if (subjectType) conds.push(eq(events.subjectType, subjectType));
    if (subjectId) conds.push(eq(events.subjectId, subjectId));
    if (type) conds.push(eq(events.type, type));
    // With people past the plan's limit whose entries come out: read further back, keep what may be shown, and answer with the same 200 at most.
    const found = await tx.select().from(events).where(and(...conds)).orderBy(desc(events.occurredAt)).limit((await companyHasLocked(tx, t.companyId)) ? 2000 : 200);
    // The same rules as a job's Activity tab (`withoutUnsentChats`, `withoutLockedEvents`).
    return (await withoutLockedEvents(tx, t.companyId, await withoutUnsentChats(tx, found))).slice(0, 200);
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

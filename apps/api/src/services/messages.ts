import { and, eq } from "drizzle-orm";
import type { Actor, PolicyDecision } from "@ros/contracts";
import { DEFAULT_POLICIES, audit, emit, gate, notify, resolvePolicy } from "@ros/core";
import { applications, approvalRequests, candidates, companies, rolePackets, roles, uuidv7, type Tx } from "@ros/db";
import { freeformFooter, sendFreeformMessage } from "@ros/agents";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";

/**
 * Messages a person writes to a candidate (docs/spec/21 F11). The text is the person's own; the product adds the
 * company's sending name and a footer that says who wrote it and how to reach a person, and never the AI disclosure
 * line, because no AI wrote it. The policy `message.send_freeform` decides whether it goes at once or waits for an
 * owner or admin; the approval request keeps the text so the decision can be made from Today's brief.
 */
type App = typeof applications.$inferSelect;
type ApprovalRow = typeof approvalRequests.$inferSelect;

/** What the approval request keeps of a message waiting for a decision: the text as written, who wrote it, who it is for. */
export type MessageProposal = { subject: string | null; text: string; senderName: string; senderUserId: string; candidateName: string };

export type SendMessageResult = { ok: true; status: "queued"; communicationId: string } | { ok: true; status: "pending_approval"; approvalRequestId: string };

async function loadBundle(tx: Tx, app: App) {
  const [candidate] = await tx.select().from(candidates).where(eq(candidates.id, app.candidateId)).limit(1);
  const [role] = await tx.select().from(roles).where(eq(roles.id, app.roleId)).limit(1);
  const [company] = await tx.select().from(companies).where(eq(companies.id, app.companyId)).limit(1);
  const [pv] = await tx.select().from(rolePackets).where(and(eq(rolePackets.roleId, app.roleId), eq(rolePackets.version, app.packetVersion))).limit(1);
  if (!candidate || !role || !company || !pv) throw new HttpError(409, "incomplete", "This application is missing its candidate record or role packet, so a message cannot be sent.");
  return { candidate, role, company, packet: pv.packet };
}
type Bundle = Awaited<ReturnType<typeof loadBundle>>;

/**
 * Who may decide a waiting message. The rule's own approver roles; when a company left them empty, the platform
 * default's, so that the strictest rule never leaves a message nobody can send.
 */
function approversOf(policy: Pick<PolicyDecision, "approverRoles">): string[] {
  return policy.approverRoles.length ? policy.approverRoles : DEFAULT_POLICIES["message.send_freeform"].approverRoles;
}

/**
 * True when a message from this role waits for an approver before it goes out: under "approval", and under
 * "human_only" too, which the gate never satisfies by itself and which must never give less reading than the level
 * below it. A person holding an approver role is their own approver under both.
 */
function waitsForApprover(policy: Pick<PolicyDecision, "level" | "approverRoles">, role: string): boolean {
  return (policy.level === "approval" || policy.level === "human_only") && !approversOf(policy).includes(role);
}

/** What the sheet shows around the text box: who the message goes to, the footer that follows it, and whether a reply comes back into the product. */
export async function composeMessagePreview(tx: Tx, container: Container, input: { app: App; tenant: Tenant; senderName: string }) {
  const b = await loadBundle(tx, input.app);
  const policy = await resolvePolicy(tx, input.tenant.companyId, input.app.roleId, "message.send_freeform");
  return {
    to: b.candidate.email,
    candidateFirstName: b.candidate.firstName,
    fromName: `${b.company.name} hiring team`,
    footer: freeformFooter({ senderName: input.senderName, company: b.company }),
    repliesComeBack: container.integrations.env.emailInConfigured,
    policyLevel: policy.level,
    /** True when this person's message would wait for one of the approver roles before it goes out. */
    needsApproval: waitsForApprover(policy, input.tenant.role),
  };
}

async function queueMessage(tx: Tx, container: Container, input: { app: App; bundle: Bundle; sender: Actor; auditActor: Actor; tenant: Tenant; proposal: MessageProposal; idempotencyKey: string; approvalRequestId: string | null; approvedBy: string | null }): Promise<Extract<SendMessageResult, { status: "queued" }>> {
  const r = await sendFreeformMessage(tx, container.integrations, { application: input.app, candidate: input.bundle.candidate, role: input.bundle.role, company: input.bundle.company, packet: input.bundle.packet, actor: input.sender, subject: input.proposal.subject, text: input.proposal.text, senderName: input.proposal.senderName, idempotencyKey: input.idempotencyKey });
  if (!("communicationId" in r)) throw new HttpError(409, "no_email", "This candidate has no email address on file, so a message cannot be sent.");
  await audit(tx, { companyId: input.tenant.companyId, actor: input.auditActor, action: "message.sent", target: { type: "application", id: input.app.id }, details: { communicationId: r.communicationId, subject: input.proposal.subject, senderUserId: input.proposal.senderUserId, approvalRequestId: input.approvalRequestId, approvedBy: input.approvedBy } });
  return { ok: true, status: "queued", communicationId: r.communicationId };
}

/** The message waits for an approver: the approver roles are told, the request is audited, and the writer gets a 202. */
async function holdForApprover(tx: Tx, input: { app: App; roleTitle: string; tenant: Tenant; actor: Actor; proposal: MessageProposal; approvalRequestId: string; approverRoles: string[] }): Promise<Extract<SendMessageResult, { status: "pending_approval" }>> {
  const { proposal } = input;
  await notify(tx, { companyId: input.tenant.companyId, kind: "message.approval_requested", title: `Send this message to ${proposal.candidateName}?`, body: `${proposal.senderName} wrote to ${proposal.candidateName} about ${input.roleTitle}. Read it on Today or the candidate's page and decide; nothing goes out until you do.`, action: { label: "Read the message", href: `/roles/${input.app.roleId}/talent?open=${input.app.id}` }, roles: input.approverRoles });
  await audit(tx, { companyId: input.tenant.companyId, actor: input.actor, action: "message.approval_requested", target: { type: "application", id: input.app.id }, details: { approvalRequestId: input.approvalRequestId, subject: proposal.subject, requiredRoles: input.approverRoles } });
  return { ok: true, status: "pending_approval", approvalRequestId: input.approvalRequestId };
}

/**
 * A person writes to a candidate. The policy gate decides: `execute` sends at once (auto_notify also tells the team);
 * `wait_for_approval` files the message for the approver roles, unless the sender holds one of them, whose own click
 * is the approval (the same rule as inviting to a screen from the sheet). `human_only` means nothing automated runs,
 * so the gate files no request of its own; this service files one, because the strictest rule must never give a team
 * member's message less reading than "approval" does. A person holding an approver role satisfies it by writing.
 * Every send is audited; the text lives on the communications row, never in the audit.
 */
export async function sendCandidateMessage(tx: Tx, container: Container, input: { app: App; tenant: Tenant; actor: Actor; body: { subject?: string; text: string } }): Promise<SendMessageResult> {
  const { app, tenant: t, actor } = input;
  const b = await loadBundle(tx, app);
  if (!b.candidate.email) throw new HttpError(409, "no_email", "This candidate has no email address on file, so a message cannot be sent.");
  const candidateName = `${b.candidate.firstName} ${b.candidate.lastName}`.trim();
  const senderName = actor.name ?? "A member of the hiring team";
  const proposal: MessageProposal = { subject: input.body.subject?.trim() || null, text: input.body.text.trim(), senderName, senderUserId: t.userId, candidateName };
  const subject = { type: "application", id: app.id } as const;
  const rationale = `${senderName} wrote to ${candidateName} about ${b.role.title}.`;
  const d = await gate(tx, { companyId: t.companyId, roleId: app.roleId, applicationId: app.id, actionType: "message.send_freeform", subject, proposal, rationale, requestedBy: actor });
  const open = `/roles/${app.roleId}/talent?open=${app.id}`;
  if (d.outcome === "wait_for_approval") {
    if (approversOf(d.decision).includes(t.role)) {
      await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: container.engine.clock().toISOString(), decisionNote: "sent by an approver" }).where(eq(approvalRequests.id, d.approvalRequestId));
      await emit(tx, { type: "approval.granted", companyId: t.companyId, actor, subject: { type: "approval_request", id: d.approvalRequestId }, payload: { actionType: "message.send_freeform", applicationId: app.id, byRequester: true } });
      return queueMessage(tx, container, { app, bundle: b, sender: actor, auditActor: actor, tenant: t, proposal, idempotencyKey: `freeform:approval:${d.approvalRequestId}`, approvalRequestId: d.approvalRequestId, approvedBy: t.userId });
    }
    // A rule saved with no approver roles falls back to the platform default's, on the request too, so the decide route accepts them.
    const approverRoles = approversOf(d.decision);
    if (!d.decision.approverRoles.length) await tx.update(approvalRequests).set({ requiredRoles: approverRoles }).where(eq(approvalRequests.id, d.approvalRequestId));
    return holdForApprover(tx, { app, roleTitle: b.role.title, tenant: t, actor, proposal, approvalRequestId: d.approvalRequestId, approverRoles });
  }
  if (d.outcome === "human_only" && waitsForApprover(d.decision, t.role)) {
    // The gate made no request under human_only; file one here, the same way the gate does under "approval".
    const approverRoles = approversOf(d.decision);
    const [req] = await tx.insert(approvalRequests).values({ companyId: t.companyId, roleId: app.roleId, applicationId: app.id, actionType: "message.send_freeform", subject, proposal, rationale, requestedBy: actor, requiredRoles: approverRoles }).returning({ id: approvalRequests.id });
    await emit(tx, { type: "approval.requested", companyId: t.companyId, actor, subject: { type: "approval_request", id: req.id }, payload: { actionType: "message.send_freeform", subject, requiredRoles: approverRoles, roleId: app.roleId, applicationId: app.id } });
    return holdForApprover(tx, { app, roleTitle: b.role.title, tenant: t, actor, proposal, approvalRequestId: req.id, approverRoles });
  }
  const sent = await queueMessage(tx, container, { app, bundle: b, sender: actor, auditActor: actor, tenant: t, proposal, idempotencyKey: `freeform:${app.id}:${uuidv7()}`, approvalRequestId: null, approvedBy: null });
  if (d.outcome === "execute" && d.notify) {
    await notify(tx, { companyId: t.companyId, kind: "message.sent", title: `${senderName} wrote to ${candidateName}`, body: `About ${b.role.title}${proposal.subject ? `: "${proposal.subject}"` : ""}. The message is on the candidate's page.`, action: { label: "Open the candidate", href: open } });
  }
  return sent;
}

/**
 * The approver's decision on a waiting message (from Today's card, the candidate's page, or the approvals list).
 * Approved: the message goes out under the writer's name and the writer is told. Declined: nothing is sent and the
 * writer is told, in the approver's words when they gave any.
 */
export async function settleMessageApproval(tx: Tx, container: Container, input: { req: ApprovalRow; status: "approved" | "rejected"; actor: Actor; tenant: Tenant; note?: string | null }): Promise<void> {
  const proposal = input.req.proposal as Partial<MessageProposal>;
  if (!input.req.applicationId || !proposal.text) return;
  const [app] = await tx.select().from(applications).where(eq(applications.id, input.req.applicationId)).limit(1);
  if (!app) return;
  const candidateName = proposal.candidateName ?? "the candidate";
  const writerIds = proposal.senderUserId ? [proposal.senderUserId] : [];
  const open = `/roles/${app.roleId}/talent?open=${app.id}`;
  const approver = input.actor.name ?? "An approver";
  if (input.status === "rejected") {
    if (writerIds.length) await notify(tx, { companyId: input.tenant.companyId, kind: "message.declined", title: `Your message to ${candidateName} was not sent`, body: `${approver} decided not to send it${input.note ? `: ${input.note}` : "."} You can write a new one from the candidate's page.`, action: { label: "Open the candidate", href: open }, userIds: writerIds });
    return;
  }
  const b = await loadBundle(tx, app);
  const full: MessageProposal = { subject: proposal.subject ?? null, text: proposal.text, senderName: proposal.senderName ?? "The hiring team", senderUserId: proposal.senderUserId ?? input.tenant.userId, candidateName };
  const writer: Actor = { kind: "user", id: full.senderUserId, name: full.senderName };
  await queueMessage(tx, container, { app, bundle: b, sender: writer, auditActor: input.actor, tenant: input.tenant, proposal: full, idempotencyKey: `freeform:approval:${input.req.id}`, approvalRequestId: input.req.id, approvedBy: input.tenant.userId });
  if (writerIds.length) await notify(tx, { companyId: input.tenant.companyId, kind: "message.sent", title: `Your message to ${candidateName} was sent`, body: `${approver} approved it; it went out under your name.`, action: { label: "Open the candidate", href: open }, userIds: writerIds });
}

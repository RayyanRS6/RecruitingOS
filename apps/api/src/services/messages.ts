import { and, eq, inArray } from "drizzle-orm";
import type { Actor, PolicyDecision, SuggestMessageLine, SuggestedLine } from "@ros/contracts";
import { DEFAULT_POLICIES, audit, emit, gate, notify, resolvePolicy } from "@ros/core";
import { aiRuns, applications, approvalRequests, candidates, companies, interviews, rolePackets, roles, uuidv7, withTenant, type Tx } from "@ros/db";
import { HELD_REASON, UndoError, freeformFooter, sendFreeformMessage, suggestMessageLine, undoQueuedMessage } from "@ros/agents";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { undoUntil } from "./application-actions";

/**
 * Messages a person writes to a candidate (docs/spec/21 F11). The text is the person's own; the product adds the
 * company's sending name and a footer that says who wrote it and how to reach a person, and no AI disclosure line,
 * because no AI wrote it, unless the person kept a line the assistant suggested (Q28): the footer then says the assistant
 * helped. The policy `message.send_freeform` decides whether it goes at once or waits for an owner or admin; the
 * approval request keeps the text so the decision can be made from Today's brief. A message that goes waits out the Undo
 * window first (plan G9).
 */
type App = typeof applications.$inferSelect;
type ApprovalRow = typeof approvalRequests.$inferSelect;

/** What the approval request keeps of a message waiting for a decision: the text as written, who wrote it, who it is for, and whether the assistant helped. */
export type MessageProposal = { subject: string | null; text: string; senderName: string; senderUserId: string; candidateName: string; aiHelped?: boolean; suggestionRunId?: string | null };

/**
 * `held`: saved in the outbox, and it goes out on its own once ITS confirms the company (founder decision B7).
 * `undoUntil`: until when POST /applications/:id/messages/:communicationId/undo can still take it back (plan G9); null
 * when it goes at once.
 */
export type SendMessageResult = { ok: true; status: "queued" | "held"; communicationId: string; undoUntil: string | null } | { ok: true; status: "pending_approval"; approvalRequestId: string };

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

/**
 * What the sheet shows around the text box: who the message goes to, the footer that follows it (and the one it gets
 * when the person keeps a line the assistant suggested, `aiFooter`), whether a reply comes back into the product, and
 * how long the Undo lasts after Send.
 */
export async function composeMessagePreview(tx: Tx, container: Container, input: { app: App; tenant: Tenant; senderName: string }) {
  const b = await loadBundle(tx, input.app);
  const policy = await resolvePolicy(tx, input.tenant.companyId, input.app.roleId, "message.send_freeform");
  return {
    to: b.candidate.email,
    candidateFirstName: b.candidate.firstName,
    fromName: `${b.company.name} hiring team`,
    footer: freeformFooter({ senderName: input.senderName, company: b.company }),
    aiFooter: freeformFooter({ senderName: input.senderName, company: b.company, aiHelped: true }),
    repliesComeBack: container.integrations.env.emailInConfigured,
    policyLevel: policy.level,
    /** True when this person's message would wait for one of the approver roles before it goes out. */
    needsApproval: waitsForApprover(policy, input.tenant.role),
    undoSeconds: container.env.MESSAGE_UNDO_SECONDS,
  };
}

/** A suggestion the message says it used must be one of this company's own suggestions; anything else is dropped. */
async function suggestionRunOf(tx: Tx, runId: string | null | undefined): Promise<string | null> {
  if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) return null;
  const [run] = await tx.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.id, runId), eq(aiRuns.promptKey, "message.suggest_line"))).limit(1);
  return run?.id ?? null;
}

async function queueMessage(tx: Tx, container: Container, input: { app: App; bundle: Bundle; sender: Actor; auditActor: Actor; tenant: Tenant; proposal: MessageProposal; idempotencyKey: string; approvalRequestId: string | null; approvedBy: string | null; holdForUndo: boolean }): Promise<Extract<SendMessageResult, { communicationId: string }>> {
  const sendAt = input.holdForUndo ? undoUntil(container) : null;
  const r = await sendFreeformMessage(tx, container.integrations, { application: input.app, candidate: input.bundle.candidate, role: input.bundle.role, company: input.bundle.company, packet: input.bundle.packet, actor: input.sender, subject: input.proposal.subject, text: input.proposal.text, senderName: input.proposal.senderName, idempotencyKey: input.idempotencyKey, aiHelped: !!input.proposal.aiHelped, aiRunId: await suggestionRunOf(tx, input.proposal.suggestionRunId), sendAt });
  if (!("communicationId" in r)) throw new HttpError(409, "no_email", "This candidate has no email address on file, so a message cannot be sent.");
  await audit(tx, { companyId: input.tenant.companyId, actor: input.auditActor, action: "message.sent", target: { type: "application", id: input.app.id }, details: { communicationId: r.communicationId, subject: input.proposal.subject, senderUserId: input.proposal.senderUserId, approvalRequestId: input.approvalRequestId, approvedBy: input.approvedBy, aiHelped: !!input.proposal.aiHelped } });
  // A company ITS has not confirmed yet keeps it in the outbox until the check (founder decision B7): never "on its way".
  const held = r.status === "pending" && r.reason === HELD_REASON;
  return { ok: true, status: held ? "held" : "queued", communicationId: r.communicationId, undoUntil: sendAt && !held ? sendAt.toISOString() : null };
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
export async function sendCandidateMessage(tx: Tx, container: Container, input: { app: App; tenant: Tenant; actor: Actor; body: { subject?: string; text: string; aiHelped?: boolean; suggestionRunId?: string } }): Promise<SendMessageResult> {
  const { app, tenant: t, actor } = input;
  const b = await loadBundle(tx, app);
  if (!b.candidate.email) throw new HttpError(409, "no_email", "This candidate has no email address on file, so a message cannot be sent.");
  const candidateName = `${b.candidate.firstName} ${b.candidate.lastName}`.trim();
  const senderName = actor.name ?? "A member of the hiring team";
  const proposal: MessageProposal = { subject: input.body.subject?.trim() || null, text: input.body.text.trim(), senderName, senderUserId: t.userId, candidateName, ...(input.body.aiHelped ? { aiHelped: true, suggestionRunId: input.body.suggestionRunId ?? null } : {}) };
  const subject = { type: "application", id: app.id } as const;
  const rationale = `${senderName} wrote to ${candidateName} about ${b.role.title}.`;
  const d = await gate(tx, { companyId: t.companyId, roleId: app.roleId, applicationId: app.id, actionType: "message.send_freeform", subject, proposal, rationale, requestedBy: actor });
  const open = `/roles/${app.roleId}/talent?open=${app.id}`;
  if (d.outcome === "wait_for_approval") {
    if (approversOf(d.decision).includes(t.role)) {
      await tx.update(approvalRequests).set({ status: "approved", decidedBy: t.userId, decidedAt: container.engine.clock().toISOString(), decisionNote: "sent by an approver" }).where(eq(approvalRequests.id, d.approvalRequestId));
      await emit(tx, { type: "approval.granted", companyId: t.companyId, actor, subject: { type: "approval_request", id: d.approvalRequestId }, payload: { actionType: "message.send_freeform", applicationId: app.id, byRequester: true } });
      return queueMessage(tx, container, { app, bundle: b, sender: actor, auditActor: actor, tenant: t, proposal, idempotencyKey: `freeform:approval:${d.approvalRequestId}`, approvalRequestId: d.approvalRequestId, approvedBy: t.userId, holdForUndo: true });
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
  const sent = await queueMessage(tx, container, { app, bundle: b, sender: actor, auditActor: actor, tenant: t, proposal, idempotencyKey: `freeform:${app.id}:${uuidv7()}`, approvalRequestId: null, approvedBy: null, holdForUndo: true });
  if (d.outcome === "execute" && d.notify) {
    await notify(tx, { companyId: t.companyId, kind: "message.sent", title: `${senderName} wrote to ${candidateName}`, body: `About ${b.role.title}${proposal.subject ? `: "${proposal.subject}"` : ""}. The message is on the candidate's page.`, action: { label: "Open the candidate", href: open } });
  }
  return sent;
}

/**
 * The approver's decision on a waiting message (from Today's card, the candidate's page, or the approvals list).
 * Approved: the message goes out under the writer's name and the writer is told. Declined: nothing is sent and the
 * writer is told, in the approver's words when they gave any. Returns what became of an approved message: on its way,
 * or held until ITS confirms the company; null when nothing was sent.
 */
export async function settleMessageApproval(tx: Tx, container: Container, input: { req: ApprovalRow; status: "approved" | "rejected"; actor: Actor; tenant: Tenant; note?: string | null }): Promise<"queued" | "held" | null> {
  const proposal = input.req.proposal as Partial<MessageProposal>;
  if (!input.req.applicationId || !proposal.text) return null;
  const [app] = await tx.select().from(applications).where(eq(applications.id, input.req.applicationId)).limit(1);
  if (!app) return null;
  const candidateName = proposal.candidateName ?? "the candidate";
  const writerIds = proposal.senderUserId ? [proposal.senderUserId] : [];
  const open = `/roles/${app.roleId}/talent?open=${app.id}`;
  const approver = input.actor.name ?? "An approver";
  if (input.status === "rejected") {
    if (writerIds.length) await notify(tx, { companyId: input.tenant.companyId, kind: "message.declined", title: `Your message to ${candidateName} was not sent`, body: `${approver} decided not to send it${input.note ? `: ${input.note}` : "."} You can write a new one from the candidate's page.`, action: { label: "Open the candidate", href: open }, userIds: writerIds });
    return null;
  }
  const b = await loadBundle(tx, app);
  const full: MessageProposal = { subject: proposal.subject ?? null, text: proposal.text, senderName: proposal.senderName ?? "The hiring team", senderUserId: proposal.senderUserId ?? input.tenant.userId, candidateName, aiHelped: !!proposal.aiHelped, suggestionRunId: proposal.suggestionRunId ?? null };
  const writer: Actor = { kind: "user", id: full.senderUserId, name: full.senderName };
  // The approver's click is the second look, so it goes at once (no Undo window).
  const sent = await queueMessage(tx, container, { app, bundle: b, sender: writer, auditActor: input.actor, tenant: input.tenant, proposal: full, idempotencyKey: `freeform:approval:${input.req.id}`, approvalRequestId: input.req.id, approvedBy: input.tenant.userId, holdForUndo: false });
  if (writerIds.length) {
    const held = sent.status === "held";
    await notify(tx, { companyId: input.tenant.companyId, kind: "message.sent", title: held ? `Your message to ${candidateName} was approved` : `Your message to ${candidateName} was sent`, body: held ? `${approver} approved it. It goes out under your name as soon as ITS confirms your company.` : `${approver} approved it; it went out under your name.`, action: { label: "Open the candidate", href: open }, userIds: writerIds });
  }
  return sent.status;
}

/**
 * Undo (plan G9): a message someone on the team sent (a message they wrote, a decision message, a closing message) is
 * taken back while it still waits in the outbox. A decision message taken back leaves the candidate not told, as before
 * the Send. Audited. Refused once it has gone (409 `already_sent`), for a message the product sent by itself (409
 * `not_yours`), and for anyone who may not write to candidates or tell decisions (the route's permission).
 */
export async function undoMessage(tx: Tx, container: Container, input: { app: App; communicationId: string; tenant: Tenant; actor: Actor }): Promise<{ ok: true; communicationId: string; toldState: string | null }> {
  const r = await undoQueuedMessage(tx, { communicationId: input.communicationId, applicationId: input.app.id, actor: input.actor, now: container.engine.clock() }).catch((e: unknown) => {
    if (e instanceof UndoError) throw new HttpError(e.code === "not_found" ? 404 : 409, e.code, e.message);
    throw e;
  });
  await audit(tx, { companyId: input.tenant.companyId, actor: input.actor, action: "message.undone", target: { type: "application", id: input.app.id }, details: { communicationId: input.communicationId, template: r.templateKey } });
  const [after] = await tx.select({ toldState: applications.toldState }).from(applications).where(eq(applications.id, input.app.id)).limit(1);
  return { ok: true, communicationId: input.communicationId, toldState: r.templateKey?.startsWith("disposition:") ? after?.toldState ?? null : null };
}

/** What the suggestion's page shows beside the line. */
const SUGGESTION_NOTE = "Suggested by the AI assistant. Change it as you like, or leave it out. If you keep it, the email says the assistant helped write it.";

/**
 * The assistant suggests one line for an interview invitation or an update (Q28; `SuggestedLine`). It sees the company's
 * name, the job title and, for an invitation, the interview's title: nothing about the candidate. The model runs with no
 * transaction open; the line comes back checked like a person's own, or not at all.
 */
export async function suggestLine(container: Container, input: { tenant: Tenant; applicationId: string; body: SuggestMessageLine }): Promise<SuggestedLine> {
  // A short read in the company's own transaction, closed before the model is called.
  const facts = await withTenant(container.db, input.tenant.companyId, async (tx) => {
    const [app] = await tx.select().from(applications).where(eq(applications.id, input.applicationId)).limit(1);
    if (!app) return null;
    const b = await loadBundle(tx, app);
    if (input.body.purpose !== "interview_invite") return { companyName: b.company.name, roleTitle: b.packet.identity.title, interviewTitle: null };
    // The round being approved names the interview; otherwise the one already being set up.
    const round = input.body.roundKey ? b.packet.interviews.plan.find((r) => r.key === input.body.roundKey) : undefined;
    const [iv] = round ? [] : await tx.select({ title: interviews.title }).from(interviews).where(and(eq(interviews.applicationId, app.id), inArray(interviews.status, ["proposed", "scheduling"]))).limit(1);
    return { companyName: b.company.name, roleTitle: b.packet.identity.title, interviewTitle: round?.title ?? iv?.title ?? null };
  });
  if (!facts) throw new HttpError(404, "not_found", "Application not found.");
  const out = await suggestMessageLine(container.db, container.ai, { companyId: input.tenant.companyId, applicationId: input.applicationId, purpose: input.body.purpose, ...facts });
  return { line: out.line, aiHelped: true, suggestionRunId: out.runId, note: out.line ? SUGGESTION_NOTE : "The assistant has no suggestion right now. Write your own line, or leave it out." };
}

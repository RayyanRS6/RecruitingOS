import type { Actor, ClosingMessagePreview, ClosingMessageResult } from "@ros/contracts";
import { assertCan, audit, emit, gate } from "@ros/core";
import type { Tx, approvalRequests } from "@ros/db";
import { closingAudience, closingMessageText, isClosingProposal, queueClosingMessages, type ClosingProposal } from "@ros/agents";
import { HttpError } from "../middleware/errors";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { declineMessagePolicy, undoUntil } from "./application-actions";

/**
 * The closing message of a closed role (founder decision Q30; plan G4). Closing a role moves everyone still in process
 * to the talent pool privately (B6), and they stay there unless they asked not to be kept. One courteous message then
 * tells all of them, approved once for everyone: under "Do it" the person's press is that approval, under "Ask me first"
 * one approval request covers the whole group, and under "Only a person" nothing is sent. People already told, or whose
 * own message waits for an approver, are left out; every message has one key per person, so nobody is told twice.
 */
type ApprovalRow = typeof approvalRequests.$inferSelect;

export const closingSendPath = (roleId: string) => `/api/v1/roles/${roleId}/closing-message`;

/** Who the closing message goes to and what it says (`ClosingMessagePreview`). Null when the role is not found; 409 while it is open. */
export async function closingMessagePreview(tx: Tx, container: Container, roleId: string): Promise<ClosingMessagePreview | null> {
  const aud = await closingAudience(tx, roleId);
  if (!aud) return null;
  if (aud.role.status !== "closed") throw new HttpError(409, "role_not_closed", "The closing message is for a role that has closed. Close the role with its outcome first.");
  const byCandidate = new Map(aud.people.map((p) => [p.id, p]));
  const people = aud.apps.map((a) => {
    const c = byCandidate.get(a.candidateId);
    return { applicationId: a.id, name: c ? `${c.firstName} ${c.lastName}`.trim() || "A candidate" : "A candidate", hasEmail: !!c?.email, optedOut: !!c?.preferences.talentPoolOptOut };
  });
  const message = aud.apps[0] ? await closingMessageText(tx, { app: aud.apps[0], statusBaseUrl: container.env.JOBS_BASE_URL }) : null;
  return {
    roleId: aud.role.id,
    roleTitle: aud.role.title,
    count: people.length,
    people,
    subject: message?.subject ?? "",
    text: message?.text ?? "",
    alreadyTold: aud.alreadyTold,
    waitingApproval: aud.waitingApproval,
    noEmail: people.filter((p) => !p.hasEmail).length,
    optedOut: people.filter((p) => p.optedOut).length,
    policy: await declineMessagePolicy(tx, { companyId: aud.role.companyId, roleId: aud.role.id }),
    waitingApprovalId: aud.batch?.id ?? null,
    sendPath: closingSendPath(aud.role.id),
  };
}

const tally = (results: ClosingMessageResult["results"]) => ({
  queued: results.filter((r) => r.candidateNotice === "queued").length,
  held: results.filter((r) => r.candidateNotice === "held").length,
  notSent: results.filter((r) => r.candidateNotice !== "queued" && r.candidateNotice !== "held").length,
});

/**
 * "Send the closing message" from the closed role's card: everyone listed in the preview (or the ones chosen among them),
 * through one gate for the whole group. Refused for someone who may not tell candidates decisions, for an ITS recruiter
 * whose access covers one candidate only, while the role is open, and while the group's approval is already waiting.
 */
export async function sendClosingMessage(tx: Tx, container: Container, input: { roleId: string; tenant: Tenant; actor: Actor; applicationIds?: string[] }): Promise<ClosingMessageResult> {
  assertCan(input.tenant.role, "application.reject");
  if (input.tenant.staff?.scope.applicationId) throw new HttpError(403, "staff_scope", "Your access covers one candidate, so you can't send the closing message to the role's whole group.");
  const aud = await closingAudience(tx, input.roleId);
  if (!aud) throw new HttpError(404, "not_found", "Role not found.");
  if (aud.role.status !== "closed") throw new HttpError(409, "role_not_closed", "The closing message is for a role that has closed. Close the role with its outcome first.");
  if (aud.batch) throw new HttpError(409, "waiting_approval", "The closing message is already waiting for approval.");
  const listed = new Set(aud.apps.map((a) => a.id));
  const ids = input.applicationIds ? [...new Set(input.applicationIds)].filter((id) => listed.has(id)) : [...listed];
  if (!ids.length) throw new HttpError(409, "nothing_to_send", "Everyone this role left in your talent pool has been told already, or their message waits for approval.");
  const proposal: ClosingProposal = { kind: "role_closed", applicationIds: ids, count: ids.length };
  const d = await gate(tx, { companyId: aud.role.companyId, roleId: aud.role.id, applicationId: null, actionType: "disposition.send", subject: { type: "role", id: aud.role.id }, proposal, rationale: `${input.actor.name ?? "Someone on your team"} wants to send the closing message to ${ids.length === 1 ? "1 person" : `${ids.length} people`} who were still in process when ${aud.role.title} closed. Nobody is told until it is approved.`, requestedBy: input.actor });
  let result: ClosingMessageResult;
  if (d.outcome === "wait_for_approval") result = { status: "waiting_approval", approvalRequestId: d.approvalRequestId, queued: 0, held: 0, notSent: 0, results: [] };
  else if (d.outcome === "human_only") result = { status: "not_sent_settings", queued: 0, held: 0, notSent: ids.length, results: ids.map((applicationId) => ({ applicationId, ok: false, candidateNotice: "not_sent_settings" as const })) };
  else {
    const results = await queueClosingMessages(tx, container.integrations, { roleId: aud.role.id, applicationIds: ids, actor: input.actor, statusBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock(), sendAt: undoUntil(container) });
    result = { status: "sent", ...tally(results), results };
  }
  await emit(tx, { type: "role.closing_message", companyId: aud.role.companyId, actor: input.actor, subject: { type: "role", id: aud.role.id }, payload: { status: result.status, requested: ids.length, queued: result.queued, held: result.held, approvalRequestId: result.approvalRequestId ?? null } });
  await audit(tx, { companyId: aud.role.companyId, actor: input.actor, action: "role.closing_message", target: { type: "role", id: aud.role.id }, reason: result.status, details: { requested: ids.length, queued: result.queued, held: result.held, notSent: result.notSent, approvalRequestId: result.approvalRequestId ?? null } });
  return result;
}

/**
 * The approved half of the closing message's one approval request: everyone it named who is still untold gets it, at
 * once (the approver's click is the second look). Nothing is sent when the role was reopened in the meantime (an
 * administrator voided its outcome): the closing message is only for a closed role. Null when the request is not a
 * closing message.
 */
export async function sendApprovedClosingMessages(tx: Tx, container: Container, input: { req: ApprovalRow; actor: Actor }): Promise<ClosingMessageResult | null> {
  if (!isClosingProposal(input.req.proposal) || !input.req.roleId) return null;
  const aud = await closingAudience(tx, input.req.roleId);
  if (!aud) return null;
  if (aud.role.status !== "closed") {
    const named = input.req.proposal.applicationIds;
    return { status: "role_reopened", queued: 0, held: 0, notSent: named.length, results: named.map((applicationId) => ({ applicationId, ok: false, code: "role_not_closed", message: "The role was reopened, so the closing message was not sent." })) };
  }
  const still = new Set(aud.apps.map((a) => a.id));
  const ids = input.req.proposal.applicationIds.filter((id) => still.has(id));
  const results = await queueClosingMessages(tx, container.integrations, { roleId: aud.role.id, applicationIds: ids, actor: input.actor, statusBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock() });
  const result: ClosingMessageResult = { status: "sent", ...tally(results), results };
  await emit(tx, { type: "role.closing_message", companyId: aud.role.companyId, actor: input.actor, subject: { type: "role", id: aud.role.id }, payload: { status: "approved", requested: input.req.proposal.applicationIds.length, queued: result.queued, held: result.held, approvalRequestId: input.req.id } });
  return result;
}

import { eq } from "drizzle-orm";
import { SEND_MAX_ATTEMPTS, queueCommunication, sendQueuedCommunication } from "@ros/agents";
import type { Actor } from "@ros/contracts";
import { loadBusinessCalendar, servedSummary } from "@ros/core";
import { recruiterEscalations, users, withPlatform, withTenant, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { boardView, loadPool } from "./pool";

/** Who raised a request, as the queue email says it: a customer, a candidate, or the product on its own. */
export type QueueNoticeOrigin = "customer" | "candidate" | "system";

/** What the ITS queue is told about a new request. `companyId` and `origin` are read from the request when left out. */
export type QueueNotice = { id: string; kind: string; slaDueAt: string; urgency: string; requiredExpertise: string; summary: string; timeZone: string; companyId?: string; origin?: QueueNoticeOrigin };

/** What sending to ITS needs from the container; the container itself fits, and so does the job that runs before it exists. */
export type ItsMailDeps = Pick<Container, "db" | "integrations"> & { env: Pick<Container["env"], "ITS_QUEUE_EMAIL" | "PRODUCT_NAME" | "APP_BASE_URL">; clock?: () => Date };

const ITS_MAIL_ACTOR: Actor = { kind: "system", id: "its_queue_mail" };

function originOf(requestedBy: Actor): QueueNoticeOrigin {
  if (requestedBy.kind === "candidate") return "candidate";
  if (requestedBy.kind === "user" || requestedBy.kind === "recruiter") return "customer";
  return "system";
}

/**
 * The queue notice of a request just created, read back in the caller's tenant transaction. The summary is served as the
 * queue shows it (`servedSummary`: one Recruiting OS raised says so); who raised it is read for that and never sent.
 */
export async function queueNoticeOf(tx: Tx, escalationId: string): Promise<QueueNotice | null> {
  const [row] = await tx.select({ companyId: recruiterEscalations.companyId, kind: recruiterEscalations.kind, slaDueAt: recruiterEscalations.slaDueAt, urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary, requestedBy: recruiterEscalations.requestedBy, roleId: recruiterEscalations.roleId, applicationId: recruiterEscalations.applicationId }).from(recruiterEscalations).where(eq(recruiterEscalations.id, escalationId)).limit(1);
  if (!row?.slaDueAt) return null;
  return { id: escalationId, companyId: row.companyId, origin: originOf(row.requestedBy), kind: row.kind, slaDueAt: row.slaDueAt, urgency: row.urgency, requiredExpertise: row.requiredExpertise, summary: servedSummary(row), timeZone: (await loadBusinessCalendar(tx)).timeZone };
}

const OPENING: Record<QueueNoticeOrigin, string> = {
  customer: "A customer asked for a recruiter.",
  candidate: "A candidate asked for a person, through the product.",
  system: "The product raised a request for a recruiter on its own.",
};

/** The queue email's words: pre-acceptance context only (correction 11), never the request's own words. */
export function queueNoticeEmail(n: QueueNotice, appBaseUrl: string): { subject: string; text: string } {
  return {
    subject: `[${n.kind}] ${n.urgency} urgency: respond by ${new Date(n.slaDueAt).toLocaleString("en-US", { timeZone: n.timeZone })} (${n.timeZone})`,
    text: `${OPENING[n.origin ?? "customer"]}\n\nCategory: ${n.kind}\nUrgency: ${n.urgency}\nNeeds: ${n.requiredExpertise}\nSummary: ${n.summary}\n\nAccept it in the queue to open the full request: ${appBaseUrl}/recruiter/queue/${n.id}`,
  };
}

/**
 * An email to the ITS queue mailbox that is never lost quietly (audit row 125): it is written to the outbox as the
 * company's message (recorded in `communications` under `idempotencyKey`, so it is sent once) and sent at once. When
 * the provider fails, the outbox retries it for about an hour; if it still cannot go, the message is marked failed and
 * ITS gets an alert (`message.delivery_failed`). A key already used returns that message and sends nothing again.
 */
export async function sendToIts(deps: ItsMailDeps, input: { companyId: string; subject: string; text: string; idempotencyKey: string; template: string }): Promise<{ status: "sent" | "pending" | "failed"; communicationId: string }> {
  const now = deps.clock?.() ?? deps.integrations.clock();
  const queued = await withTenant(deps.db, input.companyId, (tx) => queueCommunication(tx, deps.integrations, {
    channel: "email", companyId: input.companyId, to: deps.env.ITS_QUEUE_EMAIL, from: `${deps.env.PRODUCT_NAME} <${deps.integrations.env.fromAddress}>`,
    subject: input.subject, text: input.text, templateKey: input.template, idempotencyKey: input.idempotencyKey, tags: { template: input.template }, actor: ITS_MAIL_ACTOR,
  }, now));
  if (queued.status !== "pending") return { status: queued.status, communicationId: queued.communicationId };
  // The first try now, so ITS hears at once as before; the queued job is the retry (it skips a message already gone).
  try {
    const outcome = await sendQueuedCommunication(deps.db, deps.integrations, { communicationId: queued.communicationId, companyId: input.companyId }, { attempt: 1, maxAttempts: SEND_MAX_ATTEMPTS, now });
    // "unknown": the provider's reply was cut off; not confirmed, alerted, and never re-sent on a guess
    return { status: outcome === "sent" ? "sent" : outcome === "failed" || outcome === "cancelled" || outcome === "unknown" ? "failed" : "pending", communicationId: queued.communicationId };
  } catch {
    // a retryable failure: the row is queued again and the send job tries with backoff
    return { status: "pending", communicationId: queued.communicationId };
  }
}

/**
 * Tells the ITS queue a request came in. Pre-acceptance context only (correction 11): category, urgency, expertise and
 * the generic summary, never the customer's words; the full request opens once someone accepts it. Through the outbox
 * under `escalation:<id>` (`sendToIts`), so a failure is recorded and alerted, and the request is never emailed twice.
 */
export async function emailItsQueue(deps: ItsMailDeps, n: QueueNotice): Promise<void> {
  const companyId = n.companyId ?? (await withPlatform(deps.db, (tx) => tx.select({ companyId: recruiterEscalations.companyId }).from(recruiterEscalations).where(eq(recruiterEscalations.id, n.id)).limit(1)))[0]?.companyId;
  if (!companyId) return;
  const { subject, text } = queueNoticeEmail(n, deps.env.APP_BASE_URL);
  await sendToIts(deps, { companyId, subject, text, idempotencyKey: `escalation:${n.id}`, template: "escalation" });
}

/**
 * The job behind `ESCALATION_QUEUE_EMAIL_JOB_KIND` (packages/core/src/escalations.ts): a request the system raised, or
 * a candidate through the product, is emailed to the ITS queue mailbox like one a customer raised (audit row 36). A
 * request that is gone or was already answered or cancelled is not emailed.
 */
export async function emailQueueAboutRequest(deps: ItsMailDeps, input: { escalationId: string; companyId: string }): Promise<boolean> {
  const notice = await withTenant(deps.db, input.companyId, async (tx) => {
    const [row] = await tx.select({ status: recruiterEscalations.status }).from(recruiterEscalations).where(eq(recruiterEscalations.id, input.escalationId)).limit(1);
    if (!row || row.status === "resolved" || row.status === "cancelled") return null;
    return queueNoticeOf(tx, input.escalationId);
  });
  if (!notice) return false;
  await emailItsQueue(deps, { ...notice, companyId: input.companyId });
  return true;
}

/** A note the team added to a request a recruiter already holds. */
export type HeldNote = { escalationId: string; kind: string; holderId: string; messageId: string };

/**
 * Tells the recruiter holding a request that the team added a note (a later "Something wrong?" flag, plan F11), never
 * its words: they read it in the queue under their grant, as with a note sent from Your recruiter requests. The
 * recruiter is not a member, so their address is read on the platform side (email only).
 */
export async function emailHolderAboutNote(container: Container, n: HeldNote): Promise<boolean> {
  const [holder] = await withPlatform(container.db, (tx) => tx.select({ email: users.email }).from(users).where(eq(users.id, n.holderId)).limit(1));
  if (!holder?.email) return false;
  const sent = await container.integrations.email.send({
    to: holder.email,
    from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
    subject: `[${n.kind}] The customer added a note to a request you hold`,
    text: `The customer added a note to a request you are working on. Read it in the queue: ${container.env.APP_BASE_URL}/recruiter/queue/${n.escalationId}`,
    idempotencyKey: `escalation-message:${n.messageId}`,
    tags: { template: "escalation_note" },
  });
  return sent.status !== "failed";
}

/**
 * The pool board as it stood, added to a role review's context (plan F9): the summary, and for each person the column,
 * the score, the reason and what needs a person's eye. It opens only under the recruiter's grant, like the rest.
 */
export async function attachBoardSnapshot(tx: Tx, input: { escalationId: string; roleId: string; tenant: Pick<Tenant, "staff">; now: Date }): Promise<void> {
  const view = boardView(await loadPool(tx, { roleId: input.roleId, tenant: input.tenant }), input.now);
  const people = [...Object.values(view.columns).flat(), ...view.stillApplying].map((c) => ({ applicationId: c.applicationId, name: c.name, column: c.placement.column, state: c.placement.state, score: c.score?.score ?? null, reason: c.placement.reason, needsYourEye: c.placement.needsYourEye, nextStep: c.placement.nextStep?.label ?? null }));
  const [row] = await tx.select({ contextSnapshot: recruiterEscalations.contextSnapshot }).from(recruiterEscalations).where(eq(recruiterEscalations.id, input.escalationId)).limit(1);
  await tx.update(recruiterEscalations).set({ contextSnapshot: { ...(row?.contextSnapshot ?? {}), board: { capturedAt: view.generatedAt, summary: view.summary, people } } }).where(eq(recruiterEscalations.id, input.escalationId));
}

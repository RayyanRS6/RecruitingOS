import { eq } from "drizzle-orm";
import { loadBusinessCalendar, servedSummary } from "@ros/core";
import { recruiterEscalations, users, withPlatform, type Tx } from "@ros/db";
import type { Container } from "../container";
import type { Tenant } from "../middleware/session";
import { boardView, loadPool } from "./pool";

/** What the ITS queue is told about a new request. */
export type QueueNotice = { id: string; kind: string; slaDueAt: string; urgency: string; requiredExpertise: string; summary: string; timeZone: string };

/**
 * The queue notice of a request just created, read back in the caller's tenant transaction. The summary is served as the
 * queue shows it (`servedSummary`: one Recruiting OS raised says so); who raised it is read for that and never sent.
 */
export async function queueNoticeOf(tx: Tx, escalationId: string): Promise<QueueNotice | null> {
  const [row] = await tx.select({ kind: recruiterEscalations.kind, slaDueAt: recruiterEscalations.slaDueAt, urgency: recruiterEscalations.urgency, requiredExpertise: recruiterEscalations.requiredExpertise, summary: recruiterEscalations.summary, requestedBy: recruiterEscalations.requestedBy, roleId: recruiterEscalations.roleId, applicationId: recruiterEscalations.applicationId }).from(recruiterEscalations).where(eq(recruiterEscalations.id, escalationId)).limit(1);
  if (!row?.slaDueAt) return null;
  return { id: escalationId, kind: row.kind, slaDueAt: row.slaDueAt, urgency: row.urgency, requiredExpertise: row.requiredExpertise, summary: servedSummary(row), timeZone: (await loadBusinessCalendar(tx)).timeZone };
}

/**
 * Tells the ITS queue a request came in. Pre-acceptance context only (correction 11): category, urgency, expertise and
 * the generic summary, never the customer's words; the full request opens once someone accepts it.
 */
export async function emailItsQueue(container: Container, n: QueueNotice): Promise<void> {
  await container.integrations.email.send({
    to: container.env.ITS_QUEUE_EMAIL,
    from: `${container.env.PRODUCT_NAME} <${container.integrations.env.fromAddress}>`,
    subject: `[${n.kind}] ${n.urgency} urgency: respond by ${new Date(n.slaDueAt).toLocaleString("en-US", { timeZone: n.timeZone })} (${n.timeZone})`,
    text: `A customer asked for a recruiter.\n\nCategory: ${n.kind}\nUrgency: ${n.urgency}\nNeeds: ${n.requiredExpertise}\nSummary: ${n.summary}\n\nAccept it in the queue to open the full request: ${container.env.APP_BASE_URL}/recruiter/queue/${n.id}`,
    idempotencyKey: `escalation:${n.id}`,
    tags: { template: "escalation" },
  });
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

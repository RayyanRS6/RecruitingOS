import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { isCompanyVerified, type Actor } from "@ros/contracts";
import { emit, nextContactWindow, notify, raiseAlert } from "@ros/core";
import { applications, candidates, communications, companies, jobs, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import type { Integrations, SendResult } from "@ros/integrations";

/**
 * The outbox for every email and text the product sends from inside a database transaction.
 *
 * Sending from inside a transaction is unsafe: a later statement can fail, the process can die, the step's lease can
 * expire, and the transaction rolls back and runs again while the candidate already has the message. So a send is two
 * halves. The first half runs inside the caller's transaction and only writes a `communications` row as `queued` (with
 * a unique idempotency key, so a step that runs twice finds its row instead of writing a second) plus a job. The
 * second half is that job: after the transaction has committed, the worker claims the row, calls the provider, and
 * records the outcome. A message is `sending` while the provider call is in flight; a row left in that state by a
 * crash is reported, never sent again on a guess.
 *
 * Routes that send outside any transaction (a sign-in link, an invitation, an administrator's notice) may still call the
 * adapter directly: nothing can roll back underneath them.
 *
 * A message to a candidate from a company ITS has not confirmed yet (founder decision B7) is not sent: it is written as
 * `held`, with no send job, and waits. When ITS confirms the company, `releaseHeldCommunications` queues every held
 * message in the order it was written. The worker checks again before it sends, so a company whose confirmation was taken
 * back holds its queued messages too. Team mail is never held, and neither is the answer to a privacy request. Before a
 * release and before a send, a message that must no longer go (the candidate stopped texts, or left the process, while it
 * waited) is cancelled with its reason.
 */
export const SEND_JOB_KIND = "communication.send";
export const SEND_MAX_ATTEMPTS = 6;
/** A row that has been `sending` longer than this was interrupted between the provider call and the record. */
export const SENDING_STALE_MS = 15 * 60_000;

export type CommunicationRow = typeof communications.$inferSelect;

type QueueBase = {
  companyId: string;
  candidateId?: string | null;
  applicationId?: string | null;
  templateKey: string;
  /** Unique per intended message; a second call with the same key returns the first message's state and sends nothing. */
  idempotencyKey: string;
  actor: Actor;
  correlationId?: string | null;
  disclosureIncluded?: boolean;
  aiRunId?: string | null;
  retryOf?: string | null;
  retryAttempt?: number;
};
export type QueueEmailInput = QueueBase & {
  channel: "email";
  to: string;
  from: string;
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string | null;
  tags?: Record<string, string>;
  attachments?: Array<{ filename: string; contentType: string; contentBase64: string }> | null;
};
export type QueueSmsInput = QueueBase & { channel: "sms"; to: string; from: string; text: string };

export type QueueResult = SendResult & { communicationId: string };

/** The status of a message to a candidate waiting for the ITS company check. */
export const HELD_STATUS = "held";
/** What a caller hears about such a message. */
export const HELD_REASON = "held until ITS confirms the company";

/** What a caller learns about a message that already has a row. */
export function sendResultOf(row: Pick<CommunicationRow, "status" | "providerMessageId" | "error">): SendResult {
  if (row.status === "sent" || row.status === "delivered") return { status: "sent", providerMessageId: row.providerMessageId ?? "" };
  if (row.status === "failed" || row.status === "bounced" || row.status === "complained" || row.status === "unknown") return { status: "failed", error: row.error ?? "delivery failed", retryable: false };
  if (row.status === HELD_STATUS) return { status: "pending", reason: HELD_REASON };
  return { status: "pending", reason: "queued for delivery" };
}

/**
 * Whether a message waits for the ITS company check: anything to a candidate, except the answer to a privacy request,
 * which the law requires whoever runs the process to give.
 */
export function waitsForCompanyCheck(message: { candidateId?: string | null; templateKey?: string | null }): boolean {
  return !!message.candidateId && !(message.templateKey ?? "").startsWith("privacy_");
}

/**
 * Whether ITS has confirmed the company (its settings carry verifiedAt). "Not confirmed" is read a second time under a
 * share lock on the company row before it counts. ITS confirming the company holds that row until it commits
 * (company-trust.ts), so the second read waits and then sees the confirmation; and a confirmation that starts after
 * the lock waits for this transaction, so its release finds whatever this one held. Without the lock, a message held
 * while the confirmation committed would be missed by the release and wait for good. A confirmed company takes no lock.
 */
export async function companyConfirmed(q: Queryable, companyId: string): Promise<boolean> {
  const [co] = await q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!co) return false;
  if (isCompanyVerified(co.settings)) return true;
  const [locked] = await q.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)).limit(1).for("share");
  return !!locked && isCompanyVerified(locked.settings);
}

/** Invitations to a next step: pointless, and confusing, once the person has left the process. */
const NEXT_STEP_TEMPLATES = new Set(["screen_invite", "screen_reminder", "interview_slots", "interview_slots_reminder", "interview_confirmation"]);
/** Where an application has left the process: the candidate withdrew, or a decision was made. */
const LEFT_PROCESS = new Set(["withdrawn", "rejected", "declined", "talent_pool"]);

type WaitingRow = Pick<CommunicationRow, "id" | "companyId" | "channel" | "templateKey" | "candidateId" | "applicationId" | "sentBy" | "correlationId">;

/**
 * Messages to candidates that waited (held for the ITS check, or queued for a later hour) and must no longer go, with
 * the reason: the candidate stopped texts or withdrew their consent to them, their details were deleted at their
 * request, or an invitation to a next step whose person has since left the process (a closing message, such as the
 * decision or a cancellation, still goes). Read again just before a release and just before a send, because a message
 * can wait for days. The answer to a privacy request always goes.
 */
export async function reasonsNotToSend(q: Queryable, rows: readonly WaitingRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const relevant = rows.filter((r) => waitsForCompanyCheck(r));
  if (!relevant.length) return out;
  const candidateIds = [...new Set(relevant.map((r) => r.candidateId).filter((x): x is string => !!x))];
  const applicationIds = [...new Set(relevant.map((r) => r.applicationId).filter((x): x is string => !!x))];
  const people = new Map((candidateIds.length ? await q.select({ id: candidates.id, consent: candidates.consent, preferences: candidates.preferences, anonymizedAt: candidates.anonymizedAt }).from(candidates).where(inArray(candidates.id, candidateIds)) : []).map((c) => [c.id, c]));
  const stages = new Map((applicationIds.length ? await q.select({ id: applications.id, stage: applications.stage }).from(applications).where(inArray(applications.id, applicationIds)) : []).map((a) => [a.id, a.stage]));
  for (const r of relevant) {
    const who = r.candidateId ? people.get(r.candidateId) : undefined;
    const stage = r.applicationId ? stages.get(r.applicationId) : undefined;
    const reason = who?.anonymizedAt ? "the candidate's details were deleted at their request"
      : who && r.channel === "sms" && (!who.consent.sms?.granted || who.preferences.smsOptOut) ? "the candidate stopped text messages"
      : stage && LEFT_PROCESS.has(stage) && NEXT_STEP_TEMPLATES.has(r.templateKey ?? "") ? "the candidate has left the process since it was written"
      : null;
    if (reason) out.set(r.id, reason);
  }
  return out;
}

/** Withdraws a waiting message that must no longer go; a decision message among them leaves its candidate not told. */
async function cancelWaiting(q: Queryable, row: WaitingRow, reason: string, actor: Actor, now: Date): Promise<boolean> {
  const [done] = await q.update(communications).set({ status: "cancelled", error: reason }).where(and(eq(communications.id, row.id), inArray(communications.status, ["queued", HELD_STATUS]))).returning({ id: communications.id });
  if (!done) return false;
  await emit(q, { type: "message.cancelled", companyId: row.companyId, actor, subject: { type: "communication", id: row.id }, payload: { template: row.templateKey, channel: row.channel, applicationId: row.applicationId, reason }, correlationId: row.correlationId });
  await settleDecisionTold(q, row, "failed", now);
  return true;
}

/**
 * Records the message as queued inside the caller's transaction and hands it to the worker. Never calls a provider. A
 * message to a candidate of a company ITS has not confirmed yet is recorded as held instead, with no job (see above).
 */
export async function queueCommunication(q: Queryable, integrations: Integrations, input: QueueEmailInput | QueueSmsInput, now: Date = integrations.clock()): Promise<QueueResult> {
  const [existing] = await q.select().from(communications).where(eq(communications.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return { ...sendResultOf(existing), communicationId: existing.id };
  const held = waitsForCompanyCheck(input) && !(await companyConfirmed(q, input.companyId));
  const email = input.channel === "email" ? input : null;
  const [row] = await q
    .insert(communications)
    .values({
      companyId: input.companyId,
      candidateId: input.candidateId ?? null,
      applicationId: input.applicationId ?? null,
      direction: "outbound",
      channel: input.channel,
      fromAddress: input.from,
      toAddress: input.to,
      replyTo: email?.replyTo ?? null,
      subject: email?.subject ?? null,
      bodyText: input.text,
      bodyHtml: email?.html ?? null,
      templateKey: input.templateKey,
      provider: input.channel === "email" ? integrations.email.id : integrations.sms.id,
      status: held ? HELD_STATUS : "queued",
      disclosureIncluded: input.disclosureIncluded ?? false,
      sentBy: input.actor,
      aiRunId: input.aiRunId ?? null,
      idempotencyKey: input.idempotencyKey,
      tags: email?.tags ?? {},
      attachments: email?.attachments ?? null,
      correlationId: input.correlationId ?? null,
      retryOf: input.retryOf ?? null,
      retryAttempt: input.retryAttempt ?? 0,
    })
    .returning({ id: communications.id });
  if (held) {
    await emit(q, { type: "message.held", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { template: input.templateKey, channel: input.channel, applicationId: input.applicationId ?? null, reason: "company_check" }, correlationId: input.correlationId ?? null });
    return { status: "pending", reason: HELD_REASON, communicationId: row.id };
  }
  await q.insert(jobs).values({ kind: SEND_JOB_KIND, payload: { communicationId: row.id, companyId: input.companyId }, runAt: now.toISOString(), maxAttempts: SEND_MAX_ATTEMPTS });
  await emit(q, { type: "message.queued", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { template: input.templateKey, channel: input.channel, applicationId: input.applicationId ?? null }, correlationId: input.correlationId ?? null });
  return { status: "pending", reason: "queued for delivery", communicationId: row.id };
}

/**
 * ITS confirmed the company: every message to a candidate that waited for the check goes into the queue, oldest first,
 * through the same send job as any other. A text waits for the next hours the company may text candidates (the legal
 * window, narrowed by the company's contact hours); an email goes at once. One that must no longer go (the candidate
 * stopped texts, or left the process, while it waited: `reasonsNotToSend`) is cancelled instead, with its reason.
 * Returns how many were released.
 */
export async function releaseHeldCommunications(q: Queryable, input: { companyId: string; actor: Actor; now: Date }): Promise<number> {
  const waiting = await q.select({ id: communications.id, companyId: communications.companyId, channel: communications.channel, templateKey: communications.templateKey, candidateId: communications.candidateId, applicationId: communications.applicationId, sentBy: communications.sentBy, correlationId: communications.correlationId }).from(communications).where(and(eq(communications.companyId, input.companyId), eq(communications.status, HELD_STATUS)));
  if (!waiting.length) return 0;
  const stale = await reasonsNotToSend(q, waiting);
  for (const r of waiting) {
    const reason = stale.get(r.id);
    if (reason) await cancelWaiting(q, r, reason, input.actor, input.now);
  }
  const ids = waiting.filter((r) => !stale.has(r.id)).map((r) => r.id);
  if (!ids.length) return 0;
  const rows = await q.update(communications).set({ status: "queued", error: null }).where(and(inArray(communications.id, ids), eq(communications.status, HELD_STATUS))).returning({ id: communications.id, channel: communications.channel, templateKey: communications.templateKey, applicationId: communications.applicationId, correlationId: communications.correlationId, createdAt: communications.createdAt });
  if (!rows.length) return 0;
  const [company] = await q.select({ timezone: companies.timezone, settings: companies.settings }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  const textsFrom = company ? nextContactWindow(input.now, company.timezone, company.settings.businessHours) : input.now;
  for (const r of rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    await q.insert(jobs).values({ kind: SEND_JOB_KIND, payload: { communicationId: r.id, companyId: input.companyId }, runAt: (r.channel === "sms" ? textsFrom : input.now).toISOString(), maxAttempts: SEND_MAX_ATTEMPTS });
    await emit(q, { type: "message.released", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: r.id }, payload: { template: r.templateKey, channel: r.channel, applicationId: r.applicationId }, correlationId: r.correlationId });
  }
  return rows.length;
}

/**
 * The worker's check before a send: a queued message to a candidate of a company that is not confirmed (any more) is
 * held instead of sent. True when it was held.
 */
async function holdIfUnconfirmed(tx: Queryable, input: { communicationId: string; companyId: string }): Promise<boolean> {
  const [row] = await tx.select({ candidateId: communications.candidateId, templateKey: communications.templateKey, status: communications.status }).from(communications).where(and(eq(communications.id, input.communicationId), eq(communications.companyId, input.companyId))).limit(1);
  if (!row || row.status !== "queued" || !waitsForCompanyCheck(row) || (await companyConfirmed(tx, input.companyId))) return false;
  const [held] = await tx.update(communications).set({ status: HELD_STATUS }).where(and(eq(communications.id, input.communicationId), eq(communications.status, "queued"))).returning({ id: communications.id, channel: communications.channel, templateKey: communications.templateKey, applicationId: communications.applicationId, sentBy: communications.sentBy, correlationId: communications.correlationId });
  if (held) await emit(tx, { type: "message.held", companyId: input.companyId, actor: held.sentBy, subject: { type: "communication", id: held.id }, payload: { template: held.templateKey, channel: held.channel, applicationId: held.applicationId, reason: "company_check" }, correlationId: held.correlationId });
  return !!held;
}

/** The worker's other check before a send: a queued message that must no longer go (`reasonsNotToSend`) is cancelled. */
async function cancelIfUnwanted(tx: Queryable, input: { communicationId: string; companyId: string }, now: Date): Promise<boolean> {
  const [row] = await tx.select({ id: communications.id, companyId: communications.companyId, channel: communications.channel, templateKey: communications.templateKey, candidateId: communications.candidateId, applicationId: communications.applicationId, sentBy: communications.sentBy, correlationId: communications.correlationId }).from(communications).where(and(eq(communications.id, input.communicationId), eq(communications.companyId, input.companyId), eq(communications.status, "queued"))).limit(1);
  if (!row) return false;
  const reason = (await reasonsNotToSend(tx, [row])).get(row.id);
  return !!reason && (await cancelWaiting(tx, row, reason, row.sentBy, now));
}

export type SendOutcome = "sent" | "failed" | "skipped" | "retry" | "held" | "cancelled";

/**
 * The worker's half: claim the queued row, call the provider outside any transaction, record what happened. A
 * retryable provider failure puts the row back in the queue and throws so the job runs again with backoff; the last
 * attempt, or a failure that will not change (a suppressed address, no number), marks the message failed, tells the
 * team when a candidate could not be reached, and alerts an operator when the provider itself failed.
 */
export async function sendQueuedCommunication(db: Db, integrations: Integrations, input: { communicationId: string; companyId: string }, ctx: { attempt: number; maxAttempts: number; now: Date }): Promise<SendOutcome> {
  const claimed = await withTenant(db, input.companyId, async (tx) => {
    if (await holdIfUnconfirmed(tx, input)) return HELD_STATUS;
    if (await cancelIfUnwanted(tx, input, ctx.now)) return "cancelled" as const;
    const [row] = await tx
      .update(communications)
      .set({ status: "sending", sendingAt: ctx.now.toISOString(), sendAttempts: sql`${communications.sendAttempts} + 1` })
      .where(and(eq(communications.id, input.communicationId), eq(communications.companyId, input.companyId), eq(communications.status, "queued")))
      .returning();
    return row ?? null;
  });
  if (claimed === HELD_STATUS) return "held";
  if (claimed === "cancelled") return "cancelled";
  if (!claimed) return "skipped";
  if (!claimed.toAddress) {
    // Nothing to send it to (a row written without an address): failed for good, never left half-claimed in "sending".
    await withTenant(db, input.companyId, async (tx) => {
      await tx.update(communications).set({ status: "failed", error: "no address to send to", sendingAt: null }).where(eq(communications.id, claimed.id));
      await emit(tx, { type: "message.failed", companyId: claimed.companyId, actor: claimed.sentBy, subject: { type: "communication", id: claimed.id }, payload: { template: claimed.templateKey, channel: claimed.channel, applicationId: claimed.applicationId, error: "no address" }, correlationId: claimed.correlationId });
      await settleDecisionTold(tx, claimed, "failed", ctx.now);
    });
    return "failed";
  }

  let result: SendResult;
  try {
    result = claimed.channel === "sms"
      ? await integrations.sms.send({ to: claimed.toAddress, body: claimed.bodyText, idempotencyKey: claimed.idempotencyKey ?? claimed.id })
      : await integrations.email.send({
          to: claimed.toAddress,
          from: claimed.fromAddress ?? `${integrations.env.productName} <${integrations.env.fromAddress}>`,
          replyTo: claimed.replyTo ?? undefined,
          subject: claimed.subject ?? "",
          text: claimed.bodyText,
          html: claimed.bodyHtml ?? undefined,
          idempotencyKey: claimed.idempotencyKey ?? claimed.id,
          tags: { template: claimed.templateKey ?? "message", ...(claimed.tags ?? {}) },
          attachments: claimed.attachments ?? undefined,
        });
  } catch (err) {
    result = { status: "failed", error: err instanceof Error ? err.message : String(err), retryable: true };
  }

  const actor = claimed.sentBy;
  const final = ctx.attempt >= ctx.maxAttempts;
  const outcome = await withTenant(db, input.companyId, async (tx): Promise<SendOutcome> => {
    const payload = { template: claimed.templateKey, channel: claimed.channel, applicationId: claimed.applicationId, attempt: ctx.attempt };
    if (result.status === "sent") {
      await tx.update(communications).set({ status: "sent", providerMessageId: result.providerMessageId, error: null, sendingAt: null }).where(eq(communications.id, claimed.id));
      await emit(tx, { type: "message.sent", companyId: claimed.companyId, actor, subject: { type: "communication", id: claimed.id }, payload, correlationId: claimed.correlationId });
      await settleDecisionTold(tx, claimed, "sent", ctx.now);
      return "sent";
    }
    const retryable = result.status === "failed" ? result.retryable : false;
    const error = describeFailure(result);
    if (retryable && !final) {
      await tx.update(communications).set({ status: "queued", error, sendingAt: null }).where(eq(communications.id, claimed.id));
      await emit(tx, { type: "message.retried", companyId: claimed.companyId, actor, subject: { type: "communication", id: claimed.id }, payload: { ...payload, error, retryOf: claimed.id }, correlationId: claimed.correlationId });
      return "retry";
    }
    await tx.update(communications).set({ status: "failed", error, sendingAt: null }).where(eq(communications.id, claimed.id));
    await emit(tx, { type: "message.failed", companyId: claimed.companyId, actor, subject: { type: "communication", id: claimed.id }, payload: { ...payload, error }, correlationId: claimed.correlationId });
    await settleDecisionTold(tx, claimed, "failed", ctx.now);
    if (claimed.candidateId && claimed.applicationId) {
      await notify(tx, { companyId: claimed.companyId, kind: "candidate.unreachable", title: `A message to a candidate could not be sent`, body: `${claimed.subject ?? claimed.templateKey ?? "A message"}: ${error}. Please reach them another way.`, action: { label: "Open the candidate", href: "/talent" } });
    }
    return "failed";
  });
  if (outcome === "failed" && (result.status !== "failed" || result.retryable)) {
    // The provider itself failed for good (an outage that outlasted every retry, or an adapter that is not configured): an operator must see it.
    await raiseAlert(db, { kind: "message.delivery_failed", severity: "high", title: `A ${claimed.channel} could not be delivered after ${ctx.attempt} attempt${ctx.attempt === 1 ? "" : "s"}`, body: `${claimed.templateKey ?? "message"} to a recipient in this company failed: ${describeFailure(result)}. Check the provider's status and credentials; the message is marked failed and was not sent.`, companyId: claimed.companyId, target: { type: "communication", id: claimed.id }, details: { channel: claimed.channel, template: claimed.templateKey, attempts: ctx.attempt } }).catch((err) => console.warn(`[outbox] could not raise the delivery alert: ${err instanceof Error ? err.message : String(err)}`));
  }
  if (outcome === "retry") throw new Error(`delivery failed (attempt ${ctx.attempt} of ${ctx.maxAttempts}): ${describeFailure(result)}`);
  return outcome;
}

/**
 * The decision message's half of the told state (founder decision B6): a queued decision becomes "sent" when its message
 * leaves, and goes back to "not told" when it could not be delivered, or when nobody can say whether it was (`unknown`:
 * the send was interrupted), so the team sees the candidate may not have heard and can send it again or record telling
 * them; nothing is ever left waiting at "queued" with no way out. Only a decision still waiting on this message moves.
 */
export async function settleDecisionTold(tx: Queryable, row: Pick<CommunicationRow, "id" | "companyId" | "applicationId" | "templateKey" | "sentBy">, outcome: "sent" | "failed" | "unknown", now: Date): Promise<void> {
  if (!row.applicationId || !row.templateKey?.startsWith("disposition:")) return;
  const where = and(eq(applications.id, row.applicationId), eq(applications.toldState, "queued"));
  if (outcome !== "sent") {
    const [back] = await tx.update(applications).set({ toldState: "not_told" }).where(where).returning({ id: applications.id, roleId: applications.roleId });
    if (back && outcome === "unknown") await notify(tx, { companyId: row.companyId, kind: "candidate.unreachable", title: "A decision message may not have reached a candidate", body: "Sending it was interrupted, so we cannot tell whether it arrived. They show as not told yet: check with them, or record that you told them yourself, before sending it again.", action: { label: "Open the candidate", href: `/roles/${back.roleId}/talent?open=${back.id}` } });
    return;
  }
  const [told] = await tx.update(applications).set({ toldState: "sent", candidateToldAt: now.toISOString() }).where(where).returning({ id: applications.id });
  if (told) await emit(tx, { type: "application.told", companyId: row.companyId, actor: row.sentBy, subject: { type: "application", id: told.id }, payload: { how: "message", communicationId: row.id } });
}

/** The provider's reason a message did not go out, in one line. */
function describeFailure(result: SendResult): string {
  if (result.status === "sent") return "sent";
  return result.status === "failed" ? result.error : `provider not ready: ${result.reason}`;
}

/**
 * Rows stuck in `sending` were interrupted between the provider call and the record: the message may or may not have
 * left. They are marked `unknown` and put in front of an operator; they are never re-sent by the system, because a
 * duplicate to a candidate is the one outcome this design exists to prevent.
 */
export async function sweepStaleSending(db: Db, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SENDING_STALE_MS).toISOString();
  const rows = await withPlatform(db, async (tx) => {
    const stale = await tx.update(communications).set({ status: "unknown", error: "interrupted while sending; delivery could not be confirmed", sendingAt: null }).where(and(eq(communications.status, "sending"), lt(communications.sendingAt, cutoff))).returning({ id: communications.id, companyId: communications.companyId, channel: communications.channel, templateKey: communications.templateKey, applicationId: communications.applicationId, sentBy: communications.sentBy });
    // A decision message among them: the decision goes back to not told, and the team is asked to check (founder decision B6).
    for (const r of stale) await settleDecisionTold(tx, r, "unknown", now);
    return stale;
  });
  for (const r of rows) {
    await raiseAlert(db, { kind: "message.delivery_unknown", severity: "high", title: `A ${r.channel} may or may not have been delivered`, body: `The process was interrupted while sending ${r.templateKey ?? "a message"}. Check the provider's activity log before sending it again by hand; it was not re-sent automatically.`, companyId: r.companyId, target: { type: "communication", id: r.id }, details: { channel: r.channel, template: r.templateKey } });
  }
  return rows.length;
}

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { SCREEN_ACTIVE_STATUSES, appPaths, type Actor } from "@ros/contracts";
import { DECISION_STAGES, emit, errorForLog, isCompanyLive, lockedAmong, notify, raiseAlert, raiseAlertOnce } from "@ros/core";
import { applications, candidates, communications, companies, events, jobs, screens, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import { mailbox, type Integrations, type SendResult } from "@ros/integrations";

/**
 * The outbox for every email the product sends from inside a database transaction.
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
 * Just before a send, a message to a candidate that must no longer go (the company is not live, the candidate left the
 * process, or the step its link opens ended, while it waited) is cancelled with its reason. Team mail and the answer to a
 * privacy request always go.
 */
export const SEND_JOB_KIND = "communication.send";
/**
 * Tries before a message is marked failed. The queue waits 2 s, 4 s, 8 s ... up to 15 minutes between tries
 * (`jobRetryDelayMs` in packages/workflows/src/engine.ts), so the 13th try comes about an hour (62 minutes) after the
 * first: a short email provider outage delays messages, it never fails them for good (Wave S5 C2, audit row 35).
 */
export const SEND_MAX_ATTEMPTS = 13;
/**
 * A row that has been `sending` longer than this was interrupted between the provider call and the record. Every
 * provider call has its own timeout well under this (Postmark: 30 s). The hourly check finds such rows
 * (`sweepStaleSending`, apps/api/src/maintenance.ts `runHourlyChecks`): five minutes plus at most an hour between
 * checks, so the team hears within about 65 minutes of the interruption.
 */
export const SENDING_STALE_MS = 5 * 60_000;

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
  /**
   * When the send job may run (plan G9): a message a person sent waits a few seconds so they can press Undo; while it is
   * still queued, `undoQueuedMessage` withdraws it. Now when left out.
   */
  sendAt?: Date | null;
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

export type QueueResult = SendResult & { communicationId: string };

/**
 * A tag on a message whose delivery failure raises no operator alert (`QUIET_ON_FAILURE` in packages/workflows/src/notification-email.ts). It is still
 * marked failed or unknown, recorded and reported as any other message is; only the alert stays away.
 */
export const QUIET_ON_FAILURE_TAG = "quietOnFailure";

/** Whether this message's tags ask for no alert. */
function quietOnFailure(row: { tags?: Record<string, string> | null }): boolean {
  return row.tags?.[QUIET_ON_FAILURE_TAG] === "true";
}

/** Statuses of a message that has not left yet: queued, or being sent. */
const NOT_LEFT: readonly string[] = ["queued", "sending"];

/**
 * B7: of these screens, the ones whose link email has not left yet. The email that carries a screen's link is its own
 * invitation (`screen_invite:<screen>`), else the application's one email (`ack:<application>`, R20-5). The interview's
 * run starts the link's clock only when it leaves, and "Send a reminder" waits for it too: a reminder would only queue
 * behind it (20 Oct 2026, R20-7).
 */
export async function linkEmailsWaiting(q: Queryable, scrs: ReadonlyArray<{ id: string; applicationId: string }>): Promise<Set<string>> {
  if (!scrs.length) return new Set();
  const keys = [...new Set(scrs.flatMap((s) => [`screen_invite:${s.id}`, `ack:${s.applicationId}`]))];
  const rows = await q.select({ key: communications.idempotencyKey, status: communications.status }).from(communications).where(inArray(communications.idempotencyKey, keys));
  const status = new Map(rows.map((r) => [r.key, r.status]));
  return new Set(scrs.filter((s) => NOT_LEFT.includes(status.get(`screen_invite:${s.id}`) ?? status.get(`ack:${s.applicationId}`) ?? "")).map((s) => s.id));
}

/** Whether one screen's link email has not left yet (`linkEmailsWaiting`). */
export async function linkEmailWaiting(q: Queryable, scr: { id: string; applicationId: string }): Promise<boolean> {
  return (await linkEmailsWaiting(q, [scr])).has(scr.id);
}

/** What a caller learns about a message that already has a row. */
export function sendResultOf(row: Pick<CommunicationRow, "status" | "providerMessageId" | "error">): SendResult {
  if (row.status === "sent" || row.status === "delivered") return { status: "sent", providerMessageId: row.providerMessageId ?? "" };
  if (row.status === "failed" || row.status === "bounced" || row.status === "complained" || row.status === "unknown") return { status: "failed", error: row.error ?? "delivery failed", retryable: false };
  // Withdrawn before it left (Undo, or the reason for it went away): it will never go.
  if (row.status === "cancelled") return { status: "failed", error: row.error ?? "withdrawn before it was sent", retryable: false };
  return { status: "pending", reason: "queued for delivery" };
}

/**
 * Whether a message is one to a candidate that may be stopped before it leaves: anything to a candidate, except the
 * answer to a privacy request, which the law requires whoever runs the process to give.
 */
function mayBeStopped(message: { candidateId?: string | null; templateKey?: string | null }): boolean {
  return !!message.candidateId && !(message.templateKey ?? "").startsWith("privacy_");
}

/**
 * Invitations to a next step: pointless, and confusing, once the person has left the process. The links and reminders
 * of the conversation that goes with the application (plan Wave E) are among them, and so is the close-out note to
 * someone locked (Rule 2).
 */
const NEXT_STEP_TEMPLATES = new Set(["screen_invite", "screen_reminder", "screen_later", "screen_idle_reminder", "screen_review_reminder", "screen_not_started_reminder", "screen_resume", "screen_repeat_later", "screen_repeat_resume", "screen_expired", "close_out"]);
/** Where an application has left the process: the candidate withdrew, or a decision was made. */
const LEFT_PROCESS = new Set(["withdrawn", "rejected"]);
/** Messages whose link opens a screening conversation: dead once that conversation has ended (expired, closed, done). */
const SCREEN_LINK_TEMPLATES = new Set(["screen_invite", "screen_reminder", "screen_later", "screen_not_started_reminder", "screen_idle_reminder", "screen_review_reminder", "screen_resume"]);
type WaitingRow = Pick<CommunicationRow, "id" | "companyId" | "channel" | "templateKey" | "candidateId" | "applicationId" | "sentBy" | "correlationId" | "idempotencyKey">;

/**
 * Messages to candidates that waited in the queue and must no longer go, with the reason: the company is not live (it
 * was declined, or its access was taken away, so nothing of it is emailed to candidates), their details were deleted at
 * their request, an invitation to a next step whose person has since left the process (the decision message still
 * goes), a link to a step that has ended since (a screening conversation no longer open: the closing note of the step
 * still goes), a decision message whose decision no longer applies, or a close-out note to someone a change of plan has
 * opened since: it says nobody has reviewed them, and the team can now. Read just before a send, because a message can
 * wait in the queue. The answer to a privacy request always goes.
 */
export async function reasonsNotToSend(q: Queryable, rows: readonly WaitingRow[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const relevant = rows.filter((r) => mayBeStopped(r));
  if (!relevant.length) return out;
  const live = new Set((await q.select({ id: companies.id, settings: companies.settings }).from(companies).where(inArray(companies.id, [...new Set(relevant.map((r) => r.companyId))]))).filter((c) => isCompanyLive(c.settings)).map((c) => c.id));
  const candidateIds = [...new Set(relevant.map((r) => r.candidateId).filter((x): x is string => !!x))];
  const applicationIds = [...new Set(relevant.map((r) => r.applicationId).filter((x): x is string => !!x))];
  const people = new Map((candidateIds.length ? await q.select({ id: candidates.id, anonymizedAt: candidates.anonymizedAt }).from(candidates).where(inArray(candidates.id, candidateIds)) : []).map((c) => [c.id, c]));
  const stages = new Map((applicationIds.length ? await q.select({ id: applications.id, stage: applications.stage }).from(applications).where(inArray(applications.id, applicationIds)) : []).map((a) => [a.id, a.stage]));
  const appsWith = (templates: Set<string>) => [...new Set(relevant.filter((r) => r.applicationId && templates.has(r.templateKey ?? "")).map((r) => r.applicationId!))];
  const screenApps = appsWith(SCREEN_LINK_TEMPLATES);
  const openScreen = new Set((screenApps.length ? await q.select({ a: screens.applicationId }).from(screens).where(and(inArray(screens.applicationId, screenApps), inArray(screens.status, [...SCREEN_ACTIVE_STATUSES]))) : []).map((s) => s.a));
  const closeOuts = appsWith(new Set(["close_out"]));
  const stillLocked = await lockedAmong(q, closeOuts);
  for (const r of relevant) {
    const who = r.candidateId ? people.get(r.candidateId) : undefined;
    const stage = r.applicationId ? stages.get(r.applicationId) : undefined;
    const template = r.templateKey ?? "";
    const reason = !live.has(r.companyId) ? "the company is not live"
      : who?.anonymizedAt ? "the candidate's details were deleted at their request"
      : stage && LEFT_PROCESS.has(stage) && NEXT_STEP_TEMPLATES.has(template) ? "the candidate has left the process since it was written"
      : r.applicationId && SCREEN_LINK_TEMPLATES.has(template) && !openScreen.has(r.applicationId) ? "the step it invites to has ended since it was written"
      : stage && template.startsWith("disposition:") && !DECISION_STAGES.includes(stage) ? "the decision no longer applies"
      : r.applicationId && template === "close_out" && !stillLocked.has(r.applicationId) ? "the team can read this application now"
      : null;
    if (reason) out.set(r.id, reason);
  }
  return out;
}

/** Withdraws a waiting message that must no longer go; a decision message among them leaves its candidate not told. */
async function cancelWaiting(q: Queryable, row: WaitingRow, reason: string, actor: Actor, now: Date): Promise<boolean> {
  const [done] = await q.update(communications).set({ status: "cancelled", error: reason }).where(and(eq(communications.id, row.id), eq(communications.status, "queued"))).returning({ id: communications.id });
  if (!done) return false;
  await emit(q, { type: "message.cancelled", companyId: row.companyId, actor, subject: { type: "communication", id: row.id }, payload: { template: row.templateKey, channel: row.channel, applicationId: row.applicationId, reason }, correlationId: row.correlationId });
  await settleDecisionTold(q, row, "failed", now);
  return true;
}

/** Records the message as queued inside the caller's transaction and hands it to the worker. Never calls a provider. */
export async function queueCommunication(q: Queryable, integrations: Integrations, input: QueueEmailInput, now: Date = integrations.clock()): Promise<QueueResult> {
  const [existing] = await q.select().from(communications).where(eq(communications.idempotencyKey, input.idempotencyKey)).limit(1);
  if (existing) return { ...sendResultOf(existing), communicationId: existing.id };
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
      replyTo: input.replyTo ?? null,
      subject: input.subject,
      bodyText: input.text,
      bodyHtml: input.html ?? null,
      templateKey: input.templateKey,
      provider: integrations.email.id,
      status: "queued",
      disclosureIncluded: input.disclosureIncluded ?? false,
      sentBy: input.actor,
      aiRunId: input.aiRunId ?? null,
      idempotencyKey: input.idempotencyKey,
      tags: input.tags ?? {},
      attachments: input.attachments ?? null,
      correlationId: input.correlationId ?? null,
      retryOf: input.retryOf ?? null,
      retryAttempt: input.retryAttempt ?? 0,
    })
    .returning({ id: communications.id });
  const runAt = input.sendAt && input.sendAt.getTime() > now.getTime() ? input.sendAt : now;
  await q.insert(jobs).values({ kind: SEND_JOB_KIND, payload: { communicationId: row.id, companyId: input.companyId }, runAt: runAt.toISOString(), maxAttempts: SEND_MAX_ATTEMPTS });
  await emit(q, { type: "message.queued", companyId: input.companyId, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { template: input.templateKey, channel: input.channel, applicationId: input.applicationId ?? null, ...(runAt !== now ? { sendAt: runAt.toISOString() } : {}) }, correlationId: input.correlationId ?? null });
  return { status: "pending", reason: "queued for delivery", communicationId: row.id };
}

/** Why an Undo was refused, in the sender's words. */
export class UndoError extends Error {
  constructor(public readonly code: "not_found" | "already_sent" | "not_yours", message: string) {
    super(message);
  }
}

/** The messages a person's Send holds for the Undo window: a decision message. */
export function heldForUndo(templateKey: string | null | undefined): boolean {
  return !!templateKey?.startsWith("disposition:");
}

/**
 * Undo (plan G9): a message someone on the team sent is withdrawn
 * during its Undo window, while it still waits in the outbox. Only the messages a person's Send holds for that window
 * (`heldForUndo`), and only until the moment its Send set (`sendAt` on its `message.queued` fact): an invitation or a
 * note a workflow sent for them has no window, so a waiting workflow never waits for a message that was taken back. A
 * decision message withdrawn this way
 * leaves the candidate not told, as before the Send. Recorded as `message.cancelled` with the reason "undone".
 */
export async function undoQueuedMessage(q: Queryable, input: { communicationId: string; applicationId: string; actor: Actor; now: Date }): Promise<{ templateKey: string | null }> {
  const [row] = await q.select().from(communications).where(and(eq(communications.id, input.communicationId), eq(communications.applicationId, input.applicationId), eq(communications.direction, "outbound"))).limit(1);
  if (!row) throw new UndoError("not_found", "That message was not found.");
  if (row.sentBy.kind !== "user" || !heldForUndo(row.templateKey)) throw new UndoError("not_yours", "Only a message someone on the team sent can be undone; this one was sent by the product.");
  if (row.status === "cancelled") throw new UndoError("already_sent", "That message was already withdrawn.");
  const [queued] = await q.select({ payload: events.payload }).from(events).where(and(eq(events.type, "message.queued"), eq(events.subjectId, row.id))).limit(1);
  const sendAt = typeof queued?.payload.sendAt === "string" ? Date.parse(queued.payload.sendAt) : Number.NaN;
  if (row.status !== "queued" || !(sendAt > input.now.getTime())) throw new UndoError("already_sent", "Too late to undo: the message has already gone.");
  const [done] = await q.update(communications).set({ status: "cancelled", error: "undone by the team before it was sent" }).where(and(eq(communications.id, row.id), eq(communications.status, "queued"))).returning({ id: communications.id });
  if (!done) throw new UndoError("already_sent", "Too late to undo: the message has already gone.");
  await emit(q, { type: "message.cancelled", companyId: row.companyId, actor: input.actor, subject: { type: "communication", id: row.id }, payload: { template: row.templateKey, channel: row.channel, applicationId: row.applicationId, reason: "undone", by: "undo" }, correlationId: row.correlationId });
  await settleDecisionTold(q, row, "failed", input.now);
  return { templateKey: row.templateKey };
}

/** A message in one of these never left us, so nothing it says has reached them. */
const NEVER_LEFT = ["queued", "failed", "cancelled"];
/**
 * A message in one of these did not reach them: it never left us, or it came back (`bounced`, from the provider's webhook,
 * email-failures.ts). A soft bounce is tried again as a new message (`retryOf`); one of those that arrives reached them.
 * `unknown` (a send cut off) and `sending` may have reached them, so they count as reached.
 */
export const DID_NOT_REACH: readonly string[] = [...NEVER_LEFT, "bounced"];
/** How many retries of retries are followed; a soft bounce is tried twice (`RETRY_DELAYS_MS`), so a few is plenty. */
const RETRY_DEPTH = 5;

/**
 * Of these messages, the ones a retry of which arrived (left us and did not come back), retries of retries too: a soft bounce
 * that reached them after all, read where the first message's own status still says `bounced`.
 */
export async function reachedOnRetry(q: Queryable, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  let level = [...new Set(ids)].map((id) => ({ root: id, id }));
  for (let depth = 0; level.length && depth < RETRY_DEPTH; depth += 1) {
    const rows = await q.select({ id: communications.id, retryOf: communications.retryOf, status: communications.status }).from(communications).where(inArray(communications.retryOf, level.map((l) => l.id)));
    const rootOf = new Map(level.map((l) => [l.id, l.root]));
    const next: typeof level = [];
    for (const r of rows) {
      const root = r.retryOf ? rootOf.get(r.retryOf) : undefined;
      if (!root) continue;
      if (!DID_NOT_REACH.includes(r.status)) out.add(root);
      else next.push({ root, id: r.id });
    }
    level = next;
  }
  return out;
}

/** The worker's check before a send: a queued message that must no longer go (`reasonsNotToSend`) is cancelled. */
async function cancelIfUnwanted(tx: Queryable, input: { communicationId: string; companyId: string }, now: Date): Promise<boolean> {
  const [row] = await tx.select({ id: communications.id, companyId: communications.companyId, channel: communications.channel, templateKey: communications.templateKey, candidateId: communications.candidateId, applicationId: communications.applicationId, sentBy: communications.sentBy, correlationId: communications.correlationId, idempotencyKey: communications.idempotencyKey }).from(communications).where(and(eq(communications.id, input.communicationId), eq(communications.companyId, input.companyId), eq(communications.status, "queued"))).limit(1);
  if (!row) return false;
  const reason = (await reasonsNotToSend(tx, [row])).get(row.id);
  return !!reason && (await cancelWaiting(tx, row, reason, row.sentBy, now));
}

/** `unknown`: the provider may have taken it but its reply was cut off; marked unknown, alerted, never re-sent. */
export type SendOutcome = "sent" | "failed" | "skipped" | "retry" | "cancelled" | "unknown";

/** The alert ITS gets when the email provider refuses an email for good for a reason that is not one address. */
export const PROVIDER_REFUSED_ALERT = "message.provider_refused";

/**
 * The team's notice that an email to a candidate did not arrive (6 November 2026): who it was for, which email, in plain
 * words (never the provider's own error), and the way to their page, where their address and phone are. Through `notify`'s
 * `about`, so nothing is written for someone the team may not read.
 */
async function tellTeamItDidNotArrive(tx: Queryable, claimed: CommunicationRow): Promise<void> {
  if (!claimed.applicationId) return;
  const [who] = await tx.select({ roleId: applications.roleId, firstName: candidates.firstName, lastName: candidates.lastName }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(applications.id, claimed.applicationId)).limit(1);
  const name = who ? `${who.firstName} ${who.lastName}`.trim() || "a candidate" : "a candidate";
  const which = claimed.subject ? `"${claimed.subject}"` : "An email";
  await notify(tx, { companyId: claimed.companyId, about: claimed.applicationId, kind: "candidate.unreachable", title: `An email to ${name} did not arrive`, body: `${which} could not be delivered. Phone them, or write to them another way.`, action: who ? { label: `Open ${name}`, href: appPaths.candidate(who.roleId, claimed.applicationId) } : { label: "Open the candidates", href: appPaths.allCandidates } });
}

/**
 * The worker's half: claim the queued row, call the provider outside any transaction, record what happened. A
 * retryable provider failure puts the row back in the queue and throws so the job runs again with backoff; the last
 * attempt, or a failure that will not change (a suppressed address), marks the message failed, tells the
 * team when a candidate could not be reached, and alerts an operator when the provider itself failed.
 */
export async function sendQueuedCommunication(db: Db, integrations: Integrations, input: { communicationId: string; companyId: string }, ctx: { attempt: number; maxAttempts: number; now: Date }): Promise<SendOutcome> {
  const claimed = await withTenant(db, input.companyId, async (tx) => {
    if (await cancelIfUnwanted(tx, input, ctx.now)) return "cancelled" as const;
    const [row] = await tx
      .update(communications)
      .set({ status: "sending", sendingAt: ctx.now.toISOString(), sendAttempts: sql`${communications.sendAttempts} + 1` })
      .where(and(eq(communications.id, input.communicationId), eq(communications.companyId, input.companyId), eq(communications.status, "queued")))
      .returning();
    return row ?? null;
  });
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
    result = await integrations.email.send({
      to: claimed.toAddress,
      from: claimed.fromAddress ?? mailbox(integrations.env.productName, integrations.env.fromAddress),
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
    const error = describeFailure(result);
    // The provider may have taken it (its reply was cut off): like an interrupted send (`sweepStaleSending`), it is marked
    // unknown and put in front of a person, never re-sent on a guess and never told to the team as "could not be sent".
    if (result.status === "failed" && result.uncertain) {
      await tx.update(communications).set({ status: "unknown", error, sendingAt: null }).where(eq(communications.id, claimed.id));
      await settleDecisionTold(tx, claimed, "unknown", ctx.now);
      return "unknown";
    }
    const retryable = result.status === "failed" ? result.retryable : false;
    if (retryable && !final) {
      await tx.update(communications).set({ status: "queued", error, sendingAt: null }).where(eq(communications.id, claimed.id));
      await emit(tx, { type: "message.retried", companyId: claimed.companyId, actor, subject: { type: "communication", id: claimed.id }, payload: { ...payload, error, retryOf: claimed.id }, correlationId: claimed.correlationId });
      return "retry";
    }
    await tx.update(communications).set({ status: "failed", error, sendingAt: null }).where(eq(communications.id, claimed.id));
    await emit(tx, { type: "message.failed", companyId: claimed.companyId, actor, subject: { type: "communication", id: claimed.id }, payload: { ...payload, error }, correlationId: claimed.correlationId });
    await settleDecisionTold(tx, claimed, "failed", ctx.now);
    // Not about someone locked (Rule 2): it would lead the team to a person they cannot read. ITS's own alert below still goes.
    if (claimed.candidateId && claimed.applicationId) await tellTeamItDidNotArrive(tx, claimed);
    return "failed";
  });
  if (outcome === "failed" && (result.status !== "failed" || result.retryable) && !quietOnFailure(claimed)) {
    // The provider itself failed for good (an outage that outlasted every retry, or an adapter that is not configured): an operator must see it.
    await raiseAlert(db, { kind: "message.delivery_failed", severity: "high", title: `An email could not be delivered after ${ctx.attempt} attempt${ctx.attempt === 1 ? "" : "s"}`, body: `${claimed.templateKey ?? "message"} to a recipient in this company failed: ${describeFailure(result)}. Check the provider's status and credentials; the message is marked failed and was not sent.`, companyId: claimed.companyId, target: { type: "communication", id: claimed.id }, details: { channel: claimed.channel, template: claimed.templateKey, attempts: ctx.attempt } }).catch((err) => console.warn(`[outbox] could not raise the delivery alert: ${errorForLog(err)}`));
  } else if (outcome === "failed" && result.status === "failed" && !result.aboutAddress && !quietOnFailure(claimed)) {
    // The provider refused it for good, and not because of this one address (a sender signature, the account, the token):
    // every other email is refused the same way, so ITS hears at once (6 November 2026). One alert while it lasts, not one per email.
    await raiseAlertOnce(db, { kind: PROVIDER_REFUSED_ALERT, severity: "high", title: "The email provider is refusing emails", body: `${claimed.templateKey ?? "An email"} to a recipient in this company was refused: ${describeFailure(result)}. The refusal is not about one address, so other emails are likely refused too. Check the provider's account, sender signature and domain.`, companyId: claimed.companyId, details: { provider: integrations.email.id, template: claimed.templateKey, communicationId: claimed.id } }, { withinMs: 3600_000, now: ctx.now }).catch((err) => console.warn(`[outbox] could not raise the refusal alert: ${errorForLog(err)}`));
  }
  if (outcome === "unknown" && !quietOnFailure(claimed)) {
    await raiseAlert(db, { kind: "message.delivery_unknown", severity: "high", title: "An email may or may not have been delivered", body: `The provider's reply to sending ${claimed.templateKey ?? "a message"} was cut off (${describeFailure(result).slice(0, 200)}). Check the provider's activity log before sending it again by hand; it was not re-sent automatically.`, companyId: claimed.companyId, target: { type: "communication", id: claimed.id }, details: { channel: claimed.channel, template: claimed.templateKey } }).catch((err) => console.warn(`[outbox] could not raise the delivery alert: ${errorForLog(err)}`));
  }
  if (outcome === "retry") throw new Error(`delivery failed (attempt ${ctx.attempt} of ${ctx.maxAttempts}): ${describeFailure(result)}`);
  return outcome;
}

/**
 * The decision message's half of the told state (founder decision B6): a queued decision becomes "sent" when its message
 * leaves, and goes back to "not told" when it could not be delivered, or when nobody can say whether it was (`unknown`:
 * the send was interrupted), so the team sees the candidate may not have heard and can send it again; nothing is ever
 * left waiting at "queued" with no way out. Only a decision still waiting on this message moves,
 * except for a retry (`retryOf`) of a decision message that soft-bounced: the first try counted as sent when the provider
 * took it, so a retry that could not go (the address was stopped meanwhile, say) means the decision never arrived, and
 * a decision still standing goes back from "sent" to "not told" too.
 */
export async function settleDecisionTold(tx: Queryable, row: Pick<CommunicationRow, "id" | "companyId" | "applicationId" | "templateKey" | "sentBy"> & Partial<Pick<CommunicationRow, "retryOf">>, outcome: "sent" | "failed" | "unknown", now: Date): Promise<void> {
  if (!row.applicationId || !row.templateKey?.startsWith("disposition:")) return;
  const where = and(eq(applications.id, row.applicationId), eq(applications.toldState, "queued"));
  if (outcome !== "sent") {
    const notArrived = row.retryOf ? and(eq(applications.id, row.applicationId), inArray(applications.toldState, ["queued", "sent"]), inArray(applications.stage, [...DECISION_STAGES])) : where;
    const [back] = await tx.update(applications).set({ toldState: "not_told", ...(row.retryOf ? { candidateToldAt: null } : {}) }).where(notArrived).returning({ id: applications.id, roleId: applications.roleId });
    if (back && outcome === "unknown") await notify(tx, { companyId: row.companyId, about: back.id, kind: "candidate.unreachable", title: "A decision message may not have reached a candidate", body: "Sending it was interrupted, so we cannot tell whether it arrived. They show as not told yet: check with them before sending it again.", action: { label: "Open the candidate", href: appPaths.candidate(back.roleId, back.id) } });
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
    const stale = await tx.update(communications).set({ status: "unknown", error: "interrupted while sending; delivery could not be confirmed", sendingAt: null }).where(and(eq(communications.status, "sending"), lt(communications.sendingAt, cutoff))).returning({ id: communications.id, companyId: communications.companyId, channel: communications.channel, templateKey: communications.templateKey, applicationId: communications.applicationId, sentBy: communications.sentBy, retryOf: communications.retryOf, tags: communications.tags });
    // A decision message among them: the decision goes back to not told, and the team is asked to check (founder decision B6).
    for (const r of stale) await settleDecisionTold(tx, r, "unknown", now);
    return stale;
  });
  for (const r of rows) {
    if (quietOnFailure(r)) continue;
    await raiseAlert(db, { kind: "message.delivery_unknown", severity: "high", title: "An email may or may not have been delivered", body: `The process was interrupted while sending ${r.templateKey ?? "a message"}. Check the provider's activity log before sending it again by hand; it was not re-sent automatically.`, companyId: r.companyId, target: { type: "communication", id: r.id }, details: { channel: r.channel, template: r.templateKey } });
  }
  return rows.length;
}

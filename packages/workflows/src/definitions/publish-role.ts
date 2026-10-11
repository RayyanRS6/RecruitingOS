import { and, desc, eq, gt } from "drizzle-orm";
import { isCompanyVerified } from "@ros/contracts";
import { queueCommunication } from "@ros/agents";
import { BOARD_NAME, POSTING_VERIFY_JOB_KIND, POSTING_VERIFY_MAX_ATTEMPTS, applyLinkUrl, boardPostingOf, canTransitionPosting, createApplicationLink, emit, findPostingLink, isBoardChannel, jobUrlsFor, openPostingTask, publishChannelsFor, sourceForChannel, transitionPosting, type PostingState } from "@ros/core";
import { companies, events, postings, randomToken, rolePackets, roles, uuidv7, type Tx } from "@ros/db";
import { intakeAddress, type PublishResult } from "@ros/integrations";
import type { StepContext, WorkflowDefinition } from "../types";

/**
 * `prepare`: boards a person ticked again or asked to prepare ("prepare this board", plan D6). A board a person closed
 * while the role stayed open comes back only this way, never by a pause and resume or a retry of another channel.
 */
type State = { roleId: string; packetVersion: number; failedChannels?: string[]; attemptsByChannel?: Record<string, number>; prepare?: string[] };

const CHANNEL_ORDER = ["careers_page", "google_jobs", "email_in", "linkedin_basic", "indeed", "ziprecruiter"];

/** Runs started before version 3 prepared every board; they keep doing so (plan D6: runs in flight keep all boards). */
const CHOSEN_BOARDS_SINCE_VERSION = 3;

/** Rows the workflow never rewrites: the posting is up on the outside (or paused after being up), or a provider or a person holds it. */
const HANDS_OFF: readonly PostingState[] = ["posted_manually", "submitted_integration", "live_verified", "paused"];

type PostingRow = typeof postings.$inferSelect;
type PostingValues = Partial<typeof postings.$inferInsert>;

/**
 * Prepares an open role on every channel (docs/06 `publish_role`; docs/spec/20). The careers page is prepared,
 * its URL recorded and its verification queued; Google for Jobs is submitted through the page's structured data;
 * email-in is verified only when the inbound domain is configured; each board gets its own tracked apply link and
 * the numbered steps for posting by hand, and waits at "ready to post" until a person records the public URL.
 * Nothing is called live here. A channel failure never fails the run: the row records the error and a retryable
 * channel is tried up to three times over 24 hours. Re-runs (a resumed or re-opened role) re-prepare only the rows
 * nobody holds: a board that is posted, paused or waiting on a person is left alone. A channel a person closed while
 * the role stayed open is final (a pause and resume, or a Retry on another channel, never brings it back); only a
 * role that was closed and opened again prepares its closed rows again, and never a board still up on the outside.
 *
 * Nothing is prepared for a company ITS has not confirmed yet (founder decision B7): the run waits, with no deadline, for
 * the company.verified signal the admin console sends when ITS confirms the company, then publishes whatever is still
 * open. The role itself stays open and approved meanwhile; only its public side waits.
 *
 * Version 3 (plan D6, founder decision Q11): only the role's chosen channels are prepared. The careers page, Google and
 * email always; the boards a person ticked (`roles.publish_channels`), or else the ones the role plan names, with
 * ZipRecruiter only for a company with its own plan. When ITS posts for the company (the default, plan D3), each board
 * prepared here gets an ITS "post the job" task, and the ITS queue is told once per run.
 */
export const COMPANY_CHECK_WAIT_REASON = "waiting for ITS to confirm the company before anything is public";

/** The signal key the admin console wakes waiting publish runs with (the engine's event keys are `<subject id>:<type>`). */
export function companyVerifiedSignal(companyId: string): string {
  return `${companyId}:company.verified`;
}

export const publishRole: WorkflowDefinition<State> = {
  key: "publish_role",
  version: 3,
  initialStep: "publish",
  maxAttempts: 3,
  escalationKind: "stuck_role",
  steps: {
    async publish(ctx) {
      const [role] = await ctx.q.select().from(roles).where(eq(roles.id, ctx.state.roleId)).limit(1);
      const [company] = await ctx.q.select().from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
      const [pv] = await ctx.q.select().from(rolePackets).where(and(eq(rolePackets.roleId, ctx.state.roleId), eq(rolePackets.version, ctx.state.packetVersion))).limit(1);
      if (!role || !company || !pv) return { kind: "fail", error: "role, company, or packet not found", retryable: false };
      if (role.status !== "open") return { kind: "complete" };
      if (!isCompanyVerified(company.settings)) return { kind: "wait", wait: { kind: "event", eventTypes: ["company.verified"], subjectId: company.id, reason: COMPANY_CHECK_WAIT_REASON }, resumeStep: "publish" };

      const { integrations, env } = ctx.services;
      const urls = jobUrlsFor(env.jobsBaseUrl, { slug: company.slug, roleId: role.id });

      // The email-in address is allocated once per role and reused by every channel's instructions.
      const [emailIn] = await ctx.q.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, "email_in"))).limit(1);
      const intakeToken = emailIn?.intakeToken ?? (randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || randomToken(6).toLowerCase());
      const intakeAddr = intakeAddress(intakeToken, integrations.env.intakeDomain);

      const failed: string[] = [];
      const attemptsByChannel = { ...(ctx.state.attemptsByChannel ?? {}) };
      const chosen = ctx.run.workflowVersion >= CHOSEN_BOARDS_SINCE_VERSION ? publishChannelsFor(role, pv.packet, company.settings) : CHANNEL_ORDER;
      const asked = new Set(ctx.state.prepare ?? []);
      const itsPosts = boardPostingOf(company.settings) === "its";
      const newTasks: string[] = [];
      for (const channel of CHANNEL_ORDER) {
        if (!(chosen as readonly string[]).includes(channel)) continue;
        const adapter = integrations.jobBoards[channel];
        if (!adapter) continue;
        const [existing] = await ctx.q.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, channel))).limit(1);
        if (existing && HANDS_OFF.includes(existing.status as PostingState)) continue;
        // A closed board comes back when the role was closed and opened again, or when a person asked for it; never while its removal is unconfirmed.
        const askedBack = asked.has(channel) && !!existing && !(existing.closureRequired && !existing.closureConfirmedAt);
        if (existing?.status === "closed" && !askedBack && !(await reopenedSinceClosed(ctx.q, role.id, existing))) continue;
        // a board whose verification failed keeps its recorded URL for the person to retry or replace; the workflow does not reset it
        if (existing?.status === "failed" && existing.externalUrl && isBoardChannel(channel)) continue;
        if (existing?.status === "ready_to_post" && attemptsByChannel[channel]) continue; // prepared earlier in this run
        if (existing?.status === "failed" && (attemptsByChannel[channel] ?? 0) >= 3) continue; // out of retries in this run
        attemptsByChannel[channel] = (attemptsByChannel[channel] ?? 0) + 1;

        // The row id is fixed before publishing so a board's tracked link can point at it from the start.
        const postingId = existing?.id ?? uuidv7();
        let applyUrl = urls.apply;
        if (isBoardChannel(channel)) {
          const link = (existing ? await findPostingLink(ctx.q, postingId) : null) ?? (await createApplicationLink(ctx.q, { companyId: ctx.companyId, roleId: role.id, postingId, source: sourceForChannel(channel), label: BOARD_NAME[channel], actor: ctx.actor, now: ctx.now }));
          applyUrl = applyLinkUrl(env.jobsBaseUrl, link.token);
        }

        let result: PublishResult;
        try {
          result = await adapter.publish({ roleId: role.id, companyName: company.name, companySlug: company.slug, packet: pv.packet, jobUrl: urls.job, applyUrl, intakeAddress: intakeAddr });
        } catch (err) {
          result = { status: "failed", error: err instanceof Error ? err.message : String(err), retryable: true };
        }

        const base: PostingValues = { companyId: ctx.companyId, roleId: role.id, channel, intakeToken: channel === "email_in" ? intakeToken : existing?.intakeToken ?? null };
        if (result.status === "failed") {
          failed.push(channel);
          if (!result.retryable) attemptsByChannel[channel] = 3; // never retried by the timer
          await writeRow(ctx, existing, postingId, "failed", { ...base, error: result.error, instructions: existing?.instructions ?? null }, { error: result.error, attempt: attemptsByChannel[channel], retryable: result.retryable });
          continue;
        }
        const values: PostingValues = {
          ...base,
          externalUrl: result.externalUrl ?? existing?.externalUrl ?? null,
          externalId: result.externalId ?? existing?.externalId ?? null,
          instructions: result.instructions ?? null,
          steps: result.steps ?? [],
          error: null,
          verificationError: null,
          verificationAttempts: 0,
          publishedAt: result.status === "live_verified" ? ctx.now.toISOString() : existing?.publishedAt ?? null,
          ...(result.status === "live_verified" ? { verifiedAt: ctx.now.toISOString(), verifiedBy: ctx.actor } : {}),
        };
        const row = await writeRow(ctx, existing, postingId, result.status, values, { url: values.externalUrl ?? null, applyUrl: isBoardChannel(channel) ? applyUrl : null });
        if (channel === "careers_page" && row.status === "ready_to_post") {
          // The page's URL is known by construction: the system records it and the same check a board gets decides "live".
          await transitionPosting(ctx.q, { postingId: row.id, to: "posted_manually", actor: ctx.actor, now: ctx.now, patch: { publicUrlRecordedAt: ctx.now.toISOString() }, correlationId: ctx.run.id });
          await ctx.services.engine.enqueue(ctx.q, { kind: POSTING_VERIFY_JOB_KIND, payload: { postingId: row.id, companyId: ctx.companyId }, maxAttempts: POSTING_VERIFY_MAX_ATTEMPTS });
        }
        // ITS posts the board from the company's own account (plan D3): one task per board waiting to be posted.
        if (itsPosts && isBoardChannel(channel) && row.status === "ready_to_post") {
          const task = await openPostingTask(ctx.q, { companyId: ctx.companyId, roleId: role.id, postingId: row.id, channel, board: BOARD_NAME[channel], kind: "post_job", roleTitle: role.title, companyName: company.name, vertical: company.vertical, actor: ctx.actor, now: ctx.now });
          if (task.created) newTasks.push(BOARD_NAME[channel]);
        }
      }
      if (newTasks.length) await tellItsQueue(ctx, { companyName: company.name, roleTitle: role.title, boards: newTasks });

      const retryable = failed.filter((c) => (attemptsByChannel[c] ?? 0) < 3);
      if (retryable.length > 0) {
        const until = new Date(ctx.now.getTime() + 8 * 3600_000).toISOString();
        return { kind: "wait", wait: { kind: "timer", until, reason: `retry channels ${retryable.join(", ")}` }, state: { failedChannels: failed, attemptsByChannel }, resumeStep: "publish" };
      }
      return { kind: "complete", state: { failedChannels: failed, attemptsByChannel } };
    },
  },
};

/**
 * One email to the ITS queue for the posting tasks a run opened: the company, the job and the boards, nothing more.
 * Through the outbox, so it leaves once, after the step commits.
 */
async function tellItsQueue(ctx: StepContext<State>, input: { companyName: string; roleTitle: string; boards: string[] }): Promise<void> {
  const { integrations, env } = ctx.services;
  await queueCommunication(ctx.q, integrations, {
    channel: "email",
    companyId: ctx.companyId,
    to: env.itsQueueEmail,
    from: `${integrations.env.productName} <${integrations.env.fromAddress}>`,
    subject: `[post_job] ${input.companyName}: post "${input.roleTitle}" on ${input.boards.join(", ")}`,
    text: `${input.companyName} approved "${input.roleTitle}". It needs posting from the company's own account on: ${input.boards.join(", ")}. Each board is its own task in the queue, with the posting package and the board's apply link: ${env.appBaseUrl}/recruiter/queue`,
    templateKey: "its_posting_tasks",
    idempotencyKey: `its_posting_tasks:${ctx.run.id}:${input.boards.join(",")}`,
    tags: { template: "its_posting_tasks" },
    actor: ctx.actor,
    correlationId: ctx.run.id,
  }, ctx.now);
}

/**
 * Whether a closed posting may be prepared again: only when its role was closed after it (or with it) and has since
 * been opened again, and only when nothing of it is still up on the outside. A board a person closed while the role
 * stayed open stays closed, and a board whose removal nobody has confirmed yet keeps its place on the "still up"
 * checklist. The order comes from the event log (ids only grow), so no two clocks are compared.
 */
async function reopenedSinceClosed(q: Tx, roleId: string, row: PostingRow): Promise<boolean> {
  if (row.closureRequired && !row.closureConfirmedAt) return false;
  const [postingClosed] = await q.select({ id: events.id }).from(events).where(and(eq(events.subjectType, "posting"), eq(events.subjectId, row.id), eq(events.type, "posting.closed"))).orderBy(desc(events.id)).limit(1);
  if (!postingClosed) return false;
  const [roleClosedAfter] = await q.select({ id: events.id }).from(events).where(and(eq(events.subjectType, "role"), eq(events.subjectId, roleId), eq(events.type, "role.closed"), gt(events.id, postingClosed.id))).limit(1);
  return !!roleClosedAfter;
}

/**
 * Writes what a channel's adapter reported. A new row is inserted at that state; an existing row moves through the
 * state table when the table allows it; a closed or failed row of a re-opened role is re-prepared in place (the
 * workflow is the one origin of posting rows, docs/spec/20). A closure nobody has confirmed is never cleared here: the
 * listing may still be up, and the checklist is how the owner knows. Every write emits `posting.<state>`.
 */
async function writeRow(ctx: StepContext<State>, existing: PostingRow | undefined, postingId: string, to: PostingState, values: PostingValues, payload: Record<string, unknown>): Promise<PostingRow> {
  const { intakeToken, companyId, roleId, channel, ...patch } = values;
  if (!existing) {
    const [row] = await ctx.q.insert(postings).values({ ...values, id: postingId, companyId: companyId!, roleId: roleId!, channel: channel!, status: to }).returning();
    await emit(ctx.q, { type: `posting.${to}`, companyId: ctx.companyId, actor: ctx.actor, subject: { type: "posting", id: row.id }, payload: { channel: row.channel, roleId: row.roleId, from: null, to, ...payload }, correlationId: ctx.run.id });
    return row;
  }
  if (existing.status !== to && canTransitionPosting(existing.status, to)) {
    return (await transitionPosting(ctx.q, { postingId: existing.id, to, actor: ctx.actor, now: ctx.now, patch, payload, correlationId: ctx.run.id })).row;
  }
  const closurePending = existing.closureRequired && !existing.closureConfirmedAt;
  const [row] = await ctx.q.update(postings).set({ ...patch, intakeToken, status: to, ...(to === "closed" || closurePending ? {} : { closedAt: null, closureRequired: false, closureConfirmedAt: null, closureConfirmedBy: null }) }).where(eq(postings.id, existing.id)).returning();
  await emit(ctx.q, { type: `posting.${to}`, companyId: ctx.companyId, actor: ctx.actor, subject: { type: "posting", id: row.id }, payload: { channel: row.channel, roleId: row.roleId, from: existing.status, to, reprepared: true, ...payload }, correlationId: ctx.run.id });
  return row;
}

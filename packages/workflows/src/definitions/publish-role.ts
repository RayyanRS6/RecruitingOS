import { and, eq } from "drizzle-orm";
import { BOARD_NAME, POSTING_VERIFY_JOB_KIND, POSTING_VERIFY_MAX_ATTEMPTS, applyLinkUrl, canTransitionPosting, createApplicationLink, emit, findPostingLink, isBoardChannel, jobUrlsFor, sourceForChannel, transitionPosting, type PostingState } from "@ros/core";
import { companies, postings, randomToken, rolePackets, roles, uuidv7 } from "@ros/db";
import { intakeAddress, type PublishResult } from "@ros/integrations";
import type { StepContext, WorkflowDefinition } from "../types";

type State = { roleId: string; packetVersion: number; failedChannels?: string[]; attemptsByChannel?: Record<string, number> };

const CHANNEL_ORDER = ["careers_page", "google_jobs", "email_in", "linkedin_basic", "indeed", "ziprecruiter"];

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
 * nobody holds: a board that is posted, paused or waiting on a person is left alone.
 */
export const publishRole: WorkflowDefinition<State> = {
  key: "publish_role",
  version: 2,
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

      const { integrations, env } = ctx.services;
      const urls = jobUrlsFor(env.jobsBaseUrl, { slug: company.slug, roleId: role.id });

      // The email-in address is allocated once per role and reused by every channel's instructions.
      const [emailIn] = await ctx.q.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, "email_in"))).limit(1);
      const intakeToken = emailIn?.intakeToken ?? (randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || randomToken(6).toLowerCase());
      const intakeAddr = intakeAddress(intakeToken, integrations.env.intakeDomain);

      const failed: string[] = [];
      const attemptsByChannel = { ...(ctx.state.attemptsByChannel ?? {}) };
      for (const channel of CHANNEL_ORDER) {
        const adapter = integrations.jobBoards[channel];
        if (!adapter) continue;
        const [existing] = await ctx.q.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, channel))).limit(1);
        if (existing && HANDS_OFF.includes(existing.status as PostingState)) continue;
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
      }

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
 * Writes what a channel's adapter reported. A new row is inserted at that state; an existing row moves through the
 * state table when the table allows it; a closed or failed row of a re-opened role is re-prepared in place (the
 * workflow is the one origin of posting rows, docs/spec/20). Every write emits `posting.<state>`.
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
  const [row] = await ctx.q.update(postings).set({ ...patch, intakeToken, status: to, ...(to === "closed" ? {} : { closedAt: null, closureRequired: false, closureConfirmedAt: null, closureConfirmedBy: null }) }).where(eq(postings.id, existing.id)).returning();
  await emit(ctx.q, { type: `posting.${to}`, companyId: ctx.companyId, actor: ctx.actor, subject: { type: "posting", id: row.id }, payload: { channel: row.channel, roleId: row.roleId, from: existing.status, to, reprepared: true, ...payload }, correlationId: ctx.run.id });
  return row;
}

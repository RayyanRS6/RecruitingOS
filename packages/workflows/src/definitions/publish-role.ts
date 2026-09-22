import { and, eq } from "drizzle-orm";
import { emit } from "@ros/core";
import { companies, postings, randomToken, rolePackets, roles } from "@ros/db";
import { intakeAddress, type PublishResult } from "@ros/integrations";
import type { WorkflowDefinition } from "../types";

type State = { roleId: string; packetVersion: number; failedChannels?: string[]; attemptsByChannel?: Record<string, number> };

const CHANNEL_ORDER = ["careers_page", "google_jobs", "email_in", "linkedin_basic", "indeed", "ziprecruiter"];

/**
 * Publishes an open role to every channel (docs/06 `publish_role`). A channel failure never fails the run:
 * the posting row records the error and the channel is retried up to three times over 24 hours.
 */
export const publishRole: WorkflowDefinition<State> = {
  key: "publish_role",
  version: 1,
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
      const jobUrl = `${env.appBaseUrl}/careers/${company.slug}/jobs/${role.id}`;
      const applyUrl = `${jobUrl}/apply`;

      // The email-in address is allocated once per role and reused by every channel's instructions.
      let emailIn = (await ctx.q.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, "email_in"))).limit(1))[0];
      if (!emailIn) {
        const token = randomToken(9).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || randomToken(6).toLowerCase();
        [emailIn] = await ctx.q.insert(postings).values({ companyId: ctx.companyId, roleId: role.id, channel: "email_in", status: "pending", intakeToken: token }).returning();
      }
      const intakeAddr = intakeAddress(emailIn.intakeToken!, integrations.env.intakeDomain);

      const failed: string[] = [];
      const attemptsByChannel = { ...(ctx.state.attemptsByChannel ?? {}) };
      for (const channel of CHANNEL_ORDER) {
        const adapter = integrations.jobBoards[channel];
        if (!adapter) continue;
        const [existing] = await ctx.q.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, channel))).limit(1);
        if (existing && existing.status === "live_verified") continue; // idempotent
        if (existing && ["awaiting_verification", "manual_action_required", "not_connected"].includes(existing.status) && attemptsByChannel[channel]) continue;
        attemptsByChannel[channel] = (attemptsByChannel[channel] ?? 0) + 1;
        let result: PublishResult;
        try {
          result = await adapter.publish({ roleId: role.id, companyName: company.name, companySlug: company.slug, packet: pv.packet, jobUrl, applyUrl, intakeAddress: intakeAddr });
        } catch (err) {
          result = { status: "failed" as const, error: err instanceof Error ? err.message : String(err), retryable: true };
        }
        const base = { companyId: ctx.companyId, roleId: role.id, channel };
        if (result.status === "live_verified" || result.status === "awaiting_verification") {
          // Founder decision F4: "live" only when verified; Google for Jobs stays "submitted, awaiting verification" until indexing is confirmed.
          const values = { ...base, status: result.status, externalId: result.externalId ?? existing?.externalId ?? null, externalUrl: result.externalUrl ?? null, instructions: result.instructions ?? null, publishedAt: result.status === "live_verified" ? ctx.now.toISOString() : null, error: null, intakeToken: channel === "email_in" ? emailIn.intakeToken : existing?.intakeToken ?? null };
          if (existing) await ctx.q.update(postings).set(values).where(eq(postings.id, existing.id));
          else await ctx.q.insert(postings).values(values);
          await emit(ctx.q, { type: result.status === "live_verified" ? "posting.published" : "posting.awaiting_verification", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "posting", id: `${role.id}:${channel}` }, payload: { channel, url: result.externalUrl ?? null }, correlationId: ctx.run.id });
        } else if (result.status === "manual_action_required" || result.status === "not_connected") {
          const values = { ...base, status: result.status, instructions: result.instructions, externalUrl: result.externalUrl ?? null, error: null, intakeToken: channel === "email_in" ? emailIn.intakeToken : existing?.intakeToken ?? null };
          if (existing) await ctx.q.update(postings).set(values).where(eq(postings.id, existing.id));
          else await ctx.q.insert(postings).values(values);
          await emit(ctx.q, { type: result.status === "manual_action_required" ? "posting.manual_action_required" : "posting.not_connected", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "posting", id: `${role.id}:${channel}` }, payload: { channel }, correlationId: ctx.run.id });
        } else {
          failed.push(channel);
          const error = result.status === "failed" ? result.error : "unknown publish result";
          const values = { ...base, status: "failed", error };
          if (existing) await ctx.q.update(postings).set(values).where(eq(postings.id, existing.id));
          else await ctx.q.insert(postings).values(values);
          await emit(ctx.q, { type: "posting.failed", companyId: ctx.companyId, actor: ctx.actor, subject: { type: "posting", id: `${role.id}:${channel}` }, payload: { channel, error, attempt: attemptsByChannel[channel] }, correlationId: ctx.run.id });
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

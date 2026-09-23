import { FakeProvider, createRuntimeAsync, type AiRuntime } from "@ros/ai";
import { cancelInterviewEvents, registerFakeHandlers } from "@ros/agents";
import { createDb, inspectConnectionRole, jobs, migrate, problemsWithConnectionRole, seedPlatform, withPlatform, withTenant, type Db, type DbHandle, type DbRole } from "@ros/db";
import { countActiveAdmins, createRateLimitStore, raiseAlert, type RateLimitStore } from "@ros/core";
import { createIntegrations, type Integrations } from "@ros/integrations";
import { createEngine, type WorkflowEngine } from "@ros/workflows";
import { REVOKE_JOB_KIND, checkPrivacyRequestDeadlines, listSuppressions, onSuppressionChange, revokeAndDeleteCredentials, setEventSink } from "@ros/core";
import { retryCommunication, sendFallbackSms } from "@ros/agents";
import { guardEmailAdapter } from "@ros/integrations";
import type { Actor } from "@ros/contracts";
import { toProductEvent } from "@ros/integrations";
import { loadEnv, type Env } from "./env";
import { registerSecretValue } from "@ros/core";

export type Container = {
  env: Env;
  handle: DbHandle;
  db: Db;
  ai: AiRuntime;
  fake: FakeProvider | null;
  integrations: Integrations;
  engine: WorkflowEngine;
  /** Shared rate limiting (21 Sep, item 5): memory locally, a shared counter for several processes. */
  rateLimits: RateLimitStore;
  /** Kicks the inline worker after a request commits; returns a promise tests can await. */
  kick(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
};

export async function createContainer(opts: { env?: Record<string, string | undefined>; memory?: boolean; now?: () => Date; role?: DbRole } = {}): Promise<Container> {
  const env = loadEnv(opts.env ?? process.env);
  // Every runtime secret the environment carries is registered so logs, error responses and error reports scrub it (correction 10).
  for (const name of ["SESSION_SECRET", "ANTHROPIC_API_KEY", "POSTMARK_SERVER_TOKEN", "POSTMARK_INBOUND_SECRET", "POSTMARK_WEBHOOK_SECRET", "UPSTASH_REDIS_REST_TOKEN", "TWILIO_AUTH_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET", "SUPABASE_JWT_SECRET"]) {
    const v = env.raw[name];
    if (v && v.length >= 12 && !v.startsWith("dev-only")) registerSecretValue(v);
  }
  for (const name of ["DATABASE_URL", "WORKER_DATABASE_URL", "MIGRATE_DATABASE_URL"]) {
    try { const pw = env.raw[name] ? decodeURIComponent(new URL(env.raw[name]!).password) : ""; if (pw.length >= 12) registerSecretValue(pw); } catch { /* not a URL */ }
  }
  const role: DbRole = opts.role ?? "app";
  if (role === "worker" && env.NODE_ENV === "production" && !env.WORKER_DATABASE_URL) throw new Error("WORKER_DATABASE_URL must be set in production for the worker (a separate, non-privileged database role)");
  const databaseUrl = role === "worker" ? env.WORKER_DATABASE_URL ?? env.DATABASE_URL : env.DATABASE_URL;
  const handle = await createDb({ databaseUrl, pgliteDir: opts.memory ? "memory://" : env.PGLITE_DIR, role });
  // Founder decision F1: never a superuser, never an RLS-bypassing role. Migrations run as the owner role elsewhere; PGlite is dev-only.
  const roleInfo = await inspectConnectionRole(handle);
  const problems = problemsWithConnectionRole(roleInfo, handle.kind);
  if (problems.length && handle.kind === "postgres") {
    if (env.NODE_ENV === "production") throw new Error(`refusing to start: ${problems.join("; ")}`);
    console.warn(`[db] ${problems.join("; ")}`);
  }
  if (env.NODE_ENV !== "production" || env.raw.RUN_MIGRATIONS_ON_BOOT === "true") await migrate(handle);
  await seedPlatform(handle.db);
  const rateLimits = createRateLimitStore(env, {
    // The shared store degraded to per-process counting (decision 4 fail-safe): one alert an hour, never a refused request.
    onDegraded: (reason) => {
      console.warn(`[rate-limit] shared store unavailable, counting per process: ${reason}`);
      void raiseAlert(handle.db, { kind: "rate_limit.shared_unavailable", severity: "high", title: "Shared rate-limit store unreachable; limits apply per process", body: "The Upstash counter could not be reached or refused the request. Limits are counted in this process's memory until it answers again. Check the Upstash console, the monthly budget and the REST token.", details: { reason: reason.slice(0, 200) } }).catch(() => undefined);
    },
  });
  if (env.NODE_ENV === "production" && (env.RATE_LIMIT_STORE !== "shared" || env.RATE_LIMIT_SHARED_PROVIDER === "fake")) {
    console.warn("[rate-limit] production is running without a shared rate-limit store; limits are per process. Select a provider (docs/readiness/15) before real traffic.");
    await raiseAlert(handle.db, { kind: "rate_limit.not_shared", severity: "high", title: "Rate limits are not shared between processes", body: "RATE_LIMIT_STORE is not a real shared store. Limits apply per process only. Select a provider (docs/readiness/15) before real candidate traffic.", details: { store: env.RATE_LIMIT_STORE, provider: env.RATE_LIMIT_SHARED_PROVIDER } }).catch(() => undefined);
  }
  if (env.BOOTSTRAP_ADMIN_EMAILS.length && (await countActiveAdmins(handle.db)) > 0) {
    console.warn("[auth] BOOTSTRAP_ADMIN_EMAILS is set but administrators already exist: the list grants nothing and every match is audited as ignored. Remove the variable.");
  }

  let fake: FakeProvider | null = null;
  let ai: AiRuntime;
  if (env.AI_PROVIDER === "fake") {
    fake = new FakeProvider();
    registerFakeHandlers(fake);
    ai = await createRuntimeAsync(env.raw, fake);
  } else {
    ai = await createRuntimeAsync(env.raw);
  }
  const integrations = createIntegrations(
    { ...env.raw, STORAGE_DIR: env.STORAGE_DIR, EMAIL_FROM_ADDRESS: env.EMAIL_FROM_ADDRESS, EMAIL_REPLY_TO: env.EMAIL_REPLY_TO, PRODUCT_NAME: env.PRODUCT_NAME, SECRET_STORE: env.SECRET_STORE },
    { memoryStorage: opts.memory || env.STORAGE_PROVIDER === "memory", secretsExecutor: (text, params) => handle.query(text, params) },
  );
  // Item 5 (18 Sep): every email send consults the do-not-send list first, whatever adapter is underneath. The list is held
  // in memory (loaded at boot, updated the moment it changes in this process, reloaded every minute for other processes) so
  // a send inside a database transaction never queries outside it.
  const suppressed = new Map<string, string>();
  const reloadSuppressions = async () => { suppressed.clear(); for (const s of await listSuppressions(handle.db)) suppressed.set(s.address, s.reason); };
  await reloadSuppressions();
  onSuppressionChange((c) => { if (c.active) suppressed.set(c.address, c.reason); else suppressed.delete(c.address); });
  const suppressionRefresh = setInterval(() => { void reloadSuppressions().catch(() => undefined); }, 60_000);
  suppressionRefresh.unref();
  integrations.email = guardEmailAdapter(integrations.email, async (address) => { const reason = suppressed.get(address.trim().toLowerCase()); return reason ? { reason } : null; });
  // Founder decision (correction 14): privacy-preserving, server-side funnel events only; nothing from candidate pages, no PII.
  setEventSink((event) => {
    const pe = toProductEvent({ type: event.type, companyId: event.companyId, subjectId: event.subject.id, occurredAt: event.occurredAt, payload: event.payload }, integrations.analyticsSalt);
    if (pe) void integrations.analytics.capture(pe);
  });
  const engine = createEngine(
    { db: handle.db, services: { ai, integrations, env: { appBaseUrl: env.APP_BASE_URL, webBaseUrl: env.WEB_BASE_URL, itsQueueEmail: env.ITS_QUEUE_EMAIL } } },
    { now: opts.now },
  );

  // Correction 10: disconnecting queues revocation and deletion; the worker (the only role that can read the value) runs it.
  engine.registerJob(REVOKE_JOB_KIND, async (payload, ctx) => {
    const integrationId = String(payload.integrationId ?? "");
    if (!integrationId) return;
    const actor = (payload.actor as Actor | undefined) ?? { kind: "system", id: "credential_revoker" };
    const result = await withPlatform(handle.db, (tx) => revokeAndDeleteCredentials(tx, integrations.secrets, {
      integrationId, actor, attempt: ctx.attempt, maxAttempts: ctx.maxAttempts, now: ctx.now,
      revoker: (provider, value) => (integrations.revokers[provider] ? integrations.revokers[provider].revoke(value) : Promise.resolve({ ok: false, error: `no revoker for ${provider}` })),
    }));
    // The alert and audit record are committed; failing the job here makes the queue retry with backoff.
    if (!result.deleted) throw new Error(result.error ?? "credential deletion failed");
  });

  // Calendar events are removed by the worker (the only role that reads credentials); a failure notifies the person, never blocks the cancellation.
  engine.registerJob("interview.cancel_events", async (payload) => {
    const interviewId = String(payload.interviewId ?? "");
    const companyId = String(payload.companyId ?? "");
    if (!interviewId || !companyId) return;
    const actor = (payload.actor as Actor | undefined) ?? { kind: "system", id: "calendar" };
    await withTenant(handle.db, companyId, (tx) => cancelInterviewEvents(tx, integrations, { interviewId, actor }));
  });

  // Privacy-request deadlines are checked daily (correction 7): the job re-queues itself; a person sees an alert ten days before and when overdue.
  engine.registerJob("privacy.deadline_check", async (_payload, ctx) => {
    await checkPrivacyRequestDeadlines(handle.db, ctx.now);
    await handle.db.insert(jobs).values({ kind: "privacy.deadline_check", payload: {}, runAt: new Date(ctx.now.getTime() + 24 * 3600_000).toISOString(), maxAttempts: 3 });
  });

  engine.registerJob("email.retry", async (payload, ctx) => {
    await withPlatform(handle.db, (tx) => retryCommunication(tx, integrations, { communicationId: String(payload.communicationId ?? ""), attempt: Number(payload.attempt ?? 1), now: ctx.now }));
  });
  engine.registerJob("email.fallback_sms", async (payload) => {
    const applicationId = String(payload.applicationId ?? "");
    if (!applicationId) return;
    await withPlatform(handle.db, (tx) => sendFallbackSms(tx, integrations, { applicationId, communicationId: (payload.communicationId as string | null) ?? null, appBaseUrl: env.APP_BASE_URL }));
  });

  let draining: Promise<void> | null = null;
  const drain = async () => {
    if (draining) return draining;
    draining = (async () => {
      try {
        await engine.runUntilIdle();
      } finally {
        draining = null;
      }
    })();
    return draining;
  };
  const kick = async () => {
    if (!env.WORKER_INLINE) return;
    await drain();
  };

  return {
    env,
    handle,
    db: handle.db,
    ai,
    fake,
    integrations,
    engine,
    rateLimits,
    kick,
    drain,
    close: () => { clearInterval(suppressionRefresh); return handle.close(); },
  };
}

import { createRuntime, type AiRuntime, type FakeProvider } from "@ros/ai";
import { cancelInterviewEvents } from "@ros/agents";
import { eq } from "drizzle-orm";
import { createDb, inspectConnectionRole, migrate, migrationStatus, postings, problemsWithConnectionRole, roles, seedPlatform, withPlatform, withTenant, type Db, type DbHandle, type DbRole } from "@ros/db";
import { POSTING_VERIFY_JOB_KIND, POSTING_VERIFY_MAX_ATTEMPTS, countActiveAdmins, createRateLimitStore, emit, raiseAlert, transitionPosting, type RateLimitStore } from "@ros/core";
import { createIntegrations, type Integrations } from "@ros/integrations";
import { createEngine, type WorkflowEngine } from "@ros/workflows";
import { REVOKE_JOB_KIND, checkPrivacyRequestDeadlines, listSuppressions, onSuppressionChange, revokeAndDeleteCredentials, setEventSink, setNotifyClock } from "@ros/core";
import { SEND_JOB_KIND, retryCommunication, sendFallbackSms, sendQueuedCommunication } from "@ros/agents";
import { guardEmailAdapter } from "@ros/integrations";
import type { Actor } from "@ros/contracts";
import { toProductEvent } from "@ros/integrations";
import { loadEnv, type Env } from "./env";
import { registerSecretValue } from "@ros/core";
import { UploadGrants } from "./uploads";
import { HEALTH_CHECK_JOB_KIND, HOURLY_MS, MAINTENANCE_JOB_KIND, checkOperationalHealth, runMaintenance } from "./maintenance";
import { checkScannerForProduction } from "./scanner-gate";
import { checkEmailForProduction } from "./email-gate";
import { reportError } from "./observability";
import { jobFailureReport, stepFailureReport } from "./failure-reports";
import { DAILY_MS, recurring } from "./recurring-jobs";
import { LINK_REQUEST_JOB_KIND, emailStatusLinks } from "./services/applications";
import { registerApplyConversationJobs } from "./services/apply-conversation";
import { PUBLISHING_BACKFILL_JOB_KIND, backfillPublishing } from "./services/publishing-backfill";

const PRIVACY_DEADLINE_JOB_KIND = "privacy.deadline_check";

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
  /** Seals the grant a browser hands the apply form after a direct-to-storage upload (decision 2). */
  uploadGrants: UploadGrants;
  /** Kicks the inline worker after a request commits; returns a promise tests can await. */
  kick(): Promise<void>;
  drain(): Promise<void>;
  close(): Promise<void>;
};

export async function createContainer(opts: { env?: Record<string, string | undefined>; memory?: boolean; now?: () => Date; role?: DbRole } = {}): Promise<Container> {
  const role: DbRole = opts.role ?? "app";
  // The boot checks know which process this is (H7): the app needs DATABASE_URL, the worker WORKER_DATABASE_URL, and neither may fall back to PGlite in production.
  const env = loadEnv(opts.env ?? process.env, { role });
  // Every runtime secret the environment carries is registered so logs, error responses and error reports scrub it (correction 10).
  for (const name of ["SESSION_SECRET", "ANTHROPIC_API_KEY", "POSTMARK_SERVER_TOKEN", "POSTMARK_INBOUND_SECRET", "POSTMARK_WEBHOOK_SECRET", "UPSTASH_REDIS_REST_TOKEN", "TWILIO_AUTH_TOKEN", "GOOGLE_OAUTH_CLIENT_SECRET", "SUPABASE_JWT_SECRET", "STORAGE_S3_SECRET_ACCESS_KEY"]) {
    const v = env.raw[name];
    if (v && v.length >= 12 && !v.startsWith("dev-only")) registerSecretValue(v);
  }
  for (const name of ["DATABASE_URL", "WORKER_DATABASE_URL", "MIGRATE_DATABASE_URL"]) {
    try { const pw = env.raw[name] ? decodeURIComponent(new URL(env.raw[name]!).password) : ""; if (pw.length >= 12) registerSecretValue(pw); } catch { /* not a URL */ }
  }
  const databaseUrl = role === "worker" ? env.WORKER_DATABASE_URL ?? env.DATABASE_URL : env.DATABASE_URL;
  if (env.NODE_ENV === "production" && !databaseUrl) throw new Error(`refusing to start: the ${role} process has no database connection string and would open PGlite, the in-process development database, which production refuses`);
  const handle = await createDb({ databaseUrl, pgliteDir: opts.memory ? "memory://" : env.PGLITE_DIR, role });
  // Founder decision F1: never a superuser, never an RLS-bypassing role. Migrations run as the owner role elsewhere; PGlite is dev-only.
  const roleInfo = await inspectConnectionRole(handle);
  const problems = problemsWithConnectionRole(roleInfo, handle.kind);
  if (problems.length && handle.kind === "postgres") {
    if (env.NODE_ENV === "production") throw new Error(`refusing to start: ${problems.join("; ")}`);
    console.warn(`[db] ${problems.join("; ")}`);
  }
  if (env.NODE_ENV !== "production" || env.raw.RUN_MIGRATIONS_ON_BOOT === "true") {
    await migrate(handle);
  } else {
    // Production never migrates on boot (a release step does, docs/14); it also never runs against a schema it does not expect.
    const status = await migrationStatus(handle);
    if (status.pending.length) throw new Error(`refusing to start: ${status.pending.length} migration${status.pending.length === 1 ? " is" : "s are"} not applied (${status.pending.join(", ")}). Run pnpm db:migrate (or the migrate workflow) before deploying.`);
  }
  await seedPlatform(handle.db);
  // A production app reaches this only with the shared store (loadEnv refuses anything else); the worker counts no requests.
  const rateLimits = createRateLimitStore(env, {
    // The shared store degraded to per-process counting (decision 4 fail-safe): one alert an hour, never a refused request.
    onDegraded: (reason) => {
      console.warn(`[rate-limit] shared store unavailable, counting per process: ${reason}`);
      void raiseAlert(handle.db, { kind: "rate_limit.shared_unavailable", severity: "high", title: "Shared rate-limit store unreachable; limits apply per process", body: "The Upstash counter could not be reached or refused the request. Limits are counted in this process's memory until it answers again. Check the Upstash console, the monthly budget and the REST token.", details: { reason: reason.slice(0, 200) } }).catch((err) => console.warn(`[rate-limit] could not raise the degradation alert: ${err instanceof Error ? err.message : String(err)}`));
    },
  });
  if (env.BOOTSTRAP_ADMIN_EMAILS.length && (await countActiveAdmins(handle.db)) > 0) {
    console.warn("[auth] BOOTSTRAP_ADMIN_EMAILS is set but administrators already exist: the list grants nothing and every match is audited as ignored. Remove the variable.");
  }

  let fake: FakeProvider | null = null;
  let ai: AiRuntime;
  if (env.AI_PROVIDER === "fake") {
    // The deterministic fake and its 48 KB of handlers are loaded only when asked for, so they stay out of the production bundle.
    const [{ FakeProvider: Fake }, { registerFakeHandlers }] = await Promise.all([import("@ros/ai"), import("@ros/agents")]);
    fake = new Fake();
    registerFakeHandlers(fake);
    ai = await createRuntime(env.raw, fake);
  } else {
    ai = await createRuntime(env.raw);
  }
  // Every value the adapters read is the normalized one from loadEnv, so a default lives in one place only.
  const integrations = createIntegrations(
    { ...env.raw, APP_BASE_URL: env.APP_BASE_URL, STORAGE_DIR: env.STORAGE_DIR, EMAIL_FROM_DOMAIN: env.EMAIL_FROM_DOMAIN, EMAIL_FROM_ADDRESS: env.EMAIL_FROM_ADDRESS, EMAIL_REPLY_TO: env.EMAIL_REPLY_TO, EMAIL_INTAKE_DOMAIN: env.EMAIL_INTAKE_DOMAIN, ITS_QUEUE_EMAIL: env.ITS_QUEUE_EMAIL, PRODUCT_NAME: env.PRODUCT_NAME, SECRET_STORE: env.SECRET_STORE },
    { memoryStorage: opts.memory || env.STORAGE_PROVIDER === "memory", secretsExecutor: (text, params) => handle.query(text, params) },
  );
  // A real malware engine is asked whether it answers (H6); a scanner that is down does not stop the boot, the quarantine step retries.
  if (integrations.scanner.check) {
    const scannerStatus = await integrations.scanner.check();
    if (scannerStatus !== "live") console.warn(`[scanner] ${integrations.scanner.id} did not answer the boot check (${scannerStatus}); quarantined files wait until it does (CLAMAV_HOST, CLAMAV_PORT; docs/runbooks/resume-storage.md)`);
  }
  // The real-data gate (docs/readiness/20 blocker 8): a production worker on the fake scanner raises one standing alert (scanner-gate.ts).
  await checkScannerForProduction(handle.db, { nodeEnv: env.NODE_ENV, role, scannerStatus: integrations.scanner.status, scannerId: integrations.scanner.id });
  // The same for email: production on the fake adapter sends nothing while the pages say it went, so one standing alert (email-gate.ts).
  await checkEmailForProduction(handle.db, { nodeEnv: env.NODE_ENV, role, emailStatus: integrations.email.status, emailId: integrations.email.id });
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
    {
      db: handle.db,
      services: { ai, integrations, env: { appBaseUrl: env.APP_BASE_URL, jobsBaseUrl: env.JOBS_BASE_URL, itsQueueEmail: env.ITS_QUEUE_EMAIL, smsEnabled: env.SMS_ENABLED } },
      // Failures that used up their attempts reach the error reporter with kinds and ids (H2) and the last error scrubbed and cut (failure-reports.ts); the payload and the run's state never leave the database.
      onJobFailed: (info) => { const report = jobFailureReport(info); reportError(report.err, report.context); },
      onStepFailed: (info) => { const report = stepFailureReport(info); reportError(report.err, report.context); },
    },
    { now: opts.now },
  );
  // The outbox stamps its send jobs on the engine's clock, so a message queued "now" is due on the clock that runs the queue.
  integrations.clock = () => engine.clock();
  // So does the job that writes an email alert for an update (plan B3).
  setNotifyClock(() => engine.clock());

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

  // Privacy-request deadlines are checked daily (correction 7): the job re-arms itself even when a run fails (H13); a person sees an alert ten days before and when overdue.
  engine.registerJob(PRIVACY_DEADLINE_JOB_KIND, recurring(engine, handle.db, PRIVACY_DEADLINE_JOB_KIND, DAILY_MS, async (ctx) => {
    await checkPrivacyRequestDeadlines(handle.db, ctx.now);
  }));

  // The daily sweep (docs/14, retention): finished jobs, expired sessions and sign-in links, old receipts and reports, old heartbeats,
  // interrupted sends; then the health checks (a stale worker, a stale queue). Re-armed even when a run fails (H13).
  engine.registerJob(MAINTENANCE_JOB_KIND, recurring(engine, handle.db, MAINTENANCE_JOB_KIND, DAILY_MS, async (ctx) => {
    await runMaintenance(handle.db, ctx.now, { workerInline: env.WORKER_INLINE });
  }));

  // The stale-queue check every hour, not only with the daily sweep (H3). A worker that stopped is noticed by the app's
  // /healthz instead (maintenance.ts, appHealthWatch): a job cannot report that the process meant to run it is gone.
  engine.registerJob(HEALTH_CHECK_JOB_KIND, recurring(engine, handle.db, HEALTH_CHECK_JOB_KIND, HOURLY_MS, async (ctx) => {
    await checkOperationalHealth(handle.db, ctx.now, { workerInline: env.WORKER_INLINE });
  }));

  // The outbox: every email and text queued inside a transaction is sent here, after that transaction committed, once.
  engine.registerJob(SEND_JOB_KIND, async (payload, ctx) => {
    const communicationId = String(payload.communicationId ?? "");
    const companyId = String(payload.companyId ?? "");
    if (!communicationId || !companyId) return;
    await sendQueuedCommunication(handle.db, integrations, { communicationId, companyId }, ctx);
  });

  // "Lost your link?" (Wave 0 item 0.1): the page queued the request and answered at once; the lookup and the emails happen here.
  engine.registerJob(LINK_REQUEST_JOB_KIND, async (payload, ctx) => {
    const email = typeof payload.email === "string" ? payload.email : "";
    if (email) await emailStatusLinks({ db: handle.db, integrations, jobsBaseUrl: env.JOBS_BASE_URL }, email, ctx.now);
  });

  // A repeat submission's conversation (plan E1): wiped after seven days unconfirmed, and tried again after an outage.
  registerApplyConversationJobs(engine, { db: handle.db, ai, integrations, engine, jobsBaseUrl: env.JOBS_BASE_URL });

  engine.registerJob("email.retry", async (payload, ctx) => {
    await withPlatform(handle.db, (tx) => retryCommunication(tx, integrations, { communicationId: String(payload.communicationId ?? ""), attempt: Number(payload.attempt ?? 1), now: ctx.now }));
  });
  engine.registerJob("email.fallback_sms", async (payload) => {
    const applicationId = String(payload.applicationId ?? "");
    if (!applicationId) return;
    // The status link a candidate receives lives on the job-page host, like the acknowledgment's.
    await withPlatform(handle.db, (tx) => sendFallbackSms(tx, integrations, { applicationId, communicationId: (payload.communicationId as string | null) ?? null, appBaseUrl: env.JOBS_BASE_URL }));
  });

  /**
   * Public URL verification (docs/spec/20 item 12): fetches the posting's recorded URL through the verifier adapter
   * and moves the posting to live_verified when the page answers with the job title. A failed fetch is recorded on
   * the row and retried by the queue with backoff; the third failure marks the posting failed for a person to look at.
   * A posting a person confirmed by hand ("I checked it myself") is left alone by a check that was already waiting
   * when they confirmed; only a check they asked for (`payload.requested`, "Check again") fetches it again.
   * Never posts anything, never touches a candidate.
   */
  engine.registerJob(POSTING_VERIFY_JOB_KIND, async (payload, ctx) => {
    const postingId = String(payload.postingId ?? "");
    const companyId = String(payload.companyId ?? "");
    if (!postingId || !companyId) return;
    const requested = payload.requested === true;
    const actor: Actor = { kind: "system", id: "link_check" };
    const checkable = (p: { status: string; externalUrl: string | null; verifiedBy: Actor | null }) => {
      if (!["posted_manually", "submitted_integration", "live_verified"].includes(p.status) || !p.externalUrl) return false;
      const byPerson = p.status === "live_verified" && p.verifiedBy !== null && p.verifiedBy.kind !== "system";
      return requested || !byPerson;
    };
    const target = await withTenant(handle.db, companyId, async (tx) => {
      const [p] = await tx.select().from(postings).where(eq(postings.id, postingId)).limit(1);
      if (!p || !checkable(p)) return null;
      const [role] = await tx.select({ title: roles.title }).from(roles).where(eq(roles.id, p.roleId)).limit(1);
      return role ? { url: p.externalUrl!, title: role.title } : null;
    });
    if (!target) return; // nothing to check: no URL yet, the posting moved on, or a person's word stands
    const result = await integrations.verifier.verify(target.url, { expectedTitle: target.title });
    const retry = await withTenant(handle.db, companyId, async (tx) => {
      const [p] = await tx.select().from(postings).where(eq(postings.id, postingId)).limit(1);
      if (!p || !checkable(p)) return false;
      if (result.ok) {
        if (p.status === "live_verified") await tx.update(postings).set({ verifiedAt: ctx.now.toISOString(), verifiedBy: actor, verificationError: null, verificationAttempts: 0 }).where(eq(postings.id, p.id));
        else await transitionPosting(tx, { postingId: p.id, to: "live_verified", actor, now: ctx.now, patch: { verifiedAt: ctx.now.toISOString(), verifiedBy: actor, verificationError: null, verificationAttempts: 0 }, payload: { check: "fetched" } });
        return false;
      }
      const attempts = p.verificationAttempts + 1;
      const detail = `${result.reason}: ${result.detail}`;
      const last = attempts >= POSTING_VERIFY_MAX_ATTEMPTS || ctx.attempt >= ctx.maxAttempts;
      await tx.update(postings).set({ verificationAttempts: attempts, verificationError: detail }).where(eq(postings.id, p.id));
      await emit(tx, { type: "posting.verification_failed", companyId, actor, subject: { type: "posting", id: p.id }, payload: { channel: p.channel, roleId: p.roleId, url: p.externalUrl, reason: result.reason, detail: result.detail, attempt: attempts, final: last } });
      if (last) {
        await transitionPosting(tx, { postingId: p.id, to: "failed", actor, now: ctx.now, patch: { error: `The public URL could not be verified after ${attempts} ${attempts === 1 ? "check" : "checks"} (${detail}). Check the link, then record it again or confirm it yourself.` }, payload: { reason: result.reason } });
        return false;
      }
      return true;
    });
    if (retry) throw new Error(`verification of posting ${postingId} failed (${result.ok ? "" : result.reason}); retrying`);
  });

  // Roles already open when the publishing rules arrived (plan Wave D): their missing ITS posting tasks and Colorado
  // closing dates. Queued once per boot; a run changes only what is still missing (services/publishing-backfill.ts).
  engine.registerJob(PUBLISHING_BACKFILL_JOB_KIND, async () => {
    await backfillPublishing({ db: handle.db, integrations, env, engine });
  });

  // The recurring jobs exist from the first boot of any process; tests arm them explicitly so a moved clock never runs a sweep by surprise.
  if (env.NODE_ENV !== "test") {
    for (const kind of [PRIVACY_DEADLINE_JOB_KIND, MAINTENANCE_JOB_KIND, HEALTH_CHECK_JOB_KIND, PUBLISHING_BACKFILL_JOB_KIND]) await engine.ensureQueued(handle.db, { kind });
  }

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
    uploadGrants: new UploadGrants(env.SESSION_SECRET),
    kick,
    drain,
    close: () => { clearInterval(suppressionRefresh); return handle.close(); },
  };
}

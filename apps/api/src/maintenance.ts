import { and, inArray, lt } from "drizzle-orm";
import { expireEmptyDrafts, sweepStaleSending } from "@ros/agents";
import { anonymizedCandidates, raiseAlertOnce, resolveAlertsOfKind, scrubCandidateAiData } from "@ros/core";
import { cspReports, jobs, magicLinks, sessions, webhookReceipts, withPlatform, workerHeartbeats, type Db } from "@ros/db";
import { HEARTBEAT_STALE_MS, queueSnapshot, readWorkerHealth } from "./worker-health";

/**
 * The daily sweep of operational rows that have served their purpose. Nothing here deletes candidate data: that follows
 * the privacy-request process and the anonymization rules (docs/09); the sweep only finishes an anonymization already
 * made (the AI readings and run log of a deleted candidate). The periods are conservative and named in one place.
 */
export const MAINTENANCE_JOB_KIND = "maintenance.daily";

export const RETENTION_DAYS = {
  /** Finished queue jobs; the workflow ledger (`workflow_steps`) keeps the history that matters. */
  doneJobs: 7,
  /** Failed jobs stay long enough for an operator to read the error. */
  failedJobs: 30,
  /** Sessions and sign-in links are useless once expired; a day's grace keeps a late request readable in the audit trail. */
  expiredSessions: 1,
  expiredMagicLinks: 1,
  /** Providers stop redelivering long before this; the receipt only exists to answer a redelivery once. */
  webhookReceipts: 30,
  /** Content-security-policy reports are reviewed within weeks; nothing in them is personal. */
  cspReports: 90,
  /** Every worker process start writes a new heartbeat row; rows of workers not seen for a week are noise. */
  workerHeartbeats: 7,
} as const;

/** A due job that has waited this long for a worker means the queue is not being drained. */
export const QUEUE_STALE_MS = 30 * 60_000;
/** A stale worker or queue raises one alert an hour at most, and none while a person already has one open. */
export const HEALTH_ALERT_WINDOW_MS = 60 * 60_000;

export type MaintenanceReport = { doneJobs: number; failedJobs: number; sessions: number; magicLinks: number; webhookReceipts: number; cspReports: number; staleHeartbeats: number; interruptedSends: number; emptyDrafts: number; anonymizedAssessments: number; anonymizedAiRuns: number; healthAlerts: number };

export type MaintenanceOptions = {
  /** True when the queue runs inside the app process (development): there is no separate worker to watch. */
  workerInline?: boolean;
  /** Scrub the AI data of every candidate ever deleted, not only the recent ones (the weekly pass; tests). */
  fullAiScrub?: boolean;
  /**
   * Emails a critical alert this check raised to the platform administrators straight after it is committed (the
   * container wires `emailCriticalAlert`). The queued job stays as the fallback, and both skip an alert already emailed;
   * this matters for the stale worker, whose job would wait for the very worker that is down.
   */
  emailCritical?: (alertId: string) => Promise<void>;
};

/** How far back the daily pass looks for deletions whose AI data may still hold words. */
export const AI_SCRUB_WINDOW_DAYS = 30;

/** The day of the week (UTC, 0 = Sunday) the clean-up looks at every deletion ever made. */
export const AI_SCRUB_FULL_DAY = 0;

async function scrubDeletedCandidatesAi(db: Db, now: Date, opts: MaintenanceOptions): Promise<{ assessments: number; aiRuns: number }> {
  const full = opts.fullAiScrub || now.getUTCDay() === AI_SCRUB_FULL_DAY;
  const since = full ? undefined : new Date(now.getTime() - AI_SCRUB_WINDOW_DAYS * 86_400_000);
  const gone = await withPlatform(db, (tx) => anonymizedCandidates(tx, { since }));
  const total = { assessments: 0, aiRuns: 0 };
  for (const c of gone) {
    const n = await withPlatform(db, (tx) => scrubCandidateAiData(tx, { companyId: c.companyId, candidateId: c.id }));
    total.assessments += n.assessments;
    total.aiRuns += n.aiRuns;
  }
  return total;
}

export async function runMaintenance(db: Db, now: Date, opts: MaintenanceOptions = {}): Promise<MaintenanceReport> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const swept = await withPlatform(db, async (tx) => {
    const doneJobs = await tx.delete(jobs).where(and(inArray(jobs.status, ["done"]), lt(jobs.createdAt, before(RETENTION_DAYS.doneJobs)))).returning({ id: jobs.id });
    const failedJobs = await tx.delete(jobs).where(and(inArray(jobs.status, ["failed"]), lt(jobs.createdAt, before(RETENTION_DAYS.failedJobs)))).returning({ id: jobs.id });
    const expiredSessions = await tx.delete(sessions).where(lt(sessions.expiresAt, before(RETENTION_DAYS.expiredSessions))).returning({ id: sessions.id });
    const expiredLinks = await tx.delete(magicLinks).where(lt(magicLinks.expiresAt, before(RETENTION_DAYS.expiredMagicLinks))).returning({ id: magicLinks.id });
    const receipts = await tx.delete(webhookReceipts).where(lt(webhookReceipts.receivedAt, before(RETENTION_DAYS.webhookReceipts))).returning({ id: webhookReceipts.id });
    const reports = await tx.delete(cspReports).where(lt(cspReports.lastAt, before(RETENTION_DAYS.cspReports))).returning({ id: cspReports.id });
    const heartbeats = await tx.delete(workerHeartbeats).where(lt(workerHeartbeats.lastSeenAt, before(RETENTION_DAYS.workerHeartbeats))).returning({ id: workerHeartbeats.workerId });
    return { doneJobs: doneJobs.length, failedJobs: failedJobs.length, sessions: expiredSessions.length, magicLinks: expiredLinks.length, webhookReceipts: receipts.length, cspReports: reports.length, staleHeartbeats: heartbeats.length };
  });
  const interruptedSends = await sweepStaleSending(db, now);
  // Drafts nobody wrote anything into are set aside quietly (plan C3); each one is recorded as an event.
  const emptyDrafts = await expireEmptyDrafts(db, now);
  // The AI readings and AI run log of candidates deleted at their request keep no words (privacy-requests.ts): repeated
  // daily for the deletions of the last AI_SCRUB_WINDOW_DAYS (a model run that finished after a deletion lands within
  // days), and once a week for every deletion ever made (those made before this existed). One short transaction per
  // candidate, so the sweep never holds a long platform transaction, and its cost stays bounded day to day.
  const ai = await scrubDeletedCandidatesAi(db, now, opts);
  const health = await checkOperationalHealth(db, now, opts);
  const report = { ...swept, interruptedSends, emptyDrafts, anonymizedAssessments: ai.assessments, anonymizedAiRuns: ai.aiRuns, healthAlerts: health.raised };
  if (Object.values(report).some((n) => n > 0)) console.log(`[maintenance] ${Object.entries(report).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return report;
}

/** The hourly queue check the worker runs between daily sweeps (a queue that stalls while the worker still polls). */
export const HEALTH_CHECK_JOB_KIND = "ops.health_check";
export const HOURLY_MS = 3600_000;
/** How often the app runs the checks from /healthz: often enough for an uptime monitor's cadence, cheap enough for any. */
export const APP_HEALTH_CHECK_EVERY_MS = 5 * 60_000;

/**
 * The checks from the side of the process that is still up when the worker is not. The worker cannot report its own
 * death (every job it would run to do so is stuck behind it), so the app runs `checkOperationalHealth` whenever its
 * /healthz is asked (an uptime monitor asks every few minutes), at most once every `everyMs` of real time per process,
 * never twice at once. Idempotent through `raiseAlertOnce`, so several app instances raise one alert. A failure is
 * logged, never answered: the health check still reports.
 */
export function appHealthWatch(db: Db, opts: MaintenanceOptions & { everyMs?: number } = {}): (now: Date) => Promise<void> {
  if (opts.workerInline) return async () => undefined;
  const everyMs = opts.everyMs ?? APP_HEALTH_CHECK_EVERY_MS;
  let lastRun = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;
  return async (now) => {
    if (running || Date.now() - lastRun < everyMs) return;
    lastRun = Date.now();
    running = checkOperationalHealth(db, now, { workerInline: false, emailCritical: opts.emailCritical })
      .then(() => undefined)
      .catch((err) => console.warn(`[healthz] the operational health check failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { running = null; });
    await running;
  };
}

/**
 * The two things that go wrong quietly (audit remediation H3): a worker that stopped polling, and a queue whose
 * oldest due job has waited too long. Each raises one alert for as long as it lasts (an acknowledged one still stands;
 * at most one an hour), and its end resolves it, so the next outage is a new alert (Wave S2 F1). A critical alert is
 * emailed straight after it is committed when `emailCritical` is given. Safe to call from anywhere and as often as
 * wanted: the app's /healthz (appHealthWatch), the worker's hourly `ops.health_check` job and the daily sweep all do.
 */
export async function checkOperationalHealth(db: Db, now: Date, opts: MaintenanceOptions = {}): Promise<{ workerStale: boolean; queueStale: boolean; raised: number }> {
  let raised = 0;
  let workerStale = false;
  if (!opts.workerInline) {
    const worker = await readWorkerHealth(db, now, HEARTBEAT_STALE_MS);
    workerStale = !worker?.healthy;
    if (!workerStale) await withPlatform(db, (tx) => resolveAlertsOfKind(tx, "worker.stale", { now, reason: "the background worker is polling again" }));
    if (workerStale) {
      const minutes = worker ? Math.round(worker.ageSeconds / 60) : null;
      const result = await withPlatform(db, (tx) => raiseAlertOnce(tx, {
        kind: "worker.stale",
        severity: "critical",
        title: "The background worker has stopped polling",
        body: `${worker ? `The last heartbeat was ${minutes} minute${minutes === 1 ? "" : "s"} ago (worker ${worker.workerId}).` : "No worker has ever written a heartbeat."} While the worker is down nothing queued runs: no email or text leaves, no application is processed, no reminder goes out. Check the Railway worker service (docs/runbooks/railway-worker.md, screen 4): its health check, its logs and whether it keeps restarting.`,
        details: { workerId: worker?.workerId ?? null, lastSeenAt: worker?.lastSeenAt ?? null, queueDepth: worker?.queueDepth ?? null, version: worker?.version ?? null },
      }, { withinMs: HEALTH_ALERT_WINDOW_MS, now }));
      if (result.created) {
        raised += 1;
        // the worker that runs the email job is the thing that is down: the email leaves from here, after the commit
        if (opts.emailCritical) {
          try {
            await opts.emailCritical(result.id);
          } catch (err) {
            console.warn(`[health] the critical alert could not be emailed now; the queued job will try: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }
  const queue = await queueSnapshot(db, now);
  const waitedMs = queue.oldestQueuedAt ? now.getTime() - Date.parse(queue.oldestQueuedAt) : 0;
  const queueStale = queue.queueDepth > 0 && waitedMs > QUEUE_STALE_MS;
  if (!queueStale) await withPlatform(db, (tx) => resolveAlertsOfKind(tx, "queue.stale", { now, reason: "the queue is being drained again" }));
  if (queueStale) {
    const minutes = Math.round(waitedMs / 60_000);
    const result = await withPlatform(db, (tx) => raiseAlertOnce(tx, {
      kind: "queue.stale",
      severity: "high",
      title: "Queued work is not being picked up",
      body: `${queue.queueDepth} job${queue.queueDepth === 1 ? " is" : "s are"} due and waiting; the oldest has waited ${minutes} minutes. Either no worker is running or it cannot keep up. Check the worker's health and logs (docs/runbooks/railway-worker.md) and the Queue tab of the console.`,
      details: { queueDepth: queue.queueDepth, oldestQueuedAt: queue.oldestQueuedAt, waitedMinutes: minutes },
    }, { withinMs: HEALTH_ALERT_WINDOW_MS, now }));
    if (result.created) raised += 1;
  }
  return { workerStale, queueStale, raised };
}

import { and, inArray, lt } from "drizzle-orm";
import { sweepStaleSending } from "@ros/agents";
import { raiseAlertOnce } from "@ros/core";
import { cspReports, jobs, magicLinks, sessions, webhookReceipts, withPlatform, workerHeartbeats, type Db } from "@ros/db";
import { HEARTBEAT_STALE_MS, queueSnapshot, readWorkerHealth } from "./worker-health";

/**
 * The daily sweep of operational rows that have served their purpose. Nothing here is candidate data: that follows the
 * privacy-request process and the anonymization rules (docs/09). The periods are conservative and named in one place.
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

export type MaintenanceReport = { doneJobs: number; failedJobs: number; sessions: number; magicLinks: number; webhookReceipts: number; cspReports: number; staleHeartbeats: number; interruptedSends: number; healthAlerts: number };

export type MaintenanceOptions = {
  /** True when the queue runs inside the app process (development): there is no separate worker to watch. */
  workerInline?: boolean;
};

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
  const health = await checkOperationalHealth(db, now, opts);
  const report = { ...swept, interruptedSends, healthAlerts: health.raised };
  if (Object.values(report).some((n) => n > 0)) console.log(`[maintenance] ${Object.entries(report).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return report;
}

/**
 * The two things that go wrong quietly (audit remediation H3): a worker that stopped polling, and a queue whose
 * oldest due job has waited too long. Each raises one alert, at most once an hour, and never while a person already
 * has one open. Safe to call from anywhere and as often as wanted.
 */
export async function checkOperationalHealth(db: Db, now: Date, opts: MaintenanceOptions = {}): Promise<{ workerStale: boolean; queueStale: boolean; raised: number }> {
  let raised = 0;
  let workerStale = false;
  if (!opts.workerInline) {
    const worker = await readWorkerHealth(db, now, HEARTBEAT_STALE_MS);
    workerStale = !worker || !worker.healthy;
    if (workerStale) {
      const minutes = worker ? Math.round(worker.ageSeconds / 60) : null;
      const result = await withPlatform(db, (tx) => raiseAlertOnce(tx, {
        kind: "worker.stale",
        severity: "critical",
        title: "The background worker has stopped polling",
        body: `${worker ? `The last heartbeat was ${minutes} minute${minutes === 1 ? "" : "s"} ago (worker ${worker.workerId}).` : "No worker has ever written a heartbeat."} While the worker is down nothing queued runs: no email or text leaves, no application is processed, no reminder goes out. Check the Railway worker service (docs/runbooks/railway-worker.md, screen 4): its health check, its logs and whether it keeps restarting.`,
        details: { workerId: worker?.workerId ?? null, lastSeenAt: worker?.lastSeenAt ?? null, queueDepth: worker?.queueDepth ?? null, version: worker?.version ?? null },
      }, { withinMs: HEALTH_ALERT_WINDOW_MS, now }));
      if (result.created) raised += 1;
    }
  }
  const queue = await queueSnapshot(db, now);
  const waitedMs = queue.oldestQueuedAt ? now.getTime() - Date.parse(queue.oldestQueuedAt) : 0;
  const queueStale = queue.queueDepth > 0 && waitedMs > QUEUE_STALE_MS;
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

import { and, inArray, lt } from "drizzle-orm";
import { sweepStaleSending } from "@ros/agents";
import { cspReports, jobs, magicLinks, sessions, webhookReceipts, withPlatform, type Db } from "@ros/db";

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
} as const;

export type MaintenanceReport = { doneJobs: number; failedJobs: number; sessions: number; magicLinks: number; webhookReceipts: number; cspReports: number; interruptedSends: number };

export async function runMaintenance(db: Db, now: Date): Promise<MaintenanceReport> {
  const before = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const swept = await withPlatform(db, async (tx) => {
    const doneJobs = await tx.delete(jobs).where(and(inArray(jobs.status, ["done"]), lt(jobs.createdAt, before(RETENTION_DAYS.doneJobs)))).returning({ id: jobs.id });
    const failedJobs = await tx.delete(jobs).where(and(inArray(jobs.status, ["failed"]), lt(jobs.createdAt, before(RETENTION_DAYS.failedJobs)))).returning({ id: jobs.id });
    const expiredSessions = await tx.delete(sessions).where(lt(sessions.expiresAt, before(RETENTION_DAYS.expiredSessions))).returning({ id: sessions.id });
    const expiredLinks = await tx.delete(magicLinks).where(lt(magicLinks.expiresAt, before(RETENTION_DAYS.expiredMagicLinks))).returning({ id: magicLinks.id });
    const receipts = await tx.delete(webhookReceipts).where(lt(webhookReceipts.receivedAt, before(RETENTION_DAYS.webhookReceipts))).returning({ id: webhookReceipts.id });
    const reports = await tx.delete(cspReports).where(lt(cspReports.lastAt, before(RETENTION_DAYS.cspReports))).returning({ id: cspReports.id });
    return { doneJobs: doneJobs.length, failedJobs: failedJobs.length, sessions: expiredSessions.length, magicLinks: expiredLinks.length, webhookReceipts: receipts.length, cspReports: reports.length };
  });
  const interruptedSends = await sweepStaleSending(db, now);
  const report = { ...swept, interruptedSends };
  if (Object.values(report).some((n) => n > 0)) console.log(`[maintenance] ${Object.entries(report).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return report;
}

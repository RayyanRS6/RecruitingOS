import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { adminAlerts, cspReports, jobs, magicLinks, sessions, users, webhookReceipts, workerHeartbeats } from "@ros/db";
import { createContainer, type Container } from "./container";
import { HEALTH_ALERT_WINDOW_MS, MAINTENANCE_JOB_KIND, QUEUE_STALE_MS, RETENTION_DAYS, checkOperationalHealth, runMaintenance } from "./maintenance";
import { DAILY_MS, recurring } from "./recurring-jobs";
import { HEARTBEAT_STALE_MS, writeHeartbeat } from "./worker-health";

/** The daily sweep removes only what has served its purpose, and a recurring job is armed once however many processes boot. */
describe("maintenance", () => {
  let container: Container;
  const DAY = 86_400_000;
  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
  });
  afterAll(async () => {
    await container.close();
  });

  it("removes finished jobs, expired sessions and links, old receipts and reports, and keeps everything current", async () => {
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString();
    const [user] = await container.db.insert(users).values({ email: "sweep@example.com", name: "Sweep" }).returning({ id: users.id });
    await container.db.insert(jobs).values([
      { kind: "workflow.tick", status: "done", createdAt: at(RETENTION_DAYS.doneJobs + 1) },
      { kind: "workflow.tick", status: "done", createdAt: at(1) },
      { kind: "workflow.tick", status: "failed", createdAt: at(RETENTION_DAYS.failedJobs + 1), lastError: "old" },
      { kind: "workflow.tick", status: "failed", createdAt: at(RETENTION_DAYS.doneJobs + 1), lastError: "recent enough to read" },
      { kind: "workflow.tick", status: "queued", createdAt: at(30) },
    ]);
    await container.db.insert(sessions).values([
      { userId: user.id, tokenHash: "expired-long-ago", expiresAt: at(3) },
      { userId: user.id, tokenHash: "still-valid", expiresAt: new Date(now.getTime() + 10 * DAY).toISOString() },
    ]);
    await container.db.insert(magicLinks).values([
      { email: "sweep@example.com", tokenHash: "old-link", expiresAt: at(2) },
      { email: "sweep@example.com", tokenHash: "fresh-link", expiresAt: new Date(now.getTime() + DAY).toISOString() },
    ]);
    await container.db.insert(webhookReceipts).values([
      { provider: "postmark", kind: "bounce", externalId: "old", receivedAt: at(RETENTION_DAYS.webhookReceipts + 1) },
      { provider: "postmark", kind: "bounce", externalId: "new", receivedAt: at(1) },
    ]);
    await container.db.insert(cspReports).values([
      { mode: "report_only", surface: "candidate", documentPath: "/c/x", violatedDirective: "script-src", firstAt: at(200), lastAt: at(RETENTION_DAYS.cspReports + 1) },
      { mode: "report_only", surface: "candidate", documentPath: "/c/y", violatedDirective: "script-src", firstAt: at(2), lastAt: at(1) },
    ]);
    await container.db.insert(workerHeartbeats).values([
      { workerId: "worker-old", lastSeenAt: at(RETENTION_DAYS.workerHeartbeats + 1), lastPollAt: at(RETENTION_DAYS.workerHeartbeats + 1) },
      { workerId: "worker-current", lastSeenAt: at(0), lastPollAt: at(0) },
    ]);

    const report = await runMaintenance(container.db, now, { workerInline: true });
    expect(report).toMatchObject({ doneJobs: 1, failedJobs: 1, sessions: 1, magicLinks: 1, webhookReceipts: 1, cspReports: 1, staleHeartbeats: 1, interruptedSends: 0, healthAlerts: 0 });
    expect((await container.db.select().from(workerHeartbeats)).map((h) => h.workerId)).toEqual(["worker-current"]);
    await container.db.delete(workerHeartbeats);

    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "workflow.tick"))).map((j) => j.status).sort()).toEqual(["done", "failed", "queued"]);
    expect((await container.db.select().from(sessions).where(eq(sessions.userId, user.id))).map((s) => s.tokenHash)).toEqual(["still-valid"]);
    expect((await container.db.select().from(magicLinks).where(eq(magicLinks.email, "sweep@example.com"))).map((l) => l.tokenHash)).toEqual(["fresh-link"]);
    expect((await container.db.select().from(webhookReceipts)).map((r) => r.externalId)).toEqual(["new"]);
    expect((await container.db.select().from(cspReports)).map((r) => r.documentPath)).toEqual(["/c/y"]);
  });

  it("a recurring job is armed once, re-armed by its own run, and never doubled by a second boot", async () => {
    const waiting = () => container.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.kind, MAINTENANCE_JOB_KIND), eq(jobs.status, "queued"), isNull(jobs.lockedAt)));
    expect(await waiting()).toHaveLength(0); // tests arm it explicitly
    expect(await container.engine.ensureQueued(container.db, { kind: MAINTENANCE_JOB_KIND })).toBe(true);
    expect(await container.engine.ensureQueued(container.db, { kind: MAINTENANCE_JOB_KIND })).toBe(false); // a second process booting
    expect(await waiting()).toHaveLength(1);
    await container.drain(); // the run sweeps and arms tomorrow's
    const after = await container.db.select().from(jobs).where(eq(jobs.kind, MAINTENANCE_JOB_KIND));
    expect(after.map((j) => j.status).sort()).toEqual(["done", "queued"]);
    const next = after.find((j) => j.status === "queued")!;
    expect(Date.parse(next.runAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
    await expect(container.engine.ensureQueued(container.db, { kind: "no.such.job" })).rejects.toThrow(/no handler/);
  });

  it("a worker that stopped polling raises one alert an hour, and a fresh heartbeat raises none", async () => {
    const now = new Date();
    const alerts = () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "worker.stale"));
    // no heartbeat was ever written
    const first = await checkOperationalHealth(container.db, now, { workerInline: false });
    expect(first).toMatchObject({ workerStale: true, raised: 1 });
    expect((await alerts())[0]).toMatchObject({ severity: "critical", status: "open" });
    expect((await alerts())[0].body).toContain("No worker has ever written a heartbeat");
    // checked again: the open alert stands, nothing new
    expect((await checkOperationalHealth(container.db, now, { workerInline: false })).raised).toBe(0);
    // resolved by a person, checked again within the hour: still nothing new
    await container.db.update(adminAlerts).set({ status: "resolved" }).where(eq(adminAlerts.kind, "worker.stale"));
    expect((await checkOperationalHealth(container.db, new Date(now.getTime() + 30 * 60_000), { workerInline: false })).raised).toBe(0);
    // an hour on, still stale: a new alert
    expect((await checkOperationalHealth(container.db, new Date(now.getTime() + HEALTH_ALERT_WINDOW_MS + 60_000), { workerInline: false })).raised).toBe(1);
    expect(await alerts()).toHaveLength(2);
    await container.db.update(adminAlerts).set({ status: "resolved" }).where(eq(adminAlerts.kind, "worker.stale"));
    // a worker that polled a moment ago is healthy
    const later = new Date(now.getTime() + 3 * 3600_000);
    await writeHeartbeat(container.db, { workerId: "railway-1", now: later, queueDepth: 0, oldestQueuedAt: null, version: "v1" });
    expect(await checkOperationalHealth(container.db, later, { workerInline: false })).toMatchObject({ workerStale: false, raised: 0 });
    // ten minutes without a heartbeat and it is stale again, with the last heartbeat named
    const stale = await checkOperationalHealth(container.db, new Date(later.getTime() + HEARTBEAT_STALE_MS + 1000), { workerInline: false });
    expect(stale.workerStale).toBe(true);
    const newest = (await alerts()).find((a) => a.status === "open")!;
    expect(newest.details).toMatchObject({ workerId: "railway-1", version: "v1" });
    expect(newest.body).toContain("10 minutes ago");
    // the inline queue has no separate worker to watch
    expect((await checkOperationalHealth(container.db, now, { workerInline: true })).workerStale).toBe(false);
    await container.db.update(adminAlerts).set({ status: "resolved" }).where(eq(adminAlerts.kind, "worker.stale"));
    await container.db.delete(workerHeartbeats);
  });

  it("a due job that has waited over thirty minutes raises one alert until the queue drains", async () => {
    const now = new Date();
    await container.db.insert(jobs).values({ kind: "workflow.tick", status: "queued", runAt: new Date(now.getTime() - QUEUE_STALE_MS - 60_000).toISOString() });
    const first = await checkOperationalHealth(container.db, now, { workerInline: true });
    expect(first).toMatchObject({ queueStale: true, raised: 1 });
    const [alert] = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "queue.stale"));
    expect(alert.details).toMatchObject({ queueDepth: 1, waitedMinutes: 31 });
    expect(alert.body).toContain("1 job is due and waiting");
    expect((await checkOperationalHealth(container.db, now, { workerInline: true })).raised).toBe(0);
    await container.drain(); // the worker catches up
    expect((await checkOperationalHealth(container.db, now, { workerInline: true })).queueStale).toBe(false);
    await container.db.update(adminAlerts).set({ status: "resolved" }).where(eq(adminAlerts.kind, "queue.stale"));
  });

  it("a recurring job arms its next run even when the run fails, and the failure is not silent", async () => {
    const kind = "test.recurring_failure";
    let calls = 0;
    container.engine.registerJob(kind, recurring(container.engine, container.db, kind, DAILY_MS, async () => {
      calls += 1;
      throw new Error("the sweep fell over");
    }));
    // one attempt only, so the first failure is final: the chain must survive it
    expect(await container.engine.ensureQueued(container.db, { kind, maxAttempts: 1 })).toBe(true);
    await container.drain();
    expect(calls).toBe(1);
    const rows = await container.db.select().from(jobs).where(eq(jobs.kind, kind));
    expect(rows.map((j) => j.status).sort()).toEqual(["failed", "queued"]);
    expect(rows.find((j) => j.status === "failed")!.lastError).toBe("the sweep fell over");
    const next = rows.find((j) => j.status === "queued")!;
    expect(Date.parse(next.runAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
    // and a person hears about the failed run
    const [alert] = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "job.failed"));
    expect(alert).toBeTruthy();
    expect(alert.details).toMatchObject({ kind, attempts: 1, lastError: "the sweep fell over" });
    expect(alert.title).toContain(kind);
  });

  it("when the run and the re-arm both fail, the run's own error is the one that is recorded", async () => {
    const kind = "test.recurring_double_failure";
    const gone = { ensureQueued: async () => { throw new Error("the database went away"); } } as unknown as Container["engine"];
    const ctx = { attempt: 1, maxAttempts: 1, now: new Date() };
    const handler = recurring(gone, container.db, kind, DAILY_MS, async () => { throw new Error("the sweep fell over"); });
    await expect(handler({}, ctx)).rejects.toThrow("the sweep fell over");
    // a run that succeeded still surfaces a failed re-arm, since nothing else would
    const fine = recurring(gone, container.db, kind, DAILY_MS, async () => undefined);
    await expect(fine({}, ctx)).rejects.toThrow("the database went away");
  });
});

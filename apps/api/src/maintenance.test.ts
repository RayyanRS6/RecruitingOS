import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { cspReports, jobs, magicLinks, sessions, users, webhookReceipts } from "@ros/db";
import { createContainer, type Container } from "./container";
import { MAINTENANCE_JOB_KIND, RETENTION_DAYS, runMaintenance } from "./maintenance";

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

    const report = await runMaintenance(container.db, now);
    expect(report).toMatchObject({ doneJobs: 1, failedJobs: 1, sessions: 1, magicLinks: 1, webhookReceipts: 1, cspReports: 1, interruptedSends: 0 });

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
});

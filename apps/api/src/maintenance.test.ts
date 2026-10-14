import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { SYSTEM_ACTOR } from "@ros/core";
import { adminAlerts, applications, candidates, companies, cspReports, events, inboundEmails, jobs, magicLinks, randomToken, roles, sessions, users, webhookReceipts, workerHeartbeats, workflowRuns, workflowSteps, withTenant } from "@ros/db";
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
    expect(report).toMatchObject({ doneJobs: 1, failedJobs: 1, sessions: 1, magicLinks: 1, webhookReceipts: 1, cspReports: 1, staleHeartbeats: 1, interruptedSends: 0, anonymizedAssessments: 0, anonymizedAiRuns: 0, anonymizedWorkflowRuns: 0, anonymizedWorkflowSteps: 0, anonymizedWorkflowEvents: 0, cancelledWorkflowRuns: 0, healthAlerts: 0 });
    expect((await container.db.select().from(workerHeartbeats)).map((h) => h.workerId)).toEqual(["worker-current"]);
    await container.db.delete(workerHeartbeats);

    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "workflow.tick"))).map((j) => j.status).sort()).toEqual(["done", "failed", "queued"]);
    expect((await container.db.select().from(sessions).where(eq(sessions.userId, user.id))).map((s) => s.tokenHash)).toEqual(["still-valid"]);
    expect((await container.db.select().from(magicLinks).where(eq(magicLinks.email, "sweep@example.com"))).map((l) => l.tokenHash)).toEqual(["fresh-link"]);
    expect((await container.db.select().from(webhookReceipts)).map((r) => r.externalId)).toEqual(["new"]);
    expect((await container.db.select().from(cspReports)).map((r) => r.documentPath)).toEqual(["/c/y"]);
  });

  it("an emailed-in application that failed a month ago loses its stored file and its words; a recent one keeps them (Wave S5 review)", async () => {
    const now = new Date();
    const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY).toISOString();
    const storage = container.integrations.storage;
    await storage.put("inbound/test/old.txt", new TextEncoder().encode("Old résumé"), "text/plain");
    await storage.put("inbound/test/new.txt", new TextEncoder().encode("New résumé"), "text/plain");
    const [old] = await container.db.insert(inboundEmails).values({ toAddress: "jobs@in.test", fromAddress: "ezra@example.com", subject: "Application", rawStorageKey: "inbound/test/old.txt", parsed: { text: "Ezra applied" }, status: "error", createdAt: at(RETENTION_DAYS.failedInboundEmails + 1) }).returning({ id: inboundEmails.id });
    const [recent] = await container.db.insert(inboundEmails).values({ toAddress: "jobs@in.test", fromAddress: "zoe@example.com", subject: "Application", rawStorageKey: "inbound/test/new.txt", parsed: { text: "Zoe applied" }, status: "error", createdAt: at(2) }).returning({ id: inboundEmails.id });
    // without a way to remove the file, nothing is cleared (no file is ever left without its record)
    expect((await runMaintenance(container.db, now, { workerInline: true })).purgedInboundEmails).toBe(0);
    const report = await runMaintenance(container.db, now, { workerInline: true, deleteStored: (key) => storage.delete(key) });
    expect(report.purgedInboundEmails).toBe(1);
    const [gone] = await container.db.select().from(inboundEmails).where(eq(inboundEmails.id, old.id));
    expect(gone).toMatchObject({ rawStorageKey: null, parsed: {}, fromAddress: "[removed]", subject: "[removed]", status: "purged" });
    expect(await storage.get("inbound/test/old.txt")).toBeNull();
    expect((await container.db.select().from(inboundEmails).where(eq(inboundEmails.id, recent.id)))[0]).toMatchObject({ rawStorageKey: "inbound/test/new.txt", status: "error" });
    expect(await storage.get("inbound/test/new.txt")).not.toBeNull();
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

  it("an acknowledged stale worker raises nothing more while it stays down; once it polls again the alert resolves, and the next outage is a new one", async () => {
    const now = new Date(Date.now() + 10 * 3600_000);
    const alerts = () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "worker.stale"));
    await container.db.delete(workerHeartbeats);
    expect((await checkOperationalHealth(container.db, now, { workerInline: false })).raised).toBe(1);
    const [first] = (await alerts()).filter((a) => a.status === "open");
    await container.db.update(adminAlerts).set({ status: "acknowledged", acknowledgedAt: now.toISOString() }).where(eq(adminAlerts.id, first.id));
    // still down at the next hourly checks: nothing new while the acknowledgement stands
    for (const hours of [1, 2, 5]) expect((await checkOperationalHealth(container.db, new Date(now.getTime() + hours * 3600_000), { workerInline: false })).raised).toBe(0);
    // it polls again: the alert is resolved by the check, on the record
    const back = new Date(now.getTime() + 6 * 3600_000);
    await writeHeartbeat(container.db, { workerId: "railway-2", now: back, queueDepth: 0, oldestQueuedAt: null, version: "v2" });
    await checkOperationalHealth(container.db, back, { workerInline: false });
    expect((await alerts()).find((a) => a.id === first.id)?.status).toBe("resolved");
    // a new outage later: a new alert
    const down = new Date(back.getTime() + 2 * 3600_000);
    expect((await checkOperationalHealth(container.db, down, { workerInline: false })).raised).toBe(1);
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

  it("finishes a deletion made before the workflow clean-up: the run state and step records about the person lose every word, a run still going is cancelled first, and a second pass writes nothing", async () => {
    const now = new Date();
    const actor = { kind: "system" as const, id: "maintenance.test" };
    const [company] = await container.db.insert(companies).values({ name: "Harbor Dental", slug: "harbor-dental-maintenance", vertical: "dental", sizeBand: "20-49" }).returning({ id: companies.id });
    const companyId = company.id;
    // one person deleted at their request (their record already anonymized), and someone else who was not
    const { gone, kept } = await withTenant(container.db, companyId, async (tx) => {
      const [role] = await tx.insert(roles).values({ companyId, title: "Hygienist", status: "open", createdBy: actor }).returning({ id: roles.id });
      const person = async (first: string, last: string, email: string | null, anonymizedAt: string | null) => {
        const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: last, email, firstSource: "direct", anonymizedAt }).returning({ id: candidates.id });
        const [a] = await tx.insert(applications).values({ companyId, roleId: role.id, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "withdrawn", statusToken: randomToken(16) }).returning({ id: applications.id });
        return { candidateId: cand.id, applicationId: a.id, roleId: role.id };
      };
      return { gone: await person("Removed", "anon-12345678", null, now.toISOString()), kept: await person("Omar", "Haddad", "omar.haddad@example.com", null) };
    });
    // the engine's copies still hold her words: a finished intake run with her résumé reading in its steps and a model
    // error quoting her, and a scheduling run still waiting with a note to her and her reply in what woke it
    const heldAt = new Date(now.getTime() - 3 * 86_400_000).toISOString();
    const interviewId = randomUUID();
    const [intake, scheduling, other] = await container.db.insert(workflowRuns).values([
      { companyId, workflowKey: "application_intake", subject: { type: "application", id: gone.applicationId }, status: "completed", currentStep: "ready", state: { applicationId: gone.applicationId, roleId: gone.roleId, remindersSent: 1, heldAt, candidateEmail: "lena.ortiz@example.com", resumeText: "Lena Ortiz, RDH. Six years at Bright Smiles Dental. (512) 555-0142" }, completedAt: now.toISOString() },
      { companyId, workflowKey: "schedule_interview", subject: { type: "interview", id: interviewId }, status: "waiting", currentStep: "await_pick", state: { interviewId, applicationId: gone.applicationId, roleId: gone.roleId, roundKey: "first", attempt: 1, invitationNote: { text: "Looking forward to meeting you, Lena Ortiz", aiHelped: false, senderName: "Dana" } }, wait: { kind: "event", eventTypes: ["interview.slot_selected"], subjectId: interviewId, reason: "waiting for Lena Ortiz to pick a time" } },
      { companyId, workflowKey: "application_intake", subject: { type: "application", id: kept.applicationId }, status: "completed", currentStep: "ready", state: { applicationId: kept.applicationId, roleId: kept.roleId, note: "Omar Haddad called back" }, completedAt: now.toISOString() },
    ]).returning();
    await container.db.insert(workflowSteps).values([
      { runId: intake.id, companyId, stepKey: "acknowledge", seq: 1, status: "ok", input: { wake: null }, output: { kind: "next", step: "validate" }, finishedAt: now.toISOString() },
      { runId: intake.id, companyId, stepKey: "extract", seq: 2, status: "error", input: {}, output: {}, attempts: 1, error: "the model returned invalid JSON near 'Lena Ortiz, (512) 555-0142'", finishedAt: now.toISOString() },
      { runId: intake.id, companyId, stepKey: "extract", seq: 3, status: "ok", input: { wake: null }, output: { kind: "next", step: "eligibility", reading: { fullName: "Lena Ortiz", email: "lena.ortiz@example.com", positions: ["Bright Smiles Dental"], yearsOfExperienceEstimate: 6 } }, finishedAt: now.toISOString() },
      { runId: scheduling.id, companyId, stepKey: "offer", seq: 1, status: "ok", input: { wake: { kind: "event", key: `${interviewId}:interview.reply`, payload: { message: "Lena here, call me on (512) 555-0142" } } }, output: { kind: "wait", wait: { kind: "event", eventTypes: ["interview.slot_selected"], reason: "waiting for Lena Ortiz to pick a time" } }, finishedAt: now.toISOString() },
      { runId: other.id, companyId, stepKey: "acknowledge", seq: 1, status: "ok", input: { wake: null }, output: { kind: "next", step: "validate", note: "Omar Haddad" }, finishedAt: now.toISOString() },
    ]);
    // the engine wrote the model error's words twice more: in the run's events and on the queued job
    const quoted = "the model returned invalid JSON near 'Lena Ortiz, (512) 555-0142'";
    const runEvent = (runId: string, type: string, error: string) => ({ companyId, type, actor: SYSTEM_ACTOR, subjectType: "workflow_run", subjectId: runId, correlationId: runId, payload: { step: "extract", attempt: 1, error } });
    await container.db.insert(events).values([runEvent(intake.id, "workflow.retried", quoted), runEvent(intake.id, "workflow.failed", quoted), runEvent(other.id, "workflow.retried", "invalid JSON near 'Omar Haddad'")]);
    await container.db.insert(jobs).values([{ kind: "workflow.tick", status: "failed", payload: { runId: intake.id }, lastError: quoted }, { kind: "workflow.tick", status: "failed", payload: { runId: other.id }, lastError: "invalid JSON near 'Omar Haddad'" }]);
    const stepsOf = (runIds: string[]) => container.db.select().from(workflowSteps).where(inArray(workflowSteps.runId, runIds));
    const runsOf = (ids: string[]) => container.db.select().from(workflowRuns).where(inArray(workflowRuns.id, ids));
    const stepsBefore = await stepsOf([intake.id, scheduling.id]);
    const [otherBefore] = await runsOf([other.id]);
    const otherStepsBefore = await stepsOf([other.id]);

    // the engine's own cancel path, as the worker wires it
    const report = await runMaintenance(container.db, now, { workerInline: true, cancelRun: (q, runId, reason) => container.engine.cancel(q, runId, SYSTEM_ACTOR, reason) });
    expect(report).toMatchObject({ cancelledWorkflowRuns: 1, anonymizedWorkflowRuns: 2, anonymizedWorkflowSteps: 3, anonymizedWorkflowEvents: 3 });
    // the copies of the error in the run's events and on its job are gone; someone else's stay
    const runEvents = await container.db.select().from(events).where(and(eq(events.subjectType, "workflow_run"), inArray(events.subjectId, [intake.id, other.id])));
    expect(runEvents.filter((e) => e.subjectId === intake.id && e.payload.error !== undefined).map((e) => [e.type, e.payload])).toEqual([
      ["workflow.retried", { step: "extract", attempt: 1, error: "[removed at the candidate's request]" }],
      ["workflow.failed", { step: "extract", attempt: 1, error: "[removed at the candidate's request]" }],
    ]);
    expect(runEvents.find((e) => e.subjectId === other.id)!.payload.error).toBe("invalid JSON near 'Omar Haddad'");
    const runJobs = await container.db.select().from(jobs).where(eq(jobs.kind, "workflow.tick"));
    expect(runJobs.find((j) => (j.payload as { runId?: string }).runId === intake.id)!.lastError).toBe("[removed at the candidate's request]");
    expect(runJobs.find((j) => (j.payload as { runId?: string }).runId === other.id)!.lastError).toBe("invalid JSON near 'Omar Haddad'");

    const words = /Lena|Ortiz|lena\.ortiz|555-0142|Bright Smiles/;
    const runsAfter = await runsOf([intake.id, scheduling.id]);
    const stepsAfter = await stepsOf([intake.id, scheduling.id]);
    expect(JSON.stringify(runsAfter)).not.toMatch(words);
    expect(JSON.stringify(stepsAfter)).not.toMatch(words);
    // the run still going was cancelled through the engine before anything was scrubbed
    const sched = runsAfter.find((r) => r.id === scheduling.id)!;
    expect(sched).toMatchObject({ status: "cancelled", wait: null, lastError: "the candidate asked for their information to be deleted", currentStep: "await_pick", workflowKey: "schedule_interview" });
    expect(sched.state).toEqual({ interviewId, applicationId: gone.applicationId, roleId: gone.roleId, roundKey: "first", attempt: 1 });
    expect((await container.db.select().from(events).where(and(eq(events.type, "workflow.cancelled"), eq(events.subjectId, scheduling.id)))).length).toBe(1);
    // ids, status, timings, step names and codes stay
    const done = runsAfter.find((r) => r.id === intake.id)!;
    expect(done).toMatchObject({ status: "completed", currentStep: "ready", startedAt: intake.startedAt, completedAt: intake.completedAt, subject: { type: "application", id: gone.applicationId } });
    expect(done.state).toEqual({ applicationId: gone.applicationId, roleId: gone.roleId, remindersSent: 1, heldAt, candidateEmail: "[removed at the candidate's request]" });
    for (const s of stepsAfter) {
      const was = stepsBefore.find((b) => b.id === s.id)!;
      expect({ stepKey: s.stepKey, seq: s.seq, status: s.status, attempts: s.attempts, startedAt: s.startedAt, finishedAt: s.finishedAt }).toEqual({ stepKey: was.stepKey, seq: was.seq, status: was.status, attempts: was.attempts, startedAt: was.startedAt, finishedAt: was.finishedAt });
    }
    expect(stepsAfter.find((s) => s.seq === 1 && s.runId === intake.id)!.output).toEqual({ kind: "next", step: "validate" });
    expect(stepsAfter.find((s) => s.seq === 2)!.error).toBe("[removed at the candidate's request]");
    expect(stepsAfter.find((s) => s.seq === 3)!.output).toEqual({ kind: "next", step: "eligibility", reading: { positions: ["[removed at the candidate's request]"], yearsOfExperienceEstimate: 6 } });
    // someone else's run is untouched
    expect(await runsOf([other.id])).toEqual([otherBefore]);
    expect(await stepsOf([other.id])).toEqual(otherStepsBefore);

    // a second pass finds nothing left to do
    expect(await runMaintenance(container.db, now, { workerInline: true })).toMatchObject({ cancelledWorkflowRuns: 0, anonymizedWorkflowRuns: 0, anonymizedWorkflowSteps: 0, anonymizedWorkflowEvents: 0 });
  });
});

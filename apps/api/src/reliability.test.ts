import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SEND_MAX_ATTEMPTS } from "@ros/agents";
import { ESCALATION_OVERDUE_ALERT_KIND, ESCALATION_QUEUE_EMAIL_JOB_KIND, createEscalation, raisedWithoutAPerson, setEscalationQueueEmails } from "@ros/core";
import { adminAlerts, communications, companies, jobs, recruiterEscalations, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { AI_HOLD_CHECK_EVERY_MS, AI_HOLD_CHECK_JOB_KIND, AI_HOLD_KEY, AI_OUTAGE_ALERT_KIND, HELD_RELEASE_SPACING_MS, PROVIDER_OUTAGE_PATIENCE_MS, WorkflowEngine, isProviderOutage, jobRetryDelayMs, outageAttempts, providerProblem, retryDelayMs } from "@ros/workflows";
import { createContainer, type Container } from "./container";
import { runHourlyChecks } from "./maintenance";
import { sendToIts } from "./services/escalation-queue";

/**
 * Wave S5 C2, reliability and ITS operations: provider outages delay work instead of failing it for good, a slow step
 * keeps its lease, interrupted sends and late recruiter requests are found within the hour, and every request (the
 * system's own too) and every direct email reaches the ITS queue mailbox through the outbox, where a failure is seen.
 */
const ENV = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", ITS_QUEUE_EMAIL: "queue@its.test" };
const sum = (n: number, delay: (i: number) => number) => Array.from({ length: n }, (_, i) => delay(i + 1)).reduce((a, b) => a + b, 0);

describe("the retry schedules outlast an hour's outage", () => {
  it("a workflow step waits at least an hour of tries before it is held; a message at least an hour before it fails", () => {
    const tries = outageAttempts();
    expect(sum(tries - 1, retryDelayMs)).toBeGreaterThanOrEqual(PROVIDER_OUTAGE_PATIENCE_MS);
    expect(sum(tries - 2, retryDelayMs)).toBeLessThan(PROVIDER_OUTAGE_PATIENCE_MS); // and not much longer
    expect(sum(SEND_MAX_ATTEMPTS - 1, jobRetryDelayMs)).toBeGreaterThanOrEqual(60 * 60_000);
    expect(sum(SEND_MAX_ATTEMPTS - 2, jobRetryDelayMs)).toBeLessThan(60 * 60_000);
    // the first tries are as quick as before
    expect([1, 2, 3].map(jobRetryDelayMs)).toEqual([2000, 4000, 8000]);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([2000, 4000, 8000]);
  });

  it("only a provider that did not answer counts as an outage", () => {
    expect(isProviderOutage("provider threw: fake provider outage")).toBe(true);
    expect(isProviderOutage("provider error: 529 {\"type\":\"overloaded_error\"}")).toBe(true);
    expect(isProviderOutage("provider error: the model did not finish within 270 seconds, so the call was stopped")).toBe(true);
    expect(isProviderOutage("provider error: Connection error.")).toBe(true);
    expect(isProviderOutage("provider error: 429 rate limited")).toBe(true);
    expect(isProviderOutage("provider error: 400 prompt is too long")).toBe(false);
    // the whole account refused (a bad key, billing): held like an outage, with an alert that says to check the key or billing
    expect(providerProblem("provider error: 401 {\"type\":\"authentication_error\"}")).toBe("account");
    expect(providerProblem("provider error: 403 permission denied")).toBe("account");
    expect(providerProblem("provider error: 400 Your credit balance is too low to access the Anthropic API")).toBe("account");
    expect(providerProblem("provider error: 503 service unavailable")).toBe("outage");
    // a local error the adapter wrapped is a bug, not an outage: it fails like any other error
    expect(isProviderOutage("provider error: Cannot read properties of undefined (reading 'type')")).toBe(false);
    expect(isProviderOutage("provider error: the request had no time left for the model, so it was not asked")).toBe(false);
    expect(isProviderOutage("provider refused: claude-x is not allowed")).toBe(false);
    expect(isProviderOutage("fake invalid output")).toBe(false);
    expect(isProviderOutage("application not found")).toBe(false);
  });
});

describe("an AI provider outage holds work and resumes it", () => {
  let container: Container;
  let companyId = "";
  const BASE = Date.now();
  let offset = 0;
  const setClock = (ms: number) => { offset = ms; (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset); };
  const provider = { down: true, calls: 0 };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: ENV });
    setClock(0);
    const [company] = await container.db.insert(companies).values({ name: "Harbor Dental", slug: "harbor-dental-outage", vertical: "dental", sizeBand: "20-49" }).returning({ id: companies.id });
    companyId = company.id;
    container.engine.register({
      key: "test.reads_with_ai",
      version: 1,
      initialStep: "read",
      maxAttempts: 4,
      steps: {
        read: {
          prepare: async () => {
            provider.calls += 1;
            return provider.down ? { error: "provider threw: fake provider outage" } : { ok: true };
          },
          run: async (_ctx, prepared) => ("error" in (prepared as object) ? { kind: "fail", error: (prepared as { error: string }).error, retryable: true } : { kind: "complete" }),
        },
      },
    });
  });
  afterAll(async () => {
    await container.close();
  });

  const start = (applicationId: string) => withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "test.reads_with_ai", companyId, subject: { type: "application", id: applicationId } }));
  const runOf = async (id: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
  /** Moves the clock past the next retry and runs what is due, `times` times. */
  async function advance(times: number, stepMs = 11 * 60_000) {
    for (let i = 0; i < times; i++) {
      setClock(offset + stepMs);
      await container.drain();
    }
  }

  it("retries for an hour, then holds every run with one alert and no recruiter request per application", async () => {
    const a = await start("0192a6b2-0000-7aaa-8bbb-00000000000a");
    const b = await start("0192a6b2-0000-7aaa-8bbb-00000000000b");
    await container.drain();
    expect((await runOf(a.runId)).status).toBe("waiting"); // the first retry is armed
    await advance(6);
    let run = await runOf(a.runId);
    expect(run.status).toBe("waiting");
    expect((run.wait as { reason?: string }).reason).toMatch(/^retry /); // still retrying past the old four tries
    expect(run.attempts).toBe(7);
    await advance(outageAttempts() - 7);
    for (const id of [a.runId, b.runId]) {
      run = await runOf(id);
      expect(run.status).toBe("waiting");
      expect((run.wait as { keys?: string[] }).keys).toEqual([AI_HOLD_KEY]);
      expect(run.attempts).toBe(outageAttempts());
    }
    expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, companyId))).toEqual([]);
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", status: "open" });
    expect(await container.db.select().from(jobs).where(and(eq(jobs.kind, AI_HOLD_CHECK_JOB_KIND), eq(jobs.status, "queued")))).toHaveLength(1);
  });

  it("while the provider stays out, the check tries one held run at a time and the rest stay held", async () => {
    const before = provider.calls;
    await advance(1, AI_HOLD_CHECK_EVERY_MS + 1000);
    expect(provider.calls - before).toBe(1);
    expect((await container.engine.heldRuns()).length).toBe(2);
    expect(await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND))).toHaveLength(1);
  });

  it("when the provider answers, every held run resumes by itself and the alert is resolved", async () => {
    provider.down = false;
    const held = await container.engine.heldRuns();
    await advance(1, AI_HOLD_CHECK_EVERY_MS + 1000);
    // the probe went through; the others are let go a few seconds apart, as ordinary timers with their tries back at zero
    const [probe, ...others] = held;
    expect((await runOf(probe!.id)).status).toBe("completed");
    for (const r of others) expect(await runOf(r.id)).toMatchObject({ status: "waiting", attempts: 0, wait: expect.objectContaining({ kind: "timer" }) });
    expect(await container.engine.heldRuns()).toEqual([]);
    await advance(1, held.length * HELD_RELEASE_SPACING_MS);
    for (const r of held) expect((await runOf(r.id)).status).toBe("completed");
    await advance(1, AI_HOLD_CHECK_EVERY_MS + 1000);
    const [alert] = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND));
    expect(alert.status).toBe("resolved");
    expect(await container.db.select().from(jobs).where(and(eq(jobs.kind, AI_HOLD_CHECK_JOB_KIND), eq(jobs.status, "queued")))).toHaveLength(0);
  });

  it("a held run that meets an ordinary failure when tried again gets its ordinary tries, not one past the outage count", async () => {
    const mode = { now: "down" as "down" | "late" | "ok" };
    container.engine.register({
      key: "test.late_text",
      version: 1,
      initialStep: "read",
      maxAttempts: 3,
      steps: {
        read: async () => (mode.now === "down" ? { kind: "fail", error: "provider error: Connection error.", retryable: true } : mode.now === "late" ? { kind: "fail", error: "the résumé text arrived after the read phase", retryable: true } : { kind: "complete" }),
      },
    });
    const { runId } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "test.late_text", companyId, subject: { type: "application", id: "0192a6b2-0000-7aaa-8bbb-00000000000d" } }));
    await container.drain();
    await advance(outageAttempts() - 1);
    expect((await runOf(runId)).wait).toMatchObject({ keys: [AI_HOLD_KEY] });
    mode.now = "late";
    await advance(1, AI_HOLD_CHECK_EVERY_MS + 1000);
    const run = await runOf(runId);
    expect(run.status).toBe("waiting");
    expect(run.attempts).toBe(1);
    expect((run.wait as { reason?: string }).reason).toMatch(/^retry 1\//);
    mode.now = "ok";
    await advance(1);
    expect((await runOf(runId)).status).toBe("completed");
  });

  it("a failure that is not an outage still stops after the definition's tries, with a recruiter request", async () => {
    container.engine.register({ key: "test.bad_reply", version: 1, initialStep: "read", maxAttempts: 2, steps: { read: async () => ({ kind: "fail", error: "no valid output: missing field", retryable: true }) } });
    const { runId } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "test.bad_reply", companyId, subject: { type: "application", id: "0192a6b2-0000-7aaa-8bbb-00000000000c" } }));
    await container.drain();
    await advance(1);
    const run = await runOf(runId);
    expect(run.status).toBe("failed");
    expect(run.attempts).toBe(2);
    expect(run.escalationId).not.toBeNull();
  });
});

describe("a slow job keeps its lease", () => {
  let container: Container;
  beforeAll(async () => {
    container = await createContainer({ memory: true, env: ENV });
  });
  afterAll(async () => {
    await container.close();
  });

  it("a second worker never claims a job the first is still running past the lease (audit row 113)", async () => {
    const services = {} as ConstructorParameters<typeof WorkflowEngine>[0]["services"];
    const first = new WorkflowEngine({ db: container.db, services }, { workerId: "worker-first", leaseMs: 3000 });
    const second = new WorkflowEngine({ db: container.db, services }, { workerId: "worker-second", leaseMs: 3000 });
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    for (const e of [first, second]) e.registerJob("test.slow_model_step", async () => { runs += 1; await gate; });
    await first.enqueue(container.db, { kind: "test.slow_model_step" });
    const running = first.runPending(1);
    await new Promise((r) => setTimeout(r, 4500)); // longer than the lease
    expect(await second.runPending(5)).toBe(0);
    release();
    expect(await running).toBe(1);
    expect(runs).toBe(1);
    const [job] = await container.db.select().from(jobs).where(eq(jobs.kind, "test.slow_model_step"));
    expect(job.status).toBe("done");
  }, 15_000);

  it("a job waiting its turn behind a slow one in the same batch keeps its lease too, and runs once", async () => {
    const services = {} as ConstructorParameters<typeof WorkflowEngine>[0]["services"];
    const first = new WorkflowEngine({ db: container.db, services }, { workerId: "batch-first", leaseMs: 3000 });
    const second = new WorkflowEngine({ db: container.db, services }, { workerId: "batch-second", leaseMs: 3000 });
    const ran: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    for (const e of [first, second]) {
      e.registerJob("test.batch_slow", async () => { ran.push("slow"); await gate; });
      e.registerJob("test.batch_next", async () => { ran.push("next"); });
    }
    await first.enqueue(container.db, { kind: "test.batch_slow", runAt: new Date(Date.now() - 2000) });
    await first.enqueue(container.db, { kind: "test.batch_next", runAt: new Date(Date.now() - 1000) });
    const running = first.runPending(2);
    await new Promise((r) => setTimeout(r, 4500)); // past the lease the second job got when it was claimed
    expect(await second.runPending(5)).toBe(0);
    release();
    expect(await running).toBe(2);
    expect(ran).toEqual(["slow", "next"]);
  }, 15_000);
});

describe("ITS hears about every request, within the hour", () => {
  let container: Container;
  let companyId = "";
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;
  const system = { kind: "system" as const, id: "workflow:test" };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: ENV });
    const [company] = await container.db.insert(companies).values({ name: "Harbor Dental", slug: "harbor-dental-its", vertical: "dental", sizeBand: "20-49" }).returning({ id: companies.id });
    companyId = company.id;
  });
  afterEach(() => {
    setEscalationQueueEmails(null);
  });
  afterAll(async () => {
    await container.close();
  });

  it("only requests no person raised are emailed from createEscalation", () => {
    expect(raisedWithoutAPerson({ requestedBy: system })).toBe(true);
    expect(raisedWithoutAPerson({ requestedBy: { kind: "candidate", id: "a" } })).toBe(true);
    expect(raisedWithoutAPerson({ requestedBy: { kind: "agent", id: "screening" } })).toBe(true);
    expect(raisedWithoutAPerson({ requestedBy: { kind: "user", id: "u" } })).toBe(false); // the route emails those
    expect(raisedWithoutAPerson({ requestedBy: { kind: "recruiter", id: "r" } })).toBe(false);
    expect(raisedWithoutAPerson({ requestedBy: system, postingId: "p" })).toBe(false); // ITS posting tasks
  });

  it("a request the system raises (or a candidate through the product) is emailed to the queue mailbox once, through the outbox", async () => {
    setEscalationQueueEmails(() => container.engine.clock());
    const before = mail().length;
    const esc = await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, kind: "candidate_issue", summaryOrigin: "candidate", question: "Nia Brooks asked for a person.", requestedBy: { kind: "candidate", id: "app-1" } }));
    const byTeam = await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, kind: "ask", question: "Is the pay right?", requestedBy: { kind: "user", id: "owner-1", name: "Dana" } }));
    expect(await container.db.select().from(jobs).where(eq(jobs.kind, ESCALATION_QUEUE_EMAIL_JOB_KIND))).toHaveLength(1);
    await container.drain();
    const sent = mail().slice(before).filter((m) => m.to === "queue@its.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toMatch(/^\[candidate_issue\] /);
    expect(sent[0].text).toContain("A candidate asked for a person, through the product.");
    expect(sent[0].text).toContain(`/recruiter/queue/${esc.id}`);
    expect(sent[0].text).not.toContain("Nia"); // pre-acceptance context only
    const [row] = await container.db.select().from(communications).where(eq(communications.idempotencyKey, `escalation:${esc.id}`));
    expect(row).toMatchObject({ status: "sent", toAddress: "queue@its.test", templateKey: "escalation" });
    expect(await container.db.select().from(communications).where(eq(communications.idempotencyKey, `escalation:${byTeam.id}`))).toHaveLength(0);
  });

  it("a workflow that stops for good emails the queue about the request it opens", async () => {
    setEscalationQueueEmails(() => container.engine.clock());
    container.engine.register({ key: "test.stops", version: 1, initialStep: "boom", maxAttempts: 1, steps: { boom: async () => ({ kind: "fail", error: "cannot continue", retryable: false }) } });
    const before = mail().length;
    const { runId } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "test.stops", companyId, subject: { type: "role", id: "0192a6b2-0000-7aaa-8bbb-0000000000aa" } }));
    await container.drain();
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.escalationId).not.toBeNull();
    const sent = mail().slice(before).filter((m) => m.to === "queue@its.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("The product raised a request for a recruiter on its own.");
  });

  it("a direct email to ITS that fails is recorded and tried again, never lost quietly", async () => {
    (container.integrations.email as FakeEmailAdapter).failNext(1);
    const before = mail().length;
    const r = await sendToIts(container, { companyId, subject: "[access ended] Harbor Dental ended a recruiter's access", text: "Recruiter: Kai", idempotencyKey: "grant_revoked_queue:test-1", template: "staff_access_revoked_queue" });
    expect(r.status).toBe("pending");
    let [row] = await container.db.select().from(communications).where(eq(communications.id, r.communicationId));
    expect(row.status).toBe("queued");
    expect(row.error).toMatch(/outage/);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(Date.now() + 60_000);
    await container.drain();
    [row] = await container.db.select().from(communications).where(eq(communications.id, r.communicationId));
    expect(row.status).toBe("sent");
    expect(mail().slice(before).filter((m) => m.to === "queue@its.test")).toHaveLength(1);
    // the same key again sends nothing
    expect((await sendToIts(container, { companyId, subject: "again", text: "again", idempotencyKey: "grant_revoked_queue:test-1", template: "staff_access_revoked_queue" })).status).toBe("sent");
    expect(mail().slice(before).filter((m) => m.to === "queue@its.test")).toHaveLength(1);
    (container.engine as unknown as { now: () => Date }).now = () => new Date();
  });

  it("the hourly check finds interrupted sends and requests past their reply-by time, and alerts once per request", async () => {
    const now = new Date();
    const [stuck] = await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, direction: "outbound", channel: "email", fromAddress: "x", toAddress: "y@example.com", subject: "s", bodyText: "t", templateKey: "test", provider: "fake-email", status: "sending", sendingAt: new Date(now.getTime() - 20 * 60_000).toISOString(), sentBy: system, idempotencyKey: "hourly-stuck" }).returning({ id: communications.id }));
    const late = await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, kind: "candidate_issue", question: "A candidate asked for a person.", requestedBy: { kind: "candidate", id: "app-2" } }));
    await container.db.update(recruiterEscalations).set({ slaDueAt: new Date(now.getTime() - 2 * 3600_000).toISOString() }).where(eq(recruiterEscalations.id, late.id));
    const first = await runHourlyChecks(container.db, now, { workerInline: true });
    expect(first.interruptedSends).toBe(1);
    expect(first.overdueRequests).toBeGreaterThanOrEqual(1);
    expect((await container.db.select().from(communications).where(eq(communications.id, stuck.id)))[0].status).toBe("unknown");
    const overdue = () => container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, ESCALATION_OVERDUE_ALERT_KIND)).then((rows) => rows.filter((a) => a.target?.id === late.id));
    expect(await overdue()).toHaveLength(1);
    expect((await overdue())[0]).toMatchObject({ severity: "high", status: "open" });
    expect(JSON.stringify(await overdue())).not.toContain("asked for a person"); // the request's words stay with the request
    // the next hour: nothing new while it waits
    const second = await runHourlyChecks(container.db, new Date(now.getTime() + 3600_000), { workerInline: true });
    expect(second.overdueRequests).toBe(0);
    expect(await overdue()).toHaveLength(1);
    // picked up: the alert is over
    await container.db.update(recruiterEscalations).set({ status: "claimed" }).where(eq(recruiterEscalations.id, late.id));
    await runHourlyChecks(container.db, new Date(now.getTime() + 2 * 3600_000), { workerInline: true });
    expect((await overdue())[0].status).toBe("resolved");
  });
});

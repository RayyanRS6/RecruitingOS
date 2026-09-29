import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { adminAlerts, companies, jobs, withTenant, workflowRuns } from "@ros/db";
import { createContainer, type Container } from "./container";
import { FAILURE_TEXT_LIMIT, describeFailure } from "./failure-reports";
import { installReporter } from "./observability";

/**
 * Audit remediation H2: a queued job that uses up its attempts raises an alert a person sees, and both a failed job
 * and a workflow run that failed for good reach the error reporter with kinds and ids only, never a payload or state.
 */
describe("failures that used up their attempts", () => {
  let container: Container;
  const seen: Array<{ err: unknown; context?: Record<string, unknown> }> = [];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    installReporter((err, context) => seen.push({ err, context }));
  });
  afterAll(async () => {
    installReporter(null);
    await container.close();
  });

  it("a job that fails for good raises a job.failed alert and reaches the reporter without its payload", async () => {
    const kind = "test.doomed";
    let attempts = 0;
    container.engine.registerJob(kind, async () => {
      attempts += 1;
      throw new Error("the provider said no");
    });
    await withTenant(container.db, "00000000-0000-0000-0000-000000000000", (tx) => container.engine.enqueue(tx, { kind, payload: { candidateEmail: "private-person@example.com", note: "never leaves the database" }, maxAttempts: 2 }));
    await container.drain();
    // the queue retried once with backoff; the second attempt is due in seconds, so move the clock and drain again
    expect(attempts).toBe(1);
    const [pending] = await container.db.select().from(jobs).where(eq(jobs.kind, kind));
    expect(pending.status).toBe("queued");
    expect(pending.lastError).toBe("the provider said no");
    (container.engine as unknown as { now: () => Date }).now = () => new Date(Date.parse(pending.runAt) + 1000);
    await container.drain();
    expect(attempts).toBe(2);
    const [failed] = await container.db.select().from(jobs).where(eq(jobs.kind, kind));
    expect(failed.status).toBe("failed");
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "job.failed"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "high", status: "open" });
    expect(alerts[0].details).toEqual({ jobId: failed.id, kind, attempts: 2, lastError: "the provider said no" });
    expect(JSON.stringify(alerts[0])).not.toContain("private-person@example.com");
    const reported = seen.filter((s) => s.context?.where === "job");
    expect(reported).toHaveLength(1);
    expect(reported[0].context).toEqual({ process: "queue", where: "job", kind, jobId: failed.id, attempts: 2, error: "the provider said no" });
    expect((reported[0].err as Error).message).toBe("job test.doomed failed for good after 2 attempts"); // a fixed message per kind; the error text rides in the context, scrubbed
    expect(JSON.stringify(reported[0])).not.toContain("private-person@example.com");
  });

  it("the last error reaches the reporter without an address, a phone number or a secret, and cut to length", async () => {
    expect(describeFailure("delivery failed (attempt 1 of 1): postmark said no to Jane.Doe@example.com, tel +1 555 123 4567 or (555) 123-4567, token sk-ant-api03-DELIBERATE-TEST-VALUE-0000000000000000")).toBe("delivery failed (attempt 1 of 1): postmark said no to [redacted], tel [redacted] or [redacted], token [redacted]");
    expect(describeFailure("job 42 for run 883953f4-6105-42a2-a16a-77a8eac79483 at 2026-09-30T12:00:00Z timed out")).toBe("job 42 for run 883953f4-6105-42a2-a16a-77a8eac79483 at 2026-09-30T12:00:00Z timed out"); // ids and times stay
    const long = describeFailure("x".repeat(FAILURE_TEXT_LIMIT + 50));
    expect(long).toHaveLength(FAILURE_TEXT_LIMIT + 3);
    expect(long.endsWith("...")).toBe(true);
    // end to end: a job whose error names the recipient
    const kind = "test.doomed_naming_a_person";
    container.engine.registerJob(kind, async () => { throw new Error("delivery failed (attempt 1 of 1): the provider refused mail to private-person@example.com (+15551234567)"); });
    await withTenant(container.db, "00000000-0000-0000-0000-000000000000", (tx) => container.engine.enqueue(tx, { kind, payload: {}, maxAttempts: 1 }));
    await container.drain();
    const reported = seen.filter((s) => s.context?.kind === kind);
    expect(reported).toHaveLength(1);
    expect(reported[0].context?.error).toBe("delivery failed (attempt 1 of 1): the provider refused mail to [redacted] ([redacted])");
    expect((reported[0].err as Error).message).toBe(`job ${kind} failed for good after 1 attempt`);
    expect(JSON.stringify(reported[0])).not.toMatch(/private-person|5551234567/);
  });

  it("a workflow run that fails for good reaches the reporter with its keys and ids, never its state", async () => {
    const [company] = await container.db.insert(companies).values({ name: "Harbor Dental", slug: "harbor-dental-failures", vertical: "dental", sizeBand: "20-49" }).returning({ id: companies.id });
    container.engine.register({
      key: "test.failing_workflow",
      version: 1,
      initialStep: "boom",
      maxAttempts: 1,
      steps: { boom: async () => ({ kind: "fail", error: "cannot continue", retryable: false }) },
    });
    const { runId } = await withTenant(container.db, company.id, (tx) => container.engine.start(tx, { workflowKey: "test.failing_workflow", companyId: company.id, subject: { type: "role", id: "00000000-0000-0000-0000-000000000001" }, state: { candidateEmail: "private-person@example.com" } }));
    await container.drain();
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("failed");
    const reported = seen.filter((s) => s.context?.where === "workflow");
    expect(reported).toHaveLength(1);
    expect(reported[0].context).toEqual({ process: "queue", where: "workflow", workflowKey: "test.failing_workflow", runId, step: "boom", attempts: 1, companyId: company.id, error: "cannot continue" });
    expect((reported[0].err as Error).message).toBe("workflow test.failing_workflow failed for good at step boom after 1 attempt");
    expect(JSON.stringify(reported[0])).not.toContain("private-person@example.com");
  });
});

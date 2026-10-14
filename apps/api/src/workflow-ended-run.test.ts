import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { SYSTEM_ACTOR } from "@ros/core";
import { companies, events, jobs, withTenant, workflowRuns, workflowSteps } from "@ros/db";
import { createContainer, type Container } from "./container";

/**
 * Wave S3: a step whose slow half (a model call) is still running when its run is cancelled (a candidate's data deleted)
 * never writes the run again. Without this the step's result would bring the run back to life with the old state, words
 * and all, until the next daily clean-up.
 */
describe("a step in flight when its run is cancelled", () => {
  let container: Container;
  let companyId: string;
  const scrubbed = { applicationId: "0192a6b2-1111-7aaa-8bbb-123456789abc" };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    const [company] = await container.db.insert(companies).values({ name: "Harbor Dental", slug: "harbor-dental-ended-run", vertical: "dental", sizeBand: "20-49" }).returning({ id: companies.id });
    companyId = company.id;
  });
  afterAll(async () => {
    await container.close();
  });

  /** A two-phase step whose prepare waits for the test to let it go; `outcome` decides how the slow half ends. */
  function slowWorkflow(key: string, outcome: "returns" | "throws") {
    let entered!: () => void;
    let release!: () => void;
    const inPrepare = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    container.engine.register({
      key,
      version: 1,
      initialStep: "read",
      maxAttempts: 3,
      steps: {
        read: {
          prepare: async () => {
            entered();
            await gate;
            if (outcome === "throws") throw new Error("the model returned invalid JSON near 'Maria Reyes'");
            return { said: "Maria Reyes, (949) 555-0100" };
          },
          run: async (_ctx, prepared) => ({ kind: "next", step: "after", state: { said: (prepared as { said: string }).said } }),
        },
        after: async () => ({ kind: "complete" }),
      },
    });
    return { inPrepare, release };
  }

  async function startAndCancelMidStep(key: string, outcome: "returns" | "throws") {
    const slow = slowWorkflow(key, outcome);
    const { runId } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: key, companyId, subject: { type: "application", id: scrubbed.applicationId }, state: { ...scrubbed, note: "Maria Reyes asked for Tuesdays" } }));
    const ticking = container.engine.tick(runId);
    await slow.inPrepare;
    // the deletion commits while the model is still thinking: the run is cancelled, then scrubbed
    await withTenant(container.db, companyId, async (tx) => {
      await container.engine.cancel(tx, runId, SYSTEM_ACTOR, "the candidate asked for their information to be deleted");
      await tx.update(workflowRuns).set({ state: scrubbed }).where(eq(workflowRuns.id, runId));
    });
    slow.release();
    await ticking;
    return runId;
  }

  it("a step that returns after the cancel writes nothing: the run stays cancelled and scrubbed, with no step record or event", async () => {
    const runId = await startAndCancelMidStep("test.slow_step_returns", "returns");
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", currentStep: "read", state: scrubbed, wait: null });
    expect(await container.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId))).toEqual([]);
    const after = await container.db.select().from(events).where(and(eq(events.subjectType, "workflow_run"), eq(events.subjectId, runId)));
    expect(after.map((e) => e.type).sort()).toEqual(["workflow.cancelled", "workflow.started"]);
    expect(JSON.stringify(run)).not.toMatch(/Maria|555-0100/);
  });

  it("a step whose slow half fails after the cancel is not retried and does not fail the run", async () => {
    const runId = await startAndCancelMidStep("test.slow_step_throws", "throws");
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run).toMatchObject({ status: "cancelled", state: scrubbed, wait: null, lastError: "the candidate asked for their information to be deleted" });
    expect(await container.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId))).toEqual([]);
    const retries = (await container.db.select().from(jobs).where(eq(jobs.kind, "workflow.tick"))).filter((j) => (j.payload as { runId?: string; wake?: unknown }).runId === runId && (j.payload as { wake?: unknown }).wake);
    expect(retries).toEqual([]);
    const after = await container.db.select().from(events).where(and(eq(events.subjectType, "workflow_run"), eq(events.subjectId, runId)));
    expect(after.map((e) => e.type).sort()).toEqual(["workflow.cancelled", "workflow.started"]);
  });

  it("a run nobody cancelled still moves on as before", async () => {
    const slow = slowWorkflow("test.slow_step_untouched", "returns");
    const { runId } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "test.slow_step_untouched", companyId, subject: { type: "application", id: scrubbed.applicationId }, state: scrubbed }));
    const ticking = container.engine.tick(runId);
    await slow.inPrepare;
    slow.release();
    await ticking;
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("completed");
    expect((await container.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId))).map((s) => s.stepKey)).toEqual(["read", "after"]);
  });
});

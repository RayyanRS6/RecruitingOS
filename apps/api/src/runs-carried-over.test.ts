import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import { FAKE_SAMPLE_RESUMES } from "@ros/agents";
import { adminAlerts, aiRuns, applications, assessments, candidates, jobs, notifications, screens, workflowRuns, type WaitCondition } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation } from "./services/screens";
import { plantJob, usePlan } from "./test-helpers";

/** The statements of migration 0040 about workflow runs still going, word for word as the release runs them. */
const RUN_STATEMENTS = readFileSync(fileURLToPath(new URL("../../../packages/db/migrations/0040_states_the_code_knows.sql", import.meta.url)), "utf8")
  .split("--> statement-breakpoint")
  .filter((statement) => statement.includes("UPDATE workflow_runs"));

/**
 * Runs that were still going under the definitions of an earlier build, once migration 0040 has moved them: the engine
 * carries each on at a step it has, and nothing a person already got is sent or paid for twice. The rows are given the
 * old version, an old step and an old wait, the migration's own statements run, and then the worker does.
 */
describe("workflow runs of an earlier build, after the migration", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let slug = "";
  let job = "";
  const ids: Record<string, string> = {};
  const emails: Record<string, string> = {};
  const runs: Record<string, string> = {};

  const BASE = Date.now();
  let offset = 0;
  const HOUR = 3600_000;
  const advance = async (ms: number) => { offset += ms; await container.drain(); };
  const ANSWER = "At Coastal Smiles I assisted chairside for four years and took x-rays every day.";

  const call = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  const mailTo = (who: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === emails[who]);
  const stageOf = async (who: string) => (await container.db.select({ stage: applications.stage }).from(applications).where(eq(applications.id, ids[who])))[0].stage;
  const screensOf = (who: string) => container.db.select().from(screens).where(eq(screens.applicationId, ids[who])).orderBy(asc(screens.createdAt), asc(screens.id));
  const runOf = async (id: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
  const newestRun = async (key: string, who: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, key)).orderBy(asc(workflowRuns.startedAt), asc(workflowRuns.id))).filter((r) => r.subject.id === ids[who]).at(-1)!;
  const readingsOf = (who: string, kind: "triage" | "screen") => container.db.select().from(assessments).where(and(eq(assessments.applicationId, ids[who]), eq(assessments.kind, kind)));
  const aiCalls = async () => (await container.db.select({ task: aiRuns.task }).from(aiRuns).where(eq(aiRuns.companyId, companyId))).map((r) => r.task).sort();
  const finishedNotes = async () => (await container.db.select({ title: notifications.title }).from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "screen.completed")))).map((n) => n.title);

  const apply = async (name: string) => {
    const email = `${name.toLowerCase()}@people.test`;
    const fd = new FormData();
    fd.set("firstName", name);
    fd.set("lastName", "Tester");
    fd.set("email", email);
    fd.set("acknowledged", "yes");
    fd.set("resume", new File([`${name} Tester\n${email}\n${FAKE_SAMPLE_RESUMES.possible}\n`], "resume.txt", { type: "text/plain" }));
    const res = await app.request(`/careers/${slug}/jobs/${job}/apply`, { method: "POST", body: fd });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [row] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, job), eq(candidates.email, email)));
    ids[name] = row.id;
    emails[name] = email;
  };
  const shortlist = async (who: string) => {
    const r = await call("POST", `/api/v1/applications/${ids[who]}/actions`, { action: "shortlist" });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };
  /** A run as an earlier build left it: its version, one of its steps, its wait and what else it kept in its state. */
  const asOldRun = async (id: string, step: string, wait: WaitCondition, state: Record<string, unknown> = {}) => {
    const row = await runOf(id);
    await container.db.update(workflowRuns).set({ workflowVersion: 1, status: "waiting", currentStep: step, wait, completedAt: null, state: { ...row.state, ...state } }).where(eq(workflowRuns.id, id));
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", MESSAGE_UNDO_SECONDS: "30", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@carried.test" }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(devLink).searchParams.get("token") }) });
    owner = r2.headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await call("POST", "/api/v1/companies", { name: "Carried Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    slug = ((await (await call("GET", "/api/v1/companies/current")).json()) as { slug: string }).slug;
    await usePlan(container, companyId, "ultra");
    job = await plantJob(container, { companyId, title: "Dental Assistant" });
    for (const name of ["Ada", "Ben", "Cy", "Dee"]) await apply(name);

    // Ada was read and scored; her intake run waited for a person's answer to a suggestion, a step that is gone
    runs.ada = (await newestRun("application_intake", "Ada")).id;
    await asOldRun(runs.ada, "after_triage_decision", { kind: "event", eventTypes: ["approval.decided"], reason: "waiting for a person" }, { noAiReading: false });

    // Ben's AI interview is out and not started; its run waited at a step that is gone, on signals nobody sends now
    await shortlist("Ben");
    runs.ben = (await newestRun("screen", "Ben")).id;
    const [benInterview] = await screensOf("Ben");
    await asOldRun(runs.ben, "after_invite", { kind: "event", eventTypes: ["started", "completed", "human"], subjectId: `screen:${benInterview.id}`, until: benInterview.expiresAt! }, { channel: "web", invitedVia: "apply", flow: "one_visit" });

    // Cy sent his answers and has his scorecard; his run waited for a person's answer to a suggestion
    await shortlist("Cy");
    const ref = (await findConversation(container.db, (await screensOf("Cy"))[0].token))!;
    expect(await conversationStart(container, ref)).toBe(true);
    for (let turn = 0; turn < 40 && (await conversationView(container.db, ref))!.phase === "conversation"; turn++) expect((await conversationTurn(container, ref, { message: `${ANSWER} (${turn + 1})` })).kind).toBe("reply");
    expect(await conversationSubmit(container, ref)).toBe(true);
    await container.drain();
    runs.cy = (await newestRun("screen", "Cy")).id;
    await asOldRun(runs.cy, "on_decision", { kind: "event", eventTypes: ["approval.decided"] }, { channel: "web", invitedVia: "apply" });

    // Dee was never shortlisted; an interview run of the earlier build was still waiting to make her one
    const [dee] = await container.db.insert(workflowRuns).values({ companyId, workflowKey: "screen", workflowVersion: 1, subject: { type: "application", id: ids.Dee }, status: "waiting", currentStep: "await_reading", state: { applicationId: ids.Dee, roleId: job, mode: "with_application", flow: "one_visit" }, wait: { kind: "timer", until: new Date(BASE + HOUR).toISOString() } }).returning({ id: workflowRuns.id });
    runs.dee = dee.id;
    // and the company's run of a workflow that is gone waited on its timer, whose tick is still queued
    const [gone] = await container.db.insert(workflowRuns).values({ companyId, workflowKey: "notification_digest", workflowVersion: 1, subject: { type: "company", id: companyId }, status: "waiting", currentStep: "send", state: {}, wait: { kind: "timer", until: new Date(BASE + HOUR).toISOString(), token: "t1" } }).returning({ id: workflowRuns.id });
    runs.gone = gone.id;
    await container.db.insert(jobs).values({ kind: "workflow.tick", payload: { runId: gone.id, wake: { kind: "timer", key: "t1" } }, runAt: new Date(BASE + HOUR).toISOString() });
  });
  afterAll(async () => { await container.close(); });

  it("the migration gives each run a step of today's, and the worker carries every one on without sending or paying for anything twice", async () => {
    expect(RUN_STATEMENTS).toHaveLength(3);
    const before = { ai: await aiCalls(), ada: mailTo("Ada").length, ben: mailTo("Ben").length, cy: mailTo("Cy").length, dee: mailTo("Dee").length, finished: await finishedNotes() };
    expect(before.finished).toEqual(["Cy Tester finished the AI interview"]);

    for (const statement of RUN_STATEMENTS) await container.db.execute(sql.raw(statement));
    expect(Object.fromEntries(await Promise.all(Object.entries(runs).map(async ([who, id]) => { const r = await runOf(id); return [who, [r.workflowVersion, r.status, r.currentStep]]; })))).toEqual({
      ada: [2, "running", "receive"],
      ben: [2, "running", "remind"],
      cy: [2, "running", "score"],
      dee: [2, "running", "invite"],
      gone: [1, "cancelled", "send"],
    });

    // the migration queues each run's tick at the database's own time; the worker comes to them a moment later
    await advance(5 * 60_000);
    // Ada: nothing is read again and she gets no second email; she is where she was, with her one reading
    expect(await runOf(runs.ada)).toMatchObject({ status: "completed", lastError: null });
    expect(await stageOf("Ada")).toBe("triaged");
    expect(await readingsOf("Ada", "triage")).toHaveLength(1);
    expect(mailTo("Ada")).toHaveLength(before.ada);
    // Ben: his link is as it was, and the run waits for the reminder's hour
    expect(await runOf(runs.ben)).toMatchObject({ status: "waiting", currentStep: "remind" });
    expect((await screensOf("Ben")).map((s) => s.status)).toEqual(["invited"]);
    expect(mailTo("Ben")).toHaveLength(before.ben);
    // Cy: his scorecard is the one he had, nobody is told twice that he finished, and the run is over
    expect(await runOf(runs.cy)).toMatchObject({ status: "completed", lastError: null });
    expect(await readingsOf("Cy", "screen")).toHaveLength(1);
    expect(await finishedNotes()).toEqual(before.finished);
    expect(mailTo("Cy")).toHaveLength(before.cy);
    // Dee: nobody shortlisted her, so no interview is made and no link is emailed
    expect(await runOf(runs.dee)).toMatchObject({ status: "completed", lastError: null });
    expect(await screensOf("Dee")).toEqual([]);
    expect(await stageOf("Dee")).toBe("triaged");
    expect(mailTo("Dee")).toHaveLength(before.dee);
    // no AI call was made for any of them
    expect(await aiCalls()).toEqual(before.ai);
  });

  it("Ben's interview then runs its course: one reminder after 48 hours, and the link closes at five days with one note", async () => {
    const [interview] = await screensOf("Ben");
    const before = mailTo("Ben").length;
    await advance(49 * HOUR);
    expect(mailTo("Ben")).toHaveLength(before + 1);
    expect(mailTo("Ben").at(-1)!.text).toContain(`/c/screen/${interview.token}`);
    expect((await screensOf("Ben"))[0]).toMatchObject({ status: "reminded" });
    await advance(3 * 24 * HOUR + 2 * HOUR);
    expect((await screensOf("Ben"))[0].status).toBe("expired");
    expect(mailTo("Ben")).toHaveLength(before + 2);
    expect(mailTo("Ben").at(-1)!.subject).toContain("has closed");
    expect(await runOf(runs.ben)).toMatchObject({ status: "completed" });
    expect(await stageOf("Ben")).toBe("screen_invited");
  });

  it("the queued tick of a workflow that is gone finds its run cancelled and does nothing: no failed job, no alert about an older worker", async () => {
    // the hour of the old timer has passed in the case above, so the worker has claimed that tick
    const ticks = (await container.db.select().from(jobs).where(eq(jobs.kind, "workflow.tick"))).filter((j) => j.payload.runId === runs.gone);
    expect(ticks.map((j) => j.status)).toEqual(["done"]);
    expect(await runOf(runs.gone)).toMatchObject({ status: "cancelled", lastError: "this workflow is not part of the simple product" });
    expect((await container.db.select().from(jobs).where(eq(jobs.status, "failed")))).toEqual([]);
    expect((await container.db.select({ kind: adminAlerts.kind }).from(adminAlerts)).map((a) => a.kind).filter((kind) => kind === "worker.outdated" || kind === "job.failed" || kind === "workflow.failed")).toEqual([]);
  });
});

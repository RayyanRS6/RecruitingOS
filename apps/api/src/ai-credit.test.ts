import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_CREDIT_USED_UP, creditHoldUsd, estimateCostUsd, outOfCredit, runPromptDetached, runPromptsDetached, type AiProvider, type AiRuntime, type PromptDef, type StructuredRequest, type StructuredResult, type Usage } from "@ros/ai";
import { INTAKE_COMPILE_MAX_TOKENS, PERSON_OFFER, PERSON_REPLY, runIntakeTurn, startIntakeSession } from "@ros/agents";
import { ACTION_BLOCKED, AI_CREDIT_AVAILABLE, AI_HELP_BUSY_LINE, AI_HELP_LINE, AI_HELP_UPGRADE_QUESTION, CV_NO_SCORE_LABEL, INTERVIEW_NO_SCORE_LABEL, type AiCreditView, type CandidatePanel, type CompanyView, type HomeView, type IntakeSessionList, type IntakeSessionView, type IntakeStartResponse, type IntakeTurnResponse, type PlanRoom, type UsageLine } from "@ros/contracts";
import { AI_CREDIT_DRAFT_HOLD_USD, AI_CREDIT_SLACK_USD, aiCreditRoomForJob, aiCreditRoomSoon, aiCreditStanding, entitlements as allowance, holdAiCreditRows, reserveAiCredit } from "@ros/core";
import { adminAlerts, aiRuns, applications, assessments, candidates, companies, entitlements, events, intakeSessions, notifications, screens, withPlatform, withTenant, workflowRuns, workflowSteps, type Tx } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider } from "@ros/integrations";
import { AI_OUTAGE_ALERT_KIND } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { runHourlyChecks, runMaintenance } from "./maintenance";
import { conversationPerson, conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation, type ConversationRef } from "./services/screens";
import { applicationForm, plantJob, signInAdmin, testContainerOptions, usePlan } from "./test-helpers";

/** One sentence that names every essential of a job, so the job can be written at once. */
const HIRE = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
/** One that leaves the place, the work arrangement and the pay to ask about. */
const HIRE_WITH_QUESTIONS = "Software Engineer required with 3 years of hands-on experience in Python and Flask";
const ANSWER = "At Coastal Dental I see nine patients a day and chart perio exams in Dentrix.";
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const REAL_MODELS = { judgment: SONNET, standard: HAIKU, fast: HAIKU };
const DAY = 86_400_000;

type TestInput = { text: string };
const answerSchema = z.object({ ok: z.boolean() });
const chatPrompt: PromptDef<TestInput, { ok: boolean }> = { key: "test.chat", version: 1, task: "screen.turn", agent: "test", schema: answerSchema, system: () => [{ text: "You are a test." }], messages: (i) => [{ role: "user", content: i.text }] };
const draftPrompt: PromptDef<TestInput, { ok: boolean }> = { key: "test.draft", version: 1, task: "intake.compile", agent: "test", schema: answerSchema, system: () => [{ text: "You write a whole job." }], messages: (i) => [{ role: "user", content: i.text }] };
const charsOf = (p: PromptDef<TestInput, { ok: boolean }>, input: TestInput) => p.system(input).reduce((n, b) => n + b.text.length, 0) + p.messages(input).reduce((n, m) => n + m.content.length, 0);
const INPUT: TestInput = { text: "Please answer." };
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

/**
 * A stand-in provider at real prices: the models' real names, and the usage a test names (at most what the hold allows for,
 * `worstCase`). `waiting`: every call waits here until the test lets go, so many can be in flight at once. `answers`: what
 * the model says, or the fake's own answers for a real prompt (`through`).
 */
class PricedProvider implements AiProvider {
  readonly id = "priced";
  calls = 0;
  waiting: Promise<void> | null = null;
  duringCall: (() => Promise<void>) | null = null;
  usage: (req: StructuredRequest<unknown>, model: string) => Usage = () => ({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 0 });
  answer: ((req: StructuredRequest<unknown>, model: string) => StructuredResult<unknown>) | null = null;
  constructor(private through?: AiProvider) {}
  async structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>> {
    this.calls += 1;
    if (this.duringCall) await this.duringCall();
    if (this.waiting) await this.waiting;
    if (this.answer) return this.answer(req as StructuredRequest<unknown>, model) as StructuredResult<T>;
    if (this.through) {
      const out = await this.through.structured(req, "fake");
      return { ...out, model, usage: this.usage(req as StructuredRequest<unknown>, model) } as StructuredResult<T>;
    }
    return { kind: "ok", output: { ok: true } as T, model, usage: this.usage(req as StructuredRequest<unknown>, model), latencyMs: 5 };
  }
}

/** What a call really costs when it uses all its hold allows for: two requests, each at the ceiling. */
const worstCase = (req: StructuredRequest<unknown>): Usage => {
  const chars = req.system.reduce((n, b) => n + b.text.length, 0) + req.messages.reduce((n, m) => n + m.content.length, 0);
  return { inputTokens: 2 * Math.ceil(chars / 2), outputTokens: 2 * (req.maxTokens ?? 16_000), cacheReadTokens: 0 };
};

describe("the AI credit", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let made = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const errorOf = async (r: Response) => (await read<{ error: { code: string; message: string; details: { upgrade?: boolean; ask: { label: string; reason: string } | null; room?: { ok: boolean; aiHelp?: boolean; upgrade?: boolean; message: string } } } }>(r)).error;
  const moveClock = (at: number | null) => { (container.engine as unknown as { now: () => Date }).now = at === null ? () => new Date() : () => new Date(at); };
  /** The company's plan as its own people read it in Settings: the AI help as a level, a percentage and words, and the usage lines by key. */
  const planOf = async (cookie: string): Promise<{ aiCredit: Omit<AiCreditView, "notice"> & { notice: NonNullable<AiCreditView["notice"]> }; usage: Record<string, UsageLine> }> => {
    const { plan } = await read<CompanyView>(await json(cookie, "GET", "/api/v1/companies/current"));
    const credit = plan.aiCredit ?? { level: null, percent: 0, resetsAt: null, notice: null };
    return { aiCredit: { ...credit, notice: credit.notice ?? { title: "", body: "" } }, usage: Object.fromEntries(plan.usage.map((l) => [l.key, l])) };
  };

  /** A company of its own on Free, signed in from an address of its own (the route's limit per address). */
  const newCompany = async () => {
    made += 1;
    const accessToken = (container.integrations.identity as FakeIdentityProvider).mint({ email: `owner-${made}@ai-credit.test`, name: `Owner ${made}`, provider: "google" });
    const signedIn = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${made}` }, body: JSON.stringify({ accessToken }) });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const r = await json(cookie, "POST", "/api/v1/companies", { name: `Harbor Dental ${made}`, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status, await r.clone().text()).toBe(201);
    const { id } = await read<{ id: string }>(r);
    return { cookie, id };
  };

  const spend = (companyId: string, costUsd: number | string, opts: { status?: string; createdAt?: string } = {}) => withPlatform(container.db, (tx) => tx.insert(aiRuns).values({ companyId, agent: "test", task: "test.spent", provider: "fake", model: "fake", promptKey: "test.spent", promptVersion: 1, promptHash: "x", costUsd: String(costUsd), status: opts.status ?? "ok", ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) }));
  const spent = async (companyId: string) => withTenant(container.db, companyId, (tx) => allowance.aiCreditSpentMicros(tx, companyId)).then((m) => m / 1_000_000);
  /** The monthly credit's period began `ms` ago (a plan's first month starts when it is applied, so a hold dated before it would not count). */
  const monthBegan = (companyId: string, ms: number) => withPlatform(container.db, (tx) => tx.update(entitlements).set({ periodStart: new Date(Date.now() - ms).toISOString() }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "ai_credit_monthly_cents"))));
  const runsOf = (companyId: string) => container.db.select().from(aiRuns).where(and(eq(aiRuns.companyId, companyId), sql`${aiRuns.task} <> 'test.spent'`));
  const runtime = (provider: AiProvider): AiRuntime => ({ provider, models: REAL_MODELS, credit: container.ai.credit });
  /** With the company's real AI at real prices, for a route under test. */
  const atRealPrices = async <T>(fn: (provider: PricedProvider) => Promise<T>): Promise<T> => {
    const before = { provider: container.ai.provider, models: container.ai.models };
    const provider = new PricedProvider(before.provider);
    container.ai.provider = provider;
    container.ai.models = REAL_MODELS;
    try {
      return await fn(provider);
    } finally {
      container.ai.provider = before.provider;
      container.ai.models = before.models;
    }
  };

  /** A draft in the job builder, started with one sentence. */
  const draftOf = async (cookie: string, words = HIRE): Promise<IntakeSessionView> => {
    const r = await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: words });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await read<IntakeStartResponse>(r)).session!;
  };
  /** The same with the job written ("Write the job"). */
  const writtenDraftOf = async (cookie: string): Promise<string> => {
    const draft = await draftOf(cookie);
    const r = await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/draft`);
    expect(r.status, await r.clone().text()).toBe(200);
    return draft.id;
  };
  /** The plan's room for another job, as Start a hire reads it before anyone types: on Home, and beside the drafts. */
  const roomOf = async (cookie: string): Promise<PlanRoom> => {
    const { room } = await read<IntakeSessionList>(await json(cookie, "GET", "/api/v1/intake/sessions?mine=1"));
    expect((await read<HomeView>(await json(cookie, "GET", "/api/v1/home"))).room).toEqual(room);
    return room;
  };

  /** A company with one job open, the AI credit untouched (no model wrote it). */
  const openJob = async () => {
    const company = await newCompany();
    const { slug } = await read<CompanyView>(await json(company.cookie, "GET", "/api/v1/companies/current"));
    const roleId = await plantJob(container, { companyId: company.id, title: "Registered Dental Hygienist" });
    return { ...company, slug, roleId };
  };
  type Job = Awaited<ReturnType<typeof openJob>>;

  let applicants = 0;
  /** The public form, as a browser posts it; then the worker runs, and the application is read back. */
  const apply = async (job: Job, p: { first: string; last: string; email: string }) => {
    applicants += 1;
    const res = await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: applicationForm({ firstName: p.first, lastName: p.last, email: p.email }, "Registered Dental Hygienist at Coastal Dental 2019 - present\nRDH license active\nRadiography certificate\nPerio maintenance, Dentrix"), headers: { "x-forwarded-for": `198.51.100.${applicants}` } });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.id), eq(candidates.email, p.email)));
    const [row] = await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id)));
    return row;
  };
  const applicationOf = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)).orderBy(desc(screens.createdAt)))[0];
  const runOf = async (key: string, applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, key))).find((r) => r.subject.id === applicationId)!;
  const mailTo = (email: string) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === email);
  /** What a person on the team presses for one candidate. */
  const act = (job: Job, applicationId: string, action: string) => json(job.cookie, "POST", `/api/v1/applications/${applicationId}/actions`, { action });
  const panelOf = async (job: Job, applicationId: string) => read<CandidatePanel>(await json(job.cookie, "GET", `/api/v1/applications/${applicationId}`));
  /** A person shortlists them: their AI interview is made and its link emailed. */
  const interviewOf = async (job: Job, applicationId: string): Promise<ConversationRef> => {
    const r = await act(job, applicationId, "shortlist");
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
    return (await findConversation(container.db, (await screenOf(applicationId)).token))!;
  };
  /** Someone who applied, was read, was shortlisted and pressed Start. */
  const started = async (job: Job, p: { first: string; last: string; email: string }) => {
    const a = await apply(job, p);
    expect(a.stage).toBe("triaged");
    const ref = await interviewOf(job, a.id);
    expect(await conversationStart(container, ref)).toBe(true);
    return { a, ref };
  };
  /** Answers every question left, as a candidate does, and says where the chat ended. */
  const answerToTheEnd = async (ref: ConversationRef) => {
    for (let i = 0; i < 30; i++) {
      const v = (await conversationView(container.db, ref))!;
      if (v.phase !== "conversation") return v;
      const r = await conversationTurn(container, ref, { message: ANSWER });
      expect(r.kind, JSON.stringify(r)).toBe("reply");
    }
    throw new Error("the chat never ended");
  };
  const eventTypes = async (companyId: string) => (await container.db.select({ type: events.type }).from(events).where(eq(events.companyId, companyId))).map((e) => e.type);
  const creditNotes = (companyId: string) => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "entitlement.ai_credit")));
  const creditAlerts = (companyId: string) => container.db.select().from(adminAlerts).where(and(eq(adminAlerts.companyId, companyId), inArray(adminAlerts.kind, ["billing.ai_credit_warning", "billing.ai_credit_used_up"])));
  const upgrade = async (companyId: string, planKey = "basic") => {
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey, reason: "They asked to upgrade." });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };

  /** Nothing false was raised about a company whose AI credit ran out: no outage, no failure, no retry, nobody paged about a person. */
  const noFalseAlarm = async (companyId: string, applicationIds: string[] = []) => {
    expect(await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND))).toEqual([]);
    const types = await eventTypes(companyId);
    for (const type of ["ai.run_failed", "ai.output_invalid", "resume.extraction_failed", "workflow.failed", "workflow.retried"]) expect(types, type).not.toContain(type);
    const runs = await container.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId));
    expect(runs.filter((r) => r.status === "failed")).toEqual([]);
    const steps = await container.db.select().from(workflowSteps).where(and(eq(workflowSteps.companyId, companyId), eq(workflowSteps.status, "error")));
    expect(steps).toEqual([]);
    const notes = await container.db.select().from(notifications).where(eq(notifications.companyId, companyId));
    for (const id of applicationIds) expect(notes.filter((n) => n.kind === "candidate.unreachable" && (n.action?.href ?? "").includes(id))).toEqual([]);
  };

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake" }));
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
  });
  afterAll(async () => {
    await container.close();
  });

  describe("the hold", () => {
    it("writes the run before the call, with the hold as its cost, then the real numbers", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      const hold = creditHoldUsd(HAIKU, { promptChars: charsOf(chatPrompt, INPUT) });
      let during: Array<{ status: string; costUsd: string }> = [];
      provider.duringCall = async () => { during = await runsOf(id); };
      const out = await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id, inputRef: { turn: 1 } });
      expect(out).toMatchObject({ ok: true, output: { ok: true }, model: HAIKU });
      expect(during).toHaveLength(1);
      expect(during[0]).toMatchObject({ status: "running" });
      expect(Number(during[0].costUsd)).toBeCloseTo(hold, 6);
      const [row] = await runsOf(id);
      expect(row).toMatchObject({ id: (out as { runId: string }).runId, status: "ok", inputTokens: 100, outputTokens: 100, structuredOutput: { ok: true }, inputRef: { turn: 1, attempts: 1 }, promptKey: "test.chat", provider: "priced", model: HAIKU, task: "screen.turn", agent: "test" });
      expect(Number(row.costUsd)).toBeCloseTo(estimateCostUsd(HAIKU, { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0 }), 6);
    });

    it("a company with no credit row, or a plan with no limit on it, keeps today's path exactly: nothing is written before the call", async () => {
      const none = await newCompany();
      await withPlatform(container.db, (tx) => tx.delete(entitlements).where(and(eq(entitlements.companyId, none.id), inArray(entitlements.key, ["ai_credit_total_cents", "ai_credit_monthly_cents"]))));
      const partner = await newCompany();
      await usePlan(container, partner.id, "design_partner");
      for (const id of [none.id, partner.id]) {
        await spend(id, "500.000000");
        const provider = new PricedProvider();
        let during = -1;
        provider.duringCall = async () => { during = (await runsOf(id)).length; };
        const out = await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
        expect(out.ok).toBe(true);
        expect(during).toBe(0);
        expect((await runsOf(id)).map((r) => r.status)).toEqual(["ok"]);
        expect(await withTenant(container.db, id, (tx) => aiCreditStanding(tx, id))).toBeNull();
      }
    });

    it("a chat turn is refused only when its hold no longer fits under the limit less the slack, about $9.88 on $10", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      const hold = creditHoldUsd(HAIKU, { promptChars: charsOf(chatPrompt, INPUT) });
      expect(hold).toBeGreaterThan(0.01);
      expect(hold).toBeLessThan(0.02);
      const line = Math.round((10 - AI_CREDIT_SLACK_USD - hold) * 1_000_000) / 1_000_000;
      await spend(id, line);
      expect(line).toBeGreaterThan(9.87);
      // exactly at the line it still fits; settled at its real cost, the next look is over it
      const fits = await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(fits.ok).toBe(true);
      expect(provider.calls).toBe(1);
      const before = await runsOf(id);
      const refused = await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(refused).toMatchObject({ ok: false, reason: "no_credit", error: AI_CREDIT_USED_UP, model: HAIKU });
      // no model call, no run: a public form cannot fill the table the sum reads
      expect(provider.calls).toBe(1);
      expect(await runsOf(id)).toEqual(before);
      expect(await container.db.select().from(aiRuns).where(eq(aiRuns.id, refused.runId))).toEqual([]);
    });

    it("a draft is refused earlier, because its hold is bigger, while a chat turn still goes", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      const meta = { companyId: id, maxTokens: INTAKE_COMPILE_MAX_TOKENS };
      const hold = creditHoldUsd(SONNET, { promptChars: charsOf(draftPrompt, INPUT), maxTokens: INTAKE_COMPILE_MAX_TOKENS });
      expect(hold).toBeGreaterThan(0.6);
      const line = Math.round((10 - AI_CREDIT_SLACK_USD - hold) * 1_000_000) / 1_000_000;
      await spend(id, line - 0.000001);
      expect((await runPromptDetached(container.db, runtime(provider), draftPrompt, INPUT, meta)).ok).toBe(true);

      const second = await newCompany();
      await spend(second.id, line + 0.000001);
      expect(line).toBeLessThan(9.3);
      const calls = provider.calls;
      const draft = await runPromptDetached(container.db, runtime(provider), draftPrompt, INPUT, { ...meta, companyId: second.id });
      expect(draft).toMatchObject({ ok: false, reason: "no_credit" });
      expect(provider.calls).toBe(calls);
      expect((await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: second.id })).ok).toBe(true);
    });

    it("overshoot is zero with many calls at once, whatever each one really costs up to its hold", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      const rt = runtime(provider);
      provider.usage = (req) => worstCase(req);
      let letGo = () => {};
      provider.waiting = new Promise((resolve) => { letGo = resolve; });
      const hold = creditHoldUsd(SONNET, { promptChars: charsOf(draftPrompt, INPUT), maxTokens: INTAKE_COMPILE_MAX_TOKENS });
      const room = Math.floor(((10 - AI_CREDIT_SLACK_USD) * 1_000_000) / Math.round(hold * 1_000_000));
      const asked = room + 25;
      let refused = 0;
      const calls = Array.from({ length: asked }, () => runPromptDetached(container.db, rt, draftPrompt, INPUT, { companyId: id, maxTokens: INTAKE_COMPILE_MAX_TOKENS }).then((out) => { if (outOfCredit(out)) refused += 1; return out; }));
      for (let i = 0; i < 2000 && provider.calls + refused < asked; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      // none has finished, so a plain sum of finished calls would still read $0 and let them all through
      expect(provider.calls).toBe(room);
      expect(refused).toBe(asked - room);
      const running = await runsOf(id);
      expect(running.map((r) => r.status)).toEqual(Array(room).fill("running"));
      expect(await spent(id)).toBeLessThanOrEqual(10 - AI_CREDIT_SLACK_USD);
      letGo();
      const outcomes = await Promise.all(calls);
      expect(outcomes.filter((o) => o.ok)).toHaveLength(room);
      const settled = await runsOf(id);
      expect(settled.map((r) => r.status)).toEqual(Array(room).fill("ok"));
      // each cost all its hold allowed for, and the total never passed the limit
      for (const r of settled) expect(Number(r.costUsd)).toBeCloseTo(hold, 6);
      expect(await spent(id)).toBeLessThanOrEqual(10);
    });

    it("overshoot is zero near the line too, with many small calls at once", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      provider.usage = (req) => worstCase(req);
      await spend(id, "9.700000");
      const hold = creditHoldUsd(HAIKU, { promptChars: charsOf(chatPrompt, INPUT) });
      const room = Math.floor((0.2 * 1_000_000) / Math.round(hold * 1_000_000));
      const outcomes = await Promise.all(Array.from({ length: room + 30 }, () => runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })));
      expect(outcomes.filter((o) => o.ok)).toHaveLength(room);
      expect(outcomes.filter(outOfCredit)).toHaveLength(30);
      expect(provider.calls).toBe(room);
      expect(await spent(id)).toBeLessThanOrEqual(10 - AI_CREDIT_SLACK_USD);
    });

    it("the company's credit row is locked for the hold: two calls take turns, and a company with no limit takes no lock", async () => {
      // PGlite runs one connection, so it cannot show a second transaction waiting (with TEST_DATABASE_URL this file runs on
      // Postgres, where the two tests above race for real). What it can show is the row lock itself: a row locked FOR UPDATE
      // carries the locking transaction's id in xmax until that transaction ends.
      const { id } = await newCompany();
      const lockOf = (tx: Parameters<Parameters<typeof withTenant>[2]>[0], key: string) => tx.execute(sql`select xmax::text as xmax, pg_current_xact_id()::text as me from entitlements where company_id = ${id} and key = ${key}`);
      const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ xmax: string; me: string }>;
      await withTenant(container.db, id, async (tx) => {
        expect(rowsOf(await lockOf(tx, "ai_credit_total_cents"))[0].xmax).toBe("0");
        expect(await reserveAiCredit(tx, { companyId: id, holdUsd: 0.02, now: new Date() })).toBe("held");
        const [row] = rowsOf(await lockOf(tx, "ai_credit_total_cents"));
        expect(row.xmax).toBe(row.me);
        // the row with no limit is not touched
        expect(rowsOf(await lockOf(tx, "ai_credit_monthly_cents"))[0].xmax).toBe("0");
      });
      const partner = await newCompany();
      await usePlan(container, partner.id, "design_partner");
      await withTenant(container.db, partner.id, async (tx) => {
        expect(await reserveAiCredit(tx, { companyId: partner.id, holdUsd: 0.02, now: new Date() })).toBe("unmetered");
        const rows = rowsOf(await tx.execute(sql`select xmax::text as xmax from entitlements where company_id = ${partner.id} and key in ('ai_credit_total_cents', 'ai_credit_monthly_cents')`));
        expect(rows.map((r) => r.xmax)).toEqual(["0", "0"]);
      });
    });

    it("readings ask together: with no room for all three, none is made, and nobody is read once", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      const hold = creditHoldUsd(HAIKU, { promptChars: charsOf(chatPrompt, INPUT) });
      // room for two
      await spend(id, Math.round((10 - AI_CREDIT_SLACK_USD - 2 * hold) * 1_000_000) / 1_000_000);
      const three = await runPromptsDetached(container.db, runtime(provider), chatPrompt, INPUT, [1, 2, 3].map((reading) => ({ companyId: id, inputRef: { reading } })));
      expect(three.map((o) => o.ok)).toEqual([false, false, false]);
      expect(three.every(outOfCredit)).toBe(true);
      expect(provider.calls).toBe(0);
      expect(await runsOf(id)).toEqual([]);
      // two fit: both go, each with its own row
      const two = await runPromptsDetached(container.db, runtime(provider), chatPrompt, INPUT, [1, 2].map((reading) => ({ companyId: id, inputRef: { reading } })));
      expect(two.map((o) => o.ok)).toEqual([true, true]);
      expect((await runsOf(id)).map((r) => r.inputRef.reading).sort()).toEqual([1, 2]);
    });

    it("keeps the hold as the cost when the real usage cannot be known, and the real numbers when they can", async () => {
      const { id } = await newCompany();
      const hold = creditHoldUsd(HAIKU, { promptChars: charsOf(chatPrompt, INPUT) });
      const provider = new PricedProvider();
      const said = (error: string, usage: Usage = NO_USAGE, over: { usageUnknown?: boolean } = {}) => { provider.answer = (_req, model) => ({ kind: "invalid", error, model, usage, latencyMs: 5, final: true, ...over }); };
      const lastCost = async () => { const rows = await runsOf(id); return Number(rows[rows.length - 1].costUsd); };
      // stopped at the deadline or dropped part-way, after a reply began: it may well have been billed
      said("provider error: the model did not finish within 270 seconds, so the call was stopped", NO_USAGE, { usageUnknown: true });
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "error" });
      expect(await lastCost()).toBeCloseTo(hold, 6);
      said("provider error: terminated", NO_USAGE, { usageUnknown: true });
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await lastCost()).toBeCloseTo(hold, 6);
      // the same words with no reply begun: a connection that never opened billed nothing
      said("provider error: Connection error.");
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await lastCost()).toBe(0);
      // a correction turn cut part-way after a first reply that was counted: never less than that reply cost, never less than the hold
      said("provider error: terminated", { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0 }, { usageUnknown: true });
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await lastCost()).toBeCloseTo(hold, 6);
      // a correction turn lost before any reply: the first reply's cost is all of it
      said("provider error: Connection error.", { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 });
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await lastCost()).toBeCloseTo(estimateCostUsd(HAIKU, { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 }), 6);
      // a local error wrapped the same way never reached anyone
      said("provider error: Cannot read properties of undefined (reading 'type')");
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await lastCost()).toBe(0);
      // an answer with an HTTP status wrote nothing, and a call never sent cost nothing
      said("provider error: 529 {\"type\":\"overloaded_error\"}");
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "error" });
      expect(await lastCost()).toBe(0);
      said("provider error: the request had no time left for the model, so it was not asked");
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await lastCost()).toBe(0);
      // an answer that was no use cost what it cost
      said("no valid output: bad", { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 });
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "invalid" });
      expect(await lastCost()).toBeCloseTo(estimateCostUsd(HAIKU, { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 }), 6);
      // a provider that threw
      provider.answer = () => { throw new Error("boom"); };
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "error" });
      expect(await lastCost()).toBeCloseTo(hold, 6);
    });

    it("an hour with no answer from the provider costs a Free company nothing: not $1.60 for one applicant, and not 80% of its credit for five", async () => {
      const { id, cookie } = await newCompany();
      const provider = new PricedProvider();
      provider.answer = (_req, model) => ({ kind: "invalid", error: "provider error: Connection error.", model, usage: NO_USAGE, latencyMs: 5, final: true });
      // what one applicant's reading tried in the outage: three readings and their three second tries, each of the 15 tries the engine gives it
      const hold = creditHoldUsd(HAIKU, { promptChars: charsOf(chatPrompt, INPUT) });
      for (let attempt = 0; attempt < 15; attempt++) {
        const [one, two, three] = await runPromptsDetached(container.db, runtime(provider), chatPrompt, INPUT, [1, 2, 3].map((reading) => ({ companyId: id, inputRef: { reading } })));
        for (const out of [one, two, three]) expect(out).toMatchObject({ ok: false, reason: "error" });
        for (const reading of [1, 2, 3]) await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id, inputRef: { reading } });
      }
      expect(provider.calls).toBe(90);
      // the same 90 calls, each keeping its hold of about 1.6 cents, were $1.44 of the $10 for this one applicant
      expect(90 * hold).toBeGreaterThan(1.4);
      expect(await spent(id)).toBe(0);
      const rows = await runsOf(id);
      expect(rows).toHaveLength(90);
      expect(rows.every((r) => r.status === "error" && Number(r.costUsd) === 0)).toBe(true);
      // five such applicants: nobody is told anything, and Home and ITS's page read what was really billed
      expect(await creditNotes(id)).toEqual([]);
      expect(await creditAlerts(id)).toEqual([]);
      const current = await planOf(cookie);
      expect(current.aiCredit).toMatchObject({ level: null, percent: 0 });
      // a stream that started and was cut still counts, at its hold of about 1.6 cents, so the real money in an outage stays in the sum
      provider.answer = (_req, model) => ({ kind: "invalid", error: "provider error: terminated", model, usage: NO_USAGE, latencyMs: 5, final: true, usageUnknown: true });
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect(await spent(id)).toBeCloseTo(hold, 6);
      expect(hold).toBeGreaterThan(0.015);
      expect(hold).toBeLessThan(0.017);
    });

    it("a call whose process went away stays counted at its hold, is no failure while it could still be running, and reads as one after", async () => {
      const { id } = await newCompany();
      await spend(id, "9.890000", { status: "running" });
      expect(await spent(id)).toBeCloseTo(9.89, 6);
      const provider = new PricedProvider();
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "no_credit" });
      const [stale] = await container.db.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.companyId, id), eq(aiRuns.status, "running")));
      const failures = async () => (await read<{ failedAi: Array<{ id: string; task: string }> }>(await json(admin, "GET", "/api/v1/admin/failures"))).failedAi.filter((r) => r.id === stale.id);
      expect(await failures()).toEqual([]);
      // still running: it holds its place in the credit and is on nobody's list of failures
      expect(await container.db.select({ status: aiRuns.status }).from(aiRuns).where(and(eq(aiRuns.companyId, id), eq(aiRuns.status, "running")))).toHaveLength(1);
      // the daily sweep: an hour on, nothing can still be running; its hold stays as its cost
      const report = await runMaintenance(container.db, new Date(Date.now() + 2 * 3600_000));
      expect(report.interruptedAiRuns).toBeGreaterThanOrEqual(1);
      expect(await spent(id)).toBeCloseTo(9.89, 6);
      expect((await failures()).map((r) => r.task)).toEqual(["test.spent"]);
    });

    it("the hourly check closes a call whose process went away once it is an hour old, keeping its hold as its cost, and never one that could still be running", async () => {
      const { id } = await newCompany();
      const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
      await spend(id, "0.800000", { status: "running", createdAt: ago(61) });
      await spend(id, "0.020000", { status: "running", createdAt: ago(4) });
      const report = await runHourlyChecks(container.db, new Date(), { workerInline: true });
      expect(report.interruptedAiRuns).toBeGreaterThanOrEqual(1);
      const rows = await container.db.select({ costUsd: aiRuns.costUsd, status: aiRuns.status, error: aiRuns.error }).from(aiRuns).where(eq(aiRuns.companyId, id));
      expect(rows.map((r) => `${r.costUsd} ${r.status}`).sort()).toEqual(["0.020000 running", "0.800000 error"]);
      expect(rows.find((r) => r.status === "error")?.error).toMatch(/^interrupted: /);
      // what the company spent does not change: the hold was money spent from its tenth minute
      expect(await spent(id)).toBeCloseTo(0.82, 6);
    });
  });

  describe("periods", () => {
    it("a monthly plan has room again next period, by date alone, and what was spent before does not count", async () => {
      const { id } = await newCompany();
      await usePlan(container, id, "basic");
      await spend(id, "19.950000");
      const provider = new PricedProvider();
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "no_credit" });
      expect(provider.calls).toBe(0);
      // the period ended: nobody wrote anything but the dates
      await withPlatform(container.db, (tx) => tx.update(entitlements).set({ periodStart: new Date(Date.now() - 40 * DAY).toISOString(), periodEnd: new Date(Date.now() - 10 * DAY).toISOString() }).where(and(eq(entitlements.companyId, id), eq(entitlements.key, "ai_credit_monthly_cents"))));
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ createdAt: new Date(Date.now() - 15 * DAY).toISOString() }).where(eq(aiRuns.companyId, id)));
      expect((await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).ok).toBe(true);
      const standing = (await withTenant(container.db, id, (tx) => aiCreditStanding(tx, id)))!;
      expect(standing).toMatchObject({ monthly: true, percent: 0, level: null, usedUp: false });
      expect(Date.parse(standing.resetsAt!)).toBeGreaterThan(Date.now());
    });

    it("a move down to Free gives no second credit: refused at once, for all that was ever spent", async () => {
      const { id } = await newCompany();
      await usePlan(container, id, "basic");
      await spend(id, "9.950000");
      const provider = new PricedProvider();
      expect((await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).ok).toBe(true);
      await usePlan(container, id, "free");
      expect(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).toMatchObject({ ok: false, reason: "no_credit" });
      expect(provider.calls).toBe(1);
    });
  });

  /** A candidate's page as they read it: its words, without its styles and scripts (and without this suite's own mail domain, which says "credit"). */
  const shown = async (path: string) => (await (await app.request(path)).text()).replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/&#39;/g, "'").replace(/@ai-credit\.test/g, "@example.test");
  /** What the builder's assistant answers when the plan's AI help stops its turn: the line, and with `upgrade` the request to offer beside it. */
  const noTurn = (recovery: string, upgrade: boolean, label = "Upgrade") => ({ error: "The assistant did not answer.", recovery, upgrade, ask: upgrade ? { label, reason: AI_HELP_UPGRADE_QUESTION } : null });

  describe("the job builder", () => {
    it("a new job stops before anyone types, in the plan's words, with an upgrade that asks about AI help", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "9.200000");
      // too little for a draft: it says what is true
      let room = await roomOf(cookie);
      expect(room).toMatchObject({ ok: false, upgrade: true, aiHelp: true, message: AI_HELP_LINE.newJobTooBig, holding: [] });
      expect(await withTenant(container.db, id, (tx) => aiCreditRoomForJob(tx, id))).toBe("too_low");
      await spend(id, "0.750000");
      room = await roomOf(cookie);
      expect(room).toMatchObject({ ok: false, upgrade: true, aiHelp: true, message: AI_HELP_LINE.newJob });
      const r = await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE });
      expect(r.status).toBe(402);
      const error = await errorOf(r);
      expect(error).toMatchObject({ code: "limit_reached", message: AI_HELP_LINE.newJob, details: { upgrade: true } });
      expect(error.details.ask).toEqual({ label: "Upgrade", reason: AI_HELP_UPGRADE_QUESTION });
      expect(await container.db.select().from(intakeSessions).where(eq(intakeSessions.companyId, id))).toEqual([]);
      expect(await runsOf(id)).toEqual([]);
    });

    it("a turn keeps the owner's words, offers an upgrade and nothing else, and records no failure", async () => {
      const { cookie, id } = await newCompany();
      const draft = await draftOf(cookie, HIRE_WITH_QUESTIONS);
      await spend(id, "9.950000");
      const runs = (await runsOf(id)).length;
      const r = await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/messages`, { message: "We also need Saturdays covered." });
      expect(r.status).toBe(200);
      const { reply, session } = await read<IntakeTurnResponse>(r);
      expect(reply).toEqual(noTurn(AI_HELP_LINE.turn, true));
      expect(session.messages.at(-1)).toMatchObject({ role: "owner", content: "We also need Saturdays covered." });
      // the same through an answered card: the answer is taken and kept, and only the assistant's next turn waits
      const place = draft.questions.find((q) => q.field === "location")!;
      const answered = await read<IntakeTurnResponse>(await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/answers`, { answers: [{ questionId: place.id, own: ["Austin, TX"] }], note: "And Sundays." }));
      expect(answered.reply).toEqual(noTurn(AI_HELP_LINE.turn, true));
      expect(answered.summary).toEqual(["Where the job is: Austin, TX"]);
      expect(answered.session.facts.locationText).toBe("Austin, TX");
      expect((await runsOf(id)).length).toBe(runs);
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
    });

    it("a pasted ad stays unread, so it is read after an upgrade", async () => {
      const { id, cookie } = await newCompany();
      await spend(id, "9.950000");
      const ad = "Registered Dental Hygienist wanted. ".repeat(60);
      const me = await read<{ user: { id: string } }>(await json(cookie, "GET", "/api/v1/auth/me"));
      const actor = { kind: "user" as const, id: me.user.id };
      const begun = await withTenant(container.db, id, (tx) => startIntakeSession(tx, { companyId: id, actor, userId: me.user.id, message: { content: ad, kind: "pasted_ad" } }));
      const out = await runIntakeTurn(container.db, { ai: container.ai }, { companyId: id, sessionId: begun.id, actor });
      expect(out).toMatchObject({ noCredit: true, error: AI_CREDIT_USED_UP });
      const [after] = await container.db.select().from(intakeSessions).where(eq(intakeSessions.id, begun.id));
      expect((after.serverState as { ad: { extracted: boolean } }).ad.extracted).toBe(false);
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
      expect(await runsOf(id)).toEqual([]);
      await upgrade(id);
      await runIntakeTurn(container.db, { ai: container.ai }, { companyId: id, sessionId: begun.id, actor });
      const [read2] = await container.db.select().from(intakeSessions).where(eq(intakeSessions.id, begun.id));
      expect((read2.serverState as { ad: { extracted: boolean } }).ad.extracted).toBe(true);
    });

    it("writing the job answers 402, never 502: everything is kept, progress never says failed, and nothing is on the record", async () => {
      const { cookie, id } = await newCompany();
      const draft = await draftOf(cookie);
      await spend(id, "9.950000");
      const r = await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/draft`);
      expect(r.status).toBe(402);
      const error = await errorOf(r);
      expect(error).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draft, details: { upgrade: true } });
      expect(error.details.ask).toEqual({ label: "Upgrade", reason: AI_HELP_UPGRADE_QUESTION });
      const { session } = await read<{ session: IntakeSessionView }>(await json(cookie, "GET", `/api/v1/intake/sessions/${draft.id}`));
      expect(session.progress).toBeNull();
      expect(session.messages.length).toBeGreaterThan(0);
      expect(session.readiness).toMatchObject({ mayDraft: true, hasDraft: false });
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
    });

    it("at real prices the writing stops first and says what is true, while the chat goes on", async () => {
      const { cookie, id } = await newCompany();
      const draft = await draftOf(cookie);
      await spend(id, "9.500000");
      await atRealPrices(async (provider) => {
        const r = await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/draft`);
        expect(r.status).toBe(402);
        expect(await errorOf(r)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draftTooBig });
        expect(provider.calls).toBe(0);
        const turn = await read<IntakeTurnResponse>(await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/messages`, { message: "We also need Saturdays covered." }));
        expect(turn.reply).toMatchObject({ assistantMessage: expect.any(String) });
        expect(provider.calls).toBe(1);
      });
    });

    it("a job already written can still be changed by hand and published: neither asks the model", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await writtenDraftOf(cookie);
      await spend(id, "9.950000");
      const runs = (await runsOf(id)).length;
      const edited = await json(cookie, "PATCH", `/api/v1/intake/sessions/${sessionId}/draft`, { identity: { title: "Senior Dental Hygienist" } });
      expect(edited.status, await edited.clone().text()).toBe(200);
      const published = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/publish`);
      expect(published.status, await published.clone().text()).toBe(201);
      const { roleId } = await read<{ roleId: string }>(published);
      await container.drain();
      expect(await read<{ status: string; title: string }>(await json(cookie, "GET", `/api/v1/roles/${roleId}`))).toMatchObject({ status: "open", title: "Senior Dental Hygienist" });
      // no model was asked for either, and nothing failed: the posts for its Share tab wait for AI help, as that tab says
      expect((await runsOf(id)).length).toBe(runs);
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
    });

    it("refused only for a running draft's hold, the owner reads what is true: try again in a few minutes, with no Upgrade and nothing used up", async () => {
      // the words below are real money: Basic stops at $19.90, $19.06 is settled, and another person's draft holds $0.84
      const { cookie, id } = await newCompany();
      const sessionId = await writtenDraftOf(cookie);
      await usePlan(container, id, "basic");
      await spend(id, "19.060000");
      await spend(id, "0.840000", { status: "running" });
      await atRealPrices(async (provider) => {
        // a turn: the words stay saved
        const turn = await read<IntakeTurnResponse>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Saturdays covered." }));
        expect(turn.reply).toEqual(noTurn(AI_HELP_BUSY_LINE.turn, false));
        expect(turn.session.messages.at(-1)).toMatchObject({ role: "owner", content: "We also need Saturdays covered." });
        // writing the job: its own hold fits on what is settled ($19.06 + about $0.80 is under $19.90)
        const draft = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
        expect(draft.status).toBe(409);
        const error = await errorOf(draft);
        expect(error).toMatchObject({ code: "ai_help_busy", message: AI_HELP_BUSY_LINE.draft });
        expect(error.details?.upgrade).toBeUndefined();
        // and the text about the company
        const about = await json(cookie, "POST", "/api/v1/companies/current/about/draft", {});
        expect(about.status).toBe(409);
        expect(await errorOf(about)).toMatchObject({ code: "ai_help_busy", message: AI_HELP_BUSY_LINE.about });
        expect(provider.calls).toBe(0);
      });
      // nobody was told it is used up, and a new job is not refused for a hold that comes back
      expect((await creditNotes(id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      expect(await withTenant(container.db, id, (tx) => aiCreditRoomForJob(tx, id))).toBe("ok");
      // once it settled at about $0.10, the same turn goes
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ status: "ok", costUsd: "0.100000" }).where(and(eq(aiRuns.companyId, id), eq(aiRuns.status, "running"))));
      await atRealPrices(async (provider) => {
        const turn = await read<IntakeTurnResponse>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Sundays covered." }));
        expect(turn.reply).toMatchObject({ assistantMessage: expect.any(String) });
        expect(provider.calls).toBe(1);
      });
    });

    it("a draft's hold whose process went away is money spent once no call could still be running: Write the job says it is too big, and every page reads what the gate reads", async () => {
      // the words below are real money: Basic stops at $19.90, $19.06 is settled, and a draft holding $0.80 lost its process
      const { cookie, id } = await newCompany();
      const sessionId = await writtenDraftOf(cookie);
      await usePlan(container, id, "basic");
      await monthBegan(id, 3_600_000);
      await spend(id, "19.060000");
      // nine minutes after its hold it may still be running (a call's own budget is 4.5 minutes): try again in a few minutes
      await spend(id, "0.800000", { status: "running", createdAt: new Date(Date.now() - 9 * 60_000).toISOString() });
      await atRealPrices(async () => {
        const draft = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
        expect(draft.status).toBe(409);
        expect(await errorOf(draft)).toMatchObject({ code: "ai_help_busy", message: AI_HELP_BUSY_LINE.draft });
      });
      // eleven minutes after it, no call can still be running: the $0.80 is spent, $19.86 of $20, and the draft's own hold no longer fits
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ createdAt: new Date(Date.now() - 11 * 60_000).toISOString() }).where(and(eq(aiRuns.companyId, id), eq(aiRuns.status, "running"))));
      await atRealPrices(async (provider) => {
        const draft = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
        expect(draft.status).toBe(402);
        expect(await errorOf(draft)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draftTooBig, details: { upgrade: true } });
        expect(provider.calls).toBe(0);
      });
      // Home, Settings, ITS's line and Start a hire read the same $19.86: 99%, and a new job has stopped
      const current = await planOf(cookie);
      expect(current.aiCredit).toMatchObject({ level: "warning", percent: 99 });
      expect(current.aiCredit.notice.body).toBe("New jobs have stopped: writing one needs more than is left. Upgrade before the rest runs out.");
      expect(current.usage.ai_credit_monthly_cents.used).toBe(99);
      const line = (await read<Array<{ id: string; aiCredit: { spentUsd: number; percent: number } | null }>>(await json(admin, "GET", "/api/v1/admin/customers"))).find((c) => c.id === id)!.aiCredit;
      expect(line).toMatchObject({ spentUsd: 19.86, percent: 99 });
      expect(await withTenant(container.db, id, (tx) => aiCreditRoomForJob(tx, id))).toBe("too_low");
      expect(await roomOf(cookie)).toMatchObject({ ok: false, message: AI_HELP_LINE.newJobTooBig });
      // and what the gate counted all along: the stale hold, and room for no draft
      expect(await spent(id)).toBeCloseTo(19.86, 6);
      expect(await withTenant(container.db, id, (tx) => aiCreditRoomSoon(tx, { companyId: id, holdUsd: AI_CREDIT_DRAFT_HOLD_USD, now: new Date() }))).toBe(false);
    });

    it("the same refusals with the money really spent say used up, or that the job is too big to write, and offer the Upgrade", async () => {
      const { cookie, id } = await newCompany();
      const draft = await draftOf(cookie);
      await usePlan(container, id, "basic");
      // $19.50 settled and $0.39 in flight: a small call fits only once the hold settles, but the writing's $0.80 never fits
      await spend(id, "19.500000");
      await spend(id, "0.390000", { status: "running" });
      await atRealPrices(async () => {
        const written = await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/draft`);
        expect(written.status).toBe(402);
        expect(await errorOf(written)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draftTooBig, details: { upgrade: true } });
      });
      await spend(id, "0.390000");
      await atRealPrices(async () => {
        const turn = await read<IntakeTurnResponse>(await json(cookie, "POST", `/api/v1/intake/sessions/${draft.id}/messages`, { message: "We also need Saturdays covered." }));
        expect(turn.reply).toEqual(noTurn(AI_HELP_LINE.turn, true));
      });
    });

    it("the text about the company answers 402 and says they can write it; approving their own text still works", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "9.950000");
      const r = await json(cookie, "POST", "/api/v1/companies/current/about/draft", {});
      expect(r.status).toBe(402);
      expect(await errorOf(r)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.about, details: { upgrade: true } });
      const own = await json(cookie, "POST", "/api/v1/companies/current/about", { text: "We are a friendly dental practice in Irvine, looking after families for twenty years." });
      expect(own.status, await own.clone().text()).toBe(200);
    });

    it("on Ultra, the last plan, nothing in the job builder or Start a hire says to upgrade: talk with ITS, or wait for the day it starts again, and the button says Talk to ITS", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await writtenDraftOf(cookie);
      await usePlan(container, id, "ultra");
      // Ultra's $200 a month, with $199.95 spent: a small call no longer fits under $199.90, so it is used up
      await spend(id, "199.950000");
      const home = await planOf(cookie);
      expect(home.aiCredit.level).toBe("used_up");
      // the day it starts again, in the words Home already uses
      const day = /until it starts again on (\w+, \w+ \d+)\.$/.exec(home.aiCredit.notice.body)?.[1];
      expect(day).toBeTruthy();
      const way = `Talk with ITS, or wait until your AI help starts again on ${day}.`;
      /** The request as a 402 and the room carry it: the button's words, and the reason sent with POST /api/v1/plans/request. */
      const asksIts = (ask: { label: string; reason: string } | null) => expect(ask).toEqual({ label: "Talk to ITS", reason: AI_HELP_UPGRADE_QUESTION });
      const runs = (await runsOf(id)).length;
      const said: string[] = [];

      // Start a hire, before anyone types: the room, on Home and beside the drafts
      const room = await roomOf(cookie);
      expect(room).toMatchObject({ ok: false, upgrade: true, aiHelp: true, nothingAbove: true, message: `Your plan's AI help is used up. ${way}` });
      asksIts(room.ask);
      const start = await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE });
      expect(start.status).toBe(402);
      const refused = await errorOf(start);
      expect(refused).toMatchObject({ code: "limit_reached", message: room.message, details: { upgrade: true, room: { nothingAbove: true } } });
      asksIts(refused.details.ask);
      said.push(refused.message, refused.details.ask?.label ?? "");

      // a turn on the draft: their words saved, and the way on is ITS
      const turn = await read<IntakeTurnResponse>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Saturdays covered." }));
      const recovery = `Your plan's AI help is used up. Your draft is saved. ${way}`;
      expect(turn.reply).toEqual(noTurn(recovery, true, "Talk to ITS"));
      said.push(recovery);

      // Write the job and the text about the company: 402, with the same button
      const draft = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
      expect(draft.status).toBe(402);
      const draftRefused = await errorOf(draft);
      expect(draftRefused).toMatchObject({ code: "ai_credit_used_up", message: `Your plan's AI help is used up. Everything you confirmed is kept. ${way}`, details: { upgrade: true } });
      asksIts(draftRefused.details.ask);
      const about = await json(cookie, "POST", "/api/v1/companies/current/about/draft", {});
      expect(about.status).toBe(402);
      const aboutRefused = await errorOf(about);
      expect(aboutRefused).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.about });
      asksIts(aboutRefused.details.ask);
      said.push(draftRefused.message, draftRefused.details.ask?.label ?? "", aboutRefused.message, aboutRefused.details.ask?.label ?? "");
      for (const words of said) expect(words).not.toMatch(/upgrade/i);
      // and no model was asked
      expect((await runsOf(id)).length).toBe(runs);
    });
  });

  describe("an application still arrives", () => {
    it("the candidate gets the one email with their link now, and nothing false is raised; they reach New unscored, saying why, and the reading waits for the company's signal", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Ana", last: "Silva", email: "ana@ai-credit.test" });
      expect(a).toMatchObject({ stage: "triaged", extraction: null });
      const mails = mailTo("ana@ai-credit.test");
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain(`/c/status/${a.statusToken}`);
      // nothing about plans or money reaches the candidate, in the email or on their own page
      expect(`${mails[0].subject} ${mails[0].text}`).not.toMatch(/\bplan\b|credit|upgrade|AI help/i);
      const page = await shown(`/c/status/${a.statusToken}`);
      expect(page).toContain("The hiring team is reviewing your application.");
      expect(page.match(/\bplans?\b|credit|upgrade|AI help|used up|\bscore/i)).toBeNull();
      expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toEqual([]);
      // the team reads why there is no score, and the record says so
      expect((await panelOf(job, a.id)).cvScore).toMatchObject({ score: null, noScore: "ai_used_up", noScoreLabel: CV_NO_SCORE_LABEL.ai_used_up });
      const triaged = await container.db.select({ payload: events.payload }).from(events).where(and(eq(events.subjectId, a.id), eq(events.type, "application.triaged")));
      expect(triaged.map((e) => e.payload)).toEqual([{ assessmentId: null, noScore: "ai_used_up" }]);
      // the model was never asked, so no run, and no retry: the run waits, with a long timer on the company's own signal
      expect((await runsOf(job.id)).filter((r) => r.task === "resume.extract" || r.task === "triage.assess")).toEqual([]);
      const run = await runOf("application_intake", a.id);
      expect(run.status).toBe("waiting");
      expect(run.attempts).toBe(0);
      expect(run.currentStep).toBe("extract");
      expect(run.wait).toMatchObject({ kind: "event", eventTypes: [AI_CREDIT_AVAILABLE] });
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeGreaterThan(29 * DAY);
      // no poll every few hours: one look so far, and one wait
      expect(await container.db.select().from(workflowSteps).where(and(eq(workflowSteps.runId, run.id), eq(workflowSteps.stepKey, "extract")))).toHaveLength(1);
      await noFalseAlarm(job.id, [a.id]);
      // the owner hears once, about the company, never about the person
      const notes = await creditNotes(job.id);
      expect(notes.map((n) => n.title)).toEqual(["Your plan's AI help is used up"]);
      expect(JSON.stringify(notes)).not.toContain("Ana");
      expect((await container.db.select().from(notifications).where(eq(notifications.companyId, job.id))).filter((n) => JSON.stringify(n).includes("Ana"))).toEqual([]);
      // a second applicant tells nobody again
      await apply(job, { first: "Ben", last: "Okafor", email: "ben@ai-credit.test" });
      expect(await creditNotes(job.id)).toHaveLength(1);
      // and nobody new is sent an AI interview while the AI help is used up: the plan's own reason, with the way to more
      const refused = await act(job, a.id, "shortlist");
      expect(refused.status).toBe(402);
      const error = await errorOf(refused);
      expect(error).toMatchObject({ code: "limit_reached", message: ACTION_BLOCKED.aiUsedUp, details: { upgrade: true } });
      expect(error.details.ask).toEqual({ label: "Upgrade", reason: AI_HELP_UPGRADE_QUESTION });
      expect((await applicationOf(a.id)).stage).toBe("triaged");
    });

    it("after an upgrade the signal wakes the waiting reading: they are read where they stand, and nothing else moves", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Cy", last: "Rao", email: "cy@ai-credit.test" });
      expect((await runOf("application_intake", a.id)).status).toBe("waiting");
      await upgrade(job.id);
      const after = await applicationOf(a.id);
      expect(after.stage).toBe("triaged");
      expect(after.extraction).toBeTruthy();
      expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).map((x) => x.kind)).toEqual(["triage"]);
      expect((await runOf("application_intake", a.id)).status).toBe("completed");
      const scored = (await panelOf(job, a.id)).cvScore;
      expect(scored.noScore).toBeNull();
      expect(typeof scored.score).toBe("number");
      // one email all along
      expect(mailTo("cy@ai-credit.test")).toHaveLength(1);
      await noFalseAlarm(job.id, [a.id]);
    });

    it("a reading refused only for a running draft's hold says nothing is used up: the person is still being read, and is read a few minutes later", async () => {
      const job = await openJob();
      await usePlan(container, job.id, "basic");
      // Basic stops at $19.90: $19.06 settled, and a draft holding about $0.80 for two minutes
      await spend(job.id, "19.060000");
      await spend(job.id, "0.800000", { status: "running" });
      const a = await atRealPrices(() => apply(job, { first: "Ned", last: "Ash", email: "ned@ai-credit.test" }));
      // nobody waits on money to hear from us: the one email went, with their link
      const mails = mailTo("ned@ai-credit.test");
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain(`/c/status/${a.statusToken}`);
      // not read yet, and not marked as unscored either: the team reads that the resume is being read
      expect(a.stage).toBe("received");
      expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toEqual([]);
      expect((await panelOf(job, a.id)).cvScore).toMatchObject({ score: null, noScore: "being_read", noScoreLabel: CV_NO_SCORE_LABEL.being_read });
      const run = await runOf("application_intake", a.id);
      expect(run.status).toBe("waiting");
      expect(run.wait).toMatchObject({ kind: "event", eventTypes: [AI_CREDIT_AVAILABLE] });
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      // not parked until the period's end, and nothing on the record says used up
      expect(await container.db.select().from(events).where(and(eq(events.subjectId, a.id), eq(events.type, "application.triaged")))).toEqual([]);
      expect((await creditNotes(job.id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      // the draft settles at about $0.10; the next look reads them
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ status: "ok", costUsd: "0.100000" }).where(and(eq(aiRuns.companyId, job.id), eq(aiRuns.status, "running"))));
      await atRealPrices(async () => {
        try {
          moveClock(Date.now() + 16 * 60_000);
          await container.drain();
        } finally {
          moveClock(null);
        }
      });
      expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).map((x) => x.kind)).toEqual(["triage"]);
      expect((await runOf("application_intake", a.id)).status).toBe("completed");
      expect((await applicationOf(a.id)).stage).toBe("triaged");
      expect(mailTo("ned@ai-credit.test")).toHaveLength(1);
      expect((await creditNotes(job.id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
    });

    it("a waiting reading on a monthly plan looks again by itself at the period's end, with no event", async () => {
      const job = await openJob();
      await usePlan(container, job.id, "basic");
      await spend(job.id, "19.950000");
      const a = await apply(job, { first: "Dee", last: "Lam", email: "dee@ai-credit.test" });
      const run = await runOf("application_intake", a.id);
      const [row] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, job.id), eq(entitlements.key, "ai_credit_monthly_cents")));
      expect(run.status).toBe("waiting");
      expect(run.wait?.until).toBe(row.periodEnd);
      try {
        moveClock(Date.parse(row.periodEnd!) + 60_000);
        await container.drain();
        expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).map((x) => x.kind)).toEqual(["triage"]);
        expect((await runOf("application_intake", a.id)).status).toBe("completed");
      } finally {
        moveClock(null);
      }
    });

    it("someone who left while their resume reading waited for credit is not read after an upgrade, and no credit is spent on them", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Lou", last: "Park", email: "lou@ai-credit.test" });
      expect((await runOf("application_intake", a.id)).status).toBe("waiting");
      const decided = await act(job, a.id, "reject");
      expect(decided.status, await decided.clone().text()).toBe(200);
      await upgrade(job.id);
      expect((await runOf("application_intake", a.id)).status).toBe("completed");
      expect((await runsOf(job.id)).filter((r) => ["resume.extract", "triage.assess"].includes(r.task))).toEqual([]);
      expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toEqual([]);
      expect((await applicationOf(a.id)).stage).toBe("rejected");
      await noFalseAlarm(job.id, [a.id]);
    });
  });

  describe("a candidate's AI interview", () => {
    it("carries on in the job's own words, can be finished and sent, and the candidate cannot tell; the team reads the answers while the score waits", async () => {
      const job = await openJob();
      const { a, ref } = await started(job, { first: "Eva", last: "Noor", email: "eva@ai-credit.test" });
      await spend(job.id, "9.950000");
      const first = (await conversationView(container.db, ref))!;
      const firstKey = first.current!.key;

      // only a question, or only confusion: not an answer. The question again, with how to choose a person.
      for (const message of ["What does it pay?", "What do you mean?"]) {
        const r = await conversationTurn(container, ref, { message });
        expect(r).toMatchObject({ kind: "reply", review: false, withdrawn: false, message: `${first.current!.question}\n\n${PERSON_OFFER}` });
        const v = (await conversationView(container.db, ref))!;
        expect(v.current?.key).toBe(firstKey);
        expect(v.current?.answered).toBe(false);
      }

      // what they typed is the answer, through the same redaction as ever, and the next question comes in the job's own words
      const said = await conversationTurn(container, ref, { message: `${ANSWER} I am 52 years old.` });
      expect(said.kind).toBe("reply");
      const reply = (said as { message: string }).message;
      expect(reply).toMatch(/^Thanks\.\n\n/);
      const next = (await conversationView(container.db, ref))!;
      expect(reply).toContain(next.current!.question);
      expect(next.current!.key).not.toBe(firstKey);
      let scr = await screenOf(a.id);
      expect(scr.answers[firstKey]).toBe(ANSWER);
      // a reply worked out in code carries no run, so it counts toward no cap
      expect(scr.transcript.filter((t) => t.role === "assistant").every((t) => !t.aiRunId)).toBe(true);
      expect(scr.progress.failures).toBe(0);
      expect(scr.status).toBe("in_progress");

      // to the end: "check your answers", with no words about plans or money anywhere the candidate reads
      const end = await answerToTheEnd(ref);
      expect(end.phase).toBe("review");
      expect(JSON.stringify(end.transcript) + JSON.stringify(end.review)).not.toMatch(/\bplans?\b|credit|upgrade|AI help|used up/i);
      expect(await conversationSubmit(container, ref)).toBe(true);
      await container.drain();
      scr = await screenOf(a.id);
      expect(scr.status).toBe("completed");
      expect((await applicationOf(a.id)).stage).toBe("screen_complete");
      expect((await runsOf(job.id)).filter((r) => ["screen.turn", "screen.assess"].includes(r.task))).toEqual([]);

      // the scorecard waits for the company's signal, and the interview says so; nothing failed and nobody was paged
      expect(scr.progress.scoreWaitsForCredit).toBeTruthy();
      expect(scr.assessmentId).toBeNull();
      const run = await runOf("screen", a.id);
      expect(run).toMatchObject({ status: "waiting", currentStep: "score", attempts: 0 });
      expect(run.wait).toMatchObject({ kind: "event", eventTypes: [AI_CREDIT_AVAILABLE] });
      await noFalseAlarm(job.id, [a.id]);
      expect(await creditNotes(job.id)).toHaveLength(1);
      // the team is told she finished, as for anyone, and nothing else about her was written
      expect((await container.db.select().from(notifications).where(eq(notifications.companyId, job.id))).filter((n) => JSON.stringify(n).includes("Eva")).map((n) => n.title)).toEqual(["Eva Noor finished the AI interview"]);

      // the candidate's pages say what they say for anyone: sent, and never a word about a score, a plan or money
      const closed = await shown(`/c/screen/${ref.token}`);
      expect(closed).toContain("Thanks, your answers are sent");
      for (const page of [closed, await shown(`/c/status/${a.statusToken}`)]) expect(page.match(/\bscore|\bplans?\b|credit|upgrade|AI help|used up/i)).toBeNull();

      // the team reads the answers, and where the score would be it says why there is none; the resume's number never stands in for it
      const waiting = await panelOf(job, a.id);
      expect(waiting.aiInterview?.score).toMatchObject({ score: null, noScore: "ai_used_up", noScoreLabel: INTERVIEW_NO_SCORE_LABEL.ai_used_up });
      expect(waiting.aiInterview?.answers.map((x) => x.answer)).toContain(ANSWER);
      expect(typeof waiting.cvScore.score).toBe("number");

      // after an upgrade it is scored, the mark goes, and nothing failed
      await upgrade(job.id);
      scr = await screenOf(a.id);
      expect(scr.progress.scoreWaitsForCredit).toBeUndefined();
      expect(scr.assessmentId).toBeTruthy();
      expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).map((x) => x.kind).sort()).toEqual(["screen", "triage"]);
      const scored = (await panelOf(job, a.id)).aiInterview?.score;
      expect(scored?.noScore).toBeNull();
      expect(typeof scored?.score).toBe("number");
      expect((await runOf("screen", a.id)).status).toBe("completed");
      await noFalseAlarm(job.id, [a.id]);
      // and the candidate's page reads as it did: nothing there ever depended on the score
      expect(await shown(`/c/screen/${ref.token}`)).toContain("Thanks, your answers are sent");
    });

    /** An AI interview sent on a Basic job, the resume read and `settled` of the $20 spent, with `inFlight` held by a draft still running, its hold taken `heldAgoMs` ago. */
    const sentOnBasic = async (who: { first: string; last: string; email: string }, settled: string, inFlight: string | null, heldAgoMs = 0) => {
      const job = await openJob();
      await usePlan(container, job.id, "basic");
      const { a, ref } = await started(job, who);
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      await spend(job.id, settled);
      if (heldAgoMs) await monthBegan(job.id, heldAgoMs + 3_600_000);
      if (inFlight) await spend(job.id, inFlight, { status: "running", ...(heldAgoMs ? { createdAt: new Date(Date.now() - heldAgoMs).toISOString() } : {}) });
      await atRealPrices(async () => {
        expect(await conversationSubmit(container, ref)).toBe(true);
        await container.drain();
      });
      return { job, a, ref };
    };

    it("a scorecard refused only for a running draft's hold: no used-up words, a look in minutes, and it is scored once the draft settles at its real cost", async () => {
      // 19.06 + 0.80 + the three readings' hold of about 6 cents = 19.92, past Basic's $19.90
      const { job, a } = await sentOnBasic({ first: "Oli", last: "Vane", email: "oli@ai-credit.test" }, "19.060000", "0.800000");
      let scr = await screenOf(a.id);
      expect(scr.status).toBe("completed");
      expect(scr.assessmentId).toBeNull();
      expect(scr.progress.scoreWaitsForCredit).toBeUndefined();
      const run = await runOf("screen", a.id);
      expect(run).toMatchObject({ status: "waiting", currentStep: "score", attempts: 0 });
      expect(run.wait).toMatchObject({ kind: "event", eventTypes: [AI_CREDIT_AVAILABLE] });
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      // everything says what is true: being scored, with 95% settled and not used up
      expect((await panelOf(job, a.id)).aiInterview?.score).toMatchObject({ noScore: "being_scored", noScoreLabel: INTERVIEW_NO_SCORE_LABEL.being_scored });
      expect((await creditNotes(job.id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      const current = await planOf(job.cookie);
      expect(current.aiCredit).toMatchObject({ level: "warning", percent: 95 });
      expect(await creditAlerts(job.id).then((rows) => rows.map((r) => r.kind))).toEqual(["billing.ai_credit_warning"]);
      await noFalseAlarm(job.id, [a.id]);

      // two minutes on, the draft settles at about $0.10: at the next look there is room, and it is scored
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ status: "ok", costUsd: "0.100000" }).where(and(eq(aiRuns.companyId, job.id), eq(aiRuns.status, "running"))));
      await atRealPrices(async (provider) => {
        const before = provider.calls;
        try {
          moveClock(Date.now() + 16 * 60_000);
          await container.drain();
        } finally {
          moveClock(null);
        }
        expect(provider.calls).toBe(before + 3);
      });
      scr = await screenOf(a.id);
      expect(scr.assessmentId).toBeTruthy();
      expect(scr.progress.scoreWaitsForCredit).toBeUndefined();
      expect((await runOf("screen", a.id)).status).not.toBe("waiting");
    });

    it("the same interview with the money really spent: it waits to the period's end, in the used-up words, and the owner is told", async () => {
      // $19.86 settled and nothing running: the three readings' 6 cents make 19.92 whatever settles, and money spent never comes back
      const { job, a } = await sentOnBasic({ first: "Pia", last: "Wren", email: "pia@ai-credit.test" }, "19.860000", null);
      const scr = await screenOf(a.id);
      expect(scr.progress.scoreWaitsForCredit).toBeTruthy();
      const run = await runOf("screen", a.id);
      const [credit] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, job.id), eq(entitlements.key, "ai_credit_monthly_cents")));
      expect(run.wait?.until).toBe(credit.periodEnd);
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeGreaterThan(29 * DAY);
      expect((await panelOf(job, a.id)).aiInterview?.score).toMatchObject({ noScore: "ai_used_up", noScoreLabel: INTERVIEW_NO_SCORE_LABEL.ai_used_up });
      expect((await creditNotes(job.id)).map((n) => n.title)).toContain("Your plan's AI help is used up");
      // ITS moves them to Pro while something big is running: nothing is used up any more, so the mark and its words go, and it looks again soon
      await spend(job.id, "59.950000", { status: "running" });
      await atRealPrices(() => upgrade(job.id, "pro"));
      expect((await screenOf(a.id)).progress.scoreWaitsForCredit).toBeUndefined();
      expect(Date.parse((await runOf("screen", a.id)).wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      expect((await screenOf(a.id)).assessmentId).toBeNull();
      expect((await panelOf(job, a.id)).aiInterview?.score).toMatchObject({ noScore: "being_scored" });
    });

    it("a scorecard refused for a draft's hold whose process went away parks in the used-up words, which are true, and does not look again every 15 minutes for a day", async () => {
      // 19.06 settled + 0.80 held by a draft whose process died 11 minutes ago + the three readings' 6 cents = 19.92: the hold never settles
      const { job, a } = await sentOnBasic({ first: "Quin", last: "Rook", email: "quin@ai-credit.test" }, "19.060000", "0.800000", 11 * 60_000);
      const scr = await screenOf(a.id);
      expect(scr.status).toBe("completed");
      expect(scr.assessmentId).toBeNull();
      expect(scr.progress.scoreWaitsForCredit).toBeTruthy();
      const run = await runOf("screen", a.id);
      const [credit] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, job.id), eq(entitlements.key, "ai_credit_monthly_cents")));
      expect(run).toMatchObject({ status: "waiting", currentStep: "score", attempts: 0 });
      expect(run.wait?.until).toBe(credit.periodEnd);
      // the team reads "not scored" where the score would be, with the answers to read, and the owner is told it is used up, as the gate says
      expect((await panelOf(job, a.id)).aiInterview?.score).toMatchObject({ noScore: "ai_used_up" });
      expect((await creditNotes(job.id)).map((n) => n.title)).toContain("Your plan's AI help is used up");
      await noFalseAlarm(job.id, [a.id]);
    });

    it("the line between the two, in real money: what is settled plus the three readings' hold, against the limit less the slack", async () => {
      const hold = async (holdUsd: number, settled: string) => {
        const { id } = await newCompany();
        await usePlan(container, id, "basic");
        await spend(id, settled);
        await spend(id, "0.800000", { status: "running" });
        return withTenant(container.db, id, (tx) => aiCreditRoomSoon(tx, { companyId: id, holdUsd, now: new Date() }));
      };
      expect(await hold(0.06, "19.840000")).toBe(true); // 19.90 exactly still fits
      expect(await hold(0.06, "19.840001")).toBe(false);
      expect(await hold(0.02, "19.870000")).toBe(true); // a single small call fits where three readings do not
      expect(await hold(0.06, "19.870000")).toBe(false);
    });

    it("Change plan just after the refusal, before the step's own transaction: the run does not park for a month on a plan with room", async () => {
      const job = await openJob();
      const { a, ref } = await started(job, { first: "Sia", last: "Zane", email: "sia@ai-credit.test" });
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      await spend(job.id, "9.950000");
      // the refusal, and straight after it ITS moves the company to Basic, while the run is still "running", so the signal finds nobody
      const gate = container.ai.credit!;
      const hold = gate.hold;
      let moved = false;
      gate.hold = async (db, input) => {
        const verdict = await hold(db, input);
        if (verdict === "refused" && !moved) {
          moved = true;
          // the worker is in the middle of this very step, so the route's own look at the queue waits for it
          const kick = container.kick;
          container.kick = async () => {};
          try {
            const r = await json(admin, "POST", `/api/v1/admin/customers/${job.id}/plan`, { planKey: "basic", reason: "They asked to upgrade." });
            expect(r.status, await r.clone().text()).toBe(200);
          } finally {
            container.kick = kick;
          }
        }
        return verdict;
      };
      try {
        expect(await conversationSubmit(container, ref)).toBe(true);
        await container.drain();
      } finally {
        gate.hold = hold;
      }
      expect(moved).toBe(true);
      // the step looked again, behind the rows: room, no mark, and no wait to the end of the new month
      const run = await runOf("screen", a.id);
      expect(run.status).toBe("waiting");
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      expect((await screenOf(a.id)).progress.scoreWaitsForCredit).toBeUndefined();
      expect((await panelOf(job, a.id)).aiInterview?.score).toMatchObject({ noScore: "being_scored" });
      try {
        moveClock(Date.now() + 16 * 60_000);
        await container.drain();
      } finally {
        moveClock(null);
      }
      expect((await screenOf(a.id)).assessmentId).toBeTruthy();
    });

    it("a step about to wait holds the credit's row until it commits, so a change of plan takes its turn; only the limited row", async () => {
      const { id } = await newCompany();
      const rowsOf = (result: unknown) => (Array.isArray(result) ? result : (result as { rows: unknown[] }).rows) as Array<{ key: string; xmax: string; me: string }>;
      await withTenant(container.db, id, async (tx) => {
        await holdAiCreditRows(tx, id);
        const rows = rowsOf(await tx.execute(sql`select key, xmax::text as xmax, pg_current_xact_id()::text as me from entitlements where company_id = ${id} and key in ('ai_credit_total_cents', 'ai_credit_monthly_cents') order by key`));
        expect(rows.map((r) => r.key)).toEqual(["ai_credit_monthly_cents", "ai_credit_total_cents"]);
        expect(rows[0].xmax).toBe("0");
        expect(rows[1].xmax).toBe(rows[1].me);
      });
    });

    it("at real prices it uses the model while a turn's hold fits, then goes on in code, in the same chat", async () => {
      const job = await openJob();
      const { a, ref } = await started(job, { first: "Kai", last: "Moss", email: "kai@ai-credit.test" });
      await spend(job.id, "9.700000");
      await atRealPrices(async (provider) => {
        expect((await conversationTurn(container, ref, { message: ANSWER })).kind).toBe("reply");
        expect(provider.calls).toBe(1);
        expect((await screenOf(a.id)).transcript.at(-1)?.aiRunId).toBeTruthy();
        // what a real turn on Haiku holds is about two cents: at $9.95 it no longer fits
        const [held] = (await runsOf(job.id)).filter((r) => r.task === "screen.turn");
        expect(held.status).toBe("ok");
        await spend(job.id, "0.250000");
        const turn = await conversationTurn(container, ref, { message: ANSWER });
        expect(turn.kind).toBe("reply");
        expect(provider.calls).toBe(1);
        const after = await screenOf(a.id);
        expect(after.transcript.at(-1)?.aiRunId).toBeUndefined();
        expect(after.transcript.at(-1)?.content).toMatch(/^Thanks\./);
        expect((await runsOf(job.id)).filter((r) => r.task === "screen.turn")).toHaveLength(1);
      });
      await noFalseAlarm(job.id, [a.id]);
    });

    it("a turn that cannot read the credit in time says to send that again on the page it is on, never a raw error, and then goes on", async () => {
      const job = await openJob();
      const { ref } = await started(job, { first: "Tess", last: "Abel", email: "tess@ai-credit.test" });
      const gate = container.ai.credit!;
      const hold = gate.hold;
      // as the driver and the query builder report it, 15 seconds behind a long Change plan
      const timedOut = () => Object.assign(new Error("Failed query"), { cause: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }) });
      gate.hold = async () => { throw timedOut(); };
      try {
        const posted = await app.request(`/c/screen/${ref.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: ANSWER }).toString() });
        expect(posted.status).toBe(302);
        const location = posted.headers.get("location")!;
        expect(location).toContain("error=trouble");
        const page = await shown(location);
        expect(page).toContain("Something went wrong on our end. Please send that again in a minute.");
        expect(page).not.toMatch(/\bplan\b|credit|upgrade|lock timeout/i);
        // no outage, no alert and nothing about money
        expect(await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND))).toEqual([]);
        expect(await creditNotes(job.id)).toEqual([]);
      } finally {
        gate.hold = hold;
      }
      // sent again, it goes on
      expect((await conversationTurn(container, ref, { message: ANSWER })).kind).toBe("reply");
    });

    it("a skip and a request for a person work as ever: neither needs the model", async () => {
      const job = await openJob();
      const { a, ref } = await started(job, { first: "Fay", last: "Oren", email: "fay@ai-credit.test" });
      await spend(job.id, "9.950000");
      const before = (await conversationView(container.db, ref))!;
      expect((await conversationTurn(container, ref, { skip: true })).kind).toBe("reply");
      const after = (await conversationView(container.db, ref))!;
      expect(after.current?.key).not.toBe(before.current?.key);
      // HUMAN closes nothing: the chat says how to choose a person
      expect(await conversationTurn(container, ref, { message: "HUMAN" })).toMatchObject({ kind: "reply", message: PERSON_REPLY });
      expect((await screenOf(a.id)).status).toBe("in_progress");
      // the choice itself, made on the page: the team is told she chose so, whatever the credit says
      expect(await conversationPerson(container, ref)).toBeTruthy();
      await container.drain();
      expect((await screenOf(a.id)).status).toBe("declined_by_candidate");
      expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, job.id), eq(notifications.kind, "screen.declined_by_candidate")))).map((n) => n.title)).toEqual(["Fay Oren chose not to do the AI interview"]);
      expect((await runsOf(job.id)).filter((r) => r.task === "screen.turn")).toEqual([]);
    });
  });

  describe("who is told", () => {
    const money = /\$\s?\d|\bdollars?\b|\bcents?\b/i;

    it("the owner hears once at 80% and once at used up, in words; ITS gets one alert each, in dollars, never critical", async () => {
      const { id, cookie } = await newCompany();
      const provider = new PricedProvider();
      const call = () => runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      await spend(id, "7.999950");
      expect((await call()).ok).toBe(true);
      // a real call's cost took it over the 80% line
      let notes = await creditNotes(id);
      expect(notes.map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      expect(notes[0].body).toBe("Nothing has stopped. Upgrade before it runs out.");
      expect(notes[0].action).toMatchObject({ href: "/setup" });
      let alerts = await creditAlerts(id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ kind: "billing.ai_credit_warning", severity: "info", companyId: id });
      expect(alerts[0].body).toMatch(/\$8\.00 of \$10\.00/);
      // the same line is told once, however many calls cross it
      await call();
      expect(await creditNotes(id)).toHaveLength(1);
      expect(await creditAlerts(id)).toHaveLength(1);
      // Home's row and Settings read it: a level, a percentage and words
      let current = await planOf(cookie);
      expect(current.aiCredit).toMatchObject({ level: "warning", percent: 80, resetsAt: null, notice: { title: "80% of your plan's AI help used" } });

      // used up: the first small call refused
      await spend(id, "1.950000");
      expect(outOfCredit(await call())).toBe(true);
      expect(outOfCredit(await call())).toBe(true);
      notes = await creditNotes(id);
      expect(notes.map((n) => n.title).sort()).toEqual(["80% of your plan's AI help used", "Your plan's AI help is used up"]);
      expect(notes.find((n) => n.title.includes("used up"))!.body).toBe("Applications still come in and candidates can still finish. New applicants are not read by AI until you upgrade.");
      alerts = await creditAlerts(id);
      expect(alerts.map((a) => [a.kind, a.severity]).sort()).toEqual([["billing.ai_credit_used_up", "high"], ["billing.ai_credit_warning", "info"]]);
      expect(alerts.every((a) => a.severity !== "critical")).toBe(true);
      expect(await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND))).toEqual([]);
      current = await planOf(cookie);
      expect(current.aiCredit).toMatchObject({ level: "used_up", notice: { title: "Your plan's AI help is used up" } });

      // customers never read an amount, in words or in the page's data; events and notices carry none either
      const raw = JSON.stringify(await read(await json(cookie, "GET", "/api/v1/companies/current")));
      expect(raw).not.toMatch(/"ai_credit_(?:total|monthly)_cents":\s*(?:\d{2,})/);
      expect(raw).not.toContain("spent");
      for (const n of notes) expect(`${n.title} ${n.body}`, n.title).not.toMatch(money);
      const said = await container.db.select().from(events).where(and(eq(events.companyId, id), inArray(events.type, ["entitlement.warning", "entitlement.exceeded"])));
      expect(said.map((e) => e.type).sort()).toEqual(["entitlement.exceeded", "entitlement.warning"]);
      for (const e of said) expect(Object.keys(e.payload).sort()).toEqual(["key", "percent"]);

      // the console: the AI line in dollars, beside the lifetime spend
      const rows = await read<Array<{ id: string; aiCostUsd: number; aiCredit: { spentUsd: number; limitUsd: number; percent: number; monthly: boolean; level: string } | null }>>(await json(admin, "GET", "/api/v1/admin/customers"));
      const row = rows.find((c) => c.id === id)!;
      expect(row.aiCredit).toMatchObject({ limitUsd: 10, monthly: false, level: "used_up" });
      expect(row.aiCredit!.spentUsd).toBeGreaterThan(9.9);
      expect(row.aiCredit!.spentUsd).toBeCloseTo(row.aiCostUsd, 5);
    });

    it("Settings reads money actually spent, as Home does: a draft's hold does not move it to 29% and back to 25%, and the two never differ", async () => {
      const { id, cookie } = await newCompany();
      await usePlan(container, id, "basic");
      const figures = async () => {
        const c = await planOf(cookie);
        return [c.usage.ai_credit_monthly_cents.used, c.aiCredit.percent];
      };
      // $5.00 of Basic's $20, then a draft holds about $0.80 for two minutes
      await spend(id, "5.000000");
      expect(await figures()).toEqual([25, 25]);
      await spend(id, "0.800000", { status: "running" });
      expect(await figures()).toEqual([25, 25]);
      // the gate and `check` still count it, so no number of calls at once can pass the limit
      expect((await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.AI_CREDIT_MONTHLY_CENTS))).used).toBe(580);
      // it settles at about $0.10: $5.10 is still 25%
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ status: "ok", costUsd: "0.100000" }).where(and(eq(aiRuns.companyId, id), eq(aiRuns.status, "running"))));
      expect(await figures()).toEqual([25, 25]);
      // a fraction of a cent cannot part them either: $5.998 is 29.99% on both, never 30% on one
      await spend(id, "0.898000");
      expect(await figures()).toEqual([29, 29]);
    });

    it("ITS's line reads money actually spent too: a draft's $0.80 held at $19.20 is not $20 of $20 and used up, and $0.95 held at $9 on Free is not $9.95", async () => {
      const line = async (id: string) => (await read<Array<{ id: string; aiCredit: { spentUsd: number; limitUsd: number; percent: number; monthly: boolean; level: string | null } | null }>>(await json(admin, "GET", "/api/v1/admin/customers"))).find((c) => c.id === id)!.aiCredit;
      const basic = await newCompany();
      await usePlan(container, basic.id, "basic");
      await spend(basic.id, "19.200000");
      await spend(basic.id, "0.800000", { status: "running" });
      expect(await line(basic.id)).toEqual({ monthly: true, spentUsd: 19.2, limitUsd: 20, percent: 96, level: "warning", resetsAt: expect.any(String) });
      // it settles at about $0.10, and only then is that money spent
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ status: "ok", costUsd: "0.100000" }).where(and(eq(aiRuns.companyId, basic.id), eq(aiRuns.status, "running"))));
      expect(await line(basic.id)).toMatchObject({ spentUsd: 19.3, percent: 96, level: "warning" });
      const free = await newCompany();
      await spend(free.id, "9.000000");
      await spend(free.id, "0.950000", { status: "running" });
      expect(await line(free.id)).toEqual({ monthly: false, spentUsd: 9, limitUsd: 10, percent: 90, level: "warning", resetsAt: null });
    });

    it("Home and ITS never say nothing has stopped while a new job is refused: Basic above $19.10, Pro above $59.10", async () => {
      const homeAt = async (settled: string, planKey = "basic") => {
        const { id, cookie } = await newCompany();
        await usePlan(container, id, planKey);
        await spend(id, settled);
        // a real call settles, and the owner and ITS hear about the line
        await runPromptDetached(container.db, runtime(new PricedProvider()), chatPrompt, INPUT, { companyId: id });
        const current = await planOf(cookie);
        return { id, cookie, aiCredit: current.aiCredit, room: await roomOf(cookie) };
      };
      // $19.09: the draft's $0.80 still fits under $19.90, so nothing has stopped
      const fits = await homeAt("19.090000");
      expect(fits.aiCredit).toMatchObject({ level: "warning", percent: 95 });
      expect(fits.aiCredit.notice.body).toBe("Nothing has stopped. Upgrade before it runs out.");
      expect(fits.room.ok).toBe(true);
      expect((await creditNotes(fits.id))[0].body).toBe("Nothing has stopped. Upgrade before it runs out.");
      expect((await creditAlerts(fits.id))[0].body).not.toContain("Nothing has stopped");
      expect((await creditAlerts(fits.id))[0].body).toContain("Talk with the customer about upgrading before it runs out.");
      // $19.20, 96%: the Start box is refused on the same page, and the row says what stopped
      const stopped = await homeAt("19.200000");
      expect(stopped.aiCredit).toMatchObject({ level: "warning", percent: 96 });
      expect(stopped.aiCredit.notice.body).toBe("New jobs have stopped: writing one needs more than is left. Upgrade before the rest runs out.");
      expect(stopped.room).toMatchObject({ ok: false, message: AI_HELP_LINE.newJobTooBig });
      expect((await creditNotes(stopped.id))[0].body).toBe("New jobs have stopped: writing one needs more than is left. Upgrade before the rest runs out.");
      expect((await creditAlerts(stopped.id))[0].body).toContain("New jobs have stopped");
      expect((await creditAlerts(stopped.id))[0].body).not.toContain("Nothing has stopped");
      // the same on Pro: $59.20 of $60
      const pro = await homeAt("59.200000", "pro");
      expect(pro.aiCredit.notice.body).toContain("New jobs have stopped");
      expect(pro.room.ok).toBe(false);
    });

    it("at $9.89 on Free the percentage says 98 while Home's level says used up, because the two cents a small call needs pass the $9.90: Settings reads the level", async () => {
      const { id, cookie } = await newCompany();
      await spend(id, "9.890000");
      const current = await planOf(cookie);
      expect(current.usage.ai_credit_total_cents.used).toBe(98);
      expect(current.aiCredit).toMatchObject({ level: "used_up", percent: 98 });
    });

    it("an Ultra owner is never told to upgrade: past $160 and at $199.90 the row and the notice name what is true, on the last plan there is", async () => {
      const { id, cookie } = await newCompany();
      await usePlan(container, id, "ultra");
      const call = () => runPromptDetached(container.db, runtime(new PricedProvider()), chatPrompt, INPUT, { companyId: id });
      await spend(id, "170.000000");
      expect((await call()).ok).toBe(true);
      const at85 = await planOf(cookie);
      expect(at85.aiCredit).toMatchObject({ level: "warning", notice: { body: "Nothing has stopped. Talk with ITS before it runs out." } });
      await spend(id, "29.950000");
      expect(outOfCredit(await call())).toBe(true);
      const gone = await planOf(cookie);
      expect(gone.aiCredit.level).toBe("used_up");
      expect(gone.aiCredit.notice.body).toMatch(/^Applications still come in and candidates can still finish\. New applicants are not read by AI until it starts again on \w+, \w+ \d+\.$/);
      const notes = await creditNotes(id);
      expect(notes.map((n) => n.title).sort()).toEqual(["80% of your plan's AI help used", "Your plan's AI help is used up"]);
      for (const n of notes) expect(`${n.title} ${n.body}`).not.toMatch(/upgrade/i);
      // and ITS is not sent to talk about one that is not there
      const alerts = await creditAlerts(id);
      expect(alerts.map((a) => a.kind).sort()).toEqual(["billing.ai_credit_used_up", "billing.ai_credit_warning"]);
      for (const a of alerts) {
        expect(a.body).not.toMatch(/upgrad/i);
        expect(a.body).toContain("Talk with the customer about their plan");
      }
    });

    it("a big draft refused is not the credit used up, and a hold that comes back cries no wolf", async () => {
      const { id } = await newCompany();
      const provider = new PricedProvider();
      await spend(id, "7.900000");
      // a draft in flight holds more than 80% with the rest, but nothing is spent yet
      let letGo = () => {};
      provider.waiting = new Promise((resolve) => { letGo = resolve; });
      const draft = runPromptDetached(container.db, runtime(provider), draftPrompt, INPUT, { companyId: id, maxTokens: INTAKE_COMPILE_MAX_TOKENS });
      for (let i = 0; i < 500 && provider.calls < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const small = new PricedProvider();
      expect((await runPromptDetached(container.db, runtime(small), chatPrompt, INPUT, { companyId: id })).ok).toBe(true);
      expect(await creditNotes(id)).toEqual([]);
      letGo();
      await draft;
      expect(await creditNotes(id)).toEqual([]);
      // past 80% for real, then refused for its size alone: nothing says the credit is used up, because it is not
      await spend(id, "1.500000");
      expect((await runPromptDetached(container.db, runtime(new PricedProvider()), chatPrompt, INPUT, { companyId: id })).ok).toBe(true);
      expect(outOfCredit(await runPromptDetached(container.db, runtime(new PricedProvider()), draftPrompt, INPUT, { companyId: id, maxTokens: INTAKE_COMPILE_MAX_TOKENS }))).toBe(true);
      expect((await creditNotes(id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      expect((await withTenant(container.db, id, (tx) => aiCreditStanding(tx, id)))!.level).toBe("warning");
    });

    it("Change plan signals the waiting work and settles the alerts, and a new plan's lines are told again", async () => {
      const { id, cookie } = await newCompany();
      await spend(id, "9.950000");
      const provider = new PricedProvider();
      expect(outOfCredit(await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id }))).toBe(true);
      expect((await creditAlerts(id)).map((a) => a.status)).toEqual(["open"]);
      await upgrade(id);
      expect((await creditAlerts(id)).map((a) => a.status)).toEqual(["resolved"]);
      const current = await planOf(cookie);
      expect(current.aiCredit).toMatchObject({ level: null, percent: 0 });
      expect(Date.parse(current.aiCredit.resetsAt!)).toBeGreaterThan(Date.now());
      expect((await container.db.select().from(companies).where(eq(companies.id, id)))[0].settings.aiCreditTold).toBeUndefined();
      // room at once
      expect((await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id })).ok).toBe(true);
      // this month's 80%, told in its own right
      await spend(id, "16.100000");
      await runPromptDetached(container.db, runtime(provider), chatPrompt, INPUT, { companyId: id });
      expect((await creditNotes(id)).map((n) => n.title).sort()).toEqual(["80% of your plan's AI help used", "Your plan's AI help is used up"]);
      const open = (await creditAlerts(id)).filter((a) => a.status === "open");
      expect(open.map((a) => a.kind)).toEqual(["billing.ai_credit_warning"]);
      expect(open[0].body).toContain("this month");
    });

    /**
     * A Basic company with $19.89 settled, not told yet, whose next call settles. PGlite has one connection, so a Change plan cannot
     * really hold the company's row from another: `whileLocking` runs at the moment the step asks for that row, which is when a
     * Change plan holding it has committed. The handle counts how often the row was asked for.
     */
    const settleOnBasic = async (settled: string, whileLocking: (tx: Tx, id: string) => Promise<void> = async () => {}) => {
      const { id, cookie } = await newCompany();
      await usePlan(container, id, "basic");
      await spend(id, settled);
      await spend(id, "0.000000", { status: "running" });
      const [run] = await container.db.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.companyId, id), eq(aiRuns.status, "running")));
      let asked = 0;
      const watched = new Proxy(container.db, {
        get(target, prop) {
          if (prop !== "transaction") return Reflect.get(target, prop);
          return (fn: (tx: Tx) => Promise<unknown>) => target.transaction((tx) => fn(new Proxy(tx as unknown as Tx, {
            get(t, p) {
              if (p !== "execute") return Reflect.get(t, p);
              return async (statement: Parameters<Tx["execute"]>[0]) => {
                if ((statement as unknown as { queryChunks: Array<{ value?: unknown }> }).queryChunks.some((c) => Array.isArray(c.value) && c.value.join("").includes("for no key update"))) {
                  asked += 1;
                  await whileLocking(t, id);
                }
                return t.execute(statement);
              };
            },
          })));
        },
      });
      await container.ai.credit!.settle(watched, { companyId: id, runId: run.id, values: { status: "ok", costUsd: "0.000000" } });
      return { id, cookie, asked: () => asked };
    };

    it("a line that looks due while Change plan runs is read again behind the company's row: on Pro at 33% nobody reads used up, and a new job is not refused", async () => {
      // $19.89 + 2 cents is past Basic's $19.90, so used up looks due; Change plan to Pro, $60, commits first
      const { id, cookie, asked } = await settleOnBasic("19.890000", async (tx, company) => {
        await tx.update(entitlements).set({ limit: 6000 }).where(and(eq(entitlements.companyId, company), eq(entitlements.key, "ai_credit_monthly_cents")));
      });
      expect(asked()).toBe(1);
      expect((await container.db.select().from(companies).where(eq(companies.id, id)))[0].settings.aiCreditTold).toBeUndefined();
      expect(await creditNotes(id)).toEqual([]);
      expect(await creditAlerts(id)).toEqual([]);
      const current = await planOf(cookie);
      expect(current.aiCredit).toMatchObject({ level: null, percent: 33 });
      expect(await withTenant(container.db, id, (tx) => aiCreditRoomForJob(tx, id))).toBe("ok");
    });

    it("with no Change plan the same line is told, once; and a call with nothing to tell takes no lock", async () => {
      const due = await settleOnBasic("19.890000");
      expect(due.asked()).toBe(1);
      expect((await creditNotes(due.id)).map((n) => n.title)).toEqual(["Your plan's AI help is used up"]);
      expect((await container.db.select().from(companies).where(eq(companies.id, due.id)))[0].settings.aiCreditTold).toBeTruthy();
      const quiet = await settleOnBasic("5.000000");
      expect(quiet.asked()).toBe(0);
      expect(await creditNotes(quiet.id)).toEqual([]);
    });

    it("Change plan says whether the AI credit started a month: Free to Basic does, Basic to Pro keeps its month, and a plan with no monthly credit has none to start", async () => {
      const { id } = await newCompany();
      const move = async (planKey: string) => read<{ aiCreditMonthStarted: boolean }>(await json(admin, "POST", `/api/v1/admin/customers/${id}/plan`, { planKey, reason: "They asked to upgrade." }));
      const monthOf = async () => (await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, id), eq(entitlements.key, "ai_credit_monthly_cents"))))[0];
      expect(await move("basic")).toMatchObject({ aiCreditMonthStarted: true });
      const started = await monthOf();
      expect(Date.parse(started.periodEnd!) - Date.now()).toBeGreaterThan(29 * DAY);
      expect(await move("pro")).toMatchObject({ aiCreditMonthStarted: false });
      expect(await monthOf()).toMatchObject({ limit: 6000, periodStart: started.periodStart, periodEnd: started.periodEnd });
      expect(await move("free")).toMatchObject({ aiCreditMonthStarted: false });
      // back up from Free: its month starts again, and the toast says so
      expect(await move("basic")).toMatchObject({ aiCreditMonthStarted: true });
    });

    it("a new month resolves last month's alerts on the console's next look", async () => {
      const { id } = await newCompany();
      await usePlan(container, id, "basic");
      await spend(id, "19.950000");
      expect(outOfCredit(await runPromptDetached(container.db, runtime(new PricedProvider()), chatPrompt, INPUT, { companyId: id }))).toBe(true);
      expect((await creditAlerts(id)).map((a) => a.status)).toEqual(["open"]);
      const before = await read<{ alerts: Array<{ kind: string; companyId: string }> }>(await json(admin, "GET", "/api/v1/admin/failures"));
      expect(before.alerts.filter((a) => a.companyId === id).map((a) => a.kind)).toEqual(["billing.ai_credit_used_up"]);
      await withPlatform(container.db, (tx) => tx.update(entitlements).set({ periodStart: new Date(Date.now() - 40 * DAY).toISOString(), periodEnd: new Date(Date.now() - 10 * DAY).toISOString() }).where(and(eq(entitlements.companyId, id), eq(entitlements.key, "ai_credit_monthly_cents"))));
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ createdAt: new Date(Date.now() - 15 * DAY).toISOString() }).where(eq(aiRuns.companyId, id)));
      const after = await read<{ alerts: Array<{ kind: string; companyId: string }> }>(await json(admin, "GET", "/api/v1/admin/failures"));
      expect(after.alerts.filter((a) => a.companyId === id)).toEqual([]);
      expect((await creditAlerts(id)).map((a) => a.status)).toEqual(["resolved"]);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { AI_CREDIT_USED_UP, creditHoldUsd, estimateCostUsd, outOfCredit, runPromptDetached, runPromptsDetached, type AiProvider, type AiRuntime, type PromptDef, type StructuredRequest, type StructuredResult, type Usage } from "@ros/ai";
import { INTAKE_COMPILE_MAX_TOKENS, runIntakeTurn, runScreenTurn, startIntakeSession } from "@ros/agents";
import { AI_CREDIT_AVAILABLE, AI_HELP_BUSY_LINE, AI_HELP_LINE, AI_HELP_UPGRADE_QUESTION } from "@ros/contracts";
import { AI_CREDIT_SLACK_USD, aiCreditRoomForJob, aiCreditRoomSoon, aiCreditStanding, entitlements as allowance, holdAiCreditRows, reserveAiCredit } from "@ros/core";
import { adminAlerts, aiRuns, applications, assessments, candidates, companies, entitlements, events, intakeSessions, notifications, recruiterEscalations, screens, unconfirmedScreens, withPlatform, withTenant, workflowRuns, workflowSteps, type Tx } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider, FakeSmsAdapter } from "@ros/integrations";
import { AI_OUTAGE_ALERT_KIND } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { runMaintenance } from "./maintenance";
import { SENT_RECORD_LINE, SENT_RECORD_NO_SCORE_LINE } from "./pages/chat-pages";
import { conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation, interviewWaitFor, type ConversationRef } from "./services/apply-conversation";
import { readingFor, runResumeReading } from "./services/apply-details";
import { screenDeps } from "./services/screens";
import { ensureWriteup } from "./services/writeup";
import { followApply, signInAdmin, testContainerOptions, usePlan } from "./test-helpers";

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";
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
  const errorOf = async (r: Response) => (await read<{ error: { code: string; message: string; details: { upgrade?: boolean; actions: Array<{ label: string; path: string; body: Record<string, unknown> }>; room?: { ok: boolean; aiHelp?: boolean; upgrade?: boolean; message: string } } } }>(r)).error;
  const moveClock = (at: number | null) => { (container.engine as unknown as { now: () => Date }).now = at === null ? () => new Date() : () => new Date(at); };

  /** A company of its own on Free, signed in from an address of its own (the route's limit per address). */
  const newCompany = async () => {
    made += 1;
    const accessToken = (container.integrations.identity as FakeIdentityProvider).mint({ email: `owner-${made}@ai-credit.test`, name: `Owner ${made}`, provider: "google" });
    const signedIn = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${made}` }, body: JSON.stringify({ accessToken }) });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const r = await json(cookie, "POST", "/api/v1/companies", { name: `Harbor Dental ${made}`, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status, await r.clone().text()).toBe(201);
    const co = await read<{ id: string; slug: string }>(r);
    return { cookie, id: co.id, slug: co.slug };
  };

  const spend = (companyId: string, costUsd: number | string, opts: { status?: string; createdAt?: string } = {}) => withPlatform(container.db, (tx) => tx.insert(aiRuns).values({ companyId, agent: "test", task: "test.spent", provider: "fake", model: "fake", promptKey: "test.spent", promptVersion: 1, promptHash: "x", costUsd: String(costUsd), status: opts.status ?? "ok", ...(opts.createdAt ? { createdAt: opts.createdAt } : {}) }));
  const spent = async (companyId: string) => withTenant(container.db, companyId, (tx) => allowance.aiCreditSpentMicros(tx, companyId)).then((m) => m / 1_000_000);
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

  const draftOf = async (cookie: string) => (await read<{ session: { id: string } }>(await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE }))).session.id;

  /** A company with one job open, the AI credit untouched (the stand-in AI costs nothing). */
  const openJob = async () => {
    const company = await newCompany();
    const compiled = await json(company.cookie, "POST", `/api/v1/intake/sessions/${await draftOf(company.cookie)}/compile`);
    expect(compiled.status, await compiled.clone().text()).toBe(201);
    const { roleId } = await read<{ roleId: string }>(compiled);
    expect((await json(company.cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = await read<{ status: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } }>(await json(company.cookie, "GET", `/api/v1/roles/${roleId}`));
    expect(role.status).toBe("open");
    return { ...company, roleId, eligibility: role.currentPacket.packet.requirements.eligibility };
  };
  type Job = Awaited<ReturnType<typeof openJob>>;

  let applicants = 0;
  /** The public form, as a browser posts it. */
  const postApplication = async (job: Job, p: { first: string; last: string; email: string; phone?: string }) => {
    applicants += 1;
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("locationText", "Irvine, CA");
    if (p.phone) { fd.set("phone", p.phone); fd.set("smsConsent", "yes"); }
    fd.set("resume", new File([`${p.first} ${p.last}\nRegistered Dental Hygienist at Coastal Dental 2019 - present\nRDH license active\nPerio maintenance, Dentrix`], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    for (const rule of job.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${applicants}` } });
    expect(res.status, await res.clone().text()).toBe(302);
    return res;
  };
  const apply = async (job: Job, p: { first: string; last: string; email: string; phone?: string }) => {
    await postApplication(job, p);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.id), eq(candidates.email, p.email)));
    const [row] = await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id)));
    return row;
  };
  const applicationOf = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const screenOf = async (applicationId: string) => (await container.db.select().from(screens).where(eq(screens.applicationId, applicationId)))[0];
  const runOf = async (key: string, applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, key))).find((r) => r.subject.id === applicationId)!;
  const interviewOf = async (applicationId: string): Promise<ConversationRef> => {
    const wait = await interviewWaitFor(container.db, applicationId);
    if (wait.state !== "ready") throw new Error(`the AI interview is not ready: ${wait.state}`);
    return (await findConversation(container.db, wait.token))!;
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
    for (const type of ["ai.run_failed", "ai.output_invalid", "resume.extraction_failed", "workflow.failed", "workflow.retried", "screen.paused"]) expect(types, type).not.toContain(type);
    const runs = await container.db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId));
    expect(runs.filter((r) => r.status === "failed")).toEqual([]);
    const steps = await container.db.select().from(workflowSteps).where(and(eq(workflowSteps.companyId, companyId), eq(workflowSteps.status, "error")));
    expect(steps).toEqual([]);
    const notes = await container.db.select().from(notifications).where(eq(notifications.companyId, companyId));
    expect(notes.filter((n) => n.kind === "application.assessment_unavailable")).toEqual([]);
    if (applicationIds.length) expect(await container.db.select().from(recruiterEscalations).where(inArray(recruiterEscalations.applicationId, applicationIds))).toEqual([]);
  };

  beforeAll(async () => {
    container = await createContainer(testContainerOptions({ ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake", SMS_ENABLED: "true" }));
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
      // what one no-résumé applicant's reading tried in the outage: three readings and their three second tries, each of the 15 tries the engine gives it
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
      const current = await read<{ aiCredit: { level: string | null; percent: number } }>(await json(cookie, "GET", "/api/v1/companies/current"));
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
      const failures = async () => (await read<{ failedAi: Array<{ task: string; companyId: string }> }>(await json(admin, "GET", "/api/v1/admin/failures"))).failedAi.filter((r) => r.companyId === id);
      expect(await failures()).toEqual([]);
      const listed = (await read<Array<{ companyId: string; status: string }>>(await json(admin, "GET", "/api/v1/admin/ai-runs"))).filter((r) => r.companyId === id);
      expect(listed.map((r) => r.status)).toEqual(["running"]);
      // the daily sweep: an hour on, nothing can still be running; its hold stays as its cost
      const report = await runMaintenance(container.db, new Date(Date.now() + 2 * 3600_000));
      expect(report.interruptedAiRuns).toBeGreaterThanOrEqual(1);
      expect(await spent(id)).toBeCloseTo(9.89, 6);
      expect((await failures()).map((r) => r.task)).toEqual(["test.spent"]);
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

  describe("the job builder", () => {
    it("a new job stops before anyone types, in the plan's words, with an upgrade that asks about AI help", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "9.200000");
      // too little for a draft: it says what is true
      let room = await read<{ ok: boolean; upgrade?: boolean; aiHelp?: boolean; message: string; holding: unknown[] }>(await json(cookie, "GET", "/api/v1/intake/room"));
      expect(room).toMatchObject({ ok: false, upgrade: true, aiHelp: true, message: AI_HELP_LINE.newJobTooBig, holding: [] });
      expect(await withTenant(container.db, id, (tx) => aiCreditRoomForJob(tx, id))).toBe("too_low");
      await spend(id, "0.750000");
      room = await read(await json(cookie, "GET", "/api/v1/intake/room"));
      expect(room).toMatchObject({ ok: false, upgrade: true, aiHelp: true, message: AI_HELP_LINE.newJob });
      expect((await read<{ room: { ok: boolean; message: string } }>(await json(cookie, "GET", "/api/v1/intake/sessions?mine=1"))).room).toMatchObject({ ok: false, message: AI_HELP_LINE.newJob });
      for (const [path, body] of [["/api/v1/intake/sessions", { initialMessage: HIRE }], ["/api/v1/intake/conversation/messages", { message: HIRE }]] as const) {
        const r = await json(cookie, "POST", path, body);
        expect(r.status, path).toBe(402);
        const error = await errorOf(r);
        expect(error).toMatchObject({ code: "limit_reached", message: AI_HELP_LINE.newJob, details: { upgrade: true } });
        expect(error.details.actions[0]).toMatchObject({ label: "Upgrade", path: "/api/v1/escalations", body: { topic: "plan", question: AI_HELP_UPGRADE_QUESTION } });
      }
      expect(await container.db.select().from(intakeSessions).where(eq(intakeSessions.companyId, id))).toEqual([]);
      expect(await runsOf(id)).toEqual([]);
    });

    it("a turn keeps the owner's words, offers an upgrade and no recruiter, and records no failure", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await draftOf(cookie);
      await spend(id, "9.950000");
      const runs = (await runsOf(id)).length;
      const r = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Saturdays covered." });
      expect(r.status).toBe(200);
      const { reply, session } = await read<{ reply: { error: string; recovery: string; upgrade: boolean; proposedActions: Array<{ label: string; body: Record<string, unknown> }> }; session: { messages: Array<{ role: string; content: string }> } }>(r);
      expect(reply).toMatchObject({ error: AI_CREDIT_USED_UP, recovery: AI_HELP_LINE.turn, upgrade: true });
      expect(reply.proposedActions).toHaveLength(1);
      expect(reply.proposedActions[0]).toMatchObject({ label: "Upgrade", body: { question: AI_HELP_UPGRADE_QUESTION } });
      expect(session.messages.at(-1)).toMatchObject({ role: "owner", content: "We also need Saturdays covered." });
      // the same through the answers and the wrapper
      const answers = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/answers`, { answers: [], note: "And Sundays.", reply: true });
      expect((await read<{ reply: { recovery: string } }>(answers)).reply.recovery).toBe(AI_HELP_LINE.turn);
      const wrapper = await read<{ reply: string; upgrade: boolean; intakeSessionId: string; proposedActions: Array<{ label: string }> }>(await json(cookie, "POST", "/api/v1/intake/conversation/messages", { message: "One more thing." }));
      expect(wrapper).toMatchObject({ reply: AI_HELP_LINE.turn, upgrade: true, intakeSessionId: sessionId, proposedActions: [{ label: "Upgrade" }] });
      expect((await runsOf(id)).length).toBe(runs);
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
    });

    it("a pasted ad stays unread, so it is read after an upgrade", async () => {
      const { id, cookie } = await newCompany();
      await spend(id, "9.950000");
      const ad = "Registered Dental Hygienist wanted. ".repeat(60);
      const me = await read<{ user: { id: string } }>(await json(cookie, "GET", "/api/v1/auth/me"));
      const actor = { kind: "user" as const, id: me.user.id };
      const started = await withTenant(container.db, id, (tx) => startIntakeSession(tx, { companyId: id, actor, userId: me.user.id, message: { content: ad, kind: "pasted_ad" } }));
      const out = await runIntakeTurn(container.db, { ai: container.ai, comp: container.integrations.comp }, { companyId: id, sessionId: started.id, actor });
      expect(out).toMatchObject({ noCredit: true, error: AI_CREDIT_USED_UP });
      const [after] = await container.db.select().from(intakeSessions).where(eq(intakeSessions.id, started.id));
      expect((after.serverState as { ad: { extracted: boolean } }).ad.extracted).toBe(false);
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
      expect(await runsOf(id)).toEqual([]);
      await upgrade(id);
      await runIntakeTurn(container.db, { ai: container.ai, comp: container.integrations.comp }, { companyId: id, sessionId: started.id, actor });
      const [read2] = await container.db.select().from(intakeSessions).where(eq(intakeSessions.id, started.id));
      expect((read2.serverState as { ad: { extracted: boolean } }).ad.extracted).toBe(true);
    });

    it("the draft answers 402, never 502: everything is kept, progress never says failed, and nothing is on the record", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await draftOf(cookie);
      await spend(id, "9.950000");
      for (const path of ["draft", "compile"]) {
        const r = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/${path}`);
        expect(r.status, path).toBe(402);
        const error = await errorOf(r);
        expect(error).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draft, details: { upgrade: true } });
        expect(error.details.actions[0]).toMatchObject({ label: "Upgrade", body: { question: AI_HELP_UPGRADE_QUESTION } });
      }
      const { session } = await read<{ session: { progress: unknown; messages: unknown[] } }>(await json(cookie, "GET", `/api/v1/intake/sessions/${sessionId}`));
      expect(session.progress).toBeNull();
      expect(session.messages.length).toBeGreaterThan(0);
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
    });

    it("at real prices the draft stops first and says what is true, while the chat goes on", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await draftOf(cookie);
      await spend(id, "9.500000");
      await atRealPrices(async (provider) => {
        const r = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
        expect(r.status).toBe(402);
        expect(await errorOf(r)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draftTooBig });
        expect(provider.calls).toBe(0);
        const turn = await read<{ reply: { error?: string; assistantMessage?: string } }>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Saturdays covered." }));
        expect(turn.reply.error).toBeUndefined();
        expect(turn.reply.assistantMessage).toBeTruthy();
        expect(provider.calls).toBe(1);
      });
    });

    it("a draft already written can still be changed by hand and sent for approval: those use no model", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await draftOf(cookie);
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`)).status).toBe(200);
      await spend(id, "9.950000");
      // changing it by chat is the model's: nothing changed, and the editor is named
      const change = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/revisions`, { message: "Make the summary shorter." });
      expect(change.status).toBe(402);
      expect(await errorOf(change)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.revise, details: { upgrade: true } });
      const asked = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/request-approval`);
      expect(asked.status, await asked.clone().text()).toBe(201);
      const { roleId } = await read<{ roleId: string }>(asked);
      // and on the role
      const onRole = await json(cookie, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Make the summary shorter." });
      expect(onRole.status).toBe(402);
      expect(await errorOf(onRole)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.revise });
      expect(await eventTypes(id)).not.toContain("ai.run_failed");
    });

    it("refused only for a running draft's hold, the owner reads what is true: try again in a few minutes, with no Upgrade and nothing used up", async () => {
      // the words below are real money: Basic stops at $19.90, $19.06 is settled, and another person's draft holds $0.84
      const { cookie, id } = await newCompany();
      const sessionId = await draftOf(cookie);
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`)).status).toBe(200);
      await usePlan(container, id, "basic");
      await spend(id, "19.060000");
      await spend(id, "0.840000", { status: "running" });
      await atRealPrices(async (provider) => {
        // a turn: the words stay saved
        const turn = await read<{ reply: { error: string; recovery: string; upgrade?: boolean; proposedActions: unknown[] } }>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Saturdays covered." }));
        expect(turn.reply).toMatchObject({ error: AI_CREDIT_USED_UP, recovery: AI_HELP_BUSY_LINE.turn, proposedActions: [] });
        expect(turn.reply.upgrade).toBeUndefined();
        const wrapper = await read<{ reply: string; upgrade?: boolean; proposedActions: unknown[] }>(await json(cookie, "POST", "/api/v1/intake/conversation/messages", { message: "One more thing." }));
        expect(wrapper).toMatchObject({ reply: AI_HELP_BUSY_LINE.turn, proposedActions: [] });
        expect(wrapper.upgrade).toBeUndefined();
        // the draft: its own hold fits on what is settled ($19.06 + about $0.80 is under $19.90)
        const draft = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
        expect(draft.status).toBe(409);
        const error = await errorOf(draft);
        expect(error).toMatchObject({ code: "ai_help_busy", message: AI_HELP_BUSY_LINE.draft });
        expect(error.details?.upgrade).toBeUndefined();
        // changing it by chat, and the text about the company
        const change = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/revisions`, { message: "Make the summary shorter." });
        expect(change.status).toBe(409);
        expect(await errorOf(change)).toMatchObject({ code: "ai_help_busy", message: AI_HELP_BUSY_LINE.revise });
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
        const turn = await read<{ reply: { error?: string; assistantMessage?: string } }>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Sundays covered." }));
        expect(turn.reply.error).toBeUndefined();
        expect(turn.reply.assistantMessage).toBeTruthy();
        expect(provider.calls).toBe(1);
      });
    });

    it("the same refusals with the money really spent say used up, or that the draft is too big, and offer the Upgrade", async () => {
      const { cookie, id } = await newCompany();
      const sessionId = await draftOf(cookie);
      await usePlan(container, id, "basic");
      // $19.50 settled and $0.39 in flight: a small call fits only once the hold settles, but the draft's $0.80 never fits
      await spend(id, "19.500000");
      await spend(id, "0.390000", { status: "running" });
      await atRealPrices(async () => {
        const draft = await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/draft`);
        expect(draft.status).toBe(402);
        expect(await errorOf(draft)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.draftTooBig, details: { upgrade: true } });
      });
      await spend(id, "0.390000");
      await atRealPrices(async () => {
        const turn = await read<{ reply: { recovery: string; upgrade: boolean } }>(await json(cookie, "POST", `/api/v1/intake/sessions/${sessionId}/messages`, { message: "We also need Saturdays covered." }));
        expect(turn.reply).toMatchObject({ recovery: AI_HELP_LINE.turn, upgrade: true });
      });
    });

    it("the quick start's suggestions answer with nothing, quietly", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "9.950000");
      const r = await json(cookie, "POST", "/api/v1/intake/suggestions", { title: "Delivery driver" });
      expect(r.status).toBe(200);
      expect(await read(r)).toEqual({ mustHaves: [], questions: [], unavailable: true });
      expect(await runsOf(id)).toEqual([]);
    });

    it("the text about the company answers 402 and says they can write it; approving their own text still works", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "9.950000");
      const r = await json(cookie, "POST", "/api/v1/companies/current/about/draft", {});
      expect(r.status).toBe(402);
      expect(await errorOf(r)).toMatchObject({ code: "ai_credit_used_up", message: AI_HELP_LINE.about, details: { upgrade: true } });
      const own = await json(cookie, "POST", "/api/v1/companies/current/about/approve", { text: "We are a friendly dental practice in Irvine, looking after families for twenty years." });
      expect(own.status, await own.clone().text()).toBe(200);
    });
  });

  describe("an application still arrives", () => {
    it("the candidate gets the one email with the link now, and nothing false is raised; the reading waits for the company's signal", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Ana", last: "Silva", email: "ana@ai-credit.test" });
      expect(a).toMatchObject({ stage: "screen_invited", extraction: null, latestAssessmentId: null });
      const mails = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "ana@ai-credit.test");
      expect(mails).toHaveLength(1);
      const scr = await screenOf(a.id);
      expect(mails[0].text).toContain(`/c/screen/${scr.token}`);
      expect(scr).toMatchObject({ status: "invited", invitedVia: "with_application" });
      // nothing about plans or money reaches the candidate
      expect(`${mails[0].subject} ${mails[0].text}`).not.toMatch(/\bplan\b|credit|upgrade|AI help/i);
      expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toEqual([]);
      // the model was never asked, so no run, and no retry: the run waits, with a long timer on the company's own signal
      expect((await runsOf(job.id)).filter((r) => r.task === "resume.extract" || r.task === "triage.assess")).toEqual([]);
      const run = await runOf("application_intake", a.id);
      expect(run.status).toBe("waiting");
      expect(run.attempts).toBe(0);
      expect(run.currentStep).toBe("extract");
      expect(run.wait).toMatchObject({ kind: "event", keys: [AI_CREDIT_AVAILABLE] });
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeGreaterThan(29 * DAY);
      // no poll every few hours: one look so far, and one wait
      expect((await container.db.select().from(workflowSteps).where(and(eq(workflowSteps.runId, run.id), eq(workflowSteps.stepKey, "ready"))))).toHaveLength(1);
      await noFalseAlarm(job.id, [a.id]);
      // the owner hears once, about the company, never about the person
      const notes = await creditNotes(job.id);
      expect(notes.map((n) => n.title)).toEqual(["Your plan's AI help is used up"]);
      expect(JSON.stringify(notes)).not.toContain("Ana");
      expect((await container.db.select().from(notifications).where(eq(notifications.companyId, job.id))).filter((n) => JSON.stringify(n).includes("Ana"))).toEqual([]);
      // a second applicant tells nobody again
      await apply(job, { first: "Ben", last: "Okafor", email: "ben@ai-credit.test" });
      expect(await creditNotes(job.id)).toHaveLength(1);
    });

    it("the form's reading of a résumé says failed at once, with no retry, so the candidate fills in the form", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const uploadId = "0192a6b2-0000-7aaa-8bbb-0000000000aa";
      const key = `quarantine/${job.id}/${job.roleId}/${uploadId}.txt`;
      await container.integrations.storage.put(key, new TextEncoder().encode("Dana Kept\nDental hygienist at Coastal Dental 2019 - present\n"), "text/plain");
      const payload = { companyId: job.id, roleId: job.roleId, uploadId, key, filename: "dana.txt", mime: "text/plain" };
      // the first of three tries: a throw here would be a retry
      await runResumeReading({ db: container.db, ai: container.ai, integrations: container.integrations, engine: container.engine }, payload, { attempt: 1, maxAttempts: 3, now: new Date() });
      expect(await readingFor(container.integrations.storage, payload)).toMatchObject({ outcome: "failed", aiRunId: null, details: null });
      expect((await runsOf(job.id)).filter((r) => r.inputRef.uploadId === uploadId)).toEqual([]);
    });

    it("after an upgrade the signal wakes the waiting reading: it is stored beside what happened since, and moves nothing", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Cy", last: "Rao", email: "cy@ai-credit.test" });
      const run = await runOf("application_intake", a.id);
      expect(run.status).toBe("waiting");
      await upgrade(job.id);
      const after = await applicationOf(a.id);
      expect(after.stage).toBe("screen_invited");
      expect(after.extraction).toBeTruthy();
      expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).map((x) => x.kind)).toEqual(["triage"]);
      expect((await runOf("application_intake", a.id)).status).toBe("completed");
      // one email all along
      expect((container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "cy@ai-credit.test")).toHaveLength(1);
      await noFalseAlarm(job.id, [a.id]);
    });

    it("a reading refused only for a running draft's hold moves the person on all the same, says nothing is used up, and is read a few minutes later", async () => {
      const job = await openJob();
      await usePlan(container, job.id, "basic");
      // Basic stops at $19.90: $19.06 settled, and a draft holding about $0.80 for two minutes
      await spend(job.id, "19.060000");
      await spend(job.id, "0.800000", { status: "running" });
      const a = await atRealPrices(() => apply(job, { first: "Ned", last: "Ash", email: "ned@ai-credit.test" }));
      // nobody waits on money: the one email went, with the link
      const mails = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "ned@ai-credit.test");
      expect(mails).toHaveLength(1);
      expect(mails[0].text).toContain(`/c/screen/${(await screenOf(a.id)).token}`);
      expect(a.latestAssessmentId).toBeNull();
      const run = await runOf("application_intake", a.id);
      expect(run.status).toBe("waiting");
      expect(run.wait).toMatchObject({ kind: "event", keys: [AI_CREDIT_AVAILABLE] });
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      // not parked until the period's end, and nothing on the record says used up
      const said = await container.db.select({ payload: events.payload }).from(events).where(and(eq(events.subjectId, a.id), eq(events.type, "application.triaged")));
      expect(said.map((e) => e.payload.reason)).toEqual(["the plan's AI help is finishing other work"]);
      expect((await creditNotes(job.id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      // the draft settles at about $0.10; the next look reads them, and moves nothing
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
      expect((container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "ned@ai-credit.test")).toHaveLength(1);
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
  });

  describe("a candidate's chat", () => {
    it("carries on in the job's own words, can be finished and sent, and the candidate cannot tell", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Eva", last: "Noor", email: "eva@ai-credit.test" });
      const ref = await interviewOf(a.id);
      expect(ref.kind).toBe("screen");
      expect(await conversationStart(container, ref)).toBe(true);
      const first = (await conversationView(container.db, ref))!;
      const firstKey = first.current!.key;

      // only a question, or only confusion: not an answer. The question again, with the offer of a person.
      for (const message of ["What does it pay?", "What do you mean?"]) {
        const r = await conversationTurn(container, ref, { message });
        expect(r).toMatchObject({ kind: "reply", done: false, humanRequested: false });
        expect((r as { message: string }).message).toContain(first.current!.question);
        expect((r as { message: string }).message).toContain("reply HUMAN");
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
      const recorded = { ...scr.answers, ...Object.fromEntries((scr.progress.focusQuestions ?? []).map((f) => [f.key, f.answer])) }[firstKey];
      expect(recorded).toBe(ANSWER);
      // their own words stay in the transcript, and a code reply carries no run, so it counts toward no cap
      expect(scr.transcript.filter((t) => t.role === "assistant").every((t) => !t.aiRunId)).toBe(true);
      expect(scr.progress.failures).toBe(0);
      expect(scr.status).toBe("in_progress");

      // to the end: Review & send, with no words about plans or money anywhere the candidate reads
      const end = await answerToTheEnd(ref);
      expect(end.phase).toBe("review");
      expect(await ensureWriteup(container, ref)).toBe("written");
      const view = (await conversationView(container.db, ref))!;
      expect(view.writeup?.answers.length).toBeGreaterThan(0);
      expect(view.writeup?.aiRunId ?? null).toBeNull();
      const everything = JSON.stringify(view.transcript) + JSON.stringify(view.writeup);
      expect(everything).not.toMatch(/\bplans?\b|credit|upgrade|AI help|used up/i);
      expect(await conversationSubmit(container, ref)).toBe(true);
      await container.drain();
      scr = await screenOf(a.id);
      expect(scr.status).toBe("completed");
      expect((await runsOf(job.id)).filter((r) => ["screen.turn", "screen.writeup", "screen.assess"].includes(r.task))).toEqual([]);

      // the scorecard waits for the company's signal, and the screen says so; nothing failed and nobody was paged about them
      expect(scr.progress.scoreWaitsForCredit).toBeTruthy();
      expect(scr.assessmentId).toBeNull();
      const run = await runOf("screen", a.id);
      expect(run).toMatchObject({ status: "waiting", currentStep: "assess", attempts: 0 });
      expect(run.wait).toMatchObject({ kind: "event", keys: [AI_CREDIT_AVAILABLE] });
      await noFalseAlarm(job.id, [a.id]);
      expect(await creditNotes(job.id)).toHaveLength(1);
      expect((await container.db.select().from(notifications).where(eq(notifications.companyId, job.id))).filter((n) => JSON.stringify(n).includes("Eva"))).toEqual([]);

      // no score can come for now: nothing promises one, not the page they sent it from and not their record, whatever the time
      const decoded = async (path: string) => (await (await app.request(path)).text()).replace(/&#39;/g, "'");
      const closing = () => decoded(`/c/screen/${ref.token}`);
      const record = () => decoded(`/c/status/${a.statusToken}`);
      expect(await closing()).toContain(SENT_RECORD_NO_SCORE_LINE);
      expect(await closing()).not.toContain("match score");
      expect(await record()).not.toMatch(/match score|Not ready yet/i);
      moveClock(Date.now() + 2 * 3_600_000);
      try {
        expect(await record()).not.toMatch(/match score|Not ready yet/i);
      } finally {
        moveClock(null);
      }

      // the team reads the answers, and every place that says "being scored" says to read it instead
      const detail = await read<{ screens: Array<{ scorecard: string; answersShared: boolean; answers: Record<string, string> }>; placement: { doneLabel: string; reason: string; column: string | null } }>(await json(job.cookie, "GET", `/api/v1/applications/${a.id}`));
      expect(detail.screens[0].scorecard).toBe("waiting_for_credit");
      expect(detail.screens[0].answersShared).toBe(true);
      expect(Object.values(detail.screens[0].answers)).toContain(ANSWER);
      expect(detail.placement).toMatchObject({ column: null, doneLabel: "AI interview not scored" });
      expect(detail.placement.reason).toMatch(/Read their answers/);
      const board = await read<{ noAiInterview: Array<{ applicationId: string; placement: { doneLabel: string } }> }>(await json(job.cookie, "GET", `/api/v1/roles/${job.roleId}/board`));
      expect(board.noAiInterview.find((c) => c.applicationId === a.id)?.placement.doneLabel).toBe("AI interview not scored");
      const preview = await read<{ items: Array<{ applicationId: string; blockedReason?: string; reason?: string }> }>(await json(job.cookie, "POST", `/api/v1/roles/${job.roleId}/batch`, { dryRun: true, items: [{ applicationId: a.id, action: "shortlist" }] }));
      expect(JSON.stringify(preview)).toContain("your plan's AI help is used up");

      // after an upgrade it is scored, the mark goes, and the team hears as usual
      await upgrade(job.id);
      scr = await screenOf(a.id);
      expect(scr.progress.scoreWaitsForCredit).toBeUndefined();
      expect(scr.assessmentId).toBeTruthy();
      expect((await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).map((x) => x.kind).sort()).toEqual(["screen", "triage"]);
      const scored = await read<{ screens: Array<{ scorecard: string }>; placement: { doneLabel: string | null } }>(await json(job.cookie, "GET", `/api/v1/applications/${a.id}`));
      expect(scored.screens[0].scorecard).toBe("ready");
      expect((await runOf("screen", a.id)).status).not.toBe("failed");
      await noFalseAlarm(job.id, [a.id]);
      // and now both say so, as they do for anyone
      expect(await closing()).toContain(SENT_RECORD_LINE);
      expect(await record()).toContain("Your match score is ready");
    });

    it("someone whose résumé was read before the credit ran out keeps their score and its promise, and it is never 'working out' while the scorecard waits", async () => {
      const job = await openJob();
      const a = await apply(job, { first: "Rae", last: "Inge", email: "rae@ai-credit.test" });
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
      expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toHaveLength(1);
      await spend(job.id, "9.950000");
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      expect(await ensureWriteup(container, ref)).toBe("written");
      expect(await conversationSubmit(container, ref)).toBe(true);
      await container.drain();
      expect((await screenOf(a.id)).progress.scoreWaitsForCredit).toBeTruthy();
      const closed = (await (await app.request(`/c/screen/${ref.token}`)).text()).replace(/&#39;/g, "'");
      expect(closed).toContain(SENT_RECORD_LINE);
      const record = (await (await app.request(`/c/status/${a.statusToken}`)).text()).replace(/&#39;/g, "'");
      expect(record).toContain("Your match score is ready");
      expect(record).toContain("From your résumé only");
      expect(record).not.toContain("Working out your match score");
    });

    /** A chat sent on a Basic job, its résumé read and $19.06 of the $20 settled, with `inFlight` held by a draft still running. */
    const sentOnBasic = async (who: { first: string; last: string; email: string }, settled: string, inFlight: string | null) => {
      const job = await openJob();
      await usePlan(container, job.id, "basic");
      const a = await apply(job, who);
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      await spend(job.id, settled);
      if (inFlight) await spend(job.id, inFlight, { status: "running" });
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
      expect(run).toMatchObject({ status: "waiting", currentStep: "assess", attempts: 0 });
      expect(run.wait).toMatchObject({ kind: "event", keys: [AI_CREDIT_AVAILABLE] });
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      // everything says what is true: being scored, with 95% settled and not used up
      const detail = await read<{ screens: Array<{ scorecard: string }>; placement: { doneLabel: string | null } }>(await json(job.cookie, "GET", `/api/v1/applications/${a.id}`));
      expect(detail.screens[0].scorecard).toBe("writing");
      expect(detail.placement.doneLabel).not.toBe("AI interview not scored");
      expect((await creditNotes(job.id)).map((n) => n.title)).toEqual(["80% of your plan's AI help used"]);
      const current = await read<{ aiCredit: { level: string; percent: number } }>(await json(job.cookie, "GET", "/api/v1/companies/current"));
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

    it("the same chat with the money really spent: it waits to the period's end, in the used-up words, and the owner is told", async () => {
      // $19.86 settled and nothing running: the three readings' 6 cents make 19.92 whatever settles, and money spent never comes back
      const { job, a } = await sentOnBasic({ first: "Pia", last: "Wren", email: "pia@ai-credit.test" }, "19.860000", null);
      const scr = await screenOf(a.id);
      expect(scr.progress.scoreWaitsForCredit).toBeTruthy();
      const run = await runOf("screen", a.id);
      const [credit] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, job.id), eq(entitlements.key, "ai_credit_monthly_cents")));
      expect(run.wait?.until).toBe(credit.periodEnd);
      expect(Date.parse(run.wait!.until!) - Date.now()).toBeGreaterThan(29 * DAY);
      const detail = await read<{ screens: Array<{ scorecard: string }>; placement: { doneLabel: string | null } }>(await json(job.cookie, "GET", `/api/v1/applications/${a.id}`));
      expect(detail.screens[0].scorecard).toBe("waiting_for_credit");
      expect(detail.placement.doneLabel).toBe("AI interview not scored");
      expect((await creditNotes(job.id)).map((n) => n.title)).toContain("Your plan's AI help is used up");
      // ITS moves them to Pro while something big is running: nothing is used up any more, so the mark and its words go, and it looks again soon
      await spend(job.id, "59.950000", { status: "running" });
      await atRealPrices(() => upgrade(job.id, "pro"));
      expect((await screenOf(a.id)).progress.scoreWaitsForCredit).toBeUndefined();
      expect(Date.parse((await runOf("screen", a.id)).wait!.until!) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
      expect((await screenOf(a.id)).assessmentId).toBeNull();
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

    it("someone who leaves during the short wait is not read when it ends, and no credit is spent on them", async () => {
      const { job, a } = await sentOnBasic({ first: "Rex", last: "Yule", email: "rex@ai-credit.test" }, "19.060000", "0.800000");
      expect((await screenOf(a.id)).assessmentId).toBeNull();
      const decided = await json(job.cookie, "POST", `/api/v1/applications/${a.id}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Not this time." });
      expect(decided.status, await decided.clone().text()).toBe(200);
      await withPlatform(container.db, (tx) => tx.update(aiRuns).set({ status: "ok", costUsd: "0.100000" }).where(and(eq(aiRuns.companyId, job.id), eq(aiRuns.status, "running"))));
      await atRealPrices(async (provider) => {
        try {
          moveClock(Date.now() + 16 * 60_000);
          await container.drain();
        } finally {
          moveClock(null);
        }
        expect(provider.calls).toBe(0);
      });
      expect((await screenOf(a.id)).assessmentId).toBeNull();
      expect((await runsOf(job.id)).filter((r) => r.task === "screen.assess")).toEqual([]);
    });

    it("Change plan just after the refusal, before the step's own transaction: the run does not park for a month on a plan with room", async () => {
      const job = await openJob();
      const a = await apply(job, { first: "Sia", last: "Zane", email: "sia@ai-credit.test" });
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
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
      expect(await read<{ screens: Array<{ scorecard: string }> }>(await json(job.cookie, "GET", `/api/v1/applications/${a.id}`)).then((d) => d.screens[0].scorecard)).toBe("writing");
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

    it("someone who left while the AI work waited for credit is not read after an upgrade, and no credit is spent on them", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Lou", last: "Park", email: "lou@ai-credit.test" });
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      expect(await conversationSubmit(container, ref)).toBe(true);
      await container.drain();
      expect((await runOf("screen", a.id)).status).toBe("waiting");
      expect((await runOf("application_intake", a.id)).status).toBe("waiting");
      const decided = await json(job.cookie, "POST", `/api/v1/applications/${a.id}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Not this time." });
      expect(decided.status, await decided.clone().text()).toBe(200);
      await upgrade(job.id);
      expect((await runOf("screen", a.id)).status).toBe("completed");
      expect((await runOf("application_intake", a.id)).status).toBe("completed");
      expect((await runsOf(job.id)).filter((r) => ["resume.extract", "triage.assess", "screen.assess"].includes(r.task))).toEqual([]);
      expect(await container.db.select().from(assessments).where(eq(assessments.applicationId, a.id))).toEqual([]);
      await noFalseAlarm(job.id, [a.id]);
    });

    it("at real prices it uses the model while a turn's hold fits, then goes on in code, in the same chat", async () => {
      const job = await openJob();
      const a = await apply(job, { first: "Kai", last: "Moss", email: "kai@ai-credit.test" });
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
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

    it("a turn that cannot read the credit in time says to send that again on the page it is on, never a raw error, and then goes on; a repeat's chat too", async () => {
      const job = await openJob();
      const p = { first: "Tess", last: "Abel", email: "tess@ai-credit.test" };
      const a = await apply(job, p);
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
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
        const page = (await (await app.request(location)).text()).replace(/&#39;/g, "'").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ");
        expect(page).toContain("Something went wrong on our end. Please send that again in a minute.");
        expect(page).not.toMatch(/\bplan\b|credit|upgrade|lock timeout/i);
        // no outage, no alert and nothing about money
        expect(await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, AI_OUTAGE_ALERT_KIND))).toEqual([]);
        expect(await creditNotes(job.id)).toEqual([]);

        // the same on a repeat submission's chat
        const res = await postApplication(job, p);
        const { token } = await followApply(app, res, container);
        const detached = (await findConversation(container.db, token!))!;
        await conversationStart(container, detached);
        expect(await conversationTurn(container, detached, { message: ANSWER })).toMatchObject({ kind: "error", message: "Sorry, something went wrong on our end. Please send that again in a minute." });
      } finally {
        gate.hold = hold;
      }
      // sent again, it goes on
      expect((await conversationTurn(container, ref, { message: ANSWER })).kind).toBe("reply");
    });

    it("a skip and HUMAN work as ever: neither needs the model", async () => {
      const job = await openJob();
      await spend(job.id, "9.950000");
      const a = await apply(job, { first: "Fay", last: "Oren", email: "fay@ai-credit.test" });
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
      const before = (await conversationView(container.db, ref))!;
      expect((await conversationTurn(container, ref, { skip: true })).kind).toBe("reply");
      const after = (await conversationView(container.db, ref))!;
      expect(after.current?.key).not.toBe(before.current?.key);
      const human = await conversationTurn(container, ref, { message: "HUMAN" });
      expect(human).toMatchObject({ kind: "reply", humanRequested: true });
      expect((await screenOf(a.id)).status).toBe("human_requested");
      // a person asked for reaches a person, whatever the credit says
      expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, a.id))).length).toBe(1);
    });

    it("a chat paused by an outage finishes the turn in code when its retry finds no credit: it opens again, the email goes, and no recruiter is brought in", async () => {
      const job = await openJob();
      const a = await apply(job, { first: "Gus", last: "Hale", email: "gus@ai-credit.test" });
      const ref = await interviewOf(a.id);
      await conversationStart(container, ref);
      const fake = container.fake!;
      // two failed turns pause it (E5); the third failure is the workflow's first retry, so it stays paused
      for (let i = 0; i < 3; i++) fake.failNext("screen.turn", "throw");
      expect((await conversationTurn(container, ref, { message: ANSWER })).kind).toBe("error");
      expect(await conversationTurn(container, ref, { message: ANSWER })).toMatchObject({ kind: "reply", paused: true });
      await container.drain();
      expect((await screenOf(a.id)).status).toBe("paused");
      await spend(job.id, "9.950000");
      const mailsBefore = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "gus@ai-credit.test").length;
      try {
        moveClock(Date.now() + 31 * 60_000);
        await container.drain();
      } finally {
        moveClock(null);
      }
      const scr = await screenOf(a.id);
      expect(scr.status).toBe("in_progress");
      expect(scr.progress.pausedAt).toBeUndefined();
      const mails = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "gus@ai-credit.test");
      expect(mails.length).toBe(mailsBefore + 1);
      expect(`${mails.at(-1)!.subject} ${mails.at(-1)!.text}`).toContain(`/c/screen/${scr.token}`);
      expect(await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, a.id))).toEqual([]);
      // the candidate finishes
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      expect(await conversationSubmit(container, ref)).toBe(true);
    });

    it("a repeat submission's detached chat reads the same, and its paused retry finishes in code too", async () => {
      const job = await openJob();
      await apply(job, { first: "Hal", last: "Ito", email: "hal@ai-credit.test" });
      // applying again from the same address opens a detached chat on the page; it fails twice and pauses, with room in the credit
      const res = await postApplication(job, { first: "Hal", last: "Ito", email: "hal@ai-credit.test" });
      const { token } = await followApply(app, res, container);
      expect(token).toBeTruthy();
      const ref = (await findConversation(container.db, token!))!;
      expect(ref.kind).not.toBe("screen");
      await conversationStart(container, ref);
      const fake = container.fake!;
      for (let i = 0; i < 2; i++) fake.failNext("screen.turn", "throw");
      expect((await conversationTurn(container, ref, { message: ANSWER })).kind).toBe("error");
      expect(await conversationTurn(container, ref, { message: ANSWER })).toMatchObject({ kind: "reply", paused: true });
      await spend(job.id, "9.950000");
      const mailsBefore = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "hal@ai-credit.test").length;
      try {
        moveClock(Date.now() + 31 * 60_000);
        await container.drain();
      } finally {
        moveClock(null);
      }
      expect((await conversationView(container.db, ref))!.status).toBe("in_progress");
      const mails = (container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === "hal@ai-credit.test");
      expect(mails.length).toBe(mailsBefore + 1);
      // the email that says to finish, never the offer of a person that a day's outage sends
      expect(mails.at(-1)!.text).toContain("you can finish here");
      expect(await container.db.select({ intent: unconfirmedScreens.intent }).from(unconfirmedScreens).where(eq(unconfirmedScreens.id, ref.id))).toEqual([{ intent: null }]);
      // then the rest in code, with the same shape as a first application's chat, to Review & send
      const before = (await conversationView(container.db, ref))!;
      if (before.phase === "conversation") {
        const turn = await conversationTurn(container, ref, { message: ANSWER });
        expect(turn.kind).toBe("reply");
        if (!(turn as { review?: boolean }).review) expect((turn as { message: string }).message).toMatch(/^Thanks\./);
      }
      expect((await answerToTheEnd(ref)).phase).toBe("review");
      expect(await ensureWriteup(container, ref)).toBe("written");
      expect(await conversationSubmit(container, ref)).toBe(true);
      expect((await conversationView(container.db, ref))!.status).toBe("completed");
      expect((await runsOf(job.id)).filter((r) => r.task === "screen.turn" && r.status === "running")).toEqual([]);
    });

    it("a chat by text opens with the disclosure and the first question, and the invitation goes; replies go on in code", async () => {
      const job = await openJob();
      const a = await apply(job, { first: "Ida", last: "Vance", email: "ida@ai-credit.test", phone: "(949) 555-0147" });
      expect((await json(job.cookie, "POST", `/api/v1/applications/${a.id}/actions`, { action: "cancel_screen", note: "Asked for texts." })).status).toBe(200);
      await spend(job.id, "9.950000");
      const texts = () => (container.integrations.sms as FakeSmsAdapter).sent.filter((m) => m.to === "+19495550147");
      try {
        // the middle of a working day, in the legal window for texts
        moveClock(Date.parse("2026-11-11T20:00:00Z"));
        const invited = await json(job.cookie, "POST", `/api/v1/applications/${a.id}/actions`, { action: "invite_screen", channel: "sms" });
        expect(invited.status, await invited.clone().text()).toBe(200);
        await container.drain();
        expect(texts()).toHaveLength(1);
        const sms = (await container.db.select().from(screens).where(eq(screens.applicationId, a.id))).find((s) => s.channel === "sms")!;
        expect(sms.transcript[0]).toMatchObject({ role: "assistant", source: "system" });
        expect(sms.transcript[0].aiRunId).toBeUndefined();
        expect(texts()[0].body).toContain("(AI-assisted)");
        expect(texts()[0].body).toContain("Reply HUMAN");
        expect(texts()[0].body).toContain(sms.transcript[0].content);
        expect(texts()[0].body).not.toMatch(/\bplan\b|credit|upgrade/i);
        const key = sms.progress.currentQuestionKey!;
        expect(key).toBeTruthy();
        const reply = await runScreenTurn(container.db, job.id, screenDeps(container), { screenId: sms.id, message: ANSWER, channel: "sms", actor: { kind: "candidate", id: a.candidateId } });
        expect(reply.kind).toBe("reply");
        await container.drain();
        expect(texts()).toHaveLength(2);
        const after = (await container.db.select().from(screens).where(eq(screens.id, sms.id)))[0];
        expect(after.answers[key]).toBe(ANSWER);
      } finally {
        moveClock(null);
      }
      await noFalseAlarm(job.id, []);
    });

    it("a message's suggested line is simply not there, with no run to point at", async () => {
      const job = await openJob();
      const a = await apply(job, { first: "Jo", last: "Lind", email: "jo@ai-credit.test" });
      await spend(job.id, "9.950000");
      const before = (await runsOf(job.id)).length;
      const r = await read<{ line: string | null; suggestionRunId: string | null; note: string }>(await json(job.cookie, "POST", `/api/v1/applications/${a.id}/messages/suggest`, { purpose: "update" }));
      expect(r).toMatchObject({ line: null, suggestionRunId: null });
      expect(r.note).toMatch(/Write your own line/);
      expect((await runsOf(job.id)).length).toBe(before);
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
      let current = await read<{ aiCredit: { level: string; percent: number; resetsAt: string | null; notice: { title: string } }; usage: Record<string, unknown> }>(await json(cookie, "GET", "/api/v1/companies/current"));
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
      current = await read(await json(cookie, "GET", "/api/v1/companies/current"));
      expect(current.aiCredit).toMatchObject({ level: "used_up", notice: { title: "Your plan's AI help is used up" } });

      // customers never read an amount, in words or in the page's data; events and notices carry none either
      const raw = JSON.stringify(current);
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
        const c = await read<{ usage: { ai_credit_monthly_cents: { used: number } }; aiCredit: { percent: number } }>(await json(cookie, "GET", "/api/v1/companies/current"));
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
        const current = await read<{ aiCredit: { level: string; percent: number; notice: { body: string } } }>(await json(cookie, "GET", "/api/v1/companies/current"));
        return { id, cookie, aiCredit: current.aiCredit, room: await read<{ ok: boolean; message: string }>(await json(cookie, "GET", "/api/v1/intake/room")) };
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
      const current = await read<{ usage: { ai_credit_total_cents: { used: number } }; aiCredit: { level: string; percent: number } }>(await json(cookie, "GET", "/api/v1/companies/current"));
      expect(current.usage.ai_credit_total_cents.used).toBe(98);
      expect(current.aiCredit).toMatchObject({ level: "used_up", percent: 98 });
    });

    it("an Ultra owner is never told to upgrade: past $160 and at $199.90 the row and the notice name what is true, on the last plan there is", async () => {
      const { id, cookie } = await newCompany();
      await usePlan(container, id, "ultra");
      const call = () => runPromptDetached(container.db, runtime(new PricedProvider()), chatPrompt, INPUT, { companyId: id });
      await spend(id, "170.000000");
      expect((await call()).ok).toBe(true);
      const at85 = await read<{ aiCredit: { level: string; notice: { body: string } } }>(await json(cookie, "GET", "/api/v1/companies/current"));
      expect(at85.aiCredit).toMatchObject({ level: "warning", notice: { body: "Nothing has stopped. Talk with ITS before it runs out." } });
      await spend(id, "29.950000");
      expect(outOfCredit(await call())).toBe(true);
      const gone = await read<{ timezone: string; aiCredit: { level: string; notice: { body: string } } }>(await json(cookie, "GET", "/api/v1/companies/current"));
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
      const current = await read<{ aiCredit: { level: string | null; percent: number; resetsAt: string | null } }>(await json(cookie, "GET", "/api/v1/companies/current"));
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
      const current = await read<{ aiCredit: { level: string | null; percent: number } }>(await json(cookie, "GET", "/api/v1/companies/current"));
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

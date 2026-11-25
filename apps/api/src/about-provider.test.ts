import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { StructuredRequest, StructuredResult } from "@ros/ai";
import type { CompanyView, IntakeStartResponse } from "@ros/contracts";
import { adminAlerts, auditRecords, companies } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { ASSISTANT_UNAVAILABLE_ABOUT_LINE, ASSISTANT_UNAVAILABLE_ALERT_KIND, ASSISTANT_UNAVAILABLE_LINE } from "./services/assistant-unavailable";
import { seedCompany, usePlan } from "./test-helpers";

/**
 * "Draft it for me" for the text about the company (Settings), when the AI provider itself is the problem. Round 1
 * (25 November 2026) taught the job builder to say so and to alert an administrator; this draft, the other place the
 * assistant answers inside a request, still told the owner "Try again in a minute", which could not work, and alerted
 * nobody. It uses the same helper now: one true sentence, one critical alert, resolved when the assistant answers again.
 * Any other failure keeps its words and alerts nobody.
 */
describe("the draft of the text about the company when the AI provider is the problem", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  const DRAFT = "/api/v1/companies/current/about/draft";
  const REFUSES_OUR_ACCOUNT = "The AI provider refuses our account: the job builder cannot answer";
  const IS_NOT_ANSWERING = "The AI provider is not answering: the job builder cannot answer";
  const NOT_AVAILABLE = "The assistant is not available right now. Try again later, or write the text yourself.";
  type Refusal = { error: { code: string; message: string } };

  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  const draft = (notes?: string) => json("POST", DRAFT, notes ? { notes } : {});
  const errorOf = async (r: Response) => ((await r.json()) as Refusal).error;
  const alerts = async () => (await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, ASSISTANT_UNAVAILABLE_ALERT_KIND))).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const standing = async () => (await alerts()).filter((a) => a.status !== "resolved");
  const storedDraft = async () => (await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId)))[0].settings.aboutDraft;

  // The provider is the test's own to break: every call it answers passes here first.
  let answers: Container["ai"]["provider"]["structured"];
  /** As on 24 November 2026: the provider refuses every call, in its own words. */
  const PROVIDER_SAID = 'provider error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_made_up"}';
  const refuseOurAccount = () => {
    container.ai.provider.structured = async <T>(_req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>> => ({ kind: "invalid", error: PROVIDER_SAID, model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, final: true });
  };
  const answerAgain = () => {
    container.ai.provider.structured = answers;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake" } });
    app = createApp(container);
    const made = await seedCompany(app, { email: "owner@about-provider.test", name: "Harbor Dental" });
    owner = made.owner;
    companyId = made.companyId;
    await usePlan(container, companyId, "ultra");
    answers = container.ai.provider.structured.bind(container.ai.provider);
  });
  afterAll(async () => {
    await container.close();
  });

  it("tells the owner the assistant is not available, never to try again in a minute, and raises one critical alert, once, when the provider refuses our account", async () => {
    refuseOurAccount();
    const r = await draft("We have a calm office near the train station.");
    expect(r.status).toBe(502);
    const said = await errorOf(r);
    expect(said).toMatchObject({ code: "assistant_unavailable", message: NOT_AVAILABLE });
    expect(NOT_AVAILABLE).toBe(ASSISTANT_UNAVAILABLE_ABOUT_LINE);
    expect(said.message).not.toMatch(/Try again in a minute|could not write a draft/);
    // the job builder's sentence begins the same, and goes on to promise that the words are saved. Nothing typed here is
    // stored until a text is approved, so this one promises no such thing and names the other way on.
    expect(ASSISTANT_UNAVAILABLE_LINE).toBe("The assistant is not available right now. Your words are saved; try again later.");
    expect(said.message.startsWith("The assistant is not available right now. ")).toBe(true);
    expect(said.message).not.toMatch(/saved/);
    expect(await storedDraft()).toBeUndefined();

    const [alert, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(alert).toMatchObject({ severity: "critical", status: "open", title: REFUSES_OUR_ACCOUNT, companyId: null, details: { cause: "account", task: "company.about" } });
    // where it happened and what the person read, as they were, and the provider's own words
    expect(alert.body).toContain("The AI provider refused our account when someone asked for a draft of the text about their company, in Settings, so the assistant cannot answer anyone");
    expect(alert.body).toContain("The person was told that the assistant is not available, and to try again later or write the text themselves.");
    expect(alert.body).not.toMatch(/used the job builder|their words are saved/);
    expect(alert.body).toContain("Check the API key");
    expect(alert.body).toContain(`The error was: ${PROVIDER_SAID.replace("provider error: ", "").slice(0, 200)}.`);
    expect(alert.body).toContain("This alert resolves by itself the next time the assistant answers in the job builder or in Settings.");

    // it fails again: still the one alert
    expect(await errorOf(await draft())).toMatchObject({ code: "assistant_unavailable", message: NOT_AVAILABLE });
    expect((await alerts()).map((a) => a.id)).toEqual([alert.id]);
  });

  it("resolves the alert by itself when a later draft is written, so the next trouble is a new alert", async () => {
    answerAgain();
    const r = await draft("We have a calm office near the train station.");
    expect(r.status, await r.clone().text()).toBe(201);
    expect(((await r.json()) as CompanyView).aboutDraft?.text).toContain("Harbor Dental is a dental business in Irvine, CA.");
    const [alert, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(alert.status).toBe("resolved");
    const record = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "alert.resolved"))).find((a) => (a.details as { alertId?: string }).alertId === alert.id);
    expect(record).toMatchObject({ reason: "the assistant answered in Settings again", details: { automatic: true } });
  });

  /**
   * One slow answer wakes nobody; a second failure within ten minutes is an outage an administrator should see. The
   * job builder's calls and this draft count together: it is one provider that is not answering.
   */
  it("alerts for an outage from its second failure, counted together with the job builder's", async () => {
    container.fake!.failNext("company.about", "throw");
    expect(await errorOf(await draft())).toMatchObject({ code: "assistant_unavailable", message: NOT_AVAILABLE });
    expect(await standing()).toEqual([]);
    container.fake!.failNext("company.about", "throw");
    expect(await errorOf(await draft())).toMatchObject({ code: "assistant_unavailable", message: NOT_AVAILABLE });
    const open = await standing();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: "critical", status: "open", title: IS_NOT_ANSWERING, details: { cause: "outage", task: "company.about" } });
    expect(open[0].body).toContain("The AI provider did not answer when someone asked for a draft of the text about their company, in Settings");
    expect(open[0].body).toContain("Check the provider's status page");
    // a draft that is written resolves it
    expect((await draft()).status).toBe(201);
    expect(await standing()).toEqual([]);

    // one failure in the job builder, then one here, within the window: the second is the outage
    const before = (await alerts()).length;
    container.fake!.failNext("intake.turn", "throw");
    const started = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, CA." })).json()) as IntakeStartResponse;
    expect(started.reply).toMatchObject({ unavailable: true, recovery: ASSISTANT_UNAVAILABLE_LINE });
    // the two failures before were resolved with their alert, but they are still within the window: this one is alerted at once
    const afterTurn = await standing();
    expect(afterTurn).toHaveLength(1);
    expect(afterTurn[0]).toMatchObject({ title: IS_NOT_ANSWERING, details: { cause: "outage", task: "intake.turn" } });
    expect(afterTurn[0].body).toContain("when someone used the job builder");
    expect(afterTurn[0].body).toContain("their words are saved");
    expect(await alerts()).toHaveLength(before + 1);
    // and a draft written here resolves that one too
    expect((await draft()).status).toBe(201);
    expect(await standing()).toEqual([]);
  });

  it("keeps its usual words, and alerts nobody, when the failure is not the provider's", async () => {
    const before = (await alerts()).length;
    container.fake!.failNext("company.about", "unusable");
    const failed = await draft();
    expect(failed.status).toBe(502);
    expect(await errorOf(failed)).toMatchObject({ code: "ai_failed", message: "The assistant could not write a draft just now. Try again in a minute, or write the text yourself." });
    expect(await standing()).toEqual([]);
    expect(await alerts()).toHaveLength(before);
  });
});

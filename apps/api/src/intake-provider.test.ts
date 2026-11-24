import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { StructuredRequest, StructuredResult } from "@ros/ai";
import type { AdminFailures, IntakeSessionView, IntakeStartResponse, IntakeTurnResponse } from "@ros/contracts";
import { ALERT_EMAIL_JOB_KIND, setAlertEmails } from "@ros/core";
import { adminAlerts, auditRecords, jobs } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { ASSISTANT_UNAVAILABLE_ALERT_KIND, ASSISTANT_UNAVAILABLE_LINE } from "./services/assistant-unavailable";
import { seedCompany, signInAdmin, usePlan } from "./test-helpers";

/**
 * The job builder when the AI provider itself is the problem. On 24 November 2026 the provider answered every call with
 * 401 "invalid x-api-key": each owner read "The assistant could not reply just now. Your words are saved. Try again.",
 * which could not work, and nobody at ITS was told, because only held background work raised an alert. Now the owner
 * reads one true sentence, a platform administrator gets one critical alert, and the alert resolves itself when the
 * assistant answers again. Any other failure keeps its words and alerts nobody.
 */
describe("the job builder when the AI provider is the problem", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let draftId = "";
  const sessions = "/api/v1/intake/sessions";
  const HYGIENIST = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  const REFUSES_OUR_ACCOUNT = "The AI provider refuses our account: the job builder cannot answer";
  const IS_NOT_ANSWERING = "The AI provider is not answering: the job builder cannot answer";
  const NOT_AVAILABLE = { error: "The assistant is not available right now.", recovery: "The assistant is not available right now. Your words are saved; try again later.", upgrade: false, ask: null, unavailable: true };
  type Refusal = { error: { code: string; message: string } };

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const say = async (message: string): Promise<IntakeTurnResponse> => {
    const r = await json(owner, "POST", `${sessions}/${draftId}/messages`, { message });
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as IntakeTurnResponse;
  };
  /** Every alert that the assistant is not available, oldest first, and the ones still standing. */
  const alerts = async () => (await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, ASSISTANT_UNAVAILABLE_ALERT_KIND))).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const standing = async () => (await alerts()).filter((a) => a.status !== "resolved");
  const mail = () => (container.integrations.email as FakeEmailAdapter).sent;

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
    const made = await seedCompany(app, { email: "owner@provider.test", name: "Harbor Dental" });
    owner = made.owner;
    await usePlan(container, made.companyId, "ultra");
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com");
    answers = container.ai.provider.structured.bind(container.ai.provider);
    // as in every process but a test's: a critical alert queues its email to the platform administrators
    setAlertEmails(() => container.engine.clock());
  });
  afterAll(async () => {
    setAlertEmails(null);
    await container.close();
  });

  it("tells the owner the assistant is not available, never 'Try again', and raises one critical alert, once, when the provider refuses our account", async () => {
    refuseOurAccount();
    const r = await json(owner, "POST", sessions, { initialMessage: HYGIENIST });
    expect(r.status, await r.clone().text()).toBe(201);
    const started = (await r.json()) as IntakeStartResponse;
    expect(started.reply).toEqual(NOT_AVAILABLE);
    expect(NOT_AVAILABLE.recovery).toBe(ASSISTANT_UNAVAILABLE_LINE);
    expect(JSON.stringify(started.reply)).not.toContain("Try again");
    // the owner's words are saved, as the sentence says
    expect(started.session?.messages.map((m) => [m.role, m.content])).toEqual([["owner", HYGIENIST]]);
    draftId = started.session!.id;

    const [alert, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(alert).toMatchObject({ severity: "critical", status: "open", title: REFUSES_OUR_ACCOUNT, companyId: null, details: { cause: "account", task: "intake.turn" } });
    // what to check, and the provider's own words, cut to 200 characters
    expect(alert.body).toContain("Check the API key");
    expect(alert.body).toContain("billing");
    expect(alert.body).toContain(`The error was: ${PROVIDER_SAID.replace("provider error: ", "").slice(0, 200)}.`);
    expect(alert.body).not.toContain("provider error:");
    expect(alert.body).not.toContain("status page");

    // it fails again, and again: still the one alert
    expect((await say("It is full time.")).reply).toEqual(NOT_AVAILABLE);
    expect((await say("Monday to Friday.")).reply).toEqual(NOT_AVAILABLE);
    expect((await alerts()).map((a) => a.id)).toEqual([alert.id]);

    // an administrator sees it in the console, and is emailed once
    const listed = (await (await json(admin, "GET", "/api/v1/admin/failures")).json()) as AdminFailures;
    expect(listed.alerts.filter((a) => a.kind === ASSISTANT_UNAVAILABLE_ALERT_KIND).map((a) => [a.id, a.title, a.severity, a.status])).toEqual([[alert.id, REFUSES_OUR_ACCOUNT, "critical", "open"]]);
    const queued = (await container.db.select().from(jobs).where(eq(jobs.kind, ALERT_EMAIL_JOB_KIND))).filter((j) => (j.payload as { alertId?: string }).alertId === alert.id);
    expect(queued).toHaveLength(1);
    await container.drain();
    expect(mail().filter((m) => m.subject === `Critical alert: ${REFUSES_OUR_ACCOUNT}`).map((m) => m.to)).toEqual(["ada.admin@identifiedtalent.com"]);

    // the engine's own check closes its outage alert whenever no background work is held: it leaves this one standing
    await container.engine.checkHeldRuns();
    expect((await alerts()).map((a) => a.status)).toEqual(["open"]);
  });

  it("resolves the alert by itself when a later turn is answered, so the next trouble is a new alert", async () => {
    answerAgain();
    const turned = await say("Must-haves: active CA RDH license, periodontal charting.");
    expect(turned.reply).toMatchObject({ notARole: false });
    expect("error" in turned.reply).toBe(false);
    // the words typed while the provider refused were kept, as the sentence said, and are read now
    expect(turned.session.facts).toMatchObject({ title: "registered dental hygienist", locationText: "Tustin, CA", employmentType: "full_time", compensationMin: 45, compensationMax: 55, mustHaves: ["Active CA RDH license", "Periodontal charting"] });
    expect(turned.session.readiness).toMatchObject({ mayDraft: true, payConfirmed: true });
    const [alert, ...more] = await alerts();
    expect(more).toEqual([]);
    expect(alert.status).toBe("resolved");
    expect(alert.resolvedAt).toBeTruthy();
    const record = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "alert.resolved"))).find((a) => (a.details as { alertId?: string }).alertId === alert.id);
    expect(record).toMatchObject({ reason: "the assistant answered in the job builder again", details: { automatic: true } });
    // gone from the console's list
    const listed = (await (await json(admin, "GET", "/api/v1/admin/failures")).json()) as AdminFailures;
    expect(listed.alerts.filter((a) => a.kind === ASSISTANT_UNAVAILABLE_ALERT_KIND)).toEqual([]);
  });

  it("says the same on 'Write the job', keeps everything confirmed, and resolves the alert when the writing works", async () => {
    const view = async () => ((await (await json(owner, "GET", `${sessions}/${draftId}`)).json()) as { session: IntakeSessionView }).session;
    expect((await view()).readiness).toMatchObject({ mayDraft: true, payConfirmed: true });
    refuseOurAccount();
    const refused = await json(owner, "POST", `${sessions}/${draftId}/draft`);
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as Refusal).error).toMatchObject({ code: "assistant_unavailable", message: "The assistant is not available right now. Your words are saved; try again later." });
    const open = await standing();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: "critical", status: "open", title: REFUSES_OUR_ACCOUNT, details: { cause: "account", task: "intake.compile" } });
    // a turn that fails too, while that alert stands, raises nothing more
    expect((await say("Benefits: health cover")).reply).toEqual(NOT_AVAILABLE);
    expect((await standing()).map((a) => a.id)).toEqual([open[0].id]);
    // nothing confirmed was lost, and the page shows the writing as failed, not as still running
    const after = await view();
    expect(after.readiness).toMatchObject({ mayDraft: true, payConfirmed: true, hasDraft: false });
    expect(after.progress?.stage).toBe("failed");

    answerAgain();
    const written = await json(owner, "POST", `${sessions}/${draftId}/draft`);
    expect(written.status, await written.clone().text()).toBe(200);
    expect(((await written.json()) as { session: IntakeSessionView }).session.draft?.identity.title).toBe("registered dental hygienist");
    expect(await standing()).toEqual([]);
  });

  it("raises the alert in its own words when the provider is not answering", async () => {
    container.fake!.failNext("intake.turn", "throw");
    expect((await say("Deal-breaker: cannot work Saturdays")).reply).toEqual(NOT_AVAILABLE);
    const open = await standing();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: "critical", status: "open", title: IS_NOT_ANSWERING, details: { cause: "outage", task: "intake.turn" } });
    expect(open[0].body).toContain("Check the provider's status page");
    expect(open[0].body).toContain("The error was: fake provider outage.");
    // the next turn is answered: resolved
    expect("error" in (await say("Ask applicants whether they can work Saturdays")).reply).toBe(false);
    expect(await standing()).toEqual([]);
    expect(await alerts()).toHaveLength(3);
  });

  it("keeps its usual words, and alerts nobody, when the failure is not the provider's", async () => {
    // the assistant answered, in words that could not be used
    container.fake!.failNext("intake.turn", "unusable");
    expect((await say("Benefits: dental cover")).reply).toEqual({ error: "The assistant could not answer that.", recovery: "Your words are saved. Try again.", upgrade: false, ask: null });
    container.fake!.failNext("intake.compile", "unusable");
    const failed = await json(owner, "POST", `${sessions}/${draftId}/draft`);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as Refusal).error).toMatchObject({ code: "ai_failed", message: "The assistant could not write the job. Everything you confirmed is kept. Try again." });
    expect(await standing()).toEqual([]);
    expect(await alerts()).toHaveLength(3);
  });
});

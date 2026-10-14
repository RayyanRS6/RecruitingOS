import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { aiRuns, intakeSessions } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { fairSuggestions, suggestInput } from "./services/intake-suggest";
import { signInAs } from "./test-helpers";

/**
 * Suggestions for the quick start (Wave S3, G3): POST /api/v1/intake/suggestions. Only people who may start a draft ask;
 * only the job's facts go to the model; every suggestion passed the fairness word check, and refused ones are left out
 * without a word; the run is logged in ai_runs; a failed run answers with nothing to show, never an error.
 */
describe("the quick start's suggestions", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let interviewer = "";
  let companyId = "";
  const post = (cookie: string, body: unknown) => app.request("/api/v1/intake/suggestions", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  type Answer = { mustHaves: string[]; questions: string[]; unavailable?: boolean };
  const runs = () => container.db.select().from(aiRuns).where(and(eq(aiRuns.companyId, companyId), eq(aiRuns.task, "intake.suggest")));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@suggest.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ name: "Lone Star Couriers", vertical: "logistics", sizeBand: "20-49", locations: [{ city: "Austin", region: "TX", country: "US" }] }) })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("suggests must-haves and yes/no questions for any job title, logs the run, and starts no draft", async () => {
    const r = await post(owner, { title: "Delivery driver", employmentType: "part_time", remotePolicy: "onsite", place: "Austin, TX", experience: "2" });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Answer;
    expect(body.unavailable).toBeUndefined();
    expect(body.mustHaves).toContain("Valid driver's licence and a clean driving record");
    expect(body.questions).toContain("Do you hold a valid driver's licence?");
    const [run] = await runs();
    expect(run).toMatchObject({ agent: "intake", promptKey: "intake.suggest", promptVersion: 1, status: "ok" });
    expect(run.inputRef).toMatchObject({ purpose: "quick_start" });
    expect(container.fake!.calls.at(-1)).toMatchObject({ task: "intake.suggest", promptKey: "intake.suggest" });
    expect(await container.db.select().from(intakeSessions).where(eq(intakeSessions.companyId, companyId))).toEqual([]);
  });

  it("drops every suggestion the fairness check refuses, and anything that is not a short must-have or a yes/no question", async () => {
    container.fake!.scriptNext("intake.suggest", {
      mustHaves: ["Forklift certification", "Recent graduate", "Native English speaker", "forklift certification", "Can you lift?", "A very long line ".repeat(8)],
      questions: ["Can you lift 50 lb?", "Are you under 40?", "Tell us about yourself.", "Do you hold a valid driver's licence?"],
    });
    const body = (await (await post(owner, { title: "Warehouse associate" })).json()) as Answer;
    expect(body).toEqual({ mustHaves: ["Forklift certification"], questions: ["Can you lift 50 lb?", "Do you hold a valid driver's licence?"] });
  });

  it("answers with nothing to show when the assistant fails, and the failed run is logged too", async () => {
    const before = (await runs()).length;
    container.fake!.failNext("intake.suggest", "throw");
    const r = await post(owner, { title: "Dispatcher" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mustHaves: [], questions: [], unavailable: true });
    const after = await runs();
    expect(after).toHaveLength(before + 1);
    expect(after.some((x) => x.status === "error")).toBe(true);
  });

  it("is for people who may start a draft, and needs a title", async () => {
    expect((await post(interviewer, { title: "Delivery driver" })).status).toBe(403);
    expect((await post(owner, { title: "  " })).status).toBe(400);
    // only the job's facts are read: anything else is refused
    expect((await post(owner, { title: "Driver", candidate: "Jane Doe" })).status).toBe(400);
  });
});

describe("the hourly allowance of suggestion calls", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_OVERRIDES: JSON.stringify({ "intake.suggest": 1 }) } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("once used up, answers with nothing to show and calls no model, so the page still moves on quietly", async () => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@suggest-limit.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    const owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const companyId = ((await (await app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ name: "Hill Country Couriers", vertical: "logistics", sizeBand: "20-49", locations: [{ city: "Austin", region: "TX", country: "US" }] }) })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const post = () => app.request("/api/v1/intake/suggestions", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ title: "Delivery driver" }) });
    const first = (await (await post()).json()) as { mustHaves: string[]; unavailable?: boolean };
    expect(first.unavailable).toBeUndefined();
    expect(first.mustHaves.length).toBeGreaterThan(0);
    const calls = container.fake!.calls.filter((c) => c.task === "intake.suggest").length;
    const second = await post();
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ mustHaves: [], questions: [], unavailable: true });
    expect(container.fake!.calls.filter((c) => c.task === "intake.suggest")).toHaveLength(calls);
    expect(await container.db.select().from(aiRuns).where(and(eq(aiRuns.companyId, companyId), eq(aiRuns.task, "intake.suggest")))).toHaveLength(1);
  });
});

describe("what the model is given and what the page may show", () => {
  it("reads the quick start's experience as years", () => {
    expect(suggestInput({ title: "Driver", experience: "none" }).minYears).toBe(0);
    expect(suggestInput({ title: "Driver", experience: "5" }).minYears).toBe(5);
    expect(suggestInput({ title: "Driver" })).toEqual({ title: "Driver", employmentType: null, remotePolicy: null, place: null, minYears: null });
  });

  it("keeps each suggestion once, without list marks, at most eight and four", () => {
    const out = fairSuggestions({ mustHaves: ["- Forklift", "1. Forklift", ...Array.from({ length: 10 }, (_, i) => `Skill ${i}`)], questions: ["Can you drive?", "can you drive", "Do you lift?", "Are you free weekends?", "Is travel fine?", "Will you work nights?"] });
    expect(out.mustHaves).toEqual(["Forklift", "Skill 0", "Skill 1", "Skill 2", "Skill 3", "Skill 4", "Skill 5", "Skill 6"]);
    expect(out.questions).toEqual(["Can you drive?", "Do you lift?", "Are you free weekends?", "Is travel fine?"]);
    // "can you drive" is not a question (no question mark): dropped, not a duplicate
    expect(out.dropped).toBe(1);
  });
});

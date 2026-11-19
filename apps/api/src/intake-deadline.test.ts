import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StructuredRequest } from "@ros/ai";
import { entitlements } from "@ros/core";
import type { IntakeSessionView } from "@ros/contracts";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The deadline of an /api request that runs more than one slow step: a pasted ad's read followed by the turn, or the
 * saves before the job is written. The agent sets the request's deadline once, at its start, and every model call in
 * the request is sent with that same deadline, so none runs past the route's 300 s limit.
 */
describe("the deadline of an intake request", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let sessionId = "";
  const seen: Array<{ task: string; deadlineAt?: number }> = [];
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });

  // Long enough, over enough lines, to be read as a pasted job ad: the turn reads it first, in the same request.
  const AD = [
    "Dental Assistant",
    "Location: Irvine, CA",
    "Full time, Monday to Friday, 8am to 5pm",
    "Pay: $24 - $28 per hour",
    "About us: Harbor Dental is a family practice that has served Irvine for twenty years.",
    "What you will do: seat patients, take digital x-rays and keep the operatories ready.",
    "Requirements: radiography certificate and two years of chairside experience.",
    "Benefits: paid time off, dental care for you and your family, and a uniform allowance.",
  ].join("\n");

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@deadline.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const company = (await (await json("POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    await entitlements.applyPlan(container.db, company.id, "ultra");
    // Every request the agents send to the model passes here first, so the test sees each call's deadline.
    const provider = container.ai.provider;
    const structured = provider.structured.bind(provider);
    provider.structured = <T>(req: StructuredRequest<T>, model: string) => {
      seen.push({ task: req.task, deadlineAt: req.deadlineAt });
      return structured(req, model);
    };
  });
  afterAll(async () => {
    await container.close();
  });

  it("a pasted ad's read and the turn after it share one deadline: the request's, 300 s from its start", async () => {
    seen.length = 0;
    const before = Date.now();
    const r = await json("POST", "/api/v1/intake/sessions", { initialMessage: AD });
    const after = Date.now();
    expect(r.status).toBe(201);
    sessionId = ((await r.json()) as { session: IntakeSessionView }).session.id;
    expect(seen.map((s) => s.task)).toEqual(["intake.extract", "intake.turn"]);
    const [read, turn] = seen;
    expect(turn!.deadlineAt).toBe(read!.deadlineAt);
    expect(read!.deadlineAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(read!.deadlineAt).toBeLessThanOrEqual(after + 300_000);
  });

  it("writing the job counts the saves before the call against the request's deadline", async () => {
    // the cards are answered until the job may be written: the ad's pay confirmed, on site, the schedule, one must-have
    let draft = ((await (await json("GET", `/api/v1/intake/sessions/${sessionId}`)).json()) as { session: IntakeSessionView }).session;
    for (let round = 0; round < 4 && !draft.readiness.mayDraft; round++) {
      const answers = draft.questions.map((q) => (q.mode === "pay" ? { questionId: q.id, pay: { basis: "hourly", min: 24, max: 28 } } : q.field === "remote_policy" ? { questionId: q.id, selected: ["onsite"] } : q.field === "must_haves" ? { questionId: q.id, own: ["Radiography certificate"] } : q.options[0] ? { questionId: q.id, selected: [q.options[0].value] } : { questionId: q.id, skipped: true }));
      draft = ((await (await json("POST", `/api/v1/intake/sessions/${sessionId}/answers`, { answers })).json()) as { session: IntakeSessionView }).session;
    }
    expect(draft.readiness.mayDraft, draft.readiness.draftBlocker ?? "").toBe(true);
    seen.length = 0;
    const before = Date.now();
    expect((await json("POST", `/api/v1/intake/sessions/${sessionId}/draft`)).status).toBe(200);
    const after = Date.now();
    const compile = seen.find((s) => s.task === "intake.compile");
    expect(compile?.deadlineAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(compile?.deadlineAt).toBeLessThanOrEqual(after + 300_000);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HomeView } from "@ros/contracts";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInByEmailLink } from "./test-helpers";

/**
 * The first screens: the company keeps the time zone its owner chose instead of a silent Los Angeles, and a brand-new
 * company's Home has room to start a hire, with nothing else on it.
 */
describe("sign-up and the first Home", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signInByEmailLink(app, "owner@first.test");
  });
  afterAll(async () => {
    await container.close();
  });

  it("keeps the time zone the owner chose, and refuses one that does not exist", async () => {
    const bad = await json(owner, "POST", "/api/v1/companies", { name: "First Dental", vertical: "dental", sizeBand: "1-19", timezone: "Mars/Olympus_Mons", locations: [{ city: "Austin", region: "TX", country: "US" }] });
    expect(bad.status).toBe(400);
    const r = await json(owner, "POST", "/api/v1/companies", { name: "First Dental", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", locations: [{ city: "Austin", region: "TX", country: "US" }] });
    expect(r.status).toBe(201);
    const current = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { timezone: string };
    expect(current.timezone).toBe("America/Chicago");
  });

  it("a brand-new company's Home has room to start a hire: no job, no draft and no notice yet, and the plan has a place free", async () => {
    const r = await json(owner, "GET", "/api/v1/home");
    expect(r.status).toBe(200);
    const home = (await r.json()) as HomeView;
    expect(home.jobs).toEqual([]);
    expect(home.drafts).toEqual([]);
    expect(home.notices).toEqual([]);
    expect(home.room).toMatchObject({ ok: true, used: 0, holding: [], message: null, ask: null });
    // and the first draft starts
    expect((await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Austin, $24 to $28 an hour, full time." })).status).toBe(201);
    expect(((await (await json(owner, "GET", "/api/v1/home")).json()) as HomeView).drafts).toHaveLength(1);
  });
});

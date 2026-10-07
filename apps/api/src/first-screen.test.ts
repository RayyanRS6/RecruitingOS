import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * The first screens (plan item 0.10): the company keeps the time zone its owner chose instead of a silent Los Angeles,
 * and a brand-new company's Today offers a way forward instead of an "All clear" with no button.
 */
describe("sign-up and the first Today", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  type Card = { kind: string; title: string; body: string; actions: Array<{ label: string; method: string; path: string }> };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@first.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  });
  afterAll(async () => {
    await container.close();
  });

  it("keeps the time zone the owner chose, and refuses one that does not exist", async () => {
    const bad = await json(owner, "POST", "/api/v1/companies", { name: "First Dental", vertical: "dental", sizeBand: "1-19", timezone: "Mars/Olympus_Mons", locations: [{ city: "Austin", region: "TX", country: "US" }] });
    expect(bad.status).toBe(400);
    const r = await json(owner, "POST", "/api/v1/companies", { name: "First Dental", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", locations: [{ city: "Austin", region: "TX", country: "US" }] });
    expect(r.status).toBe(201);
    companyId = ((await r.json()) as { id: string }).id;
    const current = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { timezone: string };
    expect(current.timezone).toBe("America/Chicago");
  });

  it("a brand-new company's Today offers 'Start a hire' to those who can, and an honest line to those who cannot", async () => {
    const cards = ((await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards;
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "empty", title: "Tell me who you need to hire" });
    expect(cards[0].actions).toEqual([{ label: "Start a hire", method: "GET", path: "/?start=1" }]);
    const hr = await signInAs(container, app, { companyId, role: "hr" });
    const theirs = ((await (await json(hr, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards;
    expect(theirs).toHaveLength(1);
    expect(theirs[0].title).toBe("No roles are open yet");
    expect(theirs[0].actions).toEqual([]);
  });
});

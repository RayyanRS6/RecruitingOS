import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HomeView, IntakeSessionList, IntakeSessionView, IntakeStartResponse } from "@ros/contracts";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { seedCompany, signInAs, usePlan } from "./test-helpers";

/**
 * The drafts of the job builder as the lists show them, through the API on the stand-in AI: Home, the Jobs page and the
 * builder's first page read one summary of each draft (services/drafts.ts), so they cannot say different things about
 * the same draft.
 */
describe("the drafts lists", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  const sessions = "/api/v1/intake/sessions";
  const send = async <T>(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const r = await app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as T };
  };
  /** An owner's first sentence with every essential in it, the pay typed by them. */
  const HYGIENIST = "I need a registered dental hygienist in Tustin, CA, on site, full time, Monday to Friday, $45 to $55 an hour. Must-haves: active CA RDH license, periodontal charting.";
  /** A sentence that leaves essentials to ask for. */
  const ENGINEER = "Software Engineer required with 3 years of hands-on experience in Python and Flask";
  const start = async (cookie: string, words: string): Promise<IntakeSessionView> => {
    const started = await send<IntakeStartResponse>(cookie, "POST", sessions, { initialMessage: words });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    return started.body.session!;
  };
  const listOf = async (cookie: string, query = "") => (await send<IntakeSessionList>(cookie, "GET", `${sessions}${query}`)).body.sessions;
  const homeDrafts = async (cookie: string) => (await send<HomeView>(cookie, "GET", "/api/v1/home")).body.drafts;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const made = await seedCompany(app, { email: "owner@draft-lists.test", name: "Harbor Dental" });
    owner = made.owner;
    companyId = made.companyId;
    await usePlan(container, companyId, "ultra");
  });
  afterAll(async () => {
    await container.close();
  });

  it("show one summary of each draft: Home's lines are the very lines of the person's own list, and of the company's list", async () => {
    const full = await start(owner, HYGIENIST);
    const partial = await start(owner, ENGINEER);
    const mine = await listOf(owner, "?mine=1");
    expect(mine.map((d) => d.id).sort()).toEqual([full.id, partial.id].sort());
    expect(await homeDrafts(owner)).toEqual(mine);
    expect(await listOf(owner)).toEqual(mine);
    // a teammate's draft is in the company's list an owner reads, with the same line the teammate reads of it but for whose it is
    const member = await signInAs(container, app, { companyId, role: "hiring_manager", name: "Eli Example" });
    const theirs = await start(member, ENGINEER);
    const [asTheirs] = await listOf(member);
    expect(asTheirs).toMatchObject({ id: theirs.id, mine: true });
    expect(await homeDrafts(member)).toEqual([asTheirs]);
    const asOwner = (await listOf(owner)).find((d) => d.id === theirs.id);
    expect(asOwner).toEqual({ ...asTheirs, mine: false });
    // Home lists a person's own drafts only, an owner's too
    expect((await homeDrafts(owner)).map((d) => d.id)).not.toContain(theirs.id);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, memberships, roles, users } from "@ros/db";
import type { FakeUrlVerifier } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { PERMISSION_MESSAGE } from "./middleware/errors";

/**
 * Posting work belongs to role.manage (owner, admin, recruiter; docs/12-api-contracts.md). A hiring manager and HR are
 * refused every posting change, so they must not be sent posting work either: Today leaves out the "post it on the
 * board" and "still posted on" cards for them, and a refusal reads in plain words, never "role.manage". HR may still
 * close the role (outcome.record); the boards left up then go to the people who can take them down.
 */
describe("posting work goes only to the roles that can do it", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let manager = "";
  let hr = "";
  let companyId = "";
  let roleId = "";
  let roleTitle = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const get = (cookie: string, path: string) => json(cookie, "GET", path);
  const post = (cookie: string, path: string, body?: unknown) => json(cookie, "POST", path, body ?? {});
  const P = (channel: string, action: string) => `/api/v1/roles/${roleId}/postings/${channel}/${action}`;
  type Brief = { cards: Array<{ kind: string; title: string; body: string; roleId?: string }> };
  type ErrorBody = { error: { code: string; message: string; details?: { permission?: string } } };
  const brief = async (cookie: string) => ((await (await get(cookie, "/api/v1/brief")).json()) as Brief).cards;
  const postingCards = async (cookie: string) => (await brief(cookie)).filter((c) => c.kind === "posting_action");
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const member = async (email: string, name: string, role: "hiring_manager" | "hr") => {
    const [person] = await container.db.insert(users).values({ email, name }).returning();
    await container.db.insert(memberships).values({ companyId, userId: person.id, role, status: "active" });
    return signIn(email);
  };
  const expectPlainRefusal = async (r: Response, permission: string) => {
    expect(r.status).toBe(403);
    const e = (await r.json()) as ErrorBody;
    expect(e.error.code).toBe("forbidden");
    expect(e.error.message).toBe(PERMISSION_MESSAGE);
    expect(e.error.message).not.toMatch(/role\.manage|hiring_manager|\(hr\)|permission/);
    expect(e.error.details?.permission).toBe(permission);
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", APP_BASE_URL: "http://localhost:3000", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    owner = await signIn("owner@access.test");
    const co = (await (await post(owner, "/api/v1/companies", { name: "Access Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    companyId = co.id;
    const s = (await (await post(owner, "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, $24 to $30 an hour, full time. It's growth. Ceiling $32. I decide. Must-haves: x-ray certificate. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await post(owner, `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    // A company that posts on the boards itself (plan D3): the posting work is the team's. With ITS posting (the
    // default) it is ITS's task instead, and no team member gets these cards (publishing.test.ts).
    const [co0] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: { ...co0.settings, boardPosting: "self" } }).where(eq(companies.id, companyId));
    expect((await post(owner, `/api/v1/roles/${roleId}/channels`, { channels: ["linkedin_basic", "indeed"] })).status).toBe(200);
    expect((await post(owner, `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    roleTitle = (await container.db.select({ title: roles.title }).from(roles).where(eq(roles.id, roleId)))[0].title;
    manager = await member("manager@access.test", "Hana Manager", "hiring_manager");
    hr = await member("people@access.test", "Rae People", "hr");
  });
  afterAll(async () => {
    await container.close();
  });

  it("the boards waiting to be posted by hand are the owner's card, not the hiring manager's or HR's", async () => {
    const mine = await postingCards(owner);
    expect(mine.some((c) => c.title.includes("from your own account") && c.roleId === roleId)).toBe(true);
    expect(await postingCards(manager)).toEqual([]);
    expect(await postingCards(hr)).toEqual([]);
    // the rest of their Today is untouched: they still see the role's other cards, just not posting work
    expect((await brief(manager)).length).toBeGreaterThan(0);
  });

  it("a hiring manager or HR asking for a posting change is refused in plain words", async () => {
    await expectPlainRefusal(await post(manager, P("indeed", "pause")), "role.manage");
    await expectPlainRefusal(await post(manager, P("indeed", "url"), { url: "https://www.indeed.com/viewjob?jk=1" }), "role.manage");
    await expectPlainRefusal(await post(hr, `/api/v1/roles/${roleId}/applications/accepting`, { accepting: false }), "role.manage");
    await expectPlainRefusal(await post(hr, `/api/v1/roles/${roleId}/pause`), "role.manage");
    // and one of the other permissions, to show the words are not about postings only
    await expectPlainRefusal(await post(hr, `/api/v1/roles/${roleId}/packets`, { packet: {}, changeSummary: "x" }), "packet.edit");
  });

  it("when HR closes the role, the board still up is the owner's to take down and tick off, not HR's", async () => {
    const url = "https://www.linkedin.com/jobs/view/42";
    (container.integrations.verifier as FakeUrlVerifier).set(url, { pageText: `<html><title>${roleTitle} | Access Dental | LinkedIn</title></html>` });
    expect((await post(owner, P("linkedin_basic", "url"), { url })).status).toBe(200);
    await container.drain();
    expect((await post(hr, `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true })).status).toBe(200);
    const ownerCards = await postingCards(owner);
    expect(ownerCards.map((c) => c.title)).toContain("Still posted on LinkedIn");
    expect(await postingCards(hr)).toEqual([]);
    expect(await postingCards(manager)).toEqual([]);
    await expectPlainRefusal(await post(hr, P("linkedin_basic", "closure-confirm")), "role.manage");
    expect((await post(owner, P("linkedin_basic", "closure-confirm"))).status).toBe(200);
    expect((await postingCards(owner)).map((c) => c.title)).not.toContain("Still posted on LinkedIn");
  });
});

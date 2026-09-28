import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { integrations, memberships, users } from "@ros/db";
import type { MemorySecretStore } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Calendar connections belong to one person in one company. Two interviewers in the same company each connect their
 * own Google Calendar (the company-wide unique index that blocked the second one is gone, migration 0018), and the
 * consent callback trusts only the signed-in session for who and which company, never a cookie a browser could edit.
 */
describe("calendar connections: one per person, bound to the signed-in company", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const store = () => container.integrations.secrets as MemorySecretStore;

  /** Starts the browser flow and returns the consent cookie and the callback URL the fake consent page redirects to. */
  const beginConsent = async (cookie: string, email: string) => {
    const start = await app.request("/api/v1/integrations/calendar/google/connect", { headers: { cookie } });
    expect(start.status).toBe(302);
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    expect(pkce).toMatch(/^ros_cal_pkce=v1\./); // sealed, not a readable list of ids
    const authorize = new URL(start.headers.get("location")!);
    const consent = await app.request("/api/v1/integrations/calendar/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ redirect_to: `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/google/callback`, state: authorize.searchParams.get("state")!, code_challenge: authorize.searchParams.get("code_challenge")!, email, timezone: "America/Los_Angeles" }).toString() });
    const cb = new URL(consent.headers.get("location")!);
    return { pkce, cb, callbackPath: `${cb.pathname}?${cb.searchParams.toString()}` };
  };
  const finishConsent = async (cookie: string, pkce: string, callbackPath: string) => {
    const done = await app.request(callbackPath, { headers: { cookie: `${cookie}; ${pkce}` } });
    return { status: done.status, location: done.headers.get("location") ?? "" };
  };
  const connect = async (cookie: string, email: string) => {
    const { pkce, callbackPath } = await beginConsent(cookie, email);
    return finishConsent(cookie, pkce, callbackPath);
  };

  let owner = "";
  let ownerId = "";
  let interviewer = "";
  let interviewerId = "";
  let companyA = "";
  let ownerC = "";
  let companyC = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@twocal.test");
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Two Calendars Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string };
    companyA = co.id;
    ownerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@twocal.test")))[0].id;
    // a second interviewer on the same team, signed in after the membership exists so the session lands in company A
    const [second] = await container.db.insert(users).values({ email: "interviewer@twocal.test", name: "Sam Interviewer" }).returning();
    interviewerId = second.id;
    await container.db.insert(memberships).values({ companyId: companyA, userId: second.id, role: "interviewer", status: "active" });
    interviewer = await signIn("interviewer@twocal.test");
    ownerC = await signIn("owner@othercal.test");
    companyC = ((await (await json(ownerC, "POST", "/api/v1/companies", { name: "Other Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Reno", region: "NV", country: "US" }] })).json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("two members of one company each connect their own Google Calendar", async () => {
    const first = await connect(owner, "owner@twocal.test");
    expect(first.location).toContain("calendar=connected");
    const second = await connect(interviewer, "interviewer@twocal.test");
    expect(second.status).toBe(302);
    expect(second.location).toContain("calendar=connected");
    const rows = await container.db.select().from(integrations).where(and(eq(integrations.companyId, companyA), eq(integrations.kind, "calendar")));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId).sort()).toEqual([ownerId, interviewerId].sort());
    expect(rows.every((r) => r.status === "live" && !!r.secretRef)).toBe(true);
    expect(store().size).toBe(2);
    const mine = (await (await json(interviewer, "GET", "/api/v1/me/calendar")).json()) as { connection: { externalAccountId: string; status: string } | null };
    expect(mine.connection).toMatchObject({ externalAccountId: "interviewer@twocal.test", status: "live" });
    const members = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ userId: string; calendar: { email: string | null } | null }>;
    expect(members.find((m) => m.userId === interviewerId)?.calendar?.email).toBe("interviewer@twocal.test");
  });

  it("reconnecting replaces a person's own connection instead of adding a second one", async () => {
    const again = await connect(owner, "owner@twocal.test");
    expect(again.location).toContain("calendar=connected");
    const rows = await container.db.select().from(integrations).where(and(eq(integrations.companyId, companyA), eq(integrations.kind, "calendar")));
    expect(rows).toHaveLength(2);
    expect(store().size).toBe(2);
  });

  it("the callback refuses a tampered consent cookie, another person's session, a missing state, and never writes into another company", async () => {
    const { pkce, cb, callbackPath } = await beginConsent(ownerC, "owner@othercal.test");
    // the cookie's authentication tag altered by one character (the first of the tag, so real bits change, not padding)
    const tagAt = pkce.lastIndexOf(".") + 1;
    const tampered = pkce.slice(0, tagAt) + (pkce[tagAt] === "A" ? "B" : "A") + pkce.slice(tagAt + 1);
    expect((await finishConsent(ownerC, tampered, callbackPath)).location).toContain("calendar=incomplete");
    // the genuine cookie presented from a different person's session (the owner of company A)
    expect((await finishConsent(owner, pkce, callbackPath)).location).toContain("calendar=incomplete");
    // no state parameter at all
    expect((await finishConsent(ownerC, pkce, `${cb.pathname}?code=${encodeURIComponent(cb.searchParams.get("code")!)}`)).location).toContain("calendar=incomplete");
    // a state that is not the one issued
    expect((await finishConsent(ownerC, pkce, `${cb.pathname}?code=${encodeURIComponent(cb.searchParams.get("code")!)}&state=forged`)).location).toContain("calendar=incomplete");
    expect(await container.db.select().from(integrations).where(eq(integrations.companyId, companyC))).toHaveLength(0);
    expect((await container.db.select().from(integrations).where(eq(integrations.companyId, companyA))).length).toBe(2);
    // the legitimate flow still works for that person afterwards
    const ok = await connect(ownerC, "owner@othercal.test");
    expect(ok.location).toContain("calendar=connected");
    const rowsC = await container.db.select().from(integrations).where(eq(integrations.companyId, companyC));
    expect(rowsC).toHaveLength(1);
    expect(rowsC[0].companyId).toBe(companyC);
  });

  it("the sign-in callback refuses a response without the state it issued", async () => {
    const start = await app.request("/api/v1/auth/start/google", { redirect: "manual" });
    expect(start.status).toBe(302);
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    const r = await app.request("/api/v1/auth/callback?code=anything", { headers: { cookie: pkce }, redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toMatch(/error=signin_incomplete/);
  });
});

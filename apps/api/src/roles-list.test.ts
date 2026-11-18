import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitlements } from "@ros/core";
import { applications, candidates, randomToken, withTenant } from "@ros/db";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { lastActivityOf } from "./routes/roles";
import { createContainer, type Container } from "./container";

/** The Jobs list: every job of the company with its counts, and when anything last happened on each. */
describe("the roles list", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let theirs = "";
  let other = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  type Listed = { id: string; title: string; counts: Record<string, number>; countsHidden?: boolean; needsYou: number };
  const list = async (cookie: string) => {
    const r = await json(cookie, "GET", "/api/v1/roles");
    expect(r.status).toBe(200);
    return (await r.json()) as Listed[];
  };
  const compileRole = async (message: string) => {
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    return ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@roleslist.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "List Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    theirs = await compileRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    other = await compileRole("I need a front office coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $28. I decide. Must-haves: Dentrix scheduling. Just draft it.");
    // one applicant on each role
    await withTenant(container.db, companyId, async (tx) => {
      const [pat] = await tx.insert(candidates).values({ companyId, firstName: "Pat", lastName: "Lee", email: "pat@candidate.test", firstSource: "direct" }).returning();
      const [sam] = await tx.insert(candidates).values({ companyId, firstName: "Sam", lastName: "Ruiz", email: "sam@candidate.test", firstSource: "direct" }).returning();
      await tx.insert(applications).values({ companyId, roleId: theirs, candidateId: pat.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) });
      await tx.insert(applications).values({ companyId, roleId: other, candidateId: sam.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) });
    });
  });
  afterAll(async () => {
    await container.close();
  });

  it("gives the owner every role with its counts", async () => {
    const seen = await list(owner);
    expect(seen.map((r) => r.id).sort()).toEqual([theirs, other].sort());
    for (const r of seen) {
      expect(r.countsHidden).toBeUndefined();
      expect(r.counts.total).toBe(1);
    }
  });

  it("says when anything last happened on each role, for the Jobs page's Recent activity order (Wave S2)", async () => {
    const seen = (await (await json(owner, "GET", "/api/v1/roles")).json()) as Array<Listed & { createdAt: string; lastActivityAt: string }>;
    for (const r of seen) {
      expect(r.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // never earlier than the role itself, and at least as late as its newest application
      expect(Date.parse(r.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(r.createdAt));
    }
    const newest = await withTenant(container.db, companyId, (tx) => tx.select({ createdAt: applications.createdAt }).from(applications).where(eq(applications.roleId, other)));
    const row = seen.find((r) => r.id === other)!;
    expect(Date.parse(row.lastActivityAt)).toBeGreaterThanOrEqual(Date.parse(newest[0].createdAt));
  });

  it("reads the latest of a role's dates and its newest application", () => {
    expect(lastActivityOf({ createdAt: "2026-10-01T00:00:00.000Z" })).toBe("2026-10-01T00:00:00.000Z");
    expect(lastActivityOf({ createdAt: "2026-10-01 00:00:00+00", updatedAt: "2026-10-03 09:30:00+00", openedAt: "2026-10-02T00:00:00Z", pausedAt: null, closedAt: null }, "2026-10-05T08:00:00.000Z")).toBe("2026-10-05T08:00:00.000Z");
    expect(lastActivityOf({ createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-09T00:00:00Z" }, null)).toBe("2026-10-09T00:00:00.000Z");
  });
});

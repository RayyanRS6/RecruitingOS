import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitlements } from "@ros/core";
import { applications, candidates, interviewParticipants, interviews, randomToken, withTenant } from "@ros/db";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { lastActivityOf } from "./routes/roles";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * The roles list for an interviewer (Wave DS; plan backlog item 01): an interviewer holds role.read but not
 * application.read, so GET /roles names only the roles they interview for, the same rule as their interviews list, and
 * carries no applicant counts or waiting decisions. Everyone else still gets every role with its counts.
 */
describe("the roles list", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let theirs = "";
  let other = "";
  let ivan = "";
  let nina = "";
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
  const userId = async (cookie: string) => ((await (await json(cookie, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;

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
    ivan = await signInAs(container, app, { companyId, role: "interviewer", email: "ivan@roleslist.test" });
    nina = await signInAs(container, app, { companyId, role: "interviewer", email: "nina@roleslist.test" });
    const ivanId = await userId(ivan);
    const ownerId = await userId(owner);
    // one applicant on the hygienist role with an interview Ivan sits on; one applicant on the other role with none
    await withTenant(container.db, companyId, async (tx) => {
      const [pat] = await tx.insert(candidates).values({ companyId, firstName: "Pat", lastName: "Lee", email: "pat@candidate.test", firstSource: "direct" }).returning();
      const [sam] = await tx.insert(candidates).values({ companyId, firstName: "Sam", lastName: "Ruiz", email: "sam@candidate.test", firstSource: "direct" }).returning();
      const [app1] = await tx.insert(applications).values({ companyId, roleId: theirs, candidateId: pat.id, packetVersion: 1, source: "direct", stage: "interview_scheduled", statusToken: randomToken(16) }).returning();
      await tx.insert(applications).values({ companyId, roleId: other, candidateId: sam.id, packetVersion: 1, source: "direct", stage: "interview_recommended", statusToken: randomToken(16) });
      const [iv] = await tx.insert(interviews).values({ companyId, applicationId: app1.id, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "scheduling", timezone: "America/Los_Angeles", createdBy: { kind: "user", id: ownerId } }).returning();
      await tx.insert(interviewParticipants).values({ companyId, interviewId: iv.id, userId: ivanId, role: "interviewer", status: "invited" });
    });
  });
  afterAll(async () => {
    await container.close();
  });

  it("gives an interviewer only the roles they interview for, with no applicant counts and nothing waiting on them", async () => {
    const seen = await list(ivan);
    expect(seen.map((r) => r.id)).toEqual([theirs]);
    expect(seen[0]).toMatchObject({ counts: { total: 0 }, countsHidden: true, needsYou: 0 });
    expect(Object.keys(seen[0].counts)).toEqual(["total"]);
  });

  it("gives an interviewer who is on no interview an empty list", async () => {
    expect(await list(nina)).toEqual([]);
  });

  it("still gives the owner every role with its counts", async () => {
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
    // an interviewer gets the time too, from the role's own dates
    const theirsSeen = (await (await json(ivan, "GET", "/api/v1/roles")).json()) as Array<{ lastActivityAt: string }>;
    expect(theirsSeen[0].lastActivityAt).toMatch(/Z$/);
  });

  it("reads the latest of a role's dates and its newest application", () => {
    expect(lastActivityOf({ createdAt: "2026-10-01T00:00:00.000Z" })).toBe("2026-10-01T00:00:00.000Z");
    expect(lastActivityOf({ createdAt: "2026-10-01 00:00:00+00", updatedAt: "2026-10-03 09:30:00+00", openedAt: "2026-10-02T00:00:00Z", pausedAt: null, closedAt: null }, "2026-10-05T08:00:00.000Z")).toBe("2026-10-05T08:00:00.000Z");
    expect(lastActivityOf({ createdAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-09T00:00:00Z" }, null)).toBe("2026-10-09T00:00:00.000Z");
  });
});

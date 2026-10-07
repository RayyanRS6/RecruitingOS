import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { clampLevel, entitlements, resolvePolicy } from "@ros/core";
import { approvalRequests, policies, roles, takeovers, users, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Role approval is always a person; dead settings are gone; offers never run on their own (plan item 0.3). The floors
 * and the ceiling hold in three places: Setup is offered only the allowed choices, the PUT refuses the rest, and a row
 * saved before the rule existed is read through it, so a role can never open, pay included, with nobody approving it.
 */
describe("what the AI may do: floors and ceilings", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let companyId = "";
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  type Row = { actionType: string; level: string; minLevel: string | null; maxLevel: string | null; locked: boolean };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@floors.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    ownerId = (await container.db.select().from(users).where(eq(users.email, "owner@floors.test")))[0].id;
    companyId = ((await (await json("POST", "/api/v1/companies", { name: "Floors Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
  });
  afterAll(async () => {
    await container.close();
  });

  it("the rules list offers only what is allowed, and the dead 'post an approved role' row is gone", async () => {
    const rows = (await (await json("GET", "/api/v1/policies")).json()) as Row[];
    expect(rows.some((r) => r.actionType === "role.publish")).toBe(false);
    expect(rows.find((r) => r.actionType === "role_packet.approve")).toMatchObject({ level: "approval", minLevel: "approval", maxLevel: "approval" });
    for (const a of ["offer.draft", "offer.send", "offer.revise", "interview.request"]) expect(rows.find((r) => r.actionType === a)).toMatchObject({ minLevel: "approval", maxLevel: null });
    expect(rows.find((r) => r.actionType === "message.send_templated")).toMatchObject({ minLevel: null, maxLevel: null });
  });

  it("role approval can be neither automatic nor 'only a person'; offers cannot be automatic", async () => {
    for (const level of ["auto", "auto_notify"]) {
      const r = await json("PUT", "/api/v1/policies", { actionType: "role_packet.approve", level, approverRoles: [] });
      expect(r.status).toBe(400);
      const err = ((await r.json()) as { error: { code: string; message: string } }).error;
      expect(err.code).toBe("minimum_level");
      expect(err.message).toContain("Ask me first");
      expect(err.message).not.toMatch(/approval"|auto/);
    }
    const ceiling = await json("PUT", "/api/v1/policies", { actionType: "role_packet.approve", level: "human_only", approverRoles: [] });
    expect(ceiling.status).toBe(400);
    expect(((await ceiling.json()) as { error: { code: string } }).error.code).toBe("maximum_level");
    expect((await json("PUT", "/api/v1/policies", { actionType: "role_packet.approve", level: "approval", approverRoles: ["owner", "admin", "hiring_manager"] })).status).toBe(200);
    for (const actionType of ["offer.draft", "offer.send", "offer.revise"]) {
      expect((await json("PUT", "/api/v1/policies", { actionType, level: "auto_notify", approverRoles: [] })).status).toBe(400);
      expect((await json("PUT", "/api/v1/policies", { actionType, level: "human_only", approverRoles: [] })).status).toBe(200);
    }
  });

  it("a row saved before the rule is read through it: an 'automatic' role approval still waits for a person", async () => {
    await withTenant(container.db, companyId, async (tx) => {
      await tx.delete(policies).where(and(eq(policies.companyId, companyId), eq(policies.actionType, "role_packet.approve")));
      await tx.insert(policies).values({ companyId, roleId: null, actionType: "role_packet.approve", level: "auto", approverRoles: [], createdBy: { kind: "user", id: ownerId } });
    });
    const decision = await withTenant(container.db, companyId, (tx) => resolvePolicy(tx, companyId, null, "role_packet.approve"));
    expect(decision).toMatchObject({ level: "approval", approverRoles: ["owner", "admin", "hiring_manager"] });
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    const { roleId } = (await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string };
    await container.drain();
    const [role] = await container.db.select().from(roles).where(eq(roles.id, roleId));
    expect(role.status).toBe("pending_approval");
    const [req] = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.actionType, "role_packet.approve")));
    expect(req).toMatchObject({ status: "pending", requiredRoles: ["owner", "admin", "hiring_manager"] });
    // and a stored "only a person" is read as "ask me first", so the role does not sit with nobody asked
    await withTenant(container.db, companyId, (tx) => tx.update(policies).set({ level: "human_only" }).where(and(eq(policies.companyId, companyId), eq(policies.actionType, "role_packet.approve"))));
    expect((await withTenant(container.db, companyId, (tx) => resolvePolicy(tx, companyId, roleId, "role_packet.approve"))).level).toBe("approval");
  });

  it("during a recruiter takeover, a saved 'automatic' role approval still goes to the customer's approvers; automatic actions go to the recruiter", async () => {
    await withTenant(container.db, companyId, (tx) => tx.update(policies).set({ level: "auto", approverRoles: [] }).where(and(eq(policies.companyId, companyId), eq(policies.actionType, "role_packet.approve"))));
    const [role] = await container.db.select().from(roles).where(eq(roles.companyId, companyId)).limit(1);
    const [takeover] = await container.db.insert(takeovers).values({ companyId, roleId: role.id, recruiterUserId: ownerId, status: "active" }).returning();
    try {
      const approve = await withTenant(container.db, companyId, (tx) => resolvePolicy(tx, companyId, role.id, "role_packet.approve"));
      // the recruiter role cannot approve a role, so handing it to them would leave nobody able to
      expect(approve).toMatchObject({ level: "approval", approverRoles: ["owner", "admin", "hiring_manager"] });
      expect(approve.source).not.toBe("takeover");
      const decline = await withTenant(container.db, companyId, (tx) => resolvePolicy(tx, companyId, role.id, "disposition.send"));
      expect(decline).toMatchObject({ level: "approval", approverRoles: ["recruiter"], source: "takeover" });
    } finally {
      await container.db.update(takeovers).set({ status: "ended" }).where(eq(takeovers.id, takeover.id));
    }
  });

  it("clampLevel holds every floor and ceiling and leaves other actions alone", () => {
    expect(clampLevel("role_packet.approve", "auto")).toBe("approval");
    expect(clampLevel("role_packet.approve", "human_only")).toBe("approval");
    expect(clampLevel("offer.send", "auto_notify")).toBe("approval");
    expect(clampLevel("offer.send", "human_only")).toBe("human_only");
    expect(clampLevel("interview.request", "auto")).toBe("approval");
    expect(clampLevel("application.invite_screen", "auto")).toBe("auto");
    expect(clampLevel("application.invite_screen", "human_only")).toBe("human_only");
  });
});

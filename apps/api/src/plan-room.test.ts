import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import type { PlanRoom } from "@ros/contracts";
import { entitlements as entitlementRows, roles, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The plan's role allowance (polish list, plan C13): it counts the roles using a place now (open, paused, waiting for
 * approval, or sent back for changes), not every role ever created, so closing a role gives its place back.
 */
describe("the plan's role allowance counts the roles in use, not every role ever created", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  const actor = { kind: "system" as const, id: "plan_room_test" };
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body === undefined ? undefined : JSON.stringify(body) });
  const room = async () => (await (await json("GET", "/api/v1/intake/room")).json()) as PlanRoom;
  const role = (title: string, status: string) => withTenant(container.db, companyId, async (tx) => (await tx.insert(roles).values({ companyId, title, status, openedAt: status === "open" || status === "paused" ? new Date().toISOString() : null, createdBy: actor }).returning({ id: roles.id }))[0].id);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@plan-room.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json("POST", "/api/v1/companies", { name: "Plan Room Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "core"); // two roles at a time
  });
  afterAll(async () => {
    await container.close();
  });

  it("a closed role uses no place; open and paused roles do, and a full plan names them with their state", async () => {
    await role("Office Manager", "closed");
    const front = await role("Front Desk Lead", "open");
    await role("Hygienist", "paused");
    const full = await room();
    expect(full).toMatchObject({ ok: false, limit: 2, used: 2 });
    expect(full.holding.map((r) => r.title)).toEqual(["Front Desk Lead", "Hygienist"]);
    expect(full.message).toBe("Your plan includes 2 roles at a time, and all are in use: Front Desk Lead, Hygienist (paused). A role uses a place while it is open, paused or waiting for approval, and closing a role gives its place back. Close a role you no longer need, or talk to ITS about adding more.");
    // no draft and no assistant run on a full plan
    const refused = await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, $24 to $28 an hour, full time." });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("limit_reached");

    // closing a role gives its place back at once
    const closed = await json("POST", `/api/v1/roles/${front}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "We changed our plans." });
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect(await room()).toMatchObject({ ok: true, limit: 2, used: 1, message: null });
    // the company's settings show the same count
    const current = (await (await json("GET", "/api/v1/companies/current")).json()) as { usage: Record<string, { used: number; limit: number | null }> };
    expect(current.usage.active_roles).toEqual({ used: 1, limit: 2 });
    // and a new draft starts
    expect((await json("POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, $24 to $28 an hour, full time." })).status).toBe(201);
  });

  it("a role waiting for approval or sent back for changes uses a place; a role being created is not counted against itself", async () => {
    const waiting = await role("Dental Assistant", "pending_approval");
    const r = await room();
    expect(r).toMatchObject({ ok: false, used: 2 });
    expect(r.message).toMatch(/Hygienist \(paused\), Dental Assistant \(waiting for approval\)\./);
    // the role asking for the place, inside the transaction that creates it, leaves one place in use, so it fits
    const own = await withTenant(container.db, companyId, (tx) => entitlements.roleRoom(tx, companyId, { except: waiting }));
    expect(own).toMatchObject({ ok: true, used: 1 });
    await withTenant(container.db, companyId, (tx) => tx.update(roles).set({ status: "draft" }).where(eq(roles.id, waiting)));
    expect((await room()).message).toMatch(/Dental Assistant \(sent back for changes\)/);
    // the running total kept beside the plan follows the roles too: four roles were created, two use a place
    await withTenant(container.db, companyId, (tx) => entitlements.record(tx, companyId, entitlements.ACTIVE_ROLES, 1, "role", { roleId: waiting }));
    const [row] = await container.db.select().from(entitlementRows).where(and(eq(entitlementRows.companyId, companyId), eq(entitlementRows.key, entitlements.ACTIVE_ROLES)));
    expect(row.used).toBe(2);
    expect(await withTenant(container.db, companyId, (tx) => entitlements.check(tx, companyId, entitlements.ACTIVE_ROLES, 1))).toEqual({ ok: false, limit: 2, used: 2 });
  });
});

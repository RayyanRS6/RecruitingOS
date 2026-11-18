import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { memberships, users } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInWithIdentity, usePlan } from "./test-helpers";

/**
 * Team and permission hardening (plan B7): making someone an admin or an owner needs a recent sign-in.
 */
describe("team and permission hardening", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  const BASE = Date.now();
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const invite = (cookie: string, email: string, role: string) => json(cookie, "POST", "/api/v1/companies/current/members/invite", { email, role });
  const patch = (cookie: string, userId: string, body: unknown) => json(cookie, "PATCH", `/api/v1/companies/current/members/${userId}`, body);
  const errorCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
  const idOf = async (email: string) => (await container.db.select().from(users).where(eq(users.email, email)))[0].id;
  const roleOf = async (userId: string) => (await container.db.select().from(memberships).where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId))))[0].role;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signInWithIdentity(app, container, { email: "dana@harden.test", name: "Dana Owner", provider: "google", aal2: false });
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Harden Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    // More than the Trial plan's 3 people are invited here (founder decision L-02 B; the seats are tested in team.test.ts).
    await usePlan(container, companyId);
    await signInAs(container, app, { companyId, role: "hiring_manager", email: "mo.manager@harden.test", name: "Mo Manager" });
    await signInAs(container, app, { companyId, role: "admin", email: "ada.admin@harden.test", name: "Ada Admin" });
    admin = await signInAs(container, app, { companyId, role: "admin", email: "abe.admin@harden.test", name: "Abe Admin" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("making someone an admin or an owner needs a recent sign-in; the other changes do not", async () => {
    // forty minutes on: every session here is older than the thirty-minute fresh window, and nobody confirmed again
    setClock(40 * 60_000);
    try {
      for (const role of ["admin", "owner"]) {
        const r = await invite(owner, `late.${role}@harden.test`, role);
        expect(r.status, role).toBe(403);
        expect(await errorCode(r)).toBe("reauth_required");
      }
      expect((await invite(owner, "late.manager@harden.test", "hiring_manager")).status).toBe(201);
      const moId = await idOf("mo.manager@harden.test");
      const promote = await patch(owner, moId, { role: "admin" });
      expect(promote.status).toBe(403);
      expect(await errorCode(promote)).toBe("reauth_required");
      expect(await roleOf(moId)).toBe("hiring_manager");
      // taking admin away goes through at once
      const adaId = await idOf("ada.admin@harden.test");
      expect((await patch(admin, adaId, { role: "hiring_manager" })).status).toBe(200);
      expect(await roleOf(adaId)).toBe("hiring_manager");
    } finally {
      setClock(0);
    }
    // back inside the window, the owner may again
    expect((await invite(owner, "fresh.admin@harden.test", "admin")).status).toBe(201);
  });
});

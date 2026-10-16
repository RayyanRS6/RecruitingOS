import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { HARD_HUMAN_ONLY } from "@ros/core";
import { invitations, memberships, policies, users } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { FIXED, SETTABLE } from "./routes/policies";
import { signInAs, signInWithIdentity, usePlan } from "./test-helpers";

/**
 * Team and permission hardening (plan B7). Only owners and admins make someone an admin (HR manages the rest of the
 * team), and making someone an admin or an owner needs a recent sign-in, the same rule as changing the AI rules. The
 * AI-rules list says which rules the product acts on today; the planned ones go under "Coming later", while every
 * "always a person" guarantee stays in view.
 */
describe("team and permission hardening", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let hr = "";
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
    hr = await signInAs(container, app, { companyId, role: "hr", email: "hope.hr@harden.test", name: "Hope HR" });
    admin = await signInAs(container, app, { companyId, role: "admin", email: "abe.admin@harden.test", name: "Abe Admin" });
  });
  afterAll(async () => {
    await container.close();
  });

  it("HR manages the team but never makes, changes or removes an admin; an admin and an owner may", async () => {
    const refused = await invite(hr, "new.admin@harden.test", "admin");
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe("admin_only");
    expect(await container.db.select().from(invitations).where(eq(invitations.email, "new.admin@harden.test"))).toHaveLength(0);
    // HR still invites everyone else
    expect((await invite(hr, "hal.manager@harden.test", "hiring_manager")).status).toBe(201);
    // an admin invites an admin; HR cannot send that invitation again
    const created = (await (await invite(admin, "ada.admin@harden.test", "admin")).json()) as { invitation: { id: string } };
    const resend = await json(hr, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/resend`);
    expect(resend.status).toBe(403);
    expect(await errorCode(resend)).toBe("admin_only");
    expect((await json(admin, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/resend`)).status).toBe(200);
    // promoting to admin, and changing or removing an admin, are not HR's
    const manager = await signInAs(container, app, { companyId, role: "hiring_manager", email: "mo.manager@harden.test", name: "Mo Manager" });
    expect(manager).toBeTruthy();
    const moId = await idOf("mo.manager@harden.test");
    const abeId = await idOf("abe.admin@harden.test");
    for (const [target, body] of [[moId, { role: "admin" }], [abeId, { role: "hiring_manager" }], [abeId, { status: "removed" }]] as const) {
      const r = await patch(hr, target, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(await errorCode(r)).toBe("admin_only");
    }
    expect(await roleOf(moId)).toBe("hiring_manager");
    expect(await roleOf(abeId)).toBe("admin");
    // HR still changes the other roles
    expect((await patch(hr, moId, { role: "interviewer" })).status).toBe(200);
    expect(await roleOf(moId)).toBe("interviewer");
    // the owner makes Mo an admin
    expect((await patch(owner, moId, { role: "admin" })).status).toBe(200);
    expect(await roleOf(moId)).toBe("admin");
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
      const hopeId = await idOf("hope.hr@harden.test");
      const promote = await patch(owner, hopeId, { role: "admin" });
      expect(promote.status).toBe(403);
      expect(await errorCode(promote)).toBe("reauth_required");
      expect(await roleOf(hopeId)).toBe("hr");
      // taking admin away, or any other change, goes through at once
      const moId = await idOf("mo.manager@harden.test");
      expect((await patch(admin, moId, { role: "hiring_manager" })).status).toBe(200);
      expect(await roleOf(moId)).toBe("hiring_manager");
    } finally {
      setClock(0);
    }
    // back inside the window, the owner may again
    expect((await invite(owner, "fresh.admin@harden.test", "admin")).status).toBe(201);
  });

  it("HR never withdraws or resends an invitation to become an admin or owner, never signs a teammate out, and only those who manage the team see invitations", async () => {
    const created = (await (await invite(admin, "ali.admin@harden.test", "admin")).json()) as { invitation: { id: string } };
    for (const action of ["revoke", "resend"]) {
      const r = await json(hr, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/${action}`);
      expect(r.status, action).toBe(403);
      expect(await errorCode(r)).toBe("admin_only");
    }
    // nor withdraws it by inviting the same address again at a rank HR may give (a new invitation replaces the open one)
    const replaced = await invite(hr, "ali.admin@harden.test", "interviewer");
    expect(replaced.status).toBe(403);
    expect(await errorCode(replaced)).toBe("admin_only");
    expect((await container.db.select().from(invitations).where(eq(invitations.id, created.invitation.id)))[0].status).toBe("pending");
    // HR still withdraws an invitation it may give, and sees the list; an admin withdraws the admin's
    const plain = (await (await invite(hr, "ivo.interviewer@harden.test", "interviewer")).json()) as { invitation: { id: string } };
    expect((await json(hr, "POST", `/api/v1/companies/current/invitations/${plain.invitation.id}/revoke`)).status).toBe(200);
    expect((await json(hr, "GET", "/api/v1/companies/current/invitations")).status).toBe(200);
    expect((await json(admin, "POST", `/api/v1/companies/current/invitations/${created.invitation.id}/revoke`)).status).toBe(200);
    // an interviewer sees no pending invitations
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "iris.interviewer@harden.test" });
    expect((await json(interviewer, "GET", "/api/v1/companies/current/invitations")).status).toBe(403);
    // signing a teammate out is an owner's or an admin's, never HR's
    const signOut = await json(hr, "POST", `/api/v1/companies/current/members/${await idOf("iris.interviewer@harden.test")}/sign-out`);
    expect(signOut.status).toBe(403);
    expect(await errorCode(signOut)).toBe("admin_only");
    expect((await json(interviewer, "GET", "/api/v1/auth/me")).status).toBe(200);
  });

  it("the AI-rules list says what the product does today; planned rules are marked, the 'always a person' ones stay in view", async () => {
    type Row = { actionType: string; available: boolean; settable: boolean; does: string | null; locked: boolean };
    const rows = (await (await json(owner, "GET", "/api/v1/policies")).json()) as Row[];
    const byType = new Map(rows.map((r) => [r.actionType, r]));
    // a choice only where a level changes what happens
    for (const a of SETTABLE) expect(byType.get(a), a).toMatchObject({ available: true, settable: true, does: null });
    // work the product does the same way for everyone: listed with what it does, nothing to choose; interview booking is not "coming later"
    for (const a of ["application.triage", "screen.conduct", "message.send_templated", "interview.request", "interview.schedule", "interview.reschedule"]) {
      expect(byType.get(a), a).toMatchObject({ available: true, settable: false });
      expect(byType.get(a)?.does?.length, a).toBeGreaterThan(40);
    }
    const later = rows.filter((r) => !r.available && !r.locked).map((r) => r.actionType);
    expect(later).toHaveLength(15);
    expect(later).toEqual(expect.arrayContaining(["offer.send", "offer.draft", "scorecard.draft", "outreach.send", "posting.sponsor_spend", "welcome.send"]));
    // every guarantee is listed and marked, whether or not the feature exists yet
    for (const a of HARD_HUMAN_ONLY) expect(byType.get(a)?.locked, a).toBe(true);
    expect(byType.get("offer.negotiate")).toMatchObject({ available: false, locked: true });
  });

  it("refuses a level nothing reads, in plain words, and saves nothing", async () => {
    for (const actionType of ["screen.conduct", "message.send_templated", "application.triage", "interview.schedule", "welcome.send"]) {
      const r = await json(owner, "PUT", "/api/v1/policies", { actionType, level: "human_only", approverRoles: [] });
      expect(r.status, actionType).toBe(400);
      const error = ((await r.json()) as { error: { code: string; message: string } }).error;
      expect(error.code).toBe("no_setting");
      expect(error.message).toMatch(/^(There is nothing to choose here|This is not in the product yet)/);
    }
    expect(await container.db.select().from(policies).where(and(eq(policies.companyId, companyId), inArray(policies.actionType, ["screen.conduct", "message.send_templated"])))).toHaveLength(0);
  });

  it("every rule that offers a choice is read by the code, and none of the fixed ones is", () => {
    // the code that runs the product: workflows, agents, core and the API's services and routes, tests left out
    const roots = ["../../../packages/workflows/src", "../../../packages/agents/src", "../../../packages/core/src", "./services", "./routes"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
    const files = roots.flatMap((root) => walk(root)).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith(`routes${sep}policies.ts`));
    const source = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const read = (action: string) => new RegExp(`(gate|resolvePolicy)\\([\\s\\S]{0,600}?"${action.replace(/\./g, "\\.")}"`).test(source);
    for (const a of SETTABLE) expect(read(a), `${a} is offered as a choice, so something must read it`).toBe(true);
    for (const a of Object.keys(FIXED)) expect(read(a), `${a} is now read by the code: move it from FIXED to SETTABLE`).toBe(false);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

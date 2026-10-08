import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { intakeSessions, users } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs, signInStaff } from "./test-helpers";

/**
 * Who can see a role while it is being drafted (founder decision Q6, option A; plan item 0.2). A draft carries the pay
 * and the reasons for the hire: an interviewer never reaches it, a hiring manager resumes only their own and cannot
 * continue, discard or compile anyone else's, and owners and admins can take one over.
 */
describe("drafts belong to the person who started them", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let manager = "";
  let otherManager = "";
  let interviewer = "";
  let hr = "";
  let companyId = "";
  let ownersDraft = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  const current = async (cookie: string) => (await json(cookie, "GET", "/api/v1/intake/sessions/current"));

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@drafts.test");
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Draft Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    await entitlements.applyPlan(container.db, companyId, "growth");
    admin = await signInAs(container, app, { companyId, role: "admin" });
    manager = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hm@drafts.test" });
    otherManager = await signInAs(container, app, { companyId, role: "hiring_manager" });
    interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
    hr = await signInAs(container, app, { companyId, role: "hr" });
    const r = await json(owner, "POST", "/api/v1/intake/conversation/messages", { message: "I need a dental hygienist in Irvine, $45 to $55 an hour, full time." });
    ownersDraft = ((await r.json()) as { intakeSessionId: string }).intakeSessionId;
    expect(ownersDraft).toBeTruthy();
  });
  afterAll(async () => {
    await container.close();
  });

  it("an interviewer and HR never reach a draft: no resume, no start, and the conversation answers from the brief", async () => {
    for (const cookie of [interviewer, hr]) {
      expect((await current(cookie)).status).toBe(403);
      expect((await json(cookie, "POST", "/api/v1/intake/sessions", {})).status).toBe(403);
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${ownersDraft}/messages`, { message: "It's a replacement." })).status).toBe(403);
      // a hiring request in the conversation box is answered from the brief: no draft is started or continued
      const r = await json(cookie, "POST", "/api/v1/intake/conversation/messages", { message: "I need to hire a front desk coordinator." });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { reply: string; intakeSessionId?: string };
      expect(body.intakeSessionId).toBeUndefined();
      expect(body.reply).not.toMatch(/\$45|\$55/);
    }
    expect((await container.db.select().from(intakeSessions).where(eq(intakeSessions.companyId, companyId))).length).toBe(1);
  });

  it("a hiring manager resumes only their own draft and cannot continue, discard or compile the owner's", async () => {
    expect(((await (await current(manager)).json()) as { session: unknown }).session).toBeNull();
    const refused = await json(manager, "POST", `/api/v1/intake/sessions/${ownersDraft}/messages`, { message: "It's a replacement." });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "not_your_draft" });
    expect((await json(manager, "POST", `/api/v1/intake/sessions/${ownersDraft}/abandon`)).status).toBe(403);
    expect((await json(manager, "POST", `/api/v1/intake/sessions/${ownersDraft}/compile`)).status).toBe(403);
    // their own conversation starts their own draft instead of continuing the owner's
    const r = await json(manager, "POST", "/api/v1/intake/conversation/messages", { message: "I need a front office coordinator in Irvine, $22 to $26 an hour." });
    const mine = ((await r.json()) as { intakeSessionId: string }).intakeSessionId;
    expect(mine).toBeTruthy();
    expect(mine).not.toBe(ownersDraft);
    const resumed = ((await (await current(manager)).json()) as { session: { id: string } }).session;
    expect(resumed.id).toBe(mine);
    // another hiring manager sees neither
    expect(((await (await current(otherManager)).json()) as { session: unknown }).session).toBeNull();
    expect((await json(otherManager, "POST", `/api/v1/intake/sessions/${mine}/messages`, { message: "Hello" })).status).toBe(403);
    // the owner still resumes their own, not the manager's newer one
    expect(((await (await current(owner)).json()) as { session: { id: string } }).session.id).toBe(ownersDraft);
  });

  it("owners and admins can take a draft over; an unknown or malformed id is a plain not-found", async () => {
    const [hm] = await container.db.select().from(users).where(eq(users.email, "hm@drafts.test"));
    const managers = (await container.db.select().from(intakeSessions).where(eq(intakeSessions.status, "active"))).find((s) => s.createdBy.id === hm.id)!;
    expect(managers).toBeTruthy();
    const continued = await json(admin, "POST", `/api/v1/intake/sessions/${managers.id}/messages`, { message: "It's growth. Ceiling $28. I decide. Must-haves: Dentrix scheduling." });
    expect(continued.status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/intake/sessions/${managers.id}/abandon`)).status).toBe(200);
    expect((await json(owner, "POST", "/api/v1/intake/sessions/not-a-uuid/messages", { message: "x" })).status).toBe(404);
    expect((await json(owner, "POST", "/api/v1/intake/sessions/00000000-0000-4000-8000-000000000000/compile")).status).toBe(404);
  });

  it("an ITS recruiter brought in for one role does not see or touch the owner's draft", async () => {
    const roleId = await (async () => {
      const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
      return ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    })();
    const recruiter = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
    const esc = (await (await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId, question: "Can you look at our hygienist candidates?" })).json()) as { id: string };
    expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    // a grant for one role opens no draft and starts none (plan C12): every drafting route refuses it plainly
    const resumed = await current(recruiter);
    expect(resumed.status).toBe(403);
    expect(((await resumed.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    expect((await json(recruiter, "POST", `/api/v1/intake/sessions/${ownersDraft}/messages`, { message: "Hello" })).status).toBe(403);
    expect((await json(recruiter, "GET", `/api/v1/intake/sessions/${ownersDraft}`)).status).toBe(403);
    expect((await json(recruiter, "GET", "/api/v1/intake/sessions")).status).toBe(403);
    const before = (await container.db.select().from(intakeSessions).where(eq(intakeSessions.companyId, companyId))).length;
    expect((await json(recruiter, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, $24 to $28 an hour." })).status).toBe(403);
    expect((await container.db.select().from(intakeSessions).where(eq(intakeSessions.companyId, companyId))).length).toBe(before);
    // the conversation box answers them from the brief instead of starting a draft
    const conv = (await (await json(recruiter, "POST", "/api/v1/intake/conversation/messages", { message: "I need a dental assistant in Irvine." })).json()) as { intakeSessionId?: string };
    expect(conv.intakeSessionId).toBeUndefined();
  });
});

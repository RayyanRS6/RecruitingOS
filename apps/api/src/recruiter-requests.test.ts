import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDataRequest, createEscalation, openHumanReview } from "@ros/core";
import { adminAlerts, applications, candidates, events, notifications, randomToken, recruiterEscalations, roles, staffAccessGrants, users, withPlatform, withTenant, workflowRuns } from "@ros/db";
import type { WorkflowDefinition } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInStaff } from "./test-helpers";

/**
 * Recruiter access honesty (plan item 0.4, founder decision Q31 option A). A request covers one candidate, one role, or
 * all of the company's hiring only when someone chose that; every message states the real access; the system brings a
 * recruiter in only for the candidate or role involved, and a failure with nothing attached goes to ITS administrators.
 * The plan's role allowance offers a request to ITS instead of a dead-end "upgrade".
 */
describe("what a recruiter request covers, and saying so", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let recruiter = "";
  let companyId = "";
  let roleId = "";
  let applicationId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const ask = (body: Record<string, unknown>) => json(owner, "POST", "/api/v1/escalations", { kind: "ask", question: "Help us with pay for evenings.", ...body });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@scope.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    // a trial company: one active role
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Scope Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    applicationId = await withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Nia", lastName: "Brooks", email: "nia.brooks@example.com", firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning();
      return a.id;
    });
    recruiter = await signInStaff(app, container, "kai@its.test", "its_recruiter", "Kai Recruiter");
  });
  afterAll(async () => {
    await container.close();
  });

  it("a request names what it covers: 'all of your hiring' must be chosen, never inferred from missing ids", async () => {
    const none = await ask({});
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: "scope_required", message: "Say which hire this is about, or choose all of your hiring." });
    const company = await ask({ scope: "company" });
    expect(company.status).toBe(201);
    const body = (await company.json()) as { id: string; scope: string; message: string };
    expect(body.scope).toBe("company");
    expect(body.message).toContain("They will see all of your hiring");
    expect(body.message).toContain("ends a day after it is resolved, or after 14 days at most");
    // said to whoever asked, so it names who can end it: hiring managers and HR may ask but not end it
    expect(body.message).toContain("An owner or admin can end it sooner in Setup");
    expect(body.message).not.toMatch(/everything about this role and candidate/);
    // mismatches are refused in plain words
    expect((await ask({ scope: "company", roleId })).status).toBe(400);
    expect((await ask({ scope: "role" })).status).toBe(400);
    expect((await ask({ scope: "role", roleId, applicationId })).status).toBe(400);
    expect((await ask({ scope: "application", roleId })).status).toBe(400);
    expect((await ask({ roleId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await ask({ roleId: "not-a-role" })).status).toBe(404);
    expect((await ask({ applicationId: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    // a role alone is a role request; a candidate brings their role along
    const role = (await (await ask({ roleId })).json()) as { id: string; scope: string; message: string };
    expect(role.scope).toBe("role");
    expect(role.message).toContain("this role and its candidates");
    const cand = (await (await ask({ applicationId })).json()) as { id: string; scope: string; message: string };
    expect(cand.scope).toBe("application");
    expect(cand.message).toContain("this candidate and the role they applied for");
    const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, cand.id));
    expect(row).toMatchObject({ roleId, applicationId });
  });

  it("a recruiter the system brought in for one candidate: the owner is told at once, with the real access", async () => {
    const esc = await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, roleId, applicationId, kind: "candidate_issue", question: "Nia Brooks asked for a person.", requestedBy: { kind: "candidate", id: applicationId }, summaryOrigin: "candidate" }));
    expect((await json(recruiter, "POST", `/api/v1/escalations/${esc.id}/claim`)).status).toBe(200);
    const [ownerUser] = await container.db.select().from(users).where(eq(users.email, "owner@scope.test"));
    const told = (await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerUser.id), eq(notifications.kind, "recruiter.claimed")))).at(-1)!;
    expect(told.title).toBe("Kai Recruiter (ITS recruiter) was brought in");
    expect(told.body).toMatch(/^A candidate needed a person, so a recruiter was brought in\. They can see this candidate and the role they applied for until /);
    expect(told.body).toContain("a day after the request is resolved");
    expect(told.body).not.toMatch(/this role and candidate/);
    expect(told.action).toEqual({ label: "Recruiter access", href: "/setup" });
    // only owners and admins can end it, and the notice reaches everyone who is told
    expect(told.body).toContain("an owner or admin can end their access in Setup");
    const [grant] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, esc.id));
    expect(grant).toMatchObject({ roleId, applicationId });
  });

  it("a recruiter brought in for one candidate can ask about that candidate only, never the whole role or all of the hiring", async () => {
    expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    const asKai = (body: Record<string, unknown>) => json(recruiter, "POST", "/api/v1/escalations", { question: "Could someone else look at this too?", ...body });
    // a role request (named or implied by the ids) or a company request would be a wider grant once claimed
    for (const wider of [{ kind: "ask", scope: "role", roleId }, { kind: "review", roleId }, { kind: "ask", scope: "company" }]) {
      const r = await asKai(wider);
      expect(r.status, JSON.stringify(wider)).toBe(403);
      expect(((await r.json()) as { error: { code: string } }).error.code).toBe("staff_scope");
    }
    // and the Today cards offer them no button the route would refuse, while the owner keeps it (the role open, Nia waiting)
    const [before] = await container.db.select({ status: roles.status }).from(roles).where(eq(roles.id, roleId));
    await container.db.update(roles).set({ status: "open" }).where(eq(roles.id, roleId));
    try {
      type Card = { kind: string; roleId?: string; actions: Array<{ label: string; path: string }> };
      const reviewCard = async (cookie: string) => ((await (await json(cookie, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards.find((c) => c.kind === "needs_review" && c.roleId === roleId);
      expect((await reviewCard(owner))?.actions.map((a) => a.label)).toContain("Bring in a recruiter");
      const theirs = await reviewCard(recruiter);
      expect(theirs).toBeTruthy();
      expect(theirs!.actions.some((a) => a.path === "/api/v1/escalations")).toBe(false);
    } finally {
      await container.db.update(roles).set({ status: before.status }).where(eq(roles.id, roleId));
    }
    const same = await asKai({ kind: "ask", applicationId });
    expect(same.status).toBe(201);
    const { id } = (await same.json()) as { id: string };
    // whoever picks it up gets that candidate alone, and the owner is told who asked for it and why
    const lee = await signInStaff(app, container, "lee@its.test", "its_recruiter", "Lee Recruiter");
    expect((await json(lee, "POST", `/api/v1/escalations/${id}/claim`)).status).toBe(200);
    const [grant] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, id));
    expect(grant).toMatchObject({ roleId, applicationId });
    const [ownerUser] = await container.db.select().from(users).where(eq(users.email, "owner@scope.test"));
    const told = (await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerUser.id), eq(notifications.kind, "recruiter.claimed")))).find((n) => n.title.startsWith("Lee Recruiter"))!;
    expect(told.title).toBe("Lee Recruiter (ITS recruiter) was brought in");
    expect(told.body).toMatch(/^Kai Recruiter \(ITS recruiter\) asked for this while working on another of your requests, so a recruiter was brought in\. They can see this candidate and the role they applied for until /);
    expect(told.body).not.toMatch(/Something got stuck/);
  });

  it("a request that names no role or candidate, and that nobody at the company chose, grants nothing when picked up", async () => {
    // as a failed run raised before the rule (or ITS staff) could: no ids, not asked for by the team
    const esc = await withTenant(container.db, companyId, (tx) => createEscalation(tx, { companyId, kind: "stuck_role", question: "A workflow stopped.", requestedBy: { kind: "system", id: "workflow:old" } }));
    const max = await signInStaff(app, container, "max@its.test", "its_recruiter", "Max Recruiter");
    const r = await json(max, "POST", `/api/v1/escalations/${esc.id}/claim`);
    expect(r.status).toBe(409);
    const err = ((await r.json()) as { error: { code: string; message: string } }).error;
    expect(err.code).toBe("company_access_not_chosen");
    expect(err.message).toMatch(/nobody at the company chose to share all of their hiring/);
    expect(await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, esc.id))).toHaveLength(0);
    // the owner's own "all of your hiring" request is still picked up as asked
    const chosen = (await (await ask({ scope: "company" })).json()) as { id: string };
    expect((await json(max, "POST", `/api/v1/escalations/${chosen.id}/claim`)).status).toBe(200);
    const [grant] = await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, chosen.id));
    expect(grant).toMatchObject({ roleId: null, applicationId: null });
  });

  it("a step that says trying again cannot help fails at once; one that can be retried waits for its next try", async () => {
    let calls = 0;
    const final: WorkflowDefinition = { key: "test_not_retryable", version: 1, initialStep: "go", maxAttempts: 4, steps: { go: async () => { calls += 1; return { kind: "fail", error: "this cannot work", retryable: false }; } } };
    const flaky: WorkflowDefinition = { key: "test_retryable", version: 1, initialStep: "go", maxAttempts: 4, steps: { go: async () => ({ kind: "fail", error: "try again later", retryable: true }) } };
    container.engine.register(final);
    container.engine.register(flaky);
    const start = (key: string) => withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: key, companyId, subject: { type: "company", id: companyId }, state: {} }));
    const { runId } = await start(final.key);
    await container.drain();
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run).toMatchObject({ status: "failed", attempts: 1, lastError: "this cannot work" });
    expect(calls).toBe(1);
    expect(await container.db.select().from(events).where(and(eq(events.type, "workflow.retried"), eq(events.subjectId, runId)))).toHaveLength(0);
    const { runId: flakyRun } = await start(flaky.key);
    await container.drain();
    const [waiting] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, flakyRun));
    expect(waiting).toMatchObject({ status: "waiting", attempts: 1, lastError: "try again later" });
    expect(await container.db.select().from(events).where(and(eq(events.type, "workflow.retried"), eq(events.subjectId, flakyRun)))).toHaveLength(1);
  });

  it("a workflow that fails with no role and no candidate alerts ITS administrators and grants nobody the company", async () => {
    const failing: WorkflowDefinition = { key: "test_unattached_failure", version: 1, initialStep: "go", maxAttempts: 1, steps: { go: async () => ({ kind: "fail", error: "nothing to work on", retryable: false }) } };
    container.engine.register(failing);
    const before = (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, companyId))).length;
    const { runId } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: failing.key, companyId, subject: { type: "company", id: companyId }, state: {} }));
    await container.drain();
    const [run] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId));
    expect(run.status).toBe("failed");
    expect(run.escalationId).toBeNull();
    expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, companyId))).length).toBe(before);
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "workflow.failed"));
    expect(alerts.some((a) => a.target?.id === runId && a.companyId === companyId)).toBe(true);
    // the same failure about a role still brings a recruiter in for that role alone
    const { runId: roleRun } = await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: failing.key, companyId, subject: { type: "role", id: roleId }, state: { roleId } }));
    await container.drain();
    const [withRole] = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, roleRun));
    const [esc] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, withRole.escalationId!));
    expect(esc).toMatchObject({ roleId, applicationId: null });
    // the customer reads the request: plain words, never the error, the workflow's key or the step's
    expect(esc.question).toBe("An automatic step stopped after the first try and needs a person to take over.");
    expect(withRole.lastError).toBe("nothing to work on");
  });

  it("a request for a person's review with nothing attached goes to ITS administrators, not to a company-wide recruiter", async () => {
    const before = (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, companyId))).length;
    const actor = { kind: "candidate" as const, id: "someone" };
    // privacy requests are platform records, as on the status page's form
    const updated = await withPlatform(container.db, async (tx) => {
      const row = await createDataRequest(tx, { companyId, kind: "human_review", requesterEmail: "someone@example.com", channel: "admin", verified: true, actor });
      return openHumanReview(tx, row, { roleId: null, actor });
    });
    expect(updated.escalationId).toBeNull();
    expect(updated.notes.at(-1)?.text).toMatch(/no recruiter was brought in/);
    expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, companyId))).length).toBe(before);
    const alerts = await container.db.select().from(adminAlerts).where(eq(adminAlerts.kind, "privacy_request.human_review"));
    expect(alerts.map((a) => (a.details as { requestId?: string }).requestId)).toEqual([updated.id]);
  });

  it("past the plan's role allowance, the refusal offers a request to ITS instead of an upgrade nobody can make", async () => {
    // the trial allows one active role; the second draft is refused before it starts, so no model call is made (plan C13)
    const refused = await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a front office coordinator in Irvine, $22 to $26 an hour, full time. It's growth. Ceiling $28. I decide. Must-haves: Dentrix. Just draft it." });
    expect(refused.status).toBe(402);
    const err = ((await refused.json()) as { error: { code: string; message: string; details: { actions: Array<{ label: string; method: string; path: string; body: Record<string, unknown> }> } } }).error;
    expect(err.code).toBe("limit_reached");
    expect(err.message).not.toMatch(/upgrade/i);
    expect(err.message).toMatch(/talk to ITS/i);
    // the rule (polish list): a role uses a place until it closes, so the message says closing one frees it
    expect(err.message).toMatch(/closing a role gives its place back/);
    expect(err.message).toMatch(/Close a role you no longer need, or talk to ITS/);
    const [action] = err.details.actions;
    expect(action).toMatchObject({ label: "Talk to ITS about more roles", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company" } });
    // pressing it is an ordinary request about all of the company's hiring
    const sent = await json(owner, action.method, action.path, action.body);
    expect(sent.status).toBe(201);
    expect(((await sent.json()) as { scope: string }).scope).toBe("company");
  });
});

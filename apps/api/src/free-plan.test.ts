import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { entitlements as allowance, correctOutcome } from "@ros/core";
import type { PlanRoom } from "@ros/contracts";
import { aiRuns, approvalRequests, auditRecords, companies, entitlements, events, hiringOutcomes, intakeSessions, invitations, memberships, notifications, recruiterEscalations, roles, rowsOf, users, withPlatform, withTenant, workflowRuns, type Tx } from "@ros/db";
import type { FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { settleTrials } from "./services/trial";
import { signInAdmin, signInWithIdentity, usePlan } from "./test-helpers";

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";
const ONE_JOB = "Your Free plan includes one job. Upgrade to post more.";
const DAY = 86_400_000;

type Current = { planKey: string; status: string; trial: unknown; settings: { trial?: unknown }; plan: { key: string; name: string; limits: Record<string, number | null> }; usage: Record<string, { used: number; limit: number | null; resetsAt?: string | null; unit?: string }> };
type ApiError = { code: string; message: string; details: { upgrade?: boolean; room: PlanRoom; actions: Array<{ label: string; method: string; path: string; body: Record<string, unknown> }> } };

/**
 * The plans of 5 November 2026, Rule 1. A new company starts on Free: active, with no clock. Free is one job ever, counted
 * live from the roles: a job that went live counts for good, and one closed before it ever opened gives its place back.
 * Past it, every way to start a job, and every AI route on a draft with no role yet, stops with the owner's words and an
 * upgrade. And on every plan a closed role can no longer be approved open: that was a way past the limit.
 */
describe("the Free plan's one job", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let made = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const errorOf = async (r: Response) => (await read<{ error: ApiError }>(r)).error;
  const room = async (cookie: string) => read<PlanRoom>(await json(cookie, "GET", "/api/v1/intake/room"));
  const current = async (cookie: string) => read<Current>(await json(cookie, "GET", "/api/v1/companies/current"));
  const roleOf = async (id: string) => (await container.db.select().from(roles).where(eq(roles.id, id)))[0];
  const pendingOf = async (roleId: string) => (await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleId), eq(approvalRequests.actionType, "role_packet.approve"), eq(approvalRequests.status, "pending"))))[0] ?? null;
  const runCount = () => container.db.select().from(aiRuns).then((r) => r.length);
  /** Runs `fn` with the engine's clock two weeks and a day ahead, past a packet approval's 14 days, then puts it back. */
  const pastTheApprovalWindow = async <T>(fn: () => Promise<T>): Promise<T> => {
    const engine = container.engine as unknown as { now: () => Date };
    const real = engine.now;
    const at = real().getTime() + 15 * DAY;
    engine.now = () => new Date(at);
    try {
      return await fn();
    } finally {
      engine.now = real;
    }
  };

  /** A company of its own, under an owner of its own, on Free unless a suite moves it; each sign-in from an address of its own (the route's limit per address). */
  const newCompany = async () => {
    made += 1;
    const accessToken = (container.integrations.identity as FakeIdentityProvider).mint({ email: `owner-${made}@free-plan.test`, name: `Owner ${made}`, provider: "google" });
    const signedIn = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${made}` }, body: JSON.stringify({ accessToken }) });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const r = await json(cookie, "POST", "/api/v1/companies", { name: `Free Plan Dental ${made}`, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status, await r.clone().text()).toBe(201);
    return { cookie, id: (await read<{ id: string }>(r)).id };
  };
  const startDraft = async (cookie: string) => (await read<{ session: { id: string } }>(await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE }))).session.id;
  /** A job waiting for approval: an ordinary draft, asked for approval. */
  const jobWaiting = async (cookie: string) => {
    const r = await json(cookie, "POST", `/api/v1/intake/sessions/${await startDraft(cookie)}/compile`);
    expect(r.status, await r.clone().text()).toBe(201);
    await container.drain();
    return (await read<{ roleId: string }>(r)).roleId;
  };
  const approve = async (cookie: string, roleId: string) => {
    const r = await json(cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };
  const close = (cookie: string, roleId: string) => json(cookie, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "We changed our plans." });
  const closeOk = async (cookie: string, roleId: string) => {
    const r = await close(cookie, roleId);
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
  });
  afterAll(async () => {
    await container.close();
  });

  describe("a new company", () => {
    it("is on Free and active, with no clock and no trial event, and names every limit with nothing used", async () => {
      const { cookie, id } = await newCompany();
      const co = await current(cookie);
      expect(co).toMatchObject({ planKey: "free", status: "active", trial: null, plan: { key: "free", name: "Free" } });
      expect(co.settings.trial).toBeUndefined();
      expect(await container.db.select().from(events).where(and(eq(events.companyId, id), eq(events.type, "trial.started")))).toHaveLength(0);
      const rows = await container.db.select().from(entitlements).where(eq(entitlements.companyId, id));
      expect(rows.map((r) => r.key).sort()).toEqual(["active_roles", "ai_credit_monthly_cents", "ai_credit_total_cents", "candidates_per_job", "its_work", "jobs_total", "recruiter_asks", "seats", "text_screens"]);
      expect(rows.every((r) => r.used === 0 && r.source === "plan")).toBe(true);
    });

    it("reads its usage in counts and a percentage: no dollars, and no line for what is not a count", async () => {
      const { cookie } = await newCompany();
      const co = await current(cookie);
      expect(co.usage.jobs_total).toEqual({ used: 0, limit: 1 });
      expect(co.usage.active_roles).toEqual({ used: 0, limit: 1 });
      expect(co.usage.seats).toEqual({ used: 1, limit: 2 });
      expect(co.usage.ai_credit_total_cents).toEqual({ used: 0, limit: 100, unit: "percent" });
      for (const key of ["candidates_per_job", "its_work", "ai_credit_monthly_cents"]) expect(co.usage, key).not.toHaveProperty(key);
      // and the plan's own limits carry no credit in money
      expect(co.plan.limits).toMatchObject({ jobs_total: 1, candidates_per_job: 5, seats: 2 });
      expect(co.plan.limits).not.toHaveProperty("ai_credit_total_cents");
      expect(co.plan.limits).not.toHaveProperty("ai_credit_monthly_cents");
    });

    it("reads a limit that is not a count by its key, and follows the plan", async () => {
      const { id } = await newCompany();
      await withTenant(container.db, id, async (tx) => {
        expect(await allowance.limitOf(tx, id, allowance.CANDIDATES_PER_JOB)).toBe(5);
        expect(await allowance.limitOf(tx, id, "no_such_limit")).toBeNull();
        expect(await allowance.check(tx, id, allowance.ITS_WORK)).toEqual({ ok: false, limit: 0, used: 0 });
      });
      await usePlan(container, id, "pro");
      await withTenant(container.db, id, async (tx) => {
        expect(await allowance.limitOf(tx, id, allowance.CANDIDATES_PER_JOB)).toBe(100);
        expect(await allowance.check(tx, id, allowance.ITS_WORK)).toEqual({ ok: true, limit: null, used: 0 });
      });
    });
  });

  describe("one job ever", () => {
    it("the first job takes the one place; the next is refused with an upgrade, before any draft or model call", async () => {
      const { cookie, id } = await newCompany();
      expect(await room(cookie)).toMatchObject({ ok: true, message: null, holding: [] });
      const roleId = await jobWaiting(cookie);
      expect(await room(cookie)).toEqual({ ok: false, limit: 1, used: 1, holding: [], message: ONE_JOB, upgrade: true });
      const runs = await runCount();
      const refused = await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE });
      expect(refused.status).toBe(402);
      const err = await errorOf(refused);
      expect(err).toMatchObject({ code: "limit_reached", message: ONE_JOB, details: { upgrade: true, room: { ok: false, upgrade: true, holding: [] } } });
      expect(err.message).not.toMatch(/clos/i);
      expect(err.details.actions).toHaveLength(1);
      expect(err.details.actions[0]).toMatchObject({ label: "Upgrade", method: "POST", path: "/api/v1/escalations", body: { kind: "ask", scope: "company", topic: "plan" } });
      expect(await runCount()).toBe(runs);
      expect((await container.db.select().from(intakeSessions).where(and(eq(intakeSessions.companyId, id), eq(intakeSessions.status, "active"))))).toHaveLength(0);
      // pressing it is a talk about the plan, never counted as one of the plan's recruiter requests
      const asked = await json(cookie, err.details.actions[0].method, err.details.actions[0].path, err.details.actions[0].body);
      expect(asked.status, await asked.clone().text()).toBe(201);
      const [row] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, id));
      expect((row.billing as { topic?: string }).topic).toBe("plan");
      expect((await current(cookie)).usage.recruiter_asks.used).toBe(0);
      // and the job itself is untouched
      expect((await roleOf(roleId)).status).toBe("pending_approval");
    });

    it("every way in stops the same: hire again, the owner conversation, asking for approval on an older draft", async () => {
      const { cookie } = await newCompany();
      const older = await startDraft(cookie);
      const roleId = await jobWaiting(cookie);
      await approve(cookie, roleId);
      for (const [path, body] of [["/api/v1/intake/sessions", { fromRoleId: roleId }], [`/api/v1/intake/sessions/${older}/compile`, undefined], [`/api/v1/intake/sessions/${older}/request-approval`, undefined]] as const) {
        const r = await json(cookie, "POST", path, body);
        expect(r.status, path).toBe(402);
        expect(await errorOf(r), path).toMatchObject({ code: "limit_reached", message: ONE_JOB, details: { upgrade: true } });
      }
      // the conversation continues a draft in progress, so it stops only once there is none
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${older}/abandon`)).status).toBe(200);
      const talk = await json(cookie, "POST", "/api/v1/intake/conversation/messages", { message: "I need another hygienist." });
      expect(talk.status).toBe(402);
      expect(await errorOf(talk)).toMatchObject({ code: "limit_reached", message: ONE_JOB });
    });

    it("a job that went live counts for good: closing it frees nothing", async () => {
      const { cookie, id } = await newCompany();
      const roleId = await jobWaiting(cookie);
      await approve(cookie, roleId);
      expect((await roleOf(roleId)).openedAt).toBeTruthy();
      await closeOk(cookie, roleId);
      expect(await room(cookie)).toEqual({ ok: false, limit: 1, used: 1, holding: [], message: ONE_JOB, upgrade: true });
      const usage = (await current(cookie)).usage;
      expect(usage.jobs_total).toEqual({ used: 1, limit: 1 });
      expect(usage.active_roles).toEqual({ used: 0, limit: 1 });
      expect(await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.JOBS_TOTAL))).toEqual({ ok: false, limit: 1, used: 1 });
      expect(await withTenant(container.db, id, (tx) => allowance.jobsCounted(tx, id))).toBe(1);
      // the running total is only ever counted from the roles: nothing was written beside it
      expect((await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, id), eq(entitlements.key, allowance.JOBS_TOTAL))))[0].used).toBe(0);
      expect((await json(cookie, "POST", "/api/v1/intake/sessions", { fromRoleId: roleId })).status).toBe(402);
    });

    it("a job closed before it ever opened gives its place back, and the next one can open", async () => {
      const { cookie } = await newCompany();
      const cancelled = await jobWaiting(cookie);
      expect((await room(cookie)).ok).toBe(false);
      await closeOk(cookie, cancelled);
      expect(await room(cookie)).toMatchObject({ ok: true, used: 0, message: null });
      expect((await current(cookie)).usage.jobs_total).toEqual({ used: 0, limit: 1 });
      const next = await jobWaiting(cookie);
      await approve(cookie, next);
      expect((await roleOf(next)).status).toBe("open");
      expect((await room(cookie)).ok).toBe(false);
    });

    it("a job sent back for changes keeps its place, and a role being created is not counted against itself", async () => {
      const { cookie, id } = await newCompany();
      const roleId = await jobWaiting(cookie);
      const pending = (await pendingOf(roleId))!;
      expect((await json(cookie, "POST", `/api/v1/approvals/${pending.id}/decide`, { decision: "reject", note: "Change the pay." })).status).toBe(200);
      await container.drain();
      expect((await roleOf(roleId)).status).toBe("draft");
      expect(await room(cookie)).toMatchObject({ ok: false, upgrade: true });
      expect(await withTenant(container.db, id, (tx) => allowance.roleRoom(tx, id, { except: roleId }))).toMatchObject({ ok: true, used: 0, lifetime: { limit: 1, used: 0, full: false } });
    });

    it("two drafts asked for approval at once make one job", async () => {
      const { cookie, id } = await newCompany();
      const [a, b] = [await startDraft(cookie), await startDraft(cookie)];
      const answers = await Promise.all([a, b].map((s) => json(cookie, "POST", `/api/v1/intake/sessions/${s}/compile`)));
      expect(answers.map((r) => r.status).sort()).toEqual([201, 402]);
      expect(await container.db.select().from(roles).where(eq(roles.companyId, id))).toHaveLength(1);
    });

    it("editing the one job stays allowed, title included", async () => {
      const { cookie } = await newCompany();
      const roleId = await jobWaiting(cookie);
      await approve(cookie, roleId);
      const edited = await json(cookie, "PATCH", `/api/v1/roles/${roleId}/packet`, { baseVersion: 1, title: "Senior Dental Hygienist" });
      expect(edited.status, await edited.clone().text()).toBe(200);
    });

    it("an upgrade lifts it at once, because every plan names the key", async () => {
      const { cookie, id } = await newCompany();
      await jobWaiting(cookie);
      expect((await room(cookie)).upgrade).toBe(true);
      const moved = await json(admin, "POST", `/api/v1/admin/customers/${id}/plan`, { planKey: "basic", reason: "They asked to upgrade." });
      expect(moved.status, await moved.clone().text()).toBe(200);
      expect(await read(moved)).toMatchObject({ planKey: "basic", status: "active" });
      const after = await room(cookie);
      expect(after).toMatchObject({ ok: true, limit: 3, used: 1 });
      expect(after.upgrade).toBeUndefined();
      expect((await current(cookie)).usage).not.toHaveProperty("jobs_total");
    });

    it("a company with no row for the limit is unmetered, so existing companies do not change until their plan does", async () => {
      const { cookie, id } = await newCompany();
      await jobWaiting(cookie);
      await withPlatform(container.db, (tx) => tx.delete(entitlements).where(and(eq(entitlements.companyId, id), inArray(entitlements.key, [allowance.JOBS_TOTAL, allowance.ACTIVE_ROLES]))));
      expect(await room(cookie)).toMatchObject({ ok: true, limit: null, used: 1 });
      expect(await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.JOBS_TOTAL))).toEqual({ ok: true, limit: null, used: 0 });
      expect((await current(cookie)).usage).not.toHaveProperty("jobs_total");
    });
  });

  describe("a company with no room stops spending", () => {
    /** A Free company at its one job, with an older draft already written beside it. */
    const atItsJob = async () => {
      const { cookie, id } = await newCompany();
      const older = await startDraft(cookie);
      const written = await json(cookie, "POST", `/api/v1/intake/sessions/${older}/draft`);
      expect(written.status, await written.clone().text()).toBe(200);
      const fresh = await startDraft(cookie);
      const roleId = await jobWaiting(cookie);
      await approve(cookie, roleId);
      return { cookie, id, older, fresh, roleId };
    };

    it("writing a draft, changing a draft by chat and the quick start's suggestions make no model call", async () => {
      const { cookie, id, older, fresh } = await atItsJob();
      const runs = await runCount();
      for (const [session, what] of [[fresh, "a draft not written yet"], [older, "a draft written before"]]) {
        const r = await json(cookie, "POST", `/api/v1/intake/sessions/${session}/draft`);
        expect(r.status, what).toBe(402);
        expect(await errorOf(r), what).toMatchObject({ code: "limit_reached", message: ONE_JOB, details: { upgrade: true } });
      }
      const change = await json(cookie, "POST", `/api/v1/intake/sessions/${older}/revisions`, { message: "Make it shorter." });
      expect(change.status).toBe(402);
      expect(await errorOf(change)).toMatchObject({ code: "limit_reached", message: ONE_JOB, details: { actions: [{ label: "Upgrade" }] } });
      // the suggestions answer as a failed or slow run does: never an error the page must show
      const suggest = await json(cookie, "POST", "/api/v1/intake/suggestions", { title: "Hygienist" });
      expect(suggest.status).toBe(200);
      expect(await read(suggest)).toEqual({ mustHaves: [], questions: [], unavailable: true });
      expect(await runCount()).toBe(runs);
      expect(await container.db.select().from(aiRuns).where(and(eq(aiRuns.companyId, id), eq(aiRuns.task, "intake.suggest")))).toHaveLength(0);
    });

    it("the words typed are still saved, and the job already made can still be changed by chat", async () => {
      const { cookie, older, roleId } = await atItsJob();
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${older}/messages`, { message: "It starts in January." })).status).toBe(200);
      const change = await json(cookie, "POST", `/api/v1/roles/${roleId}/revisions`, { message: "Make the description shorter." });
      expect(change.status, await change.clone().text()).not.toBe(402);
    });

    it("with room the same routes run as they always did, on any plan", async () => {
      const { cookie } = await newCompany();
      const session = await startDraft(cookie);
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${session}/draft`)).status).toBe(200);
      expect((await json(cookie, "POST", `/api/v1/intake/sessions/${session}/revisions`, { message: "Make it shorter." })).status).not.toBe(402);
      const suggest = await json(cookie, "POST", "/api/v1/intake/suggestions", { title: "Delivery driver" });
      expect(((await read(suggest)) as { unavailable?: boolean }).unavailable).toBeUndefined();
    });

    it("a full plan of roles at a time stops them too, in that plan's own words", async () => {
      const { cookie, id } = await newCompany();
      await usePlan(container, id, "core");
      const session = await startDraft(cookie);
      await jobWaiting(cookie);
      await jobWaiting(cookie);
      const r = await json(cookie, "POST", `/api/v1/intake/sessions/${session}/draft`);
      expect(r.status).toBe(402);
      const err = await errorOf(r);
      expect(err.message).toMatch(/^Your plan includes 2 roles at a time/);
      expect(err.details.upgrade).toBeUndefined();
      expect(err.details.actions[0]).toMatchObject({ label: "Talk to ITS about more roles" });
    });
  });

  describe("a closed role stays closed, on every plan", () => {
    /** A company on an ordinary plan (two roles at a time), with one job waiting for approval. */
    const waitingOnCore = async () => {
      const { cookie, id } = await newCompany();
      await usePlan(container, id, "core");
      return { cookie, id, roleId: await jobWaiting(cookie) };
    };
    /** Closed the way a role was before closing withdrew its approval: the request and the run are still waiting. */
    const closedBehindItsApproval = async (roleId: string, companyId: string) => withPlatform(container.db, (tx) => tx.update(roles).set({ status: "closed", closedAt: new Date().toISOString(), closeReason: "role_cancelled" }).where(and(eq(roles.id, roleId), eq(roles.companyId, companyId))));

    it("closing a role withdraws its approval and stops its run, so its place cannot be taken twice", async () => {
      const { cookie, roleId } = await waitingOnCore();
      const req = (await pendingOf(roleId))!;
      const runId = req.workflowRunId!;
      await closeOk(cookie, roleId);
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.id)))[0]).toMatchObject({ status: "cancelled", decisionNote: "the job was closed" });
      expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0].status).toBe("cancelled");
      // approving it afterwards is refused either way, and it stays closed
      const viaRole = await json(cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" });
      expect(viaRole.status).toBe(409);
      expect((await errorOf(viaRole)).code).toBe("role_closed");
      const viaRequest = await json(cookie, "POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approve" });
      expect(viaRequest.status).toBe(409);
      await container.drain();
      expect((await roleOf(roleId)).status).toBe("closed");
      // the 14 days running out changes nothing either
      await pastTheApprovalWindow(() => container.drain());
      expect((await roleOf(roleId)).status).toBe("closed");
      expect((await room(cookie)).used).toBe(0);
    });

    it("the way past the limit is shut: job A closes, job B opens, and A can no longer be approved open beside it", async () => {
      const { cookie, id } = await newCompany();
      const a = await jobWaiting(cookie);
      await closeOk(cookie, a);
      const b = await jobWaiting(cookie);
      await approve(cookie, b);
      expect((await json(cookie, "POST", `/api/v1/roles/${a}/approve`, { version: 1, note: "ok" })).status).toBe(409);
      await container.drain();
      expect((await container.db.select({ status: roles.status }).from(roles).where(eq(roles.companyId, id))).map((r) => r.status).sort()).toEqual(["closed", "open"]);
    });

    it("a request left waiting on a closed role is refused both ways, whichever button is pressed", async () => {
      const { cookie, id, roleId } = await waitingOnCore();
      const req = (await pendingOf(roleId))!;
      await closedBehindItsApproval(roleId, id);
      for (const r of [await json(cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" }), await json(cookie, "POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approve" }), await json(cookie, "POST", `/api/v1/approvals/${req.id}/decide`, { decision: "reject", note: "No." })]) {
        expect(r.status).toBe(409);
        expect(await errorOf(r)).toMatchObject({ code: "role_closed", message: "This role is closed, so it is not changed any more. Start a new role to hire again." });
      }
      expect((await pendingOf(roleId))?.id).toBe(req.id);
      expect((await roleOf(roleId)).status).toBe("closed");
    });

    it("the open step refuses a closed role, whatever woke it", async () => {
      const { id, roleId } = await waitingOnCore();
      const req = (await pendingOf(roleId))!;
      await closedBehindItsApproval(roleId, id);
      await withPlatform(container.db, (tx) => tx.update(approvalRequests).set({ status: "approved" }).where(eq(approvalRequests.id, req.id)));
      await withTenant(container.db, id, (tx) => container.engine.signal(tx, { companyId: id, key: `approval:${req.id}`, payload: { decision: "approved" } }));
      await container.kick();
      await container.drain();
      const role = await roleOf(roleId);
      expect(role).toMatchObject({ status: "closed", openedAt: null });
      expect(await container.db.select().from(events).where(and(eq(events.type, "role.opened"), eq(events.subjectId, roleId)))).toHaveLength(0);
      expect((await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, req.workflowRunId!)))[0].status).toBe("completed");
    });

    it("the 14 days running out never turn a closed role back into a draft", async () => {
      const { id, roleId } = await waitingOnCore();
      const req = (await pendingOf(roleId))!;
      await closedBehindItsApproval(roleId, id);
      await pastTheApprovalWindow(async () => {
        await container.engine.tick(req.workflowRunId!, { kind: "manual" });
        await container.drain();
      });
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.id)))[0].status).toBe("expired");
      expect((await roleOf(roleId)).status).toBe("closed");
      expect(await container.db.select().from(events).where(and(eq(events.type, "role.sent_back"), eq(events.subjectId, roleId)))).toHaveLength(0);
    });

    it("a run that reaches its first step after the role closed asks nobody", async () => {
      const { id, roleId } = await waitingOnCore();
      await closedBehindItsApproval(roleId, id);
      await withTenant(container.db, id, (tx) => container.engine.start(tx, { workflowKey: "role_approval", companyId: id, subject: { type: "role", id: roleId }, state: { roleId, packetVersion: 1 }, idempotencyKey: `late:${roleId}`, actor: { kind: "system", id: "test" } }));
      const before = (await container.db.select().from(approvalRequests).where(eq(approvalRequests.roleId, roleId))).length;
      await container.kick();
      await container.drain();
      expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.roleId, roleId))).length).toBe(before);
    });

    it("ITS voiding the outcome of a role closed while it waited brings it back as a draft to ask again: nothing to approve would leave it stuck", async () => {
      const { cookie, roleId } = await waitingOnCore();
      await closeOk(cookie, roleId);
      const [outcome] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, roleId));
      const r = await json(admin, "POST", `/api/v1/admin/outcomes/${outcome.id}/correct`, { confirm: true, reason: "Closed by mistake, the owner says." });
      expect(r.status, await r.clone().text()).toBe(200);
      expect((await roleOf(roleId)).status).toBe("draft");
      const again = await json(cookie, "POST", `/api/v1/roles/${roleId}/request-approval`, {});
      expect(again.status, await again.clone().text()).toBe(201);
      await container.drain();
      expect(await pendingOf(roleId)).not.toBeNull();
    });

    it("ITS voiding the outcome of a live role reopens it as it was", async () => {
      const { cookie, roleId } = await waitingOnCore();
      await approve(cookie, roleId);
      await closeOk(cookie, roleId);
      const [outcome] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, roleId));
      expect((await json(admin, "POST", `/api/v1/admin/outcomes/${outcome.id}/correct`, { confirm: true, reason: "Closed by mistake, the owner says." })).status).toBe(200);
      expect((await roleOf(roleId)).status).toBe("open");
    });

    const voidOutcomeOf = async (roleId: string) => {
      const [outcome] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, roleId));
      return { outcome, answer: await json(admin, "POST", `/api/v1/admin/outcomes/${outcome.id}/correct`, { confirm: true, reason: "Closed by mistake, the owner says." }) };
    };

    it("on Free, a void that would make a second job is refused until the plan has room: nothing moves, and ITS is told to change the plan first", async () => {
      const { cookie, id } = await newCompany();
      const never = await jobWaiting(cookie);
      await closeOk(cookie, never);
      const live = await jobWaiting(cookie);
      await approve(cookie, live);
      expect((await roleOf(live)).status).toBe("open");

      const { outcome, answer } = await voidOutcomeOf(never);
      expect(answer.status).toBe(409);
      expect(await errorOf(answer)).toMatchObject({ code: "no_room_on_plan", message: "Reopening this job needs a place on the company's plan, and none is free. Change the plan first, then void this outcome." });
      expect((await roleOf(never)).status).toBe("closed");
      expect((await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.id, outcome.id)))[0].correctedAt).toBeNull();
      expect(await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.correctionOf, outcome.id))).toEqual([]);

      // Basic has room, so the same void goes, and the job is a draft to ask for approval again
      const moved = await json(admin, "POST", `/api/v1/admin/customers/${id}/plan`, { planKey: "basic", reason: "They asked to upgrade." });
      expect(moved.status).toBe(200);
      expect((await voidOutcomeOf(never)).answer.status).toBe(200);
      expect((await roleOf(never)).status).toBe("draft");
    });

    it("on any plan: Basic with all 3 places in use cannot void a closed job into a 4th, and can once one closes", async () => {
      const { cookie, id } = await newCompany();
      const moved = await json(admin, "POST", `/api/v1/admin/customers/${id}/plan`, { planKey: "basic", reason: "They asked to upgrade." });
      expect(moved.status).toBe(200);
      const first = await jobWaiting(cookie);
      await approve(cookie, first);
      await closeOk(cookie, first);
      const inUse: string[] = [];
      for (let i = 0; i < 3; i++) {
        const role = await jobWaiting(cookie);
        await approve(cookie, role);
        inUse.push(role);
      }
      expect((await room(cookie)).used).toBe(3);
      expect((await voidOutcomeOf(first)).answer.status).toBe(409);
      expect((await roleOf(first)).status).toBe("closed");
      await closeOk(cookie, inUse[0]);
      expect((await voidOutcomeOf(first)).answer.status).toBe(200);
      expect((await roleOf(first)).status).toBe("open");
      expect((await room(cookie)).used).toBe(3);
    });

    it("a correction that does not reopen the job needs no room: a closed job's reason can be put right with every place in use", async () => {
      const { cookie } = await newCompany();
      const never = await jobWaiting(cookie);
      await closeOk(cookie, never);
      const live = await jobWaiting(cookie);
      await approve(cookie, live);
      const [outcome] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, never));
      const corrected = await json(admin, "POST", `/api/v1/admin/outcomes/${outcome.id}/correct`, { confirm: true, reason: "It was filled, not cancelled.", outcome: "filled_outside_platform" });
      expect(corrected.status, await corrected.clone().text()).toBe(200);
      expect((await roleOf(never)).status).toBe("closed");
    });

    it("on Free, the one job that went live and was closed by mistake comes back: the place it needs is its own, which it never gave up", async () => {
      const { cookie } = await newCompany();
      const job = await jobWaiting(cookie);
      await approve(cookie, job);
      await closeOk(cookie, job);
      // it counts for good, so nothing new can start: 1 of Free's 1 job, and it is this one
      expect(await room(cookie)).toMatchObject({ ok: false, upgrade: true });
      expect((await voidOutcomeOf(job)).answer.status).toBe(200);
      expect((await roleOf(job)).status).toBe("open");
    });

    it("a void takes the job's lock before the plan's row, in the order a change of plan takes them, and holds the row until it commits, so nothing can take that place meanwhile", async () => {
      const { cookie, id } = await newCompany();
      const job = await jobWaiting(cookie);
      await closeOk(cookie, job);
      const [outcome] = await container.db.select().from(hiringOutcomes).where(eq(hiringOutcomes.roleId, job));
      /** Whether this transaction holds the row a new job's room is read behind (POST /intake/sessions/:id/compile). */
      const holdsThePlansRow = async (tx: Tx) => {
        const [row] = rowsOf<{ xmax: string; me: string }>(await tx.execute(sql`select xmax::text as xmax, pg_current_xact_id()::text as me from entitlements where company_id = ${id} and key = 'active_roles'`));
        return row.xmax === row.me;
      };
      const isJobLock = (statement: unknown) => (statement as { queryChunks?: Array<{ value?: unknown }> }).queryChunks?.some((c) => Array.isArray(c.value) && c.value.join("").includes("pg_advisory_xact_lock")) ?? false;
      await withPlatform(container.db, async (tx) => {
        const atEachJobLock: boolean[] = [];
        const watched = new Proxy(tx, {
          get(target, prop) {
            if (prop !== "execute") return Reflect.get(target, prop);
            return async (statement: Parameters<Tx["execute"]>[0]) => {
              if (isJobLock(statement)) atEachJobLock.push(await holdsThePlansRow(target));
              return target.execute(statement);
            };
          },
        });
        await correctOutcome(watched, { outcomeId: outcome.id, actor: { kind: "system", id: "test" }, reason: "Closed by mistake, the owner says." });
        expect(atEachJobLock[0]).toBe(false);
        expect(await holdsThePlansRow(tx)).toBe(true);
      });
      expect((await roleOf(job)).status).toBe("draft");
    });
  });

  describe("a change of plan", () => {
    it("any plan other than Trial and Design Partner reads as active, from Design Partner too", async () => {
      const { id } = await newCompany();
      const to = async (planKey: string) => read<{ status: string; planKey: string }>(await json(admin, "POST", `/api/v1/admin/customers/${id}/plan`, { planKey, reason: "A change for this test." }));
      expect(await to("design_partner")).toMatchObject({ planKey: "design_partner", status: "design_partner" });
      expect(await to("free")).toMatchObject({ planKey: "free", status: "active" });
      expect(await to("pro")).toMatchObject({ planKey: "pro", status: "active" });
      expect(await to("design_partner")).toMatchObject({ status: "design_partner" });
      expect(await to("ultra")).toMatchObject({ planKey: "ultra", status: "active" });
    });

    it("the retired plans are refused; the console lists the four and Design Partner", async () => {
      const { id } = await newCompany();
      for (const planKey of ["trial", "core", "growth", "company"]) {
        const r = await json(admin, "POST", `/api/v1/admin/customers/${id}/plan`, { planKey, reason: "A change for this test." });
        expect(r.status, planKey).toBe(400);
        expect((await errorOf(r)).code, planKey).toBe("inactive_plan");
      }
      const listed = await read<Array<{ key: string }>>(await json(admin, "GET", "/api/v1/admin/plans"));
      expect(listed.map((p) => p.key).sort()).toEqual(["basic", "design_partner", "free", "pro", "ultra"]);
      expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, id), eq(auditRecords.action, "plan.changed")))).toHaveLength(0);
    });

    it("what was already kept stays: a stored company on a retired plan keeps working", async () => {
      const { cookie, id } = await newCompany();
      await usePlan(container, id, "growth");
      expect(await room(cookie)).toMatchObject({ ok: true, limit: 5 });
      expect((await container.db.select({ planKey: companies.planKey }).from(companies).where(eq(companies.id, id)))[0].planKey).toBe("growth");
    });
  });

  describe("the AI credit, counted live and never in dollars", () => {
    const spend = (companyId: string, costUsd: string, createdAt?: string) => withPlatform(container.db, (tx) => tx.insert(aiRuns).values({ companyId, agent: "intake", task: "intake.turn", provider: "fake", model: "fake", promptKey: "intake.turn", promptVersion: 1, promptHash: "x", costUsd, ...(createdAt ? { createdAt } : {}) }));
    const credit = (cookie: string, key: "ai_credit_total_cents" | "ai_credit_monthly_cents") => current(cookie).then((c) => c.usage[key]);
    const rowOf = async (id: string, key: string) => (await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, id), eq(entitlements.key, key))))[0];

    it("Free reads its total as a percentage for the customer and in cents for the server; `used` stays 0", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "2.500000");
      expect(await credit(cookie, "ai_credit_total_cents")).toEqual({ used: 25, limit: 100, unit: "percent" });
      expect(await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.AI_CREDIT_TOTAL_CENTS))).toEqual({ ok: true, limit: 1000, used: 250 });
      expect((await rowOf(id, allowance.AI_CREDIT_TOTAL_CENTS)).used).toBe(0);
      expect(Object.values((await current(cookie)).usage).map((line) => line.used)).not.toContain(250);
      // a fraction of a cent counts: rounded up, so the money is never undercounted
      await spend(id, "0.000800");
      expect(await withTenant(container.db, id, (tx) => allowance.aiCreditSpentCents(tx, id))).toBe(251);
    });

    it("reads nearly all as nearly all, all as all, and never more than all", async () => {
      const { cookie, id } = await newCompany();
      const room = () => withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.AI_CREDIT_TOTAL_CENTS));
      await spend(id, "9.990000");
      expect((await credit(cookie, "ai_credit_total_cents")).used).toBe(99);
      expect((await room()).ok).toBe(true);
      await spend(id, "0.010000");
      expect((await credit(cookie, "ai_credit_total_cents")).used).toBe(100);
      expect((await room()).ok).toBe(false);
      await spend(id, "1.000000");
      expect((await credit(cookie, "ai_credit_total_cents")).used).toBe(100);
    });

    it("the total never resets, however long ago it was spent", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "5.000000", new Date(Date.now() - 400 * DAY).toISOString());
      expect((await credit(cookie, "ai_credit_total_cents")).used).toBe(50);
    });

    it("a paid plan reads its month from the period's start, says when it resets, and has no total line", async () => {
      const { cookie, id } = await newCompany();
      await spend(id, "5.000000", new Date(Date.now() - 60_000).toISOString());
      await usePlan(container, id, "basic");
      // the upgrade's first month starts with the upgrade: what was spent on Free is not charged to it
      expect((await credit(cookie, "ai_credit_monthly_cents")).used).toBe(0);
      await spend(id, "4.000000");
      const line = await credit(cookie, "ai_credit_monthly_cents");
      expect(line).toMatchObject({ used: 20, limit: 100, unit: "percent" });
      expect(Date.parse(line.resetsAt ?? "") - Date.now()).toBeGreaterThan(29 * DAY);
      expect((await current(cookie)).usage).not.toHaveProperty("ai_credit_total_cents");
      expect(await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.AI_CREDIT_MONTHLY_CENTS))).toEqual({ ok: true, limit: 2000, used: 400 });
      // a new period starts from nothing by date alone, with nobody writing anything
      const row = await rowOf(id, allowance.AI_CREDIT_MONTHLY_CENTS);
      const later = new Date(Date.parse(row.periodEnd!) + DAY);
      expect(await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.AI_CREDIT_MONTHLY_CENTS, 1, { now: later }))).toEqual({ ok: true, limit: 2000, used: 0 });
      expect(await withTenant(container.db, id, (tx) => allowance.usageOf(tx, id, { now: later })).then((u) => u.ai_credit_monthly_cents)).toMatchObject({ used: 0, resetsAt: new Date(Date.parse(row.periodEnd!) + 30 * DAY).toISOString() });
      // a move between paid plans keeps the month, like every other allowance: what was spent stays spent, and the date stays
      await usePlan(container, id, "pro");
      expect(await rowOf(id, allowance.AI_CREDIT_MONTHLY_CENTS)).toMatchObject({ limit: 6000, periodStart: row.periodStart, periodEnd: row.periodEnd });
      expect((await credit(cookie, "ai_credit_monthly_cents")).used).toBe(6);
    });

    it("a move down to Free gives no second credit: the total counts everything ever spent", async () => {
      const { cookie, id } = await newCompany();
      await usePlan(container, id, "basic");
      await spend(id, "9.500000");
      await usePlan(container, id, "free");
      expect((await credit(cookie, "ai_credit_total_cents")).used).toBe(95);
      expect((await current(cookie)).usage).not.toHaveProperty("ai_credit_monthly_cents");
    });

    it("a plan with no credit, like Design Partner, has no line and no limit", async () => {
      const { cookie, id } = await newCompany();
      await usePlan(container, id, "design_partner");
      await spend(id, "50.000000");
      const usage = (await current(cookie)).usage;
      for (const key of ["ai_credit_total_cents", "ai_credit_monthly_cents"]) expect(usage, key).not.toHaveProperty(key);
      expect(await withTenant(container.db, id, (tx) => allowance.check(tx, id, allowance.AI_CREDIT_TOTAL_CENTS))).toMatchObject({ ok: true, limit: null });
    });
  });

  describe("people, in the plan's words", () => {
    const seatWords = { full: "Your plan includes 2 people. Upgrade to add more.", signIn: "This company's plan includes 2 people. Ask the person who invited you to upgrade." };
    const invite = (cookie: string, email: string) => json(cookie, "POST", "/api/v1/companies/current/members/invite", { email, role: "interviewer" });

    it("Free has two: the owner and one invitation; the next is refused in the plan's words, and nothing says trial", async () => {
      const { cookie } = await newCompany();
      expect((await invite(cookie, "first@free-plan.test")).status).toBe(201);
      const refused = await invite(cookie, "second@free-plan.test");
      expect(refused.status).toBe(409);
      expect(await read(refused)).toMatchObject({ error: { code: "seats_full", message: seatWords.full, details: { seats: { used: 2, limit: 2 } } } });
    });

    it("sending a lapsed invitation again into a full company says the same", async () => {
      const { cookie } = await newCompany();
      const first = await read<{ invitation: { id: string } }>(await invite(cookie, "lapsed@free-plan.test"));
      await withPlatform(container.db, (tx) => tx.update(invitations).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(invitations.id, first.invitation.id)));
      expect((await invite(cookie, "taken@free-plan.test")).status).toBe(201);
      const again = await json(cookie, "POST", `/api/v1/companies/current/invitations/${first.invitation.id}/resend`);
      expect(again.status).toBe(409);
      expect(await read(again)).toMatchObject({ error: { code: "seats_full", message: seatWords.full } });
    });

    it("an invitation carried at sign-in into a full company is refused in the plan's words", async () => {
      const { cookie, id } = await newCompany();
      const sent = await read<{ devLink: string }>(await invite(cookie, "late@free-plan.test"));
      // the second place goes to someone who joined outside an invitation
      await withPlatform(container.db, async (tx) => {
        const [joined] = await tx.insert(users).values({ email: "joined@free-plan.test", name: "Joined" }).returning();
        await tx.insert(memberships).values({ companyId: id, userId: joined.id, role: "interviewer", status: "active" });
      });
      const page = await app.request(sent.devLink.replace(container.env.APP_BASE_URL, ""));
      const inviteCookie = page.headers.getSetCookie().find((c) => c.startsWith("ros_invite="))?.split(";")[0] ?? "";
      const token = (container.integrations.identity as FakeIdentityProvider).mint({ email: "late@free-plan.test", name: "Late", provider: "google" });
      const r = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.77", cookie: inviteCookie }, body: JSON.stringify({ accessToken: token }) });
      expect(r.status).toBe(403);
      expect(await read(r)).toMatchObject({ error: { code: "invite_seats_full", message: seatWords.signIn } });
    });

    it("the Trial plan keeps its own words", async () => {
      const { cookie, id } = await newCompany();
      await withPlatform(container.db, (tx) => allowance.applyPlan(tx, id, "trial", "trial"));
      expect((await invite(cookie, "a@trial-words.test")).status).toBe(201);
      expect((await invite(cookie, "b@trial-words.test")).status).toBe(201);
      const refused = await invite(cookie, "c@trial-words.test");
      expect(await read(refused)).toMatchObject({ error: { code: "seats_full", message: "Your trial includes 3 people. Choose a plan to add more." } });
    });
  });
});

/** With the ITS check on, as in production: confirming a company on Free starts nothing, and the hourly check never finds it. */
describe("the ITS check on the Free plan", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", COMPANY_CHECK: "its", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
  });
  afterAll(async () => {
    await container.close();
  });

  it("confirming it starts no clock and says nothing about one", async () => {
    const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const owner = await signInWithIdentity(app, container, { email: "owner@free-check.test", name: "Owner", provider: "google", aal2: false });
    const admin = await signInAdmin(app, container, "ana.admin@identifiedtalent.com", "Ana Admin");
    const made = await json(owner, "POST", "/api/v1/companies", { name: "Free Check Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(made.status, await made.clone().text()).toBe(201);
    const { id } = (await made.json()) as { id: string };
    const confirmed = await json(admin, "POST", `/api/v1/admin/customers/${id}/verification`, { verified: true, reason: "Kick-off call with the owner.", confirm: true });
    expect(confirmed.status, await confirmed.clone().text()).toBe(200);
    await container.drain();
    const [co] = await container.db.select({ planKey: companies.planKey, status: companies.status, settings: companies.settings }).from(companies).where(eq(companies.id, id));
    expect(co).toMatchObject({ planKey: "free", status: "active" });
    expect(co.settings.verifiedAt).toBeTruthy();
    expect(co.settings.trial).toBeUndefined();
    expect(await container.db.select().from(events).where(and(eq(events.companyId, id), eq(events.type, "trial.started")))).toHaveLength(0);
    const told = await container.db.select().from(notifications).where(and(eq(notifications.companyId, id), eq(notifications.kind, "company.verified")));
    expect(told.length).toBeGreaterThanOrEqual(1);
    for (const n of told) expect(n.body).not.toMatch(/trial/i);
    expect(await withPlatform(container.db, (tx) => settleTrials(tx, container.engine.clock()))).toMatchObject({ started: 0 });
    expect((await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, id)))[0].settings.trial).toBeUndefined();
  });
});

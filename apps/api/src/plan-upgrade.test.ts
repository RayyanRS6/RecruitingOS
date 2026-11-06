import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MORE_JOBS_UPGRADE_QUESTION, PLAN_REQUEST_EXPERTISE, PLAN_REQUEST_OPEN_LINE, PLAN_REQUEST_SUMMARY, type Actor, type PublicPlans, type RecruiterRequestView } from "@ros/contracts";
import { detectStuckRoles, runInterventionLadder } from "@ros/agents";
import { applications, auditRecords, candidates, entitlements, escalationMessages, notifications, randomToken, recruiterEscalations, staffAccessGrants, withTenant } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInAs, signInStaff, usePlan } from "./test-helpers";

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";
const ACCESS_WORDS = /every role|every candidate|will see|They can see|access|grant/i;
const WHY = "They asked to upgrade.";

/**
 * The plans of 5 November 2026, Rules 5 and 6: the way to a bigger plan with no payment system, and ITS staff time. GET /plans
 * lists the public plans only. A request about the plan is never counted, carries nothing of the company's hiring, and taking
 * it up gives nobody access to anything, so no word about access reaches anyone: on a plan with locked candidates that is
 * the point. A second one answers softly. Change plan tells the owners and admins, answers the request and shows in the
 * customer's own history. A plan with no ITS staff time has no ITS posting tasks, no job-boards step and a ladder that stops at
 * the email; a move up gives ITS the boards waiting, and a move down takes its tasks back.
 */
describe("asking for a bigger plan, and who does the work", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let recruiter = "";
  let made = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const errorOf = async (r: Response) => (await read<{ error: { code: string; message: string; details: { upgrade?: boolean; actions: Array<{ label: string; body: Record<string, unknown> }> } } }>(r)).error;
  const emails = () => (container.integrations.email as FakeEmailAdapter).sent;
  const askPlan = (cookie: string, question = "We would like to move to the Pro plan.") => json(cookie, "POST", "/api/v1/escalations", { kind: "ask", scope: "company", topic: "plan", question });
  const rowOf = async (id: string) => (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, id)))[0];
  const asksUsed = async (companyId: string) => (await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "recruiter_asks"))))[0].used;
  const changePlan = async (companyId: string, planKey: string) => {
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey, reason: WHY });
    expect(r.status, await r.clone().text()).toBe(200);
    await container.drain();
  };

  /** A company of its own, on Free; each sign-in from an address of its own (the route's limit per address). */
  const newCompany = async () => {
    made += 1;
    const accessToken = (container.integrations.identity as FakeIdentityProvider).mint({ email: `owner-${made}@upgrade.test`, name: `Owner ${made}`, provider: "google" });
    const signedIn = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${made}` }, body: JSON.stringify({ accessToken }) });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const r = await json(cookie, "POST", "/api/v1/companies", { name: `Upgrade Dental ${made}`, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status, await r.clone().text()).toBe(201);
    const co = await read<{ id: string; name: string }>(r);
    return { cookie, id: co.id, name: co.name };
  };
  /** A job that is live, its boards prepared. */
  const openJob = async (cookie: string) => {
    const s = await read<{ session: { id: string } }>(await json(cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE }));
    const compiled = await json(cookie, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(compiled.status, await compiled.clone().text()).toBe(201);
    const { roleId } = await read<{ roleId: string }>(compiled);
    expect((await json(cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    return roleId;
  };
  const postingTasks = async (roleId: string) => (await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.roleId, roleId))).filter((e) => ["post_job", "update_job", "take_down_job"].includes(e.kind));
  const setupSteps = async (cookie: string) => {
    const cards = (await read<{ cards: Array<{ kind: string; gettingStarted?: { steps: Array<{ key: string }> } }> }>(await json(cookie, "GET", "/api/v1/brief"))).cards;
    return cards.find((c) => c.kind === "getting_started")?.gettingStarted?.steps.map((s) => s.key) ?? [];
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
    recruiter = await signInStaff(app, container, "kai@its.test", "its_recruiter", "Kai Recruiter");
  });
  afterAll(async () => {
    await container.close();
  });

  describe("GET /plans", () => {
    it("lists the four public plans in order with their numbers, the AI help in words and the company's own marked; nobody's pilot, and no money for AI", async () => {
      const co = await newCompany();
      const r = await json(co.cookie, "GET", "/api/v1/plans");
      expect(r.status).toBe(200);
      const text = await r.clone().text();
      const { plans, requested } = await read<PublicPlans>(r);
      expect(requested).toBe(false);
      expect(plans.map((p) => p.key)).toEqual(["free", "basic", "pro", "ultra"]);
      expect(plans.filter((p) => p.current).map((p) => p.key)).toEqual(["free"]);
      expect(plans[0]).toEqual({ key: "free", name: "Free", monthlyUsd: 0, activeRoles: 1, jobsTotal: 1, candidatesPerJob: 5, seats: 2, aiHelp: "Included, up to a limit", current: true });
      expect(plans[1]).toMatchObject({ name: "Basic", monthlyUsd: 49, jobsTotal: null, activeRoles: 3, candidatesPerJob: 25, seats: 3, aiHelp: "About 600 candidates a month" });
      expect(plans[2]).toMatchObject({ name: "Pro", monthlyUsd: 149, candidatesPerJob: 100, seats: 10, aiHelp: "About 1,800" });
      expect(plans[3]).toMatchObject({ name: "Ultra", monthlyUsd: 399, candidatesPerJob: null, seats: null, aiHelp: "About 6,000" });
      for (const word of ["design_partner", "Design Partner", "ai_credit", "cents", "limits", "2000", "20000"]) expect(text, word).not.toContain(word);
    });

    it("any member reads it, nobody signed out does; a company on the private pilot or a retired plan has nothing marked", async () => {
      const co = await newCompany();
      const interviewer = await signInAs(container, app, { companyId: co.id, role: "interviewer" });
      expect((await json(interviewer, "GET", "/api/v1/plans")).status).toBe(200);
      expect((await app.request("/api/v1/plans")).status).toBe(401);
      await changePlan(co.id, "design_partner");
      expect((await read<PublicPlans>(await json(co.cookie, "GET", "/api/v1/plans"))).plans.filter((p) => p.current)).toEqual([]);
      await usePlan(container, co.id, "growth");
      expect((await read<PublicPlans>(await json(co.cookie, "GET", "/api/v1/plans"))).plans.filter((p) => p.current)).toEqual([]);
    });
  });

  describe("a request about the plan", () => {
    it("is never counted, carries nothing of the company's hiring, and says nothing about access; a second one answers softly and raises nothing", async () => {
      const co = await newCompany();
      await openJob(co.cookie);
      const r = await askPlan(co.cookie);
      expect(r.status).toBe(201);
      const first = await read<{ id: string; message: string }>(r);
      expect(first.message).toContain("ITS will respond by");
      expect(first.message).toContain("No card is charged, and nothing changes until then.");
      expect(first.message).not.toMatch(ACCESS_WORDS);
      const row = await rowOf(first.id);
      expect(row).toMatchObject({ kind: "ask", summary: PLAN_REQUEST_SUMMARY, requiredExpertise: PLAN_REQUEST_EXPERTISE, roleId: null, applicationId: null, billing: { countsTowardAllowance: false, topic: "plan" } });
      expect(Object.keys(row.contextSnapshot).sort()).toEqual(["capturedAt", "company"]);
      expect(await asksUsed(co.id)).toBe(0);
      // the ITS queue hears of it like any other
      expect(emails().filter((m) => m.subject.includes("[ask]") && m.text.includes(PLAN_REQUEST_SUMMARY)).length).toBeGreaterThan(0);

      const again = await askPlan(co.cookie, "We would like to move to the Ultra plan.");
      expect(again.status).toBe(200);
      expect(await read(again)).toMatchObject({ id: first.id, alreadyAsked: true, message: PLAN_REQUEST_OPEN_LINE });
      expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, co.id))).filter((e) => e.kind === "ask")).toHaveLength(1);
      expect((await rowOf(first.id)).question).toBe("We would like to move to the Pro plan.");
      expect((await read<PublicPlans>(await json(co.cookie, "GET", "/api/v1/plans"))).requested).toBe(true);
      // Home says it is with ITS, not that a recruiter will pick up their hiring
      const brief = await read<{ summary: string; cards: Array<{ kind: string; title: string; body: string }> }>(await json(co.cookie, "GET", "/api/v1/brief"));
      expect(brief.cards.filter((c) => c.kind === "escalation").map((c) => [c.title, c.body])).toEqual([[PLAN_REQUEST_OPEN_LINE, "We would like to move to the Pro plan."]]);
      expect(brief.summary).toContain("· 0 at risk ·");
      // anyone who may ask gets the same soft answer; an interviewer may not ask
      const hm = await signInAs(container, app, { companyId: co.id, role: "hiring_manager" });
      expect(await read(await askPlan(hm))).toMatchObject({ id: first.id, message: PLAN_REQUEST_OPEN_LINE });
      const interviewer = await signInAs(container, app, { companyId: co.id, role: "interviewer" });
      expect((await askPlan(interviewer)).status).toBe(403);
      // an ordinary request still says what it gives
      const other = await json(co.cookie, "POST", "/api/v1/escalations", { kind: "ask", scope: "company", question: "Help with our pay bands?" });
      expect((await read<{ message: string }>(other)).message).toContain("all of your hiring: every role and every candidate");
      const titles = (await read<{ cards: Array<{ kind: string; title: string }> }>(await json(co.cookie, "GET", "/api/v1/brief"))).cards.filter((c) => c.kind === "escalation").map((c) => c.title);
      expect(titles.sort()).toEqual(["A recruiter will pick this up", PLAN_REQUEST_OPEN_LINE]);
    });

    it("two asked at once raise one request", async () => {
      const co = await newCompany();
      const answers = await Promise.all([askPlan(co.cookie), askPlan(co.cookie)]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 201]);
      expect((await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.companyId, co.id))).filter((e) => e.kind === "ask")).toHaveLength(1);
    });

    it("before anyone accepts it, the queue shows the template and never the words; accepting grants nothing, and the recruiter cannot enter the company", async () => {
      const co = await newCompany();
      const { id } = await read<{ id: string }>(await askPlan(co.cookie, "We would like to move to the Pro plan. Secret note about Maria."));
      const queue = await json(recruiter, "GET", "/api/v1/escalations");
      const queueText = await queue.text();
      expect(queueText).toContain(PLAN_REQUEST_SUMMARY);
      expect(queueText).not.toContain("Secret note");
      const before = await read<{ accessGranted: boolean; why: string; summary: string }>(await json(recruiter, "GET", `/api/v1/escalations/${id}`));
      expect(before).toMatchObject({ accessGranted: false, summary: PLAN_REQUEST_SUMMARY });
      expect(before.why).toContain("It gives you no access to their hiring.");

      const claimed = await json(recruiter, "POST", `/api/v1/escalations/${id}/claim`);
      expect(claimed.status).toBe(200);
      expect((await read<{ grant: unknown }>(claimed)).grant).toBeNull();
      expect(await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, id))).toEqual([]);
      // nothing to tell the customer about who can see their hiring: nobody can
      expect(await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "recruiter.claimed")))).toEqual([]);
      expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId: co.id })).status).not.toBe(200);

      const open = await read<{ accessGranted: boolean; planRequest: boolean; grant: unknown; question: string; thread: Array<{ body: string }>; contextSnapshot: Record<string, unknown> }>(await json(recruiter, "GET", `/api/v1/escalations/${id}`));
      expect(open).toMatchObject({ accessGranted: true, planRequest: true, grant: null });
      expect(open.question).toContain("Secret note about Maria.");
      expect(Object.keys(open.contextSnapshot).sort()).toEqual(["capturedAt", "company"]);
      // every look at it is on the customer's record, with no grant to name
      const [viewed] = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, co.id), eq(auditRecords.action, "escalation.context_viewed")));
      expect(viewed.details).toMatchObject({ planRequest: true, grant: null });
    });

    it("the recruiter can write and answer with no grant; the team's list says it is about the plan; reopening grants nothing either and goes back to the queue", async () => {
      const co = await newCompany();
      const { id } = await read<{ id: string }>(await askPlan(co.cookie));
      expect((await json(recruiter, "POST", `/api/v1/escalations/${id}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", `/api/v1/escalations/${id}/messages`, { body: "Which month should it start?" })).status).toBe(201);
      const [replied] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "recruiter.replied")));
      expect(replied.title).toBe("Kai Recruiter (ITS recruiter) wrote to you about your plan");
      expect((await json(recruiter, "POST", `/api/v1/escalations/${id}/resolve`, { resolution: "An administrator will change it today." })).status).toBe(200);
      const [answered] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "recruiter.resolved")));
      expect(answered.title).toBe("Kai Recruiter (ITS recruiter) answered the request about your plan");

      const mine = (await read<RecruiterRequestView[]>(await json(co.cookie, "GET", "/api/v1/escalations/mine"))).find((r) => r.id === id)!;
      expect(mine).toMatchObject({ topic: "plan", scope: "company", status: "resolved", recruiterName: "Kai Recruiter", accessExpiresAt: null });

      const reopened = await json(co.cookie, "POST", `/api/v1/escalations/mine/${id}/reopen`, { note: "It has not changed yet." });
      expect(reopened.status).toBe(200);
      const words = await read<{ status: string; message: string }>(reopened);
      expect(words.status).toBe("open");
      expect(words.message).toMatch(/^Reopened and back with ITS, who will respond by /);
      expect(words.message).not.toMatch(ACCESS_WORDS);
      expect(await rowOf(id)).toMatchObject({ status: "open", assignedToUserId: null });
      expect(await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, id))).toEqual([]);
      expect(await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "recruiter.access_granted")))).toEqual([]);
    });
  });

  describe("given back to the queue", () => {
    it("stays open and still asked for, the next person can take it, and it grants nothing either time", async () => {
      const co = await newCompany();
      const { id } = await read<{ id: string }>(await askPlan(co.cookie));
      expect((await json(recruiter, "POST", `/api/v1/escalations/${id}/claim`)).status).toBe(200);
      expect((await json(recruiter, "POST", `/api/v1/escalations/${id}/release`)).status).toBe(200);
      expect(await rowOf(id)).toMatchObject({ status: "open", assignedToUserId: null });
      expect((await read<PublicPlans>(await json(co.cookie, "GET", "/api/v1/plans"))).requested).toBe(true);
      expect((await json(admin, "POST", `/api/v1/escalations/${id}/claim`)).status).toBe(200);
      expect(await container.db.select().from(staffAccessGrants).where(eq(staffAccessGrants.escalationId, id))).toEqual([]);
    });
  });

  describe("Change plan", () => {
    it("tells the owners and admins, answers the open request (and whoever asked), and shows in the customer's own history; the next request is a new one", async () => {
      const co = await newCompany();
      const adminUser = await signInAs(container, app, { companyId: co.id, role: "admin", name: "Abe Admin" });
      const hm = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", name: "Hana Manager" });
      const hmId = (await read<{ user: { id: string } }>(await json(hm, "GET", "/api/v1/auth/me"))).user.id;
      const { id } = await read<{ id: string }>(await askPlan(hm));

      await changePlan(co.id, "pro");

      const told = await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "company.plan_changed")));
      expect(told).toHaveLength(2);
      expect(told[0]).toMatchObject({ title: "Your plan is now Pro", action: { label: "See plan", href: "/setup#setup-company" } });
      expect(told[0].body).toBe("Your company is on the Pro plan now. The new limits apply at once.");
      expect(told.map((n) => n.userId)).not.toContain(hmId);

      expect(await rowOf(id)).toMatchObject({ status: "resolved", resolution: "Your company is on the Pro plan now." });
      const thread = await container.db.select().from(escalationMessages).where(eq(escalationMessages.escalationId, id));
      expect(thread.map((m) => [m.kind, m.side, m.body])).toEqual([["answer", "recruiter", "Your company is on the Pro plan now."]]);
      const heard = await container.db.select().from(notifications).where(and(eq(notifications.userId, hmId), eq(notifications.kind, "recruiter.resolved")));
      expect(heard.map((n) => n.action?.href)).toEqual([`/?request=${id}`]);

      // the customer's history says who changed what, from what, and why
      const history = await read<Array<{ action: string; description: string; reason: string }>>(await json(adminUser, "GET", "/api/v1/companies/current/audit?actions=plan.changed"));
      expect(history.map((h) => h.description)).toEqual([`ITS moved your company to the Pro plan from Free: ${WHY}.`]);

      const plans = await read<PublicPlans>(await json(co.cookie, "GET", "/api/v1/plans"));
      expect(plans.requested).toBe(false);
      expect(plans.plans.filter((p) => p.current).map((p) => p.key)).toEqual(["pro"]);
      expect((await askPlan(co.cookie, "We would like to move to the Ultra plan.")).status).toBe(201);
    });
  });

  describe("ITS staff time", () => {
    it("on Free the team posts: no ITS tasks, no job-boards step, no choice, and asking for ITS is refused with the way on", async () => {
      const co = await newCompany();
      const current = await read<{ whoPosts: string; itsPosting: boolean; settings: Record<string, unknown> }>(await json(co.cookie, "GET", "/api/v1/companies/current"));
      expect(current).toMatchObject({ whoPosts: "self", itsPosting: false });
      expect(current.settings).not.toHaveProperty("boardPosting");
      expect(await setupSteps(co.cookie)).not.toContain("job_boards");
      const roleId = await openJob(co.cookie);
      expect(await postingTasks(roleId)).toEqual([]);
      expect((await read<{ whoPosts: string }>(await json(co.cookie, "GET", `/api/v1/roles/${roleId}`))).whoPosts).toBe("self");
      const boards = await read<{ whoPosts: string; postings: Array<{ channel: string; postedBy: string | null }> }>(await json(co.cookie, "GET", `/api/v1/roles/${roleId}/postings`));
      expect(boards.whoPosts).toBe("self");
      expect(boards.postings.find((p) => p.channel === "indeed")?.postedBy).toBe("you");
      // Home says what to do from the team's own account
      const cards = (await read<{ cards: Array<{ kind: string; title: string }> }>(await json(co.cookie, "GET", "/api/v1/brief"))).cards;
      expect(cards.some((c) => c.kind === "posting_action" && c.title.includes("from your own account"))).toBe(true);

      const refused = await json(co.cookie, "PATCH", "/api/v1/companies/current", { settings: { boardPosting: "its" } });
      expect(refused.status).toBe(402);
      const error = await errorOf(refused);
      expect(error.code).toBe("plan_has_no_its_posting");
      expect(error.details.upgrade).toBe(true);
      expect(error.details.actions[0]).toMatchObject({ label: "Upgrade", body: { topic: "plan", scope: "company" } });
      const asked = await json(co.cookie, "POST", `/api/v1/roles/${roleId}/postings/indeed/ask-its`);
      expect(asked.status).toBe(409);
      expect((await errorOf(asked)).code).toBe("team_posts");
    });

    it("a move to a plan with ITS staff time gives ITS the boards waiting and the job-boards step, and tells its queue; a move down takes the tasks back; the company's own choice survives both", async () => {
      const co = await newCompany();
      const roleId = await openJob(co.cookie);
      await changePlan(co.id, "pro");
      const tasks = await postingTasks(roleId);
      expect(tasks.map((t) => [t.kind, t.status])).toEqual([["post_job", "open"]]);
      expect(emails().filter((m) => m.subject === `[posting tasks] ${co.name}: 1 job board task`)).toHaveLength(1);
      expect((await read<{ whoPosts: string; itsPosting: boolean }>(await json(co.cookie, "GET", "/api/v1/companies/current")))).toMatchObject({ whoPosts: "its", itsPosting: true });
      expect(await setupSteps(co.cookie)).toContain("job_boards");

      await changePlan(co.id, "basic");
      expect((await postingTasks(roleId)).map((t) => [t.kind, t.status])).toEqual([["post_job", "cancelled"]]);
      expect((await read<{ whoPosts: string }>(await json(co.cookie, "GET", "/api/v1/companies/current"))).whoPosts).toBe("self");
      expect(await setupSteps(co.cookie)).not.toContain("job_boards");

      // up again: the withdrawn task comes back. Then the company says its own team posts, and a trip down and up keeps that.
      await changePlan(co.id, "ultra");
      expect((await postingTasks(roleId)).filter((t) => t.status === "open").map((t) => t.kind)).toEqual(["post_job"]);
      expect((await json(co.cookie, "PATCH", "/api/v1/companies/current", { settings: { boardPosting: "self" } })).status).toBe(200);
      expect((await postingTasks(roleId)).filter((t) => t.status === "open")).toEqual([]);
      await changePlan(co.id, "basic");
      await changePlan(co.id, "pro");
      expect((await read<{ whoPosts: string }>(await json(co.cookie, "GET", "/api/v1/companies/current"))).whoPosts).toBe("self");
      expect((await postingTasks(roleId)).filter((t) => t.status === "open")).toEqual([]);
    });

    it("the stuck-role ladder stops at the email on a plan with no ITS staff time, and climbs to a recruiter on one with it", async () => {
      const co = await newCompany();
      const roleId = await openJob(co.cookie);
      const detection = { detector: "candidates_waiting" as const, roleId, roleTitle: "Dental Hygienist", days: 5, title: "Candidates have been waiting on you", body: "They are ready for a decision.", action: { label: "Review them", href: `/roles/${roleId}/talent` } };
      const actor: Actor = { kind: "system", id: "test" };
      let at = Date.now();
      const climb = async () => {
        at += 49 * 3_600_000;
        return (await withTenant(container.db, co.id, (tx) => runInterventionLadder(tx, { integrations: container.integrations, appBaseUrl: "http://localhost:3000", itsQueueEmail: "queue@its.test", now: new Date(at), actor }, co.id, [detection])))[0];
      };
      expect(await climb()).toMatchObject({ level: "brief" });
      expect(await climb()).toMatchObject({ level: "message" });
      expect(await climb()).toMatchObject({ level: "skipped", reason: "the plan has no ITS staff time" });
      expect(await climb()).toMatchObject({ level: "skipped", reason: "the plan has no ITS staff time" });
      const asks = await container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, co.id), eq(recruiterEscalations.kind, "stuck_role")));
      expect(asks).toEqual([]);
      await usePlan(container, co.id, "pro");
      expect(await climb()).toMatchObject({ level: "offer_recruiter" });
      expect(await climb()).toMatchObject({ level: "escalation" });
      expect(await container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, co.id), eq(recruiterEscalations.kind, "stuck_role")))).toHaveLength(1);
      // a real detection on Free still reaches the ladder with its name intact
      expect(Array.isArray(await withTenant(container.db, co.id, (tx) => detectStuckRoles(tx, co.id, new Date(at))))).toBe(true);
    });

    it("a person who asks still reaches ITS on Free, whatever the ladder does", async () => {
      const co = await newCompany();
      const r = await json(co.cookie, "POST", "/api/v1/escalations", { kind: "ask", scope: "company", question: MORE_JOBS_UPGRADE_QUESTION });
      expect(r.status).toBe(201);
      const second = await json(co.cookie, "POST", "/api/v1/escalations", { kind: "ask", scope: "company", question: "And one more?" });
      expect(second.status).toBe(201);
      expect(await asksUsed(co.id)).toBe(2);
    });
  });

  describe("the console", () => {
    it("lists the plans in their order with their prices, and each customer's AI dollars, locked count, open plan request and who posts", async () => {
      const listed = await read<Array<{ key: string; prices: Record<string, number>; limits: Record<string, number | null> }>>(await json(admin, "GET", "/api/v1/admin/plans"));
      expect(listed.map((p) => p.key)).toEqual(["free", "basic", "pro", "ultra", "design_partner"]);
      expect(listed[1].prices.monthlyUsd).toBe(49);
      expect(listed[0].limits.ai_credit_total_cents).toBe(1000);

      const co = await newCompany();
      const roleId = await openJob(co.cookie);
      await withTenant(container.db, co.id, async (tx) => {
        const [cand] = await tx.insert(candidates).values({ companyId: co.id, firstName: "Lena", lastName: "Lockwood", email: "lena.lockwood@people.test", firstSource: "direct" }).returning();
        await tx.insert(applications).values({ companyId: co.id, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "received", statusToken: randomToken(16), lockedAt: new Date().toISOString() });
      });
      type Row = { id: string; lockedApplicants: number; planRequestSince: string | null; whoPosts: string; aiCredit: { limitUsd: number; monthly: boolean } | null };
      const row = async () => (await read<Row[]>(await json(admin, "GET", "/api/v1/admin/customers"))).find((c) => c.id === co.id)!;
      expect(await row()).toMatchObject({ lockedApplicants: 1, planRequestSince: null, whoPosts: "self", aiCredit: { limitUsd: 10, monthly: false } });
      await askPlan(co.cookie);
      expect((await row()).planRequestSince).toBeTruthy();
      await changePlan(co.id, "pro");
      expect(await row()).toMatchObject({ lockedApplicants: 0, planRequestSince: null, whoPosts: "its", aiCredit: { limitUsd: 60, monthly: true } });
    });
  });
});

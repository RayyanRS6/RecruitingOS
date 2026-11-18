import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MORE_JOBS_UPGRADE_QUESTION, PLAN_REQUEST_ALERT_KIND, type PlanRequestSent, type PublicPlans } from "@ros/contracts";
import { adminAlerts, applications, candidates, notifications, randomToken, withTenant } from "@ros/db";
import type { FakeEmailAdapter, FakeIdentityProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAdmin, signInAs, usePlan } from "./test-helpers";

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";
const WHY = "They asked to upgrade.";

/**
 * The plans of 5 November 2026, Rule 5: the way to a bigger plan with no payment system. GET /plans lists the public
 * plans only, and when the company's open request was sent. A request about the plan is one open alert for the platform
 * administrators, with the plan asked for, why, the person's note and who asked; a second one answers with the first.
 * Change plan closes it, tells the owners and admins (and whoever asked) and shows in the customer's own history.
 */
describe("asking for a bigger plan", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let made = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const emails = () => (container.integrations.email as FakeEmailAdapter).sent;
  const askPlan = (cookie: string, body: Record<string, unknown> = { planKey: "pro" }) => json(cookie, "POST", "/api/v1/plans/request", body);
  const requestsOf = (companyId: string) => container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, PLAN_REQUEST_ALERT_KIND), eq(adminAlerts.companyId, companyId)));
  const plansOf = async (cookie: string) => read<PublicPlans>(await json(cookie, "GET", "/api/v1/plans"));
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
    return { cookie, id: co.id, name: co.name, owner: `Owner ${made}` };
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

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
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
      const { plans, requestedAt } = await read<PublicPlans>(r);
      expect(requestedAt).toBeNull();
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
      expect((await plansOf(co.cookie)).plans.filter((p) => p.current)).toEqual([]);
      await usePlan(container, co.id, "growth");
      expect((await plansOf(co.cookie)).plans.filter((p) => p.current)).toEqual([]);
    });
  });

  describe("a request about the plan", () => {
    it("is one open alert for ITS with the plan, why, the note and who asked; a second one answers with the first and raises nothing", async () => {
      const co = await newCompany();
      await openJob(co.cookie);
      const before = emails().length;
      const r = await askPlan(co.cookie, { planKey: "pro", reason: MORE_JOBS_UPGRADE_QUESTION, note: "Please call after 3pm." });
      expect(r.status).toBe(201);
      const first = await read<PlanRequestSent>(r);
      expect(first.alreadyAsked).toBe(false);
      expect(Number.isNaN(Date.parse(first.requestedAt))).toBe(false);
      const [alert] = await requestsOf(co.id);
      expect(alert).toMatchObject({ severity: "info", status: "open", target: { type: "company", id: co.id }, title: `${co.name} asked to move to the Pro plan`, body: `${co.owner} wrote: We would like to move to the Pro plan. We would like to post more jobs. Please call after 3pm.` });
      expect(alert.details).toMatchObject({ planKey: "pro", planName: "Pro", reason: MORE_JOBS_UPGRADE_QUESTION, note: "Please call after 3pm.", requestedBy: { name: co.owner } });
      // nothing of the company's hiring goes with it, and nothing is emailed
      expect(JSON.stringify(alert)).not.toContain("hygienist");
      expect(emails().length).toBe(before);

      const again = await askPlan(co.cookie, { planKey: "ultra" });
      expect(again.status).toBe(200);
      expect(await read(again)).toEqual({ requestedAt: first.requestedAt, alreadyAsked: true });
      expect(await requestsOf(co.id)).toHaveLength(1);
      expect((await requestsOf(co.id))[0].details).toMatchObject({ planKey: "pro" });
      expect((await plansOf(co.cookie)).requestedAt).toBe(first.requestedAt);
      // Home has no card about it, and it puts no hire at risk
      const brief = await read<{ summary: string; cards: Array<{ kind: string; title: string }> }>(await json(co.cookie, "GET", "/api/v1/brief"));
      expect(brief.cards.map((c) => c.title).join(" ")).not.toMatch(/plan/i);
      expect(brief.summary).toContain("· 0 at risk ·");
      // anyone on the team may ask, and gets the same answer
      const hm = await signInAs(container, app, { companyId: co.id, role: "hiring_manager" });
      expect(await read(await askPlan(hm))).toEqual({ requestedAt: first.requestedAt, alreadyAsked: true });
      expect((await app.request("/api/v1/plans/request", { method: "POST" })).status).toBe(401);
    });

    it("with no plan named asks to talk about the plan; a plan that is not public is refused", async () => {
      const co = await newCompany();
      expect((await askPlan(co.cookie, { planKey: "design_partner" })).status).toBe(400);
      expect(await requestsOf(co.id)).toEqual([]);
      expect((await askPlan(co.cookie, {})).status).toBe(201);
      const [alert] = await requestsOf(co.id);
      expect(alert).toMatchObject({ title: `${co.name} asked about its plan`, body: `${co.owner} wrote: We would like to talk about our plan.` });
    });

    it("two asked at once raise one request", async () => {
      const co = await newCompany();
      const answers = await Promise.all([askPlan(co.cookie), askPlan(co.cookie)]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 201]);
      expect(await requestsOf(co.id)).toHaveLength(1);
    });

    it("stays open while an administrator has only acknowledged it", async () => {
      const co = await newCompany();
      const { requestedAt } = await read<PlanRequestSent>(await askPlan(co.cookie));
      const [alert] = await requestsOf(co.id);
      expect((await json(admin, "POST", `/api/v1/admin/alerts/${alert.id}/acknowledge`, {})).status).toBe(200);
      expect((await plansOf(co.cookie)).requestedAt).toBe(requestedAt);
      expect(await read(await askPlan(co.cookie))).toEqual({ requestedAt, alreadyAsked: true });
    });
  });

  describe("Change plan", () => {
    it("closes the open request, tells the owners and admins and whoever asked, and shows in the customer's own history; the next request is a new one", async () => {
      const co = await newCompany();
      const adminUser = await signInAs(container, app, { companyId: co.id, role: "admin", name: "Abe Admin" });
      const hm = await signInAs(container, app, { companyId: co.id, role: "hiring_manager", name: "Hana Manager" });
      const hmId = (await read<{ user: { id: string } }>(await json(hm, "GET", "/api/v1/auth/me"))).user.id;
      expect((await askPlan(hm)).status).toBe(201);
      expect((await requestsOf(co.id))[0].body).toBe("Hana Manager wrote: We would like to move to the Pro plan.");

      await changePlan(co.id, "pro");

      const told = await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "company.plan_changed")));
      expect(told).toHaveLength(3);
      expect(told[0]).toMatchObject({ title: "Your plan is now Pro", action: { label: "See plan", href: "/setup#setup-company" } });
      expect(told[0].body).toBe("Your company is on the Pro plan now. The new limits apply at once.");
      expect(told.map((n) => n.userId)).toContain(hmId);
      expect((await requestsOf(co.id)).map((a) => a.status)).toEqual(["resolved"]);

      // the customer's history says who changed what, from what, and why
      const history = await read<Array<{ action: string; description: string; reason: string }>>(await json(adminUser, "GET", "/api/v1/companies/current/audit?actions=plan.changed"));
      expect(history.map((h) => h.description)).toEqual([`ITS moved your company to the Pro plan from Free: ${WHY}.`]);

      const plans = await plansOf(co.cookie);
      expect(plans.requestedAt).toBeNull();
      expect(plans.plans.filter((p) => p.current).map((p) => p.key)).toEqual(["pro"]);
      expect((await askPlan(co.cookie, { planKey: "ultra" })).status).toBe(201);
      expect((await requestsOf(co.id)).map((a) => a.status).sort()).toEqual(["open", "resolved"]);
    });

    it("with no request open tells the owners and admins only", async () => {
      const co = await newCompany();
      await signInAs(container, app, { companyId: co.id, role: "hiring_manager", name: "Hana Manager" });
      await changePlan(co.id, "basic");
      expect(await container.db.select().from(notifications).where(and(eq(notifications.companyId, co.id), eq(notifications.kind, "company.plan_changed")))).toHaveLength(1);
    });
  });

  describe("the console", () => {
    it("lists the plans in their order with their prices, and each customer's AI dollars, locked count and open plan request", async () => {
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
      type Row = { id: string; lockedApplicants: number; planRequestSince: string | null; aiCredit: { limitUsd: number; monthly: boolean } | null };
      const row = async () => (await read<Row[]>(await json(admin, "GET", "/api/v1/admin/customers"))).find((c) => c.id === co.id)!;
      expect(await row()).toMatchObject({ lockedApplicants: 1, planRequestSince: null, aiCredit: { limitUsd: 10, monthly: false } });
      const { requestedAt } = await read<PlanRequestSent>(await askPlan(co.cookie));
      expect((await row()).planRequestSince).toBe(requestedAt);
      // the request is among the console's alerts, with the company and what it asked for
      const alerts = await read<Array<{ kind: string; companyId: string | null; title: string }>>(await json(admin, "GET", "/api/v1/admin/alerts"));
      expect(alerts.filter((a) => a.kind === PLAN_REQUEST_ALERT_KIND && a.companyId === co.id).map((a) => a.title)).toEqual([`${co.name} asked to move to the Pro plan`]);
      await changePlan(co.id, "pro");
      expect(await row()).toMatchObject({ lockedApplicants: 0, planRequestSince: null, aiCredit: { limitUsd: 60, monthly: true } });
    });
  });
});

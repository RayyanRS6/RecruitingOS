import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { RolePacket, TRIAL_ENDED_LINE, TRIAL_PLAN_KEY, type PacketFlag, type PublishBlocker, type PublishResult } from "@ros/contracts";
import { addCalendarDays, companyToday, defaultClosingDate, entitlements } from "@ros/core";
import { companies, events, intakeSessions, rolePackets, roles, withPlatform, withTenant, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { signInAs } from "./test-helpers";

/**
 * Publishing a job (services/publish.ts): one press by a person on the team opens a draft job. Nobody else approves
 * it. The checks that hold it are the plan, the wording flags of the fairness guard and what the law of the job's
 * places asks of the ad; each refusal says why, and a refused publish changes nothing.
 */
describe("publishing a job", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let ownerId = "";
  let companyId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const publish = (cookie: string, roleId: string) => json(cookie, "POST", `/api/v1/roles/${roleId}/publish`);
  type Refusal = { error: { code: string; message: string; details?: { blockers?: PublishBlocker[] } } };

  /** A job record that passes every check in California: an on-site job in Irvine with its pay on the ad. */
  const packet = (change: (p: RolePacket) => void = () => {}): RolePacket => {
    const p = RolePacket.parse({
      identity: { title: "Dental Assistant", locations: [{ city: "Irvine", region: "CA", country: "US" }], employmentType: "full_time", schedule: "Monday to Friday, 8 to 5", remotePolicy: "onsite" },
      compensation: { basis: "hourly", currency: "USD", min: 24, max: 28, discloseRange: true },
      description: { publicJobDescription: "Harbor Dental is hiring a dental assistant in Irvine. You will seat patients, take digital x-rays and keep the operatories ready." },
      requirements: { mustHaves: [{ key: "mh_xray", text: "Radiography certificate" }], niceToHaves: [] },
      competencies: [{ key: "chairside", name: "Chairside skill", definition: "Anticipates the dentist's next step.", importance: "essential", indicators: [] }],
      screening: { questions: [{ key: "recent", question: "Tell me about your most recent dental assisting work." }, { key: "nervous", question: "Tell me about a nervous patient and what you did." }, { key: "available", question: "Which days and hours are you available?" }] },
      communication: { tone: "warm", companyBlurb: "A family practice in Irvine.", signature: "The team at Harbor Dental", disclosureText: "This message was sent with help from an AI assistant.", humanAlternativeText: "Reply to reach a person." },
      compliance: {},
      provenance: {},
    });
    change(p);
    return p;
  };

  /** A job as the builder leaves it before publishing: a draft with one version, written straight into the tables. */
  const draftJob = async (input: { packet?: RolePacket; status?: string; closesOn?: string | null; versions?: number } = {}): Promise<string> =>
    withTenant(container.db, companyId, async (tx) => {
      const p = input.packet ?? packet();
      const actor = { kind: "user" as const, id: ownerId };
      const [role] = await tx.insert(roles).values({ companyId, title: "Working title", status: input.status ?? "draft", createdBy: actor, applicationsCloseOn: input.closesOn ?? null }).returning();
      for (let v = 1; v <= (input.versions ?? 1); v++) await tx.insert(rolePackets).values({ companyId, roleId: role.id, version: v, packet: p, status: "proposed", source: "human_edit", createdBy: actor });
      return role.id;
    });
  const roleOf = async (roleId: string) => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];
  const versionsOf = (roleId: string) => container.db.select().from(rolePackets).where(eq(rolePackets.roleId, roleId)).orderBy(rolePackets.version);
  const eventsOf = async (roleId: string) => (await container.db.select().from(events).where(eq(events.companyId, companyId))).filter((e) => e.subjectId === roleId || e.subjectId.startsWith(`${roleId}:`));
  const flag = (over: Partial<PacketFlag> = {}): PacketFlag => ({ id: "f1", path: "description.publicJobDescription", rule: "age", text: "young and energetic", reason: "It can stand in for age.", ...over });

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@publish.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
    ownerId = ((await (await json(owner, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    // No limit of jobs: the cases about the plan set their own.
    await entitlements.applyPlan(container.db, companyId, "growth");
  });
  afterAll(async () => {
    await container.close();
  });

  it("opens a draft job with one press, by anyone on the team, and stamps the version with who published it", async () => {
    const roleId = await draftJob({ versions: 2 });
    const member = await signInAs(container, app, { companyId, role: "hiring_manager" });
    const memberId = ((await (await json(member, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
    const r = await publish(member, roleId);
    expect(r.status).toBe(200);
    const body = (await r.json()) as PublishResult;
    const [company] = await container.db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId));
    expect(body).toEqual({ ok: true, roleId, version: 2, urls: { careers: `https://jobs.example.test/careers/${company.slug}`, job: `https://jobs.example.test/careers/${company.slug}/jobs/${roleId}`, apply: `https://jobs.example.test/careers/${company.slug}/jobs/${roleId}/apply` } });
    const role = await roleOf(roleId);
    expect(role).toMatchObject({ status: "open", currentPacketVersion: 2, title: "Dental Assistant", applicationsCloseOn: null });
    expect(role.openedAt).toBeTruthy();
    const versions = await versionsOf(roleId);
    expect(versions.map((v) => [v.version, v.status, v.approvedBy])).toEqual([[1, "superseded", null], [2, "approved", memberId]]);
    expect(versions[1].approvedAt).toBeTruthy();
    const types = (await eventsOf(roleId)).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["role_packet.approved", "role.opened"]));
    // nobody was asked to approve anything
    expect(types.filter((t) => t.startsWith("approval."))).toEqual([]);
  });

  it("refuses a second press, and a closed job, and changes nothing", async () => {
    const roleId = await draftJob();
    expect((await publish(owner, roleId)).status).toBe(200);
    const again = await publish(owner, roleId);
    expect(again.status).toBe(409);
    expect(((await again.json()) as Refusal).error.code).toBe("already_published");
    const closed = await draftJob({ status: "closed" });
    const r = await publish(owner, closed);
    expect(r.status).toBe(409);
    expect(((await r.json()) as Refusal).error.code).toBe("role_closed");
    expect((await roleOf(closed)).status).toBe("closed");
    expect((await publish(owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("holds a job whose flagged wording nobody dealt with, and publishes it once the wording is kept with a reason", async () => {
    const open = await draftJob({ packet: packet((p) => { p.provenance.flags = [flag()]; }) });
    const r = await publish(owner, open);
    expect(r.status).toBe(409);
    const refusal = (await r.json()) as Refusal;
    expect(refusal.error.code).toBe("not_ready");
    expect(refusal.error.details?.blockers).toEqual([{ code: "open_flags", message: "One phrase in this role needs a decision first: edit it out, or keep it and say why." }]);
    expect(await roleOf(open)).toMatchObject({ status: "draft", currentPacketVersion: null, openedAt: null });
    expect((await versionsOf(open))[0]).toMatchObject({ status: "proposed", approvedBy: null });

    const kept = await draftJob({ packet: packet((p) => { p.provenance.flags = [flag({ kept: { reason: "It is the name of the programme.", by: { kind: "user", id: ownerId }, at: "2026-11-18T10:00:00.000Z" } })]; }) });
    expect((await publish(owner, kept)).status).toBe(200);
  });

  it("holds a job that lacks what the law of its place asks of the ad, one reason for each, then gives a Colorado job its closing date", async () => {
    const colorado = (change: (p: RolePacket) => void = () => {}) => packet((p) => { p.identity.locations = [{ city: "Denver", region: "CO", country: "US" }]; change(p); });
    const bare = await draftJob({ packet: colorado() });
    const r = await publish(owner, bare);
    expect(r.status).toBe(409);
    const refusal = (await r.json()) as Refusal;
    expect(refusal.error.code).toBe("not_ready");
    const blockers = refusal.error.details?.blockers ?? [];
    expect(blockers.map((b) => b.code)).toEqual(["legal_check"]);
    expect(blockers[0].message).toMatch(/asks for a short description of the benefits on the job ad\. Describe the benefits in the job's pay section, or in Settings/);
    expect((await roleOf(bare)).status).toBe("draft");

    // A closing date that has passed is one more reason: the law there asks the ad to say when applications close.
    const now = container.engine.clock();
    const [company] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const yesterday = addCalendarDays(companyToday(now, company.timezone), -1);
    const stale = await draftJob({ packet: colorado((p) => { p.compensation.benefitsSummary = "Health, dental and a 401(k)."; }), closesOn: yesterday });
    const late = (await (await publish(owner, stale)).json()) as Refusal;
    expect(late.error.details?.blockers?.map((b) => b.code)).toEqual(["legal_check"]);
    expect(late.error.details?.blockers?.[0].message).toMatch(/has passed\..*Choose a closing date today or later\./);

    const ready = await draftJob({ packet: colorado((p) => { p.compensation.benefitsSummary = "Health, dental and a 401(k)."; }) });
    expect((await publish(owner, ready)).status).toBe(200);
    const closesOn = defaultClosingDate(now, company.timezone);
    expect((await roleOf(ready)).applicationsCloseOn).toBe(closesOn);
    const set = (await eventsOf(ready)).find((e) => e.type === "role.closing_date_set");
    expect(set?.payload).toMatchObject({ closesOn, previous: null, defaulted: true });
    // the timer that stops applications at the end of that day is waiting
    const timers = await container.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.workflowKey, "role_closing_date")));
    expect(timers.filter((t) => (t.subject as { id?: string }).id === ready && (t.state as { closesOn?: string }).closesOn === closesOn)).toHaveLength(1);
  });

  it("keeps a closing date that is still ahead, and drops one that has passed where no law asks for a date", async () => {
    const now = container.engine.clock();
    const [company] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const today = companyToday(now, company.timezone);
    const ahead = await draftJob({ closesOn: addCalendarDays(today, 10) });
    expect((await publish(owner, ahead)).status).toBe(200);
    expect((await roleOf(ahead)).applicationsCloseOn).toBe(addCalendarDays(today, 10));
    expect((await eventsOf(ahead)).some((e) => e.type === "role.closing_date_set")).toBe(false);

    const passed = await draftJob({ closesOn: addCalendarDays(today, -3) });
    expect((await publish(owner, passed)).status).toBe(200);
    const role = await roleOf(passed);
    expect(role).toMatchObject({ status: "open", applicationsCloseOn: null, acceptingApplications: true });
    expect((await eventsOf(passed)).find((e) => e.type === "role.closing_date_set")?.payload).toMatchObject({ closesOn: null, previous: addCalendarDays(today, -3), defaulted: false });
  });

  it("gives the job the closing date chosen in the job builder, unless that day has passed", async () => {
    const now = container.engine.clock();
    const [company] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const today = companyToday(now, company.timezone);
    // The builder keeps the chosen date with the draft, as an event on it; the job made from the draft names the draft.
    const fromBuilder = async (closesOn: string) => {
      const roleId = await draftJob();
      await withTenant(container.db, companyId, async (tx) => {
        const actor = { kind: "user" as const, id: ownerId };
        const [session] = await tx.insert(intakeSessions).values({ companyId, roleId, status: "compiled", createdBy: actor, createdByUserId: ownerId }).returning({ id: intakeSessions.id });
        await tx.insert(events).values({ companyId, type: "role.closing_date_set", actor, subjectType: "intake_session", subjectId: session.id, payload: { closesOn, previous: null } });
      });
      return roleId;
    };
    const chosen = await fromBuilder(addCalendarDays(today, 14));
    expect((await publish(owner, chosen)).status).toBe(200);
    expect((await roleOf(chosen)).applicationsCloseOn).toBe(addCalendarDays(today, 14));
    expect((await eventsOf(chosen)).find((e) => e.type === "role.closing_date_set")?.payload).toMatchObject({ closesOn: addCalendarDays(today, 14), previous: null, from: "job_builder" });

    const stale = await fromBuilder(addCalendarDays(today, -2));
    expect((await publish(owner, stale)).status).toBe(200);
    expect((await roleOf(stale)).applicationsCloseOn).toBeNull();
    expect((await eventsOf(stale)).some((e) => e.type === "role.closing_date_set")).toBe(false);
  });

  it("refuses when the plan has no room for the job, or the trial has ended, and leaves the job a draft", async () => {
    const other = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    try {
      const app2 = createApp(other);
      const call = (cookie: string, method: string, path: string, body?: unknown) => app2.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
      const r1 = await app2.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@oneplace.test" }) });
      const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
      const cookie = (await app2.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
      const small = ((await (await call(cookie, "POST", "/api/v1/companies", { name: "One Place Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string }).id;
      const me = ((await (await call(cookie, "GET", "/api/v1/auth/me")).json()) as { user: { id: string } }).user.id;
      const job = (status: string) => withTenant(other.db, small, async (tx) => {
        const actor = { kind: "user" as const, id: me };
        const [role] = await tx.insert(roles).values({ companyId: small, title: "Dental Assistant", status, createdBy: actor, ...(status === "open" ? { openedAt: new Date().toISOString(), currentPacketVersion: 1 } : {}) }).returning();
        await tx.insert(rolePackets).values({ companyId: small, roleId: role.id, version: 1, packet: packet(), status: status === "open" ? "approved" : "proposed", source: "human_edit", createdBy: actor });
        return role.id;
      });
      // The plan a new company starts on holds one job: with one open, a second cannot be published.
      await job("open");
      const second = await job("draft");
      const full = await call(cookie, "POST", `/api/v1/roles/${second}/publish`);
      expect(full.status).toBe(402);
      expect(((await full.json()) as Refusal).error.code).toBe("limit_reached");
      expect((await other.db.select().from(roles).where(eq(roles.id, second)))[0].status).toBe("draft");

      // On the Trial plan, once its 30 days are over, nothing new is published until a plan is chosen.
      await withPlatform(other.db, async (tx) => {
        await entitlements.applyPlan(tx, small, TRIAL_PLAN_KEY, "trial");
        const [co] = await tx.select({ settings: companies.settings }).from(companies).where(eq(companies.id, small)).limit(1);
        const over = new Date(other.engine.clock().getTime() - 86_400_000).toISOString();
        await tx.update(companies).set({ settings: { ...co.settings, trial: { startedAt: new Date(Date.parse(over) - 30 * 86_400_000).toISOString(), endsAt: over, startedBy: "its_check" } } }).where(eq(companies.id, small));
      });
      const ended = await call(cookie, "POST", `/api/v1/roles/${second}/publish`);
      expect(ended.status).toBe(402);
      expect(((await ended.json()) as Refusal).error).toMatchObject({ code: "trial_ended", message: TRIAL_ENDED_LINE });
      expect((await other.db.select().from(roles).where(eq(roles.id, second)))[0].status).toBe("draft");
    } finally {
      await other.close();
    }
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { MORE_CANDIDATES_LINE, MORE_CANDIDATES_UPGRADE_QUESTION, moreAppliedTitle, type BulkActionResult, type CandidateList, type CandidatePanel, type HomeView, type IntakeStartResponse, type RoleDetail, type RoleSummary } from "@ros/contracts";
import { MORE_APPLIED_KIND } from "@ros/core";
import { applications, auditRecords, candidates, dataRequests, documents, entitlements, events, notifications, users, withPlatform, workflowRuns } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { applicationForm, plantJob, seedCompany, signInAdmin, signInAs, statusTokenFor, usePlan } from "./test-helpers";

/**
 * The wall of the plans: nobody on the team can read someone past the plan's candidates per job, by any route, as
 * anyone. The locked person here carries a unique marker in every field they can fill, and the sweep walks Hono's own
 * route table, so a route added tomorrow joins it by itself. One the sweep does not know how to fill (`FILL`) fails the
 * suite and names itself: it joins by saying what its parameters are. No team answer, from any route, may hold a marker.
 */
const M = { first: "Zqfirstmark", last: "Zqlastmark", email: "zqemailmark@people.test", phone: "4155550199", file: "zqfilemark", resume: "Zqresumemark", details: "Zqdetailsmark" };
const MARKS = Object.values(M);
const leaks = (text: string) => MARKS.filter((m) => text.toLowerCase().includes(m.toLowerCase()));

/** Routes outside the team's API, each for a reason: a candidate's own pages behind their own token, the public pages, and machines. */
const NOT_THE_TEAMS = /^\/(c|careers|privacy|files|webhooks|dev)(\/|$)|^\/(healthz|sitemap\.xml|robots\.txt)$/;

type Ids = { company: string; role: string; locked: string; lockedDoc: string; visible: string; visibleDoc: string; session: string; run: string; request: string };

/** What each parameter of each team route is filled with, by the prefix it sits under. A new route with a new parameter joins here. */
const FILL = (ids: Ids): Array<[string, Record<string, string>]> => [
  ["/api/v1/applications/:id", { id: ids.locked, documentId: ids.lockedDoc }],
  ["/api/v1/roles/:id", { id: ids.role, channel: "linkedin" }],
  ["/api/v1/intake/sessions/:id", { id: ids.session }],
  ["/api/v1/admin/customers/:id", { id: ids.company }],
  ["/api/v1/admin/runs/:id", { id: ids.run }],
  ["/api/v1/admin/data-requests/:id", { id: ids.request }],
  ["/api/v1/auth/start/:provider", { provider: "google" }],
];

/** A route with its parameters filled, or a failure that names it. */
function fillRoute(route: string, table: Array<[string, Record<string, string>]>): string {
  return route.replace(/:([A-Za-z]+)/g, (_, param: string) => {
    const value = table.find(([prefix]) => route.startsWith(prefix))?.[1][param];
    if (value === undefined) throw new Error(`The canary sweep cannot fill :${param} of ${route}. Say what it takes in FILL (apps/api/src/candidate-lock.test.ts), so this route is read for leaks too.`);
    return value;
  });
}

/** Answers that depend on a query, each of them read too: every tab of the list, and every way into the updates and the drafts. */
const QUERIES: Record<string, string[]> = {
  "/api/v1/roles/:id/applications": ["?tab=new", "?tab=shortlisted", "?tab=interviewed", "?tab=hired", "?tab=not_selected"],
  "/api/v1/notifications/history": ["?filter=unread&limit=100", "?limit=100"],
  "/api/v1/intake/sessions": ["?mine=1"],
};

describe("the team cannot read someone past the plan's limit", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let applicants = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const setLimit = (companyId: string, limit: number | null) => withPlatform(container.db, (tx) => tx.update(entitlements).set({ limit }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "candidates_per_job"))));
  type Job = { cookie: string; companyId: string; slug: string; roleId: string };
  type Person = { first: string; last: string; email: string; phone?: string; file?: string; resume?: string };
  /** Applies on the public form, as a browser does, with a resume file of their own. */
  const apply = async (job: Job, p: Person) => {
    applicants += 1;
    const fd = applicationForm({ firstName: p.first, lastName: p.last, email: p.email, ...(p.phone ? { phone: p.phone } : {}) }, null);
    fd.set("resume", new File([`${p.resume ?? ""} ${p.first} ${p.last}\nRegistered Dental Hygienist at Coastal Dental 2019 - present\nRadiography certificate\nPerio maintenance, Dentrix`], `${p.file ?? p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    const res = await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${applicants % 250}` } });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.companyId), eq(candidates.email, p.email)));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id))))[0];
  };
  /** A company whose plan reads one person per job, with one job open. */
  const companyOfOne = async (n: number): Promise<Job> => {
    const company = await seedCompany(app, { email: `owner-${n}@wall.test`, name: `Harbor Dental ${n}` });
    await usePlan(container, company.companyId, "basic");
    await setLimit(company.companyId, 1);
    return { cookie: company.owner, companyId: company.companyId, slug: company.slug, roleId: await plantJob(container, { companyId: company.companyId, title: "Dental Hygienist" }) };
  };
  const marked: Person = { first: M.first, last: M.last, email: M.email, phone: `+1 ${M.phone}`, file: M.file, resume: M.resume };

  /** The company everyone sweeps: one person the team can read, and everyone else past the limit. */
  let job: Job;
  let ids: Ids;
  let owner = "";
  let ownerId = "";
  let readers: Array<[string, string]> = [];
  let lockedRow: typeof applications.$inferSelect;
  let visibleRow: typeof applications.$inferSelect;
  let withdrew: typeof applications.$inferSelect;

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");
    job = await companyOfOne(1);
    owner = job.cookie;
    ownerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner-1@wall.test")))[0].id;
    readers = [["the owner", owner], ["an admin", await signInAs(container, app, { companyId: job.companyId, role: "admin" })], ["a hiring manager", await signInAs(container, app, { companyId: job.companyId, role: "hiring_manager" })]];
    // A draft of the owner's own, so the job builder's routes answer with something.
    const started = await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a dental assistant in Irvine, CA, on site, full time, Monday to Friday, $24 to $28 an hour. Must-haves: radiography certificate." });
    expect(started.status, await started.clone().text()).toBe(201);
    const session = (await read<IntakeStartResponse>(started)).session!.id;

    visibleRow = await apply(job, { first: "Vera", last: "Visible", email: "vera.visible@people.test" });
    expect(visibleRow.lockedAt).toBeNull();
    // Every field they can fill carries a marker.
    lockedRow = await apply(job, marked);
    expect(lockedRow.lockedAt).not.toBeNull();
    expect((await container.db.select().from(candidates).where(eq(candidates.id, lockedRow.candidateId)))[0].phone).toContain(M.phone);
    // They ask about their information from their own page: ITS has the request, with their words.
    const token = await statusTokenFor(container, { roleId: job.roleId, email: M.email });
    expect((await app.request(`/c/status/${token}/privacy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ kind: "access", details: `${M.details}: what do you hold about me?` }).toString() })).status).toBe(302);
    // Someone else past the limit, and someone past it who then withdrew.
    await apply(job, { first: "Lena", last: "Later", email: "lena.later@people.test" });
    withdrew = await apply(job, { first: "Wes", last: "Withdrew", email: "wes.withdrew@people.test" });
    expect(withdrew.lockedAt).not.toBeNull();
    expect((await app.request(`/c/status/${withdrew.statusToken}/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "yes" }).toString() })).status).toBe(302);
    await container.drain();

    const [lockedDoc] = await container.db.select().from(documents).where(eq(documents.applicationId, lockedRow.id));
    const [visibleDoc] = await container.db.select().from(documents).where(eq(documents.applicationId, visibleRow.id));
    const [run] = await container.db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, job.companyId)).limit(1);
    const [request] = await container.db.select({ id: dataRequests.id }).from(dataRequests).where(eq(dataRequests.applicationId, lockedRow.id));
    ids = { company: job.companyId, role: job.roleId, locked: lockedRow.id, lockedDoc: lockedDoc.id, visible: visibleRow.id, visibleDoc: visibleDoc.id, session, run: run.id, request: request.id };
  }, 300_000);

  afterAll(async () => {
    await container.close();
  });

  /** Every route the API has, of one method: the sweep's source, so nobody has to remember to add one. */
  const routesOf = (...methods: string[]) => [...new Set(app.routes.filter((r) => methods.includes(r.method)).map((r) => r.path))];

  /** Every GET, every way in, with the ids filled. A route it cannot fill throws, naming itself. */
  const everyGet = () => {
    const table = FILL(ids);
    const paths: string[] = [];
    for (const route of routesOf("GET")) {
      if (NOT_THE_TEAMS.test(route)) continue;
      expect(route.startsWith("/api/v1/"), `${route} is neither the team's API nor listed in NOT_THE_TEAMS. Say which it is, so it is read for leaks.`).toBe(true);
      const filled = fillRoute(route, table);
      paths.push(filled, ...(QUERIES[route] ?? []).map((q) => `${filled}${q}`));
    }
    // Reading someone the team can read must not bring anyone locked along.
    for (const route of routesOf("GET").filter((r) => r.startsWith("/api/v1/applications/:id"))) paths.push(fillRoute(route, [["/api/v1/applications/:id", { id: ids.visible, documentId: ids.visibleDoc }]]));
    return paths;
  };

  it("a route the sweep cannot fill fails and names itself", () => {
    expect(() => fillRoute("/api/v1/something-new/:widgetId", FILL(ids))).toThrow(/cannot fill :widgetId of \/api\/v1\/something-new\/:widgetId/);
    expect(() => fillRoute("/api/v1/roles/:id/brand-new/:widgetId", FILL(ids))).toThrow(/:widgetId of \/api\/v1\/roles\/:id\/brand-new\/:widgetId/);
    expect(fillRoute("/api/v1/roles/:id/share/:channel", FILL(ids))).toBe(`/api/v1/roles/${ids.role}/share/linkedin`);
  });

  it("no GET holds a marker, as the owner, an admin or a hiring manager, and the sweep read real answers", async () => {
    const found: string[] = [];
    let answered = 0;
    for (const [who, cookie] of readers) {
      for (const path of everyGet()) {
        const r = await app.request(path, { headers: { cookie, "x-admin-reason": "test", accept: "application/json" } });
        const body = await r.text();
        if (r.status === 200) answered += 1;
        const hits = leaks(`${body} ${r.headers.get("location") ?? ""} ${r.headers.get("content-disposition") ?? ""}`);
        if (hits.length) found.push(`${who}: GET ${path} holds ${hits.join(", ")}`);
        if (r.status >= 500) found.push(`${who}: GET ${path} answered ${r.status}: ${body.slice(0, 200)}`);
      }
    }
    expect(found).toEqual([]);
    // It is not a sweep of refusals: the team's routes answered with their data.
    expect(answered).toBeGreaterThan(45);
    expect(routesOf("GET").filter((r) => r.startsWith("/api/v1/")).length).toBeGreaterThan(30);
  }, 300_000);

  it("the markers would be seen: once a change of plan opens this person, the owner reads every one of them in the same routes", async () => {
    const other = await companyOfOne(2);
    await apply(other, { first: "Vera", last: "Visible", email: "vera.second@people.test" });
    const row = await apply(other, marked);
    expect(row.lockedAt).not.toBeNull();
    const [doc] = await container.db.select().from(documents).where(eq(documents.applicationId, row.id));
    expect((await json(other.cookie, "GET", `/api/v1/applications/${row.id}`)).status).toBe(402);

    const moved = await json(admin, "POST", `/api/v1/admin/customers/${other.companyId}/plan`, { planKey: "pro", reason: "They asked to upgrade." });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await read<{ unlocked: number }>(moved)).toMatchObject({ unlocked: 1 });
    await container.drain();

    const detail = await json(other.cookie, "GET", `/api/v1/applications/${row.id}`);
    expect(detail.status).toBe(200);
    const text = await detail.text();
    for (const m of [M.first, M.last, M.email, M.phone, M.file]) expect(text, m).toContain(m);
    // The file's own words.
    const file = await json(other.cookie, "GET", `/api/v1/applications/${row.id}/documents/${doc.id}/inline?as=text`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain(M.resume);
    // On the list, with nobody left behind the wall.
    const list = await read<CandidateList>(await json(other.cookie, "GET", `/api/v1/roles/${other.roleId}/applications?tab=new`));
    expect(list.rows.map((r) => r.name)).toContain(`${M.first} ${M.last}`);
    expect(list.locked).toEqual({ count: 0, cards: [] });
  }, 120_000);

  /** The same id as Postgres's uuid input also reads it, and finds the row: every way of writing it but the database's own. */
  const respelled = (id: string): Array<[string, string]> => {
    const hex = id.replace(/-/g, "");
    return [["no hyphens", hex], ["braces", `{${id}}`], ["no hyphens, in braces", `{${hex}}`], ["hyphens elsewhere", hex.replace(/(.{4})(?=.)/g, "$1-")], ["capitals", id.toUpperCase()]];
  };
  const under = (method: string) => routesOf(method).filter((r) => r.startsWith("/api/v1/applications/:id"));
  const auditsOf = async (action: string) => (await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, job.companyId), eq(auditRecords.action, action)))).length;
  const pressesOn = async (applicationId: string) => (await container.db.select().from(events).where(and(eq(events.type, "human.override"), eq(events.subjectId, applicationId)))).length;

  it("every route under /api/v1/applications/:id refuses before any handler: 402 candidate_locked, whatever the method, and nothing is written", async () => {
    const [viewedBefore, readBefore] = [await auditsOf("candidate.viewed"), await auditsOf("document.read")];
    expect(under("GET").length + under("POST").length).toBeGreaterThanOrEqual(5);
    for (const [who, cookie] of readers) {
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
        for (const route of under(method)) {
          const path = route.replace(":id", ids.locked).replace(":documentId", ids.lockedDoc);
          const r = await json(cookie, method, path, method === "GET" ? undefined : { action: "hire" });
          const body = await r.text();
          expect(r.status, `${who}: ${method} ${path} answered ${r.status}: ${body.slice(0, 200)}`).toBe(402);
          expect(JSON.parse(body).error.code).toBe("candidate_locked");
          expect(leaks(body)).toEqual([]);
        }
      }
    }
    // Refused before the handler: no `candidate.viewed`, no file opened, no action taken, and the person is where they were.
    expect(await auditsOf("candidate.viewed")).toBe(viewedBefore);
    expect(await auditsOf("document.read")).toBe(readBefore);
    expect(await pressesOn(ids.locked)).toBe(0);
    expect((await container.db.select().from(applications).where(eq(applications.id, ids.locked)))[0]).toMatchObject({ stage: lockedRow.stage, lockedAt: lockedRow.lockedAt });
    // The refusal offers the way on, with the upgrade's question, and no word about the person.
    const refusal = await read<{ error: { message: string; details: { upgrade: boolean; actions: unknown[] } } }>(await json(owner, "GET", `/api/v1/applications/${ids.locked}`));
    expect(refusal.error.message).toBe(`Locked. ${MORE_CANDIDATES_LINE}`);
    expect(refusal.error.details).toEqual({ upgrade: true, actions: [{ label: "Upgrade", method: "POST", path: "/api/v1/plans/request", body: { reason: MORE_CANDIDATES_UPGRADE_QUESTION } }] });
    // Someone who withdrew while past the limit stays behind the wall too.
    expect((await json(owner, "GET", `/api/v1/applications/${withdrew.id}`)).status).toBe(402);
    // An id that names nobody is answered as it always was; somebody the team can read opens, and their id is no way to someone else's file.
    expect((await json(owner, "GET", "/api/v1/applications/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}`)).status).toBe(200);
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}/documents/${ids.lockedDoc}/inline`)).status).toBe(404);
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}/documents/${ids.lockedDoc}/file`)).status).toBe(404);
    // Nobody signed in hears that first.
    expect((await app.request(`/api/v1/applications/${ids.locked}`)).status).toBe(401);
  }, 120_000);

  it("an id written any other way Postgres would read answers 404 before any handler, on every route under the prefix, and nothing is read or written", async () => {
    const [viewedBefore, readBefore] = [await auditsOf("candidate.viewed"), await auditsOf("document.read")];
    const refused = async (who: string, cookie: string, method: string, path: string) => {
      const r = await json(cookie, method, path, method === "GET" ? undefined : { action: "hire" });
      const body = await r.text();
      expect(r.status, `${who}: ${method} ${path} answered ${r.status}: ${body.slice(0, 200)}`).toBe(404);
      expect(JSON.parse(body).error).toMatchObject({ code: "not_found", message: "Application not found." });
      expect(leaks(body)).toEqual([]);
    };
    for (const method of ["GET", "POST"]) {
      for (const route of under(method)) {
        for (const [how, spelled] of respelled(ids.locked)) {
          for (const [who, cookie] of readers) await refused(`${who} (${how})`, cookie, method, route.replace(":id", spelled).replace(":documentId", ids.lockedDoc));
        }
      }
    }
    expect(await auditsOf("candidate.viewed")).toBe(viewedBefore);
    expect(await auditsOf("document.read")).toBe(readBefore);
    // Someone the team can read is no different: an id is written the database's way, or it names nobody.
    for (const [how, spelled] of respelled(ids.visible)) await refused(`the owner (${how})`, owner, "GET", `/api/v1/applications/${spelled}`);
    await refused("the owner", owner, "GET", "/api/v1/applications/not-an-id");
    expect((await app.request(`/api/v1/applications/${ids.locked.replace(/-/g, "")}`)).status).toBe(401);
  }, 120_000);

  it("the list: nobody locked is a row in any tab; `locked` holds where they came in and when, and nothing else; the counts cover those shown, and only the total and the locked number say more applied", async () => {
    // Two are waiting behind the wall; the one who withdrew there is in no figure.
    let list: CandidateList | null = null;
    for (const tab of ["new", "shortlisted", "interviewed", "hired", "not_selected"]) {
      list = await read<CandidateList>(await json(owner, "GET", `/api/v1/roles/${ids.role}/applications?tab=${tab}`));
      expect(list.rows.map((r) => r.id), tab).toEqual(tab === "new" ? [ids.visible] : []);
    }
    expect(list!.counts).toEqual({ total: 3, byTab: { new: 1, shortlisted: 0, interviewed: 0, hired: 0, not_selected: 0 }, locked: 2 });
    expect(list!.locked.count).toBe(2);
    for (const card of list!.locked.cards) expect(Object.keys(card).sort()).toEqual(["appliedAt", "position"]);
    expect(list!.locked.cards.map((c) => c.position)).toEqual([2, 3]);
    expect(Date.parse(list!.locked.cards[0].appliedAt)).toBe(Date.parse(lockedRow.createdAt));
    // The job, the jobs list and Home say how many, as numbers, and "to review" is of people the team can open.
    const role = await read<RoleDetail>(await json(owner, "GET", `/api/v1/roles/${ids.role}`));
    expect(role.counts).toEqual(list!.counts);
    const listed = (await read<RoleSummary[]>(await json(owner, "GET", "/api/v1/roles"))).find((r) => r.id === ids.role)!;
    expect(listed.counts).toEqual(list!.counts);
    const home = (await read<HomeView>(await json(owner, "GET", "/api/v1/home"))).jobs.find((j) => j.id === ids.role)!;
    expect(home).toMatchObject({ toReview: 1, interviewed: 0, applicants: 3 });
  });

  it("ids in a body answer like an id that is not on the job, with no name, and nothing happens to the person", async () => {
    for (const action of ["shortlist", "reject", "send_decision"]) {
      const r = await json(owner, "POST", `/api/v1/roles/${ids.role}/applications/actions`, { action, applicationIds: [ids.locked] });
      const text = await r.text();
      expect(r.status, text).toBe(200);
      expect(leaks(text)).toEqual([]);
      expect((JSON.parse(text) as BulkActionResult).results).toEqual([{ applicationId: ids.locked, name: "", ok: false, code: "not_found", message: "Application not found." }]);
    }
    // Beside someone the team can read, the refusal blocks nothing and still names nobody.
    const mixed = await read<BulkActionResult>(await json(owner, "POST", `/api/v1/roles/${ids.role}/applications/actions`, { action: "reject", applicationIds: [ids.locked, ids.visible] }));
    expect(mixed.results.map((x) => [x.name, x.ok, x.code])).toEqual([["", false, "not_found"], ["Vera Visible", true, null]]);
    expect((await json(owner, "POST", `/api/v1/applications/${ids.visible}/actions`, { action: "undo_decision" })).status).toBe(200);
    expect(await pressesOn(ids.locked)).toBe(0);
    expect((await container.db.select().from(applications).where(eq(applications.id, ids.locked)))[0]).toMatchObject({ stage: lockedRow.stage, toldState: lockedRow.toldState });
    expect((await read<CandidatePanel>(await json(owner, "GET", `/api/v1/applications/${ids.visible}`))).stage).toBe("triaged");
  });

  it("all the team hears of people applying past the limit is one neutral notice per job per day, naming nobody", async () => {
    const mine = async () => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, job.companyId), eq(notifications.kind, MORE_APPLIED_KIND), eq(notifications.userId, ownerId)))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Three people came in past the limit today: one notice.
    const today = await mine();
    expect(today).toHaveLength(1);
    expect(today[0]).toMatchObject({ title: moreAppliedTitle("Dental Hygienist"), body: MORE_CANDIDATES_LINE, action: { label: "See applicants", href: `/roles/${ids.role}/talent` } });
    // Everything written for the team about this company names nobody past the limit.
    expect(leaks(JSON.stringify(await container.db.select().from(notifications).where(eq(notifications.companyId, job.companyId))))).toEqual([]);
    expect(JSON.stringify(await container.db.select().from(notifications).where(eq(notifications.companyId, job.companyId)))).not.toMatch(/Later|Withdrew/);
    // The next day it says so again, once.
    await container.db.update(notifications).set({ createdAt: new Date(Date.now() - 25 * 3600_000).toISOString() }).where(and(eq(notifications.companyId, job.companyId), eq(notifications.kind, MORE_APPLIED_KIND)));
    await apply(job, { first: "Nia", last: "Nextday", email: "nia.nextday@people.test" });
    await apply(job, { first: "Otis", last: "Nextday", email: "otis.nextday@people.test" });
    expect(await mine()).toHaveLength(2);
    // Another job has its own notice: each job is counted apart.
    const second = { ...job, roleId: await plantJob(container, { companyId: job.companyId, title: "Front Desk" }) };
    await apply(second, { first: "Pat", last: "First", email: "pat.first@people.test" });
    expect(await mine()).toHaveLength(2);
    await apply(second, { first: "Quin", last: "Second", email: "quin.second@people.test" });
    expect((await mine()).map((n) => n.title)).toEqual([moreAppliedTitle("Dental Hygienist"), moreAppliedTitle("Dental Hygienist"), moreAppliedTitle("Front Desk")]);
  }, 120_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { detectStuckRoles } from "@ros/agents";
import { LOCKED_REQUEST_LINE, MORE_CANDIDATES_LINE, MORE_CANDIDATES_UPGRADE_QUESTION, type ClosingMessagePreview, type RecruiterRequestView } from "@ros/contracts";
import { MORE_APPLIED_KIND, anonymizeCandidate } from "@ros/core";
import { aiRuns, applications, approvalRequests, auditRecords, candidates, communications, documents, entitlements, events, interviewParticipants, interviews, notifications, plans, postings, recruiterEscalations, users, withPlatform, withTenant, workflowRuns } from "@ros/db";
import { fakePostmarkEvent, type FakeEmailAdapter, type FakeIdentityProvider } from "@ros/integrations";
import { Hono } from "hono";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { errorHandler } from "./middleware/errors";
import { sessionMiddleware, type Vars } from "./middleware/session";
import { interviewRoutes } from "./routes/interviews";
import { putOnInterview, signInAdmin, signInAs, signInStaff, usePlan } from "./test-helpers";

const HIRE = "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.";

/**
 * The wall of the plans of 5 November 2026, Rule 3: nobody on the team can read someone past the plan's candidates per job, by
 * any route, as anyone. The locked people here carry a unique marker in every field they can fill, and the sweep walks Hono's
 * own route table, so a route added tomorrow joins it by itself. One the sweep does not know how to fill (below, `FILL`) fails
 * the suite and names itself: it joins by saying what its parameters are. No team answer, from any route, may hold a marker.
 */
const M = {
  first: "Zqfirstmark",
  last: "Zqlastmark",
  email: "zqemailmark@people.test",
  phone: "4155550199",
  city: "Zqcitymark",
  file: "zqfilemark",
  resume: "Zqresumemark",
  reply: "Zqreplymark",
  inboundName: "Zqinboundmark",
  inboundAddress: "zqaddressmark@people.test",
  subject: "Zqsubjectmark",
  bounced: "Zqbouncemark",
  bouncedAddress: "zqbouncemark@people.test",
  human: "Zqhumanmark",
  approval: "Zqapprovalmark",
};
const MARKS = Object.values(M);
const leaks = (text: string) => MARKS.filter((m) => text.toLowerCase().includes(m.toLowerCase()));

/** Routes outside the team's API, each for a reason: a candidate's own pages behind their own token, the public pages, and machines. */
const NOT_THE_TEAMS = /^\/(c|careers|privacy|feeds|files|a|webhooks|dev)(\/|$)|^\/(healthz|sitemap\.xml|robots\.txt)$|^\/api\/csp-report$/;

type Ids = { company: string; role: string; locked: string; lockedDoc: string; lockedCandidate: string; visible: string; visibleDoc: string; interview: string; session: string; lockedRequest: string; roleRequest: string; run: string };

/** What each parameter of each team route is filled with, by the prefix it sits under. A new route with a new parameter joins here. */
const FILL = (ids: Ids): Array<[string, Record<string, string>]> => [
  ["/api/v1/applications/:id", { id: ids.locked, documentId: ids.lockedDoc }],
  ["/api/v1/interviews/:id", { id: ids.interview }],
  ["/api/v1/roles/:id", { id: ids.role, channel: "careers_page", kind: "missing_must_have" }],
  ["/api/v1/intake/sessions/:id", { id: ids.session }],
  ["/api/v1/escalations/:id", { id: ids.lockedRequest }],
  ["/api/v1/admin/customers/:id", { id: ids.company }],
  ["/api/v1/admin/runs/:id", { id: ids.run }],
  ["/api/v1/admin/ai-runs/:id", { id: ids.run }],
  ["/api/v1/admin/data-requests/:id", { id: ids.run }],
  ["/api/v1/auth/start/:provider", { provider: "google" }],
  ["/api/v1/integrations/calendar/:provider", { provider: "google" }],
];

/** A route with its parameters filled, or a failure that names it. */
function fillRoute(route: string, table: Array<[string, Record<string, string>]>): string {
  return route.replace(/:([A-Za-z]+)/g, (_, param: string) => {
    const value = table.find(([prefix]) => route.startsWith(prefix))?.[1][param];
    if (value === undefined) throw new Error(`The canary sweep cannot fill :${param} of ${route}. Say what it takes in FILL (apps/api/src/candidate-lock.test.ts), so this route is read for leaks too.`);
    return value;
  });
}

/** Answers that depend on a query, each of them read too: every way into a list, by every filter and order, with the locked id where one can be named. */
const QUERIES = (ids: Ids): Record<string, string[]> => ({
  "/api/v1/roles/:id/applications": ["?counts=1", "?order=name", "?order=score", "?order=waiting", "?stage=received", "?stage=talent_pool", "?ownerStage=no_ai_interview", "?group=in_process", "?told=not_told", "?counts=1&order=name"],
  "/api/v1/roles/:id/compare": [`?ids=${ids.locked}`, `?ids=${ids.locked},${ids.visible}`],
  "/api/v1/events": [`?subjectId=${ids.locked}`, `?subjectType=candidate&subjectId=${ids.lockedCandidate}`, "?type=application.received", "?type=message.bounced", "?type=message.suppressed", "?type=recruiter.requested", "?subjectType=escalation", `?subjectId=${ids.lockedRequest}`],
  "/api/v1/approvals": ["?status=pending", "?status=approved"],
  "/api/v1/interviews": ["?mine=1", "?status=scheduled"],
  "/api/v1/escalations": ["?status=open", "?status=resolved"],
  "/api/v1/admin/data-requests/lookup/candidate": [`?email=${encodeURIComponent(M.email)}&companyId=${ids.company}`],
});

describe("the team cannot read a locked person", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let admin = "";
  let made = 0;
  let applicants = 0;

  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie, "x-admin-reason": "test" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const read = async <T>(r: Response) => (await r.json()) as T;
  const newCompany = async () => {
    made += 1;
    const accessToken = (container.integrations.identity as FakeIdentityProvider).mint({ email: `owner-${made}@wall.test`, name: `Owner ${made}`, provider: "google" });
    const signedIn = await app.request("/api/v1/auth/session", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${made}` }, body: JSON.stringify({ accessToken }) });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";")[0];
    const r = await json(cookie, "POST", "/api/v1/companies", { name: `Harbor Dental ${made}`, vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status, await r.clone().text()).toBe(201);
    const co = await read<{ id: string; slug: string; name: string }>(r);
    return { cookie, id: co.id, slug: co.slug, name: co.name };
  };
  type Company = Awaited<ReturnType<typeof newCompany>>;
  const setLimit = (companyId: string, limit: number | null) => withPlatform(container.db, (tx) => tx.update(entitlements).set({ limit }).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "candidates_per_job"))));
  const openRole = async (company: Company) => {
    const s = await read<{ session: { id: string } }>(await json(company.cookie, "POST", "/api/v1/intake/sessions", { initialMessage: HIRE }));
    const compiled = await json(company.cookie, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`);
    expect(compiled.status, await compiled.clone().text()).toBe(201);
    const { roleId } = await read<{ roleId: string }>(compiled);
    expect((await json(company.cookie, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    const role = await read<{ status: string; title: string; currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } }>(await json(company.cookie, "GET", `/api/v1/roles/${roleId}`));
    expect(role.status).toBe("open");
    return { ...company, roleId, session: s.session.id, title: role.title, eligibility: role.currentPacket.packet.requirements.eligibility };
  };
  type Job = Awaited<ReturnType<typeof openRole>>;
  type Person = { first: string; last: string; email: string; phone?: string; city?: string; file?: string; resume?: string };
  const apply = async (job: Job, p: Person) => {
    applicants += 1;
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("locationText", `${p.city ?? "Irvine"}, CA`);
    if (p.phone) fd.set("phone", p.phone);
    fd.set("resume", new File([`${p.resume ?? ""} ${p.first} ${p.last}\nRegistered Dental Hygienist at Coastal Dental 2019 - present\nRDH license active\nPerio maintenance, Dentrix`], `${p.file ?? p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    for (const rule of job.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("acknowledged", "yes");
    const res = await app.request(`/careers/${job.slug}/jobs/${job.roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${applicants % 250}` } });
    expect(res.status, await res.clone().text()).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, job.id), eq(candidates.email, p.email)));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, job.roleId), eq(applications.candidateId, cand.id))))[0];
  };
  const person = (first: string, last = "Lockwood"): Person => ({ first, last, email: `${first.toLowerCase()}.${applicants}.${made}@people.test` });
  const inbound = (payload: Record<string, unknown>) => app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const reply = (row: { replyToken: string }, from: string, text: string, id: string) => inbound({ From: from, To: `reply-${row.replyToken}@${container.integrations.env.intakeDomain}`, Subject: "Re: Your application", TextBody: text, MessageID: id });
  const teamMail = (emails: readonly string[]) => (container.integrations.email as FakeEmailAdapter).sent.filter((m) => emails.includes(m.to));

  /** The company everyone sweeps: a limit of one, someone visible, and everyone else past it in every way someone can get there. */
  let job: Job;
  let ids: Ids;
  let owner = "";
  let hr = "";
  let interviewer = "";
  let recruiter = "";
  let lockedRow: typeof applications.$inferSelect;
  let visibleRow: typeof applications.$inferSelect;
  let readers: Array<[string, string]> = [];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", AUTH_PROVIDER: "fake", MESSAGE_UNDO_SECONDS: "0" } });
    app = createApp(container);
    admin = await signInAdmin(app, container, "ada.admin@identifiedtalent.com", "Ada Admin");

    const company = await newCompany();
    await setLimit(company.id, 1);
    job = await openRole(company);
    owner = company.cookie;
    hr = await signInAs(container, app, { companyId: company.id, role: "hr" });
    interviewer = await signInAs(container, app, { companyId: company.id, role: "interviewer" });

    visibleRow = await apply(job, { first: "Vera", last: "Visible", email: "vera.visible@people.test" });
    expect(visibleRow.lockedAt).toBeNull();
    // Every field they can fill carries a marker.
    lockedRow = await apply(job, { first: M.first, last: M.last, email: M.email, phone: `+1 ${M.phone}`, city: M.city, file: M.file, resume: M.resume });
    expect(lockedRow.lockedAt).not.toBeNull();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.id, lockedRow.candidateId));
    expect(cand.phone).toContain(M.phone);

    // Emailed in: `application.received` keeps the sender's address and subject, which is where their name often is.
    const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, job.roleId), eq(postings.channel, "email_in")));
    const emailed = await inbound({ From: M.inboundAddress, FromName: `${M.inboundName} Sender`, To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `${M.subject} application`, TextBody: `Please consider me. ${M.inboundName}`, Attachments: [], MessageID: "emailed-1" });
    expect(emailed.status, await emailed.clone().text()).toBe(200);
    await container.drain();

    // They write back: their words on the thread, and a request for ITS whose question names them.
    expect((await reply(lockedRow, M.email, `${M.reply}: I have a question about my application.`, "wrote-1")).status).toBe(200);
    await container.drain();

    // Someone asks for a person: another request naming them, raised by the candidate.
    const human = await apply(job, { first: M.human, last: "Lockwood", email: `${M.human.toLowerCase()}@people.test` });
    expect((await reply(human, `${M.human.toLowerCase()}@people.test`, "HUMAN", "human-1")).status).toBe(200);
    await container.drain();

    // Their email bounces: `message.bounced` and `message.suppressed` carry the address.
    const bounced = await apply(job, { first: M.bounced, last: "Lockwood", email: M.bouncedAddress });
    const [ack] = await container.db.select().from(communications).where(eq(communications.applicationId, bounced.id));
    const hard = await app.request("/webhooks/postmark/bounces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(fakePostmarkEvent({ providerMessageId: ack.providerMessageId!, email: M.bouncedAddress, type: "HardBounce" })) });
    expect(hard.status).toBe(200);
    await container.drain();
    // And the locked person's own email failed for good: Home's "emails to candidates did not arrive" and Settings' email
    // row read the failed sends (6 November 2026), so the sweep reads them with someone locked among them.
    await container.db.update(communications).set({ status: "failed", error: "postmark 422: refused" }).where(eq(communications.applicationId, lockedRow.id));

    // What a locked person cannot have by the rules, but a route must not trust: an interview, and an approval naming them.
    const [iv] = await container.db.insert(interviews).values({ companyId: job.id, applicationId: lockedRow.id, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "scheduled", startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: new Date(Date.now() + 90_000_000).toISOString(), timezone: "America/Los_Angeles" }).returning();
    const onIt = await read<{ user: { id: string } }>(await json(interviewer, "GET", "/api/v1/auth/me"));
    await container.db.insert(interviewParticipants).values({ companyId: job.id, interviewId: iv.id, userId: onIt.user.id, role: "interviewer", status: "invited" });
    await container.db.insert(approvalRequests).values({ companyId: job.id, roleId: job.roleId, applicationId: lockedRow.id, actionType: "message.send_freeform", subject: { type: "application", id: lockedRow.id }, proposal: { candidateName: `${M.approval} ${M.first}`, text: `A message to ${M.first}`, senderName: "A team member" }, rationale: `${M.approval} ${M.first} finished the AI interview.`, requestedBy: { kind: "system", id: "test" }, requiredRoles: ["owner"], createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    await putOnInterview(container, app, { cookie: interviewer, roleId: job.roleId });

    // An ITS recruiter under a grant for the role, asked for after all of them applied: its board has none of them in it.
    const roleAsk = await json(owner, "POST", "/api/v1/escalations", { kind: "review", roleId: job.roleId, question: "Please look at this role." });
    expect(roleAsk.status, await roleAsk.clone().text()).toBe(201);
    const { id: roleRequest } = await read<{ id: string }>(roleAsk);
    recruiter = await signInStaff(app, container, "rae@its.test", "its_recruiter", "Rae Recruiter");
    expect((await json(recruiter, "POST", `/api/v1/escalations/${roleRequest}/claim`)).status).toBe(200);
    expect((await json(recruiter, "POST", "/api/v1/auth/switch", { companyId: job.id })).status).toBe(200);

    // And one under a grant for all of the company's hiring: the widest there is, short of break glass, and it reads nobody locked either.
    const companyAsk = await json(owner, "POST", "/api/v1/escalations", { kind: "ask", scope: "company", question: "Please help with all of our hiring." });
    expect(companyAsk.status, await companyAsk.clone().text()).toBe(201);
    const { id: companyRequest } = await read<{ id: string }>(companyAsk);
    const wide = await signInStaff(app, container, "wes@its.test", "its_recruiter", "Wes Recruiter");
    expect((await json(wide, "POST", `/api/v1/escalations/${companyRequest}/claim`)).status).toBe(200);
    expect((await json(wide, "POST", "/api/v1/auth/switch", { companyId: job.id })).status).toBe(200);

    readers = [["the owner", owner], ["HR", hr], ["an interviewer", interviewer], ["an ITS recruiter under a grant for the role", recruiter], ["an ITS recruiter under a grant for the company", wide]];

    const [lockedDoc] = await container.db.select().from(documents).where(eq(documents.applicationId, lockedRow.id));
    const [visibleDoc] = await container.db.select().from(documents).where(eq(documents.applicationId, visibleRow.id));
    const [lockedRequest] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, lockedRow.id));
    const [run] = await container.db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, job.id)).limit(1);
    ids = { company: job.id, role: job.roleId, locked: lockedRow.id, lockedDoc: lockedDoc.id, lockedCandidate: lockedRow.candidateId, visible: visibleRow.id, visibleDoc: visibleDoc.id, interview: iv.id, session: job.session, lockedRequest: lockedRequest.id, roleRequest, run: run.id };
  }, 600_000);

  afterAll(async () => {
    await container.close();
  });

  /** Every route the team's API has, of one method: the sweep's source, so nobody has to remember to add one. */
  const routesOf = (...methods: string[]) => [...new Set(app.routes.filter((r) => methods.includes(r.method)).map((r) => r.path))];

  /** Every GET, every way in, with the ids filled. A route it cannot fill throws, naming itself. */
  const everyGet = () => {
    const table = FILL(ids);
    const extras = QUERIES(ids);
    const paths: string[] = [];
    for (const route of routesOf("GET")) {
      if (NOT_THE_TEAMS.test(route)) continue;
      expect(route.startsWith("/api/v1/"), `${route} is neither the team's API nor listed in NOT_THE_TEAMS. Say which it is, so it is read for leaks.`).toBe(true);
      const filled = fillRoute(route, table);
      paths.push(filled, ...(extras[route] ?? []).map((q) => `${filled}${q}`));
    }
    // Reading someone visible must not bring anyone locked along.
    for (const route of routesOf("GET").filter((r) => r.startsWith("/api/v1/applications/:id"))) paths.push(fillRoute(route, [["/api/v1/applications/:id", { id: ids.visible, documentId: ids.visibleDoc }]]));
    for (const kind of ["missing_must_have", "overlooked", "strongest_evidence?mustHave=rdh"]) paths.push(`/api/v1/roles/${ids.role}/questions/${kind}`);
    paths.push(`/api/v1/roles/${ids.role}/questions/compare?ids=${ids.locked},${ids.visible}`);
    // The recruiter's own request: the role's board, as it stood.
    paths.push(`/api/v1/escalations/${ids.roleRequest}`);
    return paths;
  };

  const sweep = async () => {
    const found: string[] = [];
    let read200 = 0;
    for (const [who, cookie] of readers) {
      for (const path of everyGet()) {
        const r = await app.request(path, { headers: { cookie, "x-admin-reason": "test", accept: "application/json" } });
        const body = await r.text();
        if (r.status === 200) read200 += 1;
        const hits = leaks(`${body} ${r.headers.get("location") ?? ""} ${r.headers.get("content-disposition") ?? ""}`);
        if (hits.length) found.push(`${who}: GET ${path} holds ${hits.join(", ")}`);
        if (r.status >= 500) found.push(`${who}: GET ${path} answered ${r.status}: ${body.slice(0, 200)}`);
      }
    }
    expect(found).toEqual([]);
    return read200;
  };

  it("a route the sweep cannot fill fails and names itself", () => {
    expect(() => fillRoute("/api/v1/something-new/:widgetId", FILL(ids))).toThrow(/cannot fill :widgetId of \/api\/v1\/something-new\/:widgetId/);
    expect(() => fillRoute("/api/v1/roles/:id/brand-new/:widgetId", FILL(ids))).toThrow(/:widgetId of \/api\/v1\/roles\/:id\/brand-new\/:widgetId/);
    expect(fillRoute("/api/v1/roles/:id/postings/:channel/package", FILL(ids))).toBe(`/api/v1/roles/${ids.role}/postings/careers_page/package`);
  });

  it("no GET holds a marker, as the owner, HR, an interviewer or an ITS recruiter under a grant for the role, and the sweep read real answers", async () => {
    const answered = await sweep();
    // It is not a sweep of refusals: most of the team's routes answered with their data.
    expect(answered).toBeGreaterThan(200);
    expect(routesOf("GET").filter((r) => r.startsWith("/api/v1/")).length).toBeGreaterThan(90);
  }, 600_000);

  it("the markers would be seen: under a grant naming exactly this person ITS reads every one of them, in the same routes", async () => {
    const [lockedRequest] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.id, ids.lockedRequest));
    expect(lockedRequest.question).toContain(M.first);
    const named = await signInStaff(app, container, "nia@its.test", "its_recruiter", "Nia Recruiter");
    expect((await json(named, "POST", `/api/v1/escalations/${ids.lockedRequest}/claim`)).status).toBe(200);
    expect((await json(named, "POST", "/api/v1/auth/switch", { companyId: job.id })).status).toBe(200);

    // Only as the database writes the id, even for them.
    expect((await json(named, "GET", `/api/v1/applications/${ids.locked.replace(/-/g, "")}`)).status).toBe(404);
    const detail = await json(named, "GET", `/api/v1/applications/${ids.locked}`);
    expect(detail.status).toBe(200);
    const text = await detail.text();
    for (const m of [M.first, M.last, M.email, M.phone, M.city, M.file, M.reply]) expect(text, m).toContain(m);
    // The file itself, and the words in it.
    const file = await json(named, "GET", `/api/v1/applications/${ids.locked}/documents/${ids.lockedDoc}/inline`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain(M.resume);
    // On the lists, that one person and nobody else.
    const list = await read<{ applications: Array<{ id: string }>; counts: { total: number }; locked: { count: number; cards: unknown[] } }>(await json(named, "GET", `/api/v1/roles/${ids.role}/applications?counts=1`));
    expect(list.applications.map((a) => a.id)).toEqual([ids.locked]);
    expect(list.locked).toEqual({ count: 0, cards: [] });
    expect(list.counts.total).toBe(1);
    // The volume says that one person, by source too: the grant may read them.
    expect(await read(await json(named, "GET", `/api/v1/roles/${ids.role}/volume`))).toMatchObject({ totals: { total: 1, bySource: { [lockedRow.source]: 1 } } });
    expect(JSON.stringify(await read(await json(named, "GET", `/api/v1/events?subjectId=${ids.locked}`)))).toContain("application.received");
    // Their call notes go through, as the recruiter's own note: nothing is scored while they are locked.
    const notes = await json(named, "POST", `/api/v1/applications/${ids.locked}/screen/recruiter-notes`, { notes: [{ text: "We talked." }], complete: false });
    expect(notes.status).toBe(200);
    expect(await read(notes)).toMatchObject({ completed: false, keptAsNote: true });
    // In the queue, with the warning: words cannot be checked by a machine.
    const queue = await read<{ accessGranted: boolean; lockedForCompany: boolean; contextSnapshot: { candidate: { name: string } }; question: string }>(await json(named, "GET", `/api/v1/escalations/${ids.lockedRequest}`));
    expect(queue).toMatchObject({ accessGranted: true, lockedForCompany: true });
    expect(queue.contextSnapshot.candidate.name).toContain(M.first);
    expect(queue.question).toContain(M.first);
    // The grant reads this person, and nobody else who is locked.
    const [other] = await container.db.select({ id: applications.id }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(eq(candidates.firstName, M.bounced));
    expect((await json(named, "GET", `/api/v1/applications/${other.id}`)).status).toBe(402);

    // Hand it back, so the sweep's other readers are not affected.
    expect((await json(named, "POST", `/api/v1/escalations/${ids.lockedRequest}/release`)).status).toBe(200);
  }, 120_000);

  it("every route under the two prefixes refuses before any handler: 402 candidate_locked, whatever the method, and nothing is written", async () => {
    const viewedBefore = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "candidate.viewed"))).filter((r) => r.target?.id === ids.locked).length;
    const readBefore = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.read"))).length;
    for (const [who, cookie] of readers) {
      for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
        for (const route of routesOf(method).filter((r) => r.startsWith("/api/v1/applications/:id") || r.startsWith("/api/v1/interviews/:id"))) {
          const path = route.replace(":id", route.startsWith("/api/v1/interviews") ? ids.interview : ids.locked).replace(":documentId", ids.lockedDoc).replace(/:[A-Za-z]+/g, "00000000-0000-0000-0000-000000000000");
          const r = await json(cookie, method, path, method === "GET" ? undefined : {});
          const body = await r.text();
          expect(r.status, `${who}: ${method} ${path} answered ${r.status}: ${body.slice(0, 200)}`).toBe(402);
          expect(JSON.parse(body).error.code).toBe("candidate_locked");
          expect(leaks(body)).toEqual([]);
        }
      }
    }
    // Refused before the handler: no `candidate.viewed`, and no signed link was ever minted for the file.
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "candidate.viewed"))).filter((r) => r.target?.id === ids.locked).length).toBe(viewedBefore);
    expect((await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.read"))).length).toBe(readBefore);
    // The refusal offers the owner the way on, with the upgrade's question; an ITS recruiter is not offered a company's plan.
    const asOwner = await read<{ error: { message: string; details: { upgrade: boolean; actions: Array<{ label: string; path: string; body: { topic: string; question: string; scope: string } }> } } }>(await json(owner, "GET", `/api/v1/applications/${ids.locked}`));
    expect(asOwner.error.message).toBe(`Locked. ${MORE_CANDIDATES_LINE}`);
    expect(asOwner.error.details.upgrade).toBe(true);
    expect(asOwner.error.details.actions[0]).toMatchObject({ label: "Upgrade", path: "/api/v1/escalations", body: { topic: "plan", scope: "company", question: MORE_CANDIDATES_UPGRADE_QUESTION } });
    const asRecruiter = await read<{ error: { details: { upgrade: boolean; actions: unknown[] } } }>(await json(recruiter, "GET", `/api/v1/applications/${ids.locked}`));
    expect(asRecruiter.error.details).toEqual({ upgrade: false, actions: [] });
    // A malformed id or someone else's company names nobody: the handler answers as it always did.
    expect((await json(owner, "GET", "/api/v1/applications/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    // Somebody visible opens as usual, and their id is no way to someone else's file.
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}`)).status).toBe(200);
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}/documents/${ids.lockedDoc}/inline`)).status).toBe(404);
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}/documents/${ids.lockedDoc}/file`)).status).toBe(404);
  }, 300_000);

  it("setting a date and time, with a real time and a real body: both routes refuse someone locked before any handler, and nothing is booked, sent or said", async () => {
    // both are in the sweep above, by the route table: this is the same refusal with a body that would book
    expect(routesOf("POST")).toEqual(expect.arrayContaining(["/api/v1/applications/:id/interviews", "/api/v1/interviews/:id/set-time"]));
    const setTime = { date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), time: "14:00", durationMinutes: 30, place: { kind: "phone" } };
    const me = await read<{ user: { id: string } }>(await json(owner, "GET", "/api/v1/auth/me"));
    const [before] = await container.db.select().from(interviews).where(eq(interviews.id, ids.interview));
    const lockedInterviews = await container.db.select().from(interviews).where(eq(interviews.applicationId, ids.locked));
    await container.drain();
    const mail = (container.integrations.email as FakeEmailAdapter).sent.length;
    for (const [who, cookie] of readers) {
      for (const [path, body] of [[`/api/v1/applications/${ids.locked}/interviews`, { roundKey: "r1", interviewerUserIds: [me.user.id], setTime }], [`/api/v1/interviews/${ids.interview}/set-time`, setTime]] as const) {
        const r = await json(cookie, "POST", path, body);
        const text = await r.text();
        expect(r.status, `${who}: ${path} answered ${r.status}: ${text.slice(0, 200)}`).toBe(402);
        expect(JSON.parse(text).error.code).toBe("candidate_locked");
        expect(leaks(text)).toEqual([]);
      }
    }
    await container.drain();
    const [after] = await container.db.select().from(interviews).where(eq(interviews.id, ids.interview));
    expect(after).toMatchObject({ status: before.status, attempt: before.attempt, startsAt: before.startsAt });
    expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, ids.locked))).toHaveLength(lockedInterviews.length);
    expect((container.integrations.email as FakeEmailAdapter).sent.length).toBe(mail);
  }, 120_000);
  /** The same id as Postgres's uuid input also reads it, and finds the row: every way of writing it but the database's own. */
  const respelled = (id: string): Array<[string, string]> => {
    const hex = id.replace(/-/g, "");
    return [["no hyphens", hex], ["braces", `{${id}}`], ["no hyphens, in braces", `{${hex}}`], ["hyphens elsewhere", hex.replace(/(.{4})(?=.)/g, "$1-")], ["capitals", id.toUpperCase()]];
  };

  it("an id written any other way Postgres would read answers 404 before any handler, for everyone, on every route under the two prefixes, and nothing is read or written", async () => {
    const viewed = async () => (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "candidate.viewed"))).length;
    const opened = async () => (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "document.read"))).length;
    const [viewedBefore, openedBefore] = [await viewed(), await opened()];
    const refused = async (who: string, cookie: string, method: string, path: string, words: string) => {
      const r = await json(cookie, method, path, method === "GET" ? undefined : {});
      const body = await r.text();
      expect(r.status, `${who}: ${method} ${path} answered ${r.status}: ${body.slice(0, 200)}`).toBe(404);
      expect(JSON.parse(body).error).toMatchObject({ code: "not_found", message: words });
      expect(leaks(body)).toEqual([]);
    };
    // Everyone who reads the team's lists: the record, the file and the interview, which each answered with the person before.
    for (const [who, cookie] of readers) {
      for (const [how, spelled] of respelled(ids.locked)) {
        for (const path of [`/api/v1/applications/${spelled}`, `/api/v1/applications/${spelled}/documents/${ids.lockedDoc}/inline`, `/api/v1/applications/${spelled}/documents/${ids.lockedDoc}/file`]) await refused(`${who} (${how})`, cookie, "GET", path, "Application not found.");
      }
      for (const [how, spelled] of respelled(ids.interview)) await refused(`${who} (${how})`, cookie, "GET", `/api/v1/interviews/${spelled}`, "Interview not found.");
    }
    // Every route under the two prefixes, whatever the method: the guard does not know which handler would have answered.
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
      for (const route of routesOf(method).filter((r) => r.startsWith("/api/v1/applications/:id") || r.startsWith("/api/v1/interviews/:id"))) {
        const interview = route.startsWith("/api/v1/interviews");
        for (const [how, spelled] of respelled(interview ? ids.interview : ids.locked)) {
          const path = route.replace(":id", spelled).replace(":documentId", ids.lockedDoc).replace(/:[A-Za-z]+/g, "00000000-0000-0000-0000-000000000000");
          await refused(`the owner (${how})`, owner, method, path, interview ? "Interview not found." : "Application not found.");
        }
      }
    }
    expect(await viewed()).toBe(viewedBefore);
    expect(await opened()).toBe(openedBefore);
    // Someone visible is no different: an id is written the database's way, or it names nobody. Written that way they open as usual.
    for (const [how, spelled] of respelled(ids.visible)) await refused(`the owner (${how})`, owner, "GET", `/api/v1/applications/${spelled}`, "Application not found.");
    expect((await json(owner, "GET", `/api/v1/applications/${ids.visible}`)).status).toBe(200);
    // Something that is no id at all answers the same, not a database error.
    await refused("the owner", owner, "GET", "/api/v1/applications/not-an-id", "Application not found.");
    await refused("the owner", owner, "GET", "/api/v1/interviews/not-an-id", "Interview not found.");
    // Nobody signed in still hears that first.
    expect((await app.request(`/api/v1/applications/${ids.locked.replace(/-/g, "")}`)).status).toBe(401);
  }, 300_000);

  it("the interview scope guard refuses another spelling itself, with no help from the guard at the prefix", async () => {
    const bare = new Hono<Vars>();
    bare.onError(errorHandler);
    bare.use("*", sessionMiddleware(container));
    bare.route("/api/v1/interviews", interviewRoutes);
    const open = (id: string) => bare.request(`/api/v1/interviews/${id}`, { headers: { cookie: recruiter } });
    // The canonical id reaches the handler here, so the refusals below are the guard's and nothing else's.
    expect((await open(ids.interview)).status).toBe(200);
    for (const [how, spelled] of respelled(ids.interview)) expect((await open(spelled)).status, how).toBe(404);
  }, 60_000);

  it("an interviewer cannot read a job they do not interview for by writing its id another way", async () => {
    const company = await newCompany();
    await usePlan(container, company.id, "ultra");
    const theirs = await openRole(company);
    const other = await openRole(company);
    const onIt = await signInAs(container, app, { companyId: company.id, role: "interviewer" });
    await putOnInterview(container, app, { cookie: onIt, roleId: theirs.roleId });
    expect((await json(onIt, "GET", `/api/v1/roles/${theirs.roleId}`)).status).toBe(200);
    expect((await json(onIt, "GET", `/api/v1/roles/${other.roleId}`)).status).toBe(404);
    for (const [how, spelled] of respelled(other.roleId)) {
      for (const path of [`/api/v1/roles/${spelled}`, `/api/v1/roles/${spelled}/packets`, `/api/v1/roles/${spelled}/interviews`]) {
        const r = await json(onIt, "GET", path);
        expect(r.status, `${how}: GET ${path}`).toBe(404);
        expect((await read<{ error: { message: string } }>(r)).error.message).toBe("Role not found.");
      }
    }
    // Their own job, written another way, is not looked up either: the same answer for every id not written the database's way.
    expect((await json(onIt, "GET", `/api/v1/roles/${theirs.roleId.replace(/-/g, "")}`)).status).toBe(404);
  }, 300_000);

  it("Settings' recruiter access says a grant covers one candidate and leaves out which, for someone the reader cannot read", async () => {
    const company = await newCompany();
    await setLimit(company.id, 1);
    const j = await openRole(company);
    const seen = await apply(j, person("Sia", "Open"));
    const email = "zqgrantmark@people.test";
    const hidden = await apply(j, { first: "Zqgrantfirst", last: "Zqgrantlast", email });
    expect((await reply(hidden, email, "HUMAN", "grant-human")).status).toBe(200);
    await container.drain();
    const about = await json(company.cookie, "POST", "/api/v1/escalations", { kind: "review", applicationId: seen.id, question: "Please look at this person." });
    expect(about.status, await about.clone().text()).toBe(201);
    const [lockedAsk] = await container.db.select().from(recruiterEscalations).where(eq(recruiterEscalations.applicationId, hidden.id));
    const staffOnHidden = await signInStaff(app, container, "hope@its.test", "its_recruiter", "Hope Recruiter");
    const staffOnSeen = await signInStaff(app, container, "seth@its.test", "its_recruiter", "Seth Recruiter");
    expect((await json(staffOnHidden, "POST", `/api/v1/escalations/${lockedAsk.id}/claim`)).status).toBe(200);
    expect((await json(staffOnSeen, "POST", `/api/v1/escalations/${(await read<{ id: string }>(about)).id}/claim`)).status).toBe(200);

    type Row = { recruiterEmail: string; applicationId: string | null; oneCandidate: boolean };
    const listed = await json(company.cookie, "GET", "/api/v1/companies/current/staff-access");
    const text = await listed.text();
    expect(listed.status, text).toBe(200);
    expect(text).not.toContain(hidden.id);
    const rows = JSON.parse(text) as Row[];
    expect(rows.find((g) => g.recruiterEmail === "hope@its.test")).toMatchObject({ applicationId: null, oneCandidate: true });
    expect(rows.find((g) => g.recruiterEmail === "seth@its.test")).toMatchObject({ applicationId: seen.id, oneCandidate: true });
    // The recruiter under that grant may read that person, so their own list may say who it is.
    expect((await json(staffOnHidden, "POST", "/api/v1/auth/switch", { companyId: company.id })).status).toBe(200);
    const own = await read<Row[]>(await json(staffOnHidden, "GET", "/api/v1/companies/current/staff-access"));
    expect(own.find((g) => g.recruiterEmail === "hope@its.test")?.applicationId).toBe(hidden.id);
  }, 300_000);

  it("the list: nobody locked is a row, whatever the order or the filter; `locked` holds where they came in and when, and nothing else; counts cover those shown, and only the total says more applied", async () => {
    const lockedCount = (await container.db.select().from(applications).where(and(eq(applications.roleId, ids.role), sql`${applications.lockedAt} is not null`))).length;
    expect(lockedCount).toBeGreaterThanOrEqual(4);
    for (const q of ["", "?order=name", "?order=score", "?order=waiting", "?stage=received", "?stage=applied", "?group=in_process", "?ownerStage=no_ai_interview"]) {
      const rows = await read<Array<{ id: string }>>(await json(owner, "GET", `/api/v1/roles/${ids.role}/applications${q}`));
      expect(rows.map((r) => r.id).filter((id) => id !== ids.visible), q).toEqual([]);
    }
    const list = await read<{ applications: Array<{ id: string }>; counts: { total: number; byOwnerStage: Record<string, number>; byGroup: Record<string, number> }; locked: { count: number; cards: Array<Record<string, unknown>> } }>(await json(owner, "GET", `/api/v1/roles/${ids.role}/applications?counts=1`));
    expect(list.applications.map((a) => a.id)).toEqual([ids.visible]);
    expect(list.locked.count).toBe(lockedCount);
    expect(list.locked.cards).toHaveLength(lockedCount);
    for (const card of list.locked.cards) expect(Object.keys(card).sort()).toEqual(["appliedAt", "position"]);
    expect(list.locked.cards.map((c) => c.position)).toEqual(Array.from({ length: lockedCount }, (_, i) => i + 2));
    expect(Date.parse(String(list.locked.cards[0].appliedAt))).toBeGreaterThan(0);
    expect(list.counts.total).toBe(1 + lockedCount);
    expect(Object.values(list.counts.byOwnerStage).reduce((a, b) => a + b, 0)).toBe(1);
    expect(Object.values(list.counts.byGroup).reduce((a, b) => a + b, 0)).toBe(1);
    // The plain answer is the rows, with nothing beside them.
    expect(Array.isArray(await read(await json(owner, "GET", `/api/v1/roles/${ids.role}/applications`)))).toBe(true);

    // The role and the jobs list say how many, as a number, beside stages that cover those shown.
    const role = await read<{ counts: Record<string, number>; lockedCount: number; pendingApprovals: unknown[] }>(await json(owner, "GET", `/api/v1/roles/${ids.role}`));
    expect(role.lockedCount).toBe(lockedCount);
    expect(Object.values(role.counts).reduce((a, b) => a + b, 0)).toBe(1);
    expect(role.pendingApprovals).toEqual([]);
    const jobs = await read<Array<{ id: string; counts: Record<string, number> & { total: number }; lockedCount: number; needsYou: number }>>(await json(owner, "GET", "/api/v1/roles"));
    const row = jobs.find((j) => j.id === ids.role)!;
    expect(row).toMatchObject({ lockedCount, needsYou: 0 });
    expect(row.counts.total).toBe(1 + lockedCount);
    expect(Object.entries(row.counts).filter(([k]) => k !== "total").reduce((n, [, v]) => n + v, 0)).toBe(1);

    // The board, and everything that goes through its one line.
    const board = await read<{ lockedCount: number; columns: Record<string, Array<{ applicationId: string }>>; noAiInterview: Array<{ applicationId: string }>; summary: { total: number } }>(await json(owner, "GET", `/api/v1/roles/${ids.role}/board`));
    expect(board.lockedCount).toBe(lockedCount);
    const onBoard = [...Object.values(board.columns).flat(), ...board.noAiInterview].map((c) => c.applicationId);
    expect(onBoard).not.toContain(ids.locked);
    expect(board.summary.total).toBeLessThanOrEqual(1);

    // The report covers those shown, and says how many it does not.
    const report = await read<{ applicants: { total: number; locked: number }; pendingDecisions: { list: Array<{ applicationId: string | null }>; approvals: number }; escalations: { total: number } }>(await json(owner, "GET", `/api/v1/roles/${ids.role}/report`));
    expect(report.applicants).toMatchObject({ total: 1, locked: lockedCount });
    expect(report.pendingDecisions.list.map((p) => p.applicationId)).not.toContain(ids.locked);
    expect(report.pendingDecisions.approvals).toBe(0);
    expect(report.escalations.total).toBe(1);
    const csv = await (await json(owner, "GET", `/api/v1/roles/${ids.role}/report/summary.csv`)).text();
    expect(csv).toContain(`Applicants,Locked,${lockedCount}`);
    const applicantsCsv = await (await json(owner, "GET", `/api/v1/roles/${ids.role}/report.csv`)).text();
    expect(applicantsCsv).toContain("Vera Visible");
    expect(applicantsCsv.trim().split("\r\n")).toHaveLength(2);
    // The share tab's volume keeps everyone an upgrade could open in each day's total: a count names nobody, and it shows demand.
    // Where they came from is only for people the team can read: a locked card says when, so a day's sources would say how.
    type Volume = { totals: { total: number; bySource: Record<string, number> }; days: Array<{ total: number; bySource: Record<string, number> }>; sources: Array<{ total: number }>; today: { total: number } };
    const sum = (bySource: Record<string, number>) => Object.values(bySource).reduce((a, b) => a + b, 0);
    const volume = await read<Volume>(await json(owner, "GET", `/api/v1/roles/${ids.role}/volume`));
    expect(volume.totals.total).toBe(1 + lockedCount);
    expect(volume.today.total).toBe(1 + lockedCount);
    expect(volume.days.at(-1)?.total).toBe(1 + lockedCount);
    expect(sum(volume.totals.bySource)).toBe(1);
    expect(sum(volume.days.at(-1)!.bySource)).toBe(1);
    expect(volume.sources.reduce((n, s) => n + s.total, 0)).toBe(1);
    // None of them came by email as far as this reader can tell, though one did: the only source left is the visible person's.
    expect(volume.totals.bySource.email_in).toBeUndefined();
  }, 120_000);

  it("ids in a body or a query answer like an id that is not in the role, and nothing happens to the person", async () => {
    const before = (await container.db.select().from(applications).where(eq(applications.id, ids.locked)))[0];
    // Compare: skipped, and no `candidate.viewed`.
    const viewed = async () => (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "candidate.viewed"))).filter((r) => r.target?.id === ids.locked).length;
    const viewedBefore = await viewed();
    const compared = await read<{ candidates: Array<{ applicationId: string }> }>(await json(owner, "GET", `/api/v1/roles/${ids.role}/compare?ids=${ids.locked},${ids.visible}`));
    expect(compared.candidates.map((c) => c.applicationId)).toEqual([ids.visible]);
    const asked = await read<{ people: Array<{ applicationId: string }>; applicationIds: string[] }>(await json(owner, "GET", `/api/v1/roles/${ids.role}/questions/compare?ids=${ids.locked}`));
    expect(asked.applicationIds).toEqual([]);
    expect(await viewed()).toBe(viewedBefore);

    // Review and apply: "not a candidate of this role", named "Unknown", dry run and real.
    const dry = await read<{ items: Array<{ name: string; allowed: boolean; refusedReason: string; score: unknown }> }>(await json(owner, "POST", `/api/v1/roles/${ids.role}/batch`, { dryRun: true, items: [{ applicationId: ids.locked, action: "shortlist" }] }));
    expect(dry.items[0]).toMatchObject({ name: "Unknown", allowed: false, refusedReason: "Not a candidate of this role.", score: null });
    for (const item of [{ action: "not_moving_forward", reason: "position_filled" }, { action: "escalate" }, { action: "shortlist" }]) {
      const real = await json(owner, "POST", `/api/v1/roles/${ids.role}/batch`, { dryRun: false, items: [{ applicationId: ids.locked, ...item }] });
      const realText = await real.text();
      expect(real.status, realText).toBe(200);
      expect(leaks(realText)).toEqual([]);
      expect(JSON.parse(realText).results).toMatchObject([{ applicationId: ids.locked, ok: false, name: "Unknown", code: "not_allowed", message: "Not a candidate of this role." }]);
    }

    // The decision message to many, and new times to many.
    const told = await read<{ results: Array<{ applicationId: string; ok: boolean; code: string }> }>(await json(owner, "POST", `/api/v1/roles/${ids.role}/decision-messages`, { applicationIds: [ids.locked] }));
    expect(told.results).toEqual([{ applicationId: ids.locked, ok: false, code: "not_found", message: "Not a candidate of this role." }]);
    const times = await json(owner, "POST", `/api/v1/roles/${ids.role}/new-times`, { applicationIds: [ids.locked] });
    const timesText = await times.text();
    expect(leaks(timesText)).toEqual([]);
    expect(JSON.parse(timesText).results[0]).toEqual({ applicationId: ids.locked, name: "This candidate", ok: false, code: "not_found", message: "Application not found." });
    // The body's check lets an id in capitals through, and it is the same person.
    const inCapitals = await read<{ results: Array<{ code: string }> }>(await json(owner, "POST", `/api/v1/roles/${ids.role}/new-times`, { applicationIds: [ids.locked.toUpperCase()] }));
    expect(inCapitals.results[0]).toMatchObject({ code: "not_found" });

    // Bringing in a recruiter on them is refused; on the role it goes on as ever.
    const asked2 = await json(owner, "POST", "/api/v1/escalations", { kind: "review", applicationId: ids.locked, question: "Who is this?" });
    expect(asked2.status).toBe(402);
    expect((await read<{ error: { code: string } }>(asked2)).error.code).toBe("candidate_locked");

    // Deciding an approval about them: the id in the path is the approval's, so no path guard saw it.
    const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.applicationId, ids.locked));
    const decided = await json(owner, "POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approve" });
    expect(decided.status).toBe(402);
    expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, req.id)))[0].status).toBe("pending");
    // ... and it is on nobody's list, with its name.
    const list = await read<Array<{ id: string }>>(await json(owner, "GET", "/api/v1/approvals"));
    expect(list.map((r) => r.id)).not.toContain(req.id);

    // Nothing moved.
    const after = (await container.db.select().from(applications).where(eq(applications.id, ids.locked)))[0];
    expect(after.stage).toBe(before.stage);
    expect(after.toldState).toBe(before.toldState);
  }, 120_000);

  it("a request about someone locked keeps only that it exists: no name, no id, no question, no answer and no thread, and the team can add nothing to it", async () => {
    const mine = await read<RecruiterRequestView[]>(await json(owner, "GET", "/api/v1/escalations/mine"));
    const masked = mine.filter((r) => r.locked);
    expect(masked.length).toBeGreaterThanOrEqual(2);
    for (const r of masked) {
      expect(r).toMatchObject({ question: LOCKED_REQUEST_LINE, applicationId: null, candidateName: null, resolution: null, thread: [], reopenedCount: 0, scope: "application", locked: true });
      expect(r.roleTitle).toBe(job.title);
      expect(leaks(JSON.stringify(r))).toEqual([]);
    }
    // ... and the owner's own request about the role is as it was.
    const own = mine.find((r) => r.id === ids.roleRequest)!;
    expect(own.question).toBe("Please look at this role.");
    expect(own.locked).toBeUndefined();
    expect(own.thread.length).toBeGreaterThan(0);

    const added = await json(owner, "POST", `/api/v1/escalations/mine/${masked[0].id}/messages`, { body: "Who is this person?" });
    expect(added.status).toBe(402);
    const reopened = await json(owner, "POST", `/api/v1/escalations/mine/${masked[0].id}/reopen`, { note: "Please reopen this." });
    expect(reopened.status).toBe(402);

    // ITS's answer stays with ITS: on the thread, and in no notice.
    const staff = await signInStaff(app, container, "kit@its.test", "its_recruiter", "Kit Recruiter");
    expect((await json(staff, "POST", `/api/v1/escalations/${ids.lockedRequest}/claim`)).status).toBe(200);
    expect((await json(staff, "POST", `/api/v1/escalations/${ids.lockedRequest}/messages`, { body: `Spoke with ${M.first} today.` })).status).toBe(201);
    expect((await json(staff, "POST", `/api/v1/escalations/${ids.lockedRequest}/resolve`, { resolution: `${M.first} is all set.` })).status).toBe(200);
    await container.drain();
    const answered = (await read<RecruiterRequestView[]>(await json(owner, "GET", "/api/v1/escalations/mine"))).find((r) => r.id === ids.lockedRequest)!;
    expect(answered).toMatchObject({ status: "resolved", resolution: null, thread: [], locked: true });
    expect(leaks(JSON.stringify(await read(await json(owner, "GET", "/api/v1/events?type=recruiter.resolved"))))).toEqual([]);
    expect(leaks(JSON.stringify(await read(await json(owner, "GET", "/api/v1/notifications"))))).toEqual([]);
  }, 120_000);

  it("the owner's Home and the job builder's conversation read from the same place: visible people, and one neutral card", async () => {
    const brief = await read<{ cards: Array<{ kind: string; title: string; body: string; actions: Array<{ label: string; path: string; body?: { question?: string } }> }>; summary: string }>(await json(owner, "GET", "/api/v1/brief"));
    expect(leaks(JSON.stringify(brief))).toEqual([]);
    // The people it counts are the ones it can say something true about.
    expect(brief.cards.map((c) => c.title)).toContain(`1 person applied to ${job.title} since yesterday`);
    const card = brief.cards.find((c) => c.title === `More people applied to ${job.title}.`)!;
    expect(card).toMatchObject({ kind: "new_applicants", body: MORE_CANDIDATES_LINE });
    expect(card.actions[0]).toMatchObject({ label: "Upgrade", path: "/api/v1/escalations", body: { question: MORE_CANDIDATES_UPGRADE_QUESTION } });
    // A person who may not draft gets the brief through the conversation route (the critic's second way to it).
    const answer = await json(hr, "POST", "/api/v1/intake/conversation/messages", { message: "What is going on?" });
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(leaks(text)).toEqual([]);
    expect(text).toContain(`More people applied to ${job.title}.`);
    // An interviewer's Home is their own interviews, and not this one.
    const theirs = await read<{ cards: Array<{ body: string }>; summary: string }>(await json(interviewer, "GET", "/api/v1/brief"));
    expect(leaks(JSON.stringify(theirs))).toEqual([]);
    expect(theirs.summary).not.toMatch(/^1 interview coming up/);
    // No ITS recruiter is offered a company's plan.
    const staffHome = await read<{ cards: Array<{ title: string }> }>(await json(recruiter, "GET", "/api/v1/brief"));
    expect(staffHome.cards.map((c) => c.title)).not.toContain(`More people applied to ${job.title}.`);
  }, 120_000);

  it("the stuck-role check the daily job runs names nobody locked, even over an approval left waiting about them", async () => {
    const found = await withTenant(container.db, job.id, (tx) => detectStuckRoles(tx, job.id, new Date()));
    expect(leaks(JSON.stringify(found))).toEqual([]);
    expect(found.map((d) => d.detector)).not.toContain("approval_pending");
  });

  it("no notice, and no email to the team, holds a marker", async () => {
    const rows = await container.db.select().from(notifications).where(eq(notifications.companyId, job.id));
    const hits = rows.filter((n) => leaks(`${n.title} ${n.body} ${JSON.stringify(n.action)}`).length);
    expect(hits.map((n) => `${n.kind}: ${n.title}`)).toEqual([]);
    const team = await container.db.select({ email: users.email }).from(users).where(sql`${users.id} in (select user_id from memberships where company_id = ${job.id})`);
    const mail = teamMail(team.map((u) => u.email));
    expect(mail.flatMap((m) => leaks(`${m.subject} ${m.text} ${m.html ?? ""}`))).toEqual([]);
  });

  it("a hire and a close: backups, the hire sheet and the closing message name nobody locked; they still hear, once, and their row in the close answer is a count", async () => {
    // Someone locked at a stage where the hire sheet would name them as a backup.
    await container.db.update(applications).set({ stage: "finalist" }).where(eq(applications.id, ids.locked));
    await container.db.update(applications).set({ stage: "interview_complete" }).where(eq(applications.id, ids.visible));
    const hired = await json(owner, "POST", `/api/v1/applications/${ids.visible}/outcome`, { outcome: "hired_externally", confirm: true, hireDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), offerAcceptedAt: new Date().toISOString().slice(0, 10) });
    const hiredText = await hired.text();
    expect(hired.status, hiredText).toBe(201);
    expect(leaks(hiredText)).toEqual([]);
    const { hire } = JSON.parse(hiredText) as { hire: { backups: { count: number; people: unknown[]; locked?: number }; closeRole: { stillInProcess: number } } };
    expect(hire.backups).toMatchObject({ count: 0, people: [] });
    // that more applied is a number, for "and N more you cannot see yet", and nothing else about them
    expect(hire.backups.locked).toBeGreaterThan(0);
    expect(hire.closeRole.stillInProcess).toBe(0);
    await container.db.update(applications).set({ stage: "received" }).where(eq(applications.id, ids.locked));

    const closed = await json(owner, "POST", `/api/v1/roles/${ids.role}/outcome`, { outcome: "filled", confirm: true, reason: "Filled." });
    const closedText = await closed.text();
    expect(closed.status, closedText).toBe(200);
    expect(leaks(closedText)).toEqual([]);
    const answer = JSON.parse(closedText) as { movedToTalentPool: number; closingMessage: ClosingMessagePreview };
    expect(answer.movedToTalentPool).toBe(0);
    expect(answer.closingMessage.people).toEqual([]);
    expect(answer.closingMessage.locked).toBeGreaterThan(0);
    const preview = await json(owner, "GET", `/api/v1/roles/${ids.role}/closing-message`);
    expect(leaks(await preview.text())).toEqual([]);
    await container.drain();
    // Sent for the others: nobody here, so the refusal is the same; the sweep still holds with the job closed.
    expect(await sweep()).toBeGreaterThan(200);
  }, 600_000);

  it("the console, a privacy request and the audit trail stay as they are: ITS is not the paying customer", async () => {
    const report = await read<{ report: { applicants: { total: number } } }>(await json(admin, "GET", `/api/v1/admin/customers/${ids.company}/report`));
    const everyone = (await container.db.select().from(applications).where(eq(applications.companyId, ids.company))).length;
    expect(report.report.applicants.total).toBe(everyone);
    const found = await read<{ candidate: { firstName: string } | null; applications: Array<{ id: string }> }>(await json(admin, "GET", `/api/v1/admin/data-requests/lookup/candidate?email=${encodeURIComponent(M.email)}&companyId=${ids.company}`));
    expect(found.candidate?.firstName).toBe(M.first);
    expect(found.applications.map((a) => a.id)).toEqual([ids.locked]);

    // A privacy request from them, by their own page: ITS reads their whole record, to hand it to them.
    const asked = await app.request(`/c/status/${lockedRow.statusToken}/privacy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ kind: "access" }).toString() });
    expect(asked.status).toBe(302);
    await container.drain();
    const requests = await read<Array<{ id: string; candidateId: string | null }>>(await json(admin, "GET", "/api/v1/admin/data-requests"));
    const theirs = requests.find((r) => r.candidateId === ids.lockedCandidate)!;
    const copy = await json(admin, "GET", `/api/v1/admin/data-requests/${theirs.id}/export`);
    expect(copy.status).toBe(200);
    const copyText = await copy.text();
    for (const m of [M.first, M.last, M.email]) expect(copyText).toContain(m);

    // The trail keeps why, and no name; the customer's own history reads ids at most.
    const [why] = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "application.locked"))).filter((r) => r.target?.id === ids.locked);
    expect(why.details).toMatchObject({ position: 2, limit: 1, plan: "free" });
    const history = await json(owner, "GET", "/api/v1/companies/current/audit");
    expect(history.status).toBe(200);
    expect(leaks(await history.text())).toEqual([]);
    const historyCsv = await json(owner, "GET", "/api/v1/companies/current/audit.csv");
    expect(leaks(await historyCsv.text())).toEqual([]);
  }, 120_000);

  it("break glass reads everyone: a row, the record and the list, and it is on the record", async () => {
    const [ada] = await container.db.select().from(users).where(eq(users.email, "ada.admin@identifiedtalent.com"));
    const glass = await json(admin, "POST", "/api/v1/admin/break-glass", { companyId: ids.company, reason: "Investigating a reported data issue for the customer.", minutes: 30 });
    expect(glass.status, await glass.clone().text()).toBe(201);
    expect((await json(admin, "POST", "/api/v1/auth/switch", { companyId: ids.company })).status).toBe(200);
    expect((await json(admin, "GET", `/api/v1/applications/${ids.locked}`)).status).toBe(200);
    const list = await read<{ applications: Array<{ id: string }>; locked: { count: number } }>(await json(admin, "GET", `/api/v1/roles/${ids.role}/applications?counts=1`));
    expect(list.applications.map((a) => a.id)).toContain(ids.locked);
    expect(list.locked.count).toBe(0);
    expect((await json(admin, "GET", `/api/v1/events?subjectId=${ids.locked}`)).status).toBe(200);
    expect(JSON.stringify(await read(await json(admin, "GET", `/api/v1/events?subjectId=${ids.locked}`)))).toContain("application.received");
    const logged = (await container.db.select().from(auditRecords).where(eq(auditRecords.action, "admin.break_glass"))).filter((r) => r.actor.id === ada.id);
    expect(logged.length).toBeGreaterThan(0);
    // The volume by source covers everyone it can read, which here is everyone.
    const volume = await read<{ totals: { total: number; bySource: Record<string, number> } }>(await json(admin, "GET", `/api/v1/roles/${ids.role}/volume`));
    expect(Object.values(volume.totals.bySource).reduce((a, b) => a + b, 0)).toBe(volume.totals.total);
    // The jobs list counts what waits on a person: all of it, not only what is about nobody.
    const [waiting] = await container.db.insert(approvalRequests).values({ companyId: ids.company, roleId: ids.role, applicationId: ids.locked, actionType: "message.send_freeform", subject: { type: "application", id: ids.locked }, proposal: { text: "A message." }, requestedBy: { kind: "system", id: "test" }, requiredRoles: ["owner"] }).returning();
    const jobs = await read<Array<{ id: string; needsYou: number }>>(await json(admin, "GET", "/api/v1/roles"));
    expect(jobs.find((j) => j.id === ids.role)?.needsYou).toBeGreaterThanOrEqual(1);
    await container.db.delete(approvalRequests).where(eq(approvalRequests.id, waiting.id));
  }, 120_000);

  it("the Share tab's volume counts someone locked only while an upgrade could open them: who withdrew or was deleted while locked is in no figure, so it adds up and agrees with the job page", async () => {
    const company = await newCompany();
    await setLimit(company.id, 1);
    const j = await openRole(company);
    await apply(j, person("Vic", "Visible"));
    const left = await apply(j, person("Lea"));
    expect((await app.request(`/c/status/${left.statusToken}/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "yes" }).toString() })).status).toBe(302);
    const deleted = await apply(j, person("Del"));
    await withTenant(container.db, company.id, (tx) => anonymizeCandidate(tx, { companyId: company.id, candidateId: deleted.candidateId, actor: { kind: "system", id: "candidate-lock.test" }, deleteFile: async () => undefined }));
    const waits = await apply(j, person("Wai"));
    for (const r of [left, deleted, waits]) expect(r.lockedAt).not.toBeNull();
    type Volume = { totals: { total: number; bySource: Record<string, number> }; days: Array<{ total: number }>; today: { total: number } };
    const volume = async () => read<Volume>(await json(company.cookie, "GET", `/api/v1/roles/${j.roleId}/volume`));
    const sources = (v: Volume) => Object.values(v.totals.bySource).reduce((a, b) => a + b, 0);
    const lockedOnJobPage = async () => (await read<{ locked: { count: number } }>(await json(company.cookie, "GET", `/api/v1/roles/${j.roleId}/applications?counts=1`))).locked.count;
    // Vic, whom the team reads, and Wai, locked and waiting: one on the Locked line, as on the job page.
    const before = await volume();
    expect([before.totals.total, before.today.total, before.days.at(-1)?.total]).toEqual([2, 2, 2]);
    expect(sources(before)).toBe(1);
    expect(await lockedOnJobPage()).toBe(1);
    expect(before.totals.total - sources(before)).toBe(1);
    // An upgrade opens Wai, and the Locked line goes: the two who left stay locked, and still count nowhere.
    const moved = await json(admin, "POST", `/api/v1/admin/customers/${company.id}/plan`, { planKey: "pro", reason: "They asked to upgrade." });
    expect(moved.status, await moved.clone().text()).toBe(200);
    await container.drain();
    const after = await volume();
    expect(after.totals.total).toBe(2);
    expect(sources(after)).toBe(2);
    expect(await lockedOnJobPage()).toBe(0);
  }, 120_000);

  describe("one neutral notice per job per day", () => {
    it("says more applied, names nobody, goes once a day per job however many apply, and again the next day", async () => {
      const company = await newCompany();
      await usePlan(container, company.id, "ultra");
      await setLimit(company.id, 1);
      const a = await openRole(company);
      const b = await openRole(company);
      await apply(a, person("Ana", "Open"));
      await apply(b, person("Bo", "Open"));
      const notices = () => container.db.select().from(notifications).where(and(eq(notifications.companyId, company.id), eq(notifications.kind, MORE_APPLIED_KIND)));
      expect(await notices()).toEqual([]);

      await apply(a, person("Cal"));
      const first = await notices();
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ title: `More people applied to ${a.title}.`, body: MORE_CANDIDATES_LINE });
      expect(first[0].action).toEqual({ label: "See applicants", href: `/roles/${a.roleId}/talent` });
      expect(JSON.stringify(first[0])).not.toContain("Lockwood");

      // However many more apply to that job that day.
      await apply(a, person("Dee"));
      await apply(a, person("Eli"));
      expect(await notices()).toHaveLength(1);
      // Each job has its own.
      await apply(b, person("Fay"));
      expect((await notices()).map((n) => n.action?.href).sort()).toEqual([`/roles/${a.roleId}/talent`, `/roles/${b.roleId}/talent`].sort());

      // The next day, once more.
      await container.db.execute(sql`update notifications set created_at = created_at - interval '2 days' where company_id = ${company.id} and kind = ${MORE_APPLIED_KIND}`);
      await apply(a, person("Gus"));
      expect((await notices()).filter((n) => n.action?.href === `/roles/${a.roleId}/talent`)).toHaveLength(2);

      // Nobody applied past the limit, nothing said: a job within its limit stays quiet.
      const quiet = await newCompany();
      await setLimit(quiet.id, 2);
      const q = await openRole(quiet);
      await apply(q, person("Hal", "Open"));
      await apply(q, person("Ivy", "Open"));
      expect(await container.db.select().from(notifications).where(and(eq(notifications.companyId, quiet.id), eq(notifications.kind, MORE_APPLIED_KIND)))).toEqual([]);
    }, 300_000);
  });

  describe("the candidate pool", () => {
    it("someone visible on one job and locked on another shows only through the visible one; and a move up opens the other", async () => {
      await withPlatform(container.db, (tx) => tx.insert(plans).values({ key: "test_many", name: "Many", limits: { candidates_per_job: 50, active_roles: 10, jobs_total: null } }).onConflictDoNothing());
      const company = await newCompany();
      await usePlan(container, company.id, "ultra");
      const seen = await openRole(company);
      const full = await openRole(company);
      await setLimit(company.id, 1);
      await apply(full, person("First", "Open"));
      const pat = { first: "Zqbothfirst", last: "Zqbothlast", email: "zqboth@people.test" };
      const shown = await apply(seen, pat);
      const hidden = await apply(full, pat);
      expect(shown.lockedAt).toBeNull();
      expect(hidden.lockedAt).not.toBeNull();
      expect(shown.candidateId).toBe(hidden.candidateId);

      expect((await json(company.cookie, "GET", `/api/v1/applications/${shown.id}`)).status).toBe(200);
      expect((await json(company.cookie, "GET", `/api/v1/applications/${hidden.id}`)).status).toBe(402);
      const named = (rows: Array<{ candidate: { name: string } | null }>) => rows.map((r) => r.candidate?.name ?? "");
      expect(named(await read(await json(company.cookie, "GET", `/api/v1/roles/${seen.roleId}/applications`)))).toEqual(["Zqbothfirst Zqbothlast"]);
      expect(named(await read(await json(company.cookie, "GET", `/api/v1/roles/${full.roleId}/applications`)))).not.toContain("Zqbothfirst Zqbothlast");
      // The other job's entries are held back, and what is about the person themselves stays, through the job that shows them.
      const timeline = await read<Array<{ subjectId: string }>>(await json(company.cookie, "GET", `/api/v1/roles/${full.roleId}/timeline`));
      expect(timeline.map((e) => e.subjectId)).not.toContain(hidden.id);
      const aboutThem = await read<Array<{ subjectId: string; type: string }>>(await json(company.cookie, "GET", `/api/v1/events?subjectType=candidate&subjectId=${shown.candidateId}`));
      expect(aboutThem.map((e) => e.type)).toContain("candidate.created");
      // Someone locked everywhere: not even that.
      const only = await apply(full, { first: "Zqonlyfirst", last: "Zqonlylast", email: "zqonly@people.test" });
      expect(await read(await json(company.cookie, "GET", `/api/v1/events?subjectType=candidate&subjectId=${only.candidateId}`))).toEqual([]);
      // The visible application's record has none of the other's: no second application hangs off it.
      const record = await (await json(company.cookie, "GET", `/api/v1/applications/${shown.id}`)).text();
      expect(record).not.toContain(hidden.id);
      expect(record).not.toContain(full.roleId);

      // A move up opens them: the wall is the stored column, and nothing else.
      const moved = await json(admin, "POST", `/api/v1/admin/customers/${company.id}/plan`, { planKey: "test_many", reason: "They asked to upgrade." });
      expect(moved.status, await moved.clone().text()).toBe(200);
      await container.drain();
      expect((await json(company.cookie, "GET", `/api/v1/applications/${hidden.id}`)).status).toBe(200);
      const after = await read<{ applications: Array<{ id: string }>; locked: { count: number } }>(await json(company.cookie, "GET", `/api/v1/roles/${full.roleId}/applications?counts=1`));
      expect(after.applications.map((a) => a.id)).toContain(hidden.id);
      expect(after.locked.count).toBe(0);
      expect((await read<Array<{ subjectId: string }>>(await json(company.cookie, "GET", `/api/v1/roles/${full.roleId}/timeline`))).map((e) => e.subjectId)).toContain(hidden.id);
    }, 300_000);
  });

  describe("the journey", () => {
    it("with the stand-in AI: past the limit nothing a locked person does reaches the team, no AI runs on them, and the team's reads stay clean at each step until an upgrade opens them", async () => {
      const company = await newCompany();
      await setLimit(company.id, 1);
      const j = await openRole(company);
      const hrHere = await signInAs(container, app, { companyId: company.id, role: "hr" });
      await apply(j, { first: "Vic", last: "Visible", email: "vic.visible@people.test" });
      const runsBefore = (await container.db.select().from(aiRuns).where(eq(aiRuns.companyId, company.id))).length;
      const zed = { first: "Zqjourneyfirst", last: "Zqjourneylast", email: "zqjourney@people.test", city: "Zqjourneycity", file: "zqjourneyfile", resume: "Zqjourneyresume" };
      const row = await apply(j, zed);
      const clean = async (step: string) => {
        for (const [who, cookie] of [["the owner", company.cookie], ["HR", hrHere]] as const) {
          for (const path of [`/api/v1/roles/${j.roleId}/applications?counts=1`, `/api/v1/roles/${j.roleId}/board`, `/api/v1/roles/${j.roleId}/timeline`, `/api/v1/roles/${j.roleId}/report`, `/api/v1/roles/${j.roleId}/report.csv`, `/api/v1/roles/${j.roleId}`, "/api/v1/roles", "/api/v1/brief", "/api/v1/events", "/api/v1/approvals", "/api/v1/escalations/mine", "/api/v1/notifications", "/api/v1/interviews"]) {
            const text = await (await json(cookie, "GET", path)).text();
            expect(/Zqjourney/i.test(text), `${step}: ${who} reads a marker at ${path}`).toBe(false);
          }
        }
        const members = await container.db.select({ email: users.email }).from(users).where(sql`${users.id} in (select user_id from memberships where company_id = ${company.id})`);
        for (const m of teamMail(members.map((u) => u.email))) expect(/Zqjourney/i.test(`${m.subject} ${m.text}`), `${step}: an email to ${m.to}`).toBe(false);
      };
      await clean("after applying");
      // No AI on them, and the one email went to them.
      expect((await container.db.select().from(aiRuns).where(eq(aiRuns.companyId, company.id))).length).toBe(runsBefore);
      expect((container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === zed.email)).toHaveLength(1);

      // They write, they ask for a person, they ask about their information.
      expect((await reply(row, zed.email, "Zqjourneyreply: any news?", "journey-1")).status).toBe(200);
      await container.drain();
      await clean("after writing back");
      expect((await reply(row, zed.email, "HUMAN", "journey-2")).status).toBe(200);
      await container.drain();
      await clean("after asking for a person");
      expect((await app.request(`/c/status/${row.statusToken}/privacy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ kind: "human_review" }).toString() })).status).toBe(302);
      await container.drain();
      await clean("after asking about their information");
      expect((await container.db.select().from(aiRuns).where(eq(aiRuns.companyId, company.id))).length).toBe(runsBefore);

      // Someone else withdraws from their page.
      const wes = await apply(j, { first: "Zqjourneywes", last: "Zqjourneylast", email: "zqjourneywes@people.test" });
      expect((await app.request(`/c/status/${wes.statusToken}/withdraw`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ confirm: "yes" }).toString() })).status).toBe(302);
      await container.drain();
      await clean("after someone withdrew");

      // An upgrade opens the oldest: now they can be read, and their interview starts by itself on the new plan.
      await withPlatform(container.db, (tx) => tx.insert(plans).values({ key: "test_two_here", name: "Two", limits: { candidates_per_job: 2 } }).onConflictDoNothing());
      const moved = await json(admin, "POST", `/api/v1/admin/customers/${company.id}/plan`, { planKey: "test_two_here", reason: "They asked to upgrade." });
      expect(moved.status, await moved.clone().text()).toBe(200);
      await container.drain();
      expect(await read<{ unlocked: number }>(moved)).toMatchObject({ unlocked: 1 });
      const opened = await json(company.cookie, "GET", `/api/v1/applications/${row.id}`);
      expect(opened.status).toBe(200);
      expect(await opened.text()).toContain("Zqjourneyfirst");
      expect((await json(company.cookie, "GET", `/api/v1/applications/${wes.id}`)).status).toBe(402);
      expect((await container.db.select().from(aiRuns).where(eq(aiRuns.companyId, company.id))).length).toBeGreaterThan(runsBefore);
      const list = await read<{ applications: Array<{ id: string }>; locked: { count: number } }>(await json(company.cookie, "GET", `/api/v1/roles/${j.roleId}/applications?counts=1`));
      expect(list.applications.map((a) => a.id)).toContain(row.id);
      // Nobody is left to open: the one still locked withdrew while locked, so they have no card, and stay unread.
      expect(list.locked.count).toBe(0);

      // A move back down locks nobody: they stay readable.
      await withPlatform(container.db, (tx) => tx.insert(plans).values({ key: "test_one_here", name: "One", limits: { candidates_per_job: 1 } }).onConflictDoNothing());
      expect((await json(admin, "POST", `/api/v1/admin/customers/${company.id}/plan`, { planKey: "test_one_here", reason: "They moved down." })).status).toBe(200);
      await container.drain();
      expect((await json(company.cookie, "GET", `/api/v1/applications/${row.id}`)).status).toBe(200);
      // The events about them from while they were locked are theirs to read now; nothing about the one still locked.
      expect(/Zqjourneywes/i.test(await (await json(company.cookie, "GET", "/api/v1/events")).text())).toBe(false);
    }, 300_000);
  });

  it("the decision after an interview answers with the backups, and someone locked is not among them, wherever their row says they are", async () => {
    const company = await newCompany();
    await setLimit(company.id, 1);
    const j = await openRole(company);
    const hal = await apply(j, { first: "Hal", last: "Visible", email: "hal.visible@people.test" });
    const zoe = await apply(j, { first: "Zqzoefirst", last: "Zqzoelast", email: "zqzoe@people.test" });
    await container.db.update(applications).set({ stage: "finalist" }).where(eq(applications.id, zoe.id));
    await container.db.update(applications).set({ stage: "interview_complete" }).where(eq(applications.id, hal.id));
    await container.db.insert(interviews).values({ companyId: company.id, applicationId: hal.id, roundKey: "r1", title: "Working interview", format: "onsite", durationMinutes: 45, status: "completed", outcome: "happened", timezone: "America/Los_Angeles" });
    const decided = await json(company.cookie, "POST", `/api/v1/applications/${hal.id}/decision`, { decision: "hired", hireDate: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) });
    const text = await decided.text();
    expect(decided.status, text).toBe(200);
    expect(/zqzoe/i.test(text)).toBe(false);
    // nobody to name, and only how many the team cannot read yet
    expect((JSON.parse(text) as { hire: { backups: unknown } }).hire.backups).toEqual({ count: 0, people: [], locked: 1 });
    // Home's "keep your backups warm" is there only for people it can name, so it says nothing here.
    const brief = await read<{ cards: Array<{ kind: string }> }>(await json(company.cookie, "GET", "/api/v1/brief"));
    expect(brief.cards.map((c) => c.kind)).not.toContain("hire");
    expect(/zqzoe/i.test(JSON.stringify(brief))).toBe(false);
  }, 120_000);

  it("a closing message's one request: someone locked comes off its list on every read, and when it goes they hear with no Undo and no line in the answer", async () => {
    const company = await newCompany();
    await setLimit(company.id, 1);
    const j = await openRole(company);
    const una = await apply(j, { first: "Una", last: "Visible", email: "una.closing@people.test" });
    const lee = { first: "Zqleefirst", last: "Zqleelast", email: "zqlee@people.test" };
    const leeRow = await apply(j, lee);
    const closed = await json(company.cookie, "POST", `/api/v1/roles/${j.roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "We changed our plans." });
    const closedText = await closed.text();
    expect(closed.status, closedText).toBe(200);
    expect(/zqlee/i.test(closedText)).toBe(false);
    expect(JSON.parse(closedText).closingMessage).toMatchObject({ count: 1, locked: 1 });

    // Stored with a locked id in it, from however it got there.
    const [req] = await container.db.insert(approvalRequests).values({ companyId: company.id, roleId: j.roleId, applicationId: null, actionType: "disposition.send", subject: { type: "role", id: j.roleId }, proposal: { kind: "role_closed", applicationIds: [una.id, leeRow.id], count: 2 }, requestedBy: { kind: "system", id: "test" }, requiredRoles: ["owner"] }).returning();
    const seen = await read<Array<{ id: string; proposal: { applicationIds: string[]; count: number } }>>(await json(company.cookie, "GET", "/api/v1/approvals"));
    expect(seen.find((r) => r.id === req.id)?.proposal).toEqual({ kind: "role_closed", applicationIds: [una.id], count: 2 });
    const onRole = await read<{ pendingApprovals: Array<{ id: string; proposal: { applicationIds: string[] } }> }>(await json(company.cookie, "GET", `/api/v1/roles/${j.roleId}`));
    expect(onRole.pendingApprovals.find((r) => r.id === req.id)?.proposal.applicationIds).toEqual([una.id]);
    await container.db.delete(approvalRequests).where(eq(approvalRequests.id, req.id));

    // Sending it: a line for the person the team can read, and the others hear with no line and no Undo.
    const sent = await json(company.cookie, "POST", `/api/v1/roles/${j.roleId}/closing-message`, { confirm: true });
    const sentText = await sent.text();
    expect(sent.status, sentText).toBe(200);
    expect(sentText).not.toContain(leeRow.id);
    expect(JSON.parse(sentText).results.map((r: { applicationId: string }) => r.applicationId)).toEqual([una.id]);
    await container.drain();
    expect((container.integrations.email as FakeEmailAdapter).sent.filter((m) => m.to === lee.email).length).toBe(2);
    // A locked id named in the body is not on the list.
    const again = await json(company.cookie, "POST", `/api/v1/roles/${j.roleId}/closing-message`, { confirm: true, applicationIds: [leeRow.id] });
    expect(again.status).toBe(409);
  }, 120_000);

  it("held emails let in when a job resumes: the notice counts only who the team can read, and says of the rest that more applied", async () => {
    const heldNotices = (companyId: string) => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "application.email_held")));
    const hold = async (j: Job, mark: string, names: string[]) => {
      const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, j.roleId), eq(postings.channel, "email_in")));
      expect((await json(j.cookie, "POST", `/api/v1/roles/${j.roleId}/pause`, {})).status).toBe(200);
      for (const n of names) expect(await read(await inbound({ From: `${n}@people.test`, FromName: `${n} Sender`, To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `${n} applying`, TextBody: "Please consider me.", Attachments: [], MessageID: `${mark}-${n}` }))).toMatchObject({ matched: true, held: true });
      const resumed = await json(j.cookie, "POST", `/api/v1/roles/${j.roleId}/resume`, {});
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      await container.drain();
    };

    // Everyone past the limit: nobody was added to anything the team can read.
    const full = await newCompany();
    await setLimit(full.id, 1);
    const allLocked = await openRole(full);
    await apply(allLocked, { first: "Una", last: "Visible", email: "una.replayed@people.test" });
    await hold(allLocked, "replay-all", ["zqreplaya", "zqreplayb"]);
    const [all] = await heldNotices(full.id);
    expect(all).toMatchObject({ title: `More people applied to ${allLocked.title}.`, body: MORE_CANDIDATES_LINE });
    expect(`${all.title} ${all.body}`).not.toMatch(/\badded\b|\b2\b/);

    // One within the limit and one past it: the notice counts the one, and says more applied.
    const some = await newCompany();
    await setLimit(some.id, 2);
    const oneRoom = await openRole(some);
    await apply(oneRoom, { first: "Vic", last: "Visible", email: "vic.replayed@people.test" });
    await hold(oneRoom, "replay-some", ["zqreplayc", "zqreplayd"]);
    const [mixed] = await heldNotices(some.id);
    expect(mixed.title).toBe(`A held email application was added to ${oneRoom.title}`);
    expect(mixed.body).toContain("so the application that arrived by email while they were closed has been added to the role's applications.");
    expect(mixed.body).toContain(MORE_CANDIDATES_LINE);
    expect(`${mixed.title} ${mixed.body}`).not.toMatch(/zqreplay|2 applications/i);

    // Within the limit it reads as it always did.
    const open = await newCompany();
    await usePlan(container, open.id, "ultra");
    const noLimit = await openRole(open);
    await hold(noLimit, "replay-open", ["zqreplaye", "zqreplayf"]);
    const [plain] = await heldNotices(open.id);
    expect(plain.title).toBe(`2 held email applications were added to ${noLimit.title}`);
    expect(plain.body).not.toContain(MORE_CANDIDATES_LINE);
  }, 300_000);

  it("an emailed-in applicant's address and subject stay out of the two lists that return raw payloads, and the close notice for a held email counts only who the team can read", async () => {
    const company = await newCompany();
    await setLimit(company.id, 1);
    const j = await openRole(company);
    await apply(j, { first: "Una", last: "Visible", email: "una.visible@people.test" });
    const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, j.roleId), eq(postings.channel, "email_in")));
    const send = (id: string) => inbound({ From: `zqheld${id}@people.test`, FromName: `Zqheld${id} Sender`, To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `Zqheldsubject ${id}`, TextBody: "Please consider me.", Attachments: [], MessageID: `held-${id}` });
    expect((await json(company.cookie, "POST", `/api/v1/roles/${j.roleId}/pause`, {})).status).toBe(200);
    expect(await read(await send("a"))).toMatchObject({ matched: true, held: true });
    const closed = await json(company.cookie, "POST", `/api/v1/roles/${j.roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "We changed our plans." });
    const answer = await read<{ movedToTalentPool: number; heldEmailsAddedToTalentPool: number; closingMessage: ClosingMessagePreview }>(closed);
    expect(answer.heldEmailsAddedToTalentPool).toBe(0);
    expect(answer.closingMessage.locked).toBe(1);
    await container.drain();
    const held = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, company.id), eq(notifications.kind, "application.email_held")))).map((n) => `${n.title} ${n.body}`);
    expect(held.join(" ")).not.toContain("talent pool");
    expect(held.join(" ")).toContain(MORE_CANDIDATES_LINE);
    for (const path of ["/api/v1/events", `/api/v1/roles/${j.roleId}/timeline`, "/api/v1/notifications"]) expect(/zqheld/i.test(await (await json(company.cookie, "GET", path)).text()), path).toBe(false);
    // It is on the record for ITS.
    const [row] = await container.db.select({ payload: events.payload }).from(events).where(and(eq(events.companyId, company.id), eq(events.type, "application.received"), sql`${events.payload}->>'note' is not null`));
    expect(String(row.payload.note)).toContain("zqheld");
  }, 300_000);
});

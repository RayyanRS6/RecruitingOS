import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { HELD_STATUS, detectStuckRoles, queueCommunication, releaseHeldCommunications } from "@ros/agents";
import type { ApplicationStage, GettingStarted, TrialTerm } from "@ros/contracts";
import { createApplicationLink, defaultClosingDate } from "@ros/core";
import { applications, auditRecords, candidates, communications, companies, events, interviews, jobs, notifications, postings, randomToken, rolePackets, roles, screens, uuidv7, withPlatform, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { COMPANY_CHECK_WAIT_REASON } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { resetPublicFeedCache } from "./pages/public-feeds";
import { createApplication } from "./services/applications";
import { signInAdmin, signInAs } from "./test-helpers";

/**
 * The one-time ITS check (founder decision B7; plan B1) and the getting-started card (plan B2). A company that signs
 * itself up drafts and approves roles at once, but nothing of it is public (careers page, job pages, apply form, tracked
 * links, feeds, sitemap) and its emails to candidates are held, not dropped, until a platform administrator confirms it
 * with a reason. Confirming publishes the waiting role and sends what waited; taking it back puts everything offline
 * again. Today says so, and shows each person only the setup steps they can do.
 */
describe("the ITS company check and getting started", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let roleId = "";
  let applicationId = "";
  let held = 0;
  let trialTerm: TrialTerm | undefined;
  const mail = () => container.integrations.email as unknown as FakeEmailAdapter;
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  type Card = { kind: string; title: string; body: string; actions: Array<{ label: string; method: string; path: string; body?: Record<string, unknown> }>; gettingStarted?: GettingStarted };
  const cards = async (cookie: string) => ((await (await json(cookie, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards;
  const setupCard = async (cookie: string) => (await cards(cookie)).find((c) => c.kind === "getting_started");
  const stepKeys = (card: Card | undefined) => card?.gettingStarted?.steps.map((s) => s.key) ?? [];
  const step = (card: Card | undefined, key: string) => card?.gettingStarted?.steps.find((s) => s.key === key);
  const page = (path: string) => app.request(path);
  const publishRun = async () => (await container.db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.workflowKey, "publish_role"))))[0];
  const verify = (cookie: string, body: Record<string, unknown>) => json(cookie, "POST", `/api/v1/admin/customers/${companyId}/verification`, body);

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", COMPANY_CHECK: "its", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@check.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const r = await json(owner, "POST", "/api/v1/companies", { name: "Check Dental", vertical: "dental", sizeBand: "20-49", website: "checkdental.example", ownerName: "Olive Owner", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status).toBe(201);
    ({ id: companyId, slug } = (await r.json()) as { id: string; slug: string });
    admin = await signInAdmin(app, container, "ana.admin@identifiedtalent.com", "Ana Admin");
  });
  afterAll(async () => {
    await container.close();
  });

  it("a company that signs itself up starts unconfirmed, ITS hears about it, and the customer cannot confirm itself", async () => {
    const current = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { settings: Record<string, unknown> };
    expect(current.settings.verifiedAt).toBeUndefined();
    const notice = mail().sent.find((m) => m.to === container.env.ITS_QUEUE_EMAIL && m.subject.includes("[company check]"));
    expect(notice?.subject).toBe("[company check] Check Dental is waiting for the ITS check");
    expect(notice?.text).toContain("Owner: Olive Owner <owner@check.test>");
    expect(notice?.text).toContain("Website: checkdental.example");
    expect((await page(`/careers/${slug}`)).status).toBe(404);
    for (const settings of [{ verifiedAt: "2026-10-08T00:00:00.000Z" }, { verifiedBy: { kind: "user", id: "me" } }, { onboarding: { jobBoardsConfirmedAt: "2026-10-08T00:00:00.000Z" } }]) {
      const refused = await json(owner, "PATCH", "/api/v1/companies/current", { settings });
      expect(refused.status).toBe(400);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("not_yours_to_change");
    }
  });

  it("drafts and approves a role, which opens while its public side waits for the check", async () => {
    const started = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    expect((await container.db.select().from(roles).where(eq(roles.id, roleId)))[0].status).toBe("open");
    const run = await publishRun();
    expect(run.status).toBe("waiting");
    expect(run.wait).toMatchObject({ kind: "event", reason: COMPANY_CHECK_WAIT_REASON });
    expect(await container.db.select().from(postings).where(eq(postings.roleId, roleId))).toHaveLength(0);
    // nothing public: the careers page, the job page (and its JobPosting data), the form, the receipt
    for (const path of [`/careers/${slug}`, `/careers/${slug}/jobs/${roleId}`, `/careers/${slug}/jobs/${roleId}/apply`, `/careers/${slug}/jobs/${roleId}/applied`]) expect((await page(path)).status, path).toBe(404);
    expect((await app.request(`/careers/${slug}/jobs/${roleId}/apply`, { method: "POST", body: new FormData() })).status).toBe(404);
    // no feed and no sitemap names it, and a tracked link leads nowhere
    resetPublicFeedCache(container);
    for (const path of ["/feeds/jobs.xml", "/feeds/jobs.json", "/feeds/linkedin.xml", "/sitemap.xml"]) expect(await (await page(path)).text(), path).not.toContain(roleId);
    const link = await withTenant(container.db, companyId, (tx) => createApplicationLink(tx, { companyId, roleId, source: "referral", label: "A friend", actor: { kind: "system", id: "test" } }));
    expect((await page(`/a/${link.token}`)).status).toBe(404);
    // a role nobody can see yet is not "a role with no applicants": no advice to post it elsewhere, no recruiter offered
    const later = new Date(Date.now() + 20 * 86_400_000);
    expect((await withTenant(container.db, companyId, (tx) => detectStuckRoles(tx, companyId, later))).map((d) => d.detector)).not.toContain("no_applicants");
  });

  it("Today says ITS is confirming the company, and shows each person only the steps they can do", async () => {
    const mine = await setupCard(owner);
    expect((await cards(owner))[0].kind).toBe("getting_started");
    expect(mine?.gettingStarted).toMatchObject({ verified: false, heldMessages: 0, dismissible: true });
    expect(mine?.body).toContain("ITS is confirming your company");
    expect(mine?.body).toContain("emails to candidates wait");
    expect(stepKeys(mine)).toEqual(["company_details", "team", "interview_hours", "first_role", "job_boards", "ai_rules"]);
    // derived from the record: the website was given at sign-up; a role exists; nothing else is done yet
    expect(step(mine, "company_details")).toMatchObject({ done: false, detail: "Still to add: a careers-page introduction, a benefits summary. A logo is optional." });
    expect(step(mine, "first_role")?.done).toBe(true);
    expect(mine?.gettingStarted?.steps.filter((s) => s.done).map((s) => s.key)).toEqual(["first_role"]);
    for (const s of mine?.gettingStarted?.steps ?? []) expect(s.why.length, s.key).toBeGreaterThan(20);
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager" });
    expect(stepKeys(await setupCard(hm))).toEqual(["interview_hours", "first_role"]);
    const hr = await signInAs(container, app, { companyId, role: "hr" });
    expect(stepKeys(await setupCard(hr))).toEqual(["team"]);
    // only those who may draft and approve roles are told they can meanwhile; HR may do neither
    expect(mine?.body).toContain("You can draft and approve roles in the meantime.");
    expect((await setupCard(hm))?.body).toContain("You can draft and approve roles in the meantime.");
    expect((await setupCard(hr))?.body).toContain("ITS is confirming your company");
    expect((await setupCard(hr))?.body).not.toMatch(/draft/);
    // a second member makes the team step done
    expect(step(await setupCard(owner), "team")?.done).toBe(true);
    const interviewer = await signInAs(container, app, { companyId, role: "interviewer" });
    expect(await setupCard(interviewer)).toBeUndefined();
  });

  it("holds every message to a candidate, not team mail or a privacy reply, and Today says how many wait", async () => {
    const actor = { kind: "system" as const, id: "check_test" };
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    // "no" to an eligibility question: she is held for the team's decision, a card that needs someone on Today
    const answers = Object.fromEntries(role.currentPacket.packet.requirements.eligibility.map((r) => [r.key, "no"]));
    // an application that reaches the company another way (here one whose person saw the notices on a form): its
    // acknowledgment is held. (One emailed in is not read at all until that email has gone, known-bugs row 16, so it
    // would not reach the eligibility hold below while the company waits for the check.)
    applicationId = (await withTenant(container.db, companyId, (tx) => createApplication(tx, container, { companyId, roleId, source: "careers_page", firstName: "Hana", lastName: "Held", email: "hana.held@example.com", phone: null, smsConsent: false, consentSource: "careers_page", noticeVersionsShown: ["ai_use@1", "privacy@1"], eligibilityAnswers: answers, noResumeAnswers: { summary: "Registered dental hygienist since 2019; active CA RDH license." } }, actor))).application.id;
    await container.drain();
    const ack = (await container.db.select().from(communications).where(eq(communications.applicationId, applicationId))).find((m) => m.templateKey === "acknowledgment");
    expect(ack?.status).toBe(HELD_STATUS);
    expect(mail().sent.some((m) => m.to === "hana.held@example.com")).toBe(false);
    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "communication.send"))).some((j) => j.payload.communicationId === ack?.id)).toBe(false);
    expect((await container.db.select().from(events).where(and(eq(events.type, "message.held"), eq(events.subjectId, ack!.id))))).toHaveLength(1);
    // a message already queued when the worker reaches it is held too (a confirmation taken back after it was queued)
    const [queued] = await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId: ack!.candidateId, applicationId, direction: "outbound", channel: "email", fromAddress: "x", toAddress: "hana.held@example.com", subject: "Queued before", bodyText: "Hello", templateKey: "freeform", provider: "fake-email", status: "queued", sentBy: actor, idempotencyKey: `queued-before:${uuidv7()}` }).returning({ id: communications.id }));
    await container.db.insert(jobs).values({ kind: "communication.send", payload: { communicationId: queued.id, companyId } });
    await container.drain();
    expect((await container.db.select().from(communications).where(eq(communications.id, queued.id)))[0].status).toBe(HELD_STATUS);
    // team mail and the answer to a privacy request are never held
    const team = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, { channel: "email", companyId, to: "olive@check.test", from: "x <updates@test.localhost>", subject: "Team", text: "Hi", templateKey: "invite", idempotencyKey: `team:${uuidv7()}`, actor }));
    const privacy = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, { channel: "email", companyId, candidateId: ack!.candidateId, to: "hana.held@example.com", from: "x <updates@test.localhost>", subject: "We received your request", text: "Hi", templateKey: "privacy_ack", idempotencyKey: `privacy:${uuidv7()}`, actor }));
    expect(team.status).toBe("pending");
    await container.drain();
    for (const id of [team.communicationId, privacy.communicationId]) expect((await container.db.select().from(communications).where(eq(communications.id, id)))[0].status).toBe("sent");
    // Today: the notice stays (nobody can hide it), says how many wait, and the steps step aside now a candidate needs a decision
    held = (await container.db.select().from(communications).where(and(eq(communications.companyId, companyId), eq(communications.status, HELD_STATUS)))).length;
    expect(held).toBeGreaterThanOrEqual(2); // the acknowledgment, the message queued before, and whatever else the intake sent them
    const card = await setupCard(owner);
    expect(card?.gettingStarted?.heldMessages).toBe(held);
    expect(card?.body).toContain(`${held} messages to candidates are waiting for it now.`);
    expect((await cards(owner)).some((c) => c.kind === "needs_review" || c.kind === "decision")).toBe(true);
    expect(card?.gettingStarted?.steps).toEqual([]);
    expect(card?.title).toBe("ITS is confirming your company");
  });

  it("only a platform administrator confirms, with a reason; confirming publishes the role, opens the pages and sends what waited", async () => {
    expect((await verify(owner, { verified: true, reason: "I am real", confirm: true })).status).toBe(403);
    expect((await verify(admin, { verified: true, reason: "ok", confirm: true })).status).toBe(400);
    expect((await verify(admin, { verified: true, reason: "Kick-off call held; website and phone checked." })).status).toBe(400);
    const r = await verify(admin, { verified: true, reason: "Kick-off call held; website and phone checked.", confirm: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, verified: true, changed: true, releasedMessages: held });
    await container.drain();
    // what waited went out, once each
    // held on a must-have answer: the neutral thank-you, without the AI interview link (R20-10)
    expect(mail().sent.filter((m) => m.to === "hana.held@example.com" && m.subject.startsWith("Thank you for applying: "))).toHaveLength(1);
    expect(mail().sent.some((m) => m.subject === "Queued before")).toBe(true);
    expect((await container.db.select().from(communications).where(eq(communications.applicationId, applicationId))).filter((m) => m.status === HELD_STATUS)).toHaveLength(0);
    expect((await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "message.released"))))).toHaveLength(held);
    // the waiting publish run woke and prepared the channels; the pages and feeds are public
    expect((await publishRun()).status).toBe("completed");
    expect((await container.db.select().from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "careers_page")))).length).toBe(1);
    expect((await page(`/careers/${slug}`)).status).toBe(200);
    const job = await page(`/careers/${slug}/jobs/${roleId}`);
    expect(job.status).toBe(200);
    expect(await job.text()).toContain("application/ld+json");
    expect(await (await page("/feeds/jobs.xml")).text()).toContain(roleId);
    // recorded with the reason, shown to the customer in their own words, and the team told
    const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.verified")));
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({ reason: "Kick-off call held; website and phone checked.", actor: { kind: "user", name: "Ana Admin" }, details: { released: held } });
    const history = (await (await json(owner, "GET", "/api/v1/companies/current/audit?actions=company.verified")).json()) as Array<{ description: string }>;
    expect(history.map((h) => h.description)).toEqual([`ITS confirmed your company; ${held} waiting messages to candidates went out.`]);
    const told = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "company.verified")));
    expect(told.length).toBeGreaterThanOrEqual(1);
    expect(told[0].body).toContain(`${held} messages to candidates that were waiting for this are on their way.`);
    // the Trial plan's 30 days start at this check (founder decision L-02 B), and the owners are told when they end
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    expect(co.settings.trial).toMatchObject({ startedBy: "its_check" });
    expect(Date.parse(co.settings.trial!.endsAt) - Date.parse(co.settings.trial!.startedAt)).toBe(30 * 86_400_000);
    expect(told[0].body).toMatch(/Your 30-day trial starts today and ends on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/);
    trialTerm = co.settings.trial;
    // the console lists it as confirmed; confirming again changes nothing
    const list = (await (await json(admin, "GET", "/api/v1/admin/customers")).json()) as Array<{ id: string; verifiedAt: string | null; heldMessages: number }>;
    expect(list.find((c) => c.id === companyId)).toMatchObject({ heldMessages: 0 });
    expect(list.find((c) => c.id === companyId)?.verifiedAt).toBeTruthy();
    expect(await (await verify(admin, { verified: true, reason: "Checked again, still fine.", confirm: true })).json()).toMatchObject({ changed: false, releasedMessages: 0 });
    // Today: no notice any more; a candidate is waiting on a decision, so no steps either
    expect(await setupCard(owner)).toBeUndefined();
    // the open request's card leads to the request itself
    const asked = await json(owner, "POST", "/api/v1/escalations", { kind: "ask", roleId, question: "Is the pay range right?" });
    const { id: requestId } = (await asked.json()) as { id: string };
    const requestCard = (await cards(owner)).find((c) => c.kind === "escalation");
    expect(requestCard?.actions).toEqual([{ label: "See the request", method: "GET", path: `/?request=${requestId}` }]);
  });

  it("confirming again repairs a message that was held as the first confirmation committed", async () => {
    // the race the share lock prevents, staged: a message written as held after the release ran
    const cand = (await container.db.select().from(applications).where(eq(applications.id, applicationId)))[0].candidateId;
    const [late] = await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId: cand, applicationId, direction: "outbound", channel: "email", fromAddress: "x", toAddress: "hana.held@example.com", subject: "Held late", bodyText: "Hello", templateKey: "freeform", provider: "fake-email", status: HELD_STATUS, sentBy: { kind: "system", id: "check_test" }, idempotencyKey: `held-late:${uuidv7()}` }).returning({ id: communications.id }));
    const r = await verify(admin, { verified: true, reason: "Confirming again to send what was held.", confirm: true });
    expect(await r.json()).toMatchObject({ changed: false, releasedMessages: 1 });
    await container.drain();
    expect((await container.db.select().from(communications).where(eq(communications.id, late.id)))[0].status).toBe("sent");
  });

  it("taking the confirmation back puts the pages and feeds offline at once and holds messages again", async () => {
    const r = await verify(admin, { verified: false, reason: "The website does not match the company.", confirm: true });
    expect(await r.json()).toMatchObject({ ok: true, verified: false, changed: true });
    for (const path of [`/careers/${slug}`, `/careers/${slug}/jobs/${roleId}`]) expect((await page(path)).status, path).toBe(404);
    expect(await (await page("/feeds/jobs.xml")).text()).not.toContain(roleId);
    const app0 = (await container.db.select().from(applications).where(eq(applications.id, applicationId)))[0];
    const again = await withTenant(container.db, companyId, (tx) => queueCommunication(tx, container.integrations, { channel: "email", companyId, candidateId: app0.candidateId, applicationId, to: "hana.held@example.com", from: "x <updates@test.localhost>", subject: "After", text: "Hi", templateKey: "freeform", idempotencyKey: `after:${uuidv7()}`, actor: { kind: "system", id: "check_test" } }));
    expect(again).toMatchObject({ status: "pending", reason: "held until ITS confirms the company" });
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.unverified"))))[0].reason).toBe("The website does not match the company.");
    expect((await setupCard(owner))?.gettingStarted).toMatchObject({ verified: false, heldMessages: 1 });
    // Today says it is a second check, not the one-time check of a new company
    const card = await setupCard(owner);
    expect(card?.title).toBe("ITS is checking your company again");
    expect(card?.body).toMatch(/^ITS is checking your company again; your ITS contact will be in touch\./);
    expect(card?.body).not.toContain("one-time check");
    // a message written from the candidate's page now is saved, and says so; it is never "on its way"
    const written = await json(owner, "POST", `/api/v1/applications/${applicationId}/messages`, { text: "Could you send us your license number?" });
    expect(written.status).toBe(201);
    expect(await written.json()).toMatchObject({ ok: true, status: "held" });
    expect((await setupCard(owner))?.gettingStarted?.heldMessages).toBe(2);
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "company.unverified")))).length).toBeGreaterThanOrEqual(1);
    // confirmed again for the next checks: the same 30 days, never restarted by a confirmation taken back and given again
    expect((await verify(admin, { verified: true, reason: "Spoke with the owner; the website was updated.", confirm: true })).status).toBe(200);
    await container.drain();
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    expect(co.settings.trial).toEqual(trialTerm);
    expect(await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "trial.started")))).toHaveLength(1);
  });
});

/**
 * What the check means for the job boards and the closing date (Wave S5, rows 58 and 63): a Colorado job that opens
 * while ITS has not confirmed the company gets its thirty-day default closing date only when ITS confirms it (the job
 * goes public then), and taking the confirmation back closes every board listing that was up and names it for taking
 * down, so no candidate meets a listing whose apply link leads nowhere.
 */
describe("the company check, the boards and Colorado's closing date", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let admin = "";
  let companyId = "";
  let roleId = "";
  const BASE = Date.now();
  const setClock = (ms: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + ms); };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const verify = (verified: boolean, reason: string) => json(admin, "POST", `/api/v1/admin/customers/${companyId}/verification`, { verified, reason, confirm: true });
  const roleRow = async () => (await container.db.select().from(roles).where(eq(roles.id, roleId)))[0];

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", COMPANY_CHECK: "its", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false" } });
    app = createApp(container);
    setClock(0);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@colorado.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    ({ id: companyId } = (await (await json(owner, "POST", "/api/v1/companies", { name: "Mile High Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Denver", region: "CO", country: "US" }] })).json()) as { id: string });
    // Colorado's legal check asks for the benefits on the ad: described once for the company
    const [co] = await container.db.select({ s: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: { ...co.s, benefitsSummary: "Health and dental insurance, 401(k) with match, paid time off." } }).where(eq(companies.id, companyId));
    admin = await signInAdmin(app, container, "ana.admin@identifiedtalent.com", "Ana Admin");
  });
  afterAll(async () => {
    await container.close();
  });

  it("a Colorado job that opens before the check has no closing date yet; the thirty days start when ITS confirms the company", async () => {
    const started = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Denver, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${started.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await container.drain();
    const [pv] = await container.db.select().from(rolePackets).where(and(eq(rolePackets.roleId, roleId), eq(rolePackets.version, 1)));
    const packet = structuredClone(pv.packet);
    packet.identity.locations = [{ city: "Denver", region: "CO", country: "US" }];
    await container.db.update(rolePackets).set({ packet }).where(eq(rolePackets.id, pv.id));
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1 })).status).toBe(200);
    await container.drain();
    expect(await roleRow()).toMatchObject({ status: "open", applicationsCloseOn: null });
    // ITS confirms the company ten days later: the job goes public now, and its thirty days start now
    setClock(10 * 86_400_000);
    expect((await verify(true, "Kick-off call held; website and phone checked.")).status).toBe(200);
    await container.drain();
    const [company] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const role = await roleRow();
    expect(role.applicationsCloseOn).toBe(defaultClosingDate(new Date(BASE + 10 * 86_400_000), company.timezone));
    const set = (await container.db.select().from(events).where(and(eq(events.type, "role.closing_date_set"), eq(events.subjectId, roleId)))).at(-1);
    expect(set?.payload).toMatchObject({ defaulted: true, closesOn: role.applicationsCloseOn });
    const timers = await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "role_closing_date"));
    expect(timers.filter((t) => t.status === "waiting").map((t) => (t.state as { roleId: string }).roleId)).toContain(roleId);
    // confirming again leaves the date alone
    expect((await verify(true, "Checked again, still fine.")).status).toBe(200);
    expect((await roleRow()).applicationsCloseOn).toBe(role.applicationsCloseOn);
  });

  it("taking the confirmation back closes every board listing that was up and names it for taking down; one not posted yet is left alone", async () => {
    const rows = await container.db.select().from(postings).where(eq(postings.roleId, roleId));
    const indeed = rows.find((p) => p.channel === "indeed");
    if (indeed) await container.db.update(postings).set({ status: "posted_manually", externalUrl: "https://www.indeed.com/viewjob?jk=abc123" }).where(eq(postings.id, indeed.id));
    else await withTenant(container.db, companyId, (tx) => tx.insert(postings).values({ companyId, roleId, channel: "indeed", status: "posted_manually", externalUrl: "https://www.indeed.com/viewjob?jk=abc123" }));
    const linkedin = rows.find((p) => p.channel === "linkedin_basic");
    if (linkedin) await container.db.update(postings).set({ status: "ready_to_post" }).where(eq(postings.id, linkedin.id));
    expect((await verify(false, "The website does not match the company.")).status).toBe(200);
    const after = await container.db.select().from(postings).where(eq(postings.roleId, roleId));
    expect(after.find((p) => p.channel === "indeed")).toMatchObject({ status: "closed", closureRequired: true, closureConfirmedAt: null });
    if (linkedin) expect(after.find((p) => p.channel === "linkedin_basic")?.status).toBe("ready_to_post");
    // the careers page is not a board: it goes offline with the company, and nothing has to be taken down by hand
    expect(after.filter((p) => p.closureRequired).map((p) => p.channel)).toEqual(["indeed"]);
    const named = await container.db.select().from(events).where(and(eq(events.type, "posting.closure_required"), eq(events.companyId, companyId)));
    expect(named.map((e) => (e.payload as { channel: string }).channel)).toEqual(["indeed"]);
    const told = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "company.unverified")))).at(-1);
    expect(told?.body).toContain("The job-board listing that was up is closed and must be taken down");
    const audited = (await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.unverified")))).at(-1);
    expect(audited?.details).toMatchObject({ boardsClosed: 1 });
  });
});

/**
 * Releasing what waited: oldest first, an email at once, a text not before the hours the company may text candidates
 * (the legal window, narrowed by the company's contact hours), each recorded as released.
 */
describe("releasing held messages", () => {
  let container: Container;
  let companyId = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", COMPANY_CHECK: "its", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    const app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@release.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    const owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await app.request("/api/v1/companies", { method: "POST", headers: { "content-type": "application/json", cookie: owner }, body: JSON.stringify({ name: "Release Dental", vertical: "dental", sizeBand: "1-19", timezone: "America/Chicago", locations: [{ city: "Austin", region: "TX", country: "US" }] }) })).json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("queues an email at once and a text at the next allowed hour, oldest first, and records each", async () => {
    const actor = { kind: "system" as const, id: "release_test" };
    const candidateId = uuidv7();
    const held = (channel: "email" | "sms", key: string, createdAt: string) => withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId, direction: "outbound", channel, fromAddress: "x", toAddress: channel === "sms" ? "+15125550100" : "pat@example.com", bodyText: "Hello", templateKey: "screen_invite", provider: "fake", status: HELD_STATUS, sentBy: actor, idempotencyKey: key, createdAt }).returning({ id: communications.id }));
    const [text] = await held("sms", `held-sms:${uuidv7()}`, "2026-10-01T10:00:00.000Z");
    const [mail] = await held("email", `held-email:${uuidv7()}`, "2026-10-01T09:00:00.000Z");
    // 23:30 in Chicago on a Wednesday: an email may go, a text waits for 08:00 Thursday (13:00 UTC)
    const now = new Date("2026-10-08T04:30:00.000Z");
    const released = await withTenant(container.db, companyId, (tx) => releaseHeldCommunications(tx, { companyId, actor, now }));
    expect(released).toBe(2);
    const sends = (await container.db.select().from(jobs).where(eq(jobs.kind, "communication.send")).orderBy(jobs.id)).filter((j) => [text.id, mail.id].includes(String(j.payload.communicationId)));
    const runAt = (id: string) => new Date(sends.find((j) => j.payload.communicationId === id)!.runAt).toISOString();
    expect(runAt(mail.id)).toBe(now.toISOString());
    expect(runAt(text.id)).toBe("2026-10-08T13:00:00.000Z");
    // the older message is queued first
    expect(sends.map((j) => j.payload.communicationId)).toEqual([mail.id, text.id]);
    for (const id of [text.id, mail.id]) expect((await container.db.select().from(communications).where(eq(communications.id, id)))[0].status).toBe("queued");
    expect((await container.db.select().from(events).where(eq(events.type, "message.released"))).map((e) => e.subjectId).sort()).toEqual([text.id, mail.id].sort());
  });

  let roleId = "";
  const actor = { kind: "system" as const, id: "release_test" };
  /** A candidate with an application in the given stage. */
  const person = (stage: ApplicationStage, over: Partial<typeof candidates.$inferInsert> = {}) => withTenant(container.db, companyId, async (tx) => {
    const [cand] = await tx.insert(candidates).values({ companyId, firstName: "Pat", lastName: stage, email: `pat.${stage}.${uuidv7()}@example.com`, phone: "+15125550111", firstSource: "direct", ...over }).returning();
    const [a] = await tx.insert(applications).values({ companyId, roleId, candidateId: cand.id, packetVersion: 1, source: "direct", stage, statusToken: randomToken(16) }).returning();
    return { candidateId: cand.id, applicationId: a.id };
  });
  const heldFor = (who: { candidateId: string; applicationId: string }, channel: "email" | "sms", templateKey: string) => withTenant(container.db, companyId, async (tx) => (await tx.insert(communications).values({ companyId, candidateId: who.candidateId, applicationId: who.applicationId, direction: "outbound", channel, fromAddress: "x", toAddress: channel === "sms" ? "+15125550111" : "pat@example.com", bodyText: "Hello", templateKey, provider: "fake", status: HELD_STATUS, sentBy: actor, idempotencyKey: `held:${uuidv7()}` }).returning({ id: communications.id }))[0].id);
  const statusOf = async (id: string) => (await container.db.select().from(communications).where(eq(communications.id, id)))[0];

  it("calls no role quiet, and no invitation unanswered, while nothing of the company can be seen", async () => {
    roleId = await withTenant(container.db, companyId, async (tx) => (await tx.insert(roles).values({ companyId, title: "Front desk", status: "open", openedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), createdBy: actor }).returning({ id: roles.id }))[0].id);
    const detected = await withTenant(container.db, companyId, (tx) => detectStuckRoles(tx, companyId, new Date()));
    expect(detected.map((d) => d.detector)).not.toContain("no_applicants");
  });

  it("cancels what must no longer go when it is released: texts to someone who stopped them, invitations to someone who left; the decision itself still goes", async () => {
    const stopped = await person("triaged", { consent: { sms: { granted: true, at: "2026-10-01T00:00:00.000Z", source: "apply_form" } }, preferences: { smsOptOut: true } });
    const left = await person("withdrawn");
    const declined = await person("rejected");
    const text = await heldFor(stopped, "sms", "screen_invite");
    const invite = await heldFor(left, "email", "screen_invite");
    const lateInvite = await heldFor(declined, "email", "screen_invite");
    const decision = await heldFor(declined, "email", "disposition:human");
    const released = await withTenant(container.db, companyId, (tx) => releaseHeldCommunications(tx, { companyId, actor, now: new Date() }));
    expect(released).toBe(1);
    expect((await statusOf(decision)).status).toBe("queued");
    expect(await statusOf(text)).toMatchObject({ status: "cancelled", error: "the candidate stopped text messages" });
    for (const id of [invite, lateInvite]) expect(await statusOf(id)).toMatchObject({ status: "cancelled", error: "the candidate has left the process since it was written" });
    expect((await container.db.select().from(events).where(eq(events.type, "message.cancelled"))).map((e) => e.subjectId).sort()).toEqual([text, invite, lateInvite].sort());
  });

  it("cancels a held link to a step that ended while it waited (a screen that lapsed, interview times no longer on offer); the closing note still goes, and an open step's link goes", async () => {
    const screen = (who: { applicationId: string }, status: string) => withTenant(container.db, companyId, (tx) => tx.insert(screens).values({ companyId, applicationId: who.applicationId, channel: "web", status, token: randomToken(24) }));
    const offer = (who: { applicationId: string }, status: string) => withTenant(container.db, companyId, (tx) => tx.insert(interviews).values({ companyId, applicationId: who.applicationId, roundKey: "first", title: "First interview", format: "video", durationMinutes: 30, status }));
    // invited the day the check was taken back; the link lapsed a week later, while every message waited
    const lapsed = await person("screen_invited");
    await screen(lapsed, "expired");
    const deadInvite = await heldFor(lapsed, "email", "screen_invite");
    const deadReminder = await heldFor(lapsed, "email", "screen_reminder");
    const closingNote = await heldFor(lapsed, "email", "screen_expired");
    // still open: its invitation goes
    const open = await person("screen_invited");
    await screen(open, "invited");
    const liveInvite = await heldFor(open, "email", "screen_invite");
    // interview times offered, never picked, and the offer lapsed; another's offer is still open
    const missed = await person("interview_recommended");
    await offer(missed, "offer_expired");
    const deadSlots = await heldFor(missed, "email", "interview_slots");
    const deadSlotsReminder = await heldFor(missed, "email", "interview_slots_reminder");
    const picking = await person("interview_recommended");
    await offer(picking, "scheduling");
    const liveSlots = await heldFor(picking, "email", "interview_slots");
    await withTenant(container.db, companyId, (tx) => releaseHeldCommunications(tx, { companyId, actor, now: new Date() }));
    for (const id of [deadInvite, deadReminder, deadSlots, deadSlotsReminder]) expect(await statusOf(id)).toMatchObject({ status: "cancelled", error: "the step it invites to has ended since it was written" });
    for (const id of [closingNote, liveInvite, liveSlots]) expect((await statusOf(id)).status).toBe("queued");
  });

  it("once confirmed: a text waiting for its hour is cancelled at send time if the candidate stopped texts meanwhile, and a quiet role is worth a nudge", async () => {
    await withPlatform(container.db, (tx) => tx.update(companies).set({ settings: { verifiedAt: new Date().toISOString(), verifiedBy: actor } }).where(eq(companies.id, companyId)));
    const someone = await person("screen_invited", { consent: { sms: { granted: true, at: "2026-10-01T00:00:00.000Z", source: "apply_form" } } });
    const [queued] = await withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId: someone.candidateId, applicationId: someone.applicationId, direction: "outbound", channel: "sms", fromAddress: "x", toAddress: "+15125550111", bodyText: "Your screen is waiting", templateKey: "screen_reminder", provider: "fake", status: "queued", sentBy: actor, idempotencyKey: `queued:${uuidv7()}` }).returning({ id: communications.id }));
    // they text STOP before the job runs
    await withTenant(container.db, companyId, (tx) => tx.update(candidates).set({ preferences: { smsOptOut: true } }).where(eq(candidates.id, someone.candidateId)));
    await container.db.insert(jobs).values({ kind: "communication.send", payload: { communicationId: queued.id, companyId } });
    await container.drain();
    expect(await statusOf(queued.id)).toMatchObject({ status: "cancelled", error: "the candidate stopped text messages" });
    // a role nobody has applied to in three weeks, now that it can be seen, is worth a nudge
    const quiet = await withTenant(container.db, companyId, async (tx) => (await tx.insert(roles).values({ companyId, title: "Back office", status: "open", openedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), createdBy: actor }).returning({ id: roles.id }))[0].id);
    const detected = await withTenant(container.db, companyId, (tx) => detectStuckRoles(tx, companyId, new Date()));
    expect(detected.find((d) => d.roleId === quiet && d.detector === "no_applicants")).toBeTruthy();
  });
});

/**
 * The getting-started steps after the check: ITS confirms job-board access, an owner or admin marks the AI rules as
 * reviewed (audited), anyone may hide the steps for themselves only, and "Draft it with an ITS recruiter" asks once.
 */
describe("getting started: ticks, hiding, and drafting the first role with ITS", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  type Card = { kind: string; title: string; actions: Array<{ label: string; method: string; path: string; body?: Record<string, unknown> }>; gettingStarted?: GettingStarted };
  const setupCard = async (cookie: string) => ((await (await json(cookie, "GET", "/api/v1/brief")).json()) as { cards: Card[] }).cards.find((c) => c.kind === "getting_started");

  beforeAll(async () => {
    // The test default (COMPANY_CHECK=auto): the company is confirmed at sign-up, and that is recorded.
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@steps.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    companyId = ((await (await json(owner, "POST", "/api/v1/companies", { name: "Steps Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Austin", region: "TX", country: "US" }] })).json()) as { id: string }).id;
  });
  afterAll(async () => {
    await container.close();
  });

  it("confirms a company at once where no ITS check is needed, and records it", async () => {
    const current = (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { settings: { verifiedAt?: string; verifiedBy?: { id: string } } };
    expect(current.settings.verifiedAt).toBeTruthy();
    expect(current.settings.verifiedBy?.id).toBe("company_check_auto");
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "company.verified"))))).toHaveLength(1);
    expect((await setupCard(owner))?.gettingStarted?.verified).toBe(true);
  });

  it("asks an ITS recruiter to draft the first role once, and says so on the step", async () => {
    const first = (await setupCard(owner))?.gettingStarted?.steps.find((s) => s.key === "first_role");
    expect(first?.actions.map((a) => a.label)).toEqual(["Start a hire", "Draft it with an ITS recruiter"]);
    const ask = first!.actions[1];
    const r = await json(owner, ask.method, ask.path, ask.body);
    expect(r.status).toBe(201);
    expect(((await r.json()) as { message: string }).message).toContain("all of your hiring");
    const after = (await setupCard(owner))?.gettingStarted?.steps.find((s) => s.key === "first_role");
    expect(after?.actions.map((a) => a.label)).toEqual(["Start a hire"]);
    expect(after?.detail).toContain("You asked an ITS recruiter");
  });

  it("ticks job-board access when ITS confirms it, and the AI rules when an owner or admin has reviewed them", async () => {
    const admin = await signInAdmin(app, container, "ben.admin@identifiedtalent.com", "Ben Admin");
    expect((await json(owner, "POST", `/api/v1/admin/customers/${companyId}/job-boards`, { confirmed: true })).status).toBe(403);
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/job-boards`, { confirmed: true })).status).toBe(200);
    expect((await setupCard(owner))?.gettingStarted?.steps.find((s) => s.key === "job_boards")?.done).toBe(true);
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager" });
    expect((await json(hm, "POST", "/api/v1/companies/current/getting-started", { action: "policies_reviewed" })).status).toBe(403);
    expect((await json(owner, "POST", "/api/v1/companies/current/getting-started", { action: "something_else" })).status).toBe(400);
    expect((await json(owner, "POST", "/api/v1/companies/current/getting-started", { action: "policies_reviewed", extra: 1 })).status).toBe(400);
    const rules = (await setupCard(owner))?.gettingStarted?.steps.find((s) => s.key === "ai_rules");
    const reviewed = rules!.actions.find((a) => a.method === "POST")!;
    expect((await json(owner, reviewed.method, reviewed.path, reviewed.body)).status).toBe(200);
    expect((await setupCard(owner))?.gettingStarted?.steps.find((s) => s.key === "ai_rules")?.done).toBe(true);
    const history = (await (await json(owner, "GET", "/api/v1/companies/current/audit?actions=company.updated")).json()) as Array<{ description: string }>;
    expect(history.map((h) => h.description)).toEqual(expect.arrayContaining([expect.stringContaining("the AI rules marked as reviewed"), expect.stringContaining("job-board access, confirmed by ITS")]));
    // taking job-board access back unticks it
    expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/job-boards`, { confirmed: false })).status).toBe(200);
    expect((await setupCard(owner))?.gettingStarted?.steps.find((s) => s.key === "job_boards")?.done).toBe(false);
  });

  it("hides the steps for the person who asked only", async () => {
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hm@steps.test" });
    expect(await setupCard(hm)).toBeDefined();
    const card = await setupCard(owner);
    expect(card?.actions).toEqual([{ label: "Hide these steps", method: "POST", path: "/api/v1/companies/current/getting-started", body: { action: "dismiss" } }]);
    expect((await json(owner, "POST", card!.actions[0].path, card!.actions[0].body)).status).toBe(200);
    expect(await setupCard(owner)).toBeUndefined();
    expect(await setupCard(hm)).toBeDefined();
  });

  it("a company that was running before the check began gets no steps: ITS set it up by hand (migration 0027)", async () => {
    const hm = await signInAs(container, app, { companyId, role: "hiring_manager", email: "hm.before@steps.test" });
    expect(await setupCard(hm)).toBeDefined();
    const [co] = await container.db.select().from(companies).where(eq(companies.id, companyId));
    await withPlatform(container.db, (tx) => tx.update(companies).set({ settings: { ...co.settings, verifiedBy: { kind: "system", id: "migration_0027", name: "Existing company, confirmed when the ITS check began" } } }).where(eq(companies.id, companyId)));
    expect(await setupCard(hm)).toBeUndefined();
  });
});

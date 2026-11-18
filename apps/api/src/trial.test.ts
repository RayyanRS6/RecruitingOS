import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { CLOSING_DATE_REASON, entitlements } from "@ros/core";
import { TRIAL_ENDED_LINE, TRIAL_PLAN_KEY, type AdminCompany, type CompanyView, type PlanChangeAnswer, type PlanLimitDetails, type TrialExtensionAnswer } from "@ros/contracts";
import { adminAlerts, applications, auditRecords, candidates, companies, dataRequests, events, notifications, roles, screens, users, withPlatform } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { resetSitemapCache } from "./pages/sitemap";
import { settleTrials } from "./services/trial";
import { plantApplicant, plantJob, signInAdmin, useTrial } from "./test-helpers";

/**
 * The Trial plan's 30 days, end to end, with sign-up by approval and the engine's clock moved by days. The 30 days start
 * when an administrator accepts the company (accepting it again after its access was taken away never restarts them);
 * in the last 7 days the owners are told; once they are over, new applications, new jobs and new AI interviews wait for
 * a plan, while candidates read only the neutral line a job not taking applications shows, and everything already started
 * carries on. The administrators get one alert; an extension or a change of plan opens the company again.
 */
describe("the Trial plan's 30 days", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const DAY = 86_400_000;
  const BASE = (() => { const d = new Date(); d.setUTCHours(17, 0, 0, 0); return d.getTime(); })();
  /** The engine's clock, `days` after the company was accepted (day 0). */
  const setClock = (days: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + days * DAY); };
  const now = () => container.engine.clock();
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const post = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
  const decode = (html: string) => html.replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  /** What a reader sees: the page without its styles, scripts and tags. */
  const visible = (html: string) => decode(html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    return (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
  };
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: PlanLimitDetails } }).error;
  /** The trial as the company's own people read it in Settings. */
  const standing = async (cookie = owner) => ((await (await json(cookie, "GET", "/api/v1/companies/current")).json()) as CompanyView).plan.trial;
  /** The company's row on the admin dashboard. */
  const row = async (id = companyId) => ((await (await json(admin, "GET", "/api/v1/admin/customers")).json()) as AdminCompany[]).find((c) => c.id === id)!;
  const access = (id: string, body: Record<string, unknown>) => json(admin, "POST", `/api/v1/admin/customers/${id}/access`, { ...body, confirm: true });
  const termOf = async (id: string) => (await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, id)))[0].settings.trial;
  const settle = () => withPlatform(container.db, (tx) => settleTrials(tx, now()));
  let ip = 10;
  /** "Send" on the application form: who they are, the CV, and the acknowledgment. */
  const applyForm = (p: { first: string; last: string; email: string }, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email);
    fd.set("resume", new File([`${p.first} ${p.last}, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA, active\nSkills: Dentrix, periodontal charting`], "resume.txt", { type: "text/plain" }));
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    ip += 1;
    return app.request(`/careers/${slug}/jobs/${roleA}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip}` } });
  };
  const act = (applicationId: string, action: string) => json(owner, "POST", `/api/v1/applications/${applicationId}/actions`, { action });
  const applicationOf = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];

  let owner = "";
  let ownerId = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let roleA = "";
  let roleB = "";
  let graceFormOpened = "";
  let chatToken = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", SIGNUP_MODE: "approval", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("olive@trialdental.test");
    ownerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "olive@trialdental.test")))[0].id;
    const r = await json(owner, "POST", "/api/v1/companies", { name: "Harbor Smile Dental", vertical: "dental", sizeBand: "1-19", ownerName: "Olive Owner", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status).toBe(201);
    companyId = ((await r.json()) as { id: string }).id;
    // a new company starts on Free; this one is on Trial, as a company that asked for access earlier is
    await useTrial(container, companyId);
    admin = await signInAdmin(app, container, "ana.admin@identifiedtalent.com", "Ana Admin");
  });
  afterAll(async () => {
    await container.close();
  });

  it("the 30 days start when an administrator accepts the company, and accepting it again later does not restart them", async () => {
    // waiting for an answer: on Trial, and nothing has started
    expect(await row()).toMatchObject({ status: "waiting", planKey: TRIAL_PLAN_KEY, trial: { started: false, startedAt: null, endsAt: null, daysLeft: null, endingSoon: false, ended: false, extendedDays: 0 }, trialTerm: null });
    expect((await settle()).started).toBe(0);
    expect((await access(companyId, { decision: "accept", from: "requested" })).status).toBe(200);
    await container.drain();
    const term = await termOf(companyId);
    expect(term).toEqual({ startedAt: new Date(BASE).toISOString(), endsAt: new Date(BASE + 30 * DAY).toISOString(), startedBy: "its_check" });
    expect(await row()).toMatchObject({ status: "active", trial: { started: true, daysLeft: 30, ended: false }, trialTerm: term });
    expect(await standing()).toEqual({ started: true, startedAt: term!.startedAt, endsAt: term!.endsAt, daysLeft: 30, endingSoon: false, ended: false, extendedDays: 0 });
    const told = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.access_accepted")));
    expect(told).toHaveLength(1);
    expect(told[0].body).toMatch(/^You can start now\. Your 30-day trial starts today and ends on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/);
    expect(await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "trial.started")))).toHaveLength(1);
    expect(await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "trial.started")))).toHaveLength(1);
    slug = (await container.db.select({ slug: companies.slug }).from(companies).where(eq(companies.id, companyId)))[0].slug;
    roleA = await plantJob(container, { companyId, title: "Dental Hygienist" });
    resetSitemapCache(container);
    expect(await (await app.request("/sitemap.xml")).text()).toContain(roleA);
    // a day later its access is taken away and given back: the same 30 days, and nobody is told a trial started again
    setClock(1);
    expect((await access(companyId, { decision: "remove" })).status).toBe(200);
    expect(await termOf(companyId)).toEqual(term);
    expect((await access(companyId, { decision: "accept", from: "declined" })).status).toBe(200);
    await container.drain();
    expect(await termOf(companyId)).toEqual(term);
    expect(await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "trial.started")))).toHaveLength(1);
    const back = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.access_restored")));
    expect(back.map((n) => n.body)).toEqual(["You can sign in and pick up where you left off."]);
    // taking access away ended the owner's session here: she signs in again
    owner = await signIn("olive@trialdental.test");
    expect(await standing()).toMatchObject({ started: true, daysLeft: 29, ended: false });
  });

  it("in the last 7 days the owners see when the trial ends, and are emailed a week and a day before, once each", async () => {
    const ending = () => container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.trial_ending"))).orderBy(notifications.createdAt);
    setClock(22);
    expect(await standing()).toMatchObject({ endingSoon: false });
    expect((await settle()).warned).toBe(0);
    setClock(24);
    expect(await standing()).toMatchObject({ started: true, endingSoon: true, ended: false, daysLeft: 6 });
    expect((await settle()).warned).toBe(1);
    expect((await settle()).warned).toBe(0);
    const week = await ending();
    expect(week).toHaveLength(1);
    expect(week[0].title).toMatch(/^Your trial ends on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
    expect(week[0].body).toContain("new applications, new jobs and new AI interviews pause until a plan is chosen; everything already started carries on.");
    // the notice leads to Settings, whose Plan section shows the date
    expect(week[0].action).toEqual({ label: "See your plan", href: "/setup" });
    // the last day: one more notice, "tomorrow", and nothing again within the day
    setClock(29.2);
    expect((await settle()).warned).toBe(1);
    expect((await settle()).warned).toBe(0);
    const both = await ending();
    expect(both).toHaveLength(2);
    expect(both[1].title).toBe("Your trial ends tomorrow");
    expect(both[1].body).toMatch(/^Your trial ends tomorrow, [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\./);
    const term = await termOf(companyId);
    expect(term).toMatchObject({ soonNoticeFor: term?.endsAt, lastDayNoticeFor: term?.endsAt });
    // the account email goes to the owner as it happens
    await container.drain();
    const mail = (container.integrations.email as unknown as { sent: Array<{ to: string; subject: string }> }).sent.filter((m) => m.to === "olive@trialdental.test" && m.subject === "Your trial ends soon");
    expect(mail.length).toBeGreaterThanOrEqual(1);
  });

  it("before the end: someone is shortlisted and starts their AI interview, a form is open, and a second job is a draft", async () => {
    setClock(29.9);
    const early = await plantApplicant(container, { companyId, roleId: roleA, mark: "Maria" });
    const shortlisted = await act(early, "shortlist");
    expect(shortlisted.status, await shortlisted.clone().text()).toBe(200);
    await container.drain();
    chatToken = (await container.db.select({ token: screens.token }).from(screens).where(eq(screens.applicationId, early)))[0]?.token ?? "";
    expect(chatToken).not.toBe("");
    expect((await post(`/c/screen/${chatToken}/start`)).status).toBe(302);
    const form = await app.request(`/careers/${slug}/jobs/${roleA}/apply`);
    expect(form.status).toBe(200);
    graceFormOpened = (await form.text()).match(/<input type="hidden" name="formOpened" value="([^"]+)"/)![1];
    roleB = await plantJob(container, { companyId, title: "Front Desk Coordinator", status: "draft" });
  });

  it("once the 30 days are over, candidates read the neutral line and nothing about a trial or a plan", async () => {
    setClock(30.5);
    expect(await standing()).toMatchObject({ ended: true, endingSoon: false, daysLeft: 0 });
    const job = await app.request(`/careers/${slug}/jobs/${roleA}`);
    expect(job.status).toBe(200);
    const jobHtml = await job.text();
    expect(visible(jobHtml)).toContain("This position is not taking new applications right now.");
    expect(jobHtml).not.toContain(`/careers/${slug}/jobs/${roleA}/apply"`);
    // the JobPosting data stays, as on a paused job's page, and says the job stopped on the day the trial ended, so
    // search engines stop listing it as the sitemap does
    expect(jobHtml).toContain('<script type="application/ld+json"');
    const jsonLd = JSON.parse(jobHtml.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/)![1]) as { validThrough?: string };
    expect(jsonLd.validThrough).toBe(new Date(BASE + 30 * DAY).toISOString().slice(0, 10));
    const careers = visible(await (await app.request(`/careers/${slug}`)).text());
    expect(careers).toContain("Not taking new applications right now.");
    for (const words of [visible(jobHtml), careers]) {
      expect(words).not.toMatch(/\btrials?\b/i);
      expect(words).not.toMatch(/choose a plan|your plan|a plan is chosen|contact ITS/i);
      expect(words).not.toContain(TRIAL_ENDED_LINE);
    }
    // the form, its upload and its sending all answer as a job not taking applications does
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply`)).status).toBe(404);
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/upload-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "cv.pdf", size: 1000, type: "application/pdf" }) })).status).toBe(404);
    expect((await applyForm({ first: "Late", last: "Comer", email: "late.comer@example.com" })).status).toBe(404);
    expect(await container.db.select().from(candidates).where(eq(candidates.email, "late.comer@example.com"))).toHaveLength(0);
  });

  it("a form opened before the end and sent within the grace window is still taken", async () => {
    const r = await applyForm({ first: "Grace", last: "Window", email: "grace.window@example.com" }, { formOpened: graceFormOpened });
    expect(r.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, "grace.window@example.com"));
    expect(cand).toBeTruthy();
    expect(await container.db.select().from(applications).where(and(eq(applications.candidateId, cand.id), eq(applications.roleId, roleA)))).toHaveLength(1);
    // a form opened now gets no grace (it is not even shown), and a made-up value none either
    expect((await applyForm({ first: "Not", last: "Graced", email: "not.graced@example.com" }, { formOpened: "v1.made-up" })).status).toBe(404);
  });

  it("the sitemap follows", async () => {
    resetSitemapCache(container);
    expect(await (await app.request("/sitemap.xml")).text()).not.toContain(roleA);
  });

  it("no new job starts: the job builder answers 402 limit_reached with the owner's line and the request to ITS", async () => {
    const r = await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a front desk coordinator in Irvine, $22 to $26 an hour, full time." });
    expect(r.status).toBe(402);
    const err = await errorOf(r);
    expect(err).toMatchObject({ code: "limit_reached", message: TRIAL_ENDED_LINE });
    expect(err.details).toMatchObject({ upgrade: true, ask: { label: "Ask ITS to choose a plan", reason: "Our trial has ended. We would like to choose a plan." }, room: { ok: false, trialEnded: true, message: TRIAL_ENDED_LINE, holding: [] } });
  });

  it("publishing a new job, resuming one and a reopening closing date wait for a plan (402)", async () => {
    const paused = async (r: Response) => {
      expect(r.status).toBe(402);
      const err = await errorOf(r);
      expect(err).toMatchObject({ code: "trial_ended", message: TRIAL_ENDED_LINE });
      expect(err.details).toEqual({ upgrade: true, ask: { label: "Ask ITS to choose a plan", reason: "Our trial has ended. We would like to choose a plan." } });
    };
    await paused(await json(owner, "POST", `/api/v1/roles/${roleB}/publish`));
    expect((await container.db.select().from(roles).where(eq(roles.id, roleB)))[0].status).toBe("draft");
    // pausing is never refused; resuming is new applications
    expect((await json(owner, "POST", `/api/v1/roles/${roleA}/pause`, {})).status).toBe(200);
    await paused(await json(owner, "POST", `/api/v1/roles/${roleA}/resume`, {}));
    await container.db.update(roles).set({ status: "open", pausedAt: null }).where(eq(roles.id, roleA));
    // a closing date that stopped applications, moved later, would reopen them: it waits; a plain date change does not
    await container.db.update(roles).set({ acceptingApplications: false, applicationsClosedReason: CLOSING_DATE_REASON, applicationsClosedAt: now().toISOString(), applicationsCloseOn: new Date(now().getTime() - 2 * DAY).toISOString().slice(0, 10) }).where(eq(roles.id, roleA));
    const later = new Date(now().getTime() + 20 * DAY).toISOString().slice(0, 10);
    await paused(await json(owner, "POST", `/api/v1/roles/${roleA}/closing-date`, { closesOn: later }));
    expect((await container.db.select().from(roles).where(eq(roles.id, roleA)))[0].applicationsCloseOn?.slice(0, 10)).not.toBe(later);
    expect((await json(owner, "POST", `/api/v1/roles/${roleB}/closing-date`, { closesOn: later })).status).toBe(200);
    await container.db.update(roles).set({ acceptingApplications: true, applicationsClosedReason: null, applicationsClosedAt: null, applicationsCloseOn: null }).where(eq(roles.id, roleA));
  });

  it("everything already started carries on: the team decides on existing candidates, and a new AI interview waits for a plan", async () => {
    // a new AI interview is new work: it waits for a plan, with the owners' line and the way to ask ITS
    const dan = await plantApplicant(container, { companyId, roleId: roleA, mark: "Dan" });
    const shortlist = await act(dan, "shortlist");
    expect(shortlist.status, await shortlist.clone().text()).toBe(402);
    expect(await errorOf(shortlist)).toMatchObject({ code: "trial_ended", message: TRIAL_ENDED_LINE, details: { upgrade: true, ask: { label: "Ask ITS to choose a plan" } } });
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, dan))).toHaveLength(0);
    expect((await applicationOf(dan)).stage).toBe("triaged");
    // a decision on someone already here is made and told as ever
    const cara = await plantApplicant(container, { companyId, roleId: roleA, mark: "Cara" });
    expect((await act(cara, "reject")).status).toBe(200);
    const sent = await act(cara, "send_decision");
    expect(sent.status, await sent.clone().text()).toBe(200);
    await container.drain();
    // and the candidate can still ask for their information
    const application = await applicationOf(cara);
    const r = await post(`/c/status/${application.statusToken}/privacy`, { kind: "access", details: "Please send what you hold about me." });
    expect(r.status).toBe(302);
    expect(await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, application.candidateId), eq(dataRequests.kind, "access")))).toHaveLength(1);
  });

  it("an AI interview started before the end goes on: its page opens and takes the candidate's answer", async () => {
    const page = await app.request(`/c/screen/${chatToken}`);
    expect(page.status).toBe(200);
    const words = visible(await page.text());
    expect(words).not.toMatch(/\btrials?\b/i);
    expect(words).not.toContain(TRIAL_ENDED_LINE);
    expect((await post(`/c/screen/${chatToken}`, { message: "Nine patients a day, charting in Dentrix and perio maintenance." })).status).toBe(302);
    expect((await app.request(`/c/screen/${chatToken}`)).status).toBe(200);
  });

  it("the hourly check tells the administrators once and the owners once; a second run adds nothing", async () => {
    expect(await settle()).toMatchObject({ ended: 1 });
    expect(await settle()).toMatchObject({ ended: 0 });
    const alerts = await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId)));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "high", status: "open", title: "Harbor Smile Dental's trial has ended" });
    expect(alerts[0].body).toContain("Change the plan, or extend the trial, on the company's page in the admin dashboard.");
    const told = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.trial_ended")));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: "Your trial has ended", body: TRIAL_ENDED_LINE, action: { label: "See your plan", href: "/setup" } });
    expect(await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "trial.ended")))).toHaveLength(1);
    expect((await termOf(companyId))?.endNoticeAt).toBeTruthy();
    // the dashboard's row says the same
    expect((await row()).trial).toMatchObject({ ended: true });
  });

  it("a live company put on Trial with no dates gets 30 days from the hourly check, never an instant lock", async () => {
    const other = await signIn("omar@oldtrial.test");
    const made = (await (await json(other, "POST", "/api/v1/companies", { name: "Old Trial Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    // accepted on Free (no dates to write), and on Trial since, with no dates
    expect((await access(made.id, { decision: "accept", from: "requested" })).status).toBe(200);
    expect(await termOf(made.id)).toBeUndefined();
    await withPlatform(container.db, (tx) => entitlements.applyPlan(tx, made.id, TRIAL_PLAN_KEY, "trial"));
    expect(await standing(other)).toMatchObject({ started: false, ended: false });
    const settled = await settle();
    expect(settled.started).toBe(1);
    expect(await termOf(made.id)).toEqual({ startedAt: now().toISOString(), endsAt: new Date(now().getTime() + 30 * DAY).toISOString(), startedBy: "switched_on" });
    expect(await standing(other)).toMatchObject({ started: true, ended: false, daysLeft: 30 });
    const [notice] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, made.id), eq(notifications.kind, "company.trial_started")));
    expect(notice).toMatchObject({ title: "Your 30-day trial has started" });
    expect(notice.body).toMatch(/^Your 30-day trial runs until [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/);
    // a second run starts nothing more
    expect((await settle()).started).toBe(0);
  });

  it("a company still waiting for an answer, or declined, starts no trial and has none to extend", async () => {
    const waiting = await signIn("wanda@waiting.test");
    const made = (await (await json(waiting, "POST", "/api/v1/companies", { name: "Waiting Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    await useTrial(container, made.id);
    expect((await settle()).started).toBe(0);
    expect(await termOf(made.id)).toBeUndefined();
    const extend = await json(admin, "POST", `/api/v1/admin/customers/${made.id}/trial`, { days: 14, reason: "Asked before it was accepted.", confirm: true });
    expect(extend.status).toBe(409);
    expect((await errorOf(extend)).code).toBe("access_request_open");
    expect((await access(made.id, { decision: "decline", from: "requested" })).status).toBe(200);
    expect((await settle()).started).toBe(0);
    expect((await row(made.id)).trial).toMatchObject({ started: false });
  });

  it("an extension takes the company out of the pause", async () => {
    for (const bad of [{ days: 14, reason: "The owner's kick-off call moved." }, { days: 0, reason: "The owner's kick-off call moved.", confirm: true }, { days: 91, reason: "The owner's kick-off call moved.", confirm: true }, { days: 14, reason: "no", confirm: true }]) {
      expect((await json(admin, "POST", `/api/v1/admin/customers/${companyId}/trial`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/trial`, { days: 14, reason: "The owner's kick-off call moved.", confirm: true });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as TrialExtensionAnswer;
    expect(body).toMatchObject({ ok: true, companyId, trial: { started: true, ended: false, extendedDays: 14, endsAt: new Date(now().getTime() + 14 * DAY).toISOString() } });
    await container.drain();
    expect((await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId))))[0].status).toBe("resolved");
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply`)).status).toBe(200);
    const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "trial.extended")));
    expect(audited).toHaveLength(1);
    expect(audited[0].reason).toBe("The owner's kick-off call moved.");
    const notices = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.trial_extended"))).orderBy(notifications.createdAt);
    expect(notices[notices.length - 1].body).toMatch(/^ITS extended your trial to .+\. New applications are open again\.$/);
    // only an administrator extends a trial
    expect((await json(owner, "POST", `/api/v1/admin/customers/${companyId}/trial`, { days: 14, reason: "We would like more time.", confirm: true })).status).toBe(403);
  });

  it("a change of plan ends the trial: the pause lifts and the alert is resolved", async () => {
    setClock(30.5 + 15);
    expect(await standing()).toMatchObject({ ended: true });
    await settle();
    expect((await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId), eq(adminAlerts.status, "open"))))).toHaveLength(1);
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "pro", reason: "The owner chose Pro." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()) as PlanChangeAnswer).toMatchObject({ trialEnded: true, unlocked: 0 });
    await container.drain();
    expect((await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId), eq(adminAlerts.status, "open"))))).toHaveLength(0);
    expect(await standing()).toBeNull();
    expect(await row()).toMatchObject({ planKey: "pro", trial: null });
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply`)).status).toBe(200);
    // new jobs again: the draft publishes
    expect((await json(owner, "POST", `/api/v1/roles/${roleB}/publish`)).status).toBe(200);
    const latest = (await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "plan.changed"))).orderBy(desc(events.occurredAt)))[0];
    expect(latest.payload).toMatchObject({ from: "trial", to: "pro", trialEnded: true });
    // the dates stay as a record, and Trial, a retired plan, is not given again from the dashboard
    expect((await termOf(companyId))?.startedBy).toBe("its_check");
    const again = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: TRIAL_PLAN_KEY, reason: "A second look, agreed with the owner." });
    expect([again.status, (await errorOf(again)).code]).toEqual([400, "inactive_plan"]);
  });
});

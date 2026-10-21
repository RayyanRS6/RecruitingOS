import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { CLOSING_DATE_REASON, CHAT_WRAP_KEY, createApplicationLink } from "@ros/core";
import { CHAT_WRAP_QUESTION } from "@ros/agents";
import { TRIAL_ENDED_LINE, type RolePacket, type TrialStanding, type TrialTerm } from "@ros/contracts";
import { adminAlerts, applications, approvalRequests, auditRecords, candidates, companies, dataRequests, entitlements as entitlementRows, events, inboundEmails, notifications, postings, randomToken, roles, screens, users, withPlatform, withTenant } from "@ros/db";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { resetPublicFeedCache } from "./pages/public-feeds";
import { otherRolesFor } from "./services/profile-facts";
import { settleTrials } from "./services/trial";
import { followApply, signInAdmin, useOneVisitApplyFlow } from "./test-helpers";

/**
 * The Trial plan's 30 days (founder decision L-02 B, 16 October 2026), end to end with the ITS check on
 * (COMPANY_CHECK=its) and the engine's clock moved by days. The 30 days start when ITS confirms the company (confirming
 * again never restarts them); in the last 7 days the owners are told; once they are over, new applications, new jobs and
 * new screening chats wait for a plan, while candidates read only the neutral line a job not taking applications shows,
 * and everything already started carries on. ITS gets one alert; an extension or a change of plan opens the company again
 * and adds the emails held meanwhile.
 */
describe("the Trial plan's 30 days", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const DAY = 86_400_000;
  const BASE = (() => { const d = new Date(); d.setUTCHours(17, 0, 0, 0); return d.getTime(); })();
  /** The engine's clock, `days` after the company signed up (the ITS check is on day 0). */
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
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  const current = async () => (await (await json(owner, "GET", "/api/v1/companies/current")).json()) as { trial: TrialStanding | null; settings: { trial?: TrialTerm }; usage: Record<string, { used: number; limit: number | null }>; status: string };
  const termOf = async (id: string) => (await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, id)))[0].settings.trial;
  const verify = (body: Record<string, unknown>, id = companyId) => json(admin, "POST", `/api/v1/admin/customers/${id}/verification`, body);
  const inbound = (name: string) => app.request("/webhooks/postmark/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: ${name}`, TextBody: `${name} applied via Indeed.\nEmail: ${name.toLowerCase().replace(" ", ".")}@example.com`, Attachments: [] }),
  });
  const inboundRow = async (name: string) => (await container.db.select().from(inboundEmails).where(eq(inboundEmails.subject, `New applicant: ${name}`)))[0];
  const draftRole = async () => {
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    return ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
  };
  let ip = 10;
  const applyForm = (p: { first: string; last: string; email: string }, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", p.last); fd.set("email", p.email); fd.set("locationText", "Irvine, CA");
    fd.set("resume", new File([`${p.first} ${p.last}, RDH\nRegistered Dental Hygienist at Smile Bright Dental 2019 - present\nLicenses: RDH license CA, active\nSkills: Dentrix, periodontal charting`], "resume.txt", { type: "text/plain" }));
    for (const rule of packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    ip += 1;
    return app.request(`/careers/${slug}/jobs/${roleA}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ip}` } });
  };
  /** A candidate who applied earlier, straight into the tables (the apply flow is covered elsewhere). */
  const seedApplicant = (first: string) =>
    withTenant(container.db, companyId, async (tx) => {
      const [cand] = await tx.insert(candidates).values({ companyId, firstName: first, lastName: "Early", email: `${first.toLowerCase()}.early@example.com`, firstSource: "direct" }).returning();
      const [a] = await tx.insert(applications).values({ companyId, roleId: roleA, candidateId: cand.id, packetVersion: 1, source: "direct", stage: "triaged", statusToken: randomToken(16) }).returning();
      return a;
    });
  /** The chat's question now, and every answer until "Review and send" (as review-send.test.ts answers it). */
  const nowLine = (html: string) => html.match(/<li class="msg assistant now" id="question">([\s\S]*?)<\/li>/)?.[1] ?? "";
  const answerAll = async (token: string) => {
    for (let i = 0; i < 24; i++) {
      const html = decode(await (await app.request(`/c/screen/${token}`)).text());
      if (html.includes(`<form method="post" action="/c/screen/${token}/review">`) || html.includes("<h1>Check your answers</h1>")) return html;
      const asked = [...packet.screening.questions, { key: CHAT_WRAP_KEY, question: CHAT_WRAP_QUESTION }].find((q) => nowLine(html).includes(q.question))?.key;
      const fields: Record<string, string> = html.includes('<input type="hidden" name="tap" value="yes_no"/>') ? { tap: "yes_no", choice: "yes" } : html.includes('<input type="hidden" name="tap" value="pay_range"/>') ? { tap: "pay_range", min: "50", max: "54" } : asked ? { message: "Nine patients a day, charting in Dentrix and perio maintenance." } : { message: "Yes." };
      expect((await post(`/c/screen/${token}`, fields)).status).toBe(302);
    }
    throw new Error("the conversation did not reach its end");
  };

  let owner = "";
  let ownerId = "";
  let admin = "";
  let companyId = "";
  let slug = "";
  let roleA = "";
  let roleB = "";
  let packet: RolePacket;
  let intakeToken = "";
  let graceFormOpened = "";
  let chatToken = "";

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", COMPANY_CHECK: "its", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test", SMS_ENABLED: "false", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("olive@trialdental.test");
    ownerId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "olive@trialdental.test")))[0].id;
    const r = await json(owner, "POST", "/api/v1/companies", { name: "Harbor Smile Dental", vertical: "dental", sizeBand: "1-19", ownerName: "Olive Owner", locations: [{ city: "Irvine", region: "CA", country: "US" }] });
    expect(r.status).toBe(201);
    ({ id: companyId, slug } = (await r.json()) as { id: string; slug: string });
    // the conversation in the same visit as the form (a pilot company), so a chat can be under way when the trial ends
    await useOneVisitApplyFlow(container, companyId);
    // ITS raised this company's roles at a time to 3, so a second job can wait for approval beside the live one
    await withPlatform(container.db, (tx) => tx.update(entitlementRows).set({ limit: 3 }).where(and(eq(entitlementRows.companyId, companyId), eq(entitlementRows.key, "active_roles"))));
    admin = await signInAdmin(app, container, "ana.admin@identifiedtalent.com", "Ana Admin");
    expect((await json(owner, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 6 })).status).toBe(200);
    roleA = await draftRole();
    expect((await json(owner, "POST", `/api/v1/roles/${roleA}/approve`, { version: 1, note: "ok" })).status).toBe(200);
    await container.drain();
    packet = ((await (await json(owner, "GET", `/api/v1/roles/${roleA}`)).json()) as { currentPacket: { packet: RolePacket } }).currentPacket.packet;
  });
  afterAll(async () => {
    await container.close();
  });

  it("the 30 days start when ITS confirms the company, and confirming again does not restart them", async () => {
    expect((await current()).trial).toEqual({ started: false, startedAt: null, endsAt: null, daysLeft: null, endingSoon: false, ended: false, extendedDays: 0 });
    expect((await verify({ verified: true, reason: "Kick-off call with the owner.", confirm: true })).status).toBe(200);
    await container.drain();
    const term = await termOf(companyId);
    expect(term).toEqual({ startedAt: new Date(BASE).toISOString(), endsAt: new Date(BASE + 30 * DAY).toISOString(), startedBy: "its_check" });
    expect((await current()).trial).toMatchObject({ started: true, daysLeft: 30, endingSoon: false, ended: false });
    const told = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.verified")));
    expect(told.at(-1)?.body).toMatch(/Your 30-day trial starts today and ends on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\./);
    expect(await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "trial.started")))).toHaveLength(1);
    // confirmed again a day later: the same 30 days
    setClock(1);
    expect((await verify({ verified: true, reason: "Confirmed again after a call.", confirm: true })).status).toBe(200);
    expect(await termOf(companyId)).toEqual(term);
    // the job went public with the confirmation; its email address for applications exists now
    const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, roleA), eq(postings.channel, "email_in")));
    intakeToken = emailIn.intakeToken!;
    resetPublicFeedCache(container);
    expect(await (await app.request("/feeds/jobs.xml")).text()).toContain(roleA);
  });

  it("in the last 7 days the owners see when the trial ends, and are emailed a week and a day before, once each", async () => {
    const ending = () => container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.trial_ending"))).orderBy(notifications.createdAt);
    setClock(22);
    expect((await current()).trial).toMatchObject({ endingSoon: false });
    expect((await withPlatform(container.db, (tx) => settleTrials(tx, now()))).warned).toBe(0);
    setClock(24);
    expect((await current()).trial).toMatchObject({ started: true, endingSoon: true, ended: false, daysLeft: 6 });
    expect((await withPlatform(container.db, (tx) => settleTrials(tx, now()))).warned).toBe(1);
    expect((await withPlatform(container.db, (tx) => settleTrials(tx, now()))).warned).toBe(0);
    const week = await ending();
    expect(week).toHaveLength(1);
    expect(week[0].title).toMatch(/^Your trial ends on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
    expect(week[0].body).toContain("new applications, new jobs and new AI interviews pause until a plan is chosen; everything already started carries on.");
    // the last day: one more notice, "tomorrow", and nothing again within the day
    setClock(29.2);
    expect((await withPlatform(container.db, (tx) => settleTrials(tx, now()))).warned).toBe(1);
    expect((await withPlatform(container.db, (tx) => settleTrials(tx, now()))).warned).toBe(0);
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

  it("before the end: a chat is under way, a form is open, and a second job waits for approval", async () => {
    setClock(29.9);
    const applied = await applyForm({ first: "Maria", last: "Chat", email: "maria.chat@example.com" });
    await container.drain();
    // the waiting room opens her AI interview once her résumé is read (20 Oct 2026)
    chatToken = (await followApply(app, applied, container)).token ?? "";
    expect(chatToken).not.toBe("");
    expect((await post(`/c/screen/${chatToken}/start`)).status).toBe(302);
    const form = await app.request(`/careers/${slug}/jobs/${roleA}/apply`);
    expect(form.status).toBe(200);
    graceFormOpened = (await form.text()).match(/<input type="hidden" name="formOpened" value="([^"]+)"/)![1];
    roleB = await draftRole();
    expect((await container.db.select().from(roles).where(eq(roles.id, roleB)))[0].status).toBe("pending_approval");
  });

  it("once the 30 days are over, candidates read the neutral line and nothing about a trial or a plan", async () => {
    setClock(30.5);
    expect((await current()).trial).toMatchObject({ ended: true, endingSoon: false });
    const job = await app.request(`/careers/${slug}/jobs/${roleA}`);
    expect(job.status).toBe(200);
    const jobHtml = await job.text();
    expect(visible(jobHtml)).toContain("This position is not taking new applications right now.");
    expect(jobHtml).not.toContain(`/careers/${slug}/jobs/${roleA}/apply"`);
    // the JobPosting data stays, as on a paused job's page, and says the job stopped on the day the trial ended, so
    // search engines stop listing it as the feeds and the sitemap do
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
    // the form, its upload, its reading and its sending all answer as a job not taking applications does
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply`)).status).toBe(404);
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/upload-intent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "cv.pdf", size: 1000, type: "application/pdf" }) })).status).toBe(404);
    const read = new FormData();
    read.set("firstName", "Rhea");
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply/read`, { method: "POST", body: read })).status).toBe(404);
    expect((await applyForm({ first: "Late", last: "Comer", email: "late.comer@example.com" })).status).toBe(404);
    expect(await container.db.select().from(candidates).where(eq(candidates.email, "late.comer@example.com"))).toHaveLength(0);
  });

  it("a form opened before the end and sent within the grace window is still taken", async () => {
    const r = await applyForm({ first: "Grace", last: "Window", email: "grace.window@example.com" }, { formOpened: graceFormOpened });
    expect(r.status).toBe(302);
    await container.drain();
    const [cand] = await container.db.select().from(candidates).where(eq(candidates.email, "grace.window@example.com"));
    expect(cand).toBeTruthy();
    const taken = await container.db.select().from(applications).where(and(eq(applications.candidateId, cand.id), eq(applications.roleId, roleA)));
    expect(taken).toHaveLength(1);
    // R20-12: the page says plainly that the AI interview's link comes by email, with no loader and never the link
    const landed = await followApply(app, r, container);
    expect(landed.token).toBeNull();
    expect(visible(landed.html)).toContain("We email you its link shortly");
    expect(landed.html).not.toContain("preparing your AI interview");
    expect(landed.html).not.toContain("/c/screen/");
    // candidates are unaffected by the pause (L-02 B): her AI interview and its one email go as anyone's
    const [interview] = await container.db.select().from(screens).where(eq(screens.applicationId, taken[0].id));
    expect(interview).toMatchObject({ invitedVia: "with_application" });
    expect((container.integrations.email as unknown as { sent: Array<{ to: string; text: string }> }).sent.find((m) => m.to === "grace.window@example.com")?.text).toContain(`/c/screen/${interview.token}`);
    // a form opened now gets no grace (it is not even shown), and a made-up value none either
    expect((await applyForm({ first: "Not", last: "Graced", email: "not.graced@example.com" }, { formOpened: "v1.made-up" })).status).toBe(404);
  });

  it("the reuse link, tracked links, the feeds and the 'other jobs' offer all follow", async () => {
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply?reuse=anything`)).status).toBe(404);
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply/reuse`)).status).toBe(404);
    const link = await withTenant(container.db, companyId, (tx) => createApplicationLink(tx, { companyId, roleId: roleA, source: "indeed", label: "Indeed", landing: "apply", actor: { kind: "system", id: "test" } }));
    const visit = await app.request(`/a/${link.token}`);
    expect(visit.status).toBe(302);
    expect(visit.headers.get("location")).toBe(`https://jobs.example.test/careers/${slug}/jobs/${roleA}`);
    resetPublicFeedCache(container);
    for (const path of ["/feeds/jobs.xml", "/feeds/jobs.json", "/feeds/linkedin.xml", "/sitemap.xml"]) expect(await (await app.request(path)).text(), path).not.toContain(roleA);
    const [maria] = await container.db.select().from(candidates).where(eq(candidates.email, "maria.chat@example.com"));
    expect((await otherRolesFor(container, { companyId, candidateId: maria.id })).roles).toEqual([]);
  });

  it("an emailed application is held, not admitted: a held row and the team's notice say why, the sender hears nothing", async () => {
    expect(await (await inbound("Held Trial")).json()).toMatchObject({ ok: true, matched: true, held: true });
    expect((await inboundRow("Held Trial")).status).toBe("held");
    expect(await container.db.select().from(candidates).where(eq(candidates.email, "held.trial@example.com"))).toHaveLength(0);
    const notice = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "application.email_held")))).at(-1);
    expect(notice?.body).toContain("new applications are paused because your trial has ended");
  });

  it("no new job starts: the job builder answers 402 limit_reached with the owner's line", async () => {
    const r = await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a front desk coordinator in Irvine, $22 to $26 an hour, full time." });
    expect(r.status).toBe(402);
    const err = await errorOf(r);
    expect(err).toMatchObject({ code: "limit_reached", message: TRIAL_ENDED_LINE });
    expect(err.details).toMatchObject({ room: { ok: false, trialEnded: true, message: TRIAL_ENDED_LINE }, actions: [{ label: "Ask ITS to choose a plan", body: { kind: "ask", scope: "company", topic: "plan" } }] });
    // no roles are listed to close: closing one would not help
    expect(await (await json(owner, "GET", "/api/v1/intake/room")).json()).toMatchObject({ ok: false, trialEnded: true, holding: [] });
  });

  it("approving a new job, resuming one, switching applications back on and a reopening closing date wait for a plan (402)", async () => {
    const paused = async (r: Response) => {
      expect(r.status).toBe(402);
      expect(await errorOf(r)).toMatchObject({ code: "trial_ended", message: TRIAL_ENDED_LINE });
    };
    await paused(await json(owner, "POST", `/api/v1/roles/${roleB}/approve`, { version: 1, note: "ok" }));
    const [req] = await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.roleId, roleB), eq(approvalRequests.status, "pending")));
    await paused(await json(owner, "POST", `/api/v1/approvals/${req.id}/decide`, { decision: "approve" }));
    expect((await container.db.select().from(roles).where(eq(roles.id, roleB)))[0].status).toBe("pending_approval");
    // pausing is never refused; resuming is new applications
    expect((await json(owner, "POST", `/api/v1/roles/${roleA}/pause`, {})).status).toBe(200);
    await paused(await json(owner, "POST", `/api/v1/roles/${roleA}/resume`, {}));
    await container.db.update(roles).set({ status: "open", pausedAt: null }).where(eq(roles.id, roleA));
    // turning applications off is fine; on again waits
    expect((await json(owner, "POST", `/api/v1/roles/${roleA}/applications/accepting`, { accepting: false, reason: "Enough for now" })).status).toBe(200);
    await paused(await json(owner, "POST", `/api/v1/roles/${roleA}/applications/accepting`, { accepting: true }));
    // a closing date that stopped applications, moved later, would reopen them: it waits; a plain date change does not
    await container.db.update(roles).set({ acceptingApplications: false, applicationsClosedReason: CLOSING_DATE_REASON, applicationsClosedAt: now().toISOString(), applicationsCloseOn: new Date(now().getTime() - 2 * DAY).toISOString().slice(0, 10) }).where(eq(roles.id, roleA));
    const later = new Date(now().getTime() + 20 * DAY).toISOString().slice(0, 10);
    await paused(await json(owner, "POST", `/api/v1/roles/${roleA}/closing-date`, { closesOn: later }));
    expect((await container.db.select().from(roles).where(eq(roles.id, roleA)))[0].applicationsCloseOn?.slice(0, 10)).not.toBe(later);
    expect((await json(owner, "POST", `/api/v1/roles/${roleB}/closing-date`, { closesOn: later })).status).toBe(200);
    await container.db.update(roles).set({ acceptingApplications: true, applicationsClosedReason: null, applicationsClosedAt: null, applicationsCloseOn: null }).where(eq(roles.id, roleA));
  });

  it("everything already started carries on: the team moves, writes to, decides on and schedules existing candidates", async () => {
    const ben = await seedApplicant("Ben");
    const act = (id: string, body: Record<string, unknown>) => json(owner, "POST", `/api/v1/applications/${id}/actions`, body);
    expect((await act(ben.id, { action: "advance_to_interview", note: "Strong résumé." })).status).toBe(200);
    const iv = await json(owner, "POST", `/api/v1/applications/${ben.id}/interviews`, { roundKey: packet.interviews.plan[0].key, interviewerUserIds: [ownerId], linkSource: "calendar" });
    expect(iv.status, await iv.clone().text()).toBe(201);
    const msg = await json(owner, "POST", `/api/v1/applications/${ben.id}/messages`, { text: "Hi Ben, could you come in on Friday?" });
    expect(msg.status, await msg.clone().text()).toBe(201);
    // a new screening chat is new work: it waits for a plan, with the owners' line and the way to ask ITS
    const dan = await seedApplicant("Dan");
    const invite = await act(dan.id, { action: "invite_screen" });
    expect(invite.status, await invite.clone().text()).toBe(402);
    expect(await errorOf(invite)).toMatchObject({ code: "trial_ended", message: TRIAL_ENDED_LINE });
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, dan.id))).toHaveLength(0);
    // approving a waiting "Invite to a screen?" suggestion is the same new work: refused, and the suggestion keeps waiting
    const suggest = (applicationId: string) => withTenant(container.db, companyId, async (tx) => (await tx.insert(approvalRequests).values({ companyId, roleId: roleA, applicationId, actionType: "application.invite_screen", subject: { type: "application", id: applicationId }, proposal: {}, requestedBy: { kind: "agent", id: "triage" }, requiredRoles: [] }).returning())[0].id);
    const eve = await seedApplicant("Eve");
    const waiting = await suggest(eve.id);
    const approve = await json(owner, "POST", `/api/v1/approvals/${waiting}/decide`, { decision: "approve" });
    expect(approve.status, await approve.clone().text()).toBe(402);
    expect(await errorOf(approve)).toMatchObject({ code: "trial_ended", message: TRIAL_ENDED_LINE });
    await container.drain();
    expect((await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, waiting)))[0]).toMatchObject({ status: "pending", decidedBy: null });
    expect(await container.db.select().from(screens).where(eq(screens.applicationId, eve.id))).toHaveLength(0);
    expect(await container.db.select().from(events).where(and(eq(events.type, "approval.granted"), eq(events.subjectId, waiting)))).toHaveLength(0);
    // "Not now" is never refused
    const notNow = await suggest(dan.id);
    expect((await json(owner, "POST", `/api/v1/approvals/${notNow}/decide`, { decision: "reject" })).status).toBe(200);
    // Review and apply says so in its preview, and the run refuses the invite while the rest goes ahead
    const preview = await json(owner, "POST", `/api/v1/roles/${roleA}/batch`, { dryRun: true, items: [{ applicationId: eve.id, action: "invite_screen" }, { applicationId: dan.id, action: "on_hold" }] });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const items = ((await preview.json()) as { items: Array<{ applicationId: string; allowed: boolean; refusedReason: string | null }> }).items;
    expect(items.find((i) => i.applicationId === eve.id)).toMatchObject({ allowed: false, refusedReason: TRIAL_ENDED_LINE });
    expect(items.find((i) => i.applicationId === dan.id)).toMatchObject({ allowed: true });
    const cara = await seedApplicant("Cara");
    expect((await act(cara.id, { action: "reject", reason: "not_a_match_experience", note: "Not this time." })).status).toBe(200);
    const sent = await act(cara.id, { action: "send_decision" });
    expect(sent.status, await sent.clone().text()).toBe(200);
    await container.drain();
    // and the candidate can still ask for their information
    const r = await post(`/c/status/${cara.statusToken}/privacy`, { kind: "access", details: "Please send what you hold about me." });
    expect(r.status).toBe(302);
    expect(await container.db.select().from(dataRequests).where(and(eq(dataRequests.candidateId, cara.candidateId), eq(dataRequests.kind, "access")))).toHaveLength(1);
  });

  it("a chat started before the end finishes: the candidate answers, reviews and sends", async () => {
    await answerAll(chatToken);
    expect((await post(`/c/screen/${chatToken}/review`)).status).toBe(302);
    expect((await post(`/c/screen/${chatToken}/submit`)).status).toBe(302);
    await container.drain();
    expect((await container.db.select().from(screens).where(eq(screens.token, chatToken)))[0].status).toBe("completed");
  });

  it("the hourly check tells ITS once and the owners once; a second run adds nothing", async () => {
    await withPlatform(container.db, (tx) => settleTrials(tx, now()));
    await withPlatform(container.db, (tx) => settleTrials(tx, now()));
    const alerts = await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId)));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "high", status: "open", title: "Harbor Smile Dental's trial has ended" });
    expect(alerts[0].body).toContain("Change the plan, or extend the trial, in the console under Customers, Plan.");
    const told = await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.trial_ended")));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ title: "Your trial has ended", body: TRIAL_ENDED_LINE });
    expect(await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "trial.ended")))).toHaveLength(1);
    expect((await termOf(companyId))?.endNoticeAt).toBeTruthy();
  });

  it("a confirmed company already on Trial with no dates gets 30 days from the hourly check, never an instant lock", async () => {
    const other = await signIn("omar@oldtrial.test");
    const made = (await (await json(other, "POST", "/api/v1/companies", { name: "Old Trial Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string };
    // confirmed before trial dates existed: the confirmation, and no dates
    await withPlatform(container.db, (tx) => tx.update(companies).set({ settings: { careersPage: { enabled: true }, verifiedAt: new Date(BASE - 60 * DAY).toISOString(), verifiedBy: { kind: "system", id: "test" } } }).where(eq(companies.id, made.id)));
    expect(((await (await json(other, "GET", "/api/v1/companies/current")).json()) as { trial: TrialStanding }).trial).toMatchObject({ started: false, ended: false });
    const settled = await withPlatform(container.db, (tx) => settleTrials(tx, now()));
    expect(settled.started).toBe(1);
    expect(await termOf(made.id)).toEqual({ startedAt: now().toISOString(), endsAt: new Date(now().getTime() + 30 * DAY).toISOString(), startedBy: "switched_on" });
    expect(((await (await json(other, "GET", "/api/v1/companies/current")).json()) as { trial: TrialStanding }).trial).toMatchObject({ started: true, ended: false, daysLeft: 30 });
    const [notice] = await container.db.select().from(notifications).where(and(eq(notifications.companyId, made.id), eq(notifications.kind, "company.trial_started")));
    expect(notice).toMatchObject({ title: "Your 30-day trial has started" });
    expect(notice.body).toMatch(/^Your 30-day trial runs until [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}\.$/);
    // a second run starts nothing more
    expect((await withPlatform(container.db, (tx) => settleTrials(tx, now()))).started).toBe(0);
  });

  it("an extension takes the company out of the pause and adds the emails held meanwhile", async () => {
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/trial`, { days: 14, reason: "The owner's kick-off call moved.", confirm: true });
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { ok: boolean; trial: TrialStanding };
    expect(body.trial).toMatchObject({ started: true, ended: false, extendedDays: 14, endsAt: new Date(now().getTime() + 14 * DAY).toISOString() });
    await container.drain();
    const row = await inboundRow("Held Trial");
    expect(row.status).toBe("matched");
    expect(row.applicationId).toBeTruthy();
    expect((await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId))))[0].status).toBe("resolved");
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply`)).status).toBe(200);
    const audited = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "trial.extended")));
    expect(audited).toHaveLength(1);
    expect(audited[0].reason).toBe("The owner's kick-off call moved.");
    expect((await container.db.select().from(notifications).where(and(eq(notifications.userId, ownerId), eq(notifications.kind, "company.trial_extended")))).at(-1)?.body).toMatch(/^ITS extended your trial to .+\. New applications are open again\.$/);
  });

  it("a change of plan ends the trial: the pause lifts, the alert is resolved and the emails held meanwhile are added", async () => {
    setClock(30.5 + 15);
    expect((await current()).trial).toMatchObject({ ended: true });
    await withPlatform(container.db, (tx) => settleTrials(tx, now()));
    expect((await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId), eq(adminAlerts.status, "open"))))).toHaveLength(1);
    expect(await (await inbound("Held Again")).json()).toMatchObject({ held: true });
    const r = await json(admin, "POST", `/api/v1/admin/customers/${companyId}/plan`, { planKey: "growth", reason: "The owner chose Growth." });
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ planKey: "growth", status: "active", trialEnded: true });
    await container.drain();
    expect((await inboundRow("Held Again")).status).toBe("matched");
    expect((await container.db.select().from(adminAlerts).where(and(eq(adminAlerts.kind, "billing.trial_ended"), eq(adminAlerts.companyId, companyId), eq(adminAlerts.status, "open"))))).toHaveLength(0);
    expect((await current()).trial).toBeNull();
    expect((await app.request(`/careers/${slug}/jobs/${roleA}/apply`)).status).toBe(200);
    // new jobs again: the job builder has room
    expect(await (await json(owner, "GET", "/api/v1/intake/room")).json()).toMatchObject({ ok: true });
    expect(((await (await json(owner, "GET", "/api/v1/intake/room")).json()) as { trialEnded?: boolean }).trialEnded).toBeUndefined();
    const latest = (await container.db.select().from(events).where(and(eq(events.companyId, companyId), eq(events.type, "plan.changed"))).orderBy(desc(events.occurredAt)))[0];
    expect(latest.payload).toMatchObject({ from: "trial", to: "growth", trialEnded: true });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { FakeHandler, StructuredRequest } from "@ros/ai";
import { entitlements as plans } from "@ros/core";
import { applications, approvalRequests, assessments, candidates, communications, entitlements, events, notifications, postings, screens, unconfirmedScreens, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { READING_WAIT_MINUTES, readingSettledSignal } from "@ros/workflows";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { RECEIPT_COOKIE } from "./pages/candidate";
import { conversationStart, conversationSubmit, conversationTurn, conversationView, findConversation } from "./services/apply-conversation";

/**
 * 20 October 2026, Step 2 (docs/workflow-decisions.md R20-4, R20-5, R20-10 to R20-12): every applicant is invited to the
 * AI interview by itself, in one email, once the résumé is read or at the latest ten minutes after applying, and the page
 * they applied on waits for it. The worker runs only when a test drains it (WORKER_INLINE false) on the test's own clock,
 * so "the reading is still running" and "ten minutes later" are real states here: an AI provider that does not answer
 * keeps a reading going, as it would in production.
 */
describe("every applicant's AI interview, in one email", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  let owner = "";
  let companyId = "";
  let companyName = "";
  let slug = "";
  type Role = { id: string; title: string; eligibility: string[]; licence: string; minutes: number };
  let role: Role;
  let other: Role;
  let closing: Role;
  const MIN = 60_000;
  const BASE = Date.now();
  let offset = 0;
  /** Moves the engine's clock on by `ms` and runs whatever is due by then. */
  const later = async (ms: number) => {
    offset += ms;
    (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offset);
    await container.drain();
  };
  let ipSeq = 10;
  const json = (method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie: owner }, body: body ? JSON.stringify(body) : undefined });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const mailTo = (email: string) => outbox().filter((m) => m.to === email);
  const linkIn = (text: string) => /\/c\/screen\/([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
  /** The AI provider stops answering for one task: the step that calls it is tried again later, so its reading keeps running. */
  const providerDown = (task: "triage.assess" | "resume.extract") => { for (let i = 0; i < 60; i++) container.fake!.failNext(task, "throw"); };
  const providerBack = () => container.fake!.clearScripts();
  /** Each résumé reading by the model, with how many emails had gone at that moment (what came first). */
  const reads: Array<{ task: string; sent: number }> = [];

  const openRole = async (message: string): Promise<Role> => {
    const s = (await (await json("POST", "/api/v1/intake/sessions", { initialMessage: message })).json()) as { session: { id: string } };
    const id = ((await (await json("POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    await container.drain();
    const approved = await json("POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "ok" });
    expect(approved.status, await approved.clone().text()).toBe(200);
    await container.drain();
    const r = (await (await json("GET", `/api/v1/roles/${id}`)).json()) as { status: string; currentPacket: { packet: { identity: { title: string }; requirements: { eligibility: Array<{ key: string; type: string }> }; screening: { maxMinutes: number } } } };
    expect(r.status).toBe("open");
    const p = r.currentPacket.packet;
    return { id, title: p.identity.title, eligibility: p.requirements.eligibility.map((e) => e.key), licence: p.requirements.eligibility.find((e) => e.type === "license")!.key, minutes: p.screening.maxMinutes };
  };
  /** The apply form as a browser posts it: "no" answers the licence question No; `resume` attaches a file to be read. */
  const applyAs = (p: { first: string; email: string; no?: boolean; resume?: string; to?: Role }) => {
    const target = p.to ?? role;
    const fd = new FormData();
    fd.set("firstName", p.first); fd.set("lastName", "Tester"); fd.set("email", p.email); fd.set("locationText", "Irvine, CA");
    if (p.resume) fd.set("resume", new File([p.resume], `${p.first.toLowerCase()}.txt`, { type: "text/plain" }));
    else fd.set("noResume", "Registered Dental Hygienist at Harbor Dental since 2019; active CA RDH license; perio maintenance.");
    for (const k of target.eligibility) fd.set(`elig_${k}`, p.no && k === target.licence ? "no" : "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    return app.request(`/careers/${slug}/jobs/${target.id}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${ipSeq++}` } });
  };
  const appOf = async (email: string, to: Role = role) => {
    const [c] = await container.db.select().from(candidates).where(and(eq(candidates.companyId, companyId), eq(candidates.email, email)));
    return (await container.db.select().from(applications).where(and(eq(applications.roleId, to.id), eq(applications.candidateId, c.id))))[0];
  };
  const screensOf = (applicationId: string) => container.db.select().from(screens).where(eq(screens.applicationId, applicationId));
  const acksOf = (applicationId: string) => container.db.select().from(communications).where(and(eq(communications.applicationId, applicationId), eq(communications.templateKey, "acknowledgment")));
  const triageOf = (applicationId: string) => container.db.select().from(assessments).where(and(eq(assessments.applicationId, applicationId), eq(assessments.kind, "triage")));
  const interviewRun = async (applicationId: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `screen:${applicationId}`)))[0];
  const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").match(new RegExp(`${RECEIPT_COOKIE}=[^;,]+`))?.[0] ?? "";
  /** The page the browser lands on after Send: the waiting room, the receipt, or a redirect to the interview. */
  const landing = (r: Response) => app.request(r.headers.get("location")!, { headers: { cookie: cookieOf(r) } });
  const words = async (r: Response) => (await r.text()).replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
  const grantIn = (html: string) => /<input type="hidden" name="grant" value="([^"]+)"/.exec(html)?.[1] ?? null;
  const status = (to: Role, grant: string) => app.request(`/careers/${slug}/jobs/${to.id}/applied/status`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify({ grant }) });
  const start = (to: Role, grant: string) => app.request(`/careers/${slug}/jobs/${to.id}/applied/start`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant }).toString() });
  /** Start pressed on an AI interview's page (its own or a detached copy): what the candidate sees, to compare two of them. */
  const startedAs = async (token: string) => {
    const ref = (await findConversation(container.db, token))!;
    expect(await conversationStart(container, ref)).toBe(true);
    const v = (await conversationView(container.db, ref))!;
    return { first: v.transcript[0]?.content ?? null, counter: v.counter, total: v.total, current: v.current?.question ?? null, transcript: v.transcript.length };
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "false", STORAGE_PROVIDER: "memory", RATE_LIMIT_STORE: "fake", JOBS_BASE_URL: "https://jobs.example.test" } });
    app = createApp(container);
    await later(0);
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "owner@auto.test" }) });
    const token = new URL(((await r1.json()) as { devLink: string }).devLink).searchParams.get("token")!;
    owner = (await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) })).headers.get("set-cookie")!.split(";")[0];
    const co = (await (await json("POST", "/api/v1/companies", { name: "Auto Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Irvine", region: "CA", country: "US" }] })).json()) as { id: string; slug: string; name: string };
    companyId = co.id;
    companyName = "Auto Dental";
    slug = co.slug;
    await plans.applyPlan(container.db, companyId, "growth");
    role = await openRole("I need a registered dental hygienist in Irvine, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    other = await openRole("I need a registered dental hygienist in Tustin, $46 to $56 an hour, part time. It's growth. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    closing = await openRole("I need a registered dental hygienist in Orange, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it.");
    // every résumé reading by the model notes how many emails had gone by then
    const handlers = (container.fake as unknown as { handlers: Map<string, FakeHandler> }).handlers;
    for (const task of ["triage.assess", "resume.extract"]) {
      const real = handlers.get(task)!;
      container.fake!.register(task, async (req: StructuredRequest<unknown>) => { reads.push({ task, sent: outbox().length }); return real(req); });
    }
  });
  afterAll(async () => {
    await container.close();
  });

  it("1. a form applicant gets exactly one email, with the link, once the résumé is read: no approval, nobody told about one person", async () => {
    const email = "ana.first@example.com";
    expect((await applyAs({ first: "Ana", email })).status).toBe(302);
    expect(mailTo(email)).toHaveLength(0); // nothing has run yet
    reads.length = 0;
    await container.drain();
    const a = await appOf(email);
    expect(a.stage).toBe("screen_invited");
    const [scr] = await screensOf(a.id);
    expect(scr).toMatchObject({ invitedVia: "with_application", channel: "web", status: "invited" });
    expect(scr.progress.flow).toBe("one_visit");
    // the reading came first (R20-5): it is written, and the email left after every call the model made for it
    expect(await triageOf(a.id)).toHaveLength(1);
    const mail = mailTo(email);
    expect(mail).toHaveLength(1);
    expect(reads.filter((r) => r.task === "triage.assess").length).toBeGreaterThan(0);
    expect(outbox().indexOf(mail[0])).toBeGreaterThanOrEqual(Math.max(...reads.map((r) => r.sent)));
    // the one email: thank you, the next step in plain words, the link, how it works, a person instead, the status link
    expect(mail[0].subject).toBe(`Thank you for applying: your next step for ${role.title} at ${companyName}`);
    expect(mail[0].text).toContain(`Your next step is a short interview with ${companyName}'s AI assistant. Everyone who applies gets the same interview`);
    expect(mail[0].text).toContain(`about ${role.minutes} minutes`);
    expect(mail[0].text).toContain(`Start your AI interview: https://jobs.example.test/c/screen/${scr.token}`);
    expect(mail[0].text).toContain("Prefer a person?");
    expect(mail[0].text).toContain("If you need an adjustment");
    expect(mail[0].text).toContain("Not doing the interview never stops your application");
    expect(mail[0].text).toContain(`/c/status/${a.statusToken}`);
    expect(mail[0].text).not.toMatch(/to qualify|screening/i);
    const [ack] = await acksOf(a.id);
    expect(ack.idempotencyKey).toBe(`ack:${a.id}`);
    // automatic: nothing waited for a person, and the team hears about her once, when her interview is scored (R20-8)
    expect(await container.db.select().from(approvalRequests).where(eq(approvalRequests.applicationId, a.id))).toHaveLength(0);
    expect((await container.db.select().from(notifications).where(eq(notifications.companyId, companyId))).filter((n) => n.title.includes("Ana Tester"))).toHaveLength(0);
    const invited = (await container.db.select().from(events).where(eq(events.type, "screen.invited"))).find((e) => e.subjectId === scr.id)!;
    expect(invited.payload).toMatchObject({ invitedBy: "system", invitedVia: "with_application", channel: "web" });
  });

  it("2. the reading still running after ten minutes: the email goes then, with the link, and the reading finishes beside it", async () => {
    providerDown("triage.assess");
    try {
      const email = "ben.late@example.com";
      expect((await applyAs({ first: "Ben", email })).status).toBe(302);
      const applied = offset;
      await later(0);
      const a = await appOf(email);
      expect(a.stage).toBe("eligible");
      expect(await screensOf(a.id)).toHaveLength(0);
      expect(mailTo(email)).toHaveLength(0);
      // the interview's run waits for the reading, ten minutes at most
      const run = await interviewRun(a.id);
      expect(run).toMatchObject({ status: "waiting", currentStep: "await_reading" });
      expect(Date.parse((run.wait as { until: string }).until)).toBe(BASE + applied + READING_WAIT_MINUTES * MIN);
      await later(9 * MIN);
      expect(mailTo(email)).toHaveLength(0);
      await later(MIN + 1000);
      const invited = await appOf(email);
      expect(invited.stage).toBe("screen_invited");
      const [scr] = await screensOf(a.id);
      expect(mailTo(email)).toHaveLength(1);
      expect(linkIn(mailTo(email)[0].text)).toBe(scr.token);
      expect(await triageOf(a.id)).toHaveLength(0);
    } finally {
      providerBack();
    }
    // the provider answers again: the résumé is read beside the interview, which moves nothing and sends nothing
    await later(11 * MIN);
    const a = await appOf("ben.late@example.com");
    expect(await triageOf(a.id)).toHaveLength(1);
    expect(a.stage).toBe("screen_invited");
    expect(mailTo("ben.late@example.com")).toHaveLength(1);
    expect(await screensOf(a.id)).toHaveLength(1);
  });

  it("3. an emailed-in applicant gets the one email first, and the AI reading still runs, only after it went", async () => {
    const [emailIn] = await container.db.select().from(postings).where(and(eq(postings.roleId, role.id), eq(postings.channel, "email_in")));
    reads.length = 0;
    const cv = "Cleo Park\nRegistered Dental Hygienist at Harbor Dental 2018 - present\nRDH license CA active\nPerio maintenance, Dentrix";
    const r = await app.request("/webhooks/postmark/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ From: "noreply@indeed.com", FromName: "Indeed", To: `apply-${emailIn.intakeToken}@${container.integrations.env.intakeDomain}`, Subject: `New applicant: Cleo Park - ${role.title}`, TextBody: "Cleo Park applied via Indeed.\nEmail: cleo.park@example.com\nPhone: 702-555-0144", Attachments: [{ Name: "cleo.txt", ContentType: "text/plain", Content: Buffer.from(cv).toString("base64"), ContentLength: cv.length }] }) });
    expect(r.status).toBe(200);
    const { applicationId } = (await r.json()) as { applicationId: string };
    await container.drain();
    const mail = mailTo("cleo.park@example.com");
    expect(mail).toHaveLength(1);
    const [scr] = await screensOf(applicationId);
    expect(scr).toMatchObject({ invitedVia: "with_application", channel: "web" });
    expect(linkIn(mail[0].text)).toBe(scr.token);
    // the AI reading ran (the file, then the fit check), every call after the email carrying the AI notice had gone
    const at = outbox().indexOf(mail[0]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((x) => x.sent > at)).toBe(true);
    expect(await triageOf(applicationId)).toHaveLength(1);
    expect((await container.db.select().from(applications).where(eq(applications.id, applicationId)))[0].stage).toBe("screen_invited");
  });

  it("4. a must-have 'No' on the form: the neutral thank-you, the team sees it, and 'Keep them in' sends the link with nothing more to approve", async () => {
    const email = "dee.no@example.com";
    const r = await applyAs({ first: "Dee", email, no: true });
    await container.drain();
    const a = await appOf(email);
    expect(a.stage).toBe("ineligible");
    expect(await screensOf(a.id)).toHaveLength(0);
    const [thanks] = mailTo(email);
    expect(mailTo(email)).toHaveLength(1);
    expect(thanks.subject).toBe(`Thank you for applying: ${role.title} at ${companyName}`);
    expect(thanks.text).not.toContain("/c/screen/");
    expect(thanks.text).not.toMatch(/must-have|eligib|not meet/i);
    // the page says nothing of it either: check your email, never a loader or a link
    const page = await (await landing(r)).text();
    expect(page).toContain("Check your email.");
    expect(page).not.toContain('class="loader"');
    expect(grantIn(page)).toBeNull();
    const held = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "application.ineligible_hold")))).find((n) => n.title.includes("Dee Tester"))!;
    expect(held.body).toContain("They get a thank-you without the AI interview link");
    expect(held.body).toContain('"Keep them in" sends them the link');
    // Keep them in: the link follows by itself, in an email of its own
    const kept0 = await json("POST", `/api/v1/applications/${a.id}/actions`, { action: "override_eligibility", note: "She has her licence; she misread the question." });
    expect(kept0.status).toBe(200);
    // the answer names the column the list and the board show her in: her AI interview is being prepared
    expect(await kept0.json()).toMatchObject({ stage: "eligible", ownerStage: "no_ai_interview" });
    const listed = (await (await json("GET", `/api/v1/roles/${role.id}/applications`)).json()) as Array<{ id: string; ownerStage: string }>;
    expect(listed.find((x) => x.id === a.id)?.ownerStage).toBe("no_ai_interview");
    await container.drain();
    const kept = await appOf(email);
    expect(kept.stage).toBe("screen_invited");
    const [scr] = await screensOf(a.id);
    expect(scr.invitedVia).toBe("with_application");
    const mail = mailTo(email);
    expect(mail).toHaveLength(2);
    expect(mail[1].subject).toBe(`Your next step: a short AI interview for ${role.title}`);
    expect(linkIn(mail[1].text)).toBe(scr.token);
    expect(await container.db.select().from(approvalRequests).where(and(eq(approvalRequests.applicationId, a.id), eq(approvalRequests.status, "pending")))).toHaveLength(0);
  });

  it("5. a role closed while the résumé is still being read: the neutral thank-you at ten minutes, never a link", async () => {
    providerDown("triage.assess");
    const email = "eli.closed@example.com";
    try {
      const r = await applyAs({ first: "Eli", email, to: closing });
      await later(0);
      const a = await appOf(email, closing);
      // the waiting room waits for it
      const room = await words(await landing(r));
      expect(room).toContain("We're preparing your AI interview…");
      const grant = grantIn(room)!;
      expect((await (await status(closing, grant)).json()) as { state: string }).toEqual({ state: "preparing" });
      expect((await json("POST", `/api/v1/roles/${closing.id}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "Budget pulled." })).status).toBe(200);
      await later(0);
      expect(mailTo(email)).toHaveLength(0);
      // once its first 40 to 90 seconds have passed (every waiting room's), the page stops waiting and says it in plain
      // words, with no loader
      expect((await (await status(closing, grant)).json()) as { state: string }).toEqual({ state: "preparing" });
      await later(91_000);
      expect((await (await status(closing, grant)).json()) as { state: string }).toEqual({ state: "closed" });
      const after = await (await landing(r)).text();
      expect(after).toContain("Check your email.");
      expect(after).not.toContain('class="loader"');
      await later(READING_WAIT_MINUTES * MIN + 1000);
      const mail = mailTo(email);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toBe(`Thank you for applying: ${closing.title} at ${companyName}`);
      expect(mail[0].text).not.toContain("/c/screen/");
      expect(await screensOf(a.id)).toHaveLength(0);
      expect((await interviewRun(a.id)).status).toBe("completed");
    } finally {
      providerBack();
    }
    await later(11 * MIN);
    expect(mailTo(email)).toHaveLength(1);
  });

  it("6. no second interview or email when steps are tried again: a reading that failed once, an email whose first send failed, a second signal and a second start", async () => {
    container.fake!.failNext("triage.assess", "throw");
    (container.integrations.email as FakeEmailAdapter).failNext(1);
    const email = "fay.retry@example.com";
    expect((await applyAs({ first: "Fay", email })).status).toBe(302);
    await later(0);
    await later(5_000); // the reading's second try
    await later(5_000); // the email's second try
    const a = await appOf(email);
    expect(a.stage).toBe("screen_invited");
    expect(await screensOf(a.id)).toHaveLength(1);
    expect(await acksOf(a.id)).toHaveLength(1);
    expect(mailTo(email)).toHaveLength(1);
    // the reading settles again, and the run is started again under its key: nothing new
    await withTenant(container.db, companyId, async (tx) => {
      await container.engine.signal(tx, { companyId, key: readingSettledSignal(a.id) });
      const again = await container.engine.start(tx, { workflowKey: "screen", companyId, subject: { type: "application", id: a.id }, state: { applicationId: a.id, roleId: role.id, invitedBy: "system", flow: "one_visit", channel: "web", mode: "with_application" }, idempotencyKey: `screen:${a.id}` });
      expect(again.created).toBe(false);
    });
    await later(5_000);
    expect(await screensOf(a.id)).toHaveLength(1);
    expect(await acksOf(a.id)).toHaveLength(1);
    expect(mailTo(email)).toHaveLength(1);
    expect(await container.db.select().from(workflowRuns).where(eq(workflowRuns.idempotencyKey, `screen:${a.id}`))).toHaveLength(1);
    providerBack();
  });

  it("7. the ten minutes run out before the eligibility step: the fallback checks the must-have answers itself", async () => {
    providerDown("resume.extract");
    const cv = (name: string) => `${name} Tester\nRegistered Dental Hygienist at Harbor Dental 2019 - present\nRDH license CA active`;
    try {
      await applyAs({ first: "Gus", email: "gus.yes@example.com", resume: cv("Gus") });
      await applyAs({ first: "Hal", email: "hal.no@example.com", resume: cv("Hal"), no: true });
      await later(0);
      const [gus0, hal0] = [await appOf("gus.yes@example.com"), await appOf("hal.no@example.com")];
      // both still being read, before their answers were checked
      expect([gus0.stage, hal0.stage]).toEqual(["received", "received"]);
      expect(gus0.eligibility).toBeNull();
      await later(READING_WAIT_MINUTES * MIN + 1000);
      // all yes: checked, recorded as the intake would, and invited with the one email
      const gus = await appOf("gus.yes@example.com");
      expect(gus.eligibility).toMatchObject({ passed: true });
      expect(gus.stage).toBe("screen_invited");
      expect(linkIn(mailTo("gus.yes@example.com")[0].text)).toBe((await screensOf(gus.id))[0].token);
      expect((await container.db.select().from(events).where(and(eq(events.type, "eligibility.evaluated"), eq(events.subjectId, gus.id))))[0].payload).toMatchObject({ passed: true, at: "interview" });
      // a "No": the neutral thank-you, no interview, and the run waits for a person
      const hal = await appOf("hal.no@example.com");
      expect(await screensOf(hal.id)).toHaveLength(0);
      expect(mailTo("hal.no@example.com")).toHaveLength(1);
      expect(mailTo("hal.no@example.com")[0].text).not.toContain("/c/screen/");
      expect((await interviewRun(hal.id)).currentStep).toBe("after_hold");
    } finally {
      providerBack();
    }
    // the intake catches up: the reading goes on beside Gus's interview, and Hal is held for the team; nothing more is sent
    await later(11 * MIN);
    const gus = await appOf("gus.yes@example.com");
    expect(gus.stage).toBe("screen_invited");
    expect(await triageOf(gus.id)).toHaveLength(1);
    expect(await container.db.select().from(events).where(and(eq(events.type, "eligibility.evaluated"), eq(events.subjectId, gus.id)))).toHaveLength(1);
    expect(mailTo("gus.yes@example.com")).toHaveLength(1);
    const hal = await appOf("hal.no@example.com");
    expect(hal.stage).toBe("ineligible");
    expect(mailTo("hal.no@example.com")).toHaveLength(1);
  });

  describe("the waiting room after Send (R20-12)", () => {
    it("waits while the résumé is read, with the job's length and a CSS loader, then opens the interview: by script and by the button", async () => {
      providerDown("triage.assess");
      const email = "ivy.wait@example.com";
      let grant = "";
      let receipt = "";
      try {
        const r = await applyAs({ first: "Ivy", email });
        expect(r.headers.get("location")).toBe(`/careers/${slug}/jobs/${role.id}/applied`);
        receipt = cookieOf(r);
        await later(0);
        const page = await landing(r);
        expect(page.status).toBe(200);
        expect(page.headers.get("cache-control")).toBe("no-store");
        const html = await words(page);
        expect(html).toContain("We're preparing your AI interview…");
        // the loader shows only once the script runs; without it the page says to press Start my interview, never that it moves by itself
        expect(html).toMatch(/<span class="loader" aria-hidden="true" hidden(="")?><\/span>/);
        expect(html).toContain('<p id="wait-more">We are reading your application so the questions fit your experience. It usually takes about a minute: press Start my interview in a moment to begin.</p>');
        expect(html).not.toContain("reading your résumé");
        // giving up after about twelve minutes (180 tries) stops the loader too
        expect(html).toContain("if(tries>=180){stopped=true;if(loader){loader.hidden=true;}");
        expect(html).toContain("@media (prefers-reduced-motion: reduce){.loader{animation:none}}");
        expect(html).toContain(`a written chat of about ${role.minutes} minutes`);
        expect(html).toContain("We've also emailed you the link (to i***@example.com), so you can join later from there.");
        expect(html).toContain(`data-wait-status="/careers/${slug}/jobs/${role.id}/applied/status"`);
        expect(html).toContain("Start my interview");
        expect(html).not.toContain("/c/screen/");
        grant = grantIn(html)!;
        expect(grant).toBeTruthy();
        // the grant names this application only: nothing readable in it, and not good for another job
        const a = await appOf(email);
        expect(grant).not.toContain(a.id);
        expect((await status(other, grant)).status).toBe(404);
        expect((await status(role, "v1.made-up")).status).toBe(404);
        // with script: the page asks, and hears "preparing"; without: the button shows the page again
        const asked = await status(role, grant);
        expect(asked.status).toBe(200);
        expect(await asked.json()).toEqual({ state: "preparing" });
        const pressed = await start(role, grant);
        expect(pressed.status).toBe(200);
        expect(await pressed.text()).toContain("It is not ready yet.");
      } finally {
        providerBack();
      }
      // the reading is tried again and done, and the 40 to 90 seconds every waiting room waits have passed: the interview
      // exists, the page hears "ready" (never the link itself)
      await later(91_000);
      const a = await appOf(email);
      const [scr] = await screensOf(a.id);
      expect(scr.invitedVia).toBe("with_application");
      const ready = await status(role, grant);
      expect(await ready.json()).toEqual({ state: "ready" });
      // the script presses Start my interview, as a person without script does: it opens the interview
      const opened = await start(role, grant);
      expect(opened.status).toBe(302);
      expect(opened.headers.get("location")).toBe(`/c/screen/${scr.token}`);
      // coming back to the page with its cookie opens it too; with no cookie it is the plain receipt, never a waiting room
      const back = await app.request(`/careers/${slug}/jobs/${role.id}/applied`, { headers: { cookie: receipt } });
      expect(back.status).toBe(302);
      expect(back.headers.get("location")).toBe(`/c/screen/${scr.token}`);
      const stranger = await (await app.request(`/careers/${slug}/jobs/${role.id}/applied`)).text();
      expect(stranger).toContain("Check your email.");
      expect(grantIn(stranger)).toBeNull();
      expect(mailTo(email)).toHaveLength(1);
      expect(linkIn(mailTo(email)[0].text)).toBe(scr.token);
    });

    it("Q14 kept in full (founder, 21 Oct): a new address and a known one get the same waiting room byte for byte apart from the sealed grant, both reach an AI interview, and the known one's answers join only once the address owner confirms by email", async () => {
      /** The page with what differs per response taken out: the sealed grant and the script's nonce, nothing else. */
      const bare = (html: string) => html.replace(/name="grant" value="[^"]*"/g, 'name="grant" value=""').replace(/ nonce="[^"]*"/g, "");
      // the same first name and masked address (a***@example.com), all sent before anything ran: per job, a new address
      // beside a repeat (Ana applied for `role` in test 1), and beside a first application to another job from an address
      // the company knows (her own, with a +suffix)
      const fresh = await applyAs({ first: "Ana", email: "amy.new@example.com" });
      const repeat = await applyAs({ first: "Ana", email: "ana.first@example.com" });
      const freshOther = await applyAs({ first: "Ana", email: "abe.new@example.com", to: other });
      const known = await applyAs({ first: "Ana", email: "ana.first+jobs@example.com", to: other });
      const rooms = await Promise.all([fresh, repeat, freshOther, known].map(async (r) => words(await landing(r))));
      for (const html of rooms) expect(html).toContain("We're preparing your AI interview…");
      expect(bare(rooms[1])).toBe(bare(rooms[0]));
      expect(bare(rooms[3])).toBe(bare(rooms[2]));
      expect(rooms.join("")).not.toContain("/c/screen/");
      // the grants have the same shape, and the page's question gets the same answer
      const grants = rooms.map((html) => grantIn(html)!);
      expect(new Set(grants.map((g) => g.length)).size).toBe(1);
      const jobOf = [role, role, other, other];
      for (let i = 0; i < 4; i++) expect(await (await status(jobOf[i], grants[i])).json()).toEqual({ state: "preparing" });
      // a repeat or a known address never opens the application's own interview: a detached copy is made for the visit
      const ana = await appOf("ana.first@example.com");
      const anaKnown = await appOf("ana.first@example.com", other);
      const copyOf = async (applicationId: string) => (await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.applicationId, applicationId)))[0];
      const [copy, knownCopy] = [await copyOf(ana.id), await copyOf(anaKnown.id)];
      for (const c of [copy, knownCopy]) expect(c).toMatchObject({ firstName: "Ana", status: "invited" });
      // the same timing (founder, 21 Oct): every waiting room says "preparing" for its first 40 to 90 seconds, a new
      // address's too, even once its interview exists; and a known address's copy waits as long as its new application's
      // own interview, which is what a new address's waits for
      await later(0);
      const amyScreen = (await screensOf((await appOf("amy.new@example.com")).id))[0];
      expect(amyScreen).toBeTruthy();
      for (let i = 0; i < 4; i++) expect(await (await status(jobOf[i], grants[i])).json()).toEqual({ state: "preparing" });
      expect(await (await start(role, grants[0])).text()).toContain("It is not ready yet.");
      const known0 = await words(await start(other, grants[3]));
      expect(known0).toContain("It is not ready yet.");
      await later(91_000);
      for (let i = 0; i < 4; i++) expect(await (await status(jobOf[i], grants[i])).json()).toEqual({ state: "ready" });
      const openedFresh = await start(role, grants[0]);
      expect(openedFresh.status).toBe(302);
      expect(openedFresh.headers.get("location")).toBe(`/c/screen/${amyScreen.token}`);
      const openedCopy = await start(role, grants[1]);
      expect(openedCopy.status).toBe(302);
      expect(openedCopy.headers.get("location")).toBe(`/c/screen/${copy.token}`);
      const abeScreen = (await screensOf((await appOf("abe.new@example.com", other)).id))[0];
      expect((await start(other, grants[2])).headers.get("location")).toBe(`/c/screen/${abeScreen.token}`);
      expect((await start(other, grants[3])).headers.get("location")).toBe(`/c/screen/${knownCopy.token}`);
      // the known application's own interview went by email only, to the address on file
      const [anaKnownScreen] = await screensOf(anaKnown.id);
      expect(anaKnownScreen.invitedVia).toBe("with_application");
      expect(mailTo("ana.first@example.com").filter((m) => linkIn(m.text) === anaKnownScreen.token)).toHaveLength(1);
      // both interview pages open on the same introduction
      const intro = async (token: string) => (await words(await app.request(`/c/screen/${token}`))).replaceAll(token, "TOKEN").replace(/ nonce="[^"]*"/g, "");
      expect(await intro(copy.token)).toBe(await intro(amyScreen.token));
      expect(await intro(knownCopy.token)).toBe(await intro(abeScreen.token));
      // and after Start, the same first message, counter and questions: both are planned from what the visit gave
      expect(await startedAs(knownCopy.token)).toEqual(await startedAs(abeScreen.token));
      expect(await startedAs(copy.token)).toEqual(await startedAs(amyScreen.token));
      // the repeat's answers: sent on the page, they wait for the address owner, who confirms by email
      const ref = (await findConversation(container.db, copy.token))!;
      expect(ref.kind).toBe("detached");
      expect(await conversationStart(container, ref)).toBe(true);
      for (let i = 0; i < 20 && (await conversationView(container.db, ref))!.phase === "conversation"; i++) await conversationTurn(container, ref, { message: "At Harbor Dental I see nine patients a day, chart perio in Dentrix and hold an active CA RDH license." });
      expect((await conversationView(container.db, ref))!.phase).toBe("review");
      expect(await conversationSubmit(container, ref)).toBe(true);
      await later(0);
      const own = async () => (await screensOf(ana.id)).sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
      const before = await own();
      expect(Object.keys(before.answers)).toHaveLength(0);
      expect(before.status).toBe("invited");
      const confirm = mailTo("ana.first@example.com").filter((m) => /^Please confirm/.test(m.subject)).at(-1)!;
      const confirmToken = /\/c\/confirm-answers\/([A-Za-z0-9_-]+)/.exec(confirm.text)![1];
      // opening the link changes nothing; the button adds them to the application's own interview
      expect((await app.request(`/c/confirm-answers/${confirmToken}`)).status).toBe(200);
      // the question says only "this job", so the "Company · Job" eyebrow above it names them (an emailed link opens it)
      expect(await (await app.request(`/c/confirm-answers/${confirmToken}`)).text()).toMatch(/<main><p class="eyebrow">[^<]+ · [^<]+<\/p><h1>Add these answers to your application\?<\/h1>/);
      expect((await own()).status).toBe("invited");
      expect((await app.request(`/c/confirm-answers/${confirmToken}`, { method: "POST" })).status).toBe(302);
      await later(0);
      // once added, the line under the heading names the job and the employer, so no eyebrow repeats them (23 October 2026)
      expect(await (await app.request(`/c/confirm-answers/${confirmToken}`)).text()).toMatch(/<main><h1>Your answers are added<\/h1><div class="card" role="status"><p>They are now part of your application for [^<]+ at [^<]+, and the hiring team reads them with it\./);
      const merged = await own();
      expect(merged.id).toBe(before.id);
      expect(merged.status).toBe("completed");
      expect(merged.transcript.filter((t) => t.role === "candidate").length).toBeGreaterThan(0);
      const [wiped] = await container.db.select().from(unconfirmedScreens).where(eq(unconfirmedScreens.id, copy.id));
      expect(wiped).toMatchObject({ confirmation: "confirmed", transcript: [], answers: {} });
    });

    it("Q14 with a résumé sent inside the form (no script): a new address and a repeat open with the same words, counter and questions", async () => {
      const cv = "Cal Tester\nRegistered Dental Hygienist at Harbor Dental 2019 - present\nRDH license CA active\nDentrix, perio maintenance";
      const fresh = await applyAs({ first: "Cal", email: "cal.new@example.com", resume: cv });
      const repeat = await applyAs({ first: "Cal", email: "ana.first@example.com", resume: cv });
      const [freshGrant, repeatGrant] = await Promise.all([fresh, repeat].map(async (r) => grantIn(await words(await landing(r)))!));
      await later(91_000);
      const cal = await appOf("cal.new@example.com");
      // the new address's résumé was read by the intake (for the fit check and the score)
      expect(cal.extraction).toBeTruthy();
      expect(await triageOf(cal.id)).toHaveLength(1);
      const own = (await start(role, freshGrant)).headers.get("location")!;
      const copy = (await start(role, repeatGrant)).headers.get("location")!;
      const [ownToken, copyToken] = [own, copy].map((l) => /^\/c\/screen\/([A-Za-z0-9_-]+)$/.exec(l)![1]);
      expect(ownToken).toBe((await screensOf(cal.id))[0].token);
      const [opened, copied] = [await startedAs(ownToken), await startedAs(copyToken)];
      expect(copied).toEqual(opened);
      // neither names a résumé only the intake read: a repeat's file is never read, and nothing tells the two apart
      expect(opened.first).toMatch(/^Hi Cal\. Thanks for applying\./);
    });

    it("the day's cap ends on 'check your email' after the same number of quick sends for a new address and one that applied more than a day ago", async () => {
      // an address whose application is older than a day (its interview too)
      const old = await appOf("fay.retry@example.com");
      await container.db.execute(sql`update applications set created_at = now() - interval '2 days' where id = ${old.id}`);
      await container.db.execute(sql`update screens set created_at = now() - interval '2 days' where application_id = ${old.id}`);
      const sends = async (first: string, email: string) => {
        const grants: string[] = [];
        for (let i = 0; i < 5; i++) grants.push(grantIn(await words(await landing(await applyAs({ first, email }))))!);
        return grants;
      };
      // five quick sends each, nothing run in between
      const fresh = await sends("Gil", "gil.cap@example.com");
      const known = await sends("Gil", "fay.retry@example.com");
      await later(91_000);
      const stateOf = async (grants: string[]) => Promise.all(grants.map(async (g) => ((await (await status(role, g)).json()) as { state: string }).state));
      expect(await stateOf(fresh)).toEqual(["ready", "ready", "ready", "ready", "email"]);
      expect(await stateOf(known)).toEqual(["ready", "ready", "ready", "ready", "email"]);
    });

    // Held and closed read plainly above (4, 5); a trial's pause does too, with its own words, in trial.test.ts.
    it("says plainly when the month's AI interviews are used up: the link follows by email, no loader", async () => {
      const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
      await container.db.update(entitlements).set({ used: ent.limit ?? 0 }).where(eq(entitlements.id, ent.id));
      try {
        const email = "jo.full@example.com";
        const r = await applyAs({ first: "Jo", email });
        await later(0);
        const html = await (await landing(r)).text();
        expect(html).toContain("Check your email.");
        expect(html).toContain("We email you its link as soon as it is ready.");
        expect(html).not.toContain('class="loader"');
        expect(grantIn(html)).toBeNull();
        const a = await appOf(email);
        expect(await screensOf(a.id)).toHaveLength(0);
        const mail = mailTo(email);
        expect(mail).toHaveLength(1);
        expect(mail[0].text).toContain("We will email you its link as soon as it is ready.");
        expect(mail[0].text).not.toContain("/c/screen/");
      } finally {
        await container.db.update(entitlements).set({ used: ent.used }).where(eq(entitlements.id, ent.id));
      }
    });
  });

  describe("a person's choices never race the AI interview or leave someone without it", () => {
    const HOUR = 60 * MIN;
    const DAY = 24 * HOUR;
    /** The link's reminder after 48 hours, and its close 72 hours after that. */
    const INVITE_HOURS = 48;
    const REMIND_HOURS = 72;
    const act =(applicationId: string, body: Record<string, unknown>) => json("POST", `/api/v1/applications/${applicationId}/actions`, body);
    const detailOf = async (applicationId: string) => (await (await json("GET", `/api/v1/applications/${applicationId}`)).json()) as { allowedActions: string[]; blockedReasons: Record<string, string> };
    const PREPARING = "Their AI interview is being prepared, and its link goes to them by itself.";

    it("while the résumé is read 'Send a new AI interview link' waits; a link a person sent anyway is the one the one email carries", async () => {
      providerDown("triage.assess");
      const email = "kim.race@example.com";
      try {
        await applyAs({ first: "Kim", email });
        await later(0);
        const a = await appOf(email);
        expect(a.stage).toBe("eligible");
        const detail = await detailOf(a.id);
        expect(detail.allowedActions).not.toContain("invite_screen");
        expect(detail.blockedReasons.invite_screen).toBe(PREPARING);
        const refused = await act(a.id, { action: "invite_screen" });
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("interview_preparing");
        // the race the button no longer allows (a person's run started in that minute): never a thank-you without the link
        await withTenant(container.db, companyId, (tx) => container.engine.start(tx, { workflowKey: "screen", companyId, subject: { type: "application", id: a.id }, state: { applicationId: a.id, roleId: role.id, invitedBy: "a-person", flow: "one_visit", channel: "web" }, idempotencyKey: `screen:${a.id}:race` }));
        await later(0);
        expect((await appOf(email)).stage).toBe("screen_invited");
        await later(READING_WAIT_MINUTES * MIN + 1000);
        const [mine] = await screensOf(a.id);
        expect(await screensOf(a.id)).toHaveLength(1);
        const mail = mailTo(email);
        expect(mail.map((m) => linkIn(m.text))).toEqual([mine.token, mine.token]);
        expect(mail[1].subject).toBe(`Thank you for applying: your next step for ${role.title} at ${companyName}`);
        expect((await interviewRun(a.id)).status).toBe("completed");
      } finally {
        providerBack();
      }
    });

    it("an intake from before 20 October, with no interview run, starts the AI interview at its reading instead of leaving them without one", async () => {
      providerDown("triage.assess");
      const email = "oli.before@example.com";
      try {
        await applyAs({ first: "Oli", email });
        await later(0);
        const a = await appOf(email);
        const run = await interviewRun(a.id);
        await withTenant(container.db, companyId, (tx) => container.engine.cancel(tx, run.id, { kind: "system", id: "test" }, "as if it applied before the deploy"));
      } finally {
        providerBack();
      }
      await later(5_000);
      const a = await appOf(email);
      expect(a.stage).toBe("screen_invited");
      expect(await triageOf(a.id)).toHaveLength(1);
      const [scr] = await screensOf(a.id);
      expect(scr).toMatchObject({ invitedVia: "with_application", channel: "web" });
      expect(mailTo(email).filter((m) => linkIn(m.text) === scr.token)).toHaveLength(1);
    });

    it("while the month's interviews are used up the button waits too; a decline taken back still gets the link once more are added", async () => {
      const [ent] = await container.db.select().from(entitlements).where(and(eq(entitlements.companyId, companyId), eq(entitlements.key, "text_screens")));
      await container.db.update(entitlements).set({ used: ent.limit ?? 0 }).where(eq(entitlements.id, ent.id));
      const email = "lou.wait@example.com";
      let id = "";
      try {
        await applyAs({ first: "Lou", email });
        await later(0);
        id = (await appOf(email)).id;
        expect((await interviewRun(id)).state).toMatchObject({ waitingForAllowance: expect.any(String) });
        expect((await detailOf(id)).blockedReasons.invite_screen).toBe(PREPARING);
        expect((await act(id, { action: "invite_screen" })).status).toBe(409);
        // declined privately; the run sees it at its next look and ends; then the decision is taken back
        expect((await act(id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
        await later(7 * HOUR);
        expect((await interviewRun(id)).status).toBe("completed");
        expect((await act(id, { action: "undo_decision" })).status).toBe(200);
        expect((await appOf(email)).stage).toBe("triaged");
      } finally {
        await container.db.update(entitlements).set({ used: ent.used }).where(eq(entitlements.id, ent.id));
      }
      await later(7 * HOUR);
      expect((await appOf(email)).stage).toBe("screen_invited");
      const [scr] = await screensOf(id);
      const mail = mailTo(email);
      expect(mail).toHaveLength(2);
      expect(mail[0].text).not.toContain("/c/screen/");
      expect(mail[1].subject).toBe(`Your next step: a short AI interview for ${role.title}`);
      expect(linkIn(mail[1].text)).toBe(scr.token);
    });

    it("'Review anyway' after the interview's run ended: the reading, then the link by itself", async () => {
      const email = "max.review@example.com";
      await applyAs({ first: "Max", email, no: true });
      await later(0);
      const a = await appOf(email);
      expect(a.stage).toBe("ineligible");
      expect((await act(a.id, { action: "reject", reason: "eligibility" })).status).toBe(200);
      await later(2 * DAY);
      expect((await interviewRun(a.id)).status).toBe("completed");
      const reopened = await act(a.id, { action: "review_anyway" });
      expect(reopened.status).toBe(200);
      expect(await reopened.json()).toMatchObject({ stage: "eligible", ownerStage: "no_ai_interview" });
      await later(0);
      expect((await appOf(email)).stage).toBe("screen_invited");
      expect(await triageOf(a.id)).toHaveLength(1);
      const [scr] = await screensOf(a.id);
      const mail = mailTo(email);
      expect(mail).toHaveLength(2);
      expect(mail[0].text).not.toContain("/c/screen/");
      expect(linkIn(mail[1].text)).toBe(scr.token);
    });

    it("'Send a new AI interview link' after the interview lapsed is the same AI interview, on the web", async () => {
      const email = "pia.again@example.com";
      await applyAs({ first: "Pia", email });
      await later(0);
      const a = await appOf(email);
      await later(INVITE_HOURS * HOUR + 1000);
      await later(REMIND_HOURS * HOUR + 1000);
      // the link lapsed: they stay under "No AI interview yet" (R20-7), where "Send a new link" is offered
      expect((await appOf(email)).stage).toBe("screen_invited");
      expect((await detailOf(a.id)).allowedActions).toContain("invite_screen");
      expect((await act(a.id, { action: "invite_screen" })).status).toBe(200);
      await later(0);
      const fresh = (await screensOf(a.id)).find((s) => s.status === "invited")!;
      expect(fresh.channel).toBe("web");
      expect(fresh.progress.flow).toBe("one_visit");
      expect(linkIn(mailTo(email).at(-1)!.text)).toBe(fresh.token);
    });

    it("an 'Invite to a screening chat?' still waiting from before 20 October is retired on the daily check, and the AI interview goes by itself", async () => {
      providerDown("triage.assess");
      const email = "quinn.old@example.com";
      let id = "";
      let requestId = "";
      try {
        await applyAs({ first: "Quinn", email });
        await later(0);
        id = (await appOf(email)).id;
        // as before the deploy: read and triaged, no interview run, an invitation waiting for a person
        await withTenant(container.db, companyId, async (tx) => {
          for (const r of await tx.select().from(workflowRuns).where(sql`${workflowRuns.subject}->>'id' = ${id}`)) await container.engine.cancel(tx, r.id, { kind: "system", id: "test" }, "as before the deploy");
          await tx.update(applications).set({ stage: "triaged" }).where(eq(applications.id, id));
          const [req] = await tx.insert(approvalRequests).values({ companyId, roleId: role.id, applicationId: id, actionType: "application.invite_screen", subject: { type: "application", id }, requestedBy: { kind: "agent", id: "triage" }, rationale: "Invite to a screening chat?" }).returning({ id: approvalRequests.id });
          requestId = req.id;
        });
      } finally {
        providerBack();
      }
      await later(DAY + 1000);
      const [req] = await container.db.select().from(approvalRequests).where(eq(approvalRequests.id, requestId));
      expect(req.status).toBe("cancelled");
      expect((await appOf(email)).stage).toBe("screen_invited");
      const [scr] = await screensOf(id);
      expect(scr.invitedVia).toBe("with_application");
      expect(mailTo(email).filter((m) => linkIn(m.text) === scr.token)).toHaveLength(1);
    });

    it("'Keep them in' after the sixty days the run waits: it starts again and the link goes", async () => {
      const email = "nia.late@example.com";
      await applyAs({ first: "Nia", email, no: true });
      await later(0);
      const a = await appOf(email);
      await later(61 * DAY);
      expect((await interviewRun(a.id)).status).toBe("completed");
      expect((await act(a.id, { action: "override_eligibility", note: "She has her licence." })).status).toBe(200);
      await later(0);
      expect((await appOf(email)).stage).toBe("screen_invited");
      const [scr] = await screensOf(a.id);
      const mail = mailTo(email);
      expect(mail).toHaveLength(2);
      expect(linkIn(mail[1].text)).toBe(scr.token);
    });
  });
});

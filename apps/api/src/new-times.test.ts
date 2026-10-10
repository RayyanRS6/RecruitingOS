import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { activeFollowUpsFor, anonymizeCandidate, cancelledView, entitlements, grantStaffAccess } from "@ros/core";
import { newTimesDayWords } from "@ros/agents";
import { applications, communications, companies, events, interviewFollowups, interviewParticipants, interviews, notifications, takeovers, users, withPlatform, withTenant, workflowRuns, type WaitCondition } from "@ros/db";
import type { FakeEmailAdapter } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { unverifyCompany, verifyCompany } from "./services/company-trust";
import { handleCandidateReply } from "./services/replies";
import { signInAs, signInStaff } from "./test-helpers";

/**
 * The Cancelled column end to end (founder decisions 1A to 4A, 9 October 2026), through the API, the candidate's pages
 * and the workflows, with the engine's clock moved to each promised day. A candidate who cancels and asks for new times
 * gets one automatic set after the working days: the interview a person approved is reopened, never a new one, and the
 * set counts as sent only once its email is on its way. Everything that should stop it does (a person's send, stop, a
 * decision, a takeover, a reply asking for a person, the ITS check, nobody left to interview, a deletion), and the
 * candidate is never promised times that will not come. A no-show is never sent anything automatically; the team sends
 * new times for the same round. The team can send to one person or to many at once.
 */
describe("new times for people under Cancelled", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const BASE = (() => { const d = new Date(); d.setUTCHours(18, 0, 0, 0); return d.getTime(); })(); // 11:00 Pacific today
  const H = 3_600_000;
  const DAY = 24 * H;
  const setClock = (at: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(at); };
  /** Moves the clock to `when` and lets every timer that came due run. */
  const runAt = async (when: number | string) => { setClock(typeof when === "string" ? Date.parse(when) : when); await container.drain(); };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const form = (path: string, fields: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const ivRow = async (id: string) => (await container.db.select().from(interviews).where(eq(interviews.id, id)))[0];
  const appRow = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const followUp = async (applicationId: string) => (await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, applicationId)).orderBy(desc(interviewFollowups.createdAt)))[0];
  const runOf = async (id: string) => (await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)))[0];
  const waitOf = (run: { wait: WaitCondition | null }) => run.wait as { kind: string; until?: string; token?: string; reason?: string } | null;
  const newTimesRuns = (applicationId: string) => container.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "interview_new_times"), sql`${workflowRuns.subject}->>'id' = ${applicationId}`));
  const scheduleRuns = (interviewId: string) => container.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "schedule_interview"), sql`${workflowRuns.subject}->>'id' = ${interviewId}`));
  const slotsEmail = async (interviewId: string, attempt: number) => (await container.db.select().from(communications).where(eq(communications.idempotencyKey, `slots:${interviewId}:${attempt}`)))[0];
  const slotsEmailsOf = (applicationId: string) => container.db.select().from(communications).where(and(eq(communications.applicationId, applicationId), eq(communications.templateKey, "interview_slots"))).orderBy(asc(communications.createdAt));
  const notes = (kind: string) => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, kind))).orderBy(asc(notifications.createdAt));
  const eventsOf = (subjectId: string, type: string) => container.db.select().from(events).where(and(eq(events.subjectId, subjectId), eq(events.type, type))).orderBy(asc(events.id));
  const viewOf = async (applicationId: string) => {
    const v = (await withTenant(container.db, companyId, (tx) => activeFollowUpsFor(tx, [applicationId]))).get(applicationId);
    return v ? cancelledView(v, { timeZone: TZ }) : null;
  };
  const sendNewTimes = (applicationId: string, cookie = owner) => json(cookie, "POST", `/api/v1/applications/${applicationId}/new-times`, {});
  const stopNewTimes = (applicationId: string, cookie = owner) => json(cookie, "POST", `/api/v1/applications/${applicationId}/new-times/stop`, {});
  const act = (applicationId: string, body: Record<string, unknown>) => json(owner, "POST", `/api/v1/applications/${applicationId}/actions`, body);
  /** The candidate's status page: the line under "What happens next", and the whole page. */
  const statusPage = async (applicationId: string) => {
    const html = await (await app.request(`/c/status/${(await appRow(applicationId)).statusToken}`)).text();
    return { line: html.match(/<h2>What happens next<\/h2><p>([^<]*)<\/p>/)?.[1] ?? null, html };
  };
  const page = async (path: string) => {
    const r = await app.request(path);
    return { status: r.status, html: await r.text() };
  };
  const hours = (cookie: string, on: boolean) => json(cookie, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: on ? [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })) : [], bufferMinutes: 15, maxPerDay: 12 });
  /** ITS confirms the company, or takes its confirmation back, as the admin console does. */
  const its = async (verified: boolean) => {
    const actor = { kind: "user" as const, id: ownerId, name: "ITS" };
    await withPlatform(container.db, (tx) => (verified ? verifyCompany(tx, container, { companyId, actor, reason: "test", now: container.engine.clock() }) : unverifyCompany(tx, { companyId, actor, reason: "test" })));
    await container.drain();
  };
  /** The status page's line promises nothing about new times or a cancellation (it is the standard line, or the screening link's). */
  const promisesNothing = (line: string | null) => {
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/new times|cancel|times we sent|next steps/i);
  };
  const TZ = "America/Los_Angeles";

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let roleTitle = "";
  let roundKey = "";
  let otherRoleId = "";
  let otherRoundKey = "";
  let grace = "";
  let graceId = "";
  let mia = "";
  let miaId = "";
  let ivan = "";
  let n = 0;

  const apply = async (first: string, last: string, role = roleId) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@newtimes.test`;
    const r0 = (await (await json(owner, "GET", `/api/v1/roles/${role}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", first);
    fd.set("lastName", last);
    fd.set("email", email);
    fd.set("locationText", "Tustin, CA");
    fd.set("resume", new File([`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present`], "resume.txt", { type: "text/plain" }));
    for (const rule of r0.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${role}/apply`, { method: "POST", body: fd });
    expect(r.status).toBe(302);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(eq(applications.roleId, role)).orderBy(desc(applications.createdAt)).limit(1);
    return { id: a.id, email, name: `${first} ${last}` };
  };
  const pick = async (token: string, slotId: string) => {
    expect((await form(`/c/schedule/${token}`, { slotId, timezone: TZ })).status).toBe(302);
    await container.drain();
  };
  type Person = Awaited<ReturnType<typeof apply>> & { ivId: string; token: string };
  /** Applies, the owner approves the round, and the candidate books the first offered time. */
  const book = async (first: string, last: string, opts: { interviewers?: string[]; role?: string; round?: string } = {}): Promise<Person> => {
    const cand = await apply(first, last, opts.role);
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey: opts.round ?? roundKey, interviewerUserIds: opts.interviewers ?? [ownerId], linkSource: "calendar" });
    expect(r.status, await r.clone().text()).toBe(201);
    const { id } = (await r.json()) as { id: string };
    const row = await ivRow(id);
    expect(row.status, `${first}: times must be on offer`).toBe("scheduling");
    await pick(row.scheduleToken!, row.offeredSlots[0].id);
    expect((await ivRow(id)).status).toBe("scheduled");
    return { ...cand, ivId: id, token: row.scheduleToken! };
  };
  /** The candidate cancels from the confirmed page with their choice (Post/Redirect/Get). */
  const cancel = async (p: Person, next: "new_times" | "not_interested") => {
    const r = await form(`/c/schedule/${p.token}/cancel`, { confirm: "yes", next });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/c/schedule/${p.token}/cancelled`);
    await container.drain();
    return followUp(p.id);
  };
  const dayOf = (at: string | null) => newTimesDayWords(at!, TZ);
  /**
   * Runs `fn` with the engine's clock on the real one, then puts it back. A decision is dated on the real clock, and the
   * untold safety net reads it on the engine's: made and taken back there, it is never told first. Setup's fresh sign-in
   * is judged on the engine's clock too.
   */
  const onRealClock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const at = container.engine.clock().getTime();
    setClock(Date.now());
    try {
      return await fn();
    } finally {
      setClock(at);
    }
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", RATE_LIMIT_OVERRIDES: JSON.stringify({ apply: 1000, "candidate.schedule": 1000, "candidate.pages": 10000, "candidate.cancel_interview": 100, "candidate.withdraw": 100 }) } });
    app = createApp(container);
    setClock(BASE);
    owner = await signIn("owner@newtimes.test");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@newtimes.test"));
    ownerId = u.id;
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    expect((await container.db.select({ tz: companies.timezone }).from(companies).where(eq(companies.id, companyId)))[0].tz).toBe(TZ);
    await entitlements.applyPlan(container.db, companyId, "growth");
    const makeRole = async () => {
      const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
      const id = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
      expect((await json(owner, "POST", `/api/v1/roles/${id}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
      const role = (await (await json(owner, "GET", `/api/v1/roles/${id}`)).json()) as { title: string; currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
      return { id, title: role.title, round: role.currentPacket.packet.interviews.plan[0].key };
    };
    const main = await makeRole();
    roleId = main.id;
    roleTitle = main.title;
    roundKey = main.round;
    const other = await makeRole();
    otherRoleId = other.id;
    otherRoundKey = other.round;
    await container.drain();
    expect((await hours(owner, true)).status).toBe(200);
    // two interviewers who will be removed from the team, and one who stays (and may not send new times)
    grace = await signInAs(container, app, { companyId, role: "interviewer", email: "grace@newtimes.test", name: "Grace Hill" });
    mia = await signInAs(container, app, { companyId, role: "interviewer", email: "mia@newtimes.test", name: "Mia Lund" });
    ivan = await signInAs(container, app, { companyId, role: "interviewer", email: "ivan@newtimes.test", name: "Ivan Petrov" });
    for (const cookie of [grace, mia]) expect((await hours(cookie, true)).status).toBe(200);
    graceId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "grace@newtimes.test")))[0].id;
    miaId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "mia@newtimes.test")))[0].id;
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  // First, while the engine's clock is near the real one: the decision's own date is written on the real clock (as its
  // messages' dates are, which decision-messages.ts compares with it), and the untold safety net (five working days, Q27)
  // must not have sent the decision before it is taken back. Later tests decide on the real clock (`onRealClock`).
  it("a private decline while the set waits: nothing goes and nothing is promised; taken back before the day, the set goes on the day; taken back after it, nothing goes and the team decides", async () => {
    const declined = await book("Eve", "Moss");
    const early = await book("Finn", "Lee");
    const late = await book("Gia", "Rossi");
    const due = (await cancel(declined, "new_times")).autoDueAt!;
    await cancel(early, "new_times");
    await cancel(late, "new_times");
    for (const p of [declined, early, late]) {
      expect((await act(p.id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
      expect(await followUp(p.id)).toMatchObject({ resolvedHow: "left_process", autoState: "not_sent", autoReason: "left_process" });
    }
    // the candidate was not told: their pages stand where they were, and promise no times
    expect((await statusPage(declined.id)).line).toBe("The hiring team is reviewing your application. You will hear from them either way.");
    for (const path of [`/c/schedule/${declined.token}/confirmed`, `/c/schedule/${declined.token}`]) {
      const html = (await page(path)).html;
      expect(html, path).toContain("<h1>You cancelled this interview</h1>");
      expect(html, path).toContain("<p>The hiring team will be in touch.</p>");
      expect(html.slice(html.indexOf("<h1>")), path).not.toMatch(/new times/);
    }
    // taken back before the day: under Cancelled again with the same choice, the set waiting for the same day
    const undoEarly = await act(early.id, { action: "undo_decision" });
    expect(undoEarly.status, await undoEarly.clone().text()).toBe(200);
    expect(await followUp(early.id)).toMatchObject({ resolvedAt: null, choice: "new_times", autoState: "waiting" });
    expect((await page(`/c/schedule/${early.token}/confirmed`)).html).toContain(`We will email you new times on ${dayOf(due)}, unless the team gets in touch first.`);

    await runAt(due);
    expect(await followUp(early.id)).toMatchObject({ autoState: "sent", timesSentCount: 1 });
    // the declined person's timer wakes, finds them gone, and writes nothing
    expect((await runOf((await followUp(declined.id)).autoRunId!)).status).toBe("completed");
    expect((await ivRow(declined.ivId)).status).toBe("cancelled");
    expect(await followUp(declined.id)).toMatchObject({ autoState: "not_sent", autoReason: "left_process" });
    // taken back after the day: back under Cancelled, nothing went, the team decides
    const undoLate = await act(late.id, { action: "undo_decision" });
    expect(undoLate.status, await undoLate.clone().text()).toBe(200);
    expect(await followUp(late.id)).toMatchObject({ resolvedAt: null, autoState: "not_sent", autoReason: "left_process" });
    expect(await viewOf(late.id)).toMatchObject({ auto: { reasonText: "Nothing went automatically while a decision was in place." }, status: "Waiting for you" });
    await container.drain();
    expect((await ivRow(late.ivId)).status).toBe("cancelled");
  });

  it("the main path: on the promised day the same interview reopens with a fresh window, the times email opens 'As you asked', and only then is the set sent; booking takes them out; a second cancel gets no second set", async () => {
    const p = await book("Ana", "Lopez");
    const before = await ivRow(p.ivId);
    const mails = outbox().length;
    let f = await cancel(p, "new_times");
    expect(f).toMatchObject({ choice: "new_times", autoState: "waiting", resolvedAt: null });
    const due = f.autoDueAt!;
    // the cancel email named the day, and that the team may get in touch first
    const mail = outbox().slice(mails).find((m) => m.to === p.email && /^Cancelled:/.test(m.subject))!;
    expect(mail.text).toContain(`We will email you new times on ${dayOf(due)}, unless the team gets in touch first.`);
    const cancelled = await ivRow(p.ivId);
    expect(cancelled.attempt).toBe(before.attempt + 1);
    // the row the team sees: due on that day, nothing sent
    expect(await viewOf(p.id)).toMatchObject({ reason: "asked_new_times", label: "Asked for new times", times: "none", auto: { state: "waiting", dueAt: new Date(due).toISOString() } });

    // the day before, nothing moves
    await runAt(Date.parse(due) - DAY);
    expect((await followUp(p.id)).autoState).toBe("waiting");
    expect((await ivRow(p.ivId)).status).toBe("cancelled");

    await runAt(due);
    const iv = await ivRow(p.ivId);
    // the same interview, a new attempt, a fresh window, the same link, the interviewers invited again
    expect(iv).toMatchObject({ status: "scheduling", attempt: cancelled.attempt + 1, scheduleToken: p.token });
    expect(iv.schedulingWindow.fromDate! > before.schedulingWindow.fromDate!).toBe(true);
    expect(iv.offeredSlots.length).toBeGreaterThan(0);
    expect((await container.db.select().from(interviewParticipants).where(eq(interviewParticipants.interviewId, p.ivId))).map((x) => x.status)).toEqual(["invited"]);
    expect((await notes("interview.new_times")).some((x) => x.userId === ownerId && x.title === "New times are being set up for Ana Lopez")).toBe(true);
    expect((await eventsOf(p.ivId, "interview.rescheduled")).at(-1)?.payload).toMatchObject({ byCandidate: false, newTimes: true, via: "auto", followUpId: f.id, attempt: iv.attempt });
    // the times email: the new-times opening, the usual template and key
    const email = await slotsEmail(p.ivId, iv.attempt);
    expect(email).toMatchObject({ templateKey: "interview_slots", subject: `New times for your interview: ${roleTitle} at Harbor Dental` });
    expect(email.bodyText).toContain("As you asked when you cancelled, here are new times for your");
    expect(email.bodyText).not.toContain("Good news");
    // only now is the one automatic set sent, and the team told
    f = await followUp(p.id);
    expect(f).toMatchObject({ autoState: "sent", timesSentCount: 1, lastSentVia: "auto", currentInterviewId: p.ivId, lastOfferKey: `slots:${p.ivId}:${iv.attempt}`, resolvedAt: null });
    expect((await runOf(f.autoRunId!)).status).toBe("completed");
    expect((await notes("interview.new_times_sent")).filter((x) => x.title === "New times went to Ana Lopez")).toHaveLength(1);
    expect(await viewOf(p.id)).toMatchObject({ times: "out", lastSentVia: "auto" });
    // the old link opens the new times
    const picker = await page(`/c/schedule/${p.token}`);
    expect(picker.status).toBe(200);
    expect(picker.html).toContain('name="slotId"');

    // she books: out of Cancelled, back under Interviewing
    await pick(p.token, iv.offeredSlots[0].id);
    expect((await ivRow(p.ivId)).status).toBe("scheduled");
    expect(await followUp(p.id)).toMatchObject({ resolvedHow: "rebooked" });
    expect((await appRow(p.id)).stage).toBe("interview_scheduled");

    // she cancels again and asks again: one automatic set, ever
    f = await cancel(p, "new_times");
    expect(f).toMatchObject({ choice: "new_times", autoState: "none", autoReason: "already_used", resolvedAt: null });
    expect(await newTimesRuns(p.id)).toHaveLength(1);
    expect((await page(`/c/schedule/${p.token}/cancelled`)).html).toMatch(/team know you would like new times\. Someone from the team will be in touch about them\./);
  });

  it("nothing counts as sent until the email exists: while the interviewers' hours are unknown the set is being prepared and the link says so; the team cancelling that interview takes them out, and a later cancel can arm a new set", async () => {
    const p = await book("Ben", "Ortiz");
    const f0 = await cancel(p, "new_times");
    await hours(owner, false);
    try {
      await runAt(f0.autoDueAt!);
      const iv = await ivRow(p.ivId);
      expect(iv).toMatchObject({ status: "scheduling", offeredSlots: [] });
      expect(await followUp(p.id)).toMatchObject({ autoState: "preparing", currentInterviewId: p.ivId, timesSentCount: 0, autoSentAt: null });
      expect(await slotsEmail(p.ivId, iv.attempt)).toBeUndefined();
      expect(await viewOf(p.id)).toMatchObject({ times: "preparing", status: "Getting new times ready" });
      expect((await (await json(owner, "GET", `/api/v1/interviews/${p.ivId}`)).json()) as { followUp: unknown }).toMatchObject({ followUp: { reason: "asked_new_times", times: "preparing" } });
      // the old link: not "expired", the times are on their way
      const link = await page(`/c/schedule/${p.token}`);
      expect(link.status).toBe(200);
      expect(link.html).toContain("<h1>We are getting new times ready</h1>");
      expect((await statusPage(p.id)).line).toBe("You asked for new times. We are getting them ready and will email them to you.");
      // the team's notice says why, with one more sentence
      expect((await notes("interview.no_availability")).at(-1)?.body).toContain("Ben cancelled and asked for new times; they go out as soon as there are times to offer.");

      // the team cancels that interview from the Interviews page: out of Cancelled, and the set never went
      expect((await json(owner, "POST", `/api/v1/interviews/${p.ivId}/cancel`, { reason: "We will call Ben instead." })).status).toBe(200);
      await container.drain();
      expect(await followUp(p.id)).toMatchObject({ resolvedHow: "team_cancelled", autoState: "not_sent", autoReason: "team_acted" });
      expect((await eventsOf(p.id, "application.left_cancelled")).at(-1)?.payload).toMatchObject({ how: "team_cancelled", autoStopped: true });
      // the team's cancellation, never "You cancelled"
      for (const path of [`/c/schedule/${p.token}/confirmed`, `/c/schedule/${p.token}`]) {
        const html = (await page(path)).html;
        expect(html, path).toContain("These interview times are no longer available");
        expect(html, path).not.toContain("You cancelled");
      }
      promisesNothing((await statusPage(p.id)).line);
    } finally {
      await hours(owner, true);
      await container.drain();
    }
    // a person approves a new interview; she books it, then cancels it asking for new times: a set that never went was not used
    const r = await json(owner, "POST", `/api/v1/applications/${p.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar" });
    expect(r.status).toBe(201);
    const next = (await r.json()) as { id: string };
    const row = await ivRow(next.id);
    await pick(row.scheduleToken!, row.offeredSlots[0].id);
    const again = await cancel({ ...p, ivId: next.id, token: row.scheduleToken! }, "new_times");
    expect(again).toMatchObject({ interviewId: next.id, autoState: "waiting" });
  });

  it("a person's send before the day replaces the automatic set: it is stopped with its timer, the times go out as the person's, and nothing more goes on the day", async () => {
    const p = await book("Cara", "Diaz");
    const f0 = await cancel(p, "new_times");
    const r = await sendNewTimes(p.id);
    expect(r.status, await r.clone().text()).toBe(200);
    const body = (await r.json()) as { ok: boolean; via: string; interviewId: string; cancelled: { reason: string; auto: { state: string; reason: string | null } } };
    expect(body).toMatchObject({ ok: true, via: "reopened", interviewId: p.ivId, cancelled: { reason: "asked_new_times", auto: { state: "not_sent", reason: "team_acted" } } });
    const f = await followUp(p.id);
    expect(f).toMatchObject({ autoState: "not_sent", autoReason: "team_acted", timesSentCount: 1, lastSentVia: "person", resolvedAt: null });
    expect((await runOf(f0.autoRunId!)).status).toBe("cancelled");
    expect((await eventsOf(p.id, "human.override")).map((e) => e.payload)).toContainEqual(expect.objectContaining({ action: "interview.new_times", followUpId: f.id }));
    const iv = await ivRow(p.ivId);
    expect((await slotsEmail(p.ivId, iv.attempt)).bodyText).toContain("As you asked when you cancelled");
    // a person's send is theirs: not the automatic set, so no "went automatically" notice
    expect((await notes("interview.new_times_sent")).filter((x) => x.title === "New times went to Cara Diaz")).toHaveLength(0);
    // while those times are out, a second send is refused in plain words
    const twice = await sendNewTimes(p.id);
    expect(twice.status).toBe(409);
    expect(await twice.json()).toMatchObject({ error: { code: "times_out", message: "New times are already being prepared or are out to them." } });
    // the promised day comes: nothing more goes
    const sent = (await slotsEmailsOf(p.id)).length;
    await runAt(Date.parse(f0.autoDueAt!) + H);
    expect(await slotsEmailsOf(p.id)).toHaveLength(sent);
    expect((await followUp(p.id)).autoState).toBe("not_sent");
  });

  it("'Don't send automatically' stops the set and its timer; they stay under Cancelled, and the candidate's pages promise nothing", async () => {
    const p = await book("Dev", "Shah");
    const f0 = await cancel(p, "new_times");
    const r = await stopNewTimes(p.id);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, cancelled: { auto: { state: "not_sent", reason: "stopped_by_team", reasonText: "Someone on your team stopped the automatic new times." }, status: "Waiting for you" } });
    expect(await followUp(p.id)).toMatchObject({ autoState: "not_sent", autoReason: "stopped_by_team", resolvedAt: null });
    expect((await runOf(f0.autoRunId!)).status).toBe("cancelled");
    expect((await eventsOf(p.id, "human.override")).map((e) => e.payload)).toContainEqual(expect.objectContaining({ action: "interview.new_times_stop", followUpId: f0.id }));
    const again = await stopNewTimes(p.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "nothing_due", message: "Nothing is due to go to them automatically." } });
    const confirmed = (await page(`/c/schedule/${p.token}/confirmed`)).html;
    expect(confirmed).toContain("<h1>You cancelled this interview</h1>");
    expect(confirmed).toContain("<p>The hiring team will be in touch.</p>");
    promisesNothing((await statusPage(p.id)).line);
    await runAt(Date.parse(f0.autoDueAt!) + H);
    expect((await ivRow(p.ivId)).status).toBe("cancelled");
  });

  it("before ITS confirms the company: no set is armed and no day promised at the cancel; the team's send is refused with a plain reason, one by one and in a batch; once ITS confirms, it works", async () => {
    const asked = await book("Hal", "Ng");
    const notInterested = await book("Ida", "Berg");
    await its(false);
    try {
      expect(await cancel(asked, "new_times")).toMatchObject({ autoState: "none", autoReason: "company_not_checked", autoDueAt: null, autoRunId: null });
      await cancel(notInterested, "not_interested");
      expect(await newTimesRuns(asked.id)).toHaveLength(0);
      expect((await page(`/c/schedule/${asked.token}/cancelled`)).html).toMatch(/team know you would like new times\. Someone from the team will be in touch about them\./);
      const refused = await sendNewTimes(asked.id);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toMatchObject({ error: { code: "company_not_checked", message: "New times can go out once ITS confirms your company. Until then, emails to candidates wait." } });
      const batch = await json(owner, "POST", `/api/v1/roles/${roleId}/new-times`, { applicationIds: [asked.id, notInterested.id] });
      expect(batch.status).toBe(200);
      const result = (await batch.json()) as { results: Array<{ applicationId: string; name: string; ok: boolean; code?: string }>; sent: number; notSent: number };
      expect(result).toMatchObject({ sent: 0, notSent: 2 });
      expect(result.results.map((x) => [x.name, x.ok, x.code])).toEqual([["Hal Ng", false, "company_not_checked"], ["Ida Berg", false, "company_not_checked"]]);
      expect((await ivRow(asked.ivId)).status).toBe("cancelled");
    } finally {
      await its(true);
    }
    const r = await sendNewTimes(asked.id);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ via: "reopened" });
  });

  it("ITS takes its confirmation back after the set was armed: on the day it waits for the check; a retry's wake changes nothing; once confirmed it is prepared, its held email starts no offer clock, and it is sent when the email leaves; never confirmed, the team is told ten days later", async () => {
    const k = await book("Kai", "Moreno");
    const due = (await cancel(k, "new_times")).autoDueAt!;
    await hours(owner, false);
    await its(false);
    try {
      await runAt(due);
      let f = await followUp(k.id);
      expect(f).toMatchObject({ autoState: "waiting_check", autoReason: null });
      expect((await ivRow(k.ivId)).status).toBe("cancelled");
      let run = await runOf(f.autoRunId!);
      expect(run).toMatchObject({ status: "waiting", currentStep: "send" });
      expect(waitOf(run)).toMatchObject({ kind: "event", until: new Date(Date.parse(due) + 10 * DAY).toISOString(), reason: "waiting for ITS to confirm the company" });
      expect(await viewOf(k.id)).toMatchObject({ status: "New times wait for the ITS company check" });
      expect((await page(`/c/schedule/${k.token}/confirmed`)).html).toContain("We will email you new times as soon as they are ready.");
      // a retry wakes on a timer too: before the tenth day it waits again and writes nothing
      setClock(Date.parse(due) + 3 * DAY);
      await container.engine.tick(run.id, { kind: "timer", key: waitOf(run)?.token });
      expect((await followUp(k.id)).autoState).toBe("waiting_check");
      expect(await runOf(run.id)).toMatchObject({ status: "waiting", currentStep: "send" });

      // ITS confirms: the interview reopens and the set is being prepared, not sent (nobody's hours are known)
      await its(true);
      f = await followUp(k.id);
      expect(f).toMatchObject({ autoState: "preparing", timesSentCount: 0 });
      expect((await ivRow(k.ivId)).status).toBe("scheduling");
      expect((await statusPage(k.id)).line).toBe("You asked for new times. We are getting them ready and will email them to you.");

      // ITS takes it back again before the times exist: the times email is held, and the offer clock does not start
      await its(false);
      await hours(owner, true);
      await container.drain();
      const iv = await ivRow(k.ivId);
      expect((await slotsEmail(k.ivId, iv.attempt)).status).toBe("held");
      expect((await eventsOf(k.ivId, "interview.slots_offered")).filter((e) => e.payload.attempt === iv.attempt)).toHaveLength(0);
      run = (await scheduleRuns(k.ivId)).find((x) => (x.state as { attempt: number }).attempt === iv.attempt)!;
      expect(run).toMatchObject({ status: "waiting", currentStep: "offer_slots" });
      expect(waitOf(run)).toMatchObject({ kind: "event", reason: "the new times wait for ITS to confirm the company" });
      expect(waitOf(run)?.until).toBeUndefined();
      expect(await followUp(k.id)).toMatchObject({ autoState: "preparing", timesSentCount: 0 });
      expect(await viewOf(k.id)).toMatchObject({ times: "held", status: "New times wait for the ITS company check" });
      const status = await statusPage(k.id);
      expect(status.line).toBe("You asked for new times. We are getting them ready and will email them to you.");
      expect(status.html).not.toContain("Choose a time");
      // the old link: the times exist, but their email waits, so they are not offered there and a pick is not taken
      expect((await page(`/c/schedule/${k.token}`)).html).toContain("<h1>We are getting new times ready</h1>");
      const tried = await form(`/c/schedule/${k.token}`, { slotId: iv.offeredSlots[0].id, timezone: TZ });
      expect(tried.status).toBe(302);
      expect(tried.headers.get("location")).toBe(`/c/schedule/${k.token}`);
      expect((await ivRow(k.ivId)).selectedSlot).toBeNull();

      // ITS confirms: the email leaves, and only then is the offer recorded and the set sent
      await its(true);
      expect(["queued", "sending", "sent", "delivered"]).toContain((await slotsEmail(k.ivId, iv.attempt)).status);
      expect((await eventsOf(k.ivId, "interview.slots_offered")).filter((e) => e.payload.attempt === iv.attempt)).toHaveLength(1);
      expect(await followUp(k.id)).toMatchObject({ autoState: "sent", timesSentCount: 1 });
    } finally {
      await hours(owner, true);
      await its(true);
    }

    // never confirmed: ten days after the promised day the set did not go, and the team is told
    const l = await book("Lia", "Santos");
    const lateDue = (await cancel(l, "new_times")).autoDueAt!;
    await its(false);
    try {
      await runAt(lateDue);
      expect((await followUp(l.id)).autoState).toBe("waiting_check");
      await runAt(Date.parse(lateDue) + 10 * DAY);
      expect(await followUp(l.id)).toMatchObject({ autoState: "not_sent", autoReason: "company_not_checked", resolvedAt: null });
      expect((await ivRow(l.ivId)).status).toBe("cancelled");
      const told = (await notes("interview.new_times_not_sent")).filter((x) => x.title === "New times for Lia Santos were not sent");
      expect(told).toHaveLength(1);
      expect(told[0].body).toBe(`Lia asked for new times, due ${dayOf(lateDue)}. ITS has not confirmed your company yet, so nothing could be sent automatically. They are under Cancelled: send new times when you are ready, or decide.`);
    } finally {
      await its(true);
    }
  });

  it("a takeover started after arming: the set does not go and the team is told why", async () => {
    const p = await book("Mae", "Cole");
    const due = (await cancel(p, "new_times")).autoDueAt!;
    const [takeover] = await container.db.insert(takeovers).values({ companyId, roleId, recruiterUserId: ownerId, status: "active" }).returning();
    try {
      await runAt(due);
      expect(await followUp(p.id)).toMatchObject({ autoState: "not_sent", autoReason: "takeover" });
      expect((await ivRow(p.ivId)).status).toBe("cancelled");
      const told = (await notes("interview.new_times_not_sent")).filter((x) => x.title === "New times for Mae Cole were not sent");
      expect(told[0]?.body).toContain("An ITS recruiter is running this role, so nothing was sent automatically.");
    } finally {
      await container.db.update(takeovers).set({ status: "ended" }).where(eq(takeovers.id, takeover.id));
    }
  });

  it("with nobody left who ran the interview, the set does not go, the team is told, and the team's send says to choose interviewers", async () => {
    const p = await book("Ned", "Ford", { interviewers: [graceId] });
    const due = (await cancel(p, "new_times")).autoDueAt!;
    expect((await json(owner, "PATCH", `/api/v1/companies/current/members/${graceId}`, { status: "removed" })).status).toBe(200);
    await runAt(due);
    expect(await followUp(p.id)).toMatchObject({ autoState: "not_sent", autoReason: "no_interviewers" });
    expect((await notes("interview.new_times_not_sent")).find((x) => x.title === "New times for Ned Ford were not sent")?.body).toContain("Nobody who ran the interview is still on your team.");
    const r = await sendNewTimes(p.id);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ error: { code: "no_interviewers", message: "Nobody who ran that interview is still on your team. Approve a new interview from their page and choose the interviewers." } });
  });

  it("the team cancelling the reopened interview, here by removing its only interviewer, takes them out of Cancelled, and every page shows the team's cancellation, never 'You cancelled'", async () => {
    const p = await book("Ola", "Berg", { interviewers: [miaId] });
    await cancel(p, "new_times");
    expect((await sendNewTimes(p.id)).status).toBe(200);
    expect((await ivRow(p.ivId)).status).toBe("scheduling");
    expect((await json(owner, "PATCH", `/api/v1/companies/current/members/${miaId}`, { status: "removed" })).status).toBe(200);
    await container.drain();
    expect((await ivRow(p.ivId)).status).toBe("cancelled");
    expect(await followUp(p.id)).toMatchObject({ resolvedHow: "team_cancelled", autoState: "not_sent", autoReason: "team_acted" });
    for (const path of [`/c/schedule/${p.token}/confirmed`, `/c/schedule/${p.token}`]) {
      const html = (await page(path)).html;
      expect(html, path).toContain("These interview times are no longer available");
      expect(html, path).not.toContain("You cancelled");
    }
    expect((await page(`/c/schedule/${p.token}/cancelled`)).status).toBe(302);
    promisesNothing((await statusPage(p.id)).line);
  });

  it("a deletion at the person's request while the set waits, or while it is being prepared: they leave the column and nothing is sent", async () => {
    const waiting = await book("Pam", "Ruiz");
    const preparing = await book("Quin", "Webb");
    const due = (await cancel(waiting, "new_times")).autoDueAt!;
    await cancel(preparing, "new_times");
    const erase = async (p: Person) => {
      const { candidateId } = await appRow(p.id);
      await withTenant(container.db, companyId, (tx) => anonymizeCandidate(tx, { companyId, candidateId, actor: { kind: "system", id: "new-times.test" }, deleteFile: async () => undefined, now: container.engine.clock() }));
      await container.drain();
    };
    await erase(waiting);
    expect(await followUp(waiting.id)).toMatchObject({ resolvedHow: "left_process", autoState: "not_sent", autoReason: "left_process" });
    await hours(owner, false);
    try {
      await runAt(due);
      expect((await runOf((await followUp(waiting.id)).autoRunId!)).status).toBe("completed");
      expect((await ivRow(waiting.ivId)).status).toBe("cancelled");
      expect((await followUp(preparing.id)).autoState).toBe("preparing");
      await erase(preparing);
      expect(await followUp(preparing.id)).toMatchObject({ resolvedHow: "left_process", autoState: "not_sent", autoReason: "left_process" });
      expect((await ivRow(preparing.ivId)).status).toBe("cancelled");
    } finally {
      await hours(owner, true);
      await container.drain();
    }
    const iv = await ivRow(preparing.ivId);
    expect(await slotsEmail(preparing.ivId, iv.attempt)).toBeUndefined();
    expect(await slotsEmail(preparing.ivId, iv.attempt - 1)).toBeUndefined();
  });

  it("replies: HUMAN or 'no thanks' stops a set that waits, and the team is told; any other reply leaves it and names its day; a no-show's reply says where they are", async () => {
    const reply = async (p: Person, text: string) => {
      const a = await appRow(p.id);
      await withTenant(container.db, companyId, (tx) => handleCandidateReply(tx, container, { app: a, mail: { to: "reply@harbor.test", from: p.email, subject: "Re: Cancelled", text, attachments: [], messageId: `<${randomUUID()}@mail.test>`, receivedAt: container.engine.clock().toISOString() } }));
      await container.drain();
      return (await notes("message.received")).filter((x) => x.title === `${p.name} wrote back`).at(-1)?.body;
    };
    const human = await book("Raj", "Patel");
    const hf = await cancel(human, "new_times");
    expect(await reply(human, "HUMAN")).toBe(`They asked for a person about ${roleTitle}. A recruiter has been asked to follow up; you can also reply yourself. Their automatic new times, due ${dayOf(hf.autoDueAt)}, were stopped: a person should arrange the next step with them. They are under Cancelled.`);
    expect(await followUp(human.id)).toMatchObject({ autoState: "not_sent", autoReason: "candidate_replied", resolvedAt: null });
    expect((await runOf(hf.autoRunId!)).status).toBe("cancelled");

    const no = await book("Sam", "Quist");
    const nf = await cancel(no, "new_times");
    // something was changed (the set was stopped), so the notice never says nothing was
    expect(await reply(no, "No thanks")).toBe(`About ${roleTitle}: "No thanks". This may mean they do not want to go ahead with this step. Reply to check with them. Their automatic new times, due ${dayOf(nf.autoDueAt)}, were stopped: a person should arrange the next step with them. They are under Cancelled.`);
    expect(await followUp(no.id)).toMatchObject({ autoState: "not_sent", autoReason: "candidate_replied" });

    const other = await book("Tia", "Vance");
    const of = await cancel(other, "new_times");
    expect(await reply(other, "Could we do Friday instead?")).toBe(`About ${roleTitle}: "Could we do Friday instead?" New times are due to go to them automatically on ${dayOf(of.autoDueAt)}. Open them under Cancelled to send them now or stop them.`);
    expect(await followUp(other.id)).toMatchObject({ autoState: "waiting" });
    expect((await runOf(of.autoRunId!)).status).toBe("waiting");

    const missed = await book("Uli", "Wolf");
    expect((await json(owner, "POST", `/api/v1/interviews/${missed.ivId}/outcome`, { outcome: "no_show_candidate" })).status).toBe(200);
    expect(await reply(missed, "Sorry, I was sick that day.")).toMatch(/ They are under Cancelled as a no-show\.$/);
  });

  it("a no-show goes under Cancelled and is never sent anything automatically; the team's send, or the usual approval, sets up the same round with the new-times wording and marks the missed interview decided", async () => {
    const p = await book("Vic", "Young");
    const outcome = await json(owner, "POST", `/api/v1/interviews/${p.ivId}/outcome`, { outcome: "no_show_candidate" });
    expect(((await outcome.json()) as { followUp: unknown }).followUp).toMatchObject({ reason: "no_show", times: "none" });
    let f = await followUp(p.id);
    expect(f).toMatchObject({ kind: "candidate_no_show", choice: null, autoState: "none", autoReason: "no_show" });
    expect(await newTimesRuns(p.id)).toHaveLength(0);
    expect(await viewOf(p.id)).toMatchObject({ reason: "no_show", label: "No-show", status: "Waiting for you" });
    expect((await statusPage(p.id)).line).toBe("The hiring team will be in touch about next steps.");
    // the approval card proposes the same round
    expect(await (await json(owner, "GET", `/api/v1/applications/${p.id}/interview-draft`)).json()).toMatchObject({ roundKey, nextRound: false });

    const r = await sendNewTimes(p.id);
    expect(r.status, await r.clone().text()).toBe(200);
    const sent = (await r.json()) as { via: string; interviewId: string; cancelled: unknown };
    expect(sent).toMatchObject({ via: "new_interview", cancelled: { reason: "no_show", label: "No-show" } });
    expect(sent.interviewId).not.toBe(p.ivId);
    const fresh = await ivRow(sent.interviewId);
    expect(fresh).toMatchObject({ roundKey, status: "scheduling" });
    expect(await ivRow(p.ivId)).toMatchObject({ status: "no_show", outcome: "no_show_candidate", decision: "new_times", decisionNote: "New times sent after the candidate did not attend" });
    const overrides = (await eventsOf(p.id, "human.override")).map((e) => e.payload.action);
    expect(overrides).toEqual(expect.arrayContaining(["interview.request", "interview.new_times"]));
    const [run] = await scheduleRuns(sent.interviewId);
    expect(run.state).toMatchObject({ offerKind: "new_times_team", followUpId: f.id, via: "person" });
    const email = await slotsEmail(sent.interviewId, fresh.attempt);
    expect(email.subject).toBe(`New interview times: ${roleTitle} at Harbor Dental`);
    expect(email.bodyText).toContain("Harbor Dental would like to find a new time for your");
    expect(email.bodyText).not.toContain("Good news");
    f = await followUp(p.id);
    expect(f).toMatchObject({ currentInterviewId: sent.interviewId, resolvedAt: null, autoState: "none", timesSentCount: 1, lastSentVia: "person" });
    expect(((await (await json(owner, "GET", `/api/v1/applications/${p.id}`)).json()) as { allowedActions: string[] }).allowedActions).not.toContain("record_decision");

    // the usual "Approve an interview" does exactly the same
    const q = await book("Wes", "Zane");
    expect((await json(owner, "POST", `/api/v1/interviews/${q.ivId}/outcome`, { outcome: "no_show_candidate" })).status).toBe(200);
    const approved = await json(owner, "POST", `/api/v1/applications/${q.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar" });
    expect(approved.status).toBe(201);
    const { id } = (await approved.json()) as { id: string };
    expect((await ivRow(q.ivId)).decision).toBe("new_times");
    expect((await scheduleRuns(id))[0].state).toMatchObject({ offerKind: "new_times_team", via: "person" });
    expect((await slotsEmail(id, (await ivRow(id)).attempt)).bodyText).not.toContain("Good news");
    expect(await followUp(q.id)).toMatchObject({ currentInterviewId: id, autoState: "none", resolvedAt: null });
    expect(((await (await json(owner, "GET", `/api/v1/applications/${q.id}`)).json()) as { allowedActions: string[] }).allowedActions).not.toContain("record_decision");
  });

  it("the team sends new times to several people at once: each result says what happened, one refusal never blocks the rest, and only people who manage interviews may", async () => {
    const asked = await book("Abe", "Hart");
    const notInterested = await book("Bea", "Hunt");
    const timesOut = await book("Cy", "Hale");
    const notUnder = await apply("Dot", "Ives");
    const otherRole = await book("Eli", "Jory", { role: otherRoleId, round: otherRoundKey });
    await cancel(asked, "new_times");
    await cancel(notInterested, "not_interested");
    await cancel(timesOut, "new_times");
    await cancel(otherRole, "new_times");
    expect((await sendNewTimes(timesOut.id)).status).toBe(200);
    // an interviewer may not send them, one by one or at once, nor stop them
    expect((await json(ivan, "POST", `/api/v1/roles/${roleId}/new-times`, { applicationIds: [asked.id] })).status).toBe(403);
    expect((await sendNewTimes(asked.id, ivan)).status).toBe(403);
    expect((await stopNewTimes(asked.id, ivan)).status).toBe(403);

    const ids = [asked.id, notInterested.id, timesOut.id, notUnder.id, otherRole.id];
    const r = await json(owner, "POST", `/api/v1/roles/${roleId}/new-times`, { applicationIds: ids });
    expect(r.status, await r.clone().text()).toBe(200);
    const result = (await r.json()) as { results: Array<{ applicationId: string; name: string; ok: boolean; code?: string; message?: string; interviewId?: string }>; sent: number; notSent: number };
    expect(result).toMatchObject({ sent: 2, notSent: 3 });
    expect(result.results.map((x) => [x.applicationId, x.name, x.ok, x.code ?? null])).toEqual([
      [asked.id, "Abe Hart", true, null],
      [notInterested.id, "Bea Hunt", true, null],
      [timesOut.id, "Cy Hale", false, "times_out"],
      [notUnder.id, "Dot Ives", false, "not_in_cancelled"],
      [otherRole.id, "This candidate", false, "not_in_cancelled"],
    ]);
    expect(result.results[3].message).toBe("They are not under Cancelled any more.");
    expect(result.results[0].interviewId).toBe(asked.ivId);
    // sent as the batch's, counted once their emails left; the automatic set they were waiting for does not go
    expect(await followUp(asked.id)).toMatchObject({ autoState: "not_sent", autoReason: "team_acted", lastSentVia: "batch", timesSentCount: 1 });
    expect(await followUp(notInterested.id)).toMatchObject({ autoState: "none", lastSentVia: "batch", timesSentCount: 1 });
    expect((await slotsEmail(notInterested.ivId, (await ivRow(notInterested.ivId)).attempt)).bodyText).toContain("Harbor Dental would like to find a new time for your");
    expect((await ivRow(otherRole.ivId)).status).toBe("cancelled");
    const batch = await eventsOf(roleId, "interview.new_times_batch");
    expect(batch.at(-1)?.payload).toEqual({ roleId, requested: 5, sent: 2, notSent: 3 });
  });

  it("an automatic send and a person's at the same moment give one interview, one scheduling run and one times email, whichever goes first", async () => {
    // the person first, at the due moment, before the timer ran: the timer then finds its run cancelled
    const a = await book("Fay", "Kim");
    const fa = await cancel(a, "new_times");
    setClock(Date.parse(fa.autoDueAt!));
    expect((await sendNewTimes(a.id)).status).toBe(200);
    await container.drain();
    let iv = await ivRow(a.ivId);
    expect((await scheduleRuns(a.ivId)).filter((x) => x.idempotencyKey === `schedule:${a.ivId}:${iv.attempt}`)).toHaveLength(1);
    expect((await slotsEmailsOf(a.id)).filter((e) => e.idempotencyKey === `slots:${a.ivId}:${iv.attempt}`)).toHaveLength(1);
    expect(await followUp(a.id)).toMatchObject({ autoState: "not_sent", autoReason: "team_acted", lastSentVia: "person" });
    expect((await runOf(fa.autoRunId!)).status).toBe("cancelled");

    // the timer first: the person's send then finds the times out
    const b = await book("Gus", "Lim");
    const fb = await cancel(b, "new_times");
    await runAt(fb.autoDueAt!);
    expect((await followUp(b.id)).autoState).toBe("sent");
    const late = await sendNewTimes(b.id);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: { code: "times_out" } });
    iv = await ivRow(b.ivId);
    expect(await scheduleRuns(b.ivId)).toHaveLength(2); // the first booking's, and the new times'
    expect((await slotsEmailsOf(b.id)).filter((e) => e.idempotencyKey === `slots:${b.ivId}:${iv.attempt}`)).toHaveLength(1);

    // "Approve an interview" at the due moment: one open interview, and the automatic set does not reopen the old one
    const c = await book("Hope", "Mann");
    const fc = await cancel(c, "new_times");
    setClock(Date.parse(fc.autoDueAt!));
    const approved = await json(owner, "POST", `/api/v1/applications/${c.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar" });
    expect(approved.status).toBe(201);
    const { id } = (await approved.json()) as { id: string };
    await container.drain();
    expect((await ivRow(c.ivId)).status).toBe("cancelled");
    expect((await container.db.select().from(interviews).where(eq(interviews.applicationId, c.id))).filter((x) => ["proposed", "scheduling", "scheduled"].includes(x.status)).map((x) => x.id)).toEqual([id]);
    expect(await followUp(c.id)).toMatchObject({ autoState: "not_sent", autoReason: "team_acted", currentInterviewId: id });
    expect((await slotsEmail(id, 1)).bodyText).toContain("As you asked when you cancelled");

    // the timer first, then the approval: refused, the interview is already being set up
    const d = await book("Ivy", "Nash");
    const fd = await cancel(d, "new_times");
    await runAt(fd.autoDueAt!);
    const refused = await json(owner, "POST", `/api/v1/applications/${d.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "interview_open" } });
  });

  it("new times that lapse without a pick leave them under Cancelled with 'Did not pick a new time', and no second set; a person can send again", async () => {
    const p = await book("Jo", "Pike");
    const f0 = await cancel(p, "new_times");
    await runAt(f0.autoDueAt!);
    expect((await followUp(p.id)).autoState).toBe("sent");
    await runAt(Date.parse(f0.autoDueAt!) + 49 * H);
    await runAt(Date.parse(f0.autoDueAt!) + 98 * H);
    expect((await ivRow(p.ivId)).status).toBe("offer_expired");
    expect(await followUp(p.id)).toMatchObject({ autoState: "sent", resolvedAt: null });
    expect(await viewOf(p.id)).toMatchObject({ times: "expired", status: "Did not pick a new time" });
    expect((await notes("interview.offer_expired")).filter((x) => x.action?.href === `/interviews/${p.ivId}`).at(-1)?.body).toBe("Four days passed with a reminder. They stay under Cancelled: send new times again, or decide.");
    expect(await newTimesRuns(p.id)).toHaveLength(1);
    expect((await statusPage(p.id)).line).toBe("The interview times we sent have passed. The hiring team will be in touch.");
    expect((await (await json(owner, "GET", `/api/v1/interviews/${p.ivId}`)).json()) as { followUp: unknown }).toMatchObject({ followUp: { times: "expired" } });
    const again = await sendNewTimes(p.id);
    expect(again.status, await again.clone().text()).toBe(200);
    expect(await again.json()).toMatchObject({ via: "reopened", interviewId: p.ivId });
    expect((await ivRow(p.ivId)).scheduleToken).toBeTruthy();
  });

  it("an ITS recruiter whose access covers one candidate sends new times to that candidate only, and never sees anyone else's name", async () => {
    const mine = await book("Ora", "Pell");
    const other = await book("Pia", "Rand");
    await cancel(mine, "not_interested");
    await cancel(other, "not_interested");
    const email = "sky@its.newtimes.test";
    const cookie = await signInStaff(app, container, email, "its_recruiter", "Sky Recruiter");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    await withPlatform(container.db, (tx) => grantStaffAccess(tx, { userId: u.id, userName: "Sky Recruiter", companyId, kind: "escalation", scope: { roleId, applicationId: mine.id }, purpose: "test: a request about one candidate", grantedBy: { kind: "system", id: "test" }, expiresAt: new Date(Date.now() + 365 * DAY) }));
    expect((await json(cookie, "POST", "/api/v1/auth/switch", { companyId })).status).toBe(200);
    const r = await json(cookie, "POST", `/api/v1/roles/${roleId}/new-times`, { applicationIds: [mine.id, other.id] });
    expect(r.status, await r.clone().text()).toBe(200);
    const result = (await r.json()) as { results: Array<{ applicationId: string; name: string; ok: boolean; code?: string; message?: string }>; sent: number; notSent: number };
    expect(result).toMatchObject({ sent: 1, notSent: 1 });
    expect(result.results.map((x) => [x.applicationId, x.name, x.ok, x.code ?? null])).toEqual([[mine.id, "Ora Pell", true, null], [other.id, "This candidate", false, "staff_scope"]]);
    expect(result.results[1].message).toBe("Your access covers one candidate, so you can send new times to them only.");
    expect(JSON.stringify(result)).not.toContain("Pia");
    expect((await ivRow(mine.ivId)).status).toBe("scheduling");
    expect((await ivRow(other.ivId)).status).toBe("cancelled");
    expect(await followUp(other.id)).toMatchObject({ timesSentCount: 0, currentInterviewId: null });
  });

  it("a decision taken back after the new times went: the interview that carried them is offered again by 'Send new times'", async () => {
    const p = await book("Rob", "Sand");
    const f0 = await cancel(p, "new_times");
    await runAt(f0.autoDueAt!);
    expect(await followUp(p.id)).toMatchObject({ autoState: "sent", currentInterviewId: p.ivId });
    const undo = await onRealClock(async () => {
      expect((await act(p.id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
      expect((await ivRow(p.ivId)).status).toBe("cancelled");
      return act(p.id, { action: "undo_decision" });
    });
    expect(undo.status, await undo.clone().text()).toBe(200);
    expect(await undo.json()).toMatchObject({ ownerStage: "cancelled", next: "Decision taken back: they are back under Cancelled. They were never told. Nothing will be sent until you act." });
    expect(await viewOf(p.id)).toMatchObject({ times: "none", status: "Waiting for you" });
    const r = await sendNewTimes(p.id);
    expect(r.status, await r.clone().text()).toBe(200);
    expect(await r.json()).toMatchObject({ via: "reopened", interviewId: p.ivId });
    expect((await ivRow(p.ivId)).status).toBe("scheduling");
    expect(await followUp(p.id)).toMatchObject({ autoState: "sent", timesSentCount: 2, lastSentVia: "person" });
  });

  it("a decision taken back after automatic times were switched off: back under Cancelled, and nothing goes on the promised day", async () => {
    const p = await book("Sid", "Tran");
    const f0 = await cancel(p, "new_times");
    const setting = (newTimesAfterCancel: Record<string, unknown>) => onRealClock(async () => json(await signIn("owner@newtimes.test"), "PATCH", "/api/v1/companies/current", { settings: { newTimesAfterCancel } }));
    try {
      const undo = await onRealClock(async () => {
        expect((await act(p.id, { action: "reject", reason: "not_a_match_experience" })).status).toBe(200);
        // the declined person's set is not promised to anyone any more, so switching off asks nothing about it
        const off = await setting({ auto: false, workingDays: 3, pending: "keep" });
        expect(off.status, await off.clone().text()).toBe(200);
        return act(p.id, { action: "undo_decision" });
      });
      expect(undo.status, await undo.clone().text()).toBe(200);
      expect(await undo.json()).toMatchObject({ ownerStage: "cancelled", next: "Decision taken back: they are back under Cancelled. They were never told. Nothing will be sent until you act." });
      expect(await followUp(p.id)).toMatchObject({ resolvedAt: null, autoState: "not_sent", autoReason: "left_process" });
      await runAt(f0.autoDueAt!);
      expect((await runOf(f0.autoRunId!)).status).toBe("completed");
      expect((await ivRow(p.ivId)).status).toBe("cancelled");
      expect(await slotsEmailsOf(p.id)).toHaveLength(1); // the first booking's only
    } finally {
      expect((await setting({ auto: true, workingDays: 3 })).status).toBe(200);
    }
  });

  it("'Offer new times' on the interview carrying someone's new times keeps carrying them: the new-times wording, counted once it leaves, and their one automatic set stays used", async () => {
    const p = await book("Uma", "Vale");
    const f0 = await cancel(p, "new_times");
    await hours(owner, false);
    let attempt = 0;
    try {
      await runAt(f0.autoDueAt!);
      expect(await followUp(p.id)).toMatchObject({ autoState: "preparing", currentInterviewId: p.ivId, timesSentCount: 0 });
      // the team offers new times on that interview (a fresh window) while it is still being prepared
      const r = await json(owner, "POST", `/api/v1/interviews/${p.ivId}/reschedule`, {});
      expect(r.status, await r.clone().text()).toBe(200);
      attempt = (await ivRow(p.ivId)).attempt;
      const [run] = (await scheduleRuns(p.ivId)).filter((x) => x.idempotencyKey === `schedule:${p.ivId}:${attempt}`);
      expect(run.state).toMatchObject({ offerKind: "new_times_asked", followUpId: f0.id, via: "person" });
      expect((await eventsOf(p.ivId, "interview.rescheduled")).at(-1)?.payload).toMatchObject({ newTimes: true, via: "person", followUpId: f0.id, attempt });
    } finally {
      await hours(owner, true);
      await container.drain();
    }
    const email = await slotsEmail(p.ivId, attempt);
    expect(email.bodyText).toContain("As you asked when you cancelled, here are new times for your");
    expect(email.bodyText).not.toContain("Good news");
    expect(await followUp(p.id)).toMatchObject({ autoState: "sent", timesSentCount: 1, lastSentVia: "person", lastOfferKey: `slots:${p.ivId}:${attempt}` });
    // she books (the team's re-offer comes with a new link), then cancels again asking for new times: her one automatic set was used
    const iv = await ivRow(p.ivId);
    await pick(iv.scheduleToken!, iv.offeredSlots[0].id);
    expect(await followUp(p.id)).toMatchObject({ resolvedHow: "rebooked", autoState: "sent" });
    expect(await cancel({ ...p, token: iv.scheduleToken! }, "new_times")).toMatchObject({ autoState: "none", autoReason: "already_used" });
  });

  // Last: it closes the role.
  it("the role closing while the set waits: they leave the column and nothing is sent on the day", async () => {
    const p = await book("Kim", "Quade");
    const f0 = await cancel(p, "new_times");
    const closed = await json(owner, "POST", `/api/v1/roles/${roleId}/outcome`, { outcome: "role_cancelled", confirm: true, reason: "Budget pulled." });
    expect(closed.status, await closed.clone().text()).toBe(200);
    await container.drain();
    expect(await followUp(p.id)).toMatchObject({ resolvedHow: "left_process", autoState: "not_sent", autoReason: "left_process" });
    await runAt(f0.autoDueAt!);
    expect((await runOf(f0.autoRunId!)).status).toBe("completed");
    expect((await ivRow(p.ivId)).status).toBe("cancelled");
    // the candidate was not told: their link promises nothing
    const html = (await page(`/c/schedule/${p.token}/confirmed`)).html;
    expect(html).toContain("You cancelled this interview");
    expect(html).toContain("<p>The hiring team will be in touch.</p>");
  });
});

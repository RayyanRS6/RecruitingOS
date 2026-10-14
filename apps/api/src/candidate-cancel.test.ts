import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { entitlements, setMark } from "@ros/core";
import { newTimesDayWords } from "@ros/agents";
import { applicationMarks, applications, communications, companies, events, interviewFollowups, interviews, jobs, notifications, roles, takeovers, users, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter, FakeGoogleCalendarProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The candidate's own cancellation (docs/spec/21 section 7, P0 row "candidate cancel test"; docs/spec/04 "Optional
 * reason; confirm"), with what they would like next (founder decision 2A): new times later, or no longer interested.
 * From the confirmed page, with the choice made and the confirmation ticked and a few words on why if they like. The
 * interview is cancelled with the reason on record, the candidate goes under Cancelled with their choice (1A), the team
 * and the interviewers are told, the calendar events are removed by the worker, the candidate gets a confirmation that
 * says only what will happen for them, a second press changes nothing, and a dead link is refused. The one automatic set
 * of new times (3A) is armed only when nothing stops it: the setting is on, ITS confirmed the company, they did not use
 * both reschedules, no ITS recruiter runs the role, and nobody had put them on hold.
 */
describe("candidate cancels an interview", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  const post = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const gcal = () => container.integrations.calendars.google as FakeGoogleCalendarProvider;
  const interview = async (id: string) => (await container.db.select().from(interviews).where(eq(interviews.id, id)))[0];
  const followUps = (applicationId: string) => container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, applicationId)).orderBy(desc(interviewFollowups.createdAt));
  const newTimesRuns = (applicationId: string) => container.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "interview_new_times"), sql`${workflowRuns.subject}->>'id' = ${applicationId}`));
  const teamNote = async (name: string) => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.cancelled")))).filter((x) => x.title === `${name} cancelled the interview`);
  const statusPage = async (applicationId: string) => {
    const [a] = await container.db.select({ token: applications.statusToken }).from(applications).where(eq(applications.id, applicationId));
    return (await app.request(`/c/status/${a.token}`)).text();
  };
  const setCompanySettings = async (patch: (s: Record<string, unknown>) => Record<string, unknown>) => {
    const [co] = await container.db.select({ settings: companies.settings }).from(companies).where(eq(companies.id, companyId));
    await container.db.update(companies).set({ settings: patch({ ...(co.settings as Record<string, unknown>) }) as never }).where(eq(companies.id, companyId));
  };
  const DATE_HINT = /We will email you new times on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}, unless the team gets in touch first\./;
  const TEAM_HINT = "Someone from the team will be in touch about new times.";

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let roundKey = "";
  let n = 0;

  const apply = async (first: string, last: string) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@cancel.test`;
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const form = new FormData();
    form.set("firstName", first);
    form.set("lastName", last);
    form.set("email", email);
    form.set("locationText", "Tustin, CA");
    form.set("resume", new File([`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nSkills: periodontal charting`], "resume.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) form.set(`elig_${rule.key}`, "yes");
    form.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    form.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: form });
    expect(r.status).toBe(302);
    await container.drain();
    const [a] = await container.db.select().from(applications).where(and(eq(applications.roleId, roleId))).orderBy(desc(applications.createdAt)).limit(1);
    return { id: a.id, email };
  };
  /** The owner approves the round and the candidate books the first offered time; the fake calendar gets the event. */
  const book = async (first: string, last: string) => {
    const cand = await apply(first, last);
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar" });
    expect(r.status, await r.clone().text()).toBe(201);
    const iv = (await r.json()) as { id: string };
    let row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    const pick = await post(`/c/schedule/${row.scheduleToken}`, { slotId: row.offeredSlots[0].id, timezone: "America/Los_Angeles" });
    expect(pick.status).toBe(302);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    expect(Object.keys((row.calendarRefs ?? {}) as Record<string, unknown>)).toHaveLength(1);
    return { cand, id: iv.id, token: row.scheduleToken!, attempt: row.attempt };
  };
  /** Cancels with "Send me new times later" and checks the Post/Redirect/Get. */
  const cancelAsking = async (token: string, extra: Record<string, string> = {}) => {
    const r = await post(`/c/schedule/${token}/cancel`, { confirm: "yes", next: "new_times", ...extra });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/c/schedule/${token}/cancelled`);
    await container.drain();
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    owner = await signIn("owner@cancel.test");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@cancel.test"));
    ownerId = u.id;
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Cancel Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
    roundKey = role.currentPacket.packet.interviews.plan[0].key;
    await container.drain();
    expect((await json(owner, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3 })).status).toBe(200);
    // a connected (fake) Google calendar, so a booking creates an event the cancellation must remove
    const start = await app.request("/api/v1/integrations/calendar/google/connect", { headers: { cookie: owner } });
    expect(start.status).toBe(302);
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    const authorize = new URL(start.headers.get("location")!);
    const consent = await app.request("/api/v1/integrations/calendar/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ redirect_to: `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/google/callback`, state: authorize.searchParams.get("state")!, code_challenge: authorize.searchParams.get("code_challenge")!, email: "owner@cancel.test", timezone: "America/Los_Angeles" }).toString() });
    const cb = new URL(consent.headers.get("location")!);
    const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${owner}; ${pkce}` } });
    expect(done.headers.get("location")).toContain("/setup?calendar=connected");
  });
  afterAll(async () => {
    await container.close();
  });

  it("the confirmed page asks what they would like next, with a hint that is true for them, and an optional reason; the choice and the confirmation box are required", async () => {
    const booked = await book("Maria", "Reyes");
    const page = await app.request(`/c/schedule/${booked.token}/confirmed`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`action="/c/schedule/${booked.token}/cancel"`);
    expect(html).toContain('id="cancel"');
    expect(html).toContain('<legend class="question-legend">If you cancel, what would you like next?</legend>');
    expect(html).toMatch(/<input type="radio" id="next-new-times" name="next" value="new_times" required="" aria-describedby="next-new-times-hint"\/?> Send me new times later/);
    expect(html).toMatch(/<input type="radio" id="next-not-interested" name="next" value="not_interested" aria-describedby="next-not-interested-hint"\/?> I(&#39;|')m no longer interested/);
    // the automatic set is on, ITS confirmed the company, nothing stops it: the hint names the day
    expect(html).toMatch(DATE_HINT);
    expect(html).toContain("We will let the team know. Your application stays open unless you withdraw it.");
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="confirm"');
    expect(html).toMatch(/if you like \(optional\)/);
    // cancelling and asking for another time are outlined secondary buttons, styled on this page too (not only on the screening page)
    expect(html).toContain('<button class="btn secondary" type="submit">Cancel the interview</button>');
    expect(html).toContain('<button class="btn secondary" type="submit">Ask for a different time</button>');
    expect(html).toContain(".btn.secondary { background: var(--surface)");
    expect(html).toMatch(/<a class="btn" href="\/c\/schedule\/[^"]+\/ics"><svg class="icon"[^>]*>.*?<\/svg>Add to my calendar<\/a>/);
    expect(html).not.toContain('role="alert"');
    // without the box, or without a choice, the interview stands and the form says what is missing
    const incomplete: Array<Record<string, string>> = [{ reason: "changed my mind", next: "new_times" }, { confirm: "yes", reason: "changed my mind" }, { confirm: "yes", next: "maybe" }];
    for (const fields of incomplete) {
      const refused = await post(`/c/schedule/${booked.token}/cancel`, fields);
      expect(refused.status).toBe(302);
      expect(refused.headers.get("location")).toBe(`/c/schedule/${booked.token}/confirmed?error=cancel#cancel`);
    }
    const again = await (await app.request(`/c/schedule/${booked.token}/confirmed?error=cancel`)).text();
    expect(again).toContain('<div class="err" role="alert" id="cancel-error">Choose what you would like next, and tick the box to confirm.</div>');
    expect(again).toContain('<fieldset aria-describedby="cancel-error">');
    expect(again).toMatch(/name="confirm" value="yes" required="" aria-invalid="true" aria-describedby="cancel-error"/);
    expect((await interview(booked.id)).status).toBe("scheduled");
    expect(await followUps(booked.cand.id)).toHaveLength(0);
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)))).toHaveLength(0);
    // cleanup so the calendar and the role are quiet for the next case
    await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes", next: "not_interested" });
    await container.drain();
  });

  it("cancelling and asking for new times: the reason is recorded, they go under Cancelled with the one automatic set armed for its day, the team and the interviewers are told, the event goes, and every page says the same day", async () => {
    const booked = await book("Luis", "Ortega");
    const eventBefore = gcal().eventsFor("owner@cancel.test").filter((e) => e.status === "confirmed").find((e) => e.idempotencyKey.startsWith(`interview:${booked.id}:`))!;
    expect(eventBefore).toBeTruthy();
    const mailsBefore = outbox().length;
    const reason = "I accepted another offer this morning.";
    const interviewerNotes = async () => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.cancelled"), eq(notifications.userId, ownerId)))).filter((x) => x.title.startsWith("Interview cancelled: ") && x.body === "The candidate cancelled, so this interview is off. The calendar event is being removed.");
    const toldBefore = (await interviewerNotes()).length;

    await cancelAsking(booked.token, { reason });
    const row = await interview(booked.id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason).toBe(`cancelled by the candidate: ${reason}`);
    expect(row.attempt).toBe(booked.attempt + 1);
    const [a] = await container.db.select().from(applications).where(eq(applications.id, booked.cand.id));
    expect(a.stage).toBe("interview_recommended");
    // under Cancelled, as they chose, with the one automatic set waiting for its day and its timer armed
    const [f] = await followUps(booked.cand.id);
    expect(f).toMatchObject({ kind: "candidate_cancelled", choice: "new_times", interviewId: booked.id, interviewAttempt: booked.attempt + 1, autoState: "waiting", autoReason: null, autoWorkingDays: 3, resolvedAt: null });
    expect(f.createdBy).toMatchObject({ kind: "candidate" });
    expect(Date.parse(f.autoDueAt!)).toBeGreaterThan(Date.now());
    const runs = await newTimesRuns(booked.cand.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: f.autoRunId, status: "waiting", idempotencyKey: `new_times:${f.id}` });
    const day = newTimesDayWords(f.autoDueAt!, "America/Los_Angeles");
    const moved = await container.db.select().from(events).where(and(eq(events.type, "application.moved_to_cancelled"), eq(events.subjectId, booked.cand.id)));
    expect(moved).toHaveLength(1);
    expect(moved[0].payload).toMatchObject({ followUpId: f.id, interviewId: booked.id, reason: "asked_new_times", auto: { state: "waiting", workingDays: 3 } });

    // Post/Redirect/Get: the page says what was done and the day, never echoes what they typed
    const done = await app.request(`/c/schedule/${booked.token}/cancelled`);
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain("<h1>Your interview is cancelled</h1>");
    expect(html).toMatch(new RegExp(`We let Cancel Dental(&#39;|')s team know\\. We will email you new times on ${day}, unless the team gets in touch first\\.`));
    expect(html).toContain("If anything changes, reply to any of our emails.");
    expect(html).toContain('<p class="notice">Reply to any of our emails with HUMAN to reach a person.</p>');
    expect(html).not.toContain(reason);

    // the fact, with no words of the candidate in it
    const facts = await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)));
    expect(facts).toHaveLength(1);
    expect(facts[0].payload).toMatchObject({ byCandidate: true, cause: "candidate_page", next: "new_times", hadEvents: true, hasReason: true });
    expect(JSON.stringify(facts[0].payload)).not.toContain("another offer");
    expect(facts[0].actor).toMatchObject({ kind: "candidate" });
    // the team's notification carries the reason and what happens next, with the day
    const notes = await teamNote("Luis Ortega");
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(`They said: "${reason}". They asked for new times. New times go to them automatically on ${day}, once, as your settings say. To send them sooner, or to stop them, open them under Cancelled.`);
    expect((notes[0].action as { href: string }).href).toBe(`/roles/${roleId}/talent?open=${booked.cand.id}`); // opens the candidate, like every other notification about a person
    // the interviewers hear the interview is off, and that its calendar event is being removed
    const told = await interviewerNotes();
    expect(told).toHaveLength(toldBefore + 1);
    expect(told.some((x) => x.title === `Interview cancelled: ${row.title}`)).toBe(true);
    // the calendar event is removed by the worker, through a queued job
    const cancelJobs = (await container.db.select().from(jobs).where(eq(jobs.kind, "interview.cancel_events"))).filter((j) => (j.payload as { interviewId: string }).interviewId === booked.id);
    expect(cancelJobs).toHaveLength(1);
    expect(cancelJobs[0].status).toBe("done");
    expect(gcal().eventsFor("owner@cancel.test").find((e) => e.eventId === eventBefore.eventId)!.status).toBe("cancelled");
    // the candidate hears it was done as they asked, with the day, and a calendar cancellation attached
    const mail = outbox().slice(mailsBefore).find((m) => m.to === booked.cand.email && /^Cancelled:/.test(m.subject))!;
    expect(mail).toBeTruthy();
    expect(mail.text).toContain(`As requested, your interview (${row.title}) at Cancel Dental is cancelled. We will email you new times on ${day}, unless the team gets in touch first.`);
    expect(mail.attachments?.[0].filename).toBe("cancel.ics");
    // the owner's interview detail shows the reason
    const detail = await json(owner, "GET", `/api/v1/interviews/${booked.id}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { status: string; cancelReason: string }).cancelReason).toBe(`cancelled by the candidate: ${reason}`);
    expect(((await (await json(owner, "GET", "/api/v1/interviews")).json()) as Array<{ id: string; status: string }>).find((x) => x.id === booked.id)?.status).toBe("cancelled");

    // a second press is idempotent: nothing is recorded or sent twice
    const again = await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes", next: "not_interested", reason: "again" });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(`/c/schedule/${booked.token}/confirmed`);
    expect((await interview(booked.id)).cancelReason).toBe(`cancelled by the candidate: ${reason}`);
    expect(await followUps(booked.cand.id)).toHaveLength(1);
    expect(await newTimesRuns(booked.cand.id)).toHaveLength(1);
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)))).toHaveLength(1);
    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "interview.cancel_events"))).filter((j) => (j.payload as { interviewId: string }).interviewId === booked.id)).toHaveLength(1);
    expect(outbox().slice(mailsBefore).filter((m) => m.to === booked.cand.email && /^Cancelled:/.test(m.subject))).toHaveLength(1);
    // the old links say they cancelled it, with the same day; the status page too
    const confirmed = await app.request(`/c/schedule/${booked.token}/confirmed`);
    expect(confirmed.status).toBe(200);
    const confirmedHtml = await confirmed.text();
    expect(confirmedHtml).toContain("<h1>You cancelled this interview</h1>");
    expect(confirmedHtml).toContain(`We will email you new times on ${day}, unless the team gets in touch first.`);
    const pick = await app.request(`/c/schedule/${booked.token}`);
    expect(pick.status).toBe(410);
    expect(await pick.text()).toContain("<h1>You cancelled this interview</h1>");
    expect(await statusPage(booked.cand.id)).toContain(`You cancelled your interview and asked for new times. We will email them to you on ${day}, unless the team gets in touch first.`);
  });

  it("no longer interested, without a reason: the record says only that the candidate cancelled, nothing is armed, and the page offers withdrawing; a long reason is cut, never refused", async () => {
    const plain = await book("Ana", "Silva");
    const mailsBefore = outbox().length;
    const r = await post(`/c/schedule/${plain.token}/cancel`, { confirm: "yes", next: "not_interested", reason: "   " });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`/c/schedule/${plain.token}/cancelled`);
    await container.drain();
    expect((await interview(plain.id)).cancelReason).toBe("cancelled by the candidate");
    const [f] = await followUps(plain.cand.id);
    expect(f).toMatchObject({ kind: "candidate_cancelled", choice: "not_interested", autoState: "none", autoReason: "not_asked", autoDueAt: null, autoRunId: null });
    expect(await newTimesRuns(plain.cand.id)).toHaveLength(0);
    const [note] = await teamNote("Ana Silva");
    expect(note.body).toBe("They said they are no longer interested. Nothing goes to them automatically; decide when you are ready.");
    const facts = await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, plain.id)));
    expect(facts[0].payload).toMatchObject({ byCandidate: true, next: "not_interested", hasReason: false });
    const [a] = await container.db.select({ token: applications.statusToken }).from(applications).where(eq(applications.id, plain.cand.id));
    const html = await (await app.request(`/c/schedule/${plain.token}/cancelled`)).text();
    expect(html).toMatch(/We let Cancel Dental(&#39;|')s team know you are no longer interested in this interview\. Your application stays open\./);
    // never the private status link itself: someone holding an old schedule link must not be handed the current one
    expect(html).toContain(`To withdraw it, open your application page from our emails, or <a href="/c/link-request">get your link by email</a>.`);
    expect(html).not.toContain(`/c/status/${a.token}`);
    expect(html).not.toMatch(/new times/);
    const mail = outbox().slice(mailsBefore).find((m) => m.to === plain.cand.email && /^Cancelled:/.test(m.subject))!;
    expect(mail.text).toContain("We let the team know you are no longer interested. If you change your mind, reply to this email.");
    expect(await (await app.request(`/c/schedule/${plain.token}/confirmed`)).text()).toContain("You told the team you are no longer interested in this interview. If you change your mind, reply to any of our emails.");
    expect(await statusPage(plain.cand.id)).toContain("You cancelled your interview and told the team you are no longer interested. If you change your mind, reply to any of our emails. You can also withdraw your application below.");
    await container.drain();
    const wordy = await book("Ben", "Okafor");
    await cancelAsking(wordy.token, { reason: "x".repeat(900) });
    const row = await interview(wordy.id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason!.length).toBeLessThanOrEqual("cancelled by the candidate: ".length + 500);
  });

  it("with automatic new times switched off, nothing is armed and no day is promised: not on the page, in the email or on the status page", async () => {
    const booked = await book("Omar", "Haddad");
    await setCompanySettings((s) => ({ ...s, newTimesAfterCancel: { auto: false, workingDays: 3 } }));
    try {
      const html = await (await app.request(`/c/schedule/${booked.token}/confirmed`)).text();
      expect(html).toContain(TEAM_HINT);
      expect(html).not.toMatch(DATE_HINT);
      const mailsBefore = outbox().length;
      await cancelAsking(booked.token);
      expect((await followUps(booked.cand.id))[0]).toMatchObject({ choice: "new_times", autoState: "none", autoReason: "switched_off", autoDueAt: null });
      expect(await newTimesRuns(booked.cand.id)).toHaveLength(0);
      expect((await teamNote("Omar Haddad"))[0].body).toBe("They asked for new times. Automatic new times are off in Settings, so nothing goes to them until you send times or decide.");
      expect(await (await app.request(`/c/schedule/${booked.token}/cancelled`)).text()).toMatch(/We let Cancel Dental(&#39;|')s team know you would like new times\. Someone from the team will be in touch about them\./);
      const mail = outbox().slice(mailsBefore).find((m) => m.to === booked.cand.email && /^Cancelled:/.test(m.subject))!;
      expect(mail.text).toContain("You asked for new times, so someone from the team will be in touch about them.");
      expect(mail.text).not.toMatch(/We will email you new times on/);
      expect(await statusPage(booked.cand.id)).toContain("You cancelled your interview and asked for new times. The hiring team will be in touch about them.");
    } finally {
      await setCompanySettings((s) => ({ ...s, newTimesAfterCancel: { auto: true, workingDays: 3 } }));
    }
  });

  it("before ITS confirms the company, nothing is armed and no day is promised: not on the page, in the held cancel email or on the status page", async () => {
    const booked = await book("Rui", "Costa");
    await setCompanySettings(({ verifiedAt: _a, verifiedBy: _b, ...s }) => s);
    try {
      const html = await (await app.request(`/c/schedule/${booked.token}/confirmed`)).text();
      expect(html).toContain(TEAM_HINT);
      expect(html).not.toMatch(DATE_HINT);
      await cancelAsking(booked.token);
      expect((await followUps(booked.cand.id))[0]).toMatchObject({ choice: "new_times", autoState: "none", autoReason: "company_not_checked", autoDueAt: null });
      expect(await newTimesRuns(booked.cand.id)).toHaveLength(0);
      expect((await teamNote("Rui Costa"))[0].body).toBe("They asked for new times. ITS has not confirmed your company yet, so nothing can go to them automatically. Once ITS confirms it, send new times from their page.");
      // the confirmation waits for the check (founder decision B7), and names no day for when it is released
      const [held] = await container.db.select().from(communications).where(and(eq(communications.applicationId, booked.cand.id), eq(communications.templateKey, "interview_cancelled")));
      expect(held.status).toBe("held");
      expect(held.bodyText).toContain("You asked for new times, so someone from the team will be in touch about them.");
      expect(held.bodyText).not.toMatch(/We will email you new times on/);
      expect(await statusPage(booked.cand.id)).toContain("You cancelled your interview and asked for new times. The hiring team will be in touch about them.");
    } finally {
      await setCompanySettings((s) => ({ ...s, verifiedAt: new Date().toISOString(), verifiedBy: { kind: "system", id: "test" } }));
    }
  });

  it("after both reschedules, under an ITS recruiter's takeover, or on hold, they still go under Cancelled but nothing is armed, and each says why", async () => {
    // both "Ask for a different time" presses used: the page already promised a person
    const twice = await book("Elena", "Costa");
    await container.db.update(interviews).set({ rescheduleCountCandidate: 2 }).where(eq(interviews.id, twice.id));
    const twiceHtml = await (await app.request(`/c/schedule/${twice.token}/confirmed`)).text();
    expect(twiceHtml).toContain("You have moved this interview twice, so someone from the team will be in touch to arrange a time.");
    await cancelAsking(twice.token);
    expect((await followUps(twice.cand.id))[0]).toMatchObject({ autoState: "none", autoReason: "reschedules_used" });
    expect((await teamNote("Elena Costa"))[0].body).toBe("They asked for new times after moving this interview twice, so a person should arrange the time with them. Nothing goes to them automatically.");

    // an ITS recruiter runs the role (founder question 7)
    const taken = await book("Ivo", "Novak");
    const [takeover] = await container.db.insert(takeovers).values({ companyId, roleId, recruiterUserId: ownerId, status: "active" }).returning();
    try {
      expect(await (await app.request(`/c/schedule/${taken.token}/confirmed`)).text()).toContain(TEAM_HINT);
      await cancelAsking(taken.token);
      expect((await followUps(taken.cand.id))[0]).toMatchObject({ autoState: "none", autoReason: "takeover" });
      expect(await newTimesRuns(taken.cand.id)).toHaveLength(0);
      expect((await teamNote("Ivo Novak"))[0].body).toBe("They asked for new times. An ITS recruiter is running this role, so nothing goes automatically: you or the recruiter decide.");
    } finally {
      await container.db.update(takeovers).set({ status: "ended" }).where(eq(takeovers.id, takeover.id));
    }

    // a person had put them on hold (founder question 6): the hold ends, they go under Cancelled, nothing is armed
    const held = await book("Hana", "Kim");
    await withTenant(container.db, companyId, (tx) => setMark(tx, { companyId, app: { id: held.cand.id, stage: "interview_scheduled" }, mark: "on_hold", note: "Waiting on budget", actor: { kind: "user", id: ownerId } }));
    expect(await (await app.request(`/c/schedule/${held.token}/confirmed`)).text()).toContain(TEAM_HINT);
    await cancelAsking(held.token);
    expect((await followUps(held.cand.id))[0]).toMatchObject({ autoState: "none", autoReason: "was_on_hold", resolvedAt: null });
    expect(await newTimesRuns(held.cand.id)).toHaveLength(0);
    const [mark] = await container.db.select().from(applicationMarks).where(eq(applicationMarks.applicationId, held.cand.id));
    expect(mark).toMatchObject({ mark: "on_hold", clearReason: "moved to Cancelled" });
    expect(mark.clearedAt).not.toBeNull();
    expect((await teamNote("Hana Kim"))[0].body).toBe("They asked for new times. You had put them on hold; that hold has ended and nothing goes automatically: send new times or decide.");
  });

  it("only a booked interview still ahead, of someone still in the process, can be cancelled: anything else changes nothing and writes no row", async () => {
    const refusedFor = async (token: string, interviewId: string, applicationId: string, status: string) => {
      const r = await post(`/c/schedule/${token}/cancel`, { confirm: "yes", next: "new_times" });
      expect(r.status, status).toBe(302);
      expect(r.headers.get("location"), status).toBe(`/c/schedule/${token}/confirmed`);
      expect((await interview(interviewId)).status, status).toBe(status);
      expect(await followUps(applicationId), status).toHaveLength(0);
      expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, interviewId))), status).toHaveLength(0);
    };
    // the interview already started (a candidate who missed it cannot cancel afterwards to get times, founder decision 4A)
    const started = await book("Sofia", "Marin");
    await container.db.update(interviews).set({ startsAt: new Date(Date.now() - 3_600_000).toISOString(), endsAt: new Date(Date.now() - 1_800_000).toISOString() }).where(eq(interviews.id, started.id));
    expect(await (await app.request(`/c/schedule/${started.token}/confirmed`)).text()).not.toContain(`action="/c/schedule/${started.token}/cancel"`);
    await refusedFor(started.token, started.id, started.cand.id, "scheduled");
    // a stale tab on an interview that is no longer booked
    for (const status of ["no_show", "offer_expired", "scheduling"] as const) {
      const other = await book("Nadia", status);
      await container.db.update(interviews).set({ status }).where(eq(interviews.id, other.id));
      await refusedFor(other.token, other.id, other.cand.id, status);
    }
    // an interview of someone whose role closed
    const closed = await book("Pia", "Sato");
    await container.db.update(roles).set({ status: "closed" }).where(eq(roles.id, roleId));
    try {
      await refusedFor(closed.token, closed.id, closed.cand.id, "scheduled");
    } finally {
      await container.db.update(roles).set({ status: "open" }).where(eq(roles.id, roleId));
    }
  });

  it("a withdrawal calls off the booked interview without putting anyone under Cancelled", async () => {
    const booked = await book("Jon", "Park");
    const [a] = await container.db.select({ token: applications.statusToken }).from(applications).where(eq(applications.id, booked.cand.id));
    expect((await post(`/c/status/${a.token}/withdraw`, { confirm: "yes" })).status).toBe(302);
    await container.drain();
    expect((await interview(booked.id)).status).toBe("cancelled");
    expect(await followUps(booked.cand.id)).toHaveLength(0);
    const page = await (await app.request(`/c/schedule/${booked.token}/confirmed`)).text();
    expect(page).toContain("This interview was cancelled");
    expect(page).not.toContain("You cancelled this interview");
    // the page after a cancel is only for their own cancel
    const after = await app.request(`/c/schedule/${booked.token}/cancelled`);
    expect(after.status).toBe(302);
    expect(after.headers.get("location")).toBe(`/c/schedule/${booked.token}/confirmed`);
  });

  it("an unknown token is refused; the link of an interview the team cancelled says so kindly and changes nothing (plan A9)", async () => {
    expect((await post(`/c/schedule/${"x".repeat(32)}/cancel`, { confirm: "yes", next: "new_times" })).status).toBe(404);
    expect((await app.request(`/c/schedule/${"x".repeat(32)}/cancelled`)).status).toBe(404);
    const booked = await book("Chloe", "Nguyen");
    const r = await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "The interviewer is out this week." });
    expect(r.status).toBe(200);
    // the page's confirmation can say exactly who was told
    expect(await r.json()).toMatchObject({ status: "cancelled", candidateTold: true, interviewersTold: true });
    await container.drain();
    expect((await interview(booked.id)).scheduleToken).toBe(booked.token);
    const again = await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes", next: "new_times" });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(`/c/schedule/${booked.token}/confirmed`);
    const page = await app.request(`/c/schedule/${booked.token}/confirmed`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("This interview was cancelled");
    expect((await app.request(`/c/schedule/${booked.token}`)).status).toBe(410);
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)))).toHaveLength(1);
    // a team cancellation never puts anyone under Cancelled
    expect(await followUps(booked.cand.id)).toHaveLength(0);
  });
});

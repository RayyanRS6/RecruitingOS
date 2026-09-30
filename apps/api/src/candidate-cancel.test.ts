import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { applications, events, interviews, jobs, notifications, users } from "@ros/db";
import type { FakeEmailAdapter, FakeGoogleCalendarProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * The candidate's own cancellation (docs/spec/21 section 7, P0 row "candidate cancel test"; docs/spec/04 "Optional
 * reason; confirm"): from the confirmed page, with the confirmation ticked and a few words on why if they like. The
 * interview is cancelled with the reason on record, the team is told, the calendar events are removed by the worker,
 * the candidate gets a confirmation, a second press changes nothing, and a dead link is refused. Nothing is decided
 * by software: the application goes back to "recommended" for a person to look at.
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

  it("the confirmed page offers the cancellation with an optional reason; the confirmation box is required", async () => {
    const booked = await book("Maria", "Reyes");
    const page = await app.request(`/c/schedule/${booked.token}/confirmed`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`action="/c/schedule/${booked.token}/cancel"`);
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="confirm"');
    expect(html).toMatch(/if you like \(optional\)/);
    // without the box the interview stands
    const unconfirmed = await post(`/c/schedule/${booked.token}/cancel`, { reason: "changed my mind" });
    expect(unconfirmed.status).toBe(302);
    expect(unconfirmed.headers.get("location")).toBe(`/c/schedule/${booked.token}?confirm=cancel`);
    expect((await interview(booked.id)).status).toBe("scheduled");
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)))).toHaveLength(0);
    // cleanup so the calendar and the role are quiet for the next case
    await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes" });
    await container.drain();
  });

  it("cancelling with a reason: the interview and its reason are recorded, the team is told, the calendar event goes, the candidate is confirmed, and the detail shows why", async () => {
    const booked = await book("Luis", "Ortega");
    const eventBefore = gcal().eventsFor("owner@cancel.test").filter((e) => e.status === "confirmed").find((e) => e.idempotencyKey.startsWith(`interview:${booked.id}:`))!;
    expect(eventBefore).toBeTruthy();
    const mailsBefore = outbox().length;
    const reason = "I accepted another offer this morning.";

    const r = await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes", reason });
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("Your interview is cancelled");
    expect(html).toContain("We let Cancel Dental");
    expect(html).not.toContain(reason); // the page confirms, it does not echo what they typed

    const row = await interview(booked.id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason).toBe(`cancelled by the candidate: ${reason}`);
    expect(row.attempt).toBe(booked.attempt + 1);
    const [a] = await container.db.select().from(applications).where(eq(applications.id, booked.cand.id));
    expect(a.stage).toBe("interview_recommended"); // back to a person's decision; nothing automatic follows
    // the fact, with no words of the candidate in it
    const facts = await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)));
    expect(facts).toHaveLength(1);
    expect(facts[0].payload).toMatchObject({ byCandidate: true, hadEvents: true, hasReason: true });
    expect(JSON.stringify(facts[0].payload)).not.toContain("another offer");
    expect(facts[0].actor).toMatchObject({ kind: "candidate" });
    // the team's notification carries the reason so they can decide
    const notes = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.cancelled")))).filter((x) => /Luis Ortega/.test(x.title));
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe("Luis Ortega cancelled the interview");
    expect(notes[0].body).toContain(`They said: "${reason}".`);
    expect(notes[0].body).toContain("nothing happens automatically");
    expect((notes[0].action as { href: string }).href).toBe(`/roles/${roleId}/talent?open=${booked.cand.id}`); // opens the candidate, like every other notification about a person
    // the calendar event is removed by the worker, through a queued job
    const cancelJobs = (await container.db.select().from(jobs).where(eq(jobs.kind, "interview.cancel_events"))).filter((j) => (j.payload as { interviewId: string }).interviewId === booked.id);
    expect(cancelJobs).toHaveLength(1);
    expect(cancelJobs[0].status).toBe("done");
    expect(gcal().eventsFor("owner@cancel.test").find((e) => e.eventId === eventBefore.eventId)!.status).toBe("cancelled");
    // the candidate hears it was done as they asked, with a calendar cancellation attached
    const mail = outbox().slice(mailsBefore).find((m) => m.to === booked.cand.email && /^Cancelled:/.test(m.subject))!;
    expect(mail).toBeTruthy();
    expect(mail.text).toContain("As requested");
    expect(mail.attachments?.[0].filename).toBe("cancel.ics");
    // the owner's interview detail shows the reason
    const detail = await json(owner, "GET", `/api/v1/interviews/${booked.id}`);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { status: string; cancelReason: string }).cancelReason).toBe(`cancelled by the candidate: ${reason}`);
    expect(((await (await json(owner, "GET", "/api/v1/interviews")).json()) as Array<{ id: string; status: string }>).find((x) => x.id === booked.id)?.status).toBe("cancelled");

    // a second press is idempotent: the page says it is cancelled, nothing is recorded or sent twice
    const again = await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes", reason: "again" });
    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(`/c/schedule/${booked.token}/confirmed`);
    expect((await interview(booked.id)).cancelReason).toBe(`cancelled by the candidate: ${reason}`);
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)))).toHaveLength(1);
    expect((await container.db.select().from(jobs).where(eq(jobs.kind, "interview.cancel_events"))).filter((j) => (j.payload as { interviewId: string }).interviewId === booked.id)).toHaveLength(1);
    expect(outbox().slice(mailsBefore).filter((m) => m.to === booked.cand.email && /^Cancelled:/.test(m.subject))).toHaveLength(1);
    const confirmed = await app.request(`/c/schedule/${booked.token}/confirmed`);
    expect(await confirmed.text()).toContain("This interview was cancelled");
  });

  it("without a reason the record says only that the candidate cancelled; a long reason is cut, never refused", async () => {
    const plain = await book("Ana", "Silva");
    expect((await post(`/c/schedule/${plain.token}/cancel`, { confirm: "yes", reason: "   " })).status).toBe(200);
    expect((await interview(plain.id)).cancelReason).toBe("cancelled by the candidate");
    const note = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.cancelled")))).find((x) => /Ana Silva/.test(x.title))!;
    expect(note.body).not.toContain("They said");
    const facts = await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, plain.id)));
    expect(facts[0].payload).toMatchObject({ byCandidate: true, hasReason: false });
    await container.drain();
    const wordy = await book("Ben", "Okafor");
    expect((await post(`/c/schedule/${wordy.token}/cancel`, { confirm: "yes", reason: "x".repeat(900) })).status).toBe(200);
    const row = await interview(wordy.id);
    expect(row.status).toBe("cancelled");
    expect(row.cancelReason!.length).toBeLessThanOrEqual("cancelled by the candidate: ".length + 500);
    await container.drain();
  });

  it("a dead link is refused: an unknown token, and the token of an interview the team cancelled", async () => {
    expect((await post(`/c/schedule/${"x".repeat(32)}/cancel`, { confirm: "yes" })).status).toBe(404);
    const booked = await book("Chloe", "Nguyen");
    expect((await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "The interviewer is out this week." })).status).toBe(200);
    await container.drain();
    expect((await interview(booked.id)).scheduleToken).toBeNull();
    expect((await post(`/c/schedule/${booked.token}/cancel`, { confirm: "yes" })).status).toBe(404);
    expect((await app.request(`/c/schedule/${booked.token}/confirmed`)).status).toBe(404);
    expect(await container.db.select().from(events).where(and(eq(events.type, "interview.cancelled"), eq(events.subjectId, booked.id)))).toHaveLength(1);
  });
});

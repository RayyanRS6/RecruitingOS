import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { entitlements } from "@ros/core";
import { applications, auditRecords, integrations, interviews, notifications, users } from "@ros/db";
import type { FakeEmailAdapter, FakeGoogleCalendarProvider, MemorySecretStore } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";

/**
 * Slice 5 steps 7 to 9 end to end with synthetic data: a person approves an interview; times come from declared hours
 * or a (fake) Google calendar; the candidate picks in their own zone; events are booked once; confirmation carries an
 * invitation; reminders and closing run on timers; reschedule, cancel, expiry, conflicts and a revoked calendar all
 * recover; nothing is decided by software.
 */
describe("interview scheduling", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const BASE = (() => { const d = new Date(); d.setUTCHours(18, 0, 0, 0); return d.getTime(); })(); // 11:00 Pacific today
  const setClock = (offsetMs: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(BASE + offsetMs); };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(path, { method, headers: { "content-type": "application/json", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const gcal = () => container.integrations.calendars.google as FakeGoogleCalendarProvider;
  const store = () => container.integrations.secrets as MemorySecretStore;
  const H = 3600_000;

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let roleId = "";
  let roundKey = "";
  let n = 0;

  const apply = async (first: string, last: string) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@example.com`;
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
    return { id: a.id, email, stage: a.stage };
  };
  const requestInterview = async (applicationId: string, extra: Record<string, unknown> = {}) => {
    const r = await json(owner, "POST", `/api/v1/applications/${applicationId}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar", ...extra });
    expect(r.status, await r.clone().text()).toBe(201);
    return (await r.json()) as { id: string; status: string; offeredSlots: Array<{ id: string; startsAt: string; endsAt: string }>; startsAt: string | null };
  };
  const interview = async (id: string) => (await container.db.select().from(interviews).where(eq(interviews.id, id)))[0];
  const pick = async (token: string, slotId: string, tz = "America/New_York") => {
    const r = await app.request(`/c/schedule/${token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId, timezone: tz }).toString() });
    expect(r.status).toBe(302);
    await container.drain();
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" } });
    app = createApp(container);
    setClock(0);
    owner = await signIn("owner@smile.test");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@smile.test"));
    ownerId = u.id;
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Smile Bright Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string };
    companyId = co.id;
    companySlug = co.slug;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = (await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json() as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
    roundKey = role.currentPacket.packet.interviews.plan[0].key;
    await container.drain();
  });
  afterAll(async () => {
    await container.close();
  });

  it("the interview policy cannot be lowered below approval", async () => {
    const r = await json(owner, "PUT", "/api/v1/policies", { actionType: "interview.request", level: "auto", approverRoles: [] });
    expect([400, 404, 405]).toContain(r.status);
    if (r.status === 400) expect(((await r.json()) as { error: { code: string } }).error.code).toBe("minimum_level");
  });

  it("without any availability the team is asked; declared hours unblock it and times go out to the candidate", async () => {
    const cand = await apply("Maria", "Reyes");
    expect(["triaged", "eligible", "screen_complete", "interview_recommended", "screen_invited", "screening"]).toContain(cand.stage);
    const iv = await requestInterview(cand.id);
    expect(["proposed", "scheduling"]).toContain(iv.status);
    let row = await interview(iv.id);
    expect(row.status).toBe("proposed");
    expect(row.offeredSlots).toHaveLength(0);
    const asks = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.declare_availability")));
    expect(asks.length).toBeGreaterThanOrEqual(1);
    const [a] = await container.db.select().from(applications).where(eq(applications.id, cand.id));
    expect(a.stage).toBe("interview_recommended");
    // the owner (also the interviewer) declares hours; the waiting run resumes
    const put = await json(owner, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 3 });
    expect(put.status).toBe(200);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.offeredSlots.length).toBeGreaterThanOrEqual(6);
    expect(row.scheduleToken).toBeTruthy();
    const mail = outbox().find((m) => m.to === cand.email && /Pick a time/.test(m.subject))!;
    expect(mail).toBeTruthy();
    expect(mail.text).toContain(`/c/schedule/${row.scheduleToken}`);
    expect(mail.text).toMatch(/Dana/);
    const members = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ userId: string; schedulable: boolean; availability: { windows: number } | null }>;
    expect(members.find((m) => m.userId === ownerId)).toMatchObject({ schedulable: true, availability: { windows: 5 } });
  });

  it("the candidate picks a time in their own zone; it is booked once, confirmed with an invitation, reminded and closed on timers", async () => {
    const cand = await apply("Luis", "Ortega");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    const token = row.scheduleToken!;
    const page = await app.request(`/c/schedule/${token}?tz=America/New_York`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('name="slotId"');
    expect(html).toContain("America/New York");
    expect(html).toContain("EDT");
    const slot = row.offeredSlots[1];
    await pick(token, slot.id);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    expect(Date.parse(row.startsAt!)).toBe(Date.parse(slot.startsAt));
    expect(row.schedulingWindow.candidateTimezone).toBe("America/New_York");
    const [a] = await container.db.select().from(applications).where(eq(applications.id, cand.id));
    expect(a.stage).toBe("interview_scheduled");
    const confirm = outbox().find((m) => m.to === cand.email && /^Confirmed:/.test(m.subject))!;
    expect(confirm).toBeTruthy();
    expect(confirm.text).toContain("for the team"); // both zones
    expect(confirm.attachments?.[0].filename).toBe("interview.ics");
    const ics = Buffer.from(confirm.attachments![0].contentBase64, "base64").toString("utf8");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain(`DTSTART:${slot.startsAt.replace(/[-:]/g, "").replace(".000Z", "Z")}`);
    expect(outbox().some((m) => m.to === "owner@smile.test" && /Interview booked/.test(m.subject))).toBe(true);
    const confirmed = await app.request(`/c/schedule/${token}/confirmed`);
    expect(await confirmed.text()).toMatch(/You(&#39;|')re confirmed/);
    const file = await app.request(`/c/schedule/${token}/ics`);
    expect(file.headers.get("content-type")).toContain("text/calendar");
    // reminders and close, driven by the engine clock
    const start = Date.parse(slot.startsAt);
    setClock(start - 23 * H - BASE);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /^Tomorrow:/.test(m.subject))).toBe(true);
    setClock(start - 1.5 * H - BASE);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /^Soon:/.test(m.subject))).toBe(true);
    setClock(Date.parse(slot.endsAt) + 2 * H - BASE);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("completed");
    expect(row.reminders.before24h).toBeTruthy();
    expect(row.reminders.before2h).toBeTruthy();
    const [after] = await container.db.select().from(applications).where(eq(applications.id, cand.id));
    expect(after.stage).toBe("interview_complete");
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.decision")))).length).toBeGreaterThanOrEqual(1);
    // the human decision
    const dec = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist", note: "Strong." });
    expect(dec.status).toBe(200);
    expect(((await dec.json()) as { stage: string }).stage).toBe("finalist");
    setClock(0);
  });

  it("a connected calendar drives free/busy and gets the event exactly once, with a conference link", async () => {
    // connect through the browser flow with the fake consent page
    const start = await app.request("/api/v1/integrations/calendar/google/connect", { headers: { cookie: owner } });
    expect(start.status).toBe(302);
    const pkce = start.headers.get("set-cookie")!.split(";")[0];
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.pathname).toBe("/api/v1/integrations/calendar/fake/authorize");
    const consent = await app.request("/api/v1/integrations/calendar/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ redirect_to: `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/google/callback`, state: authorize.searchParams.get("state")!, code_challenge: authorize.searchParams.get("code_challenge")!, email: "owner@smile.test", timezone: "America/Los_Angeles" }).toString() });
    const cb = new URL(consent.headers.get("location")!);
    const done = await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${owner}; ${pkce}` } });
    expect(done.headers.get("location")).toContain("/setup?calendar=connected");
    const mine = (await (await json(owner, "GET", "/api/v1/me/calendar")).json()) as { connection: { status: string; externalAccountId: string; credentialsDeleted: boolean } | null };
    expect(mine.connection).toMatchObject({ status: "live", externalAccountId: "owner@smile.test", credentialsDeleted: false });
    expect(JSON.stringify(mine)).not.toContain("1//0fake");
    expect(store().size).toBe(1);
    // Monday 9-12 Pacific busy: no slot may touch it
    const monday = new Date(BASE + 3 * 86_400_000); // a few days out; find next Monday
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    const mondayKey = monday.toISOString().slice(0, 10);
    gcal().setBusy("owner@smile.test", [{ start: `${mondayKey}T16:00:00.000Z`, end: `${mondayKey}T19:00:00.000Z` }]);
    const cand = await apply("Ana", "Silva");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.offeredSlots[0].source).toBe("calendar");
    for (const s of row.offeredSlots) expect(s.endsAt <= `${mondayKey}T15:45:00.000Z` || s.startsAt >= `${mondayKey}T19:15:00.000Z` || !s.startsAt.startsWith(mondayKey)).toBe(true);
    const reads = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "secret.read")));
    expect(reads.some((r) => (r.details as { purpose: string }).purpose === "calendar_sync")).toBe(true);
    await pick(row.scheduleToken!, row.offeredSlots[0].id, "America/Los_Angeles");
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    expect(row.meetingUrl).toMatch(/meet\.google\.com/);
    const events = gcal().eventsFor("owner@smile.test").filter((e) => e.status === "confirmed");
    expect(events).toHaveLength(1);
    expect(events[0].attendees).toEqual(expect.arrayContaining(["owner@smile.test", cand.email]));
    expect(events[0].idempotencyKey).toBe(`interview:${iv.id}:1:${ownerId}`);
    // cancelling removes the event and tells the candidate; the stage returns to recommended
    const cancel = await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "The interviewer is out this week." });
    expect(cancel.status).toBe(200);
    await container.drain();
    expect(gcal().eventsFor("owner@smile.test").find((e) => e.eventId === events[0].eventId)!.status).toBe("cancelled");
    expect(outbox().some((m) => m.to === cand.email && /^Cancelled:/.test(m.subject) && /out this week/.test(m.text))).toBe(true);
    const [after] = await container.db.select().from(applications).where(eq(applications.id, cand.id));
    expect(after.stage).toBe("interview_recommended");
    gcal().setBusy("owner@smile.test", []);
  });

  it("a slot taken between offer and booking is detected and new times go out", async () => {
    const cand = await apply("Ben", "Okafor");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    const slot = row.offeredSlots[0];
    gcal().setBusy("owner@smile.test", [{ start: slot.startsAt, end: slot.endsAt }]);
    await pick(row.scheduleToken!, slot.id);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.attempt).toBe(2);
    expect(row.offeredSlots.some((s) => s.id === slot.id)).toBe(false);
    expect(outbox().filter((m) => m.to === cand.email && /Pick a time/.test(m.subject))).toHaveLength(2);
    gcal().setBusy("owner@smile.test", []);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("reschedule re-offers and cancels the old event; the candidate may reschedule twice, then a person takes over", async () => {
    const cand = await apply("Chloe", "Nguyen");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    await pick(row.scheduleToken!, row.offeredSlots[0].id);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    const firstEvent = gcal().eventsFor("owner@smile.test").filter((e) => e.status === "confirmed").find((e) => e.idempotencyKey.startsWith(`interview:${iv.id}:`))!;
    // owner reschedules
    const re = await json(owner, "POST", `/api/v1/interviews/${iv.id}/reschedule`, { reason: "conflict" });
    expect(re.status).toBe(200);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.attempt).toBe(2);
    expect(gcal().eventsFor("owner@smile.test").find((e) => e.eventId === firstEvent.eventId)!.status).toBe("cancelled");
    // candidate picks again, then reschedules twice through their page
    await pick(row.scheduleToken!, row.offeredSlots[0].id);
    for (let i = 1; i <= 2; i++) {
      row = await interview(iv.id);
      expect(row.status).toBe("scheduled");
      const r = await app.request(`/c/schedule/${row.scheduleToken}/reschedule`, { method: "POST" });
      expect(r.status).toBe(302);
      await container.drain();
      row = await interview(iv.id);
      expect(row.rescheduleCountCandidate).toBe(i);
      expect(row.status).toBe("scheduling");
      await pick(row.scheduleToken!, row.offeredSlots[0].id);
    }
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    const third = await app.request(`/c/schedule/${row.scheduleToken}/reschedule`, { method: "POST" });
    expect(third.headers.get("location")).toContain("/confirmed");
    expect((await interview(iv.id)).status).toBe("scheduled");
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.reschedule_limit")))).length).toBe(1);
    const events = gcal().eventsFor("owner@smile.test").filter((e) => e.status === "confirmed" && e.idempotencyKey.startsWith(`interview:${iv.id}:`));
    expect(events).toHaveLength(1); // never two live events for one interview
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("'none of these work' reaches the owner; an unanswered offer is reminded and then expires; the link dies with it", async () => {
    const cand = await apply("Omar", "Haddad");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    const token = row.scheduleToken!;
    const none = await app.request(`/c/schedule/${token}/none-work`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ note: "Mornings before 10, any day but Wednesday", timezone: "America/Chicago" }).toString() });
    expect(none.status).toBe(200);
    await container.drain();
    const ask = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.none_work")));
    expect(ask.length).toBeGreaterThanOrEqual(1);
    expect(ask[0].body).toContain("Mornings before 10");
    // the owner widens the window; new times go out
    const re = await json(owner, "POST", `/api/v1/interviews/${iv.id}/reschedule`, { window: { toDate: new Date(BASE + 25 * 86_400_000).toISOString().slice(0, 10) } });
    expect(re.status).toBe(200);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.attempt).toBe(2);
    const token2 = row.scheduleToken!;
    // nobody answers: reminder after two days, expiry after two more
    setClock(49 * H);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /^Reminder: pick a time/.test(m.subject))).toBe(true);
    setClock(98 * H);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("offer_expired");
    expect(row.scheduleToken).toBeNull();
    expect((await app.request(`/c/schedule/${token2}`)).status).toBe(404);
    const expired = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.offer_expired")));
    expect(expired.filter((x) => x.action?.href === `/interviews/${iv.id}`).length).toBeGreaterThanOrEqual(1);
    setClock(0);
  });

  it("a revoked calendar credential falls back to declared hours, tells the person, and disconnecting deletes the credential", async () => {
    gcal().revokeAccount("owner@smile.test");
    const cand = await apply("Priya", "Raman");
    const iv = await requestInterview(cand.id);
    const row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.offeredSlots[0].source).toBe("declared");
    const [conn] = await container.db.select().from(integrations).where(and(eq(integrations.companyId, companyId), eq(integrations.userId, ownerId), eq(integrations.kind, "calendar")));
    expect(conn.status).toBe("manual_action_required");
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "calendar.needs_attention")))).length).toBeGreaterThanOrEqual(1);
    const members = (await (await json(owner, "GET", "/api/v1/companies/current/members")).json()) as Array<{ userId: string; calendar: { status: string } | null; schedulable: boolean }>;
    expect(members.find((m) => m.userId === ownerId)).toMatchObject({ calendar: { status: "manual_action_required" }, schedulable: true });
    const dis = await json(owner, "POST", "/api/v1/integrations/calendar/google/disconnect", { reason: "switching" });
    expect(dis.status).toBe(200);
    await container.drain();
    expect(store().size).toBe(0);
    const mine = (await (await json(owner, "GET", "/api/v1/me/calendar")).json()) as { connection: { status: string; credentialsDeleted: boolean } | null };
    expect(mine.connection).toMatchObject({ status: "not_connected", credentialsDeleted: true });
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("the owner can book on the candidate's behalf and the interviews list shows the load", async () => {
    const cand = await apply("Sofia", "Marin");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    const r = await json(owner, "POST", `/api/v1/interviews/${iv.id}/book-on-behalf`, { slotId: row.offeredSlots[0].id, note: "agreed by phone" });
    expect(r.status).toBe(200);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    const list = (await (await json(owner, "GET", "/api/v1/interviews?status=scheduled")).json()) as Array<{ id: string; participants: Array<{ userId: string }> }>;
    expect(list.some((i) => i.id === iv.id)).toBe(true);
    const detail = (await (await json(owner, "GET", `/api/v1/interviews/${iv.id}`)).json()) as { timeline: Array<{ type: string; payload: { onBehalf?: boolean } }>; availabilitySources: Array<{ source: string }> };
    expect(detail.timeline.some((e) => e.type === "interview.slot_selected" && e.payload.onBehalf)).toBe(true);
    expect(detail.availabilitySources[0].source).toBe("declared");
    const outcome = await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "no_show_candidate" });
    expect(outcome.status).toBe(200);
    expect((await interview(iv.id)).status).toBe("no_show");
  });
});

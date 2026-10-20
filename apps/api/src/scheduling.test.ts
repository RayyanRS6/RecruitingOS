import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { bookedFor, cancelInterviewEvents } from "@ros/agents";
import { defaultSchedulingWindow, entitlements, zonedParts } from "@ros/core";
import { applications, auditRecords, communications, companies, integrations, interviewFollowups, interviews, notifications, recruiterEscalations, users, withPlatform, withTenant, workflowRuns } from "@ros/db";
import type { FakeEmailAdapter, FakeGoogleCalendarProvider, MemorySecretStore } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { unverifyCompany, verifyCompany } from "./services/company-trust";
import { signInAs } from "./test-helpers";

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
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
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
    // the candidate is not on the interviewer's event: their one invitation is our calendar file (audit 06, bug 92)
    expect(events[0].attendees).toEqual(["owner@smile.test"]);
    expect(events[0].idempotencyKey).toBe(`interview:${iv.id}:1:${ownerId}`);
    const confirmation = outbox().filter((m) => m.to === cand.email && /^Confirmed:/.test(m.subject));
    expect(confirmation).toHaveLength(1);
    const invite = Buffer.from(confirmation[0].attachments![0].contentBase64, "base64").toString("utf8").replace(/\r\n /g, "");
    expect(invite).toContain(row.meetingUrl!);
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
    // a removal queued for an earlier time that runs late (a backed-up worker) never removes the new booking's event (audit 06, bug 101)
    const live = await interview(iv.id);
    await withTenant(container.db, companyId, (tx) => cancelInterviewEvents(tx, container.integrations, { interviewId: iv.id, actor: { kind: "system", id: "test" } }));
    expect(gcal().eventsFor("owner@smile.test").find((e) => e.eventId === events[0].eventId)!.status).toBe("confirmed");
    expect(Object.keys((await interview(iv.id)).calendarRefs ?? {})).toEqual([ownerId]);
    // the daily maximum counts an interview on the interviewer's own day, not the UTC date (audit 06, bug 91)
    const far = "Pacific/Kiritimati"; // UTC+14: a 9 am Pacific start is the next day there
    const counted = await withTenant(container.db, companyId, (tx) => bookedFor(tx, companyId, ownerId, { start: new Date(live.startsAt!).toISOString(), end: new Date(live.endsAt!).toISOString() }, "00000000-0000-0000-0000-000000000000", far));
    expect(counted.perDay).toEqual({ [zonedParts(new Date(live.startsAt!), far).dayKey]: 1 });
    expect(zonedParts(new Date(live.startsAt!), far).dayKey).not.toBe(new Date(live.startsAt!).toISOString().slice(0, 10));
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
    // the candidate is told once that the times passed: the dead link is not repeated, their status page is, nothing is promised
    const lapsed = outbox().filter((m) => m.to === cand.email && /^Your interview times have passed/.test(m.subject));
    expect(lapsed).toHaveLength(1);
    expect(lapsed[0].text).toContain("reply to this email and the hiring team will be in touch");
    expect(lapsed[0].text).toContain("/c/status/");
    expect(lapsed[0].text).not.toContain(token2);
    expect(lapsed[0].text).not.toContain("new times");
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

  it("a candidate who did not come goes under Cancelled as a no-show, with nothing automatic, and the team is told that instead of 'How did it go?'; an interviewer's no-show writes nothing", async () => {
    const decide = (name: string) => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.decision"))).then((rows) => rows.filter((x) => x.title === `How did it go with ${name}?`));
    const cand = await apply("Tom", "Berg");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/book-on-behalf`, { slotId: row.offeredSlots[0].id, note: "agreed by phone" })).status).toBe(200);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    const outcome = await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "no_show_candidate" });
    expect(outcome.status).toBe(200);
    // the interview sheet says they are under Cancelled, as a no-show, with nothing in motion
    expect(((await outcome.json()) as { followUp: unknown }).followUp).toMatchObject({ reason: "no_show", times: "none" });
    const [a] = await container.db.select().from(applications).where(eq(applications.id, cand.id));
    expect(a.stage).toBe("interview_complete");
    const followUps = await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, cand.id));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]).toMatchObject({ kind: "candidate_no_show", choice: null, interviewId: iv.id, interviewAttempt: row.attempt, autoState: "none", autoReason: "no_show", autoDueAt: null, autoRunId: null, resolvedAt: null });
    expect(await container.db.select().from(workflowRuns).where(eq(workflowRuns.workflowKey, "interview_new_times"))).toHaveLength(0);
    const notes = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.no_show")))).filter((x) => x.title === "Tom Berg did not come to the interview");
    expect(notes).toHaveLength(1);
    expect(notes[0].body).toBe(`${row.title}. They are under Cancelled as a no-show. Nothing goes to them automatically: send new times for the same round, or decide.`);
    expect(notes[0].action).toEqual({ label: "Open the candidate", href: `/roles/${roleId}/talent?open=${cand.id}` });
    expect(await decide("Tom Berg")).toHaveLength(0);
    // a second outcome on the same interview is refused, as today, and writes nothing more
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "no_show_candidate" })).status).toBe(409);
    expect(await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, cand.id))).toHaveLength(1);

    // the interviewer did not come: no row; the team is asked to approve the same round again (founder decision L-12)
    const other = await apply("Lena", "Vogel");
    const iv2 = await requestInterview(other.id);
    const row2 = await interview(iv2.id);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv2.id}/book-on-behalf`, { slotId: row2.offeredSlots[0].id })).status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv2.id}/outcome`, { outcome: "no_show_interviewer" })).status).toBe(200);
    expect(await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, other.id))).toHaveLength(0);
    expect(await decide("Lena Vogel")).toHaveLength(0);
    const missed = (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.decision")))).filter((x) => x.title === "Lena Vogel's interview did not happen");
    expect(missed).toHaveLength(1);
    expect(missed[0].body).toContain("Approve the same round again");
    expect(missed[0].action).toEqual({ label: "Open the candidate", href: `/roles/${roleId}/talent?open=${other.id}&step=interview` });
    // the approval card proposes the same round; the new invitation says sorry, and the missed interview stops asking for a decision
    const draft = (await (await json(owner, "GET", `/api/v1/applications/${other.id}/interview-draft`)).json()) as { roundKey: string; nextRound: boolean; sameRoundAgain?: string };
    expect(draft).toMatchObject({ roundKey: row2.roundKey, nextRound: false, sameRoundAgain: "missed_by_us" });
    // the candidate panel's decision card offers the same round first: both actions are open to the owner
    const detail = (await (await json(owner, "GET", `/api/v1/applications/${other.id}`)).json()) as { allowedActions: string[] };
    expect(detail.allowedActions).toEqual(expect.arrayContaining(["interview", "record_decision"]));
    const before = outbox().length;
    const again = await requestInterview(other.id);
    await container.drain();
    const apology = outbox().slice(before).filter((m) => m.to === other.email);
    expect(apology).toHaveLength(1);
    expect(apology[0].subject).toMatch(/^New times for your interview:/);
    expect(apology[0].text).toContain("We are sorry: the interviewer from Smile Bright Dental could not join your last interview");
    expect((await interview(iv2.id)).decision).toBe("new_times");
    await json(owner, "POST", `/api/v1/interviews/${again.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("what happened is recorded once: a later 'took place' or no-show is refused, as the screen asks it once (audit 06, bug 98)", async () => {
    const cand = await apply("Ada", "Moss");
    const iv = await requestInterview(cand.id);
    const row = await interview(iv.id);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/book-on-behalf`, { slotId: row.offeredSlots[0].id })).status).toBe(200);
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "happened" })).status).toBe(200);
    const again = await json(owner, "POST", `/api/v1/interviews/${iv.id}/outcome`, { outcome: "no_show_candidate" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("already_recorded");
    expect(await interview(iv.id)).toMatchObject({ status: "completed", outcome: "happened" });
    // a decision needs a finished, undecided interview, as on the screen (audit 06, bug 99)
    expect((await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist" })).status).toBe(200);
    const none = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "next_round" });
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("no_interview_to_decide");
    const fresh = await apply("Ben", "Cole");
    const never = await json(owner, "POST", `/api/v1/applications/${fresh.id}/decision`, { decision: "finalist" });
    expect(never.status).toBe(409);
  });

  it("once the interview has started the candidate can no longer ask for a different time (audit 06, bug 96)", async () => {
    const cand = await apply("Eli", "Park");
    const iv = await requestInterview(cand.id);
    let row = await interview(iv.id);
    await pick(row.scheduleToken!, row.offeredSlots[0].id);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    setClock(Date.parse(row.startsAt!) + 10 * 60_000 - BASE);
    const page = await (await app.request(`/c/schedule/${row.scheduleToken}/confirmed`)).text();
    expect(page).not.toContain("Ask for a different time");
    expect(page).toContain("This interview has started, so it can no longer be moved here.");
    const r = await app.request(`/c/schedule/${row.scheduleToken}/reschedule`, { method: "POST" });
    expect(r.headers.get("location")).toBe(`/c/schedule/${row.scheduleToken}/confirmed`);
    expect(await interview(iv.id)).toMatchObject({ status: "scheduled", attempt: row.attempt, rescheduleCountCandidate: 0 });
    setClock(0);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  // ---- Interview scheduling that recovers (F2, 15 Oct 2026: docs/audit/06-interviews.md bugs 1 to 5, 7 and 23) ----
  const DAY = 24 * H;
  const businessDays = (w: { fromDate?: string; toDate?: string }) => {
    let count = 0;
    for (let t = Date.parse(`${w.fromDate}T12:00:00Z`); t <= Date.parse(`${w.toDate}T12:00:00Z`); t += DAY) if (![0, 6].includes(new Date(t).getUTCDay())) count++;
    return count;
  };
  const hoursFor = (cookie: string, windows: Array<{ day: number; start: string; end: string }>) => json(cookie, "PUT", "/api/v1/me/availability", { timezone: "America/Los_Angeles", windows, bufferMinutes: 15, maxPerDay: 6 });
  const weekdays = (start: string, end: string) => [1, 2, 3, 4, 5].map((day) => ({ day, start, end }));
  const noneWork = async (token: string, note: string) => {
    const r = await app.request(`/c/schedule/${token}/none-work`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ note, timezone: "America/Los_Angeles" }).toString() });
    expect(r.status).toBe(200);
    await container.drain();
  };
  let wes = "";
  let wesId = "";
  const wesIn = async () => {
    if (wes) return;
    wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@smile.test", name: "Wes Park" });
    wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@smile.test")))[0].id;
  };

  it("times worked out again never use dates that have passed: 'Offer times again' and the candidate's own reschedule get a fresh window as long as the first", async () => {
    const [co] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    const cand = await apply("Ivy", "Lam");
    const iv = await requestInterview(cand.id);
    const first = (await interview(iv.id)).schedulingWindow;
    // nobody picks; the offer is reminded and lapses three weeks on, long after the first window ended
    const later = 20 * DAY;
    setClock(later);
    await container.drain();
    setClock(later + 49 * H);
    await container.drain();
    let row = await interview(iv.id);
    expect(row.status).toBe("offer_expired");
    const now = new Date(BASE + later + 49 * H);
    expect(first.toDate! < now.toISOString().slice(0, 10)).toBe(true);
    // "Offer times again": a fresh window from tomorrow, as many business days as the first, and real times in it
    const before = outbox().length;
    expect((await json(owner, "POST", `/api/v1/interviews/${iv.id}/reschedule`, {})).status).toBe(200);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.schedulingWindow.fromDate).toBe(defaultSchedulingWindow(now, co.timezone).fromDate);
    expect(businessDays(row.schedulingWindow)).toBe(businessDays(first));
    expect(row.offeredSlots.length).toBeGreaterThan(0);
    for (const s of row.offeredSlots) expect(Date.parse(s.startsAt)).toBeGreaterThan(now.getTime());
    expect(outbox().slice(before).filter((m) => m.to === cand.email && /^New times for your interview:/.test(m.subject))).toHaveLength(1);
    // they book the latest time; two days on they ask for a different one: again a fresh window from that day
    await pick(row.scheduleToken!, row.offeredSlots.at(-1)!.id);
    expect((await interview(iv.id)).status).toBe("scheduled");
    const moved = later + 49 * H + 2 * DAY;
    setClock(moved);
    const r = await app.request(`/c/schedule/${row.scheduleToken}/reschedule`, { method: "POST" });
    expect(r.status).toBe(302);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.schedulingWindow.fromDate).toBe(defaultSchedulingWindow(new Date(BASE + moved), co.timezone).fromDate);
    expect(businessDays(row.schedulingWindow)).toBe(businessDays(first));
    expect(row.offeredSlots.length).toBeGreaterThan(0);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
    setClock(0);
  });

  it("saving availability wakes an interview stuck on 'no common times' at once; after 'none of these work' other times are emailed to the candidate", async () => {
    await wesIn();
    // Wes only interviews on Saturdays: no weekday time in common with Dana
    expect((await hoursFor(wes, [{ day: 6, start: "09:00", end: "17:00" }])).status).toBe(200);
    const cand = await apply("Kai", "Moreno");
    const iv = await requestInterview(cand.id, { interviewerUserIds: [ownerId, wesId] });
    let row = await interview(iv.id);
    expect(row.status).toBe("proposed");
    expect(row.offeredSlots).toHaveLength(0);
    expect((await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.no_slots")))).some((x) => x.action?.href === `/interviews/${iv.id}`)).toBe(true);
    // Wes adds weekday hours: the waiting interview wakes now, not two days later, and the times go out
    expect((await hoursFor(wes, weekdays("09:00", "17:00"))).status).toBe(200);
    await container.drain();
    row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    expect(row.offeredSlots.length).toBeGreaterThan(0);
    expect(outbox().filter((m) => m.to === cand.email && /^Pick a time/.test(m.subject))).toHaveLength(1);
    const offered = row.offeredSlots.map((s) => s.id);
    // none of these work; Wes then keeps only afternoons: other times are worked out and emailed, as a new attempt
    await noneWork(row.scheduleToken!, "Afternoons are better for me");
    const before = outbox().length;
    expect((await hoursFor(wes, weekdays("13:00", "17:00"))).status).toBe(200);
    await container.drain();
    const again = await interview(iv.id);
    expect(again.status).toBe("scheduling");
    expect(again.attempt).toBe(row.attempt + 1);
    expect(again.offeredSlots.some((s) => !offered.includes(s.id))).toBe(true);
    const mail = outbox().slice(before).filter((m) => m.to === cand.email);
    expect(mail).toHaveLength(1);
    expect(mail[0].subject).toMatch(/^Other times for your interview:/);
    expect(mail[0].text).toContain("As you asked, here are other times");
    expect(mail[0].text).toContain(`/c/schedule/${again.scheduleToken}`);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("'No common times' is told once per interview, not at every 48-hour re-check; again only when an interviewer's hours change (audit 06-interviews, bug 105)", async () => {
    await wesIn();
    expect((await hoursFor(wes, [{ day: 6, start: "09:00", end: "17:00" }])).status).toBe(200);
    await container.drain();
    const cand = await apply("Noor", "Haddad");
    const iv = await requestInterview(cand.id, { interviewerUserIds: [ownerId, wesId] });
    const told = async () => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.no_slots"), eq(notifications.userId, ownerId)))).filter((x) => x.action?.href === `/interviews/${iv.id}`).length;
    expect((await interview(iv.id)).offeredSlots).toHaveLength(0);
    expect(await told()).toBe(1);
    // two re-checks two days apart find the same answer: nothing new is said
    setClock(49 * H);
    await container.drain();
    setClock(98 * H);
    await container.drain();
    expect((await interview(iv.id)).offeredSlots).toHaveLength(0);
    expect(await told()).toBe(1);
    // Wes saves the same hours again: nothing changed, nothing said
    expect((await hoursFor(wes, [{ day: 6, start: "09:00", end: "17:00" }])).status).toBe(200);
    await container.drain();
    expect(await told()).toBe(1);
    // Wes changes his hours, still with no weekday in common: the team hears once more
    expect((await hoursFor(wes, [{ day: 6, start: "10:00", end: "16:00" }])).status).toBe(200);
    await container.drain();
    expect(await told()).toBe(2);
    setClock(147 * H);
    await container.drain();
    expect(await told()).toBe(2);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
    setClock(0);
  });

  it("a pick while no run waits for one is booked straight away; a time booked for another interview since is refused plainly; booking for them is audited as a booking", async () => {
    // Wes is back to full weekdays; these interviews are Dana's alone
    await wesIn();
    expect((await hoursFor(wes, weekdays("09:00", "17:00"))).status).toBe(200);
    const rui = await apply("Rui", "Costa");
    const uma = await apply("Uma", "Shah");
    const ivR = await requestInterview(rui.id);
    const ivU = await requestInterview(uma.id);
    const rowR = await interview(ivR.id);
    const rowU = await interview(ivU.id);
    // both said none of these work, so no run waits for a pick on either
    await noneWork(rowR.scheduleToken!, "Not sure yet");
    await noneWork(rowU.scheduleToken!, "Not sure yet");
    // Rui changes their mind and picks one of the times on the page: booked, never lost
    const slot = rowR.offeredSlots[1];
    await pick(rowR.scheduleToken!, slot.id);
    const bookedR = await interview(ivR.id);
    expect(bookedR).toMatchObject({ status: "scheduled", attempt: rowR.attempt + 1 });
    expect(Date.parse(bookedR.startsAt!)).toBe(Date.parse(slot.startsAt));
    expect(outbox().some((m) => m.to === rui.email && /^Confirmed:/.test(m.subject))).toBe(true);
    // Uma was offered the same time; it is Rui's now. Her pick and a booking for her are both refused, with a plain line
    const same = rowU.offeredSlots.find((s) => s.startsAt === slot.startsAt)!;
    expect(same).toBeTruthy();
    const page = await app.request(`/c/schedule/${rowU.scheduleToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId: same.id, timezone: "America/Los_Angeles" }).toString() });
    expect(page.headers.get("location")).toBe(`/c/schedule/${rowU.scheduleToken}?error=slot_taken`);
    expect(await (await app.request(page.headers.get("location")!)).text()).toContain("That time was just booked for another interview. Choose another.");
    const refused = await json(owner, "POST", `/api/v1/interviews/${ivU.id}/book-on-behalf`, { slotId: same.id, note: "agreed by phone" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("slot_taken");
    expect(await interview(ivU.id)).toMatchObject({ status: "scheduling", selectedSlot: null, attempt: rowU.attempt });
    // another time, agreed by phone: booked straight away and audited as a booking
    const other = rowU.offeredSlots.find((s) => s.startsAt !== slot.startsAt && Math.abs(Date.parse(s.startsAt) - Date.parse(slot.startsAt)) > 3 * H)!;
    const ok = await json(owner, "POST", `/api/v1/interviews/${ivU.id}/book-on-behalf`, { slotId: other.id, note: "agreed by phone" });
    expect(ok.status, await ok.clone().text()).toBe(200);
    await container.drain();
    expect(await interview(ivU.id)).toMatchObject({ status: "scheduled", attempt: rowU.attempt + 1 });
    const audits = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "interview.booked_on_behalf")));
    expect(audits.some((a) => a.target?.id === ivU.id)).toBe(true);
    expect((await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "candidate.viewed")))).some((a) => a.target?.id === ivU.id)).toBe(false);
    for (const id of [ivR.id, ivU.id]) await json(owner, "POST", `/api/v1/interviews/${id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("the team moving a booked interview tells the candidate the time is off, with a calendar file that removes it, and tells the other interviewers", async () => {
    await wesIn();
    expect((await hoursFor(wes, weekdays("09:00", "17:00"))).status).toBe(200);
    const cand = await apply("Zoe", "Hart");
    const iv = await requestInterview(cand.id, { interviewerUserIds: [ownerId, wesId] });
    let row = await interview(iv.id);
    await pick(row.scheduleToken!, row.offeredSlots[0].id);
    row = await interview(iv.id);
    expect(row.status).toBe("scheduled");
    const before = outbox().length;
    const re = await json(owner, "POST", `/api/v1/interviews/${iv.id}/reschedule`, { reason: "Wes is travelling that day." });
    expect(re.status).toBe(200);
    expect(await re.json()).toMatchObject({ candidateTold: true, status: "scheduling" });
    await container.drain();
    const sent = outbox().slice(before).filter((m) => m.to === cand.email);
    const moved = sent.find((m) => /^Your interview time has changed:/.test(m.subject))!;
    expect(moved).toBeTruthy();
    expect(moved.text).toContain("is off, so there is no need to attend then");
    expect(moved.text).toContain('"Wes is travelling that day."');
    expect(moved.text).toContain("We will email you new times");
    const ics = Buffer.from(moved.attachments![0].contentBase64, "base64").toString("utf8");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain(`DTSTART:${new Date(row.startsAt!).toISOString().replace(/[-:]/g, "").replace(".000Z", "Z")}`);
    expect(sent.some((m) => /^New times for your interview:/.test(m.subject))).toBe(true);
    expect(sent.some((m) => /^Pick a time/.test(m.subject))).toBe(false);
    // Wes hears it moved; Dana, who moved it, is not told her own news
    const heard = (userId: string) => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.rescheduled"), eq(notifications.userId, userId))).then((rows) => rows.filter((x) => x.title.startsWith("Interview moved: Zoe Hart")));
    const wesNote = await heard(wesId);
    expect(wesNote).toHaveLength(1);
    expect(wesNote[0].body).toMatch(/^The time on .+ is off\. New times are being offered; you will be told when one is booked\.$/);
    expect(await heard(ownerId)).toHaveLength(0);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("only real collisions count toward bringing in a recruiter: after two moves, a taken time is simply offered again", async () => {
    const lia = await apply("Lia", "Fox");
    const ivA = await requestInterview(lia.id);
    // the team moves it twice: attempt 3, and nothing has collided yet
    for (let i = 0; i < 2; i++) {
      expect((await json(owner, "POST", `/api/v1/interviews/${ivA.id}/reschedule`, {})).status).toBe(200);
      await container.drain();
    }
    let rowA = await interview(ivA.id);
    expect(rowA).toMatchObject({ status: "scheduling", attempt: 3 });
    // Max is offered the same times and books one first; Lia then picks that very time
    const max = await apply("Max", "Gray");
    const ivB = await requestInterview(max.id);
    const rowB = await interview(ivB.id);
    const shared = rowA.offeredSlots.find((s) => rowB.offeredSlots.some((x) => x.startsAt === s.startsAt))!;
    await pick(rowB.scheduleToken!, rowB.offeredSlots.find((x) => x.startsAt === shared.startsAt)!.id);
    expect((await interview(ivB.id)).status).toBe("scheduled");
    await pick(rowA.scheduleToken!, shared.id);
    rowA = await interview(ivA.id);
    expect(rowA).toMatchObject({ status: "scheduling", attempt: 4, selectedSlot: null });
    expect(rowA.offeredSlots.some((s) => s.startsAt === shared.startsAt)).toBe(false);
    const stuck = await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.stuck")));
    expect(stuck.filter((x) => x.title.includes("Lia"))).toHaveLength(0);
    for (const id of [ivA.id, ivB.id]) await json(owner, "POST", `/api/v1/interviews/${id}/cancel`, { reason: "test cleanup" });
    await container.drain();
  });

  it("a time that has passed is never booked: the page leaves it out, and a pick or a booking for them is refused plainly", async () => {
    await wesIn();
    expect((await hoursFor(wes, weekdays("09:00", "17:00"))).status).toBe(200);
    const cand = await apply("Ora", "Diaz");
    const iv = await requestInterview(cand.id);
    const row = await interview(iv.id);
    // they say none of these work, so no run waits for a pick; the first offered time then passes
    await noneWork(row.scheduleToken!, "Not sure yet");
    const first = row.offeredSlots[0];
    setClock(Date.parse(first.startsAt) + 30 * 60_000 - BASE);
    const page = await (await app.request(`/c/schedule/${row.scheduleToken}`)).text();
    expect(page).not.toContain(`value="${first.id}"`);
    const r = await app.request(`/c/schedule/${row.scheduleToken}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ slotId: first.id, timezone: "America/Los_Angeles" }).toString() });
    expect(r.headers.get("location")).toBe(`/c/schedule/${row.scheduleToken}?error=slot_unknown`);
    const refused = await json(owner, "POST", `/api/v1/interviews/${iv.id}/book-on-behalf`, { slotId: first.id, note: "agreed by phone" });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("slot_unknown");
    expect(await interview(iv.id)).toMatchObject({ status: "scheduling", selectedSlot: null, startsAt: null });
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
    setClock(0);
  });

  it("a required interviewer who never adds hours: the owner is reminded at each two-day wait, and after the second a recruiter is brought in", async () => {
    const pat = await signInAs(container, app, { companyId, role: "hiring_manager", email: "pat@smile.test", name: "Pat Lee" });
    expect(pat).toBeTruthy();
    const patId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "pat@smile.test")))[0].id;
    const cand = await apply("Noa", "Kim");
    const iv = await requestInterview(cand.id, { interviewerUserIds: [ownerId, patId] });
    expect((await interview(iv.id)).status).toBe("proposed");
    // the notices the owner herself gets (each one goes to every owner and admin)
    const asked = () => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.no_availability"), eq(notifications.userId, ownerId))).then((rows) => rows.filter((x) => x.title.includes("Noa")));
    expect(await asked()).toHaveLength(1);
    expect((await asked())[0].action?.href).toBe(`/interviews/${iv.id}`);
    const escalations = () => container.db.select().from(recruiterEscalations).where(and(eq(recruiterEscalations.companyId, companyId), eq(recruiterEscalations.kind, "candidate_issue"))).then((rows) => rows.filter((e) => (e.question ?? "").includes("Noa Kim")));
    // two days on, still no hours: the owner hears again, nobody else is brought in yet
    setClock(49 * H);
    await container.drain();
    expect(await asked()).toHaveLength(2);
    expect((await asked()).some((x) => /^Still waiting: .*Pat/.test(x.body))).toBe(true);
    expect(await escalations()).toHaveLength(0);
    // two more days: a recruiter is brought in, once
    setClock(98 * H);
    await container.drain();
    expect(await escalations()).toHaveLength(1);
    setClock(147 * H);
    await container.drain();
    expect(await escalations()).toHaveLength(1);
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
    setClock(0);
  });

  it("a first offer whose email waits for the ITS check starts no clock: no reminder, no expiry, until the times are actually sent (audit 06, bug 12)", async () => {
    const its = async (verified: boolean) => {
      const actor = { kind: "user" as const, id: ownerId, name: "ITS" };
      await withPlatform(container.db, (tx) => (verified ? verifyCompany(tx, container, { companyId, actor, reason: "test", now: container.engine.clock() }) : unverifyCompany(tx, { companyId, actor, reason: "test" })));
      await container.drain();
    };
    // Asked on a Wednesday, whatever day the tests run: the 8 times span Thursday to the next Tuesday, so some are still
    // ahead after the five held days (asked on a Monday, every time would have passed by then and the link would read
    // "expired").
    const d0 = ((3 - new Date(BASE).getUTCDay() + 7) % 7) * DAY;
    setClock(d0);
    const cand = await apply("Ines", "Cruz");
    await its(false);
    const iv = await requestInterview(cand.id);
    await container.drain();
    const row = await interview(iv.id);
    expect(row.status).toBe("scheduling");
    const [held] = await container.db.select().from(communications).where(eq(communications.idempotencyKey, `slots:${iv.id}:${row.attempt}`));
    expect(held.status).toBe("held");
    // the wait has no deadline, so the team is told once that the times wait for the ITS check
    const waiting = () => container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, "interview.no_availability"), eq(notifications.userId, ownerId))).then((rows) => rows.filter((x) => x.title === "Ines's interview times are waiting"));
    expect(await waiting()).toHaveLength(1);
    expect((await waiting())[0]!.body).toContain("wait for ITS to confirm your company");
    // five days pass with the email still held: no reminder, and the offer does not lapse
    setClock(d0 + 5 * DAY);
    await container.drain();
    expect(await interview(iv.id)).toMatchObject({ status: "scheduling", scheduleToken: row.scheduleToken });
    expect(await waiting()).toHaveLength(1);
    expect(outbox().some((m) => m.to === cand.email && /^Reminder: pick a time/.test(m.subject))).toBe(false);
    // ITS confirms the company: the email goes, its link still works, and only now does the offer's clock start
    await its(true);
    const sent = outbox().filter((m) => m.to === cand.email && /^Pick a time/.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`/c/schedule/${row.scheduleToken}`);
    expect((await app.request(`/c/schedule/${row.scheduleToken}`)).status).toBe(200);
    setClock(d0 + 5 * DAY + 47 * H);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /^Reminder: pick a time/.test(m.subject))).toBe(false);
    setClock(d0 + 5 * DAY + 49 * H);
    await container.drain();
    expect(outbox().some((m) => m.to === cand.email && /^Reminder: pick a time/.test(m.subject))).toBe(true);
    expect((await interview(iv.id)).status).toBe("scheduling");
    await json(owner, "POST", `/api/v1/interviews/${iv.id}/cancel`, { reason: "test cleanup" });
    await container.drain();
    setClock(0);
  });
});

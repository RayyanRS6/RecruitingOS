import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { INTERVIEW_CHANGED_SINCE, NEVER_HEARD_OF_IT, REMINDER_TOO_LATE, handleEmailEvent, interviewsCalledOff } from "@ros/agents";
import { anonymizeCandidate, entitlements, zonedParts, zonedToUtc } from "@ros/core";
import { applications, auditRecords, candidates, communications, companies, events, interviewFollowups, interviewParticipants, interviews, notifications, roles, screens, users, withPlatform, withTenant, workflowRuns, workflowSteps } from "@ros/db";
import type { FakeEmailAdapter, FakeGoogleCalendarProvider } from "@ros/integrations";
import { createApp } from "./app";
import { createContainer, type Container } from "./container";
import { unverifyCompany, verifyCompany } from "./services/company-trust";
import { placeOnInterview } from "./services/interview-create";
import { signInAs } from "./test-helpers";

/**
 * The owner's words, 6 November 2026: "nadine sets date and time from the shortlisted candidates and he/she will get the
 * mail". Everything here runs with nobody's calendar connected and nobody's hours declared, unless a case says otherwise:
 * that is the whole point. A person's press is the approval and the booking; the route writes it at once; the worker
 * then emails the candidate, reminds and closes.
 */
describe("a person sets the date and time", () => {
  let container: Container;
  let app: ReturnType<typeof createApp>;
  const H = 3_600_000;
  const DAY = 24 * H;
  const BASE = (() => { const d = new Date(); d.setUTCHours(18, 0, 0, 0); return d.getTime(); })();
  const TZ = "America/Los_Angeles";
  const setClock = (at: number) => { (container.engine as unknown as { now: () => Date }).now = () => new Date(at); };
  const signIn = async (email: string) => {
    const r1 = await app.request("/api/v1/auth/magic-link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    const { devLink } = (await r1.json()) as { devLink: string };
    const token = new URL(devLink).searchParams.get("token")!;
    const r2 = await app.request("/api/v1/auth/magic-link/consume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return r2.headers.get("set-cookie")!.split(";")[0];
  };
  const json = (cookie: string, method: string, path: string, body?: unknown) => app.request(path, { method, headers: { "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
  const form = (path: string, fields: Record<string, string> = {}) => app.request(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  const outbox = () => (container.integrations.email as FakeEmailAdapter).sent;
  const gcal = () => container.integrations.calendars.google as FakeGoogleCalendarProvider;
  const mailTo = (email: string) => outbox().filter((m) => m.to === email);
  const icsOf = (m: { attachments?: Array<{ contentBase64: string }> }) => Buffer.from(m.attachments![0].contentBase64, "base64").toString("utf8").replace(/\r\n /g, "");
  const interview = async (id: string) => (await container.db.select().from(interviews).where(eq(interviews.id, id)))[0];
  const application = async (id: string) => (await container.db.select().from(applications).where(eq(applications.id, id)))[0];
  const followUpOf = async (applicationId: string) => (await container.db.select().from(interviewFollowups).where(eq(interviewFollowups.applicationId, applicationId)).orderBy(desc(interviewFollowups.createdAt)))[0];
  const noticesAbout = async (kind: string, words: string) => (await container.db.select().from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, kind))).orderBy(asc(notifications.createdAt))).filter((n) => `${n.title} ${n.body}`.includes(words));
  const eventsOf = (subjectId: string, type: string) => container.db.select().from(events).where(and(eq(events.subjectId, subjectId), eq(events.type, type))).orderBy(asc(events.id));
  const runs = (interviewId: string) => container.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "schedule_interview"), sql`${workflowRuns.subject}->>'id' = ${interviewId}`));
  const emailOf = async (key: string) => (await container.db.select().from(communications).where(eq(communications.idempotencyKey, key)))[0];
  const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; details?: { names?: string[] } } }).error;
  const its = async (verified: boolean, at?: number) => {
    const actor = { kind: "user" as const, id: ownerId, name: "ITS" };
    await withPlatform(container.db, (tx) => (verified ? verifyCompany(tx, container, { companyId, actor, reason: "test", now: at ? new Date(at) : container.engine.clock() }) : unverifyCompany(tx, { companyId, actor, reason: "test" })));
    await container.drain();
  };

  let owner = "";
  let ownerId = "";
  let companyId = "";
  let companySlug = "";
  let companyName = "";
  let roleId = "";
  let roundKey = "";
  let n = 0;
  /** The company's day, `days` from today. */
  const dayIn = (days: number) => zonedParts(new Date(BASE + days * DAY), TZ).dayKey;
  /** The instant of a day and time on the company's clock. */
  const instant = (date: string, time: string) => { const [y, m, d] = date.split("-").map(Number); const [hh, mm] = time.split(":").map(Number); return zonedToUtc(y, m, d, hh, mm, TZ).getTime(); };
  /** A day far enough ahead of every clock move below, one per booking, so bookings never clash unless a case means them to. */
  let nextDay = 20;
  const fresh = () => ({ date: dayIn((nextDay += 1)), time: "14:00" });
  const setTime = (over: Record<string, unknown> = {}) => ({ ...fresh(), durationMinutes: 45, place: { kind: "link", url: "https://meet.example/room" }, ...over });

  const apply = async (first: string, last: string, opts: { phone?: string } = {}) => {
    n += 1;
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${n}@settime.test`;
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { requirements: { eligibility: Array<{ key: string }> } } } };
    const fd = new FormData();
    fd.set("firstName", first);
    fd.set("lastName", last);
    fd.set("email", email);
    fd.set("locationText", "Tustin, CA");
    if (opts.phone) fd.set("phone", opts.phone);
    fd.set("resume", new File([`${first} ${last}, RDH\nRegistered Dental Hygienist at Coastal Family Dentistry 2019 - present\nSkills: periodontal charting`], "resume.txt", { type: "text/plain" }));
    for (const rule of role.currentPacket.packet.requirements.eligibility) fd.set(`elig_${rule.key}`, "yes");
    fd.set("noticeVersionsShown", "ai_use@2026-09-01,privacy@2026-09-01");
    fd.set("acknowledged", "yes");
    const r = await app.request(`/careers/${companySlug}/jobs/${roleId}/apply`, { method: "POST", body: fd, headers: { "x-forwarded-for": `198.51.100.${n % 250}` } });
    expect(r.status).toBe(302);
    await container.drain();
    // Found by who applied, not by the newest time: the machine's clock can step back while a suite runs.
    const [{ a }] = await container.db.select({ a: applications }).from(applications).innerJoin(candidates, eq(candidates.id, applications.candidateId)).where(and(eq(applications.roleId, roleId), eq(candidates.email, email))).limit(1);
    return { id: a.id, email, candidateId: a.candidateId, statusToken: a.statusToken };
  };
  type Booked = { id: string; status: string; startsAt: string; candidateNotice?: string; moved?: boolean; [k: string]: unknown };
  const routeA = (applicationId: string, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, cookie = owner) => json(cookie, "POST", `/api/v1/applications/${applicationId}/interviews`, { roundKey, interviewerUserIds: [ownerId], setTime: setTime(body), ...extra });
  const routeB = (interviewId: string, body: Record<string, unknown> = {}, cookie = owner) => json(cookie, "POST", `/api/v1/interviews/${interviewId}/set-time`, setTime(body));
  type Applicant = Awaited<ReturnType<typeof apply>>;
  /** A person books this applicant through route A; the worker runs. */
  const bookFor = async (cand: Applicant, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
    const r = await routeA(cand.id, body, extra);
    expect(r.status, await r.clone().text()).toBe(201);
    const booked = (await r.json()) as Booked;
    await container.drain();
    const row = await interview(booked.id);
    return { cand, booked, row, token: row.scheduleToken! };
  };
  const book = async (first: string, last: string, body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => bookFor(await apply(first, last), body, extra);
  /** The old path, for the interview a person approved with no time: still `proposed` while nobody has hours. */
  const approveFor = async (cand: Applicant, extra: Record<string, unknown> = {}) => {
    const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar", ...extra });
    expect(r.status, await r.clone().text()).toBe(201);
    const { id } = (await r.json()) as { id: string };
    await container.drain();
    return { cand, id };
  };
  const approveOnly = async (first: string, last: string, extra: Record<string, unknown> = {}) => approveFor(await apply(first, last), extra);
  const confirmedPage = async (token: string, query = "") => (await app.request(`/c/schedule/${token}/confirmed${query}`)).text();
  /** As in production: `kick` runs nothing, and the worker gets to it when it gets to it. Everything inside sees what a person sees before that. */
  const withWorkerStopped = async <T>(during: () => Promise<T>): Promise<T> => {
    const kick = container.kick;
    container.kick = async () => undefined;
    try {
      return await during();
    } finally {
      container.kick = kick;
    }
  };

  beforeAll(async () => {
    container = await createContainer({ memory: true, env: { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", COMP_BLS_ENABLED: "false", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory", AUTH_PROVIDER: "fake" } });
    app = createApp(container);
    setClock(BASE);
    owner = await signIn("owner@settime.test");
    const [u] = await container.db.select({ id: users.id }).from(users).where(eq(users.email, "owner@settime.test"));
    ownerId = u.id;
    await container.db.update(users).set({ name: "Dana Whitfield" }).where(eq(users.id, ownerId));
    const co = (await (await json(owner, "POST", "/api/v1/companies", { name: "Harbor Dental", vertical: "dental", sizeBand: "20-49", locations: [{ city: "Tustin", region: "CA", country: "US" }] })).json()) as { id: string; slug: string; name: string };
    companyId = co.id;
    companySlug = co.slug;
    companyName = co.name;
    await entitlements.applyPlan(container.db, companyId, "growth");
    const [row] = await container.db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, companyId));
    expect(row.timezone).toBe(TZ);
    const s = (await (await json(owner, "POST", "/api/v1/intake/sessions", { initialMessage: "I need a registered dental hygienist in Tustin, $45 to $55 an hour, full time. It's a replacement. Ceiling $58. I decide. Must-haves: active CA RDH license. Just draft it." })).json()) as { session: { id: string } };
    roleId = ((await (await json(owner, "POST", `/api/v1/intake/sessions/${s.session.id}/compile`)).json()) as { roleId: string }).roleId;
    expect((await json(owner, "POST", `/api/v1/roles/${roleId}/approve`, { version: 1, note: "Looks right." })).status).toBe(200);
    const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { interviews: { plan: Array<{ key: string }> } } } };
    roundKey = role.currentPacket.packet.interviews.plan[0].key;
    await container.drain();
    // Nobody has hours or a calendar: the state every first-time owner is in.
    const mine = (await (await json(owner, "GET", "/api/v1/me/calendar")).json()) as { connection: unknown; availability: unknown };
    expect(mine).toMatchObject({ connection: null, availability: null });
  });
  afterAll(async () => {
    await container.close();
  });

  describe("route A: a new interview", () => {
    it("with no calendar and no declared hours, one press books it at once: the answer, the stage, the people and the sheet are right before the worker runs", async () => {
      const cand = await apply("Ana", "Reyes");
      expect(["triaged", "eligible", "screen_invited", "screening", "screen_complete"]).toContain((await application(cand.id)).stage);
      const chosen = fresh();
      const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], setTime: { ...chosen, durationMinutes: 60, place: { kind: "link", url: "https://meet.example/ana" } } });
      expect(r.status, await r.clone().text()).toBe(201);
      const out = (await r.json()) as Booked & { selectedSlot: { source: string; startsAt: string; id: string }; participants: Array<{ status: string }>; candidate: { stage: string } };
      expect(out).toMatchObject({ status: "scheduled", timezone: TZ, durationMinutes: 60, format: "video", meetingUrl: "https://meet.example/ana", linkSource: "pasted", offeredSlots: [], attempt: 1, candidateNotice: "queued", selectedSlot: { source: "person" }, candidate: { stage: "interview_scheduled", hasEmail: true } });
      expect(Date.parse(out.startsAt)).toBe(instant(chosen.date, chosen.time));
      expect(Date.parse(out.endsAt as string)).toBe(instant(chosen.date, chosen.time) + 60 * 60_000);
      expect(out.participants.map((p) => p.status)).toEqual(["confirmed"]);
      // the row, as the sheet reads it, even if the worker never runs
      const row = await interview(out.id);
      expect(row.scheduleToken).toBeTruthy();
      expect(Date.parse(row.scheduleTokenExpiresAt!)).toBe(Date.parse(out.endsAt as string) + DAY);
      expect((await application(cand.id)).stage).toBe("interview_scheduled");
      // the owner's Interviews page and the candidate's panel
      const list = (await (await json(owner, "GET", "/api/v1/interviews?status=scheduled")).json()) as Array<{ id: string }>;
      expect(list.some((i) => i.id === out.id)).toBe(true);
      const panel = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { ownerStage: string; interviews: Array<{ id: string; selectedSlot: { source: string }; durationMinutes: number; format: string; linkSource: string; candidateEmail: string | null }> };
      expect(panel.ownerStage).toBe("interviewing");
      expect(panel.interviews[0]).toMatchObject({ id: out.id, selectedSlot: { source: "person" }, durationMinutes: 60, format: "video", linkSource: "pasted", candidateEmail: null });
      // recorded as a person's booking, and the press was the approval: no second person, no waiting
      expect(await eventsOf(out.id, "interview.booked")).toHaveLength(1);
      expect((await eventsOf(out.id, "interview.booked"))[0].payload).toMatchObject({ setByPerson: true, attempt: 1, clashAllowed: false });
      const audits = await container.db.select().from(auditRecords).where(and(eq(auditRecords.companyId, companyId), eq(auditRecords.action, "interview.booked_on_behalf")));
      expect(audits.filter((a) => a.target?.id === out.id)[0]).toMatchObject({ reason: "a person set the date and time" });
      // History's reason beside each move of the one press: what the person did, never that an interview was approved
      const moves = (await eventsOf(cand.id, "application.stage_changed")).slice(-2).map((e) => [e.payload.to, e.payload.reason]);
      expect(moves).toEqual([["interview_recommended", "a person set the date and time"], ["interview_scheduled", "a person set the date and time"]]);
      // the run starts past `prepare`, so it never asks for hours, and an older worker in a release puts it back rather than failing it
      await container.drain();
      const [run] = await runs(out.id);
      expect((await container.db.select({ step: workflowSteps.stepKey }).from(workflowSteps).where(eq(workflowSteps.runId, run.id)).orderBy(asc(workflowSteps.seq))).map((s) => s.step)).toEqual(["place_on_calendars", "confirm", "on_timer"]);
    });

    it("as in production, where the route's kick runs nothing: the answer, the stage, the sheet, the list and their status page are right before the worker has run; moved meanwhile, the one email it then sends is their first", async () => {
      const cand = await apply("Ott", "Early");
      const before = mailTo(cand.email).length;
      const id = await withWorkerStopped(async () => {
        const r = await routeA(cand.id);
        expect(r.status, await r.clone().text()).toBe(201);
        const out = (await r.json()) as Booked;
        expect(out).toMatchObject({ status: "scheduled", candidateNotice: "queued", candidate: { stage: "interview_scheduled" } });
        // the run has not started, and nothing has been written to them yet
        expect((await runs(out.id))[0]).toMatchObject({ status: "running", currentStep: "place_on_calendars" });
        expect(await emailOf(`confirm:${out.id}:1`)).toBeUndefined();
        expect(((await (await json(owner, "GET", `/api/v1/interviews/${out.id}`)).json()) as { status: string; candidateEmail: string | null })).toMatchObject({ status: "scheduled", candidateEmail: null });
        const list = (await (await json(owner, "GET", "/api/v1/interviews?status=scheduled")).json()) as Array<{ id: string }>;
        expect(list.some((i) => i.id === out.id)).toBe(true);
        expect(((await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { ownerStage: string }).ownerStage).toBe("interviewing");
        const status = await (await app.request(`/c/status/${cand.statusToken}`)).text();
        expect(status).toContain("Your interview is booked. The details are below and in your email.");
        // moved at once: its old run stops, and nothing says "moved" to someone who has heard nothing
        const m = await routeB(out.id);
        expect(m.status, await m.clone().text()).toBe(200);
        expect((await m.json()) as Booked).toMatchObject({ status: "scheduled", attempt: 2, moved: false, candidateNotice: "queued" });
        expect((await runs(out.id)).find((x) => x.idempotencyKey === `schedule:${out.id}:1`)?.status).toBe("cancelled");
        expect(mailTo(cand.email)).toHaveLength(before);
        return out.id;
      });
      await container.drain();
      const mail = mailTo(cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toMatch(/^Your interview: /);
      expect(mail[0].text).toContain("Good news:");
      expect(await emailOf(`confirm:${id}:1`)).toBeUndefined();
      expect((await emailOf(`confirm:${id}:2`)).status).toBe("sent");
    });

    it("the candidate gets one email with the date, the time named by its zone, where, the calendar file and a way to ask for a change; the interviewer gets the brief; nobody is asked for hours", async () => {
      const chosen = fresh();
      const { cand, booked, token } = await book("Ben", "Cole", { ...chosen, durationMinutes: 30, place: { kind: "link", url: "https://meet.example/ben" } });
      const mail = mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:"));
      expect(mail).toHaveLength(1);
      const when = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(instant(chosen.date, chosen.time)));
      expect(mail[0].subject).toBe(`Your interview: ${booked.title} at ${companyName}, ${when}`);
      expect(mail[0].text).toContain(`Good news: ${companyName} would like to interview you for the `);
      expect(mail[0].text).toContain(`When: ${when}`);
      expect(when).toMatch(/P[DS]T$/);
      expect(mail[0].text).toContain("How long: 30 minutes");
      expect(mail[0].text).toContain("Join: https://meet.example/ben");
      expect(mail[0].text).toContain("Who: Dana");
      expect(mail[0].text).toContain("What to prepare: ");
      expect(mail[0].text).toContain(`A calendar invitation is attached. Need a different time? ${container.env.APP_BASE_URL}/c/schedule/${token}/confirmed`);
      // nothing in it says they confirmed something, or that they should pick
      expect(mail[0].text).not.toMatch(/You are confirmed|Pick a time|lets you reschedule/);
      expect(mailTo(cand.email).some((m) => /Pick a time/.test(m.subject))).toBe(false);
      const ics = icsOf(mail[0]);
      expect(ics).toContain("METHOD:REQUEST");
      expect(ics).toContain("SEQUENCE:0");
      expect(ics).toContain(`DTSTART:${new Date(instant(chosen.date, chosen.time)).toISOString().replace(/[-:]/g, "").replace(".000Z", "Z")}`);
      expect(ics).toContain(`UID:interview-${booked.id}@`);
      // the interviewer's confirmation, with the brief
      const team = mailTo("owner@settime.test").filter((m) => m.subject.startsWith("Interview booked: Ben Cole"));
      expect(team).toHaveLength(1);
      expect(team[0].text).toContain("Join: https://meet.example/ben");
      // not one of the old path's asks
      for (const kind of ["interview.no_availability", "interview.declare_availability", "interview.assigned"]) expect(await noticesAbout(kind, "Ben"), kind).toHaveLength(0);
      expect((await noticesAbout("interview.confirmed", "Ben Cole")).length).toBeGreaterThan(0);
      expect(await runs(booked.id)).toHaveLength(1);
    });

    it("the place: a link left empty, an address (kept as a working session when the round is one), by phone with the number they gave and without one", async () => {
      const video = await book("Cleo", "Link", { place: { kind: "link" } });
      expect(video.row).toMatchObject({ format: "video", linkSource: "calendar", meetingUrl: null });
      expect(mailTo(video.cand.email)[1].text).toContain("Format: video; details from the team follow if anything else is needed.");

      const visit = await book("Dov", "Visit", { place: { kind: "address", text: " 12 Main St, Tustin " } });
      expect(visit.row).toMatchObject({ format: "onsite", linkSource: "pasted", meetingUrl: null, selectedSlot: { source: "person", address: "12 Main St, Tustin" } });
      const visitMail = mailTo(visit.cand.email).find((m) => m.subject.startsWith("Your interview:"))!;
      expect(visitMail.text).toContain("Where: 12 Main St, Tustin");
      expect(icsOf(visitMail)).toContain("LOCATION:12 Main St\\, Tustin");
      const visitPage = await confirmedPage(visit.token);
      expect(visitPage).toContain("<div><span>Where</span><span>12 Main St, Tustin</span></div>");
      const status = await (await app.request(`/c/status/${visit.cand.statusToken}`)).text();
      expect(status).toContain("Your interview is booked. The details are below and in your email.");
      expect(status).toContain(" · 12 Main St, Tustin");
      expect(status).toContain("Details, calendar file, reschedule or cancel");
      expect((await noticesAbout("interview.confirmed", "Dov Visit")).some((x) => x.body.includes("Where: 12 Main St, Tustin"))).toBe(true);

      const withPhone = await apply("Eva", "Phone", { phone: "+1 714 555 0100" });
      const called = await routeA(withPhone.id, { place: { kind: "phone" } });
      expect(called.status, await called.clone().text()).toBe(201);
      await container.drain();
      const phoned = await interview(((await called.json()) as Booked).id);
      expect(phoned).toMatchObject({ format: "phone", linkSource: "pasted", meetingUrl: null, selectedSlot: { source: "person" } });
      const phoneMail = mailTo(withPhone.email).find((m) => m.subject.startsWith("Your interview:"))!;
      expect(phoneMail.text).toMatch(/By phone: Harbor Dental will call you at \+?1?.*714.*555.*0100/);
      expect(icsOf(phoneMail)).toContain("LOCATION:By phone");
      expect(await confirmedPage(phoned.scheduleToken!)).toMatch(/<div><span>Where<\/span><span>By phone: Harbor Dental will call you at [^<]*0100<\/span><\/div>/);
      // the team is told it is by phone; an interviewer never gets the candidate's number (docs/spec/21 F8)
      const team = mailTo("owner@settime.test").find((m) => m.subject.startsWith("Interview booked: Eva Phone"))!;
      expect(team.text).toContain("By phone");
      expect(team.text).not.toContain("0100");

      const noPhone = await book("Finn", "Quiet", { place: { kind: "phone" } });
      expect(mailTo(noPhone.cand.email).find((m) => m.subject.startsWith("Your interview:"))!.text).toContain("By phone: Harbor Dental will call you. Reply with the best number to reach you.");
    });

    it("an address or a phone call never asks a live calendar for a video link; a link left empty does, and it goes in the email", async () => {
      const cal = await signInAs(container, app, { companyId, role: "hiring_manager", email: "cal@settime.test", name: "Cal Ortiz" });
      const calId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "cal@settime.test")))[0].id;
      const start = await app.request("/api/v1/integrations/calendar/google/connect", { headers: { cookie: cal } });
      const pkce = start.headers.get("set-cookie")!.split(";")[0];
      const authorize = new URL(start.headers.get("location")!);
      const consent = await app.request("/api/v1/integrations/calendar/fake/authorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ redirect_to: `${container.env.APP_BASE_URL}/api/v1/integrations/calendar/google/callback`, state: authorize.searchParams.get("state")!, code_challenge: authorize.searchParams.get("code_challenge")!, email: "cal@settime.test", timezone: TZ }).toString() });
      const cb = new URL(consent.headers.get("location")!);
      await app.request(`${cb.pathname}?${cb.searchParams.toString()}`, { headers: { cookie: `${cal}; ${pkce}` } });
      const events_ = () => gcal().eventsFor("cal@settime.test").filter((e) => e.status === "confirmed");

      const onCalendar = await book("Gus", "Hall", { place: { kind: "link" } }, { interviewerUserIds: [calId] });
      expect(onCalendar.row.meetingUrl).toMatch(/meet\.google\.com/);
      expect(mailTo(onCalendar.cand.email).find((m) => m.subject.startsWith("Your interview:"))!.text).toContain(`Join: ${onCalendar.row.meetingUrl}`);
      expect(events_()).toHaveLength(1);

      const visit = await book("Hal", "Page", { place: { kind: "address", text: "12 Main St, Tustin" } }, { interviewerUserIds: [calId] });
      expect(visit.row.meetingUrl).toBeNull();
      expect(events_().find((e) => e.idempotencyKey.startsWith(`interview:${visit.booked.id}:`))!.location).toBe("12 Main St, Tustin");

      // moving one takes the old event off and puts the new one on: never two live events for one interview
      const moved = await routeB(onCalendar.booked.id, { place: { kind: "link" } }, cal);
      expect(moved.status, await moved.clone().text()).toBe(200);
      await container.drain();
      const mine = events_().filter((e) => e.idempotencyKey.startsWith(`interview:${onCalendar.booked.id}:`));
      expect(mine).toHaveLength(1);
      expect(mine[0].idempotencyKey).toBe(`interview:${onCalendar.booked.id}:2:${calId}`);
    });

    it("what a place writes on the interview: a round that is a working session stays one at an address, and only a link left empty asks a calendar for one", () => {
      expect(placeOnInterview({ kind: "address", text: "12 Main St" }, "working_session")).toEqual({ format: "working_session", linkSource: "pasted", meetingUrl: null, address: "12 Main St" });
      expect(placeOnInterview({ kind: "address", text: "12 Main St" }, "video")).toEqual({ format: "onsite", linkSource: "pasted", meetingUrl: null, address: "12 Main St" });
      expect(placeOnInterview({ kind: "phone" }, "onsite")).toEqual({ format: "phone", linkSource: "pasted", meetingUrl: null, address: null });
      expect(placeOnInterview({ kind: "link" }, "onsite")).toEqual({ format: "video", linkSource: "calendar", meetingUrl: null, address: null });
      expect(placeOnInterview({ kind: "link", url: "https://meet.example/x" }, "onsite")).toEqual({ format: "video", linkSource: "pasted", meetingUrl: "https://meet.example/x", address: null });
    });

    it("the owner's path: someone on the Shortlist is booked, and the mark gives way to Interviewing; a time for someone on hold ends the hold", async () => {
      const cand = await apply("Lia", "Short");
      expect((await json(owner, "POST", `/api/v1/applications/${cand.id}/actions`, { action: "set_mark", mark: "shortlist" })).status).toBe(200);
      const before = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { ownerStage: string; allowedActions: string[] };
      expect(before.ownerStage).toBe("shortlist");
      expect(before.allowedActions).toContain("interview");
      expect((await routeA(cand.id)).status).toBe(201);
      const after = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { ownerStage: string; mark: unknown; allowedActions: string[] };
      expect(after).toMatchObject({ ownerStage: "interviewing", mark: null });
      expect(after.allowedActions).not.toContain("interview");

      const { cand: held, id } = await approveOnly("Mo", "Short");
      expect((await json(owner, "POST", `/api/v1/applications/${held.id}/actions`, { action: "hold", note: "Waiting on a licence renewal" })).status).toBe(200);
      expect(((await (await json(owner, "GET", `/api/v1/applications/${held.id}`)).json()) as { ownerStage: string }).ownerStage).toBe("on_hold");
      expect((await routeB(id)).status).toBe(200);
      expect(((await (await json(owner, "GET", `/api/v1/applications/${held.id}`)).json()) as { ownerStage: string; mark: unknown })).toMatchObject({ ownerStage: "interviewing", mark: null });
    });

    it("the same round twice is refused while one is open; an unknown round or interviewer is refused; the personal line goes in the email", async () => {
      const cand = await apply("Ida", "Lane");
      const first = await routeA(cand.id, {}, { invitationLine: { text: "Looking forward to meeting you.", aiHelped: false } });
      expect(first.status, await first.clone().text()).toBe(201);
      const again = await routeA(cand.id);
      expect(again.status).toBe(409);
      expect((await errorOf(again)).code).toBe("interview_open");
      // a notice's old link to the form says the same, in the same words
      const form_ = await json(owner, "GET", `/api/v1/applications/${cand.id}/interview-draft`);
      expect(form_.status).toBe(409);
      expect(await errorOf(form_)).toMatchObject({ code: "interview_open", message: "This candidate already has an interview set up. Open it to move or cancel it." });
      await container.drain();
      expect(mailTo(cand.email).find((m) => m.subject.startsWith("Your interview:"))!.text).toContain("A note from Dana Whitfield: Looking forward to meeting you.");

      const other = await apply("Jan", "Lane");
      expect((await errorOf(await routeA(other.id, {}, { roundKey: "no_such_round" }))).code).toBe("round_unknown");
      expect((await errorOf(await routeA(other.id, {}, { interviewerUserIds: ["00000000-0000-0000-0000-000000000000"] }))).code).toBe("interviewer_unknown");
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, other.id))).toHaveLength(0);
    });

    it("someone who has not done the AI interview may be booked: its link stays open, and their page says the booked time is what happens next", async () => {
      const cand = await apply("Kit", "Moss");
      expect((await application(cand.id)).stage).toBe("screen_invited");
      const page = async () => (await app.request(`/c/status/${cand.statusToken}`)).text();
      expect(await page()).toContain("Start your AI interview");
      const r = await routeA(cand.id);
      expect(r.status, await r.clone().text()).toBe(201);
      expect((await application(cand.id)).stage).toBe("interview_scheduled");
      const [scr] = await container.db.select().from(screens).where(eq(screens.applicationId, cand.id));
      expect(scr.status).toBe("invited");
      const booked = await page();
      expect(booked).toContain("Your interview is booked. The details are below and in your email.");
      expect(booked).not.toMatch(/<a class="btn" href="\/c\/screen\//);
      // the line where they are never ticks an AI interview they have not done: Applied and Review behind them, Interview now
      const track = (html: string) => html.slice(html.indexOf('<ol class="track"'), html.indexOf("</ol>", html.indexOf('<ol class="track"')));
      expect(track(booked)).not.toContain("AI interview");
      expect(track(booked)).toContain('<li class="current" aria-current="step"><span class="dot" aria-hidden="true"></span><span>Interview</span></li>');
      expect(track(booked)).toContain('<span>Review</span><span class="sr-only"> (done)</span>');
      expect((await app.request(`/c/screen/${scr.token}`)).status).toBe(200);
      // the AI interview's own reminder and closing note never come while the interview is theirs: "in a few days your
      // application goes to the hiring team without it" and "nothing else is needed from you" would not be true (the release
      // review, 11 November 2026, L4-6); its link still closes on time
      const NUDGES = ["screen_not_started_reminder", "screen_not_started", "screen_reminder", "screen_expired", "screen_idle_reminder", "screen_review_reminder", "screen_unfinished"];
      const nudges = async () => (await container.db.select({ key: communications.templateKey }).from(communications).where(eq(communications.applicationId, cand.id))).filter((m) => NUDGES.includes(m.key ?? ""));
      try {
        setClock(BASE + 49 * H);
        await container.drain();
        expect(await nudges()).toEqual([]);
        setClock(BASE + 8 * DAY);
        await container.drain();
        expect(await nudges()).toEqual([]);
        expect((await container.db.select().from(screens).where(eq(screens.id, scr.id)))[0].status).toBe("expired");
        expect(mailTo(cand.email).some((m) => /your AI interview is still open|without the AI interview|nothing else is needed/i.test(`${m.subject} ${m.text}`))).toBe(false);
      } finally {
        setClock(BASE);
      }
    });

    it("who may press: an owner, an admin, a hiring manager and an ITS recruiter's roles hold it; HR and an interviewer see the time and cannot set it", async () => {
      const hr = await signInAs(container, app, { companyId, role: "hr", email: "hr@settime.test", name: "Hana Ruiz" });
      const interviewer = await signInAs(container, app, { companyId, role: "interviewer", email: "ivan@settime.test", name: "Ivan Petrov" });
      const manager = await signInAs(container, app, { companyId, role: "hiring_manager", email: "mia@settime.test", name: "Mia Lund" });
      const cand = await apply("Lou", "Hart");
      for (const cookie of [hr, interviewer]) {
        const refused = await routeA(cand.id, {}, {}, cookie);
        expect(refused.status).toBe(403);
      }
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, cand.id))).toHaveLength(0);
      const ok = await routeA(cand.id, {}, {}, manager);
      expect(ok.status, await ok.clone().text()).toBe(201);
      const { id } = (await ok.json()) as Booked;
      for (const cookie of [hr, interviewer]) expect((await routeB(id, {}, cookie)).status).toBe(403);
      // HR reads the time; the sheet carries it for anyone who may read interviews
      expect(((await (await json(hr, "GET", `/api/v1/interviews/${id}`)).json()) as { status: string }).status).toBe("scheduled");
      expect((await routeB(id, {}, manager)).status).toBe(200);
      // the press is the approval for every role that holds it: no second person, on either route
      for (const role of ["admin", "recruiter"] as const) {
        const cookie = await signInAs(container, app, { companyId, role, email: `${role}.presser@settime.test`, name: `${role} Presser` });
        const theirs = await apply("Max", role === "admin" ? "Admin" : "Recruiter");
        const set = await routeA(theirs.id, {}, {}, cookie);
        expect(set.status, await set.clone().text()).toBe(201);
        const { id: theirId } = (await set.json()) as Booked;
        expect((await routeB(theirId, {}, cookie)).status, role).toBe(200);
      }
    });
  });

  describe("route B: an interview in motion", () => {
    it("the stuck interview: approved with nobody's hours, sitting on 'Preparing times', is booked at once with the same form, and the run that waited for hours stops", async () => {
      const { cand, id } = await approveOnly("Mae", "Fern", { invitationLine: { text: "We loved your application.", aiHelped: false } });
      const stuck = await interview(id);
      expect(stuck).toMatchObject({ status: "proposed", attempt: 1, offeredSlots: [], scheduleToken: null });
      expect((await application(cand.id)).stage).toBe("interview_recommended");
      expect((await runs(id))[0]).toMatchObject({ status: "waiting", currentStep: "prepare" });
      // the notice says what to do about it
      expect((await noticesAbout("interview.no_availability", "Mae's interview"))[0].action).toEqual({ label: "Set a date and time", href: `/interviews/${id}` });
      const before = mailTo(cand.email).length;
      const chosen = fresh();
      const r = await routeB(id, { ...chosen, durationMinutes: 30, place: { kind: "address", text: "12 Main St, Tustin" } });
      expect(r.status, await r.clone().text()).toBe(200);
      const out = (await r.json()) as Booked;
      expect(out).toMatchObject({ status: "scheduled", attempt: 2, durationMinutes: 30, format: "onsite", timezone: TZ, candidateNotice: "queued", moved: false, candidate: { stage: "interview_scheduled" } });
      expect(Date.parse(out.startsAt)).toBe(instant(chosen.date, chosen.time));
      expect((await application(cand.id)).stage).toBe("interview_scheduled");
      const row = await interview(id);
      expect(row.scheduleToken).toBeTruthy();
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${id}`)).json()) as { participants: Array<{ status: string }> }).participants.map((p) => p.status)).toEqual(["confirmed"]);
      await container.drain();
      // the old run stopped for good; the new one carries the personal line nobody has read yet, and waits for its reminders
      const all = await runs(id);
      expect(all.find((x) => x.idempotencyKey === `schedule:${id}:1`)?.status).toBe("cancelled");
      expect(all.find((x) => x.idempotencyKey === `schedule:${id}:2`)).toMatchObject({ status: "waiting", currentStep: "on_timer" });
      const mail = mailTo(cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toMatch(/^Your interview: /);
      expect(mail[0].text).toContain("Good news:");
      expect(mail[0].text).toContain("Where: 12 Main St, Tustin");
      expect(mail[0].text).toContain("A note from Dana Whitfield: We loved your application.");
      expect(icsOf(mail[0])).toContain("SEQUENCE:2");
      expect(await eventsOf(id, "interview.booked")).toHaveLength(1);
    });

    it("the old re-offer never takes a booked time away for times nobody has hours to offer: nobody is told new times are coming that never would, and the time stands; one nothing was booked for still takes a time", async () => {
      const { cand, booked, row, token } = await book("Ren", "Hours");
      const before = mailTo(cand.email).length;
      const r = await json(owner, "POST", `/api/v1/interviews/${booked.id}/reschedule`, { reason: "A clash at our end." });
      expect(r.status).toBe(409);
      expect(await errorOf(r)).toMatchObject({ code: "no_hours", message: "Not everyone on this interview has hours to offer. Set a date and time instead." });
      await container.drain();
      expect(await interview(booked.id)).toMatchObject({ status: "scheduled", attempt: row.attempt, scheduleToken: token });
      expect((await application(cand.id)).stage).toBe("interview_scheduled");
      expect(mailTo(cand.email)).toHaveLength(before);
      // from a page left open on a stuck interview, nothing reaches anyone and it stays without a time: the form still books it
      const stuck = await approveOnly("Sia", "Hours");
      const mails = mailTo(stuck.cand.email).length;
      expect((await json(owner, "POST", `/api/v1/interviews/${stuck.id}/reschedule`, {})).status).toBe(200);
      await container.drain();
      expect(await interview(stuck.id)).toMatchObject({ status: "scheduling", attempt: 2, offeredSlots: [], startsAt: null });
      expect(mailTo(stuck.cand.email)).toHaveLength(mails);
      const set = await routeB(stuck.id);
      expect(set.status, await set.clone().text()).toBe(200);
      await container.drain();
      expect(await interview(stuck.id)).toMatchObject({ status: "scheduled", attempt: 3 });
      expect(mailTo(stuck.cand.email).slice(mails).map((m) => m.subject)).toEqual([expect.stringMatching(/^Your interview: /)]);
    });

    it("with hours known, the fold's re-offer of a time a person set still works: they are told it is off, and pick from new times; one nobody told them of says nothing and the times are their first email", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      expect((await json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const told = await book("Tad", "Fold", {}, { interviewerUserIds: [wesId] });
      const before = mailTo(told.cand.email).length;
      const r = await json(wes, "POST", `/api/v1/interviews/${told.booked.id}/reschedule`, { reason: "A clash at our end." });
      expect(r.status, await r.clone().text()).toBe(200);
      expect(await r.json()).toMatchObject({ candidateTold: true, status: "scheduling" });
      await container.drain();
      const mail = mailTo(told.cand.email).slice(before);
      expect(mail.map((m) => m.subject)).toEqual([expect.stringMatching(/^Your interview time has changed/), expect.stringMatching(/^New times for your interview/)]);
      expect(await interview(told.booked.id)).toMatchObject({ status: "scheduling", selectedSlot: null });

      const unheard = await apply("Uli", "Fold");
      const { id, before: first } = await withWorkerStopped(async () => {
        const set = await routeA(unheard.id, {}, { interviewerUserIds: [wesId] });
        expect(set.status, await set.clone().text()).toBe(201);
        const { id: bookedId } = (await set.json()) as Booked;
        const again = await json(wes, "POST", `/api/v1/interviews/${bookedId}/reschedule`, { reason: "A clash at our end." });
        expect(again.status, await again.clone().text()).toBe(200);
        expect(await again.json()).toMatchObject({ candidateTold: false, status: "scheduling" });
        return { id: bookedId, before: mailTo(unheard.email).length };
      });
      await container.drain();
      expect(await emailOf(`iv_moved:${id}:1`)).toBeUndefined();
      const firstMail = mailTo(unheard.email).slice(first);
      expect(firstMail.map((m) => m.subject)).toEqual([expect.stringMatching(/^Pick a time for your interview/)]);
      expect(firstMail[0].text).toContain("Good news:");
    });

    it("an interview whose times are out, from someone's declared hours: a person sets another; the old link goes to the booked page, and a pick from it changes nothing", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      expect((await json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 6 })).status).toBe(200);
      const { cand, id } = await approveOnly("Nia", "Bloom", { interviewerUserIds: [wesId] });
      const offered = await interview(id);
      expect(offered.status).toBe("scheduling");
      expect(offered.offeredSlots.length).toBeGreaterThan(0);
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Pick a time"))).toHaveLength(1);
      const r = await routeB(id, {}, wes);
      expect(r.status, await r.clone().text()).toBe(200);
      await container.drain();
      const row = await interview(id);
      expect(row).toMatchObject({ status: "scheduled", attempt: offered.attempt + 1, offeredSlots: [], selectedSlot: { source: "person" }, scheduleToken: offered.scheduleToken });
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(1);
      expect((await app.request(`/c/schedule/${offered.scheduleToken}`)).headers.get("location")).toBe(`/c/schedule/${offered.scheduleToken}/confirmed`);
      const pick = await form(`/c/schedule/${offered.scheduleToken}`, { slotId: offered.offeredSlots[0].id, timezone: TZ });
      expect(pick.headers.get("location")).toBe(`/c/schedule/${offered.scheduleToken}/confirmed`);
      expect(Date.parse((await interview(id)).startsAt!)).toBe(Date.parse(row.startsAt!));

      // with hours known and nothing booked, the times they lapsed from: a lapsed offer takes a time too, with a new link
      const lapsing = await approveOnly("Ola", "Bloom", { interviewerUserIds: [wesId] });
      setClock(BASE + 49 * H);
      await container.drain();
      setClock(BASE + 98 * H);
      await container.drain();
      expect(await interview(lapsing.id)).toMatchObject({ status: "offer_expired", scheduleToken: null });
      expect((await noticesAbout("interview.offer_expired", "Ola Bloom"))[0]).toMatchObject({ body: "Four days passed with a reminder. Set a date and time, decide, or bring in a recruiter.", action: { label: "Set a date and time", href: `/interviews/${lapsing.id}` } });
      const set = await routeB(lapsing.id, {}, wes);
      expect(set.status, await set.clone().text()).toBe(200);
      await container.drain();
      const relit = await interview(lapsing.id);
      expect(relit.status).toBe("scheduled");
      expect(relit.scheduleToken).toBeTruthy();
      expect(mailTo(lapsing.cand.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(1);
      setClock(BASE);
    });

    it("what cannot be set: an interview that is over or cancelled, one already started, someone who left the process, and a lapsed offer when another interview is open", async () => {
      const { cand, booked, row } = await book("Pia", "Stone");
      // started
      setClock(Date.parse(row.startsAt!) + 5 * 60_000);
      const started = await routeB(booked.id);
      expect(started.status).toBe(409);
      expect(await errorOf(started)).toMatchObject({ code: "interview_started", message: "It has started. Record what happened instead." });
      setClock(BASE);
      // cancelled
      expect((await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "A clash at our end." })).status).toBe(200);
      const off = await routeB(booked.id);
      expect(off.status).toBe(409);
      // in words, never the raw status ("This interview is cancelled.", "… no_show."): the release review, 11 November 2026
      expect(await errorOf(off)).toMatchObject({ code: "interview_not_schedulable", message: "This interview was cancelled." });
      expect(await errorOf(await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "Again." }))).toMatchObject({ code: "interview_not_schedulable", message: "This interview was cancelled." });
      expect(await errorOf(await json(owner, "POST", `/api/v1/interviews/${booked.id}/outcome`, { outcome: "happened" }))).toMatchObject({ code: "interview_not_schedulable", message: "This interview was cancelled." });
      // and a new interview is route A again
      const again = await routeA(cand.id);
      expect(again.status, await again.clone().text()).toBe(201);
      const { id: secondId } = (await again.json()) as Booked;

      // over
      const done = await book("Quin", "Stone");
      expect((await json(owner, "POST", `/api/v1/interviews/${done.booked.id}/outcome`, { outcome: "happened" })).status).toBe(200);
      expect(await errorOf(await routeB(done.booked.id))).toMatchObject({ code: "interview_not_schedulable", message: "This interview took place: record what comes next on their page." });
      // the candidate did not come: said as it is, with where to go
      const missed = await book("Ros", "Stone");
      expect((await json(owner, "POST", `/api/v1/interviews/${missed.booked.id}/outcome`, { outcome: "no_show_candidate" })).status).toBe(200);
      for (const r of [await routeB(missed.booked.id), await json(owner, "POST", `/api/v1/interviews/${missed.booked.id}/cancel`, { reason: "Off." })]) {
        const e = await errorOf(r);
        expect(e).toMatchObject({ code: "interview_not_schedulable", message: "This interview did not take place: record what comes next on their page." });
        expect(e.message).not.toMatch(/no_show|_/);
      }

      // left the process: the row left behind for someone hired is refused in plain words
      await container.db.update(applications).set({ stage: "hired" }).where(eq(applications.id, cand.id));
      const gone = await routeB(secondId);
      expect(gone.status).toBe(409);
      expect((await errorOf(gone)).message).toBe('A candidate at "Hired" cannot be moved to an interview from here.');
      await container.db.update(applications).set({ stage: "interview_scheduled" }).where(eq(applications.id, cand.id));

      // a lapsed offer beside an open interview: one at a time
      const [lapsed] = await container.db.insert(interviews).values({ companyId, applicationId: cand.id, roundKey, title: "An older round", format: "video", durationMinutes: 30, status: "offer_expired", timezone: TZ }).returning();
      await container.db.insert(interviewParticipants).values({ companyId, interviewId: lapsed.id, userId: ownerId, role: "interviewer", status: "invited" });
      const open = await routeB(lapsed.id);
      expect(open.status).toBe(409);
      expect((await errorOf(open)).code).toBe("interview_open");
      expect((await interview(lapsed.id)).status).toBe("offer_expired");

      // an interview nobody is on: refused in words that say what to do, with no booking nobody attends
      const { id: empty } = await approveOnly("Rex", "Stone");
      await container.db.delete(interviewParticipants).where(eq(interviewParticipants.interviewId, empty));
      const nobody = await routeB(empty);
      expect(nobody.status).toBe(409);
      expect(await errorOf(nobody)).toMatchObject({ code: "no_interviewers", message: "Nobody is on this interview. Cancel it and set up a new one." });
    });
  });

  describe("times that are refused, on the company's clock", () => {
    it("a time that has passed, on both routes, and nothing is written", async () => {
      const cand = await apply("Rae", "Vale");
      for (const past of [{ date: dayIn(-1), time: "14:00" }, { date: dayIn(0), time: zonedParts(new Date(BASE - H), TZ).hour.toString().padStart(2, "0") + ":00" }]) {
        const r = await routeA(cand.id, past);
        expect(r.status, JSON.stringify(past)).toBe(400);
        expect(await errorOf(r)).toMatchObject({ code: "time_passed", message: "That time has passed. Choose a later one." });
      }
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, cand.id))).toHaveLength(0);
      expect((await application(cand.id)).stage).not.toBe("interview_recommended");
      const { id } = await approveOnly("Sam", "Vale");
      const r = await routeB(id, { date: dayIn(-1), time: "14:00" });
      expect(r.status).toBe(400);
      expect((await errorOf(r)).code).toBe("time_passed");
      expect(await interview(id)).toMatchObject({ status: "proposed", attempt: 1, startsAt: null });
      expect((await runs(id))[0].status).toBe("waiting");
    });

    it("a wall-clock time the clocks skip, on both routes; the hour after it is fine", async () => {
      // the second Sunday of next March: 02:00 to 03:00 does not happen in Los Angeles
      const year = zonedParts(new Date(BASE), TZ).year + 1;
      const first = new Date(Date.UTC(year, 2, 1)).getUTCDay();
      const gapDay = `${year}-03-${String(1 + ((7 - first) % 7) + 7).padStart(2, "0")}`;
      const cand = await apply("Tam", "Vale");
      const r = await routeA(cand.id, { date: gapDay, time: "02:30" });
      expect(r.status).toBe(400);
      expect(await errorOf(r)).toMatchObject({ code: "no_such_time", message: "That time does not exist on that day: the clocks change. Choose another." });
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, cand.id))).toHaveLength(0);
      const { id } = await approveOnly("Uma", "Vale");
      expect((await errorOf(await routeB(id, { date: gapDay, time: "02:00" }))).code).toBe("no_such_time");
      expect((await routeB(id, { date: gapDay, time: "03:00" })).status).toBe(200);
      // a date that does not exist, a clock that does not, and a length out of range are refused before anything reads them
      for (const bad of [{ date: `${year}-02-30` }, { time: "25:00" }, { durationMinutes: 5 }, { durationMinutes: 600 }, { place: { kind: "address", text: "x" } }, { place: { kind: "link", url: "javascript:alert(1)" } }, { place: { kind: "carrier-pigeon" } }]) {
        const res = await routeB(id, bad);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        expect((await errorOf(res)).code).toBe("invalid_request");
      }
    });

    it("this afternoon, a weekend and the middle of the night are allowed, and nothing is said about any of them", async () => {
      const soon = new Date(BASE + 90 * 60_000);
      const today = zonedParts(soon, TZ);
      const a = await apply("Val", "Hour");
      const r = await routeA(a.id, { date: today.dayKey, time: `${String(today.hour).padStart(2, "0")}:${String(today.minute).padStart(2, "0")}` });
      expect(r.status, await r.clone().text()).toBe(201);
      // the next Sunday, at 23:00
      let sunday = 21;
      while (zonedParts(new Date(BASE + sunday * DAY), TZ).weekday !== 0) sunday += 1;
      const b = await apply("Wyn", "Hour");
      const s = await routeA(b.id, { date: dayIn(sunday), time: "23:00" });
      expect(s.status, await s.clone().text()).toBe(201);
      expect(((await s.json()) as { candidateNotice: string }).candidateNotice).toBe("queued");
    });
  });

  describe("a clash", () => {
    it("an interviewer already booked then gets a 409 naming them; Book anyway goes ahead and is recorded; a time next to it, and the interview's own time, are not a clash", async () => {
      const chosen = fresh();
      await book("Xia", "Stone", { ...chosen, durationMinutes: 60 });
      const cand = await apply("Yan", "Stone");
      const r = await routeA(cand.id, { ...chosen, durationMinutes: 30 });
      expect(r.status).toBe(409);
      expect(await errorOf(r)).toMatchObject({ code: "interviewer_busy", message: "Dana already has an interview at that time.", details: { names: ["Dana"] } });
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, cand.id))).toHaveLength(0);
      // right after it ends is free: no buffer
      const later = await apply("Zed", "Stone");
      const next = await routeA(later.id, { date: chosen.date, time: "15:00" });
      expect(next.status, await next.clone().text()).toBe(201);
      // "Book anyway"
      const anyway = await routeA(cand.id, { ...chosen, durationMinutes: 30, allowClash: true });
      expect(anyway.status, await anyway.clone().text()).toBe(201);
      const { id } = (await anyway.json()) as Booked;
      expect((await eventsOf(id, "interview.booked"))[0].payload).toMatchObject({ clashAllowed: true, setByPerson: true });
      // route B, too: moving it fifteen minutes still overlaps the other one, so it names Dana for that
      const ownClash = await routeB(id, { ...chosen, time: "14:15", durationMinutes: 30 });
      expect(ownClash.status).toBe(409);
      expect((await errorOf(ownClash)).code).toBe("interviewer_busy");
      // the interview's own time is no clash: alone on its day, it moves onto a time it overlaps
      const alone = await book("Abe", "Stone");
      const self = await routeB(alone.booked.id, { date: zonedParts(new Date(alone.row.startsAt!), TZ).dayKey, time: "14:15" });
      expect(self.status, await self.clone().text()).toBe(200);
      const moved = (await self.json()) as Booked;
      expect((await eventsOf(moved.id, "interview.rescheduled")).at(-1)?.payload).toMatchObject({ clashAllowed: false });
    });

    it("two interviewers clashing are both named", async () => {
      const lea = await signInAs(container, app, { companyId, role: "hiring_manager", email: "lea@settime.test", name: "Lea Hart" });
      const leaId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "lea@settime.test")))[0].id;
      expect(lea).toBeTruthy();
      const chosen = fresh();
      await book("Bea", "Stone", chosen, { interviewerUserIds: [ownerId, leaId] });
      const cand = await apply("Cal", "Stone");
      const r = await routeA(cand.id, chosen, { interviewerUserIds: [ownerId, leaId] });
      expect((await errorOf(r)).message).toBe("Dana and Lea already have an interview at that time.");
    });
  });

  describe("a closed or filled role", () => {
    it("is refused on both routes, instead of a booking whose run would end silently with no email", async () => {
      const cand = await apply("Dee", "Vale");
      const { id } = await approveOnly("Eli", "Vale");
      try {
        for (const status of ["closed", "filled"]) {
          await container.db.update(roles).set({ status }).where(eq(roles.id, roleId));
          // the folded path too: its run would end the same way, and leave "Preparing times" for ever
          const oldPath = await json(owner, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey, interviewerUserIds: [ownerId], linkSource: "calendar" });
          for (const r of [await routeA(cand.id), await routeB(id), oldPath]) {
            expect(r.status, status).toBe(409);
            expect(await errorOf(r), status).toMatchObject({ code: "role_closed", message: "This job is closed, so no interview can be booked for it." });
          }
        }
      } finally {
        await container.db.update(roles).set({ status: "open" }).where(eq(roles.id, roleId));
      }
      expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, cand.id))).toHaveLength(0);
      expect((await interview(id)).status).toBe("proposed");
    });
  });

  describe("someone under Cancelled", () => {
    it("they cancelled and asked for new times with nobody's hours known: no day is promised anywhere, the team is told to set a time, 'Send new times' says why not, and setting one takes them out as rebooked with words that fit", async () => {
      const { cand, booked, token } = await book("Fay", "Reed");
      const page = await confirmedPage(token);
      expect(page).toContain("Someone from the team will be in touch about new times.");
      expect(page).not.toMatch(/We will email you new times on/);
      expect((await form(`/c/schedule/${token}/cancel`, { confirm: "yes", next: "new_times" })).headers.get("location")).toBe(`/c/schedule/${token}/cancelled`);
      await container.drain();
      const f = await followUpOf(cand.id);
      expect(f).toMatchObject({ choice: "new_times", autoState: "none", autoReason: "no_hours", autoDueAt: null, resolvedAt: null });
      expect((await container.db.select().from(workflowRuns).where(and(eq(workflowRuns.workflowKey, "interview_new_times"), sql`${workflowRuns.subject}->>'id' = ${cand.id}`)))).toHaveLength(0);
      expect((await noticesAbout("interview.cancelled", "Fay Reed"))[0].body).toBe("They asked for new times. Set a new date and time from their page.");
      expect(await (await app.request(`/c/schedule/${token}/cancelled`)).text()).toContain("Someone from the team will be in touch about them.");
      const cancelMail = mailTo(cand.email).find((m) => m.subject.startsWith("Cancelled:"))!;
      expect(cancelMail.text).toContain("You asked for new times, so someone from the team will be in touch about them.");
      // the panel's reason, and "Send new times", which cannot work with nobody's hours: one person, and many at once
      const panel = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { ownerStage: string; cancelled: { auto: { reasonText: string }; noHours?: boolean }; allowedActions: string[]; blockedReasons: Record<string, string> };
      expect(panel.ownerStage).toBe("cancelled");
      expect(panel.cancelled.auto.reasonText).toBe("Not everyone on the interview has hours to offer, so nothing goes automatically: set a date and time from their page.");
      // the panel and the Interviews page are told, so neither offers "Send new times"; "Set a date and time" alone is the way on (10 November 2026)
      expect(panel.cancelled.noHours).toBe(true);
      expect(panel.allowedActions).not.toContain("send_new_times");
      expect(panel.allowedActions).toContain("interview");
      expect(panel.blockedReasons.send_new_times).toBe("Not everyone on this interview has hours to offer. Set a date and time instead.");
      const sheet = (await (await json(owner, "GET", `/api/v1/interviews/${booked.id}`)).json()) as { followUp: { reason: string; noHours?: boolean } | null };
      expect(sheet.followUp).toMatchObject({ reason: "asked_new_times", noHours: true });
      const send = await json(owner, "POST", `/api/v1/applications/${cand.id}/new-times`, {});
      expect(send.status).toBe(409);
      expect(await errorOf(send)).toMatchObject({ code: "no_hours", message: "Not everyone on this interview has hours to offer. Set a date and time instead." });
      const batch = (await (await json(owner, "POST", `/api/v1/roles/${roleId}/new-times`, { applicationIds: [cand.id] })).json()) as { sent: number; results: Array<{ code: string; message: string }> };
      expect(batch.sent).toBe(0);
      expect(batch.results[0]).toMatchObject({ code: "no_hours", message: "Not everyone on this interview has hours to offer. Set a date and time instead." });
      expect((await interview(booked.id)).status).toBe("cancelled");
      // the way on: route A, one new interview, out of Cancelled
      const before = mailTo(cand.email).length;
      const r = await routeA(cand.id, { place: { kind: "phone" } });
      expect(r.status, await r.clone().text()).toBe(201);
      const out = (await r.json()) as Booked & { followUp: unknown };
      expect(out.status).toBe("scheduled");
      expect(out.followUp).toBeNull();
      await container.drain();
      expect(await followUpOf(cand.id)).toMatchObject({ resolvedHow: "rebooked", autoState: "none", currentInterviewId: out.id });
      expect((await application(cand.id)).stage).toBe("interview_scheduled");
      const mail = mailTo(cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].text).toContain(`${companyName} has set a new time for your `);
      expect(mail[0].text).not.toContain("Good news");
    });

    it("an automatic set armed and waiting for its day: a person setting a time stops it first and then moves them, in that order, and it never goes", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      expect((await json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const { cand, id } = await approveOnly("Gil", "Reed", { interviewerUserIds: [wesId] });
      const offered = await interview(id);
      expect((await form(`/c/schedule/${offered.scheduleToken}`, { slotId: offered.offeredSlots[0].id, timezone: TZ })).status).toBe(302);
      await container.drain();
      expect((await interview(id)).status).toBe("scheduled");
      expect((await form(`/c/schedule/${offered.scheduleToken}/cancel`, { confirm: "yes", next: "new_times" })).status).toBe(302);
      await container.drain();
      const armed = await followUpOf(cand.id);
      expect(armed).toMatchObject({ autoState: "waiting", resolvedAt: null });
      // someone on it has hours: "Send new times" is offered as ever, on the panel and the Interviews page
      const panel = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { cancelled: { noHours?: boolean }; allowedActions: string[] };
      expect(panel.cancelled.noHours).toBe(false);
      expect(panel.allowedActions).toContain("send_new_times");
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${id}`)).json()) as { followUp: { noHours?: boolean } | null }).followUp?.noHours).toBe(false);
      const r = await json(wes, "POST", `/api/v1/applications/${cand.id}/interviews`, { roundKey, interviewerUserIds: [wesId], setTime: setTime() });
      expect(r.status, await r.clone().text()).toBe(201);
      const { id: newId } = (await r.json()) as Booked;
      await container.drain();
      expect(await followUpOf(cand.id)).toMatchObject({ autoState: "not_sent", autoReason: "team_acted", resolvedHow: "rebooked", currentInterviewId: newId });
      const timer = await container.db.select().from(workflowRuns).where(eq(workflowRuns.id, armed.autoRunId!));
      expect(timer[0].status).toBe("cancelled");
      // its day comes: nothing goes, nothing else is opened
      setClock(Date.parse(armed.autoDueAt!) + H);
      await container.drain();
      setClock(BASE);
      expect(mailTo(cand.email).filter((m) => /^New times/.test(m.subject))).toHaveLength(0);
      expect(await interview(id)).toMatchObject({ status: "cancelled" });
    });

    it("an automatic set being prepared with nobody's hours: route B takes the interview it reopened, and the set ends as a person's act", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      const hours = (on: boolean) => json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: on ? [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })) : [], bufferMinutes: 15, maxPerDay: 12 });
      expect((await hours(true)).status).toBe(200);
      const { cand, id } = await approveOnly("Hob", "Reed", { interviewerUserIds: [wesId] });
      const offered = await interview(id);
      expect((await form(`/c/schedule/${offered.scheduleToken}`, { slotId: offered.offeredSlots[0].id, timezone: TZ })).status).toBe(302);
      await container.drain();
      expect((await form(`/c/schedule/${offered.scheduleToken}/cancel`, { confirm: "yes", next: "new_times" })).status).toBe(302);
      await container.drain();
      const armed = await followUpOf(cand.id);
      expect(armed.autoState).toBe("waiting");
      await hours(false);
      try {
        setClock(Date.parse(armed.autoDueAt!) + H);
        await container.drain();
        expect(await followUpOf(cand.id)).toMatchObject({ autoState: "preparing", currentInterviewId: id });
        expect(await interview(id)).toMatchObject({ status: "scheduling", offeredSlots: [] });
        const r = await routeB(id, { date: zonedParts(new Date(Date.parse(armed.autoDueAt!) + 30 * DAY), TZ).dayKey, time: "11:00" }, wes);
        expect(r.status, await r.clone().text()).toBe(200);
        await container.drain();
        expect(await followUpOf(cand.id)).toMatchObject({ autoState: "not_sent", autoReason: "team_acted", resolvedHow: "rebooked" });
        expect((await interview(id)).status).toBe("scheduled");
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:") && m.text.includes("has set a new time for your"))).toHaveLength(1);
      } finally {
        setClock(BASE);
        await hours(true);
      }
    });

    it("a time a person set, cancelled with hours known: the one automatic set still comes on its day (founder decision 3A), and a pick from it is the candidate's own again", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      expect((await json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const { cand, booked, token } = await book("Kes", "Reed", {}, { interviewerUserIds: [wesId] });
      expect(await confirmedPage(token)).toMatch(/We will email you new times on /);
      expect((await form(`/c/schedule/${token}/cancel`, { confirm: "yes", next: "new_times" })).status).toBe(302);
      await container.drain();
      const armed = await followUpOf(cand.id);
      expect(armed).toMatchObject({ autoState: "waiting", resolvedAt: null });
      try {
        setClock(Date.parse(armed.autoDueAt!) + H);
        await container.drain();
        const reopened = await interview(booked.id);
        expect(reopened).toMatchObject({ status: "scheduling", selectedSlot: null, scheduleToken: token });
        expect(reopened.offeredSlots.length).toBeGreaterThan(0);
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("New times for your interview")).map((m) => m.text).join()).toContain("As you asked when you cancelled, here are new times for your");
        expect((await form(`/c/schedule/${token}`, { slotId: reopened.offeredSlots[0].id, timezone: TZ })).status).toBe(302);
        await container.drain();
        expect(await interview(booked.id)).toMatchObject({ status: "scheduled", selectedSlot: { source: reopened.offeredSlots[0].source } });
        expect(await confirmedPage(token)).toMatch(/<h1>You(&#39;|')re confirmed<\/h1>/);
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Confirmed: "))).toHaveLength(1);
        expect(await followUpOf(cand.id)).toMatchObject({ resolvedHow: "rebooked", autoState: "sent" });
      } finally {
        setClock(BASE);
      }
    });

    it("a candidate who did not come: the missed interview is settled, the new one says a new time was set; our interviewer missed it: it says sorry", async () => {
      const noShow = await book("Ira", "Reed");
      expect((await json(owner, "POST", `/api/v1/interviews/${noShow.booked.id}/outcome`, { outcome: "no_show_candidate" })).status).toBe(200);
      expect((await application(noShow.cand.id)).stage).toBe("interview_complete");
      expect((await followUpOf(noShow.cand.id)).resolvedAt).toBeNull();
      const before = mailTo(noShow.cand.email).length;
      const again = await routeA(noShow.cand.id);
      expect(again.status, await again.clone().text()).toBe(201);
      await container.drain();
      // what the Interviews page keeps about the missed one says what a person did: set a date and time, never "New times sent"
      // (the release review, 11 November 2026)
      expect(await interview(noShow.booked.id)).toMatchObject({ status: "no_show", decision: "new_times", decisionNote: "A new date and time was set after the candidate did not attend" });
      expect((await followUpOf(noShow.cand.id)).resolvedHow).toBe("rebooked");
      const mail = mailTo(noShow.cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].text).toContain("has set a new time for your");
      expect(mail[0].text).not.toMatch(/did not|missed|Good news/);

      const ours = await book("Jay", "Reed");
      expect((await json(owner, "POST", `/api/v1/interviews/${ours.booked.id}/outcome`, { outcome: "no_show_interviewer" })).status).toBe(200);
      const fresh2 = await routeA(ours.cand.id);
      expect(fresh2.status, await fresh2.clone().text()).toBe(201);
      await container.drain();
      const sorry = mailTo(ours.cand.email).at(-1)!;
      expect(sorry.text).toContain(`We are sorry: the interviewer from ${companyName} could not join your last interview for the `);
      expect(sorry.text).toContain("Here is a new time for your ");
      // founder decision L-12: the interview we missed stops asking for a decision
      expect(await interview(ours.booked.id)).toMatchObject({ status: "no_show", decision: "new_times" });
    });
  });

  describe("moving a booked time", () => {
    it("is one email saying it moved, with the team's reason; the calendar file replaces the entry (same UID, higher SEQUENCE); reminders follow the new time; the interviewers are told", async () => {
      const lea = await signInAs(container, app, { companyId, role: "hiring_manager", email: "lea@settime.test", name: "Lea Hart" });
      const leaId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "lea@settime.test")))[0].id;
      expect(lea).toBeTruthy();
      const { cand, booked, row, token } = await book("Kay", "Moore", {}, { interviewerUserIds: [ownerId, leaId] });
      const first = mailTo(cand.email).find((m) => m.subject.startsWith("Your interview:"))!;
      const before = mailTo(cand.email).length;
      const chosen = fresh();
      const r = await routeB(booked.id, { ...chosen, durationMinutes: 90, place: { kind: "address", text: "45 Elm St, Irvine" }, reason: "Lea is travelling that day." });
      expect(r.status, await r.clone().text()).toBe(200);
      const out = (await r.json()) as Booked;
      expect(out).toMatchObject({ status: "scheduled", attempt: 2, durationMinutes: 90, format: "onsite", moved: true, candidateNotice: "queued", reminders: {} });
      await container.drain();
      const moved = await interview(booked.id);
      expect(moved).toMatchObject({ status: "scheduled", attempt: 2, scheduleToken: token, selectedSlot: { address: "45 Elm St, Irvine", source: "person" } });
      expect(Date.parse(moved.startsAt!)).toBe(instant(chosen.date, chosen.time));
      // one email, not "it is off" and then "new times"
      const mail = mailTo(cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toMatch(/^New time for your interview: /);
      expect(mail[0].text).toMatch(new RegExp(`${companyName} has moved your [^.]+\\. ${companyName} said: "Lea is travelling that day\\."`));
      expect(mail[0].text).toContain("Where: 45 Elm St, Irvine");
      expect(mail[0].text).toContain("How long: 90 minutes");
      expect(mail[0].text).toContain("Need a different time?");
      expect(mail[0].text).not.toContain("We will email you new times");
      expect(mail[0].text).not.toContain("Good news");
      expect(mailTo(cand.email).some((m) => m.subject.startsWith("Your interview time has changed"))).toBe(false);
      const oldFile = icsOf(first);
      const newFile = icsOf(mail[0]);
      const uid = (s: string) => /UID:(.+)/.exec(s)![1].trim();
      const seq = (s: string) => Number(/SEQUENCE:(\d+)/.exec(s)![1]);
      expect(uid(newFile)).toBe(uid(oldFile));
      expect(seq(oldFile)).toBe(0);
      expect(seq(newFile)).toBe(2);
      expect(newFile).toContain("METHOD:REQUEST");
      expect(newFile).toContain("STATUS:CONFIRMED");
      expect(newFile).toContain("LOCATION:45 Elm St\\, Irvine");
      // the download on the page is the same newer entry
      expect(await (await app.request(`/c/schedule/${token}/ics`)).text()).toContain("SEQUENCE:2");
      // the old run stopped, so nothing it was waiting for fires at the old time
      const all = await runs(booked.id);
      expect(all.find((x) => x.idempotencyKey === `schedule:${booked.id}:1`)?.status).toBe("cancelled");
      expect(all.find((x) => x.idempotencyKey === `schedule:${booked.id}:2`)).toMatchObject({ status: "waiting", currentStep: "on_timer" });
      // the people on it are told it moved, with the new place
      expect((await noticesAbout("interview.confirmed", "Kay Moore")).filter((x) => x.title.startsWith("Interview moved:")).length).toBeGreaterThanOrEqual(2);
      const team = mailTo("lea@settime.test").filter((m) => m.subject.startsWith("Interview moved: Kay Moore"));
      expect(team).toHaveLength(1);
      expect(team[0].text).toContain("Where: 45 Elm St, Irvine");
      expect((await eventsOf(booked.id, "interview.rescheduled")).at(-1)?.payload).toMatchObject({ setByPerson: true, wasBooked: true, moved: true, reason: "Lea is travelling that day.", attempt: 2 });
      // the old time's reminders never come: the clock passes where they would have been
      const oldStart = Date.parse(row.startsAt!);
      setClock(oldStart - 23 * H);
      await container.drain();
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Tomorrow:"))).toHaveLength(0);
      // the new time's do, on its own moments, with its own place
      setClock(instant(chosen.date, chosen.time) - 23 * H);
      await container.drain();
      const tomorrow = mailTo(cand.email).filter((m) => m.subject.startsWith("Tomorrow:"));
      expect(tomorrow).toHaveLength(1);
      expect(tomorrow[0].text).toContain("Your interview is tomorrow.");
      expect(tomorrow[0].text).toContain("Where: 45 Elm St, Irvine");
      setClock(BASE);
    });

    it("the same time and place pressed again changes nothing and emails nobody twice; a change of place alone is a change", async () => {
      const chosen = { ...fresh(), durationMinutes: 30, place: { kind: "address", text: "12 Main St, Tustin" } };
      const { cand, booked } = await book("Mya", "Moore", chosen);
      const first = mailTo(cand.email).length;
      const again = await routeB(booked.id, chosen);
      expect(again.status, await again.clone().text()).toBe(200);
      // the answer says nothing changed and promises no email (the release review, 11 November 2026: it said the email was on
      // its way); a reason typed with the same time changes nothing either
      const same = (await again.json()) as Booked & { unchanged?: boolean };
      expect(same).toMatchObject({ attempt: 1, moved: false, status: "scheduled", unchanged: true });
      expect(same.candidateNotice ?? null).toBeNull();
      const withReason = (await (await routeB(booked.id, { ...chosen, reason: "Did the first email arrive?" })).json()) as Booked & { unchanged?: boolean };
      expect(withReason).toMatchObject({ attempt: 1, unchanged: true });
      expect(withReason.candidateNotice ?? null).toBeNull();
      await container.drain();
      expect(mailTo(cand.email)).toHaveLength(first);
      expect((await runs(booked.id)).filter((x) => x.status === "cancelled")).toHaveLength(0);
      // a change of place alone is a change, at the same time: the email says the details changed, never that it moved (L4-3)
      const elsewhere = await routeB(booked.id, { ...chosen, place: { kind: "address", text: "45 Elm St, Irvine" } });
      expect(((await elsewhere.json()) as Booked)).toMatchObject({ attempt: 2, moved: false, changed: true });
      await container.drain();
      const updated = mailTo(cand.email).at(-1)!;
      expect(updated.subject).toMatch(/^Your interview has changed: /);
      expect(updated.text).toMatch(new RegExp(`${companyName} has changed the details of your [^.]+\\.`));
      expect(updated.text).not.toMatch(/has moved your|New time/);
      expect(updated.text).toContain("Where: 45 Elm St, Irvine");
      expect(updated.text).toContain("Need a different time?");
    });

    /**
     * The release review (11 November 2026, L4-3): the video link pasted later, at the same day and time, emailed "New time for
     * your interview: ..." and "Harbor Dental has moved your ...", so the candidate could not tell whether it moved, and the
     * interviewers were told "Interview moved".
     */
    it("the same day and time with a new link or a longer slot is an update: never 'New time for your interview' or 'has moved', and the interviewers hear 'Interview updated'", async () => {
      const chosen = { ...fresh(), durationMinutes: 30, place: { kind: "link" } };
      const { cand, booked, token } = await book("Ola", "Moore", chosen);
      const first = mailTo(cand.email).find((m) => m.subject.startsWith("Your interview:"))!;
      expect(first.text).not.toContain("Join:");
      const before = mailTo(cand.email).length;
      const linked = await routeB(booked.id, { ...chosen, place: { kind: "link", url: "https://meet.example/ola" }, reason: "Here is the video link." });
      expect(linked.status, await linked.clone().text()).toBe(200);
      expect((await linked.json()) as Booked).toMatchObject({ attempt: 2, moved: false, changed: true, candidateNotice: "queued" });
      await container.drain();
      const mail = mailTo(cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toMatch(/^Your interview has changed: /);
      expect(mail[0].text).toMatch(new RegExp(`${companyName} has changed the details of your [^.]+\\. ${companyName} said: "Here is the video link\\."`));
      expect(mail[0].text).toContain("Join: https://meet.example/ola");
      expect(mail[0].text).not.toMatch(/has moved your|New time for your interview/);
      // the calendar file replaces the entry in place, as for a move
      expect(/UID:(.+)/.exec(icsOf(mail[0]))![1].trim()).toBe(/UID:(.+)/.exec(icsOf(first))![1].trim());
      expect(Number(/SEQUENCE:(\d+)/.exec(icsOf(mail[0]))![1])).toBe(2);
      // the interviewers: updated, not moved
      expect((await noticesAbout("interview.confirmed", "Ola Moore")).filter((x) => x.title.startsWith("Interview updated:")).length).toBeGreaterThanOrEqual(1);
      expect((await noticesAbout("interview.confirmed", "Ola Moore")).some((x) => x.title.startsWith("Interview moved:"))).toBe(false);
      expect(mailTo("owner@settime.test").filter((m) => m.subject.startsWith("Interview updated: Ola Moore"))).toHaveLength(1);
      expect((await eventsOf(booked.id, "interview.rescheduled")).at(-1)?.payload).toMatchObject({ setByPerson: true, wasBooked: true, moved: false, changed: true });
      // a longer slot at the same start: an update too
      const longer = await routeB(booked.id, { ...chosen, durationMinutes: 45, place: { kind: "link", url: "https://meet.example/ola" } });
      expect((await longer.json()) as Booked).toMatchObject({ attempt: 3, moved: false, changed: true, durationMinutes: 45 });
      await container.drain();
      expect(mailTo(cand.email).at(-1)!.subject).toMatch(/^Your interview has changed: /);
      expect(mailTo(cand.email).at(-1)!.text).toContain("How long: 45 minutes");
      // and the page their link opens still shows the one booked time
      expect(await confirmedPage(token)).toContain("Your interview is booked");
    });

    it("with no reason given, it says only that it moved; the same person can be moved again", async () => {
      const { cand, booked } = await book("Lex", "Moore");
      expect((await routeB(booked.id)).status).toBe(200);
      await container.drain();
      const once = mailTo(cand.email).at(-1)!;
      expect(once.subject).toMatch(/^New time for your interview: /);
      expect(once.text).not.toContain("said:");
      expect((await routeB(booked.id)).status).toBe(200);
      await container.drain();
      const twice = mailTo(cand.email).at(-1)!;
      expect(Number(/SEQUENCE:(\d+)/.exec(icsOf(twice))![1])).toBe(4);
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("New time for your interview:"))).toHaveLength(2);
    });
  });

  describe("calling a time off", () => {
    it("told of it: one cancellation with the calendar file that takes it out, the sheet's answer says it went, they go back to Interview to set up, and the old link says it is off", async () => {
      const { cand, booked, token } = await book("Ana", "Off");
      const before = mailTo(cand.email).length;
      const r = await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "The interviewer is out this week." });
      expect(r.status, await r.clone().text()).toBe(200);
      const out = (await r.json()) as Booked & { candidateNotice?: string };
      expect(out).toMatchObject({ status: "cancelled", candidateTold: true, interviewersTold: true });
      expect(out.candidateNotice).toBeUndefined();
      await container.drain();
      const mail = mailTo(cand.email).slice(before);
      expect(mail).toHaveLength(1);
      expect(mail[0].subject).toMatch(/^Cancelled: /);
      expect(mail[0].text).toContain(`${companyName} had to cancel your interview`);
      const file = icsOf(mail[0]);
      expect(file).toContain("METHOD:CANCEL");
      expect(file).toContain("STATUS:CANCELLED");
      expect(file).toContain("SEQUENCE:1");
      expect(file).toContain(`UID:interview-${booked.id}@`);
      expect((await application(cand.id)).stage).toBe("interview_recommended");
      expect(await confirmedPage(token)).toContain("This interview was cancelled");
    });

    it("called off before the email left, on a confirmed company: nothing goes in either direction, and the answer does not claim it did", async () => {
      const cand = await apply("Pam", "Off");
      const before = mailTo(cand.email).length;
      const id = await withWorkerStopped(async () => {
        const r = await routeA(cand.id);
        expect(r.status, await r.clone().text()).toBe(201);
        const { id: bookedId } = (await r.json()) as Booked;
        const off = await json(owner, "POST", `/api/v1/interviews/${bookedId}/cancel`, { reason: "We changed our minds." });
        expect(off.status, await off.clone().text()).toBe(200);
        const out = (await off.json()) as { candidateTold: boolean; interviewersTold: boolean; candidateNotice?: string };
        expect(out).toMatchObject({ candidateTold: false, interviewersTold: true });
        expect(out.candidateNotice).toBeUndefined();
        return bookedId;
      });
      await container.drain();
      expect(mailTo(cand.email)).toHaveLength(before);
      expect(await emailOf(`confirm:${id}:1`)).toBeUndefined();
      expect(await emailOf(`iv_cancel:${id}:1`)).toBeUndefined();
      expect((await eventsOf(id, "interview.cancelled"))[0].payload).toMatchObject({ candidateTold: false, neverHeard: true });
      expect(await interview(id)).toMatchObject({ status: "cancelled" });
    });

    it("an email that could not be delivered never told them either; no email on file is the same", async () => {
      const bounced = await book("Rod", "Off");
      await container.db.update(communications).set({ status: "failed", error: "provider refused" }).where(eq(communications.idempotencyKey, `confirm:${bounced.booked.id}:1`));
      const a = await json(owner, "POST", `/api/v1/interviews/${bounced.booked.id}/cancel`, { reason: "A clash at our end." });
      expect(await a.json()).toMatchObject({ candidateTold: false });
      await container.drain();
      expect(await emailOf(`iv_cancel:${bounced.booked.id}:1`)).toBeUndefined();

      const nobody = await apply("Sal", "Off");
      await withPlatform(container.db, (tx) => tx.update(candidates).set({ email: null }).where(eq(candidates.id, nobody.candidateId)));
      const set = await routeA(nobody.id);
      expect(set.status, await set.clone().text()).toBe(201);
      const { id } = (await set.json()) as Booked;
      await container.drain();
      const b = await json(owner, "POST", `/api/v1/interviews/${id}/cancel`, { reason: "A clash at our end." });
      expect(await b.json()).toMatchObject({ candidateTold: false });
    });

    it("a decline while the email has not left: no note, the toast's count says none, and the decision message never names an interview they never heard of", async () => {
      const cand = await apply("Sue", "Off");
      await withWorkerStopped(async () => {
        expect((await routeA(cand.id)).status).toBe(201);
        const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/actions`, { action: "reject", reason: "not_a_match_experience", note: "Wants a front-desk role." });
        expect(r.status, await r.clone().text()).toBe(200);
        expect(await r.json()).toMatchObject({ stage: "rejected", candidateNotice: "not_told", interviewsCancelled: 1, interviewOffNotes: 0 });
      });
      await container.drain();
      expect(mailTo(cand.email).filter((m) => /^(Your interview|Cancelled):/.test(m.subject))).toHaveLength(0);
      const row = await application(cand.id);
      expect(await withTenant(container.db, companyId, (tx) => interviewsCalledOff(tx, row, container.engine.clock()))).toEqual([]);
    });

    /**
     * The release review (11 November 2026, L2-1): the decline and "Record what happened" steps promised "a short note saying
     * so" from a booking alone, while the cancellation tells only someone an email about it reached. The panel and the
     * Interviews sheet read `candidateHeard`, worked out the way the cancellation works it out.
     */
    it("the panel and the Interviews sheet say whether an email about the interview reached them (candidateHeard), as the cancellation decides", async () => {
      const heardOn = async (applicationId: string, interviewId: string) => {
        const detail = (await (await json(owner, "GET", `/api/v1/applications/${applicationId}`)).json()) as { interviews: Array<{ id: string; candidateHeard?: boolean }> };
        const sheet = (await (await json(owner, "GET", `/api/v1/interviews/${interviewId}`)).json()) as { candidateHeard?: boolean };
        return { panel: detail.interviews.find((i) => i.id === interviewId)?.candidateHeard, sheet: sheet.candidateHeard };
      };
      // the worker has not sent it yet
      const waiting = await apply("Una", "Heard");
      await withWorkerStopped(async () => {
        const r = await routeA(waiting.id);
        expect(r.status, await r.clone().text()).toBe(201);
        const { id } = (await r.json()) as Booked;
        expect(await heardOn(waiting.id, id)).toEqual({ panel: false, sheet: false });
      });
      // it left: they heard of it
      const { cand, booked } = await book("Vic", "Heard");
      expect(await heardOn(cand.id, booked.id)).toEqual({ panel: true, sheet: true });
      // it could not be delivered: never heard
      await container.db.update(communications).set({ status: "failed", error: "provider refused" }).where(eq(communications.idempotencyKey, `confirm:${booked.id}:1`));
      expect(await heardOn(cand.id, booked.id)).toEqual({ panel: false, sheet: false });
    });

    /**
     * The release review's second reading (11 November 2026, S-2): an email that bounced came back, so it told them nothing.
     * Bea's address has a typo and the confirmation hard-bounces: the panel says it could not be delivered, and the decline step
     * promised "a short note saying so" to an address that takes nothing. A soft bounce is tried again after four hours: once a
     * retry arrives they have heard of it, and a time called off before that is one they never heard of, so the retry of its
     * confirmation never goes either (it would be the only word they got, about an interview that is off).
     */
    it("a confirmation that bounced told them nothing: no note promised or written, the panel says so; a retry that arrived did tell them, and one still to come never goes once it is off", async () => {
      const bounce = (providerMessageId: string, email: string, hard: boolean) => withPlatform(container.db, (tx) => handleEmailEvent(tx, container.integrations, { event: { provider: "postmark", recordType: "Bounce", externalId: `Bounce:${providerMessageId}`, messageId: providerMessageId, email, type: hard ? "HardBounce" : "SoftBounce", description: hard ? "The mailbox does not exist." : "The mailbox is full.", at: container.engine.clock().toISOString(), hard, complaint: false, soft: !hard, metadata: {} }, appBaseUrl: "http://localhost:3000", now: container.engine.clock() }));
      const seen = async (applicationId: string, interviewId: string) => {
        const detail = (await (await json(owner, "GET", `/api/v1/applications/${applicationId}`)).json()) as { interviews: Array<{ id: string; candidateHeard?: boolean; candidateEmail: string | null }> };
        const sheet = (await (await json(owner, "GET", `/api/v1/interviews/${interviewId}`)).json()) as { candidateHeard?: boolean; candidateEmail: string | null };
        const row = detail.interviews.find((i) => i.id === interviewId);
        return { heard: row?.candidateHeard, email: row?.candidateEmail, sheetHeard: sheet.candidateHeard, sheetEmail: sheet.candidateEmail };
      };

      // a typo in the address: the confirmation hard-bounces, and the address takes nothing more
      const typo = await book("Bea", "Bounce");
      const confirm = await emailOf(`confirm:${typo.booked.id}:1`);
      expect(confirm.status).toBe("sent");
      await bounce(confirm.providerMessageId!, typo.cand.email, true);
      expect(await seen(typo.cand.id, typo.booked.id)).toEqual({ heard: false, email: "failed", sheetHeard: false, sheetEmail: "failed" });
      // Not moving forward: no note is written to it, and none is counted
      const before = mailTo(typo.cand.email).length;
      const declined = await json(owner, "POST", `/api/v1/applications/${typo.cand.id}/actions`, { action: "reject", reason: "not_a_match_experience" });
      expect(declined.status, await declined.clone().text()).toBe(200);
      expect(await declined.json()).toMatchObject({ interviewsCancelled: 1, interviewOffNotes: 0 });
      await container.drain();
      expect(await emailOf(`iv_cancel:${typo.booked.id}:1`)).toBeUndefined();
      expect(mailTo(typo.cand.email)).toHaveLength(before);
      expect((await eventsOf(typo.booked.id, "interview.cancelled"))[0].payload).toMatchObject({ candidateTold: false, neverHeard: true });

      // a full mailbox: a soft bounce, tried again after four hours; the retry arrives, so they heard of it after all
      const full = await book("Cal", "Bounce");
      const fullConfirm = await emailOf(`confirm:${full.booked.id}:1`);
      await bounce(fullConfirm.providerMessageId!, full.cand.email, false);
      expect(await seen(full.cand.id, full.booked.id)).toEqual({ heard: false, email: "failed", sheetHeard: false, sheetEmail: "failed" });
      setClock(BASE + 5 * H);
      try {
        await container.drain();
      } finally {
        setClock(BASE);
      }
      const [fullRetry] = await container.db.select().from(communications).where(eq(communications.retryOf, fullConfirm.id));
      expect(fullRetry?.status).toBe("sent");
      expect(await seen(full.cand.id, full.booked.id)).toEqual({ heard: true, email: null, sheetHeard: true, sheetEmail: null });
      const fullOff = await json(owner, "POST", `/api/v1/interviews/${full.booked.id}/cancel`, { reason: "A clash at our end." });
      expect(await fullOff.json()).toMatchObject({ candidateTold: true });

      // called off while the retry still waits: nothing about it reached them, so no note, and the retry never goes
      const late = await book("Dot", "Bounce");
      const lateConfirm = await emailOf(`confirm:${late.booked.id}:1`);
      await bounce(lateConfirm.providerMessageId!, late.cand.email, false);
      const lateOff = await json(owner, "POST", `/api/v1/interviews/${late.booked.id}/cancel`, { reason: "A clash at our end." });
      expect(await lateOff.json()).toMatchObject({ candidateTold: false });
      const sentBefore = mailTo(late.cand.email).length;
      setClock(BASE + 5 * H);
      try {
        await container.drain();
      } finally {
        setClock(BASE);
      }
      expect(await emailOf(`iv_cancel:${late.booked.id}:1`)).toBeUndefined();
      const [lateRetry] = await container.db.select().from(communications).where(eq(communications.retryOf, lateConfirm.id));
      expect(lateRetry).toMatchObject({ status: "cancelled", error: INTERVIEW_CHANGED_SINCE });
      expect(mailTo(late.cand.email)).toHaveLength(sentBefore);
    });

    it("told of it and then declined: the short note goes, and the decision message leaves it out as before", async () => {
      const { cand, booked } = await book("Tom", "Off");
      const before = mailTo(cand.email).length;
      const r = await json(owner, "POST", `/api/v1/applications/${cand.id}/actions`, { action: "reject", reason: "not_a_match_experience" });
      expect(await r.json()).toMatchObject({ interviewsCancelled: 1, interviewOffNotes: 1 });
      await container.drain();
      expect(mailTo(cand.email).slice(before).map((m) => m.subject)).toEqual([expect.stringMatching(/^Cancelled: /)]);
      expect((await eventsOf(booked.id, "interview.cancelled"))[0].payload).toMatchObject({ candidateTold: true });
      const row = await application(cand.id);
      expect(await withTenant(container.db, companyId, (tx) => interviewsCalledOff(tx, row, container.engine.clock()))).toEqual([]);
    });
  });

  describe("reminders", () => {
    it("a time set for this afternoon never says tomorrow: past moments are skipped, the one still ahead goes, and it closes after the end", async () => {
      const at = new Date(BASE + 3 * H);
      const today = zonedParts(at, TZ);
      const cand = await apply("Mel", "Soon");
      const r = await routeA(cand.id, { date: today.dayKey, time: `${String(today.hour).padStart(2, "0")}:00`, durationMinutes: 30 });
      expect(r.status, await r.clone().text()).toBe(201);
      const { id } = (await r.json()) as Booked;
      await container.drain();
      const row = await interview(id);
      expect(row.reminders.before24h).toBe("skipped");
      expect(row.reminders.before2h).toBeUndefined();
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Tomorrow:"))).toHaveLength(0);
      expect(mailTo(cand.email).filter((m) => m.text.includes("is tomorrow"))).toHaveLength(0);
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(1);
      // two hours before: the place comes along with it
      setClock(Date.parse(row.startsAt!) - 2 * H + 60_000);
      await container.drain();
      const soon = mailTo(cand.email).filter((m) => m.subject.startsWith("Soon:"));
      expect(soon).toHaveLength(1);
      expect(soon[0].text).toContain("Your interview starts in about two hours.");
      expect(soon[0].text).toContain("Join: https://meet.example/room");
      // after the end: "Did it take place?" and "How did it go?", as for every interview
      setClock(Date.parse(row.endsAt!) + 2 * H);
      await container.drain();
      expect((await interview(id)).status).toBe("completed");
      expect((await application(cand.id)).stage).toBe("interview_complete");
      expect((await noticesAbout("interview.decision", "Mel Soon")).length).toBeGreaterThan(0);
      expect((await noticesAbout("interview.outcome", "Mel Soon")).length).toBeGreaterThan(0);
      setClock(BASE);
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Tomorrow:"))).toHaveLength(0);
      // and on to the decision, as the hire goes
      const dec = await json(owner, "POST", `/api/v1/applications/${cand.id}/decision`, { decision: "finalist", note: "Strong." });
      expect(dec.status, await dec.clone().text()).toBe(200);
      expect(((await dec.json()) as { stage: string }).stage).toBe("finalist");
    });

    it("a time set for within the hour gets no reminder at all; one set for twenty hours ahead gets no 'tomorrow', only the two-hour one", async () => {
      const inside = new Date(BASE + 40 * 60_000);
      const p = zonedParts(inside, TZ);
      const quick = await apply("Noa", "Soon");
      const r = await routeA(quick.id, { date: p.dayKey, time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`, durationMinutes: 15 });
      expect(r.status, await r.clone().text()).toBe(201);
      const { id } = (await r.json()) as Booked;
      await container.drain();
      expect((await interview(id)).reminders).toMatchObject({ before24h: "skipped", before2h: "skipped" });
      expect(mailTo(quick.email).filter((m) => /^(Tomorrow|Soon):/.test(m.subject))).toHaveLength(0);
      expect(mailTo(quick.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(1);

      const nextMorning = new Date(BASE + 20 * H);
      const q = zonedParts(nextMorning, TZ);
      const later = await apply("Oli", "Soon");
      const s = await routeA(later.id, { date: q.dayKey, time: `${String(q.hour).padStart(2, "0")}:00` });
      expect(s.status, await s.clone().text()).toBe(201);
      const { id: laterId } = (await s.json()) as Booked;
      await container.drain();
      const row = await interview(laterId);
      expect(row.reminders.before24h).toBe("skipped");
      setClock(Date.parse(row.startsAt!) - 2 * H + 60_000);
      await container.drain();
      expect(mailTo(later.email).filter((m) => m.subject.startsWith("Tomorrow:"))).toHaveLength(0);
      expect(mailTo(later.email).filter((m) => m.subject.startsWith("Soon:"))).toHaveLength(1);
      setClock(BASE);
    });

    it("a time days ahead gets both, on their own moments", async () => {
      const chosen = { date: dayIn(6), time: "10:00" };
      const { cand, booked } = await book("Pat", "Soon", chosen);
      setClock(instant(chosen.date, chosen.time) - 23 * H);
      await container.drain();
      const tomorrow = mailTo(cand.email).filter((m) => m.subject.startsWith("Tomorrow:"));
      expect(tomorrow).toHaveLength(1);
      expect(tomorrow[0].text).toContain("Your interview is tomorrow.");
      setClock(instant(chosen.date, chosen.time) - 1.5 * H);
      await container.drain();
      expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Soon:"))).toHaveLength(1);
      const row = await interview(booked.id);
      expect(row.reminders.before24h).not.toBe("skipped");
      expect(row.reminders.before2h).not.toBe("skipped");
      setClock(BASE);
      expect((await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "test cleanup" })).status).toBe(200);
      await container.drain();
    });
  });

  describe("the candidate's page", () => {
    it("says booked, not confirmed, with the place, the calendar file, the accommodation field, the time zone and the HUMAN notice", async () => {
      const { token } = await book("Rio", "West");
      const html = await confirmedPage(token);
      expect(html).toContain("<h1>Your interview is booked</h1>");
      expect(html).not.toMatch(/You(&#39;|')re confirmed/);
      expect(html).toContain("Add to my calendar");
      expect(html).toContain('<summary>Change the time zone</summary>');
      expect(html).toContain(`action="/c/schedule/${token}/timezone"`);
      expect(html).toContain(`action="/c/schedule/${token}/accommodation"`);
      expect(html).toContain('<label for="access" class="flush">Anything that would make the interview easier for you? (optional)</label>');
      expect(html).toContain('name="accessibilityNote"');
      expect(html).toContain('<p class="notice">Reply to any of our emails with HUMAN to reach a person. Nothing here is decided by software.</p>');
      expect(html).toContain("<h2>Need a different time?</h2>");
      expect(html).toContain('<label for="suits">What suits you better? (optional)</label>');
      expect(html).toContain("We will tell the team. This time stands until you hear from them.");
      expect(html).not.toContain("We will send new times");
      expect(html).toContain("I need to cancel");
      expect(html).not.toMatch(/<script|style="/);
    });

    it("the old path's page keeps its words and gains the accommodation field, the time zone and the notice; its email gains the accommodation line", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      expect((await json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const { cand, id } = await approveOnly("Sol", "West", { interviewerUserIds: [wesId] });
      const offered = await interview(id);
      expect((await form(`/c/schedule/${offered.scheduleToken}`, { slotId: offered.offeredSlots[0].id, timezone: TZ })).status).toBe(302);
      await container.drain();
      const html = await confirmedPage(offered.scheduleToken!);
      expect(html).toMatch(/<h1>You(&#39;|')re confirmed<\/h1>/);
      expect(html).toContain("We will send new times. You can do this twice.");
      expect(html).toContain('name="accessibilityNote"');
      expect(html).toContain("<summary>Change the time zone</summary>");
      expect(html).toContain("Reply to any of our emails with HUMAN to reach a person.");
      const mail = mailTo(cand.email).find((m) => m.subject.startsWith("Confirmed:"))!;
      expect(mail.text).toContain("You are confirmed:");
      expect(mail.text).toContain("Need an adjustment, such as captions or a phone call instead of video? Tell us on the same page, or reply to this email.");
      expect(mail.text).toContain("lets you reschedule or cancel.");
    });

    it("every email carries the accommodation line, the AI disclosure and the way to a person", async () => {
      const { cand, booked } = await book("Tia", "West");
      expect((await routeB(booked.id, { reason: "A clash at our end." })).status).toBe(200);
      await container.drain();
      const mails = mailTo(cand.email).filter((m) => /^(Your interview|New time for your interview):/.test(m.subject));
      expect(mails).toHaveLength(2);
      const role = (await (await json(owner, "GET", `/api/v1/roles/${roleId}`)).json()) as { currentPacket: { packet: { communication: { humanAlternativeText: string; disclosureText: string } } } };
      for (const m of mails) {
        expect(m.text).toContain("Need an adjustment, such as captions or a phone call instead of video? Tell us on the same page, or reply to this email.");
        expect(m.text).toContain(role.currentPacket.packet.communication.humanAlternativeText);
        expect(m.text).toContain(role.currentPacket.packet.communication.disclosureText);
      }
      expect(role.currentPacket.packet.communication.humanAlternativeText).toMatch(/HUMAN/);
    });

    it("an accommodation goes to the team at once and shows when they come back; empty or unchanged says nothing new; a long note is cut", async () => {
      const { booked, token } = await book("Uri", "West");
      const none = await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "   " });
      expect(none.headers.get("location")).toBe(`/c/schedule/${token}/confirmed`);
      expect(await noticesAbout("interview.accessibility", "Uri asked")).toHaveLength(0);
      const r = await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "Captions on, please." });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`/c/schedule/${token}/confirmed?noted=1`);
      await container.drain();
      const notes = await noticesAbout("interview.accessibility", "Uri asked for an accommodation");
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]).toMatchObject({ body: "Captions on, please.", action: { label: "Open the interview", href: `/interviews/${booked.id}` } });
      const row = await interview(booked.id);
      expect(row.candidateAvailability).toMatchObject({ accessibilityNote: "Captions on, please.", timezone: TZ });
      expect(row.status).toBe("scheduled");
      // the sheet reads it
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${booked.id}`)).json()) as { candidateAvailability: { accessibilityNote: string } }).candidateAvailability.accessibilityNote).toBe("Captions on, please.");
      const page = await confirmedPage(token, "?noted=1");
      expect(page).toContain('<strong>We told the team.</strong>');
      expect(page).toContain('value="Captions on, please."');
      const count = notes.length;
      await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "Captions on, please." });
      expect(await noticesAbout("interview.accessibility", "Uri asked for an accommodation")).toHaveLength(count);
      await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "x".repeat(900) });
      expect((await interview(booked.id)).candidateAvailability?.accessibilityNote).toHaveLength(500);
    });

    it("saying none of the times work keeps an accommodation they asked for earlier", async () => {
      const { booked, token } = await book("Quo", "West");
      await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "Captions on, please." });
      await container.db.update(interviews).set({ status: "scheduling" }).where(eq(interviews.id, booked.id));
      expect((await form(`/c/schedule/${token}/none-work`, { note: "Mornings suit me better." })).status).toBe(200);
      expect((await interview(booked.id)).candidateAvailability).toMatchObject({ accessibilityNote: "Captions on, please.", note: "Mornings suit me better." });
    });

    it("a deletion at their request takes what they told us about a time with it, and calls the booked time off", async () => {
      const { cand, booked, token } = await book("Uma", "Erased");
      await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "Captions on, please." });
      await form(`/c/schedule/${token}/reschedule`, { note: "Mornings suit me better." });
      expect((await interview(booked.id)).candidateAvailability).toMatchObject({ accessibilityNote: "Captions on, please.", note: "Mornings suit me better." });
      await withTenant(container.db, companyId, (tx) => anonymizeCandidate(tx, { companyId, candidateId: cand.candidateId, actor: { kind: "system", id: "set-interview-time.test" }, deleteFile: async () => undefined, now: container.engine.clock() }));
      await container.drain();
      expect(await interview(booked.id)).toMatchObject({ status: "cancelled", candidateAvailability: null });
      expect((await application(cand.id)).stage).toBe("withdrawn");
    });

    it("the time zone they save is used by the page and by later reminders; one that does not exist is ignored; the email already sent named the company's", async () => {
      const chosen = { date: dayIn(7), time: "10:00" };
      const { cand, booked, token } = await book("Vic", "West", chosen);
      expect(mailTo(cand.email).find((m) => m.subject.startsWith("Your interview:"))!.text).toMatch(/When: .* P[DS]T\n/);
      const bad = await form(`/c/schedule/${token}/timezone`, { timezone: "Mars/Olympus_Mons" });
      expect(bad.headers.get("location")).toBe(`/c/schedule/${token}/confirmed`);
      expect((await interview(booked.id)).schedulingWindow.candidateTimezone).toBeUndefined();
      const good = await form(`/c/schedule/${token}/timezone`, { timezone: "America/New_York" });
      expect(good.headers.get("location")).toBe(`/c/schedule/${token}/confirmed`);
      expect((await interview(booked.id)).schedulingWindow.candidateTimezone).toBe("America/New_York");
      const page = await confirmedPage(token);
      expect(page).toMatch(/E[DS]T/);
      expect(page).toContain("<span>For the team</span>");
      setClock(instant(chosen.date, chosen.time) - 23 * H);
      await container.drain();
      setClock(BASE);
      expect(mailTo(cand.email).find((m) => m.subject.startsWith("Tomorrow:"))!.text).toMatch(/E[DS]T/);
      await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "test cleanup" });
      await container.drain();
    });

    /**
     * The release review (11 November 2026, L4-4): before the hiring build a re-offer after a cancel reopened the same row, so
     * what the candidate told us stayed. A person now sets a new date and time as a new interview, which started empty: the
     * sheet showed no accommodation, the new booked page's field was blank, and their zone and note were gone.
     */
    it("what they told us carries to the interview a person books after they cancel: the accommodation, their zone and their note", async () => {
      const { cand, booked, token } = await book("Yara", "West");
      await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "Captions on, please." });
      await form(`/c/schedule/${token}/timezone`, { timezone: "America/New_York" });
      await form(`/c/schedule/${token}/reschedule`, { note: "Mornings suit me better." });
      expect((await form(`/c/schedule/${token}/cancel`, { confirm: "yes", next: "new_times" })).status).toBe(302);
      await container.drain();
      expect((await interview(booked.id)).status).toBe("cancelled");
      // a person sets a new date and time from their Cancelled card: a new interview
      const again = await routeA(cand.id);
      expect(again.status, await again.clone().text()).toBe(201);
      const next = (await again.json()) as Booked;
      expect(next.id).not.toBe(booked.id);
      await container.drain();
      const row = await interview(next.id);
      expect(row.candidateAvailability).toMatchObject({ accessibilityNote: "Captions on, please.", note: "Mornings suit me better." });
      expect(row.schedulingWindow.candidateTimezone).toBe("America/New_York");
      // the sheet reads it, and their new booked page shows it filled in, in their own zone
      const sheet = (await (await json(owner, "GET", `/api/v1/interviews/${next.id}`)).json()) as { candidateAvailability: { accessibilityNote: string; note: string } };
      expect(sheet.candidateAvailability).toMatchObject({ accessibilityNote: "Captions on, please.", note: "Mornings suit me better." });
      const page = await confirmedPage(row.scheduleToken!);
      expect(page).toContain('value="Captions on, please."');
      expect(page).toMatch(/E[DS]T/);
      // an interview booked for someone who never told us anything starts empty, as before
      const other = await book("Zed", "West");
      expect((await interview(other.booked.id)).candidateAvailability).toBeNull();
      for (const id of [next.id, other.booked.id]) await json(owner, "POST", `/api/v1/interviews/${id}/cancel`, { reason: "test cleanup" });
      await container.drain();
    });

    it("asking for a different time leaves the time standing and tells the team; twice, then a person; a move answers it; the candidate's cancel is unchanged", async () => {
      const { cand, booked, row, token } = await book("Wes", "Asker");
      const before = mailTo(cand.email).length;
      const r = await form(`/c/schedule/${token}/reschedule`, { note: "Mornings next week suit me better." });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe(`/c/schedule/${token}/confirmed?asked=1`);
      await container.drain();
      // nothing moved: not the time, not the attempt, not the stage, not the link, not the run
      const after = await interview(booked.id);
      expect(after).toMatchObject({ status: "scheduled", attempt: row.attempt, scheduleToken: token, rescheduleCountCandidate: 1, selectedSlot: row.selectedSlot });
      expect(Date.parse(after.startsAt!)).toBe(Date.parse(row.startsAt!));
      expect(after.candidateAvailability).toMatchObject({ note: "Mornings next week suit me better." });
      expect((await application(cand.id)).stage).toBe("interview_scheduled");
      expect((await runs(booked.id)).filter((x) => x.status === "waiting")).toHaveLength(1);
      expect(mailTo(cand.email).slice(before)).toHaveLength(0);
      // the team hears, with their words and the way on
      const notes = await noticesAbout("interview.rescheduled", "Wes Asker asked for a different time");
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0]).toMatchObject({ title: "Wes Asker asked for a different time", body: "Mornings next week suit me better.", action: { label: "Set a new time", href: `/interviews/${booked.id}` } });
      expect((await eventsOf(booked.id, "interview.candidate_availability")).at(-1)?.payload).toMatchObject({ hasNote: true, askedForAnotherTime: true });
      // their page says so
      const page = await confirmedPage(token, "?asked=1");
      expect(page).toContain("<strong>We told the team.</strong><p>This time stands until you hear from them.</p>");
      expect(page).toContain("<h1>Your interview is booked</h1>");
      // the sheet reads what they wrote
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${booked.id}`)).json()) as { candidateAvailability: { note: string } }).candidateAvailability.note).toBe("Mornings next week suit me better.");
      // a second press with nothing written, then a person
      expect((await form(`/c/schedule/${token}/reschedule`)).headers.get("location")).toBe(`/c/schedule/${token}/confirmed?asked=1`);
      await container.drain();
      expect((await noticesAbout("interview.rescheduled", "Wes Asker asked for a different time")).some((n) => n.body === "The time stands until you set a new one.")).toBe(true);
      expect((await interview(booked.id)).candidateAvailability).toMatchObject({ note: "Mornings next week suit me better." });
      const third = await confirmedPage(token);
      expect(third).toContain("You have asked for a different time twice. Reply to any of our emails and a person will arrange a time with you.");
      expect(third).not.toContain('name="note"');
      // and the cancel choice says what they did, never that they moved it: the time stood both times (the release review, L4-5)
      expect(third).toContain("You have asked for a different time twice, so someone from the team will be in touch to arrange a time.");
      expect(third).not.toMatch(/You have moved this interview/);
      const last = await form(`/c/schedule/${token}/reschedule`);
      expect(last.headers.get("location")).toBe(`/c/schedule/${token}/confirmed`);
      expect((await interview(booked.id)).rescheduleCountCandidate).toBe(2);
      expect((await noticesAbout("interview.reschedule_limit", "Wes wants to reschedule again")).length).toBeGreaterThan(0);
      // the person sets a new time from the notice: one email, and the same page
      expect((await routeB(booked.id)).status).toBe(200);
      await container.drain();
      expect(mailTo(cand.email).at(-1)!.subject).toMatch(/^New time for your interview: /);
      // cancelling still cancels
      expect((await form(`/c/schedule/${token}/cancel`, { confirm: "yes", next: "not_interested" })).headers.get("location")).toBe(`/c/schedule/${token}/cancelled`);
      await container.drain();
      expect(await interview(booked.id)).toMatchObject({ status: "cancelled" });
      expect((await application(cand.id)).stage).toBe("interview_recommended");
      expect(await followUpOf(cand.id)).toMatchObject({ choice: "not_interested", resolvedAt: null });
    });

    it("once it has started, or for someone no longer in the process, none of it changes anything; a token that does not exist is a plain 404", async () => {
      const { booked, row, token } = await book("Xan", "West");
      setClock(Date.parse(row.startsAt!) + 5 * 60_000);
      expect((await form(`/c/schedule/${token}/reschedule`, { note: "Too late." })).headers.get("location")).toBe(`/c/schedule/${token}/confirmed`);
      const started = await confirmedPage(token);
      expect(started).toContain("This interview has started, so it can no longer be moved here.");
      expect(started).not.toContain(`action="/c/schedule/${token}/accommodation"`);
      expect(started).toContain("Reply to any of our emails with HUMAN to reach a person.");
      setClock(BASE);
      expect((await interview(booked.id)).rescheduleCountCandidate).toBe(0);
      for (const path of ["timezone", "accommodation", "reschedule"]) expect((await form(`/c/schedule/not-a-token/${path}`, {})).status, path).toBe(404);
      expect((await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "test cleanup" })).status).toBe(200);
      await form(`/c/schedule/${token}/accommodation`, { accessibilityNote: "Captions." });
      await form(`/c/schedule/${token}/timezone`, { timezone: "America/New_York" });
      expect(await interview(booked.id)).toMatchObject({ candidateAvailability: null });
      expect((await interview(booked.id)).schedulingWindow.candidateTimezone).toBeUndefined();
    });
  });

  describe("honest answers about the email", () => {
    it("no email on file: booked, and the answer, the sheet and the panel say to tell them; nothing retries", async () => {
      const cand = await apply("Yui", "Noemail");
      await withPlatform(container.db, (tx) => tx.update(candidates).set({ email: null }).where(eq(candidates.id, cand.candidateId)));
      const r = await routeA(cand.id);
      expect(r.status, await r.clone().text()).toBe(201);
      const out = (await r.json()) as Booked & { candidate: { hasEmail: boolean } };
      expect(out).toMatchObject({ status: "scheduled", candidateNotice: "not_sent_no_email", candidate: { hasEmail: false } });
      await container.drain();
      expect(await interview(out.id)).toMatchObject({ status: "scheduled" });
      expect((await runs(out.id))[0]).toMatchObject({ status: "waiting", currentStep: "on_timer" });
      const failed = await container.db.select().from(communications).where(and(eq(communications.applicationId, cand.id), eq(communications.templateKey, "interview_confirmation")));
      expect(failed.map((c) => c.status)).toEqual(["failed"]);
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${out.id}`)).json()) as { candidateEmail: string }).candidateEmail).toBe("no_email");
      const panel = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { interviews: Array<{ candidateEmail: string }> };
      expect(panel.interviews[0].candidateEmail).toBe("no_email");
      // moving it says the same
      const moved = (await (await routeB(out.id)).json()) as Booked;
      expect(moved).toMatchObject({ candidateNotice: "not_sent_no_email", moved: false });
    });

    it("an email that could not be delivered shows on the sheet and the panel; one on its way, or gone, says nothing", async () => {
      const { cand, booked, row } = await book("Zia", "Bounce");
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${booked.id}`)).json()) as { candidateEmail: string | null }).candidateEmail).toBeNull();
      const statusPage = async () => await (await app.request(`/c/status/${cand.statusToken}`)).text();
      expect(await statusPage()).toContain("Your interview is booked. The details are below and in your email.");
      const key = `confirm:${booked.id}:${row.attempt}`;
      expect((await emailOf(key)).status).toBe("sent");
      await container.db.update(communications).set({ status: "failed", error: "provider refused" }).where(eq(communications.idempotencyKey, key));
      expect(((await (await json(owner, "GET", `/api/v1/interviews/${booked.id}`)).json()) as { candidateEmail: string }).candidateEmail).toBe("failed");
      // their status page no longer points them to an email that never came (the release review, 11 November 2026)
      const page = await statusPage();
      expect(page).toContain("Your interview is booked. The details are below.");
      expect(page).not.toContain("and in your email");
      const panel = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { interviews: Array<{ id: string; candidateEmail: string }> };
      expect(panel.interviews.find((i) => i.id === booked.id)?.candidateEmail).toBe("failed");
      // the email that did not reach them never told them, so a move is their first time too
      const moved = (await (await routeB(booked.id)).json()) as Booked;
      expect(moved.moved).toBe(false);
    });

    it("times offered on the old path that did not reach them say so on the list, the sheet and the panel; times that did say nothing", async () => {
      // the old path needs hours: Pia has them; nobody else does
      const pia = await signInAs(container, app, { companyId, role: "hiring_manager", email: "pia@settime.test", name: "Pia Moss" });
      const piaId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "pia@settime.test")))[0].id;
      expect((await json(pia, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const states = async (cand: Applicant, id: string) => {
        const list = (await (await json(owner, "GET", "/api/v1/interviews")).json()) as Array<{ id: string; status: string; offeredSlots: unknown[]; candidateEmail: string | null }>;
        const sheet = (await (await json(owner, "GET", `/api/v1/interviews/${id}`)).json()) as { candidateEmail: string | null };
        const panel = (await (await json(owner, "GET", `/api/v1/applications/${cand.id}`)).json()) as { interviews: Array<{ id: string; candidateEmail: string | null }> };
        const row = list.find((i) => i.id === id)!;
        expect(row.status).toBe("scheduling");
        expect(row.offeredSlots.length).toBeGreaterThan(0);
        return [row.candidateEmail, sheet.candidateEmail, panel.interviews.find((i) => i.id === id)?.candidateEmail];
      };
      // who waits on whom (6 November 2026): times out, or a time booked, wait on nobody; no time, or times that reached
      // nobody, wait on a person, on the list, the panel, the compare view and Home
      const groupOf = async (applicationId: string) => {
        const rows = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/applications`)).json()) as Array<{ id: string; group: string }>;
        const panel = (await (await json(owner, "GET", `/api/v1/applications/${applicationId}`)).json()) as { group: string };
        const compare = (await (await json(owner, "GET", `/api/v1/roles/${roleId}/compare?ids=${applicationId}`)).json()) as { candidates?: Array<{ applicationId: string; group: string }> };
        const listed = rows.find((x) => x.id === applicationId)?.group;
        expect(panel.group).toBe(listed);
        if (compare.candidates) expect(compare.candidates.find((x) => x.applicationId === applicationId)?.group).toBe(listed);
        return listed;
      };
      // Home's "N candidates need your review" for this job
      const reviewCount = async () => {
        const cards = ((await (await json(owner, "GET", "/api/v1/brief")).json()) as { cards: Array<{ kind: string; title: string; roleId?: string }> }).cards;
        const card = cards.find((c) => c.kind === "needs_review" && c.roleId === roleId && /need/.test(c.title) && /your review/.test(c.title));
        return Number(/^(\d+) candidates? needs? your review/.exec(card?.title ?? "")?.[1] ?? 0);
      };
      // the times reached them: nothing to say, so the page may say "Waiting on the candidate"
      const { cand: rex, id } = await approveFor(await apply("Rex", "Offered"), { interviewerUserIds: [piaId] });
      const offered = await interview(id);
      expect((await emailOf(`slots:${id}:${offered.attempt}`)).status).toBe("sent");
      expect(await states(rex, id)).toEqual([null, null, null]);
      expect(await groupOf(rex.id)).toBe("in_process");
      const before = await reviewCount();
      // the provider refused it: never "Waiting on the candidate", and it waits on a person again, Home's card too
      await container.db.update(communications).set({ status: "failed", error: "provider refused" }).where(eq(communications.idempotencyKey, `slots:${id}:${offered.attempt}`));
      expect(await states(rex, id)).toEqual(["failed", "failed", "failed"]);
      expect(await groupOf(rex.id)).toBe("waiting_on_you");
      expect(await reviewCount()).toBe(before + 1);
      // no address on file: the times can never reach them
      const sol = await apply("Sol", "Noaddress");
      await withPlatform(container.db, (tx) => tx.update(candidates).set({ email: null }).where(eq(candidates.id, sol.candidateId)));
      const { id: solId } = await approveFor(sol, { interviewerUserIds: [piaId] });
      expect(await states(sol, solId)).toEqual(["no_email", "no_email", "no_email"]);
      expect(await groupOf(sol.id)).toBe("waiting_on_you");
      // set up with nobody's hours: no time, so it waits on a person
      const { cand: wen } = await approveOnly("Wen", "Stuck");
      expect((await interview((await container.db.select().from(interviews).where(eq(interviews.applicationId, wen.id)))[0].id)).status).toBe("proposed");
      expect(await groupOf(wen.id)).toBe("waiting_on_you");
      // a person sets the time instead: the interview is booked, and its own confirmation is what the screens read
      const r = await routeB(id);
      expect(r.status, await r.clone().text()).toBe(200);
      expect(((await r.json()) as Booked & { candidateEmail: string | null }).candidateEmail).toBeNull();
      expect(await groupOf(rex.id)).toBe("in_process");
    });
  });

  describe("a company ITS has not confirmed", () => {
    it("books, and the email waits: the answer and the sheet say so; moving it and then confirming sends only the current attempt, as a first email", async () => {
      const cand = await apply("Ada", "Held");
      await its(false);
      try {
        const r = await routeA(cand.id, { ...fresh(), place: { kind: "link", url: "https://meet.example/old" } });
        expect(r.status, await r.clone().text()).toBe(201);
        const out = (await r.json()) as Booked;
        expect(out).toMatchObject({ status: "scheduled", candidateNotice: "held" });
        await container.drain();
        expect((await emailOf(`confirm:${out.id}:1`)).status).toBe("held");
        expect(((await (await json(owner, "GET", `/api/v1/interviews/${out.id}`)).json()) as { candidateEmail: string }).candidateEmail).toBe("held");
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(0);
        // the booking stands and shows, and their status page has it, without pointing them to an email that waits for the ITS
        // check (known-bugs row 149, fixed on 11 November 2026)
        expect((await application(cand.id)).stage).toBe("interview_scheduled");
        const status = await (await app.request(`/c/status/${cand.statusToken}`)).text();
        expect(status).toContain("Your interview is booked. The details are below.");
        expect(status).not.toContain("and in your email");
        // a move, while they have heard nothing: not "moved"
        const chosen = fresh();
        const m = await routeB(out.id, { ...chosen, place: { kind: "link", url: "https://meet.example/new" }, reason: "A clash at our end." });
        expect(m.status, await m.clone().text()).toBe(200);
        expect(((await m.json()) as Booked)).toMatchObject({ candidateNotice: "held", moved: false, attempt: 2 });
        await container.drain();
        expect((await emailOf(`confirm:${out.id}:2`)).status).toBe("held");
        const r3 = await routeB(out.id, { ...chosen, time: "16:00", place: { kind: "link", url: "https://meet.example/newest" } });
        expect(r3.status).toBe(200);
        await container.drain();
        expect((await emailOf(`confirm:${out.id}:3`)).status).toBe("held");

        await its(true);
        for (const attempt of [1, 2]) expect(await emailOf(`confirm:${out.id}:${attempt}`), `attempt ${attempt}`).toMatchObject({ status: "cancelled", error: INTERVIEW_CHANGED_SINCE });
        const sent = mailTo(cand.email).filter((x) => /^(Your interview|New time for your interview):/.test(x.subject));
        expect(sent).toHaveLength(1);
        expect(sent[0].subject).toMatch(/^Your interview: /);
        expect(sent[0].text).toContain("Good news:");
        expect(sent[0].text).toContain("Join: https://meet.example/newest");
        expect(sent[0].text).not.toContain("https://meet.example/old");
        expect(Number(/SEQUENCE:(\d+)/.exec(icsOf(sent[0]))![1])).toBe(4);
        expect(((await (await json(owner, "GET", `/api/v1/interviews/${out.id}`)).json()) as { candidateEmail: string | null }).candidateEmail).toBeNull();
        // team mail is never held, so the interviewer heard of each time: the later two say it moved, even though the candidate's says it is new
        expect(mailTo("owner@settime.test").filter((x) => x.subject.startsWith("Interview booked: Ada Held"))).toHaveLength(1);
        expect(mailTo("owner@settime.test").filter((x) => x.subject.startsWith("Interview moved: Ada Held"))).toHaveLength(2);
      } finally {
        await its(true);
      }
    });

    /**
     * The release review (11 November 2026, L2-8): on the folded pick-a-time path, times worked out while ITS has not confirmed
     * the company wait with their email, and the run books nothing until ITS confirms. "Book this for them" then answered as if
     * a run would book it in a moment.
     */
    it("a time booked for them while the times wait for the ITS check is saved, says it waits for ITS, and is booked once ITS confirms", async () => {
      const kai = await signInAs(container, app, { companyId, role: "hiring_manager", email: "kai@settime.test", name: "Kai Moss" });
      const kaiId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "kai@settime.test")))[0].id;
      expect((await json(kai, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const eve = await apply("Eve", "Held");
      await its(false);
      try {
        const { id } = await approveFor(eve, { interviewerUserIds: [kaiId] });
        const offered = await interview(id);
        expect(offered.status).toBe("scheduling");
        expect((await emailOf(`slots:${id}:${offered.attempt}`)).status).toBe("held");
        const r = await json(owner, "POST", `/api/v1/interviews/${id}/book-on-behalf`, { slotId: offered.offeredSlots[0]!.id, note: "chosen with the candidate by phone" });
        expect(r.status, await r.clone().text()).toBe(200);
        expect(await r.json()).toMatchObject({ status: "scheduling", booking: "held" });
        await container.drain();
        expect(await interview(id)).toMatchObject({ status: "scheduling", selectedSlot: { id: offered.offeredSlots[0]!.id } });
      } finally {
        await its(true);
      }
      // ITS confirms: the times' email goes, and the time chosen with them is booked
      const booked = await interview((await container.db.select({ id: interviews.id }).from(interviews).where(eq(interviews.applicationId, eve.id)))[0].id);
      expect(booked).toMatchObject({ status: "scheduled" });
    });

    it("the old path's held offer is withdrawn when a person sets the time instead; a held reminder of a moved time, and a time that has passed, go nowhere", async () => {
      const wes = await signInAs(container, app, { companyId, role: "hiring_manager", email: "wes@settime.test", name: "Wes Park" });
      const wesId = (await container.db.select({ id: users.id }).from(users).where(eq(users.email, "wes@settime.test")))[0].id;
      expect((await json(wes, "PUT", "/api/v1/me/availability", { timezone: TZ, windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: "09:00", end: "17:00" })), bufferMinutes: 15, maxPerDay: 12 })).status).toBe(200);
      const [bea, cam, dot] = [await apply("Bea", "Held"), await apply("Cam", "Held"), await apply("Dot", "Held")];
      await its(false);
      try {
        const { cand, id } = await approveFor(bea, { interviewerUserIds: [wesId] });
        const offered = await interview(id);
        expect(offered.status).toBe("scheduling");
        expect((await emailOf(`slots:${id}:${offered.attempt}`)).status).toBe("held");
        // parked on the ITS check with no deadline: route B stops it too
        expect((await runs(id))[0]).toMatchObject({ status: "waiting", currentStep: "offer_slots" });
        const r = await routeB(id, {}, wes);
        expect(r.status, await r.clone().text()).toBe(200);
        expect(((await runs(id)).find((x) => x.idempotencyKey === `schedule:${id}:${offered.attempt}`))?.status).toBe("cancelled");
        await container.drain();

        const near = { date: dayIn(5), time: "11:00" };
        const heldReminder = await bookFor(cam, near);
        const start = instant(near.date, near.time);
        setClock(start - 23 * H);
        await container.drain();
        const reminderKey = `iv_reminder:${heldReminder.booked.id}:1:before24h`;
        expect((await emailOf(reminderKey)).status).toBe("held");
        // this one moves to days later, so the reminder of the old time must not go
        const away = instant(dayIn(40), "11:00");
        expect((await routeB(heldReminder.booked.id, { date: dayIn(40), time: "11:00" })).status).toBe(200);
        expect(away).toBeGreaterThan(start);
        await container.drain();
        // and this one's time passes while it waits
        const passing = await bookFor(dot, { date: dayIn(5), time: "13:00" });
        setClock(BASE + 6 * DAY);
        await container.drain();
        await its(true);
        expect(await emailOf(`slots:${id}:${offered.attempt}`)).toMatchObject({ status: "cancelled", error: "the step it invites to has ended since it was written" });
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Pick a time"))).toHaveLength(0);
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(1);
        expect(await emailOf(reminderKey)).toMatchObject({ status: "cancelled", error: INTERVIEW_CHANGED_SINCE });
        expect(await emailOf(`confirm:${heldReminder.booked.id}:1`)).toMatchObject({ status: "cancelled", error: INTERVIEW_CHANGED_SINCE });
        expect((await emailOf(`confirm:${heldReminder.booked.id}:2`)).status).toBe("sent");
        expect(await emailOf(`confirm:${passing.booked.id}:1`)).toMatchObject({ status: "cancelled", error: INTERVIEW_CHANGED_SINCE });
      } finally {
        setClock(BASE);
        await its(true);
      }
    });

    it("a 'tomorrow' reminder that waited until the day itself never goes; the confirmation does", async () => {
      const eda = await apply("Eda", "Held");
      await its(false);
      const near = { date: dayIn(4), time: "11:00" };
      const start = instant(near.date, near.time);
      try {
        const { cand, booked } = await bookFor(eda, near);
        setClock(start - 23 * H);
        await container.drain();
        expect((await emailOf(`iv_reminder:${booked.id}:1:before24h`)).status).toBe("held");
        // ITS confirms on the morning of the interview
        setClock(start - 5 * H);
        await its(true, start - 5 * H);
        expect(await emailOf(`iv_reminder:${booked.id}:1:before24h`)).toMatchObject({ status: "cancelled", error: REMINDER_TOO_LATE });
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Tomorrow:"))).toHaveLength(0);
        expect(mailTo(cand.email).filter((m) => m.subject.startsWith("Your interview:"))).toHaveLength(1);
      } finally {
        setClock(BASE);
        await its(true);
      }
    });

    it("booked and called off before anyone was told: the news never goes, so nobody hears of an interview being cancelled that they never heard of", async () => {
      const fia = await apply("Fia", "Held");
      await its(false);
      try {
        const { cand, booked } = await bookFor(fia);
        const off = await json(owner, "POST", `/api/v1/interviews/${booked.id}/cancel`, { reason: "We changed our minds." });
        expect(off.status).toBe(200);
        expect(await off.json()).toMatchObject({ candidateTold: false, interviewersTold: true });
        await container.drain();
        expect(await emailOf(`iv_cancel:${booked.id}:1`)).toBeUndefined();
        await its(true);
        expect(await emailOf(`confirm:${booked.id}:1`)).toMatchObject({ status: "cancelled", error: INTERVIEW_CHANGED_SINCE });
        expect(mailTo(cand.email).filter((m) => /^(Cancelled|Your interview):/.test(m.subject))).toHaveLength(0);
      } finally {
        await its(true);
      }
    });

    it("news that slipped through before anything reached them is withdrawn on release, a moved note as much as a cancellation", async () => {
      const gus = await apply("Gus", "Held");
      await its(false);
      try {
        const { booked } = await bookFor(gus);
        const held = (key: string, templateKey: string) => withTenant(container.db, companyId, (tx) => tx.insert(communications).values({ companyId, candidateId: gus.candidateId, applicationId: gus.id, direction: "outbound", channel: "email", fromAddress: "x@settime.test", toAddress: gus.email, subject: "News", bodyText: "News", templateKey, provider: "fake", status: "held", sentBy: { kind: "system", id: "test" }, idempotencyKey: key }));
        await held(`iv_cancel:${booked.id}:9`, "interview_cancelled");
        await held(`iv_moved:${booked.id}:9`, "interview_moved");
        await its(true);
        for (const key of [`iv_cancel:${booked.id}:9`, `iv_moved:${booked.id}:9`]) expect(await emailOf(key), key).toMatchObject({ status: "cancelled", error: NEVER_HEARD_OF_IT });
      } finally {
        await its(true);
      }
    });

    it("told first, then the check was taken back: a move held meanwhile says it moved when it goes, and a cancellation still reaches them", async () => {
      const told = await book("Gia", "Held");
      expect((await emailOf(`confirm:${told.booked.id}:1`)).status).toBe("sent");
      const toldToo = await book("Hui", "Held");
      await its(false);
      try {
        const m = await routeB(told.booked.id);
        expect(((await m.json()) as Booked)).toMatchObject({ moved: true, candidateNotice: "held" });
        await container.drain();
        const off = await json(owner, "POST", `/api/v1/interviews/${toldToo.booked.id}/cancel`, { reason: "A clash at our end." });
        expect(off.status).toBe(200);
        // it has not left: the toast says it waits, never that it went
        expect(await off.json()).toMatchObject({ candidateTold: false, candidateNotice: "held" });
        await container.drain();
        await its(true);
        expect(mailTo(told.cand.email).filter((x) => x.subject.startsWith("New time for your interview:"))).toHaveLength(1);
        expect(mailTo(toldToo.cand.email).filter((x) => x.subject.startsWith("Cancelled:"))).toHaveLength(1);
      } finally {
        await its(true);
      }
    });
  });

  describe("the walls", () => {
    it("a locked applicant is refused on both routes, before any handler, and nothing is written or named", async () => {
      const cand = await apply("Ivy", "Locked");
      const { id } = await approveOnly("Jed", "Locked");
      const [jed] = await container.db.select({ applicationId: interviews.applicationId }).from(interviews).where(eq(interviews.id, id));
      const at = new Date(BASE).toISOString();
      await container.db.update(applications).set({ lockedAt: at }).where(eq(applications.id, cand.id));
      await container.db.update(applications).set({ lockedAt: at }).where(eq(applications.id, jed.applicationId));
      try {
        for (const r of [await routeA(cand.id), await routeB(id)]) {
          expect(r.status).toBe(402);
          const text = await r.text();
          expect(JSON.parse(text).error.code).toBe("candidate_locked");
          expect(text).not.toMatch(/Ivy|Jed|Locked,/);
        }
        expect(await container.db.select().from(interviews).where(eq(interviews.applicationId, cand.id))).toHaveLength(0);
        expect(await interview(id)).toMatchObject({ status: "proposed", attempt: 1 });
        // the candidate's notices and the team's never name them
        expect(await noticesAbout("interview.confirmed", "Ivy")).toHaveLength(0);
      } finally {
        await container.db.update(applications).set({ lockedAt: null }).where(eq(applications.id, cand.id));
        await container.db.update(applications).set({ lockedAt: null }).where(eq(applications.id, jed.applicationId));
      }
    });

    it("another company's interview and application answer as if they did not exist", async () => {
      const { booked, cand } = await book("Kai", "Walled");
      const other = await signIn("owner@othercompany.test");
      expect((await json(other, "POST", "/api/v1/companies", { name: "Other Dental", vertical: "dental", sizeBand: "1-19", locations: [{ city: "Austin", region: "TX", country: "US" }] })).status).toBe(201);
      expect((await routeB(booked.id, {}, other)).status).toBe(404);
      expect((await routeA(cand.id, {}, {}, other)).status).toBe(404);
    });
  });
});

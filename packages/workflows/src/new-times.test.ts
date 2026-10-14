import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { activeFollowUpsFor, openFollowUp, openFollowUpOf, setNotifyClock, transition, upsertAvailability, type FollowUpRow } from "@ros/core";
import { SEND_JOB_KIND, releaseHeldCommunications } from "@ros/agents";
import { createDb, migrate, rowsOf, withTenant, type DbHandle, type Tx } from "@ros/db";
import { createIntegrations } from "@ros/integrations";
import { samplePacket } from "../../agents/src/fixtures/sample-packet";
import { NEW_TIMES_KEY, armNewTimes, cancelNewTimesRuns, companyVerifiedSignal, createEngine, reopenForNewTimes, type WorkflowEngine } from "./index";

/**
 * The automatic new times (the Cancelled column, founder decisions 2A and 3A) run by the engine against a migrated
 * database: the timer waits for the stored day; when it is due everything is checked again; it reopens the interview a
 * person approved (never a new one) and counts as sent only once the times email is queued; it waits for ITS when the
 * company's confirmation was taken back; and a person's acts end it. The API journeys are in apps/api new-times.test.ts.
 */
describe("interview_new_times", () => {
  let handle: DbHandle;
  let engine: WorkflowEngine;
  let now = new Date("2026-10-09T21:00:00.000Z"); // Friday 9 October 2026, 14:00 in Los Angeles: the cancel
  const CANCELLED_AT = new Date("2026-10-09T21:00:00.000Z");
  const DUE = "2026-10-15T16:00:00.000Z"; // Thursday 15 October, 09:00 in Los Angeles
  const DAY = 86_400_000;
  const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs);
  const VERIFIED = { verifiedAt: "2026-09-01T00:00:00.000Z" };
  const packet = samplePacket();

  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  type FollowUp = { id: string; auto_state: string; auto_reason: string | null; resolved_how: string | null; current_interview_id: string | null; times_sent_count: number; last_sent_via: string | null; last_offer_key: string | null; auto_run_id: string | null; auto_sent_at: string | null };
  const followUp = async (applicationId: string) => (await rows<FollowUp>(sql`SELECT * FROM interview_followups WHERE application_id = ${applicationId} ORDER BY created_at DESC LIMIT 1`))[0];
  type Interview = { status: string; attempt: number; schedule_token: string | null; scheduling_window: Record<string, unknown>; calendar_refs: Record<string, unknown>; cancel_reason: string | null };
  const interview = async (id: string) => (await rows<Interview>(sql`SELECT status, attempt, schedule_token, scheduling_window, calendar_refs, cancel_reason FROM interviews WHERE id = ${id}`))[0];
  const runOf = async (runId: string) => (await rows<{ status: string; current_step: string; state: Record<string, unknown>; wait: { kind: string; until?: string; token?: string; keys?: string[]; eventTypes?: string[]; reason?: string } | null }>(sql`SELECT status, current_step, state, wait FROM workflow_runs WHERE id = ${runId}`))[0];
  const scheduleRuns = (interviewId: string) => rows<{ id: string; status: string; state: Record<string, unknown>; idempotency_key: string }>(sql`SELECT id, status, state, idempotency_key FROM workflow_runs WHERE workflow_key = 'schedule_interview' AND subject->>'id' = ${interviewId} ORDER BY idempotency_key`);
  const notices = (companyId: string, kind: string) => rows<{ user_id: string; title: string; body: string }>(sql`SELECT user_id, title, body FROM notifications WHERE company_id = ${companyId} AND kind = ${kind} ORDER BY created_at`);
  const slotsEmails = (applicationId: string) => rows<{ idempotency_key: string; status: string; subject: string; body_text: string }>(sql`SELECT idempotency_key, status, subject, body_text FROM communications WHERE application_id = ${applicationId} AND template_key = 'interview_slots' ORDER BY created_at`);
  const tenant = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, companyId, fn);
  const eventsOf = (subjectId: string, type: string) => rows<{ payload: Record<string, unknown> }>(sql`SELECT payload FROM events WHERE subject_id = ${subjectId} AND type = ${type} ORDER BY id`);

  /**
   * A company with an owner and interviewers, a role with its approved packet, and one candidate who cancelled their
   * booked interview on Friday asking for new times: under Cancelled, the set waiting for Thursday, its run armed.
   */
  async function person(opts: { availability?: boolean; interviewers?: number } = {}) {
    const ids = { companyId: randomUUID(), roleId: randomUUID(), candidateId: randomUUID(), applicationId: randomUUID(), interviewId: randomUUID(), ownerId: randomUUID(), interviewerIds: [] as string[] };
    const { companyId } = ids;
    const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, timezone, settings) VALUES (${companyId}, 'Harbor Dental', ${`harbor-${companyId}`}, 'dental', '20-49', 'America/Los_Angeles', ${JSON.stringify(VERIFIED)}::jsonb)`);
    await handle.db.execute(sql`INSERT INTO users (id, email, name) VALUES (${ids.ownerId}, ${`olive-${ids.ownerId}@example.com`}, 'Olive Owner')`);
    await handle.db.execute(sql`INSERT INTO memberships (id, company_id, user_id, role) VALUES (${randomUUID()}, ${companyId}, ${ids.ownerId}, 'owner')`);
    for (const name of ["Grace Hill", "Ben Ortiz"].slice(0, opts.interviewers ?? 1)) {
      const userId = randomUUID();
      ids.interviewerIds.push(userId);
      await handle.db.execute(sql`INSERT INTO users (id, email, name) VALUES (${userId}, ${`${name.split(" ")[0].toLowerCase()}-${userId}@example.com`}, ${name})`);
      await handle.db.execute(sql`INSERT INTO memberships (id, company_id, user_id, role) VALUES (${randomUUID()}, ${companyId}, ${userId}, 'interviewer')`);
    }
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${ids.roleId}, ${companyId}, 'Dental Assistant', 'open', ${actor})`);
    await handle.db.execute(sql`INSERT INTO role_packets (id, company_id, role_id, version, packet, status, source, created_by) VALUES (${randomUUID()}, ${companyId}, ${ids.roleId}, 1, ${JSON.stringify(packet)}::jsonb, 'approved', 'intake', ${actor})`);
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${ids.candidateId}, ${companyId}, 'Ana', 'Lopez', ${`ana-${ids.candidateId}@example.com`}, 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${ids.applicationId}, ${companyId}, ${ids.roleId}, ${ids.candidateId}, 1, 'direct', ${`tok-${ids.applicationId}`}, 'interview_recommended')`);
    const window = { fromDate: "2026-09-21", toDate: "2026-10-02", businessDaysOnly: true, candidateTimezone: "America/New_York" };
    const refs = Object.fromEntries(ids.interviewerIds.map((u) => [u, { provider: "google", eventId: `ev-${u}`, htmlLink: null, meetingUrl: null }]));
    await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, attempt, schedule_token, schedule_token_expires_at, scheduling_window, calendar_refs, cancel_reason, starts_at, ends_at)
      VALUES (${ids.interviewId}, ${companyId}, ${ids.applicationId}, 'owner', 'Conversation with the dentist', 'video', 30, 'cancelled', 2, ${`tok-${ids.interviewId}`}, '2026-10-08T18:00:00Z', ${JSON.stringify(window)}::jsonb, ${JSON.stringify(refs)}::jsonb, 'cancelled by the candidate', '2026-10-12T17:00:00Z', '2026-10-12T17:30:00Z')`);
    for (const userId of ids.interviewerIds) await handle.db.execute(sql`INSERT INTO interview_participants (id, company_id, interview_id, user_id, role, status) VALUES (${randomUUID()}, ${companyId}, ${ids.interviewId}, ${userId}, 'interviewer', 'confirmed')`);
    if (opts.availability !== false) await declareHours(ids);
    const candidate: Actor = { kind: "candidate", id: ids.candidateId };
    const runId = await tenant(companyId, async (tx) => {
      const { row } = await openFollowUp(tx, { companyId, applicationId: ids.applicationId, interviewId: ids.interviewId, interviewAttempt: 2, kind: "candidate_cancelled", choice: "new_times", auto: { state: "waiting", dueAt: DUE, workingDays: 3 }, actor: candidate, now: CANCELLED_AT });
      return armNewTimes(tx, engine, { companyId, followUpId: row.id, applicationId: ids.applicationId, roleId: ids.roleId, interviewId: ids.interviewId, actor: candidate });
    });
    return { ...ids, runId, owner: { kind: "user", id: ids.ownerId, name: "Olive Owner" } as Actor };
  }
  type Person = Awaited<ReturnType<typeof person>>;

  /** The interviewers declare weekday hours, and any run waiting for availability is woken (as the availability route does). */
  async function declareHours(p: Pick<Person, "companyId" | "interviewerIds">, hours = { start: "09:00", end: "17:00" }) {
    await tenant(p.companyId, async (tx) => {
      for (const userId of p.interviewerIds) await upsertAvailability(tx, { companyId: p.companyId, userId, timezone: "America/Los_Angeles", windows: [1, 2, 3, 4, 5].map((day) => ({ day, ...hours })), bufferMinutes: 15, maxPerDay: 3, actor: { kind: "user", id: userId } });
      await engine.signal(tx, { companyId: p.companyId, key: "availability.updated" });
    });
  }
  /** ITS takes its confirmation of the company back, or gives it (with the release and the signal `verifyCompany` sends). */
  const unverify = (p: Person) => handle.db.execute(sql`UPDATE companies SET settings = settings - 'verifiedAt' WHERE id = ${p.companyId}`);
  async function verify(p: Person) {
    await handle.db.execute(sql`UPDATE companies SET settings = settings || ${JSON.stringify(VERIFIED)}::jsonb WHERE id = ${p.companyId}`);
    await tenant(p.companyId, async (tx) => {
      await releaseHeldCommunications(tx, { companyId: p.companyId, actor: { kind: "system", id: "its" }, now });
      await engine.signal(tx, { companyId: p.companyId, key: companyVerifiedSignal(p.companyId) });
    });
  }
  async function runAt(when: Date | string) {
    now = new Date(when);
    await engine.runUntilIdle();
  }

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    const integrations = { ...createIntegrations({ NODE_ENV: "test", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory" }, { memoryStorage: true }), clock: () => now };
    engine = createEngine({ db: handle.db, services: { ai: {} as never, integrations, env: { appBaseUrl: "https://app.example", jobsBaseUrl: "https://jobs.example", itsQueueEmail: "queue@example.com", smsEnabled: false } } }, { now: () => now });
    // Emails stay queued here: what matters is that they were written to leave.
    engine.registerJob(SEND_JOB_KIND, async () => {});
    setNotifyClock(() => now);
  });
  afterAll(async () => {
    setNotifyClock(() => new Date());
    await handle.close();
  });

  it("waits for the stored day, then reopens the same interview and counts the set as sent once the times email is queued", async () => {
    now = CANCELLED_AT;
    const p = await person();
    await engine.runUntilIdle();
    const armed = await runOf(p.runId);
    expect(armed).toMatchObject({ status: "waiting", current_step: "wait", wait: { kind: "timer", until: DUE } });
    expect((await followUp(p.applicationId)).auto_run_id).toBe(p.runId);

    // the day before: nothing moves
    await runAt(at(DUE, -DAY));
    expect((await followUp(p.applicationId)).auto_state).toBe("waiting");
    expect((await interview(p.interviewId)).status).toBe("cancelled");

    await runAt(DUE);
    const iv = await interview(p.interviewId);
    expect(iv).toMatchObject({ status: "scheduling", attempt: 3, schedule_token: `tok-${p.interviewId}`, cancel_reason: "cancelled by the candidate" });
    // a fresh window from the day after, in the company's zone; the candidate's own zone kept
    expect(iv.scheduling_window).toMatchObject({ fromDate: "2026-10-16", businessDaysOnly: true, candidateTimezone: "America/New_York" });
    expect(await rows(sql`SELECT status FROM interview_participants WHERE interview_id = ${p.interviewId}`)).toEqual([{ status: "invited" }]);
    expect(await notices(p.companyId, "interview.new_times")).toEqual([{ user_id: p.interviewerIds[0], title: "New times are being set up for Ana Lopez", body: "Conversation with the dentist. Ana cancelled and asked for new times; times are offered from your calendar or declared hours, and you will be told when one is booked." }]);
    expect((await eventsOf(p.interviewId, "interview.rescheduled"))[0].payload).toEqual({ byCandidate: false, attempt: 3, hadEvents: false, newTimes: true, via: "auto", followUpId: (await followUp(p.applicationId)).id });

    const [run] = await scheduleRuns(p.interviewId);
    expect(run.idempotency_key).toBe(`schedule:${p.interviewId}:3`);
    expect(run.state).toMatchObject({ attempt: 3, offerKind: "new_times_asked", followUpId: (await followUp(p.applicationId)).id, via: "auto" });
    const [email] = await slotsEmails(p.applicationId);
    expect(email).toMatchObject({ idempotency_key: `slots:${p.interviewId}:3`, status: "queued", subject: "New times for your interview: Dental Assistant at Harbor Dental" });
    expect(email.body_text).toContain("As you asked when you cancelled, here are new times for your conversation with the dentist");
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "sent", auto_reason: null, resolved_how: null, current_interview_id: p.interviewId, times_sent_count: 1, last_sent_via: "auto", last_offer_key: `slots:${p.interviewId}:3` });
    expect((await followUp(p.applicationId)).auto_sent_at).not.toBeNull();
    expect(await notices(p.companyId, "interview.new_times_sent")).toEqual([{ user_id: p.ownerId, title: "New times went to Ana Lopez", body: "Ana cancelled the conversation with the dentist and asked for new times. They went out today. This was their one automatic set; if Ana does not pick a time, they stay under Cancelled for you to decide." }]);
    expect(await runOf(p.runId)).toMatchObject({ status: "completed" });
    expect((await runOf(run.id)).wait).toMatchObject({ kind: "event", reason: "waiting for the candidate to pick a time" });
    const view = (await tenant(p.companyId, (tx) => activeFollowUpsFor(tx, [p.applicationId]))).get(p.applicationId);
    expect(view).toMatchObject({ times: "out", interviewOpen: true });

    // Unpicked: after the reminder and four days they stay under Cancelled, and nothing goes automatically again.
    await runAt(at(DUE, 49 * 3_600_000));
    await runAt(at(DUE, 98 * 3_600_000));
    expect((await interview(p.interviewId)).status).toBe("offer_expired");
    expect((await notices(p.companyId, "interview.offer_expired")).map((n) => n.body)).toEqual(["Four days passed with a reminder. They stay under Cancelled: send new times again, or decide."]);
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "sent", resolved_how: null });
    expect((await tenant(p.companyId, (tx) => activeFollowUpsFor(tx, [p.applicationId]))).get(p.applicationId)).toMatchObject({ times: "expired", interviewOpen: false });

    // A person sends new times again: the lapsed interview reopens once more, with a new link, and counts as their send.
    const reopened = await tenant(p.companyId, async (tx) => reopenForNewTimes(tx, engine, { followUp: (await openFollowUpOf(tx, p.applicationId, { lock: true }))!, actor: p.owner, via: "person", offerKind: "new_times_asked", now }));
    expect(reopened).toMatchObject({ ok: true, interviewId: p.interviewId, attempt: 4 });
    await engine.runUntilIdle();
    expect((await interview(p.interviewId)).schedule_token).not.toBeNull();
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "sent", times_sent_count: 2, last_sent_via: "person", last_offer_key: `slots:${p.interviewId}:4` });
    expect(await notices(p.companyId, "interview.new_times_sent")).toHaveLength(1);
  });

  it("is only preparing while the interviewers' times are unknown, and the team's notice says why", async () => {
    now = CANCELLED_AT;
    const p = await person({ availability: false });
    await runAt(DUE);
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "preparing", current_interview_id: p.interviewId, times_sent_count: 0 });
    expect(await slotsEmails(p.applicationId)).toEqual([]);
    expect((await tenant(p.companyId, (tx) => activeFollowUpsFor(tx, [p.applicationId]))).get(p.applicationId)).toMatchObject({ times: "preparing" });
    const [notice] = await notices(p.companyId, "interview.no_availability");
    expect(notice.body).toContain("need to connect a calendar or declare hours before times can be offered. Ana cancelled and asked for new times; they go out as soon as there are times to offer.");

    // ITS takes its confirmation back before the times exist: the email is held, and the offer clock does not start.
    await unverify(p);
    await declareHours(p);
    await engine.runUntilIdle();
    expect((await slotsEmails(p.applicationId)).map((e) => e.status)).toEqual(["held"]);
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "preparing", times_sent_count: 0 });
    expect(await eventsOf(p.interviewId, "interview.slots_offered")).toEqual([]);
    const [run] = await scheduleRuns(p.interviewId);
    expect(await runOf(run.id)).toMatchObject({ status: "waiting", current_step: "offer_slots", wait: { kind: "event", keys: [companyVerifiedSignal(p.companyId)], reason: "the new times wait for ITS to confirm the company" } });
    expect((await runOf(run.id)).wait?.until).toBeUndefined();
    expect((await tenant(p.companyId, (tx) => activeFollowUpsFor(tx, [p.applicationId]))).get(p.applicationId)).toMatchObject({ times: "held" });

    // ITS confirms: the email is released, and only then is the offer recorded and the clock started.
    await runAt(at(DUE, 2 * DAY));
    await verify(p);
    await engine.runUntilIdle();
    expect((await slotsEmails(p.applicationId)).map((e) => e.status)).toEqual(["queued"]);
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "sent", times_sent_count: 1 });
    expect(await eventsOf(p.interviewId, "interview.slots_offered")).toHaveLength(1);
    expect((await runOf(run.id)).wait).toMatchObject({ kind: "event", reason: "waiting for the candidate to pick a time", until: at(DUE, 4 * DAY).toISOString() });
  });

  it("says so in the no-common-times notice too, and stays preparing", async () => {
    now = CANCELLED_AT;
    const p = await person({ availability: false });
    await runAt(DUE);
    await declareHours(p, { start: "09:00", end: "09:10" });
    await engine.runUntilIdle();
    const [notice] = await notices(p.companyId, "interview.no_slots");
    expect(notice.body).toMatch(/no shared free time of 30 minutes\. Add hours or free some time; we check again when an interviewer's hours change\. Ana cancelled and asked for new times; they go out as soon as there are times to offer\.$/);
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "preparing", times_sent_count: 0 });
  });

  it("ends not sent when the times email cannot go, and the team hears it twice over (the set, and how to reach them)", async () => {
    now = CANCELLED_AT;
    const p = await person({ availability: false });
    await runAt(DUE);
    await handle.db.execute(sql`UPDATE candidates SET email = NULL WHERE id = ${p.candidateId}`);
    await declareHours(p);
    await engine.runUntilIdle();
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "not_sent", auto_reason: "no_email", times_sent_count: 0, resolved_how: null });
    expect((await notices(p.companyId, "interview.new_times_not_sent")).map((n) => n.body)).toEqual(["Ana asked for new times, due Thursday, October 15. We have no email address for them, or the email did not reach them. They are under Cancelled: send new times when you are ready, or decide."]);
    expect(await notices(p.companyId, "interview.unreachable")).toHaveLength(1);
    expect(await notices(p.companyId, "interview.new_times_sent")).toEqual([]);
  });

  it("waits for ITS when the company's confirmation was taken back after arming, and gives up ten days after the promised day", async () => {
    now = CANCELLED_AT;
    const kept = await person();
    const lost = await person();
    await engine.runUntilIdle();
    await unverify(kept);
    await unverify(lost);
    await runAt(DUE);
    for (const p of [kept, lost]) {
      expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "waiting_check", auto_reason: null });
      expect((await interview(p.interviewId)).status).toBe("cancelled");
      expect(await runOf(p.runId)).toMatchObject({ status: "waiting", current_step: "send", wait: { kind: "event", keys: [companyVerifiedSignal(p.companyId)], until: at(DUE, 10 * DAY).toISOString() } });
    }

    // a timer wake before the tenth day (as a retry would be) waits again and changes nothing
    now = at(DUE, 3 * DAY);
    await engine.tick(lost.runId, { kind: "timer", key: (await runOf(lost.runId)).wait?.token });
    expect(await followUp(lost.applicationId)).toMatchObject({ auto_state: "waiting_check" });
    expect(await runOf(lost.runId)).toMatchObject({ status: "waiting", current_step: "send" });

    // ITS confirms one company again: its set goes
    await verify(kept);
    await engine.runUntilIdle();
    expect(await followUp(kept.applicationId)).toMatchObject({ auto_state: "sent", times_sent_count: 1 });
    expect((await interview(kept.interviewId)).status).toBe("scheduling");

    // the other is never confirmed: ten days after the promised day the team is told
    await runAt(at(DUE, 10 * DAY));
    expect(await followUp(lost.applicationId)).toMatchObject({ auto_state: "not_sent", auto_reason: "company_not_checked", resolved_how: null });
    expect((await interview(lost.interviewId)).status).toBe("cancelled");
    expect(await notices(lost.companyId, "interview.new_times_not_sent")).toEqual([{ user_id: lost.ownerId, title: "New times for Ana Lopez were not sent", body: "Ana asked for new times, due Thursday, October 15. ITS had not confirmed your company in time, so nothing was sent automatically. They are under Cancelled: you can send new times once ITS confirms your company, or decide." }]);
  });

  it("checks everything again when it is due: a timer alone never sends anything", async () => {
    now = CANCELLED_AT;
    const takeover = await person();
    const teamActed = await person();
    const nobody = await person();
    const closed = await person();
    const deleted = await person();
    const noEmail = await person();
    const changed = await person();
    await engine.runUntilIdle();
    await handle.db.execute(sql`INSERT INTO takeovers (id, company_id, role_id, recruiter_user_id, status) VALUES (${randomUUID()}, ${takeover.companyId}, ${takeover.roleId}, ${takeover.ownerId}, 'active')`);
    await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status) VALUES (${randomUUID()}, ${teamActed.companyId}, ${teamActed.applicationId}, 'owner', 'Conversation with the dentist', 'video', 30, 'proposed')`);
    await handle.db.execute(sql`UPDATE memberships SET status = 'removed' WHERE user_id = ${nobody.interviewerIds[0]}`);
    await handle.db.execute(sql`UPDATE roles SET status = 'closed' WHERE id = ${closed.roleId}`);
    await handle.db.execute(sql`UPDATE candidates SET anonymized_at = now() WHERE id = ${deleted.candidateId}`);
    await handle.db.execute(sql`UPDATE candidates SET email = NULL WHERE id = ${noEmail.candidateId}`);
    await handle.db.execute(sql`UPDATE interviews SET attempt = 3 WHERE id = ${changed.interviewId}`);
    await runAt(DUE);
    const expected: Array<[Person, string, boolean]> = [[takeover, "takeover", true], [teamActed, "team_acted", false], [nobody, "no_interviewers", true], [closed, "left_process", false], [deleted, "details_deleted", false], [noEmail, "no_email", true], [changed, "interview_changed", true]];
    for (const [p, reason, told] of expected) {
      expect(await followUp(p.applicationId), reason).toMatchObject({ auto_state: "not_sent", auto_reason: reason });
      expect((await interview(p.interviewId)).status, reason).toBe("cancelled");
      expect(await scheduleRuns(p.interviewId), reason).toEqual([]);
      expect((await notices(p.companyId, "interview.new_times_not_sent")).length, reason).toBe(told ? 1 : 0);
      expect((await eventsOf(p.applicationId, "interview.new_times_not_sent")).at(-1)?.payload, reason).toMatchObject({ reason, from: "waiting" });
    }
    expect((await notices(takeover.companyId, "interview.new_times_not_sent"))[0].body).toContain("An ITS recruiter is running this role, so nothing was sent automatically.");
  });

  it("completes without writing for someone no longer under Cancelled, and sends on the day after a decision taken back", async () => {
    now = CANCELLED_AT;
    const declined = await person();
    const undone = await person();
    await engine.runUntilIdle();
    for (const p of [declined, undone]) await tenant(p.companyId, (tx) => transition(tx, { applicationId: p.applicationId, companyId: p.companyId, to: "rejected", by: "owner", actor: p.owner, reason: "not a fit", now: at(DUE, -3 * DAY) }));
    expect(await followUp(declined.applicationId)).toMatchObject({ auto_state: "not_sent", auto_reason: "left_process", resolved_how: "left_process" });
    // the decision taken back before the day: back under Cancelled, the promised set waiting again
    await tenant(undone.companyId, (tx) => transition(tx, { applicationId: undone.applicationId, companyId: undone.companyId, to: "interview_recommended", by: "owner", actor: undone.owner, undoDecision: true, now: at(DUE, -2 * DAY) }));
    expect(await followUp(undone.applicationId)).toMatchObject({ auto_state: "waiting", resolved_how: null });

    await runAt(DUE);
    expect(await runOf(declined.runId)).toMatchObject({ status: "completed" });
    expect((await interview(declined.interviewId)).status).toBe("cancelled");
    expect(await followUp(declined.applicationId)).toMatchObject({ auto_state: "not_sent", auto_reason: "left_process" });
    expect(await followUp(undone.applicationId)).toMatchObject({ auto_state: "sent", resolved_how: null, times_sent_count: 1 });
  });

  it("is cancelled when a person stops or replaces the set, and a stale timer then does nothing", async () => {
    now = CANCELLED_AT;
    const p = await person();
    await engine.runUntilIdle();
    const stopped = await tenant(p.companyId, (tx) => cancelNewTimesRuns(tx, engine, { companyId: p.companyId, applicationId: p.applicationId, actor: p.owner, reason: "stopped by the team" }));
    expect(stopped).toBe(1);
    expect(await runOf(p.runId)).toMatchObject({ status: "cancelled" });
    expect(await tenant(p.companyId, (tx) => cancelNewTimesRuns(tx, engine, { companyId: p.companyId, applicationId: p.applicationId, actor: p.owner, reason: "again" }))).toBe(0);
    await runAt(DUE);
    expect(await runOf(p.runId)).toMatchObject({ status: "cancelled" });
    expect((await interview(p.interviewId)).status).toBe("cancelled");
    expect(NEW_TIMES_KEY).toBe("interview_new_times");
  });

  it("takes interviewers who left the team off the reopened interview, and refuses what cannot be reopened", async () => {
    now = CANCELLED_AT;
    const p = await person({ interviewers: 2 });
    await engine.runUntilIdle();
    const [grace, ben] = p.interviewerIds;
    await handle.db.execute(sql`UPDATE memberships SET status = 'removed' WHERE user_id = ${ben}`);
    const reopen = (over: Partial<FollowUpRow> = {}) => tenant(p.companyId, async (tx) => reopenForNewTimes(tx, engine, { followUp: { ...(await openFollowUpOf(tx, p.applicationId, { lock: true }))!, ...over }, actor: p.owner, via: "person", offerKind: "new_times_team", now }));

    // the interview changed since the cancel (its attempt moved on)
    expect(await reopen({ interviewAttempt: 1 })).toEqual({ ok: false, reason: "interview_changed" });
    // a no-show's missed interview is never reopened: a person approves a new one
    expect(await reopen({ kind: "candidate_no_show", choice: null })).toEqual({ ok: false, reason: "not_reopenable" });

    const done = await reopen();
    expect(done).toMatchObject({ ok: true, interviewId: p.interviewId, attempt: 3 });
    expect(await rows(sql`SELECT user_id FROM interview_participants WHERE interview_id = ${p.interviewId}`)).toEqual([{ user_id: grace }]);
    expect(Object.keys((await interview(p.interviewId)).calendar_refs)).toEqual([grace]);
    expect((await notices(p.companyId, "interview.new_times")).map((n) => [n.user_id, n.body])).toEqual([[grace, "Conversation with the dentist. Your team is offering new times from your calendar or declared hours; you will be told when one is booked."]]);
    // the times are out (being prepared) now: a second send is refused
    expect(await reopen()).toEqual({ ok: false, reason: "times_out" });
    await engine.runUntilIdle();
    const [email] = await slotsEmails(p.applicationId);
    expect(email.subject).toBe("New interview times: Dental Assistant at Harbor Dental");
    expect(email.body_text).toContain("Harbor Dental would like to find a new time for your conversation with the dentist for the Dental Assistant position. 30 minutes, video with Grace.");
    // a person's send: counted, never "the one automatic set"
    expect(await followUp(p.applicationId)).toMatchObject({ auto_state: "waiting", times_sent_count: 1, last_sent_via: "person" });
    expect(await notices(p.companyId, "interview.new_times_sent")).toEqual([]);
  });

  it("refuses with nobody left to interview, and when another interview is already open", async () => {
    now = CANCELLED_AT;
    const alone = await person();
    const other = await person();
    await engine.runUntilIdle();
    await handle.db.execute(sql`UPDATE memberships SET status = 'removed' WHERE user_id = ${alone.interviewerIds[0]}`);
    await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status) VALUES (${randomUUID()}, ${other.companyId}, ${other.applicationId}, 'owner', 'Conversation with the dentist', 'video', 30, 'scheduled')`);
    for (const [p, reason] of [[alone, "no_interviewers"], [other, "team_acted"]] as const) {
      const result = await tenant(p.companyId, async (tx) => reopenForNewTimes(tx, engine, { followUp: (await openFollowUpOf(tx, p.applicationId, { lock: true }))!, actor: p.owner, via: "batch", offerKind: "new_times_asked", now }));
      expect(result).toEqual({ ok: false, reason });
      expect((await interview(p.interviewId)).status).toBe("cancelled");
    }
    expect(await rows(sql`SELECT user_id FROM interview_participants WHERE interview_id = ${alone.interviewId}`)).toHaveLength(1);
  });
});

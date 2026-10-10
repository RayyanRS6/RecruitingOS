import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { openFollowUp, setMark, type FollowUpEntryAuto } from "@ros/core";
import { createDb, migrate, withTenant, type DbHandle, type Tx } from "@ros/db";
import { createIntegrations } from "@ros/integrations";
import { sendStillReviewingNotes } from "./decision-messages";
import { samplePacket } from "./fixtures/sample-packet";
import { MAX_CANDIDATE_RESCHEDULES, autoNewTimesPlan, newTimesDayWords, newTimesDue, workingDaysLater } from "./new-times";
import { detectStuckRoles } from "./orchestrator";

/**
 * The one automatic set of new times (founder decisions 2A and 3A): the day it is due, counted in the company's working
 * days and time zone, the hour it goes, and whether a candidate who cancels and asks for new times gets it at all. And
 * how people under Cancelled are left out of the team's other nudges and of the "still reviewing" note.
 */
const LA = "America/Los_Angeles";
const FRIDAY_2PM = new Date("2026-10-09T21:00:00.000Z"); // Friday 9 October 2026, 14:00 in Los Angeles
const COLUMBUS_DAY = new Set(["2026-10-12"]);

describe("working days", () => {
  it("counts the company's working days in its own zone, skipping weekends and holidays (the worked example)", () => {
    // Monday 12 October is Columbus Day: Tuesday, Wednesday, Thursday.
    expect(workingDaysLater(FRIDAY_2PM, { timeZone: LA, holidays: COLUMBUS_DAY }, 3)).toEqual({ day: "2026-10-15" });
    expect(workingDaysLater(FRIDAY_2PM, { timeZone: LA, holidays: COLUMBUS_DAY }, 1)).toEqual({ day: "2026-10-13" });
    expect(workingDaysLater(FRIDAY_2PM, { timeZone: LA }, 3)).toEqual({ day: "2026-10-14" });
  });

  it("reads a Friday-evening cancel as Friday in the company's zone, even when it is already Saturday in UTC", () => {
    const fridayEvening = new Date("2026-10-10T06:30:00.000Z"); // Friday 23:30 in Los Angeles
    expect(workingDaysLater(fridayEvening, { timeZone: LA, holidays: COLUMBUS_DAY }, 3)).toEqual({ day: "2026-10-15" });
    // the zone decides the day: in UTC the same moment is already Saturday 10 October
    expect(workingDaysLater(fridayEvening, { timeZone: "UTC" }, 1)).toEqual({ day: "2026-10-12" });
    expect(workingDaysLater(fridayEvening, { timeZone: LA }, 1)).toEqual({ day: "2026-10-12" });
    expect(workingDaysLater(new Date("2026-10-09T06:30:00.000Z"), { timeZone: "UTC" }, 1)).toEqual({ day: "2026-10-12" });
    expect(workingDaysLater(new Date("2026-10-09T06:30:00.000Z"), { timeZone: LA }, 1)).toEqual({ day: "2026-10-09" });
  });

  it("never skips or repeats a day across the end of daylight saving (1 November 2026)", () => {
    const thursday = new Date("2026-10-29T21:00:00.000Z"); // Thursday 29 October, 14:00 in Los Angeles
    expect(workingDaysLater(thursday, { timeZone: LA }, 3)).toEqual({ day: "2026-11-03" });
    expect(workingDaysLater(new Date("2026-10-31T19:00:00.000Z"), { timeZone: LA }, 1)).toEqual({ day: "2026-11-02" });
  });

  it("counts only the contact days the company chose", () => {
    // Tuesday to Thursday only: from Friday, Tuesday 13 is a holiday-free first day here (no holidays given).
    expect(workingDaysLater(FRIDAY_2PM, { timeZone: LA, workDays: [2, 3, 4] }, 2)).toEqual({ day: "2026-10-14" });
  });

  it("names the day in the candidate's words", () => {
    expect(newTimesDayWords("2026-10-15T16:00:00.000Z", LA)).toBe("Thursday, October 15");
    expect(newTimesDayWords(new Date("2026-10-15T16:00:00.000Z"), "America/New_York")).toBe("Thursday, October 15");
  });
});

describe("the automatic set: when and whether", () => {
  let handle: DbHandle;
  const ownerId = randomUUID();
  const owner: Actor = { kind: "user", id: ownerId, name: "Olive Owner" };
  const VERIFIED = { verifiedAt: "2026-09-01T00:00:00.000Z" };

  const tenant = <T>(companyId: string, fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, companyId, fn);
  async function company(settings: Record<string, unknown>, timezone = LA): Promise<string> {
    const id = randomUUID();
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, timezone, settings) VALUES (${id}, 'Bright Dental', ${`bright-${id}`}, 'dental', '20-49', ${timezone}, ${JSON.stringify(settings)}::jsonb)`);
    return id;
  }
  /** A company with a role and one candidate whose interview was booked: what `autoNewTimesPlan` reads at the cancel. */
  async function person(settings: Record<string, unknown> = VERIFIED) {
    const companyId = await company(settings);
    const roleId = randomUUID();
    const candidateId = randomUUID();
    const applicationId = randomUUID();
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${roleId}, ${companyId}, 'Hygienist', 'open', ${sql`'{"kind":"user","id":"u1"}'::jsonb`})`);
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${candidateId}, ${companyId}, 'Ana', 'Lopez', ${`ana-${candidateId}@example.com`}, 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${applicationId}, ${companyId}, ${roleId}, ${candidateId}, 1, 'direct', ${`tok-${applicationId}`}, 'interview_scheduled')`);
    const plan = (rescheduleCount = 0, now = FRIDAY_2PM) => tenant(companyId, (tx) => autoNewTimesPlan(tx, { companyId, roleId, applicationId, rescheduleCount, now }));
    return { companyId, roleId, applicationId, plan };
  }
  /** An earlier automatic set of theirs, in the given state (one per person ever: `preparing` or `sent`). */
  async function earlierSet(p: { companyId: string; applicationId: string }, state: "preparing" | "sent" | "not_sent") {
    const interviewId = randomUUID();
    await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, attempt) VALUES (${interviewId}, ${p.companyId}, ${p.applicationId}, 'first', 'First interview', 'video', 30, 'cancelled', 2)`);
    await handle.db.execute(sql`INSERT INTO interview_followups (id, company_id, application_id, interview_id, interview_attempt, kind, choice, auto_state, auto_reason, auto_sent_at, resolved_at, resolved_how, created_by)
      VALUES (${randomUUID()}, ${p.companyId}, ${p.applicationId}, ${interviewId}, 2, 'candidate_cancelled', 'new_times', ${state}, ${state === "not_sent" ? "no_email" : null}, ${state === "sent" ? "2026-09-20T16:00:00Z" : null}, now(), 'rebooked', ${sql`'{"kind":"candidate","id":"c"}'::jsonb`})`);
  }

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    await handle.db.execute(sql`INSERT INTO users (id, email, name) VALUES (${ownerId}, ${`olive-${ownerId}@example.com`}, 'Olive Owner')`);
  });
  afterAll(async () => {
    await handle.close();
  });

  it("is due at 09:00 company time on the third working day (Thursday 15 October, 16:00Z)", async () => {
    const companyId = await company(VERIFIED);
    expect(await tenant(companyId, (tx) => newTimesDue(tx, { companyId, from: FRIDAY_2PM, workingDays: 3 }))).toEqual({ at: "2026-10-15T16:00:00.000Z", day: "2026-10-15" });
  });

  it("goes at the start of the company's contact hours when they open after 09:00", async () => {
    const companyId = await company({ ...VERIFIED, businessHours: { days: [1, 2, 3, 4, 5], start: "10:00", end: "17:00" } });
    expect(await tenant(companyId, (tx) => newTimesDue(tx, { companyId, from: FRIDAY_2PM, workingDays: 3 }))).toEqual({ at: "2026-10-15T17:00:00.000Z", day: "2026-10-15" });
    // earlier contact hours never bring it before 09:00
    const early = await company({ ...VERIFIED, businessHours: { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" } });
    expect((await tenant(early, (tx) => newTimesDue(tx, { companyId: early, from: FRIDAY_2PM, workingDays: 3 }))).at).toBe("2026-10-15T16:00:00.000Z");
  });

  it("never counts a Saturday, even when the company contacts people on Saturdays", async () => {
    const companyId = await company({ ...VERIFIED, businessHours: { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00" } });
    expect(await tenant(companyId, (tx) => newTimesDue(tx, { companyId, from: FRIDAY_2PM, workingDays: 1 }))).toEqual({ at: "2026-10-13T16:00:00.000Z", day: "2026-10-13" });
  });

  it("keeps 09:00 local across the end of daylight saving (17:00Z in November)", async () => {
    const companyId = await company(VERIFIED);
    expect(await tenant(companyId, (tx) => newTimesDue(tx, { companyId, from: new Date("2026-10-29T21:00:00.000Z"), workingDays: 3 }))).toEqual({ at: "2026-11-03T17:00:00.000Z", day: "2026-11-03" });
  });

  it("arms one set after the company's number of working days (3 unless it chose otherwise)", async () => {
    expect(await (await person()).plan()).toEqual({ arm: true, dueAt: "2026-10-15T16:00:00.000Z", day: "2026-10-15", workingDays: 3 });
    expect(await (await person({ ...VERIFIED, newTimesAfterCancel: { auto: true, workingDays: 5 } })).plan()).toEqual({ arm: true, dueAt: "2026-10-19T16:00:00.000Z", day: "2026-10-19", workingDays: 5 });
  });

  it("arms nothing when the company switched automatic new times off, before anything else is read", async () => {
    expect(await (await person({ newTimesAfterCancel: { auto: false, workingDays: 3 } })).plan()).toEqual({ arm: false, reason: "switched_off" });
  });

  it("arms nothing and promises no day before ITS has confirmed the company", async () => {
    const plan = await (await person({})).plan();
    expect(plan).toEqual({ arm: false, reason: "company_not_checked" });
    expect(plan).not.toHaveProperty("dueAt");
  });

  it("arms nothing for someone who already had their one set, being prepared or sent; a set that never went does not count", async () => {
    const preparing = await person();
    await earlierSet(preparing, "preparing");
    expect(await preparing.plan()).toEqual({ arm: false, reason: "already_used" });
    const sent = await person();
    await earlierSet(sent, "sent");
    // already used is read before the reschedule limit
    expect(await sent.plan(MAX_CANDIDATE_RESCHEDULES)).toEqual({ arm: false, reason: "already_used" });
    const never = await person();
    await earlierSet(never, "not_sent");
    expect((await never.plan()).arm).toBe(true);
  });

  it("arms nothing after both of the candidate's own reschedules: a person arranges the time", async () => {
    const p = await person();
    expect((await p.plan(MAX_CANDIDATE_RESCHEDULES - 1)).arm).toBe(true);
    expect(await p.plan(MAX_CANDIDATE_RESCHEDULES)).toEqual({ arm: false, reason: "reschedules_used" });
  });

  it("arms nothing while an ITS recruiter is running the role", async () => {
    const p = await person();
    await handle.db.execute(sql`INSERT INTO takeovers (id, company_id, role_id, recruiter_user_id, status) VALUES (${randomUUID()}, ${p.companyId}, ${p.roleId}, ${ownerId}, 'active')`);
    expect(await p.plan()).toEqual({ arm: false, reason: "takeover" });
  });

  it("arms nothing for someone a person had put on hold", async () => {
    const p = await person();
    await tenant(p.companyId, (tx) => setMark(tx, { companyId: p.companyId, app: { id: p.applicationId, stage: "interview_scheduled" }, mark: "on_hold", actor: owner, now: FRIDAY_2PM }));
    expect(await p.plan()).toEqual({ arm: false, reason: "was_on_hold" });
  });
});

describe("people under Cancelled and the team's other nudges", () => {
  let handle: DbHandle;
  const NOW = new Date("2026-11-20T18:00:00.000Z");
  const DAY = 86_400_000;
  const companyId = randomUUID();
  const roleId = randomUUID();
  const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, companyId, fn);

  /** Someone recommended for interview five days ago, who applied 31 days ago; under Cancelled when `auto` is given. */
  async function applicant(first: string, auto?: FollowUpEntryAuto) {
    const candidateId = randomUUID();
    const applicationId = randomUUID();
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${candidateId}, ${companyId}, ${first}, 'Lopez', ${`${first}-${candidateId}@example.com`}, 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage, stage_changed_at, created_at) VALUES (${applicationId}, ${companyId}, ${roleId}, ${candidateId}, 1, 'direct', ${`tok-${applicationId}`}, 'interview_recommended', ${new Date(NOW.getTime() - 5 * DAY).toISOString()}, ${new Date(NOW.getTime() - 31 * DAY).toISOString()})`);
    if (auto) {
      const interviewId = randomUUID();
      await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, attempt) VALUES (${interviewId}, ${companyId}, ${applicationId}, 'owner', 'Conversation with the dentist', 'video', 30, 'cancelled', 2)`);
      await tenant((tx) => openFollowUp(tx, { companyId, applicationId, interviewId, interviewAttempt: 2, kind: "candidate_cancelled", choice: auto.state === "waiting" ? "new_times" : "not_interested", auto, actor: { kind: "candidate", id: candidateId }, now: new Date(NOW.getTime() - 5 * DAY) }));
    }
    await handle.db.execute(sql`INSERT INTO approval_requests (id, company_id, role_id, application_id, action_type, subject, rationale, requested_by, created_at) VALUES (${randomUUID()}, ${companyId}, ${roleId}, ${applicationId}, 'application.recommend_interview', ${JSON.stringify({ type: "application", id: applicationId })}::jsonb, ${`Interview ${first}`}, ${actor}, ${new Date(NOW.getTime() - 3 * DAY).toISOString()})`);
    return applicationId;
  }

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, timezone, settings) VALUES (${companyId}, 'Harbor Dental', ${`harbor-${companyId}`}, 'dental', '20-49', 'America/Los_Angeles', '{"verifiedAt":"2026-09-01T00:00:00.000Z"}'::jsonb)`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${roleId}, ${companyId}, 'Dental Assistant', 'open', ${actor})`);
    await handle.db.execute(sql`INSERT INTO role_packets (id, company_id, role_id, version, packet, status, source, created_by) VALUES (${randomUUID()}, ${companyId}, ${roleId}, 1, ${JSON.stringify(samplePacket())}::jsonb, 'approved', 'intake', ${actor})`);
    // the company chose to send the "still reviewing" note itself
    await handle.db.execute(sql`INSERT INTO policies (id, company_id, action_type, level, created_by) VALUES (${randomUUID()}, ${companyId}, 'message.still_reviewing', 'auto', ${actor})`);
  });
  afterAll(async () => {
    await handle.close();
  });

  it("names only people outside Cancelled as waiting on the team, and parks a promised set's other nudges", async () => {
    const waitingOnTeam = await applicant("Bea");
    const promised = await applicant("Ana", { state: "waiting", dueAt: new Date(NOW.getTime() + DAY).toISOString(), workingDays: 3 });
    const notInterested = await applicant("Cal", { state: "none", reason: "not_asked" });
    const found = await tenant((tx) => detectStuckRoles(tx, companyId, NOW));
    // the Cancelled card on Today names Ana and Cal; the long-wait card never names them as well
    const waiting = found.find((d) => d.detector === "candidates_waiting");
    expect(waiting).toMatchObject({ applicationIds: [waitingOnTeam], title: "1 candidate has been waiting on you for 5 days (Dental Assistant)" });
    expect(waiting?.applicationIds).not.toContain(promised);
    expect(waiting?.applicationIds).not.toContain(notInterested);
    // the approval waiting for Ana is parked until her new times' day; Cal's waits on the team as before
    expect(found.find((d) => d.detector === "approval_pending")?.body.split("; ").sort()).toEqual(["Interview Bea", "Interview Cal"]);
  });

  it("never sends the \"still reviewing\" note to someone under Cancelled", async () => {
    const integrations = createIntegrations({ NODE_ENV: "test", COMP_BLS_ENABLED: "false", STORAGE_PROVIDER: "memory" }, { memoryStorage: true });
    const outside = await applicant("Dee");
    const under = await applicant("Eli", { state: "none", reason: "not_asked" });
    const noted = await tenant((tx) => sendStillReviewingNotes(tx, { integrations, statusBaseUrl: "https://jobs.example", now: NOW, actor: { kind: "system", id: "test" } }, companyId));
    expect(noted).toContain(outside);
    expect(noted).not.toContain(under);
  });
});

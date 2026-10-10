import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import type { Actor, ApplicationStage, CancelNext } from "@ros/contracts";
import { createDb, migrate, rowsOf, withTenant, type DbHandle, type Tx } from "@ros/db";
import {
  activeFollowUpsFor,
  autoReasonText,
  cancelledView,
  candidateNewTimesPromise,
  FollowUpError,
  followUpInMotion,
  followUpParked,
  followUpStripOf,
  inCancelled,
  interviewFollowUpRef,
  newTimesOffered,
  newTimesSettingOf,
  openFollowUp,
  openFollowUpOf,
  pendingNewTimesRows,
  recordAutoRun,
  setAutoState,
  setCurrentInterview,
  type FollowUpEntryAuto,
  type FollowUpRow,
  type FollowUpView,
} from "./interview-followups";
import { setMark } from "./marks";
import { roleTakenOver } from "./policy";
import { exportCandidateData } from "./privacy-requests";
import { ownerStage, transition } from "./stages";

/**
 * The Cancelled column's one module (founder decisions 1A to 4A) against a migrated database: entering is idempotent per
 * entry and ends a hold; booking, leaving or a person's move takes someone out, the system's own moves never do; a
 * decision taken back puts them back, with their promised set when its day is still ahead; the automatic set moves only
 * along its state machine and counts as sent only when its email is on its way; and what a candidate page may promise.
 */
describe("interview follow-ups (the Cancelled column)", () => {
  let handle: DbHandle;
  const companyId = randomUUID();
  const roleId = randomUUID();
  const otherRoleId = randomUUID();
  const ownerId = randomUUID();
  const owner: Actor = { kind: "user", id: ownerId, name: "Olive Owner" };
  const candidate: Actor = { kind: "candidate", id: "candidate" };
  const system: Actor = { kind: "system", id: "workflow:interview_new_times" };
  const NOW = new Date("2026-10-09T21:00:00.000Z"); // Friday 9 October, 14:00 in Los Angeles
  const DUE = "2026-10-15T16:00:00.000Z"; // Thursday 15 October, 09:00 in Los Angeles
  const waiting: FollowUpEntryAuto = { state: "waiting", dueAt: DUE, workingDays: 3 };

  const tenant = <T>(fn: (tx: Tx) => Promise<T>) => withTenant(handle.db, companyId, fn);
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  const eventsOf = (applicationId: string, type: string) => rows<{ payload: Record<string, unknown> }>(sql`SELECT payload FROM events WHERE subject_type = 'application' AND subject_id = ${applicationId} AND type = ${type} ORDER BY id`);
  const followUps = (applicationId: string) => rows<{ id: string; resolved_how: string | null; auto_state: string; auto_reason: string | null }>(sql`SELECT id, resolved_how, auto_state, auto_reason FROM interview_followups WHERE application_id = ${applicationId} ORDER BY created_at, id`);

  /** A candidate and an application at `stage`, with the interview they cancelled (status cancelled, attempt 2). */
  async function person(stage: ApplicationStage, opts: { roleId?: string; candidateId?: string; interview?: "cancelled" | "no_show" } = {}) {
    const candidateId = opts.candidateId ?? randomUUID();
    if (!opts.candidateId) await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, email, first_source) VALUES (${candidateId}, ${companyId}, 'Ana', 'Lopez', ${`ana-${candidateId}@example.com`}, 'direct')`);
    const applicationId = randomUUID();
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${applicationId}, ${companyId}, ${opts.roleId ?? roleId}, ${candidateId}, 1, 'direct', ${`tok-${applicationId}`}, ${stage})`);
    const interviewId = randomUUID();
    await handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, outcome, attempt) VALUES (${interviewId}, ${companyId}, ${applicationId}, 'first', 'First interview', 'video', 30, ${opts.interview ?? "cancelled"}, ${opts.interview === "no_show" ? "no_show_candidate" : null}, 2)`);
    return { candidateId, applicationId, interviewId };
  }
  type Person = Awaited<ReturnType<typeof person>>;

  const cancelled = (p: Person, auto: FollowUpEntryAuto = waiting, choice: CancelNext = "new_times", attempt = 2) =>
    tenant((tx) => openFollowUp(tx, { companyId, applicationId: p.applicationId, interviewId: p.interviewId, interviewAttempt: attempt, kind: "candidate_cancelled", choice, auto, actor: candidate, now: NOW }));
  const noShow = (p: Person) =>
    tenant((tx) => openFollowUp(tx, { companyId, applicationId: p.applicationId, interviewId: p.interviewId, interviewAttempt: 2, kind: "candidate_no_show", choice: null, auto: { state: "none", reason: "no_show" }, actor: owner, now: NOW }));
  const view = async (p: Person) => (await tenant((tx) => activeFollowUpsFor(tx, [p.applicationId]))).get(p.applicationId) ?? null;
  /** The interview that carries their new times: reopened for scheduling, as `reopenForNewTimes` leaves it. */
  async function reopened(p: Person, row: FollowUpRow) {
    await handle.db.execute(sql`UPDATE interviews SET status = 'scheduling', attempt = 3 WHERE id = ${p.interviewId}`);
    await tenant((tx) => setCurrentInterview(tx, { followUpId: row.id, interviewId: p.interviewId }));
  }
  const slotsEmail = (p: Person, status: string) =>
    handle.db.execute(sql`INSERT INTO communications (id, company_id, candidate_id, application_id, direction, channel, body_text, sent_by, template_key, status, idempotency_key) VALUES (${randomUUID()}, ${companyId}, ${p.candidateId}, ${p.applicationId}, 'outbound', 'email', 'Pick a time', ${sql`'{"kind":"system","id":"s"}'::jsonb`}, 'interview_slots', ${status}, ${`slots:${p.interviewId}:3`})`);

  beforeAll(async () => {
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle);
    const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, timezone) VALUES (${companyId}, 'Bright Dental', ${`bright-${companyId}`}, 'dental', '20-49', 'America/Los_Angeles')`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${roleId}, ${companyId}, 'Hygienist', 'open', ${actor})`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${otherRoleId}, ${companyId}, 'Front desk', 'open', ${actor})`);
    await handle.db.execute(sql`INSERT INTO users (id, email, name) VALUES (${ownerId}, ${`olive-${ownerId}@example.com`}, 'Olive Owner')`);
    await handle.db.execute(sql`INSERT INTO memberships (id, company_id, user_id, role) VALUES (${randomUUID()}, ${companyId}, ${ownerId}, 'owner')`);
  });
  afterAll(async () => {
    await handle.close();
  });

  describe("going under Cancelled", () => {
    it("writes one row per entry: the same cancel twice returns the row already written, records one event and leaves the set waiting", async () => {
      const p = await person("interview_recommended");
      const first = await cancelled(p);
      expect(first.created).toBe(true);
      const again = await cancelled(p);
      expect(again).toMatchObject({ created: false, row: { id: first.row.id, autoState: "waiting", resolvedAt: null } });
      const moved = await eventsOf(p.applicationId, "application.moved_to_cancelled");
      expect(moved).toHaveLength(1);
      expect(moved[0].payload).toMatchObject({ followUpId: first.row.id, interviewId: p.interviewId, reason: "asked_new_times", auto: { state: "waiting", reason: null, dueAt: DUE, workingDays: 3 } });
      expect(await followUps(p.applicationId)).toEqual([{ id: first.row.id, resolved_how: null, auto_state: "waiting", auto_reason: null }]);
    });

    it("replaces an open row of another entry (superseded), and its pending set does not go", async () => {
      const p = await person("interview_recommended");
      const first = await cancelled(p);
      const second = await cancelled(p, { state: "none", reason: "not_asked" }, "not_interested", 4);
      expect(second.created).toBe(true);
      expect(await followUps(p.applicationId)).toEqual([
        { id: first.row.id, resolved_how: "superseded", auto_state: "not_sent", auto_reason: "interview_changed" },
        { id: second.row.id, resolved_how: null, auto_state: "none", auto_reason: "not_asked" },
      ]);
      expect((await eventsOf(p.applicationId, "interview.new_times_not_sent"))[0].payload).toEqual({ followUpId: first.row.id, reason: "interview_changed", from: "waiting" });
      expect((await eventsOf(p.applicationId, "application.left_cancelled"))[0].payload).toEqual({ followUpId: first.row.id, how: "superseded", autoStopped: true });
    });

    it("ends a person's hold: a Cancelled entry and a private mark never coexist", async () => {
      const p = await person("interview_recommended");
      await tenant((tx) => setMark(tx, { companyId, app: { id: p.applicationId, stage: "interview_recommended" }, mark: "on_hold", actor: owner, now: NOW }));
      await cancelled(p, { state: "none", reason: "was_on_hold" });
      const marks = await rows<{ cleared_at: string | null; clear_reason: string | null }>(sql`SELECT cleared_at, clear_reason FROM application_marks WHERE application_id = ${p.applicationId}`);
      expect(marks).toHaveLength(1);
      expect(marks[0].cleared_at).not.toBeNull();
      expect(marks[0].clear_reason).toBe("moved to Cancelled");
      expect((await eventsOf(p.applicationId, "application.mark_cleared")).at(-1)?.payload).toMatchObject({ mark: "on_hold", reason: "moved_on", to: "cancelled" });
      const v = await view(p);
      expect(v && ownerStage({ stage: "interview_recommended" }, null, v)).toBe("cancelled");
    });

    it("writes a no-show with no choice and nothing armed, and refuses anyone not recommended for interview or interview done", async () => {
      const p = await person("interview_complete", { interview: "no_show" });
      const { row } = await noShow(p);
      expect(row).toMatchObject({ kind: "candidate_no_show", choice: null, autoState: "none", autoReason: "no_show" });
      const q = await person("interview_scheduled");
      await expect(cancelled(q)).rejects.toThrow(FollowUpError);
      expect(await followUps(q.applicationId)).toEqual([]);
    });
  });

  describe("leaving through a stage move", () => {
    it("resolves on booking a time (the system's own booking included), on a person's move and on leaving the process", async () => {
      const booked = await person("interview_recommended");
      await cancelled(booked);
      await tenant((tx) => transition(tx, { applicationId: booked.applicationId, companyId, to: "interview_scheduled", by: "system", actor: system, now: NOW }));
      expect(await followUps(booked.applicationId)).toEqual([expect.objectContaining({ resolved_how: "rebooked", auto_state: "not_sent", auto_reason: "team_acted" })]);

      const moved = await person("interview_complete", { interview: "no_show" });
      await noShow(moved);
      await tenant((tx) => transition(tx, { applicationId: moved.applicationId, companyId, to: "finalist", by: "owner", actor: owner, now: NOW }));
      expect(await followUps(moved.applicationId)).toEqual([expect.objectContaining({ resolved_how: "moved_by_team", auto_state: "none" })]);
      expect((await eventsOf(moved.applicationId, "application.left_cancelled"))[0].payload).toMatchObject({ how: "moved_by_team", autoStopped: false });

      const withdrew = await person("interview_recommended");
      await cancelled(withdrew);
      await tenant((tx) => transition(tx, { applicationId: withdrew.applicationId, companyId, to: "withdrawn", by: "candidate", actor: candidate, now: NOW }));
      expect(await followUps(withdrew.applicationId)).toEqual([expect.objectContaining({ resolved_how: "left_process", auto_state: "not_sent", auto_reason: "left_process" })]);
    });

    it("never resolves on the system's own moves back to recommended or to interview done", async () => {
      for (const to of ["interview_recommended", "interview_complete"] as const) {
        const p = await person("interview_recommended");
        const { row } = await cancelled(p);
        await handle.db.execute(sql`UPDATE applications SET stage = 'interview_scheduled' WHERE id = ${p.applicationId}`);
        await tenant((tx) => transition(tx, { applicationId: p.applicationId, companyId, to, by: "system", actor: system, now: NOW }));
        expect(await followUps(p.applicationId), to).toEqual([{ id: row.id, resolved_how: null, auto_state: "waiting", auto_reason: null }]);
      }
    });

    it("takes someone a person puts on hold out of Cancelled, and nothing goes to them automatically", async () => {
      const p = await person("interview_recommended");
      await cancelled(p);
      const { mark } = await tenant((tx) => setMark(tx, { companyId, app: { id: p.applicationId, stage: "interview_recommended" }, mark: "on_hold", actor: owner, now: NOW }));
      expect(await followUps(p.applicationId)).toEqual([expect.objectContaining({ resolved_how: "moved_by_team", auto_state: "not_sent", auto_reason: "team_acted" })]);
      expect(await view(p)).toBeNull();
      expect(ownerStage({ stage: "interview_recommended" }, mark, null)).toBe("on_hold");
    });
  });

  describe("a decision taken back before the candidate was told", () => {
    async function declinedFromCancelled(runStatus: string) {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      const runId = randomUUID();
      await handle.db.execute(sql`INSERT INTO workflow_runs (id, company_id, workflow_key, subject, status, current_step) VALUES (${runId}, ${companyId}, 'interview_new_times', ${JSON.stringify({ type: "application", id: p.applicationId })}::jsonb, ${runStatus}, 'wait')`);
      await tenant((tx) => recordAutoRun(tx, { followUpId: row.id, runId }));
      await tenant((tx) => transition(tx, { applicationId: p.applicationId, companyId, to: "rejected", by: "owner", actor: owner, now: NOW }));
      expect(await followUps(p.applicationId)).toEqual([{ id: row.id, resolved_how: "left_process", auto_state: "not_sent", auto_reason: "left_process" }]);
      return { p, row };
    }
    const undo = (p: Person, now: Date) => tenant((tx) => transition(tx, { applicationId: p.applicationId, companyId, to: "interview_recommended", by: "owner", actor: owner, undoDecision: true, now }));

    it("before the promised day: the same row is open again and the set waits for its day, its run still waiting", async () => {
      const { p, row } = await declinedFromCancelled("waiting");
      await undo(p, new Date("2026-10-12T17:00:00Z"));
      expect(await followUps(p.applicationId)).toEqual([{ id: row.id, resolved_how: null, auto_state: "waiting", auto_reason: null }]);
      expect((await eventsOf(p.applicationId, "application.moved_to_cancelled")).at(-1)?.payload).toMatchObject({ followUpId: row.id, restored: true, reason: "asked_new_times", auto: { state: "waiting", dueAt: DUE } });
      const v = await view(p);
      expect(v && ownerStage({ stage: "interview_recommended" }, null, v)).toBe("cancelled");
    });

    it("after the promised day: back under Cancelled, nothing was sent, and the team decides", async () => {
      const { p, row } = await declinedFromCancelled("waiting");
      await undo(p, new Date("2026-10-16T17:00:00Z"));
      expect(await followUps(p.applicationId)).toEqual([{ id: row.id, resolved_how: null, auto_state: "not_sent", auto_reason: "left_process" }]);
      const v = await view(p);
      expect(v && cancelledView(v, { timeZone: "America/Los_Angeles" })).toMatchObject({ status: "Waiting for you", auto: { state: "not_sent", reasonText: "Nothing went automatically while a decision was in place." } });
    });

    it("keeps the set not sent when its timer run no longer waits", async () => {
      const { p, row } = await declinedFromCancelled("completed");
      await undo(p, new Date("2026-10-12T17:00:00Z"));
      expect(await followUps(p.applicationId)).toEqual([{ id: row.id, resolved_how: null, auto_state: "not_sent", auto_reason: "left_process" }]);
    });

    it("keeps the set not sent when automatic times were switched off in the meantime: Setup never asked about it", async () => {
      const { p, row } = await declinedFromCancelled("waiting");
      await handle.db.execute(sql`UPDATE companies SET settings = settings || '{"newTimesAfterCancel":{"auto":false,"workingDays":3}}'::jsonb WHERE id = ${companyId}`);
      try {
        await undo(p, new Date("2026-10-12T17:00:00Z"));
        expect(await followUps(p.applicationId)).toEqual([{ id: row.id, resolved_how: null, auto_state: "not_sent", auto_reason: "left_process" }]);
        const v = await view(p);
        expect(v && ownerStage({ stage: "interview_recommended" }, null, v)).toBe("cancelled");
      } finally {
        await handle.db.execute(sql`UPDATE companies SET settings = settings - 'newTimesAfterCancel' WHERE id = ${companyId}`);
      }
    });

    it("puts nobody under Cancelled who was declined from Interviewing", async () => {
      const p = await person("interview_recommended");
      await tenant((tx) => transition(tx, { applicationId: p.applicationId, companyId, to: "rejected", by: "owner", actor: owner, now: NOW }));
      await undo(p, NOW);
      expect(await followUps(p.applicationId)).toEqual([]);
      expect(await view(p)).toBeNull();
    });
  });

  describe("the automatic set's state machine", () => {
    it("moves along waiting, waiting for the ITS check, being prepared and sent, and refuses every other move", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      const move = (to: FollowUpRow["autoState"], reason?: FollowUpRow["autoReason"]) => tenant((tx) => setAutoState(tx, { followUpId: row.id, to, reason, actor: system, now: NOW }));
      await expect(move("sent")).rejects.toThrow(/cannot go from waiting to sent/);
      await expect(move("not_sent")).rejects.toThrow(FollowUpError);
      await expect(move("not_sent", "not_asked")).rejects.toThrow(FollowUpError);
      await expect(move("none")).rejects.toThrow(FollowUpError);
      expect((await move("waiting_check")).autoState).toBe("waiting_check");
      expect((await move("preparing")).autoState).toBe("preparing");
      // from being prepared only these reasons end it: no email, the team acted, they left, the interview changed
      await expect(move("not_sent", "takeover")).rejects.toThrow(FollowUpError);
      await expect(move("waiting")).rejects.toThrow(FollowUpError);
      const sent = await move("sent");
      expect(sent.autoState).toBe("sent");
      expect(sent.autoSentAt).not.toBeNull();
      // sent is final
      for (const [to, reason] of [["not_sent", "team_acted"], ["waiting", null], ["preparing", null]] as const) await expect(move(to, reason)).rejects.toThrow(FollowUpError);
    });

    it("never moves a set that did not go back to waiting, whatever the reason; only the undo does", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      await tenant((tx) => setAutoState(tx, { followUpId: row.id, to: "not_sent", reason: "left_process", actor: owner, now: NOW }));
      await expect(tenant((tx) => setAutoState(tx, { followUpId: row.id, to: "waiting", actor: owner, now: NOW }))).rejects.toThrow(FollowUpError);
      const none = await person("interview_recommended");
      const n = await cancelled(none, { state: "none", reason: "switched_off" });
      await expect(tenant((tx) => setAutoState(tx, { followUpId: n.row.id, to: "waiting", actor: owner, now: NOW }))).rejects.toThrow(FollowUpError);
      const other = await cancelled(await person("interview_recommended"));
      const stopped = await tenant((tx) => setAutoState(tx, { followUpId: other.row.id, to: "not_sent", reason: "stopped_by_team", actor: owner, now: NOW }));
      expect(stopped).toMatchObject({ autoState: "not_sent", autoReason: "stopped_by_team" });
    });

    it("lists the sets already promised a day, for Setup to ask about before switching off", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      const pending = await tenant((tx) => pendingNewTimesRows(tx, companyId, { lock: true }));
      expect(pending.map((r) => r.id)).toContain(row.id);
      expect(pending.every((r) => r.autoState === "waiting" || r.autoState === "waiting_check")).toBe(true);
    });
  });

  describe("where the new times stand", () => {
    it("reads nothing in motion, being prepared, held, out, not reached and lapsed from the interview and its slots email", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p, { state: "none", reason: "switched_off" });
      expect(await view(p)).toMatchObject({ times: "none", interviewOpen: false, reason: "asked_new_times", autoState: "none", autoReason: "switched_off" });
      await reopened(p, row);
      expect(await view(p)).toMatchObject({ times: "preparing", interviewOpen: true, currentInterviewId: p.interviewId });
      await slotsEmail(p, "held");
      expect(await view(p)).toMatchObject({ times: "held", interviewOpen: true });
      await handle.db.execute(sql`UPDATE communications SET status = 'queued' WHERE idempotency_key = ${`slots:${p.interviewId}:3`}`);
      expect(await view(p)).toMatchObject({ times: "out", interviewOpen: true });
      await handle.db.execute(sql`UPDATE communications SET status = 'bounced' WHERE idempotency_key = ${`slots:${p.interviewId}:3`}`);
      expect(await view(p)).toMatchObject({ times: "not_reached", interviewOpen: true });
      await handle.db.execute(sql`UPDATE interviews SET status = 'offer_expired' WHERE id = ${p.interviewId}`);
      expect(await view(p)).toMatchObject({ times: "expired", interviewOpen: false });
    });
  });

  describe("counting new times as sent", () => {
    it("counts the automatic set as sent once its email is queued, once per offer, and tells the team", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      await tenant((tx) => setAutoState(tx, { followUpId: row.id, to: "preparing", actor: system, now: NOW }));
      await reopened(p, row);
      const offer = (outcome: "queued" | "held" | "failed", interviewId = p.interviewId) => tenant((tx) => newTimesOffered(tx, { followUpId: row.id, interviewId, attempt: 3, outcome, via: "auto", actor: system, now: new Date(DUE) }));
      expect(await offer("held")).toMatchObject({ counted: false, row: { autoState: "preparing", timesSentCount: 0 } });
      expect(await offer("queued", randomUUID())).toBeNull();
      const sent = await offer("queued");
      expect(sent).toMatchObject({ counted: true, row: { autoState: "sent", timesSentCount: 1, lastSentVia: "auto", lastOfferKey: `slots:${p.interviewId}:3` } });
      expect(sent?.row.autoSentAt).not.toBeNull();
      expect(await offer("queued")).toMatchObject({ counted: false, row: { timesSentCount: 1 } });
      expect(await eventsOf(p.applicationId, "interview.new_times_sent")).toEqual([{ payload: { followUpId: row.id, interviewId: p.interviewId, attempt: 3, via: "auto" } }]);
      const told = await rows<{ title: string; body: string; action: { href: string } }>(sql`SELECT title, body, action FROM notifications WHERE company_id = ${companyId} AND kind = 'interview.new_times_sent'`);
      expect(told).toHaveLength(1);
      expect(told[0].title).toBe("New times went to Ana Lopez");
      expect(told[0].body).toBe("Ana cancelled the First interview and asked for new times. They went out today. This was their one automatic set; if Ana does not pick a time, they stay under Cancelled for you to decide.");
      expect(told[0].action.href).toBe(`/roles/${roleId}/talent?open=${p.applicationId}`);
    });

    it("ends an automatic set being prepared as not sent when its email fails, and tells the team why", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      await tenant((tx) => setAutoState(tx, { followUpId: row.id, to: "preparing", actor: system, now: NOW }));
      await reopened(p, row);
      const failed = await tenant((tx) => newTimesOffered(tx, { followUpId: row.id, interviewId: p.interviewId, attempt: 3, outcome: "failed", via: "auto", actor: system, now: new Date(DUE) }));
      expect(failed).toMatchObject({ counted: false, row: { autoState: "not_sent", autoReason: "no_email", timesSentCount: 0 } });
      const [told] = await rows<{ title: string; body: string }>(sql`SELECT title, body FROM notifications WHERE company_id = ${companyId} AND kind = 'interview.new_times_not_sent'`);
      expect(told.title).toBe("New times for Ana Lopez were not sent");
      expect(told.body).toBe("Ana asked for new times, due Thursday, October 15. We have no email address for them, or the email did not reach them. They are under Cancelled: send new times when you are ready, or decide.");
    });

    it("counts the same interview's times once when the run offers them again after a picked time was taken", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      await tenant((tx) => setAutoState(tx, { followUpId: row.id, to: "preparing", actor: system, now: NOW }));
      await reopened(p, row);
      const offer = (attempt: number, reoffer: boolean) => tenant((tx) => newTimesOffered(tx, { followUpId: row.id, interviewId: p.interviewId, attempt, outcome: "queued", via: "auto", actor: system, now: new Date(DUE), reoffer }));
      expect(await offer(3, false)).toMatchObject({ counted: true, row: { autoState: "sent", timesSentCount: 1 } });
      expect(await offer(4, true)).toMatchObject({ counted: false, row: { autoState: "sent", timesSentCount: 1, lastOfferKey: `slots:${p.interviewId}:4` } });
      expect(await eventsOf(p.applicationId, "interview.new_times_sent")).toHaveLength(1);
      const told = await rows<{ id: string }>(sql`SELECT id FROM notifications WHERE company_id = ${companyId} AND kind = 'interview.new_times_sent' AND action->>'href' = ${`/roles/${roleId}/talent?open=${p.applicationId}`}`);
      expect(told).toHaveLength(1);
      // the same interview reopened again later (a new run) is a new send, and counts
      expect(await offer(5, false)).toMatchObject({ counted: true, row: { timesSentCount: 2 } });
    });

    it("records the promised day in the company's calendar with the entry, for the history", async () => {
      const p = await person("interview_recommended");
      await cancelled(p, { ...waiting, day: "2026-10-15" });
      expect((await eventsOf(p.applicationId, "application.moved_to_cancelled"))[0].payload).toMatchObject({ auto: { state: "waiting", dueAt: DUE, dueDay: "2026-10-15" } });
    });

    it("counts a team send without touching the automatic state", async () => {
      const p = await person("interview_complete", { interview: "no_show" });
      const { row } = await noShow(p);
      await reopened(p, row);
      const sent = await tenant((tx) => newTimesOffered(tx, { followUpId: row.id, interviewId: p.interviewId, attempt: 3, outcome: "queued", via: "person", actor: owner, now: NOW }));
      expect(sent).toMatchObject({ counted: true, row: { autoState: "none", timesSentCount: 1, lastSentVia: "person" } });
      expect((await view(p))?.lastSentAt).toBe(NOW.toISOString());
    });
  });

  describe("what a candidate page may promise", () => {
    const row = (o: Partial<Pick<FollowUpRow, "choice" | "autoState" | "autoReason" | "resolvedAt">>) => ({ choice: "new_times" as const, autoState: "none" as const, autoReason: null, resolvedAt: null, ...o });
    it("promises a date, soon, the team, or says they are no longer interested, only while the row is open", () => {
      expect(candidateNewTimesPromise(row({ autoState: "waiting" }), { applicationClosed: false })).toBe("date");
      expect(candidateNewTimesPromise(row({ autoState: "waiting_check" }), { applicationClosed: false })).toBe("soon");
      expect(candidateNewTimesPromise(row({ autoState: "preparing" }), { applicationClosed: false })).toBe("soon");
      expect(candidateNewTimesPromise(row({ autoState: "none", autoReason: "switched_off" }), { applicationClosed: false })).toBe("team");
      expect(candidateNewTimesPromise(row({ autoState: "not_sent", autoReason: "candidate_replied" }), { applicationClosed: false })).toBe("team");
      expect(candidateNewTimesPromise(row({ choice: "not_interested", autoReason: "not_asked" }), { applicationClosed: false })).toBe("not_interested");
      // the team stopped it, or the row is resolved: nothing is promised
      expect(candidateNewTimesPromise(row({ autoState: "not_sent", autoReason: "stopped_by_team" }), { applicationClosed: false })).toBe("neutral");
      expect(candidateNewTimesPromise(row({ autoState: "waiting", resolvedAt: "2026-10-10T10:00:00Z" }), { applicationClosed: false })).toBe("neutral");
      expect(candidateNewTimesPromise(row({ choice: null, autoReason: "no_show" }), { applicationClosed: false })).toBe("neutral");
    });
    it("promises nothing and reveals nothing once the application is closed (founder decision B6)", () => {
      for (const o of [{ autoState: "waiting" }, { autoState: "waiting_check" }, { autoState: "preparing" }, { autoState: "sent" }, { autoState: "none" }, { choice: "not_interested" }] as const) {
        expect(candidateNewTimesPromise(row(o), { applicationClosed: true })).toBe("neutral");
      }
    });
  });

  describe("the team's view and words", () => {
    const base: FollowUpView = {
      id: "f1", applicationId: "a1", kind: "candidate_cancelled", choice: "new_times", reason: "asked_new_times", autoState: "waiting", autoReason: null, autoDueAt: DUE, autoWorkingDays: 3, autoSentAt: null,
      interviewId: "i1", interviewAttempt: 2, currentInterviewId: null, times: "none", interviewOpen: false, lastSentAt: null, lastSentVia: null, since: NOW.toISOString(),
    };
    const tz = { timeZone: "America/Los_Angeles" };
    it("says where each person stands, with the promised day in the company's time", () => {
      expect(cancelledView(base, tz)).toEqual({
        id: "f1", reason: "asked_new_times", label: "Asked for new times", since: NOW.toISOString(), interviewId: "i1",
        auto: { state: "waiting", reason: null, reasonText: null, dueAt: DUE, dueDay: "2026-10-15", sentAt: null },
        times: "none", lastSentAt: null, lastSentVia: null, status: "New times go out automatically Thu, Oct 15",
      });
      const status = (o: Partial<FollowUpView>) => cancelledView({ ...base, ...o }, tz).status;
      expect(status({ autoState: "waiting_check" })).toBe("New times wait for the ITS company check");
      expect(status({ autoState: "preparing", times: "preparing", interviewOpen: true })).toBe("Getting new times ready");
      expect(status({ autoState: "none", times: "held", interviewOpen: true })).toBe("New times wait for the ITS company check");
      expect(status({ autoState: "sent", times: "out", interviewOpen: true, lastSentAt: "2026-10-15T16:05:00.000Z" })).toBe("New times sent Oct 15, waiting for a pick");
      expect(status({ autoState: "sent", times: "not_reached", interviewOpen: true })).toBe("The new times email did not reach them");
      expect(status({ autoState: "sent", times: "expired" })).toBe("Did not pick a new time");
      expect(status({ autoState: "none", autoReason: "switched_off" })).toBe("Waiting for you");
      expect(cancelledView({ ...base, kind: "candidate_no_show", choice: null, reason: "no_show", autoState: "none", autoReason: "no_show", autoDueAt: null, currentInterviewId: "i2" }, tz)).toMatchObject({ label: "No-show", interviewId: "i2", auto: { dueDay: null, reasonText: null } });
    });
    it("gives the strip, a counted row and an interview summary the same reading", () => {
      expect(followUpStripOf({ kind: null, choice: null, autoState: null, interviewOpen: null })).toBeNull();
      const strip = followUpStripOf({ kind: "candidate_cancelled", choice: "not_interested", autoState: "none", interviewOpen: true });
      expect(strip).toEqual({ reason: "not_interested", autoState: "none", interviewOpen: true });
      expect(strip && followUpInMotion(strip)).toBe(true);
      expect(followUpParked({ autoState: "waiting_check" })).toBe(true);
      expect(followUpParked({ autoState: "preparing" })).toBe(false);
      expect(inCancelled("interview_complete", strip)).toBe(true);
      expect(inCancelled("interview_scheduled", strip)).toBe(false);
      expect(inCancelled("interview_complete", null)).toBe(false);
      expect(interviewFollowUpRef({ ...base, times: "expired" })).toEqual({ id: "f1", reason: "asked_new_times", times: "expired" });
    });
    it("explains why no automatic set went, and says nothing where nothing needs saying", () => {
      expect(autoReasonText("switched_off", { state: "none" })).toBe("Automatic new times are off in Setup.");
      expect(autoReasonText("switched_off", { state: "not_sent" })).toBe("Automatic new times were switched off in Setup.");
      expect(autoReasonText("was_on_hold")).toBe("You had put them on hold, so nothing goes automatically.");
      expect(autoReasonText("candidate_replied")).toBe("They replied to us, so nothing went automatically: read their reply first.");
      expect(autoReasonText("left_process")).toBe("Nothing went automatically while a decision was in place.");
      for (const r of ["not_asked", "no_show", "details_deleted", null]) expect(autoReasonText(r)).toBeNull();
      expect(autoReasonText("left_process", { resolved: true })).toBeNull();
    });
    it("reads the company setting: on after 3 working days when never saved, the days kept within 1 to 10", () => {
      expect(newTimesSettingOf(undefined)).toEqual({ auto: true, workingDays: 3 });
      expect(newTimesSettingOf({})).toEqual({ auto: true, workingDays: 3 });
      expect(newTimesSettingOf({ newTimesAfterCancel: { auto: false, workingDays: 5 } })).toEqual({ auto: false, workingDays: 5 });
      expect(newTimesSettingOf({ newTimesAfterCancel: { auto: true, workingDays: 0 } })).toEqual({ auto: true, workingDays: 1 });
      expect(newTimesSettingOf({ newTimesAfterCancel: { auto: true, workingDays: 42 } })).toEqual({ auto: true, workingDays: 10 });
      expect(newTimesSettingOf({ newTimesAfterCancel: { auto: true, workingDays: 2.6 } })).toEqual({ auto: true, workingDays: 3 });
      expect(newTimesSettingOf({ newTimesAfterCancel: { auto: true, workingDays: Number.NaN } })).toEqual({ auto: true, workingDays: 3 });
    });
  });

  describe("around the column", () => {
    it("gives the person their own choice in a data export, never the team's no-show record", async () => {
      const p = await person("interview_recommended");
      await cancelled(p, { state: "none", reason: "not_asked" }, "not_interested");
      const q = await person("interview_complete", { roleId: otherRoleId, candidateId: p.candidateId, interview: "no_show" });
      await noShow(q);
      const bundle = await tenant((tx) => exportCandidateData(tx, companyId, p.candidateId));
      expect(bundle.interviewCancellations).toEqual([{ applicationId: p.applicationId, at: NOW.toISOString(), choice: "not_interested" }]);
    });

    it("knows when an ITS recruiter is running the role", async () => {
      expect(await tenant((tx) => roleTakenOver(tx, companyId, roleId))).toBe(false);
      const takeoverId = randomUUID();
      await handle.db.execute(sql`INSERT INTO takeovers (id, company_id, role_id, recruiter_user_id, status) VALUES (${takeoverId}, ${companyId}, ${roleId}, ${ownerId}, 'active')`);
      expect(await tenant((tx) => roleTakenOver(tx, companyId, roleId))).toBe(true);
      expect(await tenant((tx) => roleTakenOver(tx, companyId, otherRoleId))).toBe(false);
      await handle.db.execute(sql`UPDATE takeovers SET status = 'ended', ended_at = now() WHERE id = ${takeoverId}`);
      expect(await tenant((tx) => roleTakenOver(tx, companyId, roleId))).toBe(false);
    });

    it("reads the open row, locked when asked", async () => {
      const p = await person("interview_recommended");
      const { row } = await cancelled(p);
      expect((await tenant((tx) => openFollowUpOf(tx, p.applicationId, { lock: true })))?.id).toBe(row.id);
      expect(await tenant((tx) => openFollowUpOf(tx, randomUUID()))).toBeNull();
    });
  });
});

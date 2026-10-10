import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";

/**
 * Migration 0035 (founder decisions 1A to 4A): the Cancelled column's table on data that existed before it. Its row
 * policy and grants (resolved, never deleted); the CHECKs that hold 2A and 4A in the database (a choice only for a
 * candidate's cancel, automatic times only for someone who asked); one open row and one automatic set per person; and the
 * backfill, which puts only undecided candidate no-shows under Cancelled, each with one history event, and never invents
 * a choice for an earlier candidate cancellation.
 */
describe("migration 0035: interview follow-ups (the Cancelled column)", () => {
  let handle: DbHandle;
  let dir = "";
  const ids = { company: "11111111-1111-4111-8111-111111111111", open: "22222222-2222-4222-8222-222222222222", closed: "22222222-2222-4222-8222-222222222223" };
  const app = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;
  const cand = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;
  const iv = (n: number, k = 0) => `55555555-5555-4555-8555-5555555555${k}${n}`;
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
  const refused = (q: ReturnType<typeof sql>) => handle.db.execute(q).then(() => null, (e: unknown) => e);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0035-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0035")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${ids.company}, 'Old Dental', 'old-dental', 'dental', '20-49')`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${ids.open}, ${ids.company}, 'Hygienist', 'open', ${actor})`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${ids.closed}, ${ids.company}, 'Front desk', 'closed', ${actor})`);
    // 1 an undecided candidate no-show (goes in); 2 a decided one; 3 one with a newer interview; 4 one with a hold; 5 one
    // on a closed role; 6 an earlier candidate cancellation; 7 an interviewer no-show
    const stages = ["interview_complete", "interview_complete", "interview_complete", "interview_complete", "interview_complete", "interview_recommended", "interview_complete"];
    for (let n = 1; n <= 7; n++) {
      await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, first_source) VALUES (${cand(n)}, ${ids.company}, ${`C${n}`}, 'Old', 'direct')`);
      await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${app(n)}, ${ids.company}, ${n === 5 ? ids.closed : ids.open}, ${cand(n)}, 1, 'direct', ${`tok${n}xxxxxxxxxxxx`}, ${stages[n - 1]})`);
    }
    const interview = (n: number, k: number, status: string, extra: { outcome?: string | null; decision?: string | null; cancelReason?: string | null; createdAt?: string } = {}) =>
      handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, outcome, decision, cancel_reason, attempt, created_at) VALUES (${iv(n, k)}, ${ids.company}, ${app(n)}, 'first', 'First interview', 'video', 30, ${status}, ${extra.outcome ?? null}, ${extra.decision ?? null}, ${extra.cancelReason ?? null}, 1, ${extra.createdAt ?? "2026-09-20T10:00:00Z"})`);
    await interview(1, 0, "no_show", { outcome: "no_show_candidate" });
    await interview(2, 0, "no_show", { outcome: "no_show_candidate", decision: "not_moving_forward" });
    await interview(3, 0, "no_show", { outcome: "no_show_candidate" });
    await interview(3, 1, "scheduling", { createdAt: "2026-09-25T10:00:00Z" });
    await interview(4, 0, "no_show", { outcome: "no_show_candidate" });
    await interview(5, 0, "no_show", { outcome: "no_show_candidate" });
    await interview(6, 0, "cancelled", { cancelReason: "cancelled by the candidate: other offer" });
    await interview(7, 0, "no_show", { outcome: "no_show_interviewer" });
    await handle.db.execute(sql`INSERT INTO application_marks (id, company_id, application_id, mark, remind_at, set_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(4)}, 'on_hold', '2026-10-30T15:00:00Z', ${actor})`);
    copyFileSync(join(MIGRATIONS_DIR, "0035_interview_followups.sql"), join(dir, "0035_interview_followups.sql"));
    expect(await migrate(handle, { dir })).toEqual(["0035_interview_followups.sql"]);
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills only an undecided candidate no-show still at interview done, with no newer interview, no mark and an open role", async () => {
    const added = await rows<{ application_id: string; interview_id: string; kind: string; choice: string | null; auto_state: string; auto_reason: string; resolved_at: string | null; created_by: { id: string } }>(sql`SELECT application_id, interview_id, kind, choice, auto_state, auto_reason, resolved_at, created_by FROM interview_followups`);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ application_id: app(1), interview_id: iv(1), kind: "candidate_no_show", choice: null, auto_state: "none", auto_reason: "no_show", resolved_at: null });
    expect(added[0].created_by.id).toBe("migration_0035");
  });

  it("records each backfilled row once in the history, and nothing else", async () => {
    const [row] = await rows<{ id: string }>(sql`SELECT id FROM interview_followups`);
    const recorded = await rows<{ subject_type: string; subject_id: string; payload: { followUpId: string; interviewId: string; reason: string; backfill: boolean; auto: { state: string } } }>(sql`SELECT subject_type, subject_id, payload FROM events WHERE type = 'application.moved_to_cancelled'`);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ subject_type: "application", subject_id: app(1), payload: { followUpId: row.id, interviewId: iv(1), reason: "no_show", backfill: true, auto: { state: "none" } } });
  });

  it("isolates tenants with row-level security and a policy on the company id", async () => {
    const [rls] = await rows<{ relrowsecurity: boolean }>(sql`SELECT relrowsecurity FROM pg_class WHERE relname = 'interview_followups'`);
    expect(rls.relrowsecurity).toBe(true);
    const policies = await rows<{ policyname: string; qual: string }>(sql`SELECT policyname, qual FROM pg_policies WHERE tablename = 'interview_followups'`);
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
    expect(policies[0].qual).toMatch(/app\.company_id/);
    const other = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_tenant`);
      await tx.execute(sql`SELECT set_config('app.company_id', '99999999-9999-4999-8999-999999999999', true)`);
      return rowsOf(await tx.execute(sql`SELECT id FROM interview_followups`));
    });
    expect(other).toHaveLength(0);
  });

  it("resolves rows and never deletes them: no application role may DELETE", async () => {
    for (const role of ["app_tenant", "ros_app", "ros_worker"]) {
      const [p] = await rows<{ s: boolean; i: boolean; u: boolean; d: boolean }>(sql`SELECT has_table_privilege(${role}, 'interview_followups', 'SELECT') AS s, has_table_privilege(${role}, 'interview_followups', 'INSERT') AS i, has_table_privilege(${role}, 'interview_followups', 'UPDATE') AS u, has_table_privilege(${role}, 'interview_followups', 'DELETE') AS d`);
      expect(p, role).toEqual({ s: true, i: true, u: true, d: false });
    }
    const denied = await handle.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_tenant`);
      await tx.execute(sql`SELECT set_config('app.company_id', ${ids.company}, true)`);
      await tx.execute(sql`DELETE FROM interview_followups WHERE application_id = ${app(1)}`);
    }).then(() => null, (e: unknown) => e);
    expect(denied).toBeInstanceOf(Error);
    expect(await rows(sql`SELECT id FROM interview_followups`)).toHaveLength(1);
  });

  const insert = (o: { app: number; iv: number; k?: number; attempt?: number; kind: string; choice: string | null; state?: string; dueAt?: string | null; days?: number | null; sentAt?: string | null; resolved?: boolean }) =>
    sql`INSERT INTO interview_followups (id, company_id, application_id, interview_id, interview_attempt, kind, choice, auto_state, auto_due_at, auto_working_days, auto_sent_at, resolved_at, resolved_how, created_by)
      VALUES (gen_random_uuid(), ${ids.company}, ${app(o.app)}, ${iv(o.iv, o.k ?? 0)}, ${o.attempt ?? 2}, ${o.kind}, ${o.choice}, ${o.state ?? "none"}, ${o.dueAt ?? null}, ${o.days ?? null}, ${o.sentAt ?? null},
        ${o.resolved ? "2026-10-01T10:00:00Z" : null}, ${o.resolved ? "rebooked" : null}, ${actor})`;

  it("holds decisions 2A and 4A in the database: a choice only with a candidate's cancel, automatic times only for someone who asked", async () => {
    const due = "2026-10-15T16:00:00Z";
    // a no-show never carries a choice, and never an automatic set
    expect(await refused(insert({ app: 2, iv: 2, kind: "candidate_no_show", choice: "new_times" }))).toBeInstanceOf(Error);
    expect(await refused(insert({ app: 2, iv: 2, kind: "candidate_no_show", choice: null, state: "waiting", dueAt: due, days: 3 }))).toBeInstanceOf(Error);
    // a candidate's cancel always carries their choice; "no longer interested" never gets an automatic set
    expect(await refused(insert({ app: 6, iv: 6, kind: "candidate_cancelled", choice: null }))).toBeInstanceOf(Error);
    expect(await refused(insert({ app: 6, iv: 6, kind: "candidate_cancelled", choice: "not_interested", state: "waiting", dueAt: due, days: 3 }))).toBeInstanceOf(Error);
    // a promised set always has its day; a sent one, when it went; working days stay within 1 to 10
    expect(await refused(insert({ app: 6, iv: 6, kind: "candidate_cancelled", choice: "new_times", state: "waiting", days: 3 }))).toBeInstanceOf(Error);
    expect(await refused(insert({ app: 6, iv: 6, kind: "candidate_cancelled", choice: "new_times", state: "sent" }))).toBeInstanceOf(Error);
    expect(await refused(insert({ app: 6, iv: 6, kind: "candidate_cancelled", choice: "new_times", state: "waiting", dueAt: due, days: 11 }))).toBeInstanceOf(Error);
    expect(await refused(sql`INSERT INTO interview_followups (id, company_id, application_id, interview_id, interview_attempt, kind, choice, resolved_at, created_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(6)}, ${iv(6)}, 2, 'candidate_cancelled', 'new_times', now(), ${actor})`)).toBeInstanceOf(Error);
    expect(await rows(sql`SELECT id FROM interview_followups WHERE application_id IN (${app(2)}, ${app(6)})`)).toHaveLength(0);
  });

  it("keeps someone in the column once, and the same entry written once", async () => {
    // app 1 is already under Cancelled from the backfill
    expect(await refused(insert({ app: 1, iv: 1, attempt: 7, kind: "candidate_no_show", choice: null }))).toBeInstanceOf(Error);
    await handle.db.execute(insert({ app: 7, iv: 7, kind: "candidate_no_show", choice: null }));
    expect(await refused(insert({ app: 7, iv: 7, kind: "candidate_no_show", choice: null, resolved: true }))).toBeInstanceOf(Error);
  });

  it("allows one automatic set per person, ever: a second sent set, or one beside a set being prepared, is refused", async () => {
    const due = "2026-10-15T16:00:00Z";
    await handle.db.execute(insert({ app: 6, iv: 6, attempt: 2, kind: "candidate_cancelled", choice: "new_times", state: "sent", dueAt: due, days: 3, sentAt: due, resolved: true }));
    expect(await refused(insert({ app: 6, iv: 6, attempt: 4, kind: "candidate_cancelled", choice: "new_times", state: "sent", dueAt: due, days: 3, sentAt: due }))).toBeInstanceOf(Error);
    expect(await refused(insert({ app: 6, iv: 6, attempt: 4, kind: "candidate_cancelled", choice: "new_times", state: "preparing", dueAt: due, days: 3 }))).toBeInstanceOf(Error);
    // a set that never went is not used: the next cancel may be armed
    await handle.db.execute(insert({ app: 3, iv: 3, attempt: 2, kind: "candidate_cancelled", choice: "new_times", state: "not_sent", dueAt: due, days: 3, resolved: true }));
    await handle.db.execute(insert({ app: 3, iv: 3, attempt: 4, kind: "candidate_cancelled", choice: "new_times", state: "preparing", dueAt: due, days: 3 }));
    expect(await rows(sql`SELECT id FROM interview_followups WHERE application_id = ${app(3)}`)).toHaveLength(2);
  });
});

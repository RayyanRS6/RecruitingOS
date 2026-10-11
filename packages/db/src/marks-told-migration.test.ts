import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";

/**
 * Migration 0026 (founder decisions B3 and B6) on data that existed before it: decisions whose decline message left are
 * "sent", one still in the outbox is "queued", one whose message waits for an approver is "not_told", and every other
 * earlier decision (already shown on the candidate's status page) is "before_tracking", recorded as an event; people
 * still in the process keep the default; saved send-at-once decision-message settings move to the new default ("auto":
 * the message goes when a person presses Send), while "Ask me first" and "only a person" stay, and each move is recorded;
 * and the new marks table keeps one active mark per application and a date on every hold.
 */
describe("migration 0026: marks and the told state", () => {
  let handle: DbHandle;
  let dir = "";
  const ids = { company: "11111111-1111-4111-8111-111111111111", role: "22222222-2222-4222-8222-222222222222" };
  const app = (n: number) => `33333333-3333-4333-8333-33333333333${n}`;
  const cand = (n: number) => `44444444-4444-4444-8444-44444444444${n}`;
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0026-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0026")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });
    const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${ids.company}, 'Old Dental', 'old-dental', 'dental', '20-49')`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, created_by) VALUES (${ids.role}, ${ids.company}, 'Hygienist', ${actor})`);
    // 1 declined and told, 2 declined with the message still queued, 3 moved to the talent pool and never sent anything,
    // 4 still in the process with an old message, 5 declined with the message waiting for an approver, 6 declined with a
    // message that failed
    const stages = ["rejected", "rejected", "talent_pool", "triaged", "rejected", "rejected"];
    for (let n = 1; n <= 6; n++) {
      await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, first_source) VALUES (${cand(n)}, ${ids.company}, ${`C${n}`}, 'Old', 'direct')`);
      await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage) VALUES (${app(n)}, ${ids.company}, ${ids.role}, ${cand(n)}, 1, 'direct', ${`tok${n}xxxxxxxxxxxx`}, ${stages[n - 1]})`);
    }
    const message = (n: number, status: string) => handle.db.execute(sql`INSERT INTO communications (id, company_id, application_id, direction, channel, body_text, sent_by, template_key, status, created_at) VALUES (gen_random_uuid(), ${ids.company}, ${app(n)}, 'outbound', 'email', 'Thank you', ${actor}, 'disposition:human', ${status}, '2026-09-01T10:00:00Z')`);
    await message(1, "sent");
    await message(2, "queued");
    await message(4, "sent");
    await message(6, "failed");
    await handle.db.execute(sql`INSERT INTO approval_requests (id, company_id, role_id, application_id, action_type, subject, requested_by) VALUES (gen_random_uuid(), ${ids.company}, ${ids.role}, ${app(5)}, 'disposition.send', ${sql`'{"type":"application"}'::jsonb`}, ${actor})`);
    // saved settings: the company asked first, one role sent at once, another role sends nothing
    const policy = (roleId: string | null, level: string) => handle.db.execute(sql`INSERT INTO policies (id, company_id, role_id, action_type, level, created_by) VALUES (gen_random_uuid(), ${ids.company}, ${roleId}, 'disposition.send', ${level}, ${actor})`);
    await policy(null, "approval");
    await policy(ids.role, "auto_notify");
    await policy("55555555-5555-4555-8555-555555555555", "human_only");
    await handle.db.execute(sql`INSERT INTO policies (id, company_id, role_id, action_type, level, created_by) VALUES (gen_random_uuid(), ${ids.company}, NULL, 'interview.request', 'approval', ${actor})`);
    copyFileSync(join(MIGRATIONS_DIR, "0026_marks_and_told_state.sql"), join(dir, "0026_marks_and_told_state.sql"));
    expect(await migrate(handle, { dir })).toEqual(["0026_marks_and_told_state.sql"]);
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("backfills who was told: messages that left, one still in the outbox, and earlier decisions the status page already showed", async () => {
    const told = await rows<{ id: string; told_state: string; candidate_told_at: string | null }>(sql`SELECT id, told_state, candidate_told_at FROM applications ORDER BY id`);
    expect(told.map((r) => r.told_state)).toEqual(["sent", "queued", "before_tracking", "not_told", "not_told", "before_tracking"]);
    expect(told[0].candidate_told_at).toBeTruthy();
    expect(told[1].candidate_told_at).toBeNull();
    // counted as told from when the decision was made; nothing will ever list them as "not told yet"
    expect(told[2].candidate_told_at).toBeTruthy();
    expect(told[5].candidate_told_at).toBeTruthy();
    const recorded = await rows<{ subject_id: string; payload: { how: string } }>(sql`SELECT subject_id, payload FROM events WHERE type = 'application.told' ORDER BY subject_id`);
    expect(recorded.map((e) => [e.subject_id, e.payload.how])).toEqual([[app(3), "before_tracking"], [app(6), "before_tracking"]]);
  });

  it("moves saved send-at-once decision-message settings to the new default, keeps 'Ask me first' and 'only a person', and records each move", async () => {
    const levels = await rows<{ role_id: string | null; action_type: string; level: string }>(sql`SELECT role_id, action_type, level FROM policies ORDER BY action_type, level`);
    expect(levels.filter((p) => p.action_type === "disposition.send").map((p) => p.level).sort()).toEqual(["approval", "auto", "human_only"]);
    expect(levels.find((p) => p.action_type === "interview.request")?.level).toBe("approval");
    const moved = await rows<{ payload: { previous: string; level: string } }>(sql`SELECT payload FROM events WHERE type = 'policy.changed' ORDER BY id`);
    expect(moved.map((e) => e.payload.previous).sort()).toEqual(["auto_notify"]);
    expect(moved.every((e) => e.payload.level === "auto")).toBe(true);
  });

  it("keeps one active mark per application, and a date on every hold", async () => {
    const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
    await handle.db.execute(sql`INSERT INTO application_marks (id, company_id, application_id, mark, set_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(4)}, 'shortlist', ${actor})`);
    await expect(handle.db.execute(sql`INSERT INTO application_marks (id, company_id, application_id, mark, set_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(4)}, 'longlist', ${actor})`)).rejects.toThrow();
    await handle.db.execute(sql`UPDATE application_marks SET cleared_at = now() WHERE application_id = ${app(4)}`);
    await handle.db.execute(sql`INSERT INTO application_marks (id, company_id, application_id, mark, set_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(4)}, 'longlist', ${actor})`);
    await expect(handle.db.execute(sql`INSERT INTO application_marks (id, company_id, application_id, mark, set_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(3)}, 'on_hold', ${actor})`)).rejects.toThrow();
    const marks = await rows<{ mark: string; cleared: boolean }>(sql`SELECT mark, cleared_at IS NOT NULL AS cleared FROM application_marks ORDER BY created_at, mark`);
    expect(marks).toHaveLength(2);
  });
});

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";

/**
 * Migration 0037 (the owner, 6 November 2026: a person decides who to interview): on data that existed before it, the
 * people the assistant moved to "Interview to set up" under the old default go back to New, so they can be shortlisted.
 * Only them: a person's move, anyone with an interview or an open follow-up, and a company that chose "Do it and tell me"
 * stay. Each move is recorded once, nobody's waiting time starts again, and nothing is sent or queued.
 */
describe("migration 0037: the people the assistant moved go back to New", () => {
  let handle: DbHandle;
  let dir = "";
  const ids = { company: "11111111-1111-4111-8111-111111111111", chose: "11111111-1111-4111-8111-111111111112", role: "22222222-2222-4222-8222-222222222222", ownRule: "22222222-2222-4222-8222-222222222223", chosenRole: "22222222-2222-4222-8222-222222222224", tightened: "22222222-2222-4222-8222-222222222225" };
  const app = (n: number) => `33333333-3333-4333-8333-3333333333${String(n).padStart(2, "0")}`;
  const cand = (n: number) => `44444444-4444-4444-8444-4444444444${String(n).padStart(2, "0")}`;
  const iv = (n: number) => `55555555-5555-4555-8555-5555555555${String(n).padStart(2, "0")}`;
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  const person = sql`'{"kind":"user","id":"u1"}'::jsonb`;
  const assistant = sql`'{"kind":"system","id":"workflow:screen"}'::jsonb`;
  const waitingSince = "2026-10-20T10:00:00.000Z";
  const stage = async (n: number) => (await rows<{ stage: string }>(sql`SELECT stage FROM applications WHERE id = ${app(n)}`))[0].stage;

  const PEOPLE = {
    moved: 1, // the assistant moved them, and nothing has happened since
    byPerson: 2, // a person moved them
    personAfter: 3, // the assistant moved them; then an interview was cancelled and a person moved them back there
    hadInterview: 4, // the assistant moved them, then a person approved an interview
    openFollowUp: 5, // the assistant moved them, then they cancelled the interview
    movedOn: 6, // the assistant moved them and they have gone on to a booked interview
    noHistory: 7, // nothing says who moved them
    companyChose: 8, // the company chose "Do it and tell me"
    roleChose: 9, // this job's own rule says "Do it"
    roleTightened: 10, // the company chose "Do it", and this job's own rule says "Only a person"
    marked: 11, // the assistant moved them; a Shortlist mark from before their AI interview stays, and now shows
    secondCompany: 12, // the assistant moved them at another company with no saved rule for that job
  } as const;

  const moveEvent = (n: number, actor: ReturnType<typeof sql>, companyId: string = ids.company) => handle.db.execute(sql`INSERT INTO events (company_id, type, actor, subject_type, subject_id, payload) VALUES (${companyId}, 'application.stage_changed', ${actor}, 'application', ${app(n)}, '{"from":"screen_complete","to":"interview_recommended"}'::jsonb)`);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0037-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0037")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });
    const addCompany = (id: string, name: string) => handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${id}, ${name}, ${name.toLowerCase().replace(/ /g, "-")}, 'dental', '20-49')`);
    await addCompany(ids.company, "Old Dental");
    await addCompany(ids.chose, "Chose Dental");
    const addRole = (id: string, companyId: string) => handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${id}, ${companyId}, 'Hygienist', 'open', ${person})`);
    await addRole(ids.role, ids.company);
    await addRole(ids.ownRule, ids.company);
    await addRole(ids.chosenRole, ids.chose);
    await addRole(ids.tightened, ids.chose);
    const add = async (n: number, roleId: string, companyId: string, at = "interview_recommended") => {
      await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, first_source) VALUES (${cand(n)}, ${companyId}, ${`C${n}`}, 'Old', 'direct')`);
      await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage, stage_changed_at) VALUES (${app(n)}, ${companyId}, ${roleId}, ${cand(n)}, 1, 'direct', ${`tok${n}xxxxxxxxxxxx`}, ${at}, ${waitingSince})`);
    };
    for (const n of [PEOPLE.moved, PEOPLE.byPerson, PEOPLE.personAfter, PEOPLE.hadInterview, PEOPLE.openFollowUp, PEOPLE.noHistory, PEOPLE.marked]) await add(n, ids.role, ids.company);
    await add(PEOPLE.movedOn, ids.role, ids.company, "interview_scheduled");
    await add(PEOPLE.roleChose, ids.ownRule, ids.company);
    await add(PEOPLE.companyChose, ids.chosenRole, ids.chose);
    await add(PEOPLE.roleTightened, ids.tightened, ids.chose);
    // another company with no rule saved at all: a person there is moved back, whatever the first company chose
    const third = "11111111-1111-4111-8111-111111111113";
    await addCompany(third, "Third Dental");
    const thirdRole = "22222222-2222-4222-8222-222222222226";
    await addRole(thirdRole, third);
    await add(PEOPLE.secondCompany, thirdRole, third);

    for (const n of [PEOPLE.moved, PEOPLE.personAfter, PEOPLE.hadInterview, PEOPLE.openFollowUp, PEOPLE.movedOn, PEOPLE.roleChose, PEOPLE.marked]) await moveEvent(n, assistant);
    await moveEvent(PEOPLE.byPerson, person);
    await moveEvent(PEOPLE.personAfter, person);
    await moveEvent(PEOPLE.companyChose, assistant, ids.chose);
    await moveEvent(PEOPLE.roleTightened, assistant, ids.chose);
    await moveEvent(PEOPLE.secondCompany, assistant, third);

    const interview = (n: number, status: string) => handle.db.execute(sql`INSERT INTO interviews (id, company_id, application_id, round_key, title, format, duration_minutes, status, attempt) VALUES (${iv(n)}, ${ids.company}, ${app(n)}, 'first', 'First interview', 'video', 30, ${status}, 1)`);
    await interview(PEOPLE.hadInterview, "proposed");
    await interview(PEOPLE.openFollowUp, "cancelled");
    await handle.db.execute(sql`INSERT INTO interview_followups (id, company_id, application_id, interview_id, interview_attempt, kind, choice, created_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(PEOPLE.openFollowUp)}, ${iv(PEOPLE.openFollowUp)}, 1, 'candidate_cancelled', 'not_interested', ${person})`);
    await handle.db.execute(sql`INSERT INTO application_marks (id, company_id, application_id, mark, set_by) VALUES (gen_random_uuid(), ${ids.company}, ${app(PEOPLE.marked)}, 'shortlist', ${person})`);

    const rule = (companyId: string, roleId: string | null, level: string) => handle.db.execute(sql`INSERT INTO policies (id, company_id, role_id, action_type, level, created_by) VALUES (gen_random_uuid(), ${companyId}, ${roleId}, 'application.recommend_interview', ${level}, ${person})`);
    await rule(ids.chose, null, "auto_notify");
    await rule(ids.chose, ids.tightened, "human_only");
    await rule(ids.company, ids.ownRule, "auto");

    copyFileSync(join(MIGRATIONS_DIR, "0037_person_decides_who_to_interview.sql"), join(dir, "0037_person_decides_who_to_interview.sql"));
    expect(await migrate(handle, { dir })).toEqual(["0037_person_decides_who_to_interview.sql"]);
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts back the people the assistant moved who have never had an interview", async () => {
    expect(await stage(PEOPLE.moved)).toBe("screen_complete");
    expect(await stage(PEOPLE.marked)).toBe("screen_complete");
    expect(await stage(PEOPLE.secondCompany)).toBe("screen_complete");
  });

  it("leaves a person's decision alone, whoever moved them first", async () => {
    expect(await stage(PEOPLE.byPerson)).toBe("interview_recommended");
    expect(await stage(PEOPLE.personAfter)).toBe("interview_recommended");
  });

  it("leaves anyone with an interview, or under Cancelled, or who has moved on", async () => {
    expect(await stage(PEOPLE.hadInterview)).toBe("interview_recommended");
    expect(await stage(PEOPLE.openFollowUp)).toBe("interview_recommended");
    expect(await stage(PEOPLE.movedOn)).toBe("interview_scheduled");
    expect(await stage(PEOPLE.noHistory)).toBe("interview_recommended");
  });

  it("leaves a company or a job that chose to have the assistant move people, and reads a job's own rule first", async () => {
    expect(await stage(PEOPLE.companyChose)).toBe("interview_recommended");
    expect(await stage(PEOPLE.roleChose)).toBe("interview_recommended");
    expect(await stage(PEOPLE.roleTightened)).toBe("screen_complete");
  });

  it("records each move once, in the same shape as a stage change, and nobody's waiting time starts again", async () => {
    const recorded = await rows<{ subject_id: string; subject_type: string; company_id: string; actor: { kind: string; id: string }; payload: { from: string; to: string; reason: string; backfill: boolean } }>(sql`SELECT subject_id, subject_type, company_id, actor, payload FROM events WHERE type = 'application.stage_changed' AND actor->>'id' = 'migration_0037' ORDER BY subject_id`);
    expect(recorded.map((e) => e.subject_id)).toEqual([PEOPLE.moved, PEOPLE.roleTightened, PEOPLE.marked, PEOPLE.secondCompany].map(app));
    for (const e of recorded) expect(e).toMatchObject({ subject_type: "application", actor: { kind: "system", id: "migration_0037" }, payload: { from: "interview_recommended", to: "screen_complete", reason: "A person decides who to interview", backfill: true } });
    const [row] = await rows<{ stage_changed_at: string }>(sql`SELECT stage_changed_at FROM applications WHERE id = ${app(PEOPLE.moved)}`);
    expect(new Date(row.stage_changed_at).toISOString()).toBe(waitingSince);
  });

  it("sends nothing and tells nobody", async () => {
    expect(await rows(sql`SELECT id FROM communications`)).toHaveLength(0);
    expect(await rows(sql`SELECT id FROM notifications`)).toHaveLength(0);
    expect(await rows(sql`SELECT id FROM jobs`)).toHaveLength(0);
  });

  it("changes nothing when it runs on a database with nothing to repair", async () => {
    const fresh = await createDb({ pgliteDir: "memory://" });
    try {
      await migrate(fresh);
      expect(rowsOf(await fresh.db.execute(sql`SELECT id FROM events WHERE actor->>'id' = 'migration_0037'`))).toHaveLength(0);
    } finally {
      await fresh.close();
    }
  });
});

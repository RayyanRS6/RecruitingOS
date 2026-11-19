import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate, migrationStatus } from "./migrate";

/**
 * Migration 0039 on data that existed before it: the five columns of a reading that nothing reads are gone, every row is
 * still there, and the readings themselves (`assessments.result`, their kind and the job version each was made against)
 * are as they were.
 */
describe("migration 0039: the columns of a reading that nothing reads", () => {
  const MIGRATION = "0039_one_scoring_system.sql";
  let handle: DbHandle;
  let dir = "";
  const ids = {
    company: "11111111-1111-4111-8111-111111111111",
    role: "22222222-2222-4222-8222-222222222222",
    candidate: "33333333-3333-4333-8333-333333333333",
    application: "44444444-4444-4444-8444-444444444444",
    reading: "55555555-5555-4555-8555-555555555555",
    scorecard: "55555555-5555-4555-8555-555555555556",
    later: "55555555-5555-4555-8555-555555555557",
  };
  const actor = sql`'{"kind":"user","id":"u1"}'::jsonb`;
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));
  const columnsOf = async (table: string) => (await rows<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY ordinal_position`)).map((r) => r.column_name);
  /** A reading as the build before this migration stored it: the verdict and the confidence inside the reading, and copied beside it. */
  const oldReading = { overall: "strong", confidence: "high", recommendation: "screen", summary: "Shows the license.", strengths: [], concerns: [], unknowns: [], competencyFindings: [], requirementFindings: [{ requirementKey: "mh_license", met: "yes", evidence: { source: "resume", quote: "RDH license CA active" } }] };
  const oldScorecard = { overall: "potential", confidence: "medium", recommendation: "interview", summary: "Answered every question.", strengths: [], concerns: [], unknowns: [], questionFindings: [{ questionKey: "recent", answered: true, finding: "Names the practice.", meetsModelAnswer: "yes" }] };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0039-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0039")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${ids.company}, 'Old Dental', 'old-dental', 'dental', '20-49')`);
    await handle.db.execute(sql`INSERT INTO roles (id, company_id, title, status, created_by) VALUES (${ids.role}, ${ids.company}, 'Hygienist', 'open', ${actor})`);
    await handle.db.execute(sql`INSERT INTO candidates (id, company_id, first_name, last_name, first_source) VALUES (${ids.candidate}, ${ids.company}, 'Ada', 'Old', 'direct')`);
    await handle.db.execute(sql`INSERT INTO applications (id, company_id, role_id, candidate_id, packet_version, source, status_token, stage, latest_assessment_id) VALUES (${ids.application}, ${ids.company}, ${ids.role}, ${ids.candidate}, 3, 'direct', 'token-1', 'screen_complete', ${ids.scorecard})`);
    await handle.db.execute(sql`INSERT INTO assessments (id, company_id, application_id, kind, packet_version, result, overall, confidence, secondary_score, superseded_by) VALUES (${ids.reading}, ${ids.company}, ${ids.application}, 'triage', 3, ${JSON.stringify(oldReading)}::jsonb, 'strong', 'high', 87.5, ${ids.scorecard})`);
    await handle.db.execute(sql`INSERT INTO assessments (id, company_id, application_id, kind, packet_version, result, overall, confidence) VALUES (${ids.scorecard}, ${ids.company}, ${ids.application}, 'screen', 3, ${JSON.stringify(oldScorecard)}::jsonb, 'potential', 'medium')`);
    // this migration alone, so a later one that changes these tables does not change what is checked here
    copyFileSync(join(MIGRATIONS_DIR, MIGRATION), join(dir, MIGRATION));
    expect(await migrate(handle, { dir })).toEqual([MIGRATION]);
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops the five columns, and no other column of the two tables", async () => {
    expect(await columnsOf("assessments")).toEqual(["id", "company_id", "application_id", "kind", "packet_version", "ai_run_id", "result", "created_at"]);
    const application = await columnsOf("applications");
    expect(application).not.toContain("latest_assessment_id");
    for (const kept of ["id", "company_id", "role_id", "candidate_id", "packet_version", "stage", "answers", "extraction", "status_token", "told_state", "locked_at"]) expect(application, kept).toContain(kept);
  });

  it("keeps every reading as it was: the findings, the kind, the job version it was made against", async () => {
    const kept = await rows<{ id: string; kind: string; packet_version: number; result: unknown }>(sql`SELECT id, kind, packet_version, result FROM assessments WHERE application_id = ${ids.application} ORDER BY id`);
    expect(kept).toEqual([
      { id: ids.reading, kind: "triage", packet_version: 3, result: oldReading },
      { id: ids.scorecard, kind: "screen", packet_version: 3, result: oldScorecard },
    ]);
    expect(await rows(sql`SELECT stage, packet_version FROM applications WHERE id = ${ids.application}`)).toEqual([{ stage: "screen_complete", packet_version: 3 }]);
  });

  it("stores a new reading with the findings alone, against whichever version of the job it was made", async () => {
    await handle.db.execute(sql`INSERT INTO assessments (id, company_id, application_id, kind, packet_version, result) VALUES (${ids.later}, ${ids.company}, ${ids.application}, 'triage', 4, '{"summary":"Read again.","requirementFindings":[],"competencyFindings":[]}'::jsonb)`);
    expect(await rows(sql`SELECT kind, packet_version FROM assessments WHERE id = ${ids.later}`)).toEqual([{ kind: "triage", packet_version: 4 }]);
  });

  it("is recorded once, and running the migrations again changes nothing", async () => {
    expect(await rows(sql`SELECT count(*)::int AS n FROM _migrations WHERE name = ${MIGRATION}`)).toEqual([{ n: 1 }]);
    expect(await migrate(handle, { dir })).toEqual([]);
    expect((await migrationStatus(handle, { dir })).pending).toEqual([]);
  });
});

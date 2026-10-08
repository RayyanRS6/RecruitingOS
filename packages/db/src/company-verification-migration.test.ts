import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, rowsOf, type DbHandle } from "./client";
import { MIGRATIONS_DIR, migrate } from "./migrate";

/**
 * Migration 0027 (founder decision B7): every company that existed before the ITS check began is recorded as confirmed,
 * so nothing public goes offline and nothing waiting is held; the rest of its settings are kept, a company that already
 * carries a confirmation keeps its own, and each backfill is recorded as a company.verified event.
 */
describe("migration 0027: existing companies are confirmed", () => {
  let handle: DbHandle;
  let dir = "";
  const ids = { old: "11111111-1111-4111-8111-111111111111", bare: "22222222-2222-4222-8222-222222222222", checked: "33333333-3333-4333-8333-333333333333" };
  const rows = async <T>(q: ReturnType<typeof sql>) => rowsOf<T>(await handle.db.execute(q));

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ros-0027-"));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((x) => x < "0027")) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    handle = await createDb({ pgliteDir: "memory://" });
    await migrate(handle, { dir });
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, settings) VALUES (${ids.old}, 'Old Dental', 'old-dental', 'dental', '20-49', ${sql`'{"website":"olddental.example","careersPage":{"enabled":true,"intro":"Hello"}}'::jsonb`})`);
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band) VALUES (${ids.bare}, 'Bare Clinic', 'bare-clinic', 'medical', '1-19')`);
    await handle.db.execute(sql`INSERT INTO companies (id, name, slug, vertical, size_band, settings) VALUES (${ids.checked}, 'Checked Co', 'checked-co', 'dental', '1-19', ${sql`'{"verifiedAt":"2026-10-01T09:00:00.000Z","verifiedBy":{"kind":"user","id":"admin-1","name":"Ana Admin"}}'::jsonb`})`);
    copyFileSync(join(MIGRATIONS_DIR, "0027_company_verification.sql"), join(dir, "0027_company_verification.sql"));
    expect(await migrate(handle, { dir })).toEqual(["0027_company_verification.sql"]);
  });
  afterAll(async () => {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("confirms every company that existed, keeping the rest of its settings and any confirmation it already had", async () => {
    const all = await rows<{ id: string; settings: { verifiedAt?: string; verifiedBy?: { kind: string; id: string }; website?: string; careersPage?: { intro?: string } } }>(sql`SELECT id, settings FROM companies ORDER BY id`);
    const [old, bare, checked] = all;
    for (const co of [old, bare]) {
      expect(co.settings.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Number.isNaN(Date.parse(co.settings.verifiedAt!))).toBe(false);
      expect(co.settings.verifiedBy).toMatchObject({ kind: "system", id: "migration_0027" });
    }
    expect(old.settings.website).toBe("olddental.example");
    expect(old.settings.careersPage?.intro).toBe("Hello");
    expect(checked.settings).toMatchObject({ verifiedAt: "2026-10-01T09:00:00.000Z", verifiedBy: { kind: "user", id: "admin-1" } });
  });

  it("records each backfill as a company.verified event, and only those", async () => {
    const recorded = await rows<{ company_id: string; subject_id: string; payload: { how: string } }>(sql`SELECT company_id, subject_id, payload FROM events WHERE type = 'company.verified' ORDER BY subject_id`);
    expect(recorded.map((e) => [e.company_id, e.subject_id, e.payload.how])).toEqual([[ids.old, ids.old, "existing_company"], [ids.bare, ids.bare, "existing_company"]]);
  });
});

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, rowsOf } from "./client";
import { migrate } from "./migrate";

/** Migration 0017 on a database that has the Data API roles: their access to public goes away, ours stays. */
describe("0017 supabase api roles", () => {
  it("revokes anon, authenticated and service_role from public and keeps the application roles working", async () => {
    const h = await createDb({ pgliteDir: "memory://" });
    try {
      await h.execRaw("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;");
      await h.execRaw("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role");
      await h.execRaw("ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role");
      await h.execRaw("GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role");
      await migrate(h);
      const q = async (t: string) => rowsOf<Record<string, unknown>>(await h.db.execute(sql.raw(t)));
      for (const r of ["anon", "authenticated", "service_role"]) {
        expect((await q(`select exists (select 1 from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'public' and a.grantee = '${r}'::regrole and a.privilege_type = 'USAGE') as u`))[0]!.u).toBe(false);
        expect((await q(`select count(*)::int as n from information_schema.table_privileges where grantee = '${r}' and table_schema = 'public'`))[0]!.n).toBe(0);
      }
      await h.execRaw("CREATE TABLE later_table (id int)");
      expect((await q("select has_table_privilege('anon','later_table','SELECT') as s"))[0]!.s).toBe(false);
      expect((await q("select has_table_privilege('ros_app','later_table','SELECT') as s"))[0]!.s).toBe(true);
      expect((await q("select has_table_privilege('ros_app','users','SELECT') as s"))[0]!.s).toBe(true);
      // running the migration set again is a no-op
      expect(await migrate(h)).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

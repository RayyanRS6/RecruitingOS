import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { glob } from "node:fs/promises";

/**
 * Tenant isolation lives in row-level security, and row-level security only applies inside `withTenant` (or, for
 * platform tables, `withPlatform`). A query made straight on `container.db` runs as the connection's own role, which
 * sees every company. Some routes need that (a token lookup before any tenant is known, a platform-wide feed); most
 * do not. Tests cannot catch a missed wrapper (PGlite runs as a superuser), so this test holds the line instead: the
 * number of raw queries per file may go down, never up, without a deliberate change here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW_QUERY = /(?:container|c\.get\("container"\)|handle)\.db\.(?:select|insert|update|delete|execute)\(/g;

/** Raw queries per file as of the audit remediation (September 2026). Lower is fine; higher needs a reason and a change here. */
const ALLOWED: Record<string, number> = {
  "apps/api/src/app.ts": 1,
  "apps/api/src/pages/candidate.tsx": 8,
  "apps/api/src/routes/admin.ts": 11,
  "apps/api/src/routes/auth-mfa.tsx": 3,
  "apps/api/src/routes/auth-shared.ts": 1,
  "apps/api/src/routes/auth.ts": 3,
  "apps/api/src/routes/companies.ts": 2,
  "apps/api/src/routes/privacy-requests.ts": 4,
  "apps/api/src/routes/roles.ts": 3,
  "apps/api/src/test-helpers.ts": 4,
  "apps/api/src/webhooks/postmark.ts": 8,
  "apps/api/src/webhooks/twilio.ts": 1,
};

describe("raw database access outside a tenant transaction", () => {
  it("does not grow: every new query on container.db needs a tenant or platform transaction, or a deliberate entry in the allow list", async () => {
    const files: string[] = [];
    for await (const f of glob("apps/api/src/**/*.{ts,tsx}", { cwd: ROOT })) files.push(f.split("\\").join("/"));
    const counts: Record<string, number> = {};
    for (const file of files.filter((f) => !/\.test\.tsx?$/.test(f)).sort()) {
      const n = (readFileSync(join(ROOT, file), "utf8").match(RAW_QUERY) ?? []).length;
      if (n) counts[relative(ROOT, join(ROOT, file)).split("\\").join("/")] = n;
    }
    const over = Object.entries(counts).filter(([file, n]) => n > (ALLOWED[file] ?? 0));
    expect(over, `raw queries grew in: ${over.map(([f, n]) => `${f} (${n}, allowed ${ALLOWED[f] ?? 0})`).join("; ")}. Use withTenant/withPlatform, or explain the exception in tests/policy/raw-db-access.test.ts.`).toEqual([]);
    // the allow list does not hold stale entries either
    const stale = Object.keys(ALLOWED).filter((f) => !(f in counts));
    expect(stale, `allow-list entries for files that no longer query raw: ${stale.join(", ")}`).toEqual([]);
  });
});

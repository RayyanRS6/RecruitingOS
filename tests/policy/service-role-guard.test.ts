import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Founder decision (15 Sep 2026, correction 9): the Supabase service-role key bypasses row-level security and must never
 * become a general application credential. No client code may reference it; server code may use it only in an
 * allowlisted, reviewed module (none exists for release 1, so the allowlist is empty and any reference fails this test).
 */
const ROOT = join(__dirname, "..", "..");
const CLIENT_DIRS = ["apps/web/src", "apps/shell/app", "apps/shell/components", "apps/shell/lib", "apps/shell/middleware.ts", "apps/shell/next.config.ts"];
const SERVER_DIRS = ["apps/api/src", "packages", "scripts"];
// Repo-relative files permitted to reference the service-role key, each documented in docs/spec/09. The secret scanner
// names the variable only as a pattern it hunts for; no application module is permitted in release 1.
/**
 * Files that may mention the words: the scanner names the pattern; the database status report names Supabase's
 * Data API role "service_role" to report that it holds no privilege in public (migration 0017). Neither touches a key.
 */
const ALLOWLIST: string[] = ["scripts/secret-scan.ts", "packages/db/src/cli/status.ts"];
const PATTERNS = [/SUPABASE_SERVICE_ROLE_KEY/, /service_role/i, /SERVICE_ROLE/];

/** Repo-relative with forward slashes on every platform, so the allowlist matches on Windows checkouts too. */
const rel = (f: string) => relative(ROOT, f).split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  if (!statSync(dir).isDirectory()) { out.push(dir); return out; }
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".data" || name === "results") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("service-role key guard", () => {
  it("client code never references the service-role key", () => {
    const hits = CLIENT_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => PATTERNS.some((re) => re.test(readFileSync(f, "utf8"))));
    expect(hits.map(rel)).toEqual([]);
  });
  it("server code references it only from the documented allowlist", () => {
    const hits = SERVER_DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => PATTERNS.some((re) => re.test(readFileSync(f, "utf8")))).map(rel);
    expect(hits.filter((f) => !ALLOWLIST.includes(f))).toEqual([]);
  });
  it("no public environment variable carries a secret or the service role", () => {
    const files = [...CLIENT_DIRS, ...SERVER_DIRS].flatMap((d) => walk(join(ROOT, d)));
    const bad: string[] = [];
    for (const f of files) {
      const m = readFileSync(f, "utf8").match(/NEXT_PUBLIC_[A-Z0-9_]*(SECRET|SERVICE|TOKEN|PRIVATE)[A-Z0-9_]*/g);
      if (m) bad.push(`${rel(f)}: ${m.join(", ")}`);
    }
    expect(bad).toEqual([]);
  });
});

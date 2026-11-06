import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The wall of first sign-in asks for approval (6 November 2026) is a membership that is not `active`: `requested` or
 * `declined`. It holds because the code reads a membership only at `status = 'active'`. The canary sweep
 * (apps/api/src/access-approval.test.ts) proves it on every route; this holds the line in the source, for the worker and the
 * workflows too, where a machine can see a new reader before anyone runs anything.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** One statement that reads the table: from `from(memberships` or a join of it to its semicolon. */
const READS_A_MEMBERSHIP = /\b(?:from|leftJoin|innerJoin|rightJoin|fullJoin)\(memberships\b[^;]*;/g;

/**
 * Who reads the table with no look at the status, per file. Lower is fine; higher needs a line here saying why a row of any
 * status is not taken for someone on a team.
 */
const READS_ANY_STATUS: Record<string, number> = {
  // Hands the status back, and both callers keep only `active` (services/team.ts `listTeam`, routes/role-packets.ts `interviewerViews`).
  "packages/core/src/calendar-connections.ts": 1,
  // The one reader that does act on any status. A request for access is skipped first, so no invitation opens it; a `removed` person rejoins, as ever.
  "packages/core/src/invitations.ts": 2,
  // The team role of people already on an interview, to leave pay out of their brief. Only an active member is put on an interview (services/interview-create.ts).
  "packages/workflows/src/definitions/schedule-interview.ts": 1,
  // What a test does for itself.
  "apps/api/src/test-helpers.ts": 1,
};

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const pattern of ["apps/api/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"]) {
    for await (const file of glob(pattern, { cwd: ROOT })) {
      const path = file.split("\\").join("/");
      if (path.includes("node_modules") || /\.test\.tsx?$/.test(path)) continue;
      out.push(path);
    }
  }
  return out.sort();
}

describe("readers of memberships", () => {
  it("every one looks at the status, but for the few named here", async () => {
    const found: Record<string, number> = {};
    let readers = 0;
    for (const file of await sourceFiles()) {
      for (const [statement] of readFileSync(join(ROOT, file), "utf8").matchAll(READS_A_MEMBERSHIP)) {
        readers += 1;
        if (!statement.includes("memberships.status")) found[file] = (found[file] ?? 0) + 1;
      }
    }
    expect(found, "A new read of memberships with no look at the status: filter on `active`, or say here why a row of any status is not taken for someone on a team.").toEqual(READS_ANY_STATUS);
    // It is not reading nothing: the table has dozens of readers.
    expect(readers).toBeGreaterThan(25);
  });
});

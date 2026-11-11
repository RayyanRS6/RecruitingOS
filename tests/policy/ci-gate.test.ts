import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The one required status check on main is `verify` (docs/runbooks/production-setup.md). The release review (11 November
 * 2026, L5-3): it ran `if: ${{ !cancelled() }}`, so a cancelled run (a press of Cancel, or a newer push) skipped it, and
 * GitHub counts a job skipped by its condition as a success: the merge button turned green with no test run.
 */
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
/** The `verify` job's own block: from its key to the end of the file (it is the last job). */
const verify = ci.slice(ci.indexOf("\n  verify:\n"));

describe("the required check", () => {
  it("verify waits for every job and runs whatever became of them, so it reads failed and never skipped", () => {
    expect(verify.length).toBeGreaterThan(20);
    expect(verify).toContain("needs: [checks, flows]");
    // always(), never !cancelled() or success(): a cancelled run must read as a failed check
    expect(verify).toMatch(/\n {4}if: \$\{\{ always\(\) \}\}\n/);
    expect(verify).not.toMatch(/\n {4}if: .*cancelled\(\)/);
    // and it passes only when both passed
    expect(verify).toContain('test "${{ needs.checks.result }}" = "success"');
    expect(verify).toContain('test "${{ needs.flows.result }}" = "success"');
  });
});

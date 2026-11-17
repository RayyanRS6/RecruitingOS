import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The evaluation runner run for real, as the fairness button runs it (.github/workflows/fairness.yml: tsx, one process,
 * `--suite`), on the stand-in provider. A name given to `--suite` that chooses no suite fails the run (second review of
 * the live-test fixes, #22), which is what turns the button's run red; that exit lives only in the runner's main(), which
 * no other test runs (the second look at that fix, S2). The rules themselves are `suiteNameFailures` in summary.ts,
 * pinned in summary.test.ts; this holds the runner to them. `board` chooses board.determinism, which makes no model
 * call, so each run costs only the in-memory database's migrations.
 */
const EVALS = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = fileURLToPath(import.meta.resolve("tsx/cli"));
/** The process's environment without a key, a provider, a model or an effort the outer shell set. */
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_API_KEY|AI_PROVIDER|AI_MODEL_\w+|AI_EFFORT_\w+)$/.test(k)));

/** One run with `--suite`. The result file it writes is removed, so the newest file in results/ stays one a person made. */
function runWith(suites: string): { status: number | null; stdout: string; wrote: boolean } {
  const r = spawnSync(process.execPath, [TSX, join("src", "runner.ts"), "--suite", suites], { cwd: EVALS, env: { ...clean, AI_PROVIDER: "fake" }, encoding: "utf8", timeout: 120_000 });
  const stdout = r.stdout ?? "";
  const file = /^results: (.+)$/m.exec(stdout)?.[1]?.trim();
  if (file && existsSync(file)) rmSync(file);
  return { status: r.status, stdout, wrote: !!file };
}
/** The lines the runner printed for what failed the run. */
const failed = (stdout: string) => stdout.split(/\r?\n/).filter((line) => line.startsWith("FAIL "));

describe("the evaluation runner's exit code", () => {
  it("fails a run in which a name given to --suite chose no suite, after running the ones that did", () => {
    const r = runWith("board,board.renamed");
    expect(r.stdout).toContain("PASS board.determinism: ");
    expect(failed(r.stdout)).toEqual(["FAIL --suite board.renamed: no suite by that name or family ran"]);
    // the run reached its end and wrote its file: a crash exits 1 too, and must not pass for the refusal
    expect(r.wrote).toBe(true);
    expect(r.status).toBe(1);
  }, 120_000);

  it("passes a run in which every name chose a suite, held to its choice and not to every suite thresholds.json lists", () => {
    const r = runWith("board");
    expect(r.stdout).toContain("PASS board.determinism: ");
    expect(failed(r.stdout)).toEqual([]);
    expect(r.wrote).toBe(true);
    expect(r.status).toBe(0);
  }, 120_000);
});

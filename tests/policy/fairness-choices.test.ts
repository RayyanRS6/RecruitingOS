import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUITE_WORDS, chosenBy, unmatchedSuites } from "../../packages/evals/src/summary";

/**
 * The fairness button (.github/workflows/fairness.yml) hands one of its "Which tests" choices to the evaluation runner as
 * `--suite`, and the runner picks a suite by its own name or by its family, the part before the dot (`chosenBy`). The
 * second review of the live-test fixes (12 November 2026, #22): nothing tied the choices to the suites, so a suite renamed
 * on one side only ran fewer checks, or none, and the run still passed. The runner now fails on a name that chooses no
 * suite; this catches one before anyone presses the button, and checks that the run's page names every check a choice
 * runs in plain words.
 */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const yml = read(".github/workflows/fairness.yml");
/** The choices as GitHub lists them: the options of the `tests` input. */
const choices: string[] = JSON.parse(/\n\s+options: (\[.*\])/.exec(yml.slice(yml.indexOf("\n      tests:\n"), yml.indexOf("\n      screening_model:\n")))?.[1] ?? "[]");
/** Every suite the runner scores, as thresholds.json lists them. */
const suites = Object.keys(JSON.parse(read("packages/evals/thresholds.json")) as Record<string, unknown>).filter((key) => !key.startsWith("_"));

describe("the fairness button's choices", () => {
  it("are read from the workflow", () => {
    expect(choices).toContain("resume,triage");
    expect(choices.length).toBeGreaterThan(1);
    expect(suites).toContain("packet.revise");
  });

  it("name only suites, or families of suites, that the runner has", () => {
    for (const choice of choices) expect(unmatchedSuites(choice.split(","), suites), choice).toEqual([]);
    // the finding's case: change by chat renamed in the runner and not in the choice
    const renamed = suites.map((suite) => (suite === "packet.revise" ? "packet.change" : suite));
    expect(unmatchedSuites("intake,packet.revise".split(","), renamed)).toEqual(["packet.revise"]);
  });

  it("run only checks that the run's page names in plain words", () => {
    for (const choice of choices) {
      const chosen = suites.filter((suite) => choice.split(",").some((name) => chosenBy(name, suite)));
      expect(chosen.length, choice).toBeGreaterThan(0);
      expect(chosen.filter((suite) => !SUITE_WORDS[suite]), choice).toEqual([]);
    }
  });
});

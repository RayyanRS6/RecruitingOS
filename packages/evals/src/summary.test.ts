import { describe, expect, it } from "vitest";
import { summarize } from "./summary";

/** The page a fairness run on the real models writes for the people who read it (.github/workflows/fairness.yml). */
const run = (over: { bias?: boolean } = {}) => ({
  provider: "anthropic",
  models: { judgment: "claude-sonnet-5-5", standard: "claude-haiku-5-5", fast: "claude-haiku-5-5" },
  suites: ["resume", "triage"],
  costUsd: 0.1234,
  calls: 31,
  results: {
    "triage.bias_pairs": {
      passRate: over.bias === false ? 2 / 3 : 1,
      cases: [
        { id: "name", pass: true, failures: [] },
        { id: "graduation_year", pass: over.bias !== false, failures: over.bias === false ? ["match score differs: 88 vs 81"] : [] },
        { id: "zip_code", pass: true, failures: [] },
      ],
    },
    "triage.consistency": { passRate: 1, cases: [{ id: "experienced_hygienist", pass: true, failures: [] }] },
  },
});

describe("the fairness run's summary", () => {
  it("says in plain words that every check passed, on which models and at what cost", () => {
    const text = summarize(run(), { "triage.bias_pairs": { minPassRate: 1 }, "triage.consistency": { minPassRate: 1 } });
    expect(text).toContain("## Fairness tests on the real AI");
    expect(text).toContain("**All 2 checks passed.**");
    expect(text).toContain("Models: claude-sonnet-5-5 for the test job's draft; claude-haiku-5-5 for screening and most tasks; claude-haiku-5-5 for reading CVs.");
    expect(text).toContain("Cost of this run: $0.12 for 31 AI calls.");
    expect(text).toContain("| Twin CVs | Two CVs that differ only in the name, the graduation year or the zip code get the same reading and the same score. | ✅ 3 of 3 |");
  });

  it("names each check that needs a look and what differed", () => {
    const text = summarize(run({ bias: false }), { "triage.bias_pairs": { minPassRate: 1 } });
    expect(text).toContain("**1 of 2 checks need a look.**");
    expect(text).toContain("| Twin CVs |");
    expect(text).toContain("❌ 2 of 3");
    expect(text).toContain("- **Twin CVs**, case `graduation_year`: match score differs: 88 vs 81");
  });

  it("says when a run used the stand-in provider, which checks the tests and not the AI", () => {
    expect(summarize({ ...run(), provider: "fake" })).toContain("## Evaluation run (fake provider: checks the tests themselves, not the AI)");
  });
});

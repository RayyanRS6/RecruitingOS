import { describe, expect, it } from "vitest";
import { suiteNameFailures, summarize, unmatchedSuites } from "./summary";

/** The page a fairness run on the real models writes for the people who read it (.github/workflows/fairness.yml). */
const run = (over: { bias?: boolean } = {}) => ({
  provider: "anthropic",
  models: { judgment: "claude-sonnet-5-5", standard: "claude-haiku-5-5", fast: "claude-haiku-5-5" },
  // the choice these results answer: a chosen name that ran nothing is a check that needs a look (#22 below)
  suites: ["triage"],
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
    expect(text).toContain("| Twin CVs | Two CVs that differ only in the name, the graduation year, the zip code or an earlier rejection at the same company get the same reading and the same score. | ✅ 3 of 3 |");
  });

  it("names each check that needs a look and what differed", () => {
    const text = summarize(run({ bias: false }), { "triage.bias_pairs": { minPassRate: 1 } });
    expect(text).toContain("**1 of 2 checks need a look.**");
    expect(text).toContain("| Twin CVs |");
    expect(text).toContain("❌ 2 of 3");
    expect(text).toContain("- **Twin CVs**, case `graduation_year`: match score differs: 88 vs 81");
  });

  // Wave S9: a failing screening case's full record stays in the file; the page says where it is and does not print it
  it("points to the full record of a failing screening case, and leaves it out of the page", () => {
    const failing = { ...run(), suites: ["screen.writeup"], results: { "screen.writeup": { passRate: 0, cases: [{ id: "skipped_question", pass: false, failures: ["model: wq_patients says something they did not write"], notes: ["prompt: screen.writeup v2"], diagnostics: { transcript: [{ role: "candidate", text: "About eight." }], writeup: { output: { answers: [] } } } }] } } };
    const text = summarize(failing, { "screen.writeup": { minPassRate: 1 } });
    // the second review of the live-test fixes (#22): every check the screen,chat choice runs has its plain name
    expect(text).toContain("- **Answers written up for Review & send**, case `skipped_question`: model: wq_patients says something they did not write");
    expect(text).toContain("  - prompt: screen.writeup v2");
    expect(text).toContain("under `diagnostics`");
    expect(text).not.toContain("About eight.");
    expect(summarize(run({ bias: false }), { "triage.bias_pairs": { minPassRate: 1 } })).not.toContain("diagnostics");
  });

  it("says when a run used the stand-in provider, which checks the tests and not the AI", () => {
    expect(summarize({ ...run(), provider: "fake" })).toContain("## Evaluation run (fake provider: checks the tests themselves, not the AI)");
  });

  it("shows a check with no plain words under its own name", () => {
    const text = summarize({ ...run(), suites: ["board"], results: { "board.determinism": { passRate: 1, cases: [{ id: "same_order", pass: true, failures: [] }] } } });
    expect(text).toContain("| board.determinism |  | ✅ 1 of 1 |");
  });

  /**
   * The second review of the live-test fixes (12 November 2026, #17, #23 and #39): a job-builder run reads no CV, Sonnet
   * writes every draft under test, and the "screening" model and effort set the builder's conversation.
   */
  it("names the models of a job-builder run for what they did in it", () => {
    const builder = {
      ...run(),
      suites: ["intake"],
      models: { judgment: "claude-sonnet-5-5", standard: "claude-haiku-5-5", fast: "claude-haiku-5-5" },
      efforts: { standard: "high" },
      results: {
        "intake.golden": { passRate: 1, cases: [{ id: "dental_rdh_one_sentence", pass: true, failures: [] }] },
        "intake.job_ad": { passRate: 1, cases: [{ id: "dental_assistant_ad", pass: true, failures: [] }] },
      },
    };
    const text = summarize(builder);
    expect(text).toContain("**All 2 checks passed.**");
    expect(text).toContain("Models: claude-sonnet-5-5 for writing each job draft; claude-haiku-5-5 for the job builder's conversation; claude-haiku-5-5 for reading a pasted ad.");
    expect(text).toContain("Thinking effort set for this run: high for the job builder's conversation (otherwise the app's own setting).");
    expect(text).not.toContain("reading CVs");
    expect(text).not.toContain("the test job's draft");
    expect(text).not.toContain("for screening");
    expect(text).toContain("| Writing a job | From what an owner types");
    expect(text).toContain("| A pasted job ad | A pasted ad is read for its job and its pay");
    // a run of both names both
    const both = summarize({ ...builder, suites: "all" as const, results: { ...builder.results, ...run().results } });
    expect(both).toContain("Models: claude-sonnet-5-5 for writing each job draft; claude-haiku-5-5 for screening, the job builder's conversation and most tasks; claude-haiku-5-5 for reading CVs and pasted ads.");
  });

  /**
   * The second look at the fairness button's fix (S1): the fast model reads the CVs in the CV checks and the pasted ads in
   * the job builder's. The screening chat's checks read neither, so their page, the run required before any real
   * candidate, names no model for reading.
   */
  it("names a model for reading only in a run that read CVs or pasted ads", () => {
    const chat = {
      ...run(),
      suites: ["screen", "chat"],
      efforts: { standard: "high", fast: "low" },
      results: {
        "screen.writeup": { passRate: 1, cases: [{ id: "skipped_question", pass: true, failures: [] }] },
        "chat.shape": { passRate: 1, cases: [{ id: "concrete_answer", pass: true, failures: [] }] },
      },
    };
    const text = summarize(chat);
    expect(text).toContain("**All 2 checks passed.**");
    expect(text).toContain("\nModels: claude-sonnet-5-5 for the test job's draft; claude-haiku-5-5 for screening and most tasks.\n");
    expect(text).toContain("\nThinking effort set for this run: high for screening and most tasks (otherwise the app's own setting).\n");
    expect(text).not.toContain("reading CVs");
    expect(text).not.toContain("for reading");
  });

  /**
   * The second review of the live-test fixes (12 November 2026, #22): a chosen name that ran no check (a typo, or a suite
   * renamed on one side only) fails the run, and the page counts it as a check that needs a look, never "All N passed".
   */
  it("counts a chosen name that ran no check as a check that needs a look", () => {
    const text = summarize({ ...run(), suites: ["triage", "board.renamed"] }, { "triage.bias_pairs": { minPassRate: 1 }, "triage.consistency": { minPassRate: 1 } });
    expect(text).toContain("**1 of 3 checks need a look.** Details are below.");
    expect(text).not.toContain("checks passed");
    expect(text).toContain("| board.renamed | Chosen for this run, but no check by that name ran. | ❌ not run |");
    expect(text).toContain("- **board.renamed**: chosen for this run, but no check by that name ran.");
    expect(text).toContain("| Twin CVs |");
    // and a choice that names nothing never reads "All 0 checks passed"
    const none = summarize({ ...run(), suites: [], results: {} });
    expect(none).toContain("**No check ran.**");
    expect(none).not.toContain("checks passed");
  });

  it("finds each chosen name that chose none of the suites that ran, by name or by family", () => {
    expect(unmatchedSuites(["intake", "company.about"], ["intake.golden", "company.renamed"])).toEqual(["company.about"]);
    expect(unmatchedSuites(["typo"], [])).toEqual(["typo"]);
    expect(unmatchedSuites(["triage.typo"], ["triage.bias_pairs", "triage.consistency"])).toEqual(["triage.typo"]);
    expect(unmatchedSuites(["board", "chat.shape", "triage.bias_pairs"], ["board.determinism", "chat.shape", "triage.bias_pairs"])).toEqual([]);
    expect(unmatchedSuites("all", [])).toEqual([]);
    expect(unmatchedSuites(undefined, [])).toEqual([]);
  });

  /**
   * The second look at the fairness button's fix (S3): the button's choices are checked against thresholds.json, but
   * nothing held thresholds.json to the suites the runner writes, so a suite renamed in the runner alone passed every
   * check until the button ran. A whole run, as CI's `pnpm eval` makes, now fails on either side of such a rename.
   */
  it("fails a run on a name given to --suite that chose nothing, and a whole run whose suites and thresholds.json disagree", () => {
    const listed = ["intake.golden", "company.about", "board.determinism", "_note"];
    expect(suiteNameFailures(null, ["intake.golden", "company.renamed", "board.determinism"], listed)).toEqual([
      "company.renamed: no entry in thresholds.json",
      "company.about: in thresholds.json, but no suite by that name ran",
    ]);
    expect(suiteNameFailures(null, ["intake.golden", "company.about", "board.determinism"], listed)).toEqual([]);
    // a run of chosen suites answers for its choice only, never for every suite listed
    expect(suiteNameFailures(["board", "board.renamed"], ["board.determinism"], listed)).toEqual(["--suite board.renamed: no suite by that name or family ran"]);
    expect(suiteNameFailures(["intake", "company.about"], ["intake.golden", "company.about"], listed)).toEqual([]);
    expect(suiteNameFailures([], [], listed)).toEqual(["--suite: no suite named"]);
  });
});

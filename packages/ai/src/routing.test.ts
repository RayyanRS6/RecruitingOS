import { describe, expect, it } from "vitest";
import { ALLOWED_MODELS, TASK_TIER, TIER_EFFORT, appRouting, effortForTask, effortsFromEnv, modelForTask, modelTableFromEnv } from "./routing";
import type { TaskKey } from "./types";

/**
 * The owner's decision (13 Oct 2026): Claude Haiku 5.5 for every task, Claude Sonnet 5.5 only for a long, complex one,
 * and no other model, ever.
 */
const TASKS = Object.keys(TASK_TIER) as TaskKey[];

describe("which model each task runs on", () => {
  it("runs on Haiku 5.5 and Sonnet 5.5 only", () => {
    expect([...ALLOWED_MODELS]).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5"]);
    const table = modelTableFromEnv({});
    for (const task of TASKS) expect(ALLOWED_MODELS).toContain(modelForTask(task, table));
  });

  it("gives Sonnet 5.5 the whole job draft alone, and every other task to Haiku 5.5", () => {
    const table = modelTableFromEnv({});
    expect(TASKS.filter((t) => modelForTask(t, table) === "claude-sonnet-5-5")).toEqual(["intake.compile"]);
    for (const task of ["intake.turn", "intake.extract", "company.about", "job.posts", "resume.extract", "triage.assess", "screen.turn", "screen.assess"] as const) {
      expect(modelForTask(task, table)).toBe("claude-haiku-5-5");
    }
  });

  it("takes an allowed model from the environment as it is said, and an empty value as unset (what an evaluation reads)", () => {
    expect(modelTableFromEnv({ AI_MODEL_JUDGMENT: "claude-haiku-5-5" }).judgment).toBe("claude-haiku-5-5");
    expect(modelTableFromEnv({ AI_MODEL_STANDARD: " claude-sonnet-5-5 " }).standard).toBe("claude-sonnet-5-5");
    expect(modelTableFromEnv({ AI_MODEL_FAST: "" }).fast).toBe("claude-haiku-5-5");
  });

  it("refuses to start on any other model, naming the variable", () => {
    for (const [name, value] of [["AI_MODEL_JUDGMENT", "claude-opus-5"], ["AI_MODEL_STANDARD", "claude-sonnet-5"], ["AI_MODEL_FAST", "claude-haiku-4-5-20251001"], ["AI_MODEL_FAST", "claude-fable-5-1"]] as const) {
      expect(() => modelTableFromEnv({ [name]: value })).toThrow(`${name}=${value} is not allowed: the app runs only on claude-haiku-5-5 and claude-sonnet-5-5`);
    }
  });
});

describe("an effort set in the environment (the fairness run's choice)", () => {
  it("takes low, medium or high per tier, an empty value as unset, and refuses anything else", () => {
    expect(effortsFromEnv({ AI_EFFORT_STANDARD: "high", AI_EFFORT_FAST: "" })).toEqual({ standard: "high" });
    expect(effortsFromEnv({})).toEqual({});
    expect(() => effortsFromEnv({ AI_EFFORT_JUDGMENT: "max" })).toThrow("AI_EFFORT_JUDGMENT=max is not an effort: use low, medium, high");
  });
});

/**
 * The app's own routing (the app and the worker). The owner's rule must hold whatever the settings say: the larger model
 * writes the job and nothing else, no model outside the two ever runs, and both scoring readings think at high. A
 * setting that says otherwise is ignored and named in one line for the log; a model outside the two still stops the start.
 */
describe("the app's own routing, whatever the environment says", () => {
  const HAIKU = "claude-haiku-5-5";
  const SONNET = "claude-sonnet-5-5";
  const MODEL_VALUES = [undefined, "", HAIKU, SONNET] as const;
  const EFFORT_VALUES = [undefined, "", "low", "medium", "high"] as const;

  it("puts the larger model on the writing of the job alone, under every combination of the three model settings", () => {
    for (const judgment of MODEL_VALUES) {
      for (const standard of MODEL_VALUES) {
        for (const fast of MODEL_VALUES) {
          const { models } = appRouting({ AI_MODEL_JUDGMENT: judgment, AI_MODEL_STANDARD: standard, AI_MODEL_FAST: fast });
          const where = `judgment=${judgment} standard=${standard} fast=${fast}`;
          for (const task of TASKS) {
            if (task === "intake.compile") expect(ALLOWED_MODELS, where).toContain(modelForTask(task, models));
            else expect(modelForTask(task, models), `${task} with ${where}`).toBe(HAIKU);
          }
        }
      }
    }
  });

  it("ignores the larger model named for the standard tier or the fast tier, and says so in one line each", () => {
    const r = appRouting({ AI_MODEL_STANDARD: SONNET, AI_MODEL_FAST: ` ${SONNET} ` });
    expect(r.models).toEqual({ judgment: SONNET, standard: HAIKU, fast: HAIKU });
    expect(r.ignored).toEqual([
      "AI_MODEL_STANDARD=claude-sonnet-5-5 is ignored: claude-sonnet-5-5 writes the job and runs nothing else. This tier stays on claude-haiku-5-5.",
      "AI_MODEL_FAST=claude-sonnet-5-5 is ignored: claude-sonnet-5-5 writes the job and runs nothing else. This tier stays on claude-haiku-5-5.",
    ]);
  });

  it("takes the model settings that keep the rule, with nothing to say: the small model for the writing of the job, and each model named where it already runs", () => {
    expect(appRouting({ AI_MODEL_JUDGMENT: HAIKU })).toEqual({ models: { judgment: HAIKU, standard: HAIKU, fast: HAIKU }, efforts: {}, ignored: [] });
    expect(appRouting({ AI_MODEL_JUDGMENT: SONNET, AI_MODEL_STANDARD: HAIKU, AI_MODEL_FAST: HAIKU })).toEqual({ models: { judgment: SONNET, standard: HAIKU, fast: HAIKU }, efforts: {}, ignored: [] });
    expect(appRouting({})).toEqual({ models: modelTableFromEnv({}), efforts: {}, ignored: [] });
  });

  it("still stops the start on a model outside the two, and on a word that is no effort", () => {
    expect(() => appRouting({ AI_MODEL_STANDARD: "claude-opus-5" })).toThrow("AI_MODEL_STANDARD=claude-opus-5 is not allowed: the app runs only on claude-haiku-5-5 and claude-sonnet-5-5");
    expect(() => appRouting({ AI_MODEL_JUDGMENT: "claude-fable-5-1" })).toThrow("AI_MODEL_JUDGMENT=claude-fable-5-1 is not allowed");
    expect(() => appRouting({ AI_EFFORT_STANDARD: "max" })).toThrow("AI_EFFORT_STANDARD=max is not an effort: use low, medium, high");
  });

  it("ignores an effort for the scoring readings' tier that is lower than theirs, and says so in one line", () => {
    for (const effort of ["low", "medium"] as const) {
      const r = appRouting({ AI_EFFORT_STANDARD: effort });
      expect(r.efforts).toEqual({});
      expect(r.ignored).toEqual([`AI_EFFORT_STANDARD=${effort} is ignored: it would lower a scoring reading (triage.assess runs at high, screen.assess runs at high).`]);
    }
  });

  it("takes the effort settings that lower no scoring reading: high for their tier, and any effort for the two other tiers", () => {
    expect(appRouting({ AI_EFFORT_STANDARD: "high" })).toMatchObject({ efforts: { standard: "high" }, ignored: [] });
    expect(appRouting({ AI_EFFORT_JUDGMENT: "low", AI_EFFORT_FAST: "low" })).toMatchObject({ efforts: { judgment: "low", fast: "low" }, ignored: [] });
  });

  it("leaves both scoring readings at high under every combination of the three effort settings", () => {
    for (const judgment of EFFORT_VALUES) {
      for (const standard of EFFORT_VALUES) {
        for (const fast of EFFORT_VALUES) {
          const { efforts } = appRouting({ AI_EFFORT_JUDGMENT: judgment, AI_EFFORT_STANDARD: standard, AI_EFFORT_FAST: fast });
          // the runner's own line (runner.ts, `callPrompt`): the runtime's effort for the task's tier, else the task's own
          for (const task of ["triage.assess", "screen.assess"] as const) expect(efforts[TASK_TIER[task]] ?? effortForTask(task), `${task} with standard=${standard}`).toBe("high");
        }
      }
    }
  });

  it("names the setting and one of the known words only, so nothing else from the environment reaches the log", () => {
    const lines = appRouting({ AI_MODEL_STANDARD: SONNET, AI_EFFORT_STANDARD: "low", ANTHROPIC_API_KEY: "fake-key-for-this-test", DATABASE_URL: "fake-address-for-this-test" }).ignored.join("\n");
    expect(lines).not.toContain("fake-key-for-this-test");
    expect(lines).not.toContain("fake-address-for-this-test");
  });
});

describe("how hard each task thinks", () => {
  it("starts Haiku 5.5 at medium, its default, the Sonnet 5.5 draft at high, and the two candidate readings at high", () => {
    expect(TIER_EFFORT).toEqual({ judgment: "high", standard: "medium", fast: "medium" });
    expect(effortForTask("intake.compile")).toBe("high");
    expect(effortForTask("intake.turn")).toBe("medium");
    expect(effortForTask("resume.extract")).toBe("medium");
    // the fairness runs (14 Oct 2026): twin resumes read and scored the same at high
    expect(effortForTask("triage.assess")).toBe("high");
    expect(effortForTask("screen.assess")).toBe("high");
  });
});

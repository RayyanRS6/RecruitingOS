import { describe, expect, it } from "vitest";
import { ALLOWED_MODELS, TASK_TIER, TIER_EFFORT, effortForTask, modelForTask, modelTableFromEnv } from "./routing";
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
    for (const task of ["intake.turn", "intake.extract", "packet.revise", "company.about", "resume.extract", "triage.assess", "screen.turn", "screen.assess", "message.freeform"] as const) {
      expect(modelForTask(task, table)).toBe("claude-haiku-5-5");
    }
  });

  it("takes an allowed model from the environment, and an empty value as unset", () => {
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

describe("how hard each task thinks", () => {
  it("starts Haiku 5.5 at medium, its default, and the Sonnet 5.5 draft at high", () => {
    expect(TIER_EFFORT).toEqual({ judgment: "high", standard: "medium", fast: "medium" });
    expect(effortForTask("intake.compile")).toBe("high");
    expect(effortForTask("triage.assess")).toBe("medium");
    expect(effortForTask("resume.extract")).toBe("medium");
  });
});

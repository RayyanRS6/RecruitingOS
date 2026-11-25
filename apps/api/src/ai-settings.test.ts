import { afterEach, describe, expect, it, vi } from "vitest";
import { createContainer, type Container } from "./container";

/**
 * The owner's model rule holds whatever the AI settings say (packages/ai/src/routing.ts, `appRouting`). This holds the
 * container to it: the app and the worker both start here, so their runtime must be the app's own, never the one the
 * evaluations build, which takes the settings as they are.
 */
describe("the AI settings of the app's own container", () => {
  const base = { ...process.env, NODE_ENV: "test", AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", WORKER_INLINE: "true", STORAGE_PROVIDER: "memory" };
  let container: Container | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await container?.close();
    container = null;
  });
  /** The lines about AI settings the start wrote to the log. */
  const aiLines = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith("[ai] "));

  it("ignores a lower effort for the scoring readings and the larger model for another tier, and says each once at start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const role of ["app", "worker"] as const) {
      warn.mockClear();
      container = await createContainer({ memory: true, role, env: { ...base, AI_EFFORT_STANDARD: "low", AI_MODEL_STANDARD: "claude-sonnet-5-5" } });
      expect(container.ai.efforts, role).toEqual({});
      expect(aiLines(warn), role).toEqual([
        "[ai] AI_MODEL_STANDARD=claude-sonnet-5-5 is ignored: claude-sonnet-5-5 writes the job and runs nothing else. This tier stays on claude-haiku-5-5.",
        "[ai] AI_EFFORT_STANDARD=low is ignored: it would lower a scoring reading (triage.assess runs at high, screen.assess runs at high).",
      ]);
      await container.close();
      container = null;
    }
  });

  it("takes the settings that keep the rule, and says nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    container = await createContainer({ memory: true, env: { ...base, AI_EFFORT_STANDARD: "high", AI_EFFORT_FAST: "low", AI_MODEL_JUDGMENT: "claude-haiku-5-5" } });
    expect(container.ai.efforts).toEqual({ standard: "high", fast: "low" });
    expect(aiLines(warn)).toEqual([]);
  });

  it("still refuses to start on a model outside the two", async () => {
    await expect(createContainer({ memory: true, env: { ...base, AI_MODEL_STANDARD: "claude-opus-5" } })).rejects.toThrow("AI_MODEL_STANDARD=claude-opus-5 is not allowed: the app runs only on claude-haiku-5-5 and claude-sonnet-5-5");
  });
});

import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "./pricing";

const million = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };

describe("cost estimates", () => {
  it("know the 5.5 models, so a run on them is not priced as Opus 5", () => {
    expect(estimateCostUsd("claude-haiku-5-5", million)).toBeCloseTo(0.1 + 0.5 + 0.01, 6);
    expect(estimateCostUsd("claude-sonnet-5-5", million)).toBeCloseTo(2 + 10 + 0.2, 6);
    expect(estimateCostUsd("claude-opus-5-5", million)).toBeCloseTo(4 + 20 + 0.2, 6);
  });

  it("price a model they do not know as Opus 5 rather than as free", () => {
    expect(estimateCostUsd("claude-unknown", million)).toBeCloseTo(5 + 25 + 0.5, 6);
  });
});

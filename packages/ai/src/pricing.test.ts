import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TOKENS, creditHoldUsd, estimateCostUsd } from "./pricing";

const million = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 };

describe("cost estimates", () => {
  it("price the two models the app runs on at Anthropic's October 2026 list prices", () => {
    const short = { inputTokens: 50_000, outputTokens: 10_000, cacheReadTokens: 20_000 };
    expect(estimateCostUsd("claude-haiku-5-5", short)).toBeCloseTo((50_000 * 0.1 + 10_000 * 0.5 + 20_000 * 0.01) / 1e6, 6);
    // Sonnet 5.5 cache reads are 0.05 times its input price: $0.10, not Sonnet 5's $0.20
    expect(estimateCostUsd("claude-sonnet-5-5", million)).toBeCloseTo(2 + 10 + 0.1, 6);
  });

  it("charge Haiku 5.5's long-prompt price once the prompt is over 100,000 tokens, cache included", () => {
    expect(estimateCostUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 1_000, cacheReadTokens: 0 })).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 6);
    expect(estimateCostUsd("claude-haiku-5-5", { inputTokens: 60_000, outputTokens: 1_000, cacheReadTokens: 50_000 })).toBeCloseTo((60_000 * 0.5 + 1_000 * 2.5 + 50_000 * 0.05) / 1e6, 6);
    expect(estimateCostUsd("claude-haiku-5-5", million)).toBeCloseTo(0.5 + 2.5 + 0.05, 6);
  });

  it("count cache writes at 1.25 times the input price", () => {
    expect(estimateCostUsd("claude-haiku-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 10_000 })).toBeCloseTo((10_000 * 0.125) / 1e6, 6);
    expect(estimateCostUsd("claude-sonnet-5-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000 })).toBeCloseTo(2.5, 6);
  });

  it("still price runs recorded on the earlier models", () => {
    expect(estimateCostUsd("claude-opus-5", million)).toBeCloseTo(5 + 25 + 0.5, 6);
    expect(estimateCostUsd("claude-haiku-4-5-20251001", million)).toBeCloseTo(1 + 5 + 0.1, 6);
  });

  it("price a model they do not know as Opus 5 rather than as free", () => {
    expect(estimateCostUsd("claude-unknown", million)).toBeCloseTo(5 + 25 + 0.5, 6);
  });
});

describe("what a call holds against a company's AI credit", () => {
  it("is two full requests at its ceiling of output tokens, the prompt at two characters a token", () => {
    // 20,000 prompt tokens and 16,000 written, twice over, on Haiku 5.5
    expect(creditHoldUsd("claude-haiku-5-5", { promptChars: 40_000 })).toBeCloseTo(2 * ((20_000 * 0.1 + DEFAULT_MAX_TOKENS * 0.5) / 1e6), 6);
    // the task's own ceiling when it has one
    expect(creditHoldUsd("claude-haiku-5-5", { promptChars: 0, maxTokens: 2_000 })).toBeCloseTo(2 * ((2_000 * 0.5) / 1e6), 6);
  });

  it("is about two cents for a call on Haiku 5.5, and about eighty for a draft on Sonnet 5.5", () => {
    expect(creditHoldUsd("claude-haiku-5-5", { promptChars: 40_000 })).toBeCloseTo(0.02, 2);
    const draft = creditHoldUsd("claude-sonnet-5-5", { promptChars: 80_000, maxTokens: 32_000 });
    expect(draft).toBeGreaterThan(0.7);
    expect(draft).toBeLessThan(0.9);
  });

  it("asks nothing of the stand-in model, which costs nothing, and more of one it does not know", () => {
    expect(creditHoldUsd("fake", { promptChars: 100_000, maxTokens: 32_000 })).toBe(0);
    expect(creditHoldUsd("claude-unknown", { promptChars: 40_000 })).toBeGreaterThan(creditHoldUsd("claude-haiku-5-5", { promptChars: 40_000 }));
  });

  it("does not take two requests' prompts together for Haiku 5.5's long-prompt price: each request is under the line", () => {
    expect(creditHoldUsd("claude-haiku-5-5", { promptChars: 160_000 })).toBeCloseTo(2 * ((80_000 * 0.1 + DEFAULT_MAX_TOKENS * 0.5) / 1e6), 6);
  });
});

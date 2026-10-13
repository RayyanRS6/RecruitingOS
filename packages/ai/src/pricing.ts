import type { Usage } from "./types";

/**
 * List prices per million tokens (USD), from Anthropic's price list as of October 2026, with each model's own price for
 * cache reads. Claude Haiku 5.5's price holds for prompts up to 100K tokens (longer ones cost five times as much), so a
 * very long prompt on it is estimated low. Update when prices change; the admin console shows cost from these numbers.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  fake: { input: 0, output: 0, cacheRead: 0 },
};

export function estimateCostUsd(model: string, usage: Usage): number {
  const p = PRICES[model] ?? { input: 5, output: 25, cacheRead: 0.5 };
  const cost = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

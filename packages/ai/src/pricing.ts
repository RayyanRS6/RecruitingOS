import type { Usage } from "./types";

/**
 * List prices per million tokens (USD), from Anthropic's price list as of September 2026.
 * Cache reads are billed at a fraction of input; we use 10% as the estimate.
 * Update when prices change; the admin console shows cost from these numbers.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  fake: { input: 0, output: 0, cacheRead: 0 },
};

export function estimateCostUsd(model: string, usage: Usage): number {
  const p = PRICES[model] ?? { input: 5, output: 25, cacheRead: 0.5 };
  const cost = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

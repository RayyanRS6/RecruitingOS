import type { Usage } from "./types";

type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** A five-minute cache write costs 1.25 times the base input price on every model. */
const rates = (input: number, output: number, cacheRead: number): Rates => ({ input, output, cacheRead, cacheWrite: input * 1.25 });

/**
 * List prices per million tokens (USD), from Anthropic's price list as of October 2026, with each model's own price for
 * cache reads. The app calls only Claude Haiku 5.5 and Claude Sonnet 5.5 (routing.ts); the earlier models stay here so
 * the admin console can still price runs recorded before the switch on 13 Oct 2026. Update when prices change.
 */
const PRICES: Record<string, Rates> = {
  "claude-haiku-5-5": rates(0.1, 0.5, 0.01),
  "claude-sonnet-5-5": rates(2, 10, 0.1),
  "claude-opus-5": rates(5, 25, 0.5),
  "claude-opus-5-5": rates(4, 20, 0.2),
  "claude-sonnet-5": rates(2, 10, 0.2),
  "claude-haiku-4-5": rates(1, 5, 0.1),
  "claude-haiku-4-5-20251001": rates(1, 5, 0.1),
  "claude-fable-5-1": rates(10, 50, 0.25),
  fake: rates(0, 0, 0),
};

/**
 * Claude Haiku 5.5 has a second price for a request whose prompt is over 100,000 tokens, counting input, cache reads
 * and cache writes together: five times the base, output included. A call's correction turn is a second request and
 * the usage here is their sum, so a call near the line is an estimate.
 */
const HAIKU_55_LONG_PROMPT = 100_000;
const HAIKU_55_LONG = rates(0.5, 2.5, 0.05);

/** A model this table does not know is priced as Opus 5, the dearest it ever used, rather than as free. */
const UNKNOWN = rates(5, 25, 0.5);

export function estimateCostUsd(model: string, usage: Usage): number {
  const write = usage.cacheWriteTokens ?? 0;
  const prompt = usage.inputTokens + usage.cacheReadTokens + write;
  const p = model === "claude-haiku-5-5" && prompt > HAIKU_55_LONG_PROMPT ? HAIKU_55_LONG : (PRICES[model] ?? UNKNOWN);
  const cost = (usage.inputTokens * p.input + usage.outputTokens * p.output + usage.cacheReadTokens * p.cacheRead + write * p.cacheWrite) / 1_000_000;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

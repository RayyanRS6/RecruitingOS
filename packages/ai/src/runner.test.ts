import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PromptDef } from "./prompts/registry";
import { API_ROUTE_LIMIT_MS, callPrompt, routeDeadline, type AiRuntime } from "./runner";
import type { AiProvider, StructuredRequest, StructuredResult } from "./types";

/**
 * The runner's own retry against a stand-in provider. It asks once more with the validation error fed back, but not
 * when the provider marked the failure final: on staging (13 Oct 2026) the provider's correction turn plus the runner's
 * retry stacked intake.compile past the /api route's 300 s limit, which ends in a 504 with no ai_runs row.
 */
type Draft = { title: string };

const prompt: PromptDef<null, Draft> = {
  key: "test.prompt",
  version: 1,
  task: "intake.compile",
  agent: "intake",
  schema: z.object({ title: z.string() }),
  system: () => [{ text: "You draft roles." }],
  messages: () => [{ role: "user", content: "Draft it." }],
};

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 };
const ok: StructuredResult<Draft> = { kind: "ok", output: { title: "Engineer" }, model: "m", usage, latencyMs: 1 };
const invalid = (over: { error?: string; final?: boolean } = {}): StructuredResult<Draft> => ({ kind: "invalid", error: "title: expected string", model: "m", usage, latencyMs: 1, ...over });

function runtime(results: Array<StructuredResult<Draft>>) {
  const requests: Array<StructuredRequest<unknown>> = [];
  const provider: AiProvider = {
    id: "stand-in",
    async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      requests.push(req as StructuredRequest<unknown>);
      const next = results.shift();
      if (!next) throw new Error("no result queued");
      return next as unknown as StructuredResult<T>;
    },
  };
  const rt: AiRuntime = { provider, models: { judgment: "m", standard: "m", fast: "m" } };
  return { rt, requests };
}

describe("the runner's retry", () => {
  it("asks once more, with the error fed back, when the provider leaves an invalid reply open", async () => {
    const { rt, requests } = runtime([invalid(), ok]);
    const call = await callPrompt(rt, prompt, null, { companyId: null });
    expect(call.result.kind).toBe("ok");
    expect(call.attempts).toBe(2);
    expect(requests[1]!.messages.at(-1)!.content).toContain("title: expected string");
  });

  it("does not ask again when the provider marked the failure final", async () => {
    const { rt, requests } = runtime([invalid({ final: true }), ok]);
    const call = await callPrompt(rt, prompt, null, { companyId: null });
    expect(call.result).toMatchObject({ kind: "invalid", final: true });
    expect(call.attempts).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("does not ask again after a provider error", async () => {
    const { rt, requests } = runtime([invalid({ error: "provider error: 529 overloaded" }), ok]);
    const call = await callPrompt(rt, prompt, null, { companyId: null });
    expect(call.result.kind).toBe("invalid");
    expect(requests).toHaveLength(1);
  });
});

describe("the deadline of the request a call serves", () => {
  it("is the /api route's limit, counted from the start of the request", () => {
    expect(API_ROUTE_LIMIT_MS).toBe(300_000);
    expect(routeDeadline(1_000)).toBe(301_000);
  });

  it("reaches the provider on every attempt, so a retry cannot run past it either", async () => {
    const { rt, requests } = runtime([invalid(), ok]);
    await callPrompt(rt, prompt, null, { companyId: null, deadlineAt: 301_000 });
    expect(requests.map((r) => r.deadlineAt)).toEqual([301_000, 301_000]);
  });

  it("is left out when the caller sets none (the worker), and each call keeps its own budget", async () => {
    const { rt, requests } = runtime([ok]);
    await callPrompt(rt, prompt, null, { companyId: null });
    expect(requests[0]!.deadlineAt).toBeUndefined();
  });
});

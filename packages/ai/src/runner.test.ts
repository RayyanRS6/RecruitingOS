import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "@ros/db";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { creditHoldUsd, estimateCostUsd } from "./pricing";
import type { PromptDef } from "./prompts/registry";
import { AnthropicProvider, ROUTE_RESERVE_MS } from "./providers/anthropic";
import { AI_CREDIT_BUSY, API_ROUTE_LIMIT_MS, callPrompt, routeDeadline, runPromptDetached, type AiCreditGate, type AiRunValues, type AiRuntime } from "./runner";
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

function runtime(results: Array<StructuredResult<Draft>>, opts: { id?: string; model?: string } = {}) {
  const requests: Array<StructuredRequest<unknown>> = [];
  const provider: AiProvider = {
    id: opts.id ?? "stand-in",
    async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      requests.push(req as StructuredRequest<unknown>);
      const next = results.shift();
      if (!next) throw new Error("no result queued");
      return next as unknown as StructuredResult<T>;
    },
  };
  const m = opts.model ?? "m";
  const rt: AiRuntime = { provider, models: { judgment: m, standard: m, fast: m } };
  return { rt, requests };
}

describe("the models and effort the runner asks for", () => {
  it("sends each task's effort: high for the draft and the candidate reading, medium for the rest", async () => {
    const { rt, requests } = runtime([ok, ok, ok]);
    await callPrompt(rt, prompt, null, { companyId: null });
    await callPrompt(rt, { ...prompt, task: "triage.assess" }, null, { companyId: null });
    await callPrompt(rt, { ...prompt, task: "intake.turn" }, null, { companyId: null });
    expect(requests.map((r) => r.effort)).toEqual(["high", "high", "medium"]);
  });

  it("sends a tier's effort from the environment instead, when the runtime carries one", async () => {
    const { rt, requests } = runtime([ok, ok]);
    const tuned: AiRuntime = { ...rt, efforts: { standard: "low" } };
    await callPrompt(tuned, { ...prompt, task: "triage.assess" }, null, { companyId: null });
    await callPrompt(tuned, { ...prompt, task: "resume.extract" }, null, { companyId: null });
    expect(requests.map((r) => r.effort)).toEqual(["low", "medium"]);
  });

  it("never sends the real provider a model outside Haiku 5.5 and Sonnet 5.5, whatever runtime was built", async () => {
    const refused = runtime([ok], { id: "anthropic", model: "claude-opus-5" });
    const call = await callPrompt(refused.rt, prompt, null, { companyId: null });
    expect(refused.requests).toHaveLength(0);
    expect(call.result).toMatchObject({ kind: "invalid", final: true, error: "provider refused: claude-opus-5 is not allowed; the app runs only on claude-haiku-5-5 and claude-sonnet-5-5" });
    const allowed = runtime([ok], { id: "anthropic", model: "claude-sonnet-5-5" });
    expect((await callPrompt(allowed.rt, prompt, null, { companyId: null })).result.kind).toBe("ok");
  });
});

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

/**
 * What a call that failed costs on the company's AI credit, through the real Anthropic adapter against a stand-in client:
 * the hold is about 1.6 cents on Haiku 5.5, and it stays only where a reply began (the SDK's stream says "connect").
 */
describe("what a failed call settles at", () => {
  const HAIKU = "claude-haiku-5-5";
  const turn: PromptDef<null, Draft> = { ...prompt, task: "screen.turn" };
  type Next = { fails: Error; began?: boolean } | { text: string } | { hangs: true; began?: boolean };
  const firstReply = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0 };

  /** The stand-in client: each request fails before or after "connect", answers, or says nothing more until the call is stopped. */
  const clientOf = (answers: Next[]) => ({
    messages: {
      stream(_params: unknown, opts?: { signal?: AbortSignal }) {
        const next = answers.shift()!;
        let connected = () => {};
        const stream = {
          on(event: string, listener: () => void) { if (event === "connect") connected = listener; return stream; },
          finalMessage: async () => {
            if ("text" in next) { connected(); return { content: [{ type: "text", text: next.text }], stop_reason: "end_turn", stop_details: null, usage: firstReply }; }
            if (next.began) connected();
            if ("hangs" in next) return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError())));
            throw next.fails;
          },
        };
        return stream;
      },
    },
  }) as unknown as Anthropic;

  const settledAt = async (answers: Next[], meta: { deadlineAt?: number } = {}) => {
    const settled: Array<Partial<AiRunValues>> = [];
    const credit: AiCreditGate = { hold: async () => "held", settle: async (_db, input) => { settled.push(input.values); } };
    const rt: AiRuntime = { provider: new AnthropicProvider(undefined, clientOf(answers)), models: { judgment: HAIKU, standard: HAIKU, fast: HAIKU }, credit };
    const out = await runPromptDetached({} as Db, rt, turn, null, { companyId: "c1", ...meta });
    expect(out.ok).toBe(false);
    expect(settled).toHaveLength(1);
    return Number(settled[0]!.costUsd);
  };
  const hold = creditHoldUsd(HAIKU, { promptChars: "You draft roles.Draft it.".length });
  const connectionError = () => new Anthropic.APIConnectionError({ message: undefined });

  it("a hold that timed out on the lock is an ordinary failed call, with nothing to settle; any other error goes on up", async () => {
    const provider: AiProvider = { id: "never", structured: async () => { throw new Error("the model was asked"); } };
    const asked = (error: unknown) => runPromptDetached({} as Db, { provider, models: { judgment: HAIKU, standard: HAIKU, fast: HAIKU }, credit: { hold: async () => { throw error; }, settle: async () => { throw new Error("settled"); } } }, turn, null, { companyId: "c1" });
    // however the driver and the query builder wrap it
    for (const error of [Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }), Object.assign(new Error("Failed query"), { cause: { code: "55P03" } })]) {
      const out = await asked(error);
      expect(out).toMatchObject({ ok: false, reason: "error", error: AI_CREDIT_BUSY });
      // not an outage to the engine, which goes by this word
      expect(out.ok === false && out.error.startsWith("provider")).toBe(false);
    }
    await expect(asked(new Error("boom"))).rejects.toThrow("boom");
    await expect(asked(Object.assign(new Error("deadlock detected"), { code: "40P01" }))).rejects.toThrow("deadlock");
  });

  it("the hold really is about 1.6 cents, so the money below is real", () => {
    expect(hold).toBeGreaterThan(0.015);
    expect(hold).toBeLessThan(0.017);
  });

  it("nothing for a connection that never opened", async () => {
    expect(await settledAt([{ fails: connectionError() }])).toBe(0);
  });

  it("nothing for an answer with an HTTP status", async () => {
    expect(await settledAt([{ fails: new Anthropic.InternalServerError(529, { type: "overloaded_error" }, undefined, new Headers()) }])).toBe(0);
  });

  it("the whole hold for a reply that began and was cut", async () => {
    expect(await settledAt([{ fails: new Error("terminated"), began: true }])).toBeCloseTo(hold, 6);
  });

  it("nothing for a call the deadline stopped before the provider answered, and the whole hold for one it stopped part-way through a reply", async () => {
    // an outage where the connection hangs rather than fails: 15 tries of 6 calls kept 1.6 cents each, $1.44 of Free's $10 for one
    // applicant. A budget of 200 ms here: the request the call serves must answer by then (`deadlineAt`, less the route's reserve).
    const soon = () => ({ deadlineAt: Date.now() + ROUTE_RESERVE_MS + 200 });
    expect(await settledAt([{ hangs: true }], soon())).toBe(0);
    expect(await settledAt([{ hangs: true, began: true }], soon())).toBeCloseTo(hold, 6);
    expect(90 * hold).toBeGreaterThan(1.4);
  });

  it("the first reply's cost for a correction turn lost before it began, and the hold for one cut part-way", async () => {
    const reply = estimateCostUsd(HAIKU, { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0 });
    expect(reply).toBeLessThan(hold);
    expect(await settledAt([{ text: '{"title":1}' }, { fails: connectionError() }])).toBeCloseTo(reply, 6);
    expect(await settledAt([{ text: '{"title":1}' }, { fails: new Error("terminated"), began: true }])).toBeCloseTo(hold, 6);
  });
});

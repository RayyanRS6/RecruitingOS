import Anthropic from "@anthropic-ai/sdk";
import { DraftRolePacket } from "@ros/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StructuredRequest } from "../types";
import { AnthropicProvider, CALL_BUDGET_MS, CORRECTION_FLOOR_MS, ROUTE_RESERVE_MS, acceptsEffort, extractJson, instructionSchema, isGrammarTooLarge, withoutNulls } from "./anthropic";

/**
 * The Anthropic adapter against a stand-in client (no network, no key). Pins the faults the live runs on staging found:
 * intake.compile asked for 24,000 tokens without streaming, which the SDK refuses before sending, and intake.turn's
 * schema was too large for the API to compile into a decoding grammar (12 Oct 2026); Haiku 4.5 rejects the effort
 * setting, a constrained reply that broke a zod rule surfaced as a provider error, and retries could stack past the
 * route's 300 s limit (13 Oct 2026).
 */
type Sent = Record<string, unknown> & { output_config?: { format?: unknown; effort?: string }; system?: Array<{ text: string }>; messages?: Array<{ role: string; content: string }> };
type Options = { timeout?: number; signal?: AbortSignal };
type Reply = ReturnType<typeof reply>;
type Answer = Reply | Error | ((options: Options) => Reply | Promise<Reply>);

function reply(over: { text?: string; stop?: string } = {}) {
  return {
    content: over.text === undefined ? [] : [{ type: "text", text: over.text }],
    stop_reason: over.stop ?? "end_turn",
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  };
}

function fakeClient(answers: Answer[]) {
  const sent: Sent[] = [];
  const options: Options[] = [];
  const client = {
    messages: {
      stream(params: Sent, opts?: Options) {
        sent.push(params);
        options.push(opts ?? {});
        const next = answers.shift();
        return {
          finalMessage: async () => {
            if (!next) throw new Error("no answer queued");
            if (next instanceof Error) throw next;
            return typeof next === "function" ? next(opts ?? {}) : next;
          },
        };
      },
      parse() {
        throw new Error("the adapter must stream, not call messages.parse");
      },
    },
  };
  return { client: client as unknown as Anthropic, sent, options };
}

/** An answer that arrives after `ms` of (fake) time. */
const after = (ms: number, answer: Reply) => () => {
  vi.advanceTimersByTime(ms);
  return answer;
};

const grammarError = () =>
  new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." } }, undefined, new Headers());

function request<T>(schema: z.ZodType<T>, maxTokens?: number): StructuredRequest<T> {
  return { task: "intake.compile", agent: "intake", companyId: null, promptKey: "test.prompt", promptVersion: 1, system: [{ text: "You draft roles.", cache: true }], messages: [{ role: "user", content: "Draft it." }], schema, inputRef: {}, maxTokens };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the Anthropic adapter", () => {
  it("streams every request, even one asking for 24,000 tokens, with the schema as a plain JSON-schema output format", async () => {
    const schema = z.object({ title: z.string() });
    const { client, sent } = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema, 24000), "claude-opus-5");
    expect(out).toMatchObject({ kind: "ok", output: { title: "Engineer" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "claude-opus-5", max_tokens: 24000, output_config: { effort: "high" } });
    // No parse function: the SDK must not validate (and throw) inside finalMessage; the adapter validates the text.
    expect(sent[0]!.output_config?.format).toEqual({ type: "json_schema", schema: expect.objectContaining({ type: "object" }) });
    expect(sent[0]!.output_config?.format).not.toHaveProperty("parse");
  });

  it("sends the request again without constrained decoding when the schema is too large for a grammar, and remembers it", async () => {
    const schema = z.object({ reply: z.string(), done: z.boolean() });
    const { client, sent } = fakeClient([grammarError(), reply({ text: '{"reply":"Tell me the pay range.","done":false}' }), reply({ text: '```json\n{"reply":"Thanks.","done":true}\n```' })]);
    const provider = new AnthropicProvider(undefined, client);

    const first = await provider.structured(request(schema), "claude-opus-5");
    expect(first).toMatchObject({ kind: "ok", output: { reply: "Tell me the pay range.", done: false } });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.output_config?.format).toBeUndefined();
    expect(sent[1]!.output_config?.effort).toBe("high");
    const instruction = sent[1]!.system!.at(-1)!.text;
    expect(instruction).toContain("JSON Schema");
    expect(instruction).toContain('"done"');

    // The same prompt later goes straight to the unconstrained request: no refused call first.
    const second = await provider.structured(request(schema), "claude-opus-5");
    expect(second).toMatchObject({ kind: "ok", output: { reply: "Thanks.", done: true } });
    expect(sent).toHaveLength(3);
    expect(sent[2]!.output_config?.format).toBeUndefined();
  });

  it("writes zod's own schema into the instructions: a record may hold keys, and a maximum count stays a rule", async () => {
    // A rule's expectation is a record; the grammar version of the schema says it may hold no keys at all.
    const schema = z.object({ expectation: z.record(z.string(), z.unknown()), mustHaves: z.array(z.string()).max(6) });
    const { client, sent } = fakeClient([grammarError(), reply({ text: '{"expectation":{"days":["Mon","Tue"],"withinDays":30},"mustHaves":["RDH license"]}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "ok", output: { expectation: { days: ["Mon", "Tue"], withinDays: 30 } } });
    const instruction = sent[1]!.system!.at(-1)!.text;
    expect(instruction).toContain(instructionSchema(schema));
    expect(instruction).not.toContain('"properties":{},"additionalProperties":false');
    expect(instruction).toContain('"maxItems":6');
    // the constrained request still sends the SDK's grammar version
    expect(JSON.stringify(sent[0]!.output_config?.format)).toContain('"expectation":{"type":"object","properties":{},"additionalProperties":false');
  });

  it("gives the role packet's records their keys in the instructions (intake.compile and packet.revise always go unconstrained)", () => {
    const records: unknown[] = [];
    const walk = (v: unknown) => {
      if (!v || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (k === "expectation" || k === "labels") records.push(x);
        walk(x);
      }
    };
    walk(JSON.parse(instructionSchema(DraftRolePacket)));
    expect(records).toHaveLength(2);
    for (const r of records) expect(r).toMatchObject({ type: "object", additionalProperties: {} });
  });

  it("falls back the same way for the too-many-optional-parameters refusal (intake.compile on staging)", async () => {
    const schema = z.object({ title: z.string(), note: z.string().optional() });
    const tooManyOptional = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "Schemas contains too many optional parameters (40), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24)." } }, undefined, new Headers());
    const { client, sent } = fakeClient([tooManyOptional, reply({ text: '{"title":"Engineer"}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "ok", output: { title: "Engineer" } });
    expect(sent[1]!.output_config?.format).toBeUndefined();
  });

  it("drops nulls an optional field cannot take, rather than failing the reply", async () => {
    const schema = z.object({ title: z.string(), department: z.string().optional(), rounds: z.array(z.object({ name: z.string(), notes: z.string().optional() })) });
    const { client, sent } = fakeClient([grammarError(), reply({ text: '{"title":"Engineer","department":null,"rounds":[{"name":"Screen","notes":null}]}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "ok", output: { title: "Engineer", rounds: [{ name: "Screen" }] } });
    expect(sent).toHaveLength(2);
  });

  it("gives a reply that does not validate one correction turn, quoting what was wrong", async () => {
    const schema = z.object({ count: z.number() });
    const { client, sent } = fakeClient([grammarError(), reply({ text: '{"count":"three"}' }), reply({ text: '{"count":3}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "ok", output: { count: 3 }, usage: { inputTokens: 20, outputTokens: 10 } });
    expect(sent).toHaveLength(3);
    const turns = sent[2]!.messages!;
    expect(turns.at(-2)).toEqual({ role: "assistant", content: '{"count":"three"}' });
    expect(turns.at(-1)!.role).toBe("user");
    expect(turns.at(-1)!.content).toContain("does not validate");
  });

  it("records the reply as invalid, and final, when the correction does not validate either", async () => {
    const schema = z.object({ count: z.number() });
    const { client, sent } = fakeClient([grammarError(), reply({ text: '{"count":"three"}' }), reply({ text: '{"count":"still three"}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "invalid", final: true });
    if (out.kind === "invalid") {
      expect(out.error).toMatch(/^no valid output \(unconstrained\): /);
      expect(out.rawText).toContain("still three");
    }
    expect(sent).toHaveLength(3);
  });

  it("records an unconstrained reply cut off at max_tokens as invalid and final, without asking again", async () => {
    const schema = z.object({ a: z.string() });
    const { client, sent } = fakeClient([grammarError(), reply({ text: "I will now write the role", stop: "max_tokens" })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "invalid", error: "no parsed output (unconstrained): the reply hit max_tokens (5 output tokens, thinking included)", final: true });
    expect(sent).toHaveLength(2);
  });

  it("does not retry other errors: they are recorded as provider errors", async () => {
    const schema = z.object({ a: z.string() });
    const { client, sent } = fakeClient([new Anthropic.BadRequestError(400, undefined, "messages: roles must alternate", new Headers())]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "invalid", error: "provider error: 400 messages: roles must alternate" });
    expect(sent).toHaveLength(1);
  });

  it("passes a refusal through, on either path", async () => {
    const schema = z.object({ a: z.string() });
    const { client } = fakeClient([reply({ stop: "refusal" })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out.kind).toBe("refused");
  });
});

describe("a constrained reply that breaks a rule the grammar cannot hold", () => {
  // A maximum count is one such rule: intake.compile's mustHaves allows 6, and the grammar does not enforce it.
  const mustHaves = () => z.object({ mustHaves: z.array(z.string()).max(2) });

  it("is validated here and gets one correction turn, with the constrained format kept", async () => {
    const { client, sent } = fakeClient([reply({ text: '{"mustHaves":["a","b","c"]}' }), reply({ text: '{"mustHaves":["a","b"]}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(mustHaves()), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "ok", output: { mustHaves: ["a", "b"] }, usage: { inputTokens: 20, outputTokens: 10 } });
    expect(sent).toHaveLength(2);
    expect(sent[1]!.output_config).toEqual(sent[0]!.output_config);
    expect(sent[1]!.output_config?.format).toMatchObject({ type: "json_schema" });
    const turns = sent[1]!.messages!;
    expect(turns).toHaveLength(3);
    expect(turns[1]).toEqual({ role: "assistant", content: '{"mustHaves":["a","b","c"]}' });
    expect(turns[2]!.content).toContain("does not validate");
  });

  it("is recorded as invalid (not a provider error) and final when the correction breaks it too", async () => {
    const { client, sent } = fakeClient([reply({ text: '{"mustHaves":["a","b","c"]}' }), reply({ text: '{"mustHaves":["a","b","c","d"]}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(mustHaves()), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "invalid", final: true });
    if (out.kind === "invalid") {
      expect(out.error).toMatch(/^no valid output: /);
      expect(out.rawText).toContain('"d"');
    }
    expect(sent).toHaveLength(2);
  });

  it("gets the same correction turn when the reply holds no JSON at all", async () => {
    const { client, sent } = fakeClient([reply({ text: "" }), reply({ text: '{"mustHaves":[]}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(mustHaves()), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "ok", output: { mustHaves: [] } });
    expect(sent[1]!.messages![1]).toEqual({ role: "assistant", content: "(empty reply)" });
  });

  it("is not asked again when it was cut off at max_tokens", async () => {
    const { client, sent } = fakeClient([reply({ text: '{"mustHaves":["a"', stop: "max_tokens" })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(mustHaves()), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "invalid", error: "no parsed output: the reply hit max_tokens (5 output tokens, thinking included)", final: true });
    expect(sent).toHaveLength(1);
  });

  it("keeps a reply whose only fault is a null in an optional field", async () => {
    const schema = z.object({ title: z.string(), department: z.string().optional() });
    const { client, sent } = fakeClient([reply({ text: '{"title":"Engineer","department":null}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-sonnet-5");
    expect(out).toMatchObject({ kind: "ok", output: { title: "Engineer" } });
    expect(sent).toHaveLength(1);
  });
});

describe("the effort setting", () => {
  it("is left out for Haiku 4.5, which rejects it, on both paths", async () => {
    const schema = z.object({ title: z.string() });
    const { client, sent } = fakeClient([grammarError(), reply({ text: '{"title":"Engineer"}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-haiku-4-5-20251001");
    expect(out).toMatchObject({ kind: "ok" });
    expect(sent[0]!.output_config).toEqual({ format: expect.objectContaining({ type: "json_schema" }) });
    expect(sent[1]).not.toHaveProperty("output_config");
  });

  it("is sent to models that take it when the runner names none: high for Opus and medium for the rest", async () => {
    const cases: Array<[string, string | undefined]> = [
      ["claude-opus-4-5", "high"],
      ["claude-opus-5-5", "high"],
      ["claude-sonnet-5-5", "medium"],
      ["claude-haiku-5-5", "medium"],
      ["claude-sonnet-4-5-20250929", undefined],
    ];
    for (const [model, effort] of cases) {
      const { client, sent } = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
      await new AnthropicProvider(undefined, client).structured(request(z.object({ title: z.string() })), model);
      expect(sent[0]!.output_config?.effort, model).toBe(effort);
    }
  });

  it("is known per model: Opus 4.5+, Sonnet 4.6+, Haiku 5.5+, every Fable; not Haiku 4.5, Sonnet 4.5 or older", () => {
    for (const model of ["claude-opus-4-5", "claude-opus-4-5-20251101", "claude-opus-4-6", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5", "claude-fable-5-1", "claude-mythos-5-1", "anthropic.claude-opus-5-5", "claude-opus-4-5@20251101"]) {
      expect(acceptsEffort(model), model).toBe(true);
    }
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1-20250805", "claude-opus-4-20250514", "claude-sonnet-4-20250514", "claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022", "fake", ""]) {
      expect(acceptsEffort(model), model).toBe(false);
    }
  });
});

describe("the time budget of one call", () => {
  it("sends each request with the time that is left as its timeout, and the call's deadline signal", async () => {
    vi.useFakeTimers();
    const schema = z.object({ count: z.number() });
    const { client, options } = fakeClient([after(100_000, reply({ text: '{"count":"three"}' })), reply({ text: '{"count":3}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out.kind).toBe("ok");
    expect(options.map((o) => o.timeout)).toEqual([CALL_BUDGET_MS, CALL_BUDGET_MS - 100_000]);
    expect(options[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(options[1]!.signal).toBe(options[0]!.signal);
    expect(options[0]!.signal!.aborted).toBe(false);
  });

  it("skips the correction turn when too little of the budget is left, and marks the failure final", async () => {
    vi.useFakeTimers();
    const schema = z.object({ count: z.number() });
    const { client, sent } = fakeClient([after(CALL_BUDGET_MS - CORRECTION_FLOOR_MS + 1, reply({ text: '{"count":"three"}' })), reply({ text: '{"count":3}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "invalid", final: true });
    if (out.kind === "invalid") expect(out.error).toContain("too little time was left to ask for a correction");
    expect(sent).toHaveLength(1);
  });

  it("stops a request still running when the budget is spent, and records a provider error so nothing retries it", async () => {
    vi.useFakeTimers();
    const schema = z.object({ title: z.string() });
    const hangs = (opts: Options) => new Promise<Reply>((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError())));
    const { client } = fakeClient([hangs]);
    const pending = new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    await vi.advanceTimersByTimeAsync(CALL_BUDGET_MS);
    const out = await pending;
    expect(out).toMatchObject({ kind: "invalid", error: "provider error: the model did not finish within 270 seconds, so the call was stopped", final: true });
  });
});

describe("the deadline of the request a call serves", () => {
  // A turn after a pasted ad's read runs two calls in one /api request, so each cannot have a full budget of its own.
  it("ends the call that much before the request's deadline when that is sooner than its own budget", async () => {
    vi.useFakeTimers();
    const schema = z.object({ count: z.number() });
    const { client, sent, options } = fakeClient([reply({ text: '{"count":"three"}' }), reply({ text: '{"count":3}' })]);
    const out = await new AnthropicProvider(undefined, client).structured({ ...request(schema), deadlineAt: Date.now() + 100_000 }, "claude-opus-5");
    expect(options[0]!.timeout).toBe(100_000 - ROUTE_RESERVE_MS);
    // 70 seconds is too little for a correction turn, so the invalid reply is final
    expect(out).toMatchObject({ kind: "invalid", final: true });
    expect(sent).toHaveLength(1);
  });

  it("keeps the call's own budget when the request's deadline is further away", async () => {
    vi.useFakeTimers();
    const { client, options } = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
    await new AnthropicProvider(undefined, client).structured({ ...request(z.object({ title: z.string() })), deadlineAt: Date.now() + 600_000 }, "claude-opus-5");
    expect(options[0]!.timeout).toBe(CALL_BUDGET_MS);
  });

  it("stops a request still running at that point, and says how long it had", async () => {
    vi.useFakeTimers();
    const hangs = (opts: Options) => new Promise<Reply>((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError())));
    const { client } = fakeClient([hangs]);
    const pending = new AnthropicProvider(undefined, client).structured({ ...request(z.object({ title: z.string() })), deadlineAt: Date.now() + 100_000 }, "claude-opus-5");
    await vi.advanceTimersByTimeAsync(100_000 - ROUTE_RESERVE_MS);
    expect(await pending).toMatchObject({ kind: "invalid", error: "provider error: the model did not finish within 70 seconds, so the call was stopped", final: true });
  });

  it("does not ask the model at all when the request has no time left for it", async () => {
    vi.useFakeTimers();
    const { client, sent } = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
    const out = await new AnthropicProvider(undefined, client).structured({ ...request(z.object({ title: z.string() })), deadlineAt: Date.now() + ROUTE_RESERVE_MS }, "claude-opus-5");
    expect(out).toMatchObject({ kind: "invalid", error: "provider error: the request had no time left for the model, so it was not asked", final: true });
    expect(sent).toHaveLength(0);
  });
});

describe("reading JSON from an unconstrained reply", () => {
  it("takes the whole reply, a fenced block, or the outermost braces", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here it is: {"a":3} as asked.')).toEqual({ a: 3 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJson("no json here")).toThrow("no JSON object");
  });

  it("removes null-valued keys at any depth and keeps everything else", () => {
    expect(withoutNulls({ a: null, b: 0, c: [{ d: null, e: "x" }, null], f: { g: null, h: false } })).toEqual({ b: 0, c: [{ e: "x" }, null], f: { h: false } });
  });

  it("recognises only the grammar refusals", () => {
    expect(isGrammarTooLarge(grammarError())).toBe(true);
    const bad = (message: string) => new Anthropic.BadRequestError(400, undefined, message, new Headers());
    // the documented limits that apply to every model, Haiku 5.5 and Sonnet 5.5 included
    expect(isGrammarTooLarge(bad("Schemas contains too many optional parameters (40), which would make grammar compilation inefficient (limit: 24)"))).toBe(true);
    expect(isGrammarTooLarge(bad("Schemas contains too many parameters with union types (18) (limit: 16)"))).toBe(true);
    expect(isGrammarTooLarge(bad("Schema is too complex for compilation."))).toBe(true);
    expect(isGrammarTooLarge(bad("other"))).toBe(false);
    expect(isGrammarTooLarge(bad("This model does not support assistant message prefill. The conversation must end with a user message."))).toBe(false);
    expect(isGrammarTooLarge(new Error("The compiled grammar is too large"))).toBe(false);
  });
});

describe("requests to Haiku 5.5 and Sonnet 5.5", () => {
  const schema = z.object({ title: z.string() });

  it("always end with a user turn: both models refuse an assistant turn last (a prefill)", async () => {
    const { client, sent } = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
    const req = { ...request(schema), messages: [{ role: "user" as const, content: "A role." }, { role: "assistant" as const, content: "Tell me more." }] };
    await new AnthropicProvider(undefined, client).structured(req, "claude-haiku-5-5");
    expect(sent[0]!.messages!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(sent[0]!.messages!.at(-1)!.content).toBe("Continue.");
    // a conversation that already ends with the user is sent as it is
    const plain = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
    await new AnthropicProvider(undefined, plain.client).structured(request(schema), "claude-haiku-5-5");
    expect(plain.sent[0]!.messages).toEqual([{ role: "user", content: "Draft it." }]);
  });

  it("carry the effort the runner chose for the task, not one guessed from the model's name", async () => {
    const { client, sent } = fakeClient([reply({ text: '{"title":"Engineer"}' })]);
    await new AnthropicProvider(undefined, client).structured({ ...request(schema), effort: "high" }, "claude-sonnet-5-5");
    expect(sent[0]!.output_config?.effort).toBe("high");
  });

  it("count cache writes, so the recorded cost includes them", async () => {
    const answer = { ...reply({ text: '{"title":"Engineer"}' }), usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 700 } };
    const { client } = fakeClient([answer as Reply]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-haiku-5-5");
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 700 });
  });

  it("say when thinking used the whole max_tokens before any text was written", async () => {
    const { client } = fakeClient([reply({ stop: "max_tokens" })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-sonnet-5-5");
    expect(out).toMatchObject({ kind: "invalid", final: true, error: "no parsed output: the reply hit max_tokens (5 output tokens, thinking included, no text written)" });
  });
});

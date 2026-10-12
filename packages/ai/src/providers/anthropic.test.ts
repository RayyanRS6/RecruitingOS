import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StructuredRequest } from "../types";
import { AnthropicProvider, extractJson, isGrammarTooLarge } from "./anthropic";

/**
 * The Anthropic adapter against a stand-in client (no network, no key). Pins the two faults the first live run on
 * staging found (12 Oct 2026): intake.compile asked for 24,000 tokens without streaming, which the SDK refuses before
 * sending, and intake.turn's schema was too large for the API to compile into a decoding grammar.
 */
type Sent = Record<string, unknown> & { output_config?: { format?: unknown; effort?: string }; system?: Array<{ text: string }> };

function reply(over: { text?: string; parsed?: unknown; stop?: string } = {}) {
  return {
    content: over.text === undefined ? [] : [{ type: "text", text: over.text }],
    parsed_output: over.parsed ?? null,
    stop_reason: over.stop ?? "end_turn",
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
  };
}

function fakeClient(answers: Array<ReturnType<typeof reply> | Error>) {
  const sent: Sent[] = [];
  const client = {
    messages: {
      stream(params: Sent) {
        sent.push(params);
        const next = answers.shift();
        return { finalMessage: async () => { if (!next) throw new Error("no answer queued"); if (next instanceof Error) throw next; return next; } };
      },
      parse() {
        throw new Error("the adapter must stream, not call messages.parse");
      },
    },
  };
  return { client: client as unknown as Anthropic, sent };
}

const grammarError = () =>
  new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." } }, undefined, new Headers());

function request<T>(schema: z.ZodType<T>, maxTokens?: number): StructuredRequest<T> {
  return { task: "intake.compile", agent: "intake", companyId: null, promptKey: "test.prompt", promptVersion: 1, system: [{ text: "You draft roles.", cache: true }], messages: [{ role: "user", content: "Draft it." }], schema, inputRef: {}, maxTokens };
}

describe("the Anthropic adapter", () => {
  it("streams every request, even one asking for 24,000 tokens, with the schema as the output format", async () => {
    const schema = z.object({ title: z.string() });
    const { client, sent } = fakeClient([reply({ parsed: { title: "Engineer" } })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema, 24000), "claude-opus-5");
    expect(out).toMatchObject({ kind: "ok", output: { title: "Engineer" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: "claude-opus-5", max_tokens: 24000, output_config: { effort: "high" } });
    expect(sent[0]!.output_config?.format).toBeDefined();
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

  it("validates an unconstrained reply against the schema and records a mismatch as invalid", async () => {
    const schema = z.object({ count: z.number() });
    const { client } = fakeClient([grammarError(), reply({ text: '{"count":"three"}' })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-sonnet-5");
    expect(out.kind).toBe("invalid");
    if (out.kind === "invalid") expect(out.rawText).toContain("three");
  });

  it("records an unconstrained reply with no JSON in it as invalid, saying when the reply was cut off", async () => {
    const schema = z.object({ a: z.string() });
    const { client } = fakeClient([grammarError(), reply({ text: "I will now write the role", stop: "max_tokens" })]);
    const out = await new AnthropicProvider(undefined, client).structured(request(schema), "claude-opus-5");
    expect(out).toMatchObject({ kind: "invalid", error: "no parsed output (unconstrained): the reply hit max_tokens" });
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

describe("reading JSON from an unconstrained reply", () => {
  it("takes the whole reply, a fenced block, or the outermost braces", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Here it is: {"a":3} as asked.')).toEqual({ a: 3 });
  });

  it("throws when there is no JSON object", () => {
    expect(() => extractJson("no json here")).toThrow("no JSON object");
  });

  it("recognises only the grammar refusal", () => {
    expect(isGrammarTooLarge(grammarError())).toBe(true);
    expect(isGrammarTooLarge(new Anthropic.BadRequestError(400, undefined, "other", new Headers()))).toBe(false);
    expect(isGrammarTooLarge(new Error("The compiled grammar is too large"))).toBe(false);
  });
});

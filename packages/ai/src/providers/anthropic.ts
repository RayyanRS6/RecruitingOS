import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageStreamParams, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type { AiProvider, StructuredRequest, StructuredResult, Usage } from "../types";

/**
 * Schemas the API would not compile into a decoding grammar, remembered for the life of the process so later calls with
 * the same prompt go straight to the unconstrained path instead of paying for a refused request first. Keyed by the
 * prompt's schema object, which each prompt defines once.
 */
const tooLargeForGrammar = new WeakSet<object>();

/**
 * The 400s the API returns when a schema is too complex to constrain decoding with. Seen on staging, 12 Oct 2026:
 * intake.turn "The compiled grammar is too large, which would cause performance issues" and intake.compile "Schemas
 * contains too many optional parameters (40), which would make grammar compilation inefficient ... (limit: 24)".
 */
export function isGrammarTooLarge(err: unknown): boolean {
  return err instanceof Anthropic.BadRequestError && /grammar|too many optional parameters/i.test(err.message);
}

/**
 * The value with every null-valued object key removed, at any depth. Written without constrained decoding, a reply
 * often fills an optional field it has nothing for with null, which an optional (not nullable) zod field rejects.
 * Tried only after the reply as written fails, so a schema that does accept null keeps it.
 */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
  }
  return value;
}

/**
 * The JSON object in a reply written without constrained decoding: the whole reply, or else the first fenced block, or
 * else the outermost braces. Throws when none of them parses; the caller records the reply as invalid.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidates = [trimmed, fenced, first >= 0 && last > first ? trimmed.slice(first, last + 1) : undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  throw new Error("the reply holds no JSON object");
}

/**
 * The only file that imports the Anthropic SDK. Uses structured outputs (JSON-schema constrained), prompt caching on
 * the stable system blocks, and adaptive thinking (the model default). The request is typed against the SDK, so a
 * change in the SDK's request shape fails the typecheck instead of the first live call.
 *
 * Every request streams: the SDK refuses a non-streaming request whose max_tokens could take longer than ten minutes
 * (the draft asks for 24,000), and a stream keeps a long reply from tripping an idle timeout. When the API cannot
 * compile a prompt's schema into a grammar, the request is sent again without constrained decoding, with the schema
 * in the instructions, and the reply is parsed and validated here against the same schema.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  /** `client` is a test seam; production passes only the key (or nothing, and the SDK reads ANTHROPIC_API_KEY). */
  constructor(apiKey?: string, client?: Anthropic) {
    this.client = client ?? (apiKey ? new Anthropic({ apiKey }) : new Anthropic());
  }

  async structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>> {
    const started = Date.now();
    const system: TextBlockParam[] = req.system.map((b) => (b.cache ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } } : { type: "text", text: b.text }));
    const effort = req.effort ?? (model.includes("opus") ? "high" : "medium");
    const base = {
      model,
      max_tokens: req.maxTokens ?? 16000,
      system,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    const usageOf = (response: Anthropic.Message): Usage => ({
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    });
    try {
      if (!tooLargeForGrammar.has(req.schema)) {
        try {
          const params = { ...base, output_config: { format: zodOutputFormat(req.schema), effort } } satisfies MessageStreamParams;
          const response = await this.client.messages.stream(params).finalMessage();
          const usage = usageOf(response);
          const latencyMs = Date.now() - started;
          if (response.stop_reason === "refusal") {
            return { kind: "refused", reason: response.stop_details?.category ?? "refused", model, usage, latencyMs };
          }
          const parsed = response.parsed_output;
          if (parsed === null || parsed === undefined) {
            const text = response.content.map((c) => (c.type === "text" ? c.text : "")).join("");
            return { kind: "invalid", error: response.stop_reason === "max_tokens" ? "no parsed output: the reply hit max_tokens" : "no parsed output", model, usage, latencyMs, rawText: text };
          }
          const check = req.schema.safeParse(parsed);
          if (!check.success) {
            return { kind: "invalid", error: check.error.message, model, usage, latencyMs, rawText: JSON.stringify(parsed).slice(0, 4000) };
          }
          return { kind: "ok", output: check.data, model, usage, latencyMs, raw: undefined };
        } catch (err) {
          if (!isGrammarTooLarge(err)) throw err;
          tooLargeForGrammar.add(req.schema);
        }
      }
      return await this.unconstrained(req, model, base, effort, started, usageOf);
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "invalid", error: `provider error: ${message}`, model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, latencyMs };
    }
  }

  /**
   * The same request without constrained decoding: the schema goes into the instructions and the reply is validated
   * here. A reply that does not validate gets one correction turn, which quotes what was wrong; the second reply is
   * final either way.
   */
  private async unconstrained<T>(
    req: StructuredRequest<T>,
    model: string,
    base: Pick<MessageStreamParams, "model" | "max_tokens" | "system" | "messages">,
    effort: NonNullable<NonNullable<MessageStreamParams["output_config"]>["effort"]>,
    started: number,
    usageOf: (response: Anthropic.Message) => Usage,
  ): Promise<StructuredResult<T>> {
    const schema = JSON.stringify(zodOutputFormat(req.schema).schema);
    const instruction: TextBlockParam = { type: "text", text: `Reply with exactly one JSON object and nothing else: no words before or after it and no code fence. Leave out an optional field you have nothing for rather than writing null. The object must validate against this JSON Schema:\n${schema}` };
    const system = [...(base.system as TextBlockParam[]), instruction];
    let messages = base.messages;
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let last: { error: string; rawText: string } = { error: "no reply", rawText: "" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const params = { ...base, system, messages, output_config: { effort } } satisfies MessageStreamParams;
      const response = await this.client.messages.stream(params).finalMessage();
      const used = usageOf(response);
      usage.inputTokens += used.inputTokens;
      usage.outputTokens += used.outputTokens;
      usage.cacheReadTokens += used.cacheReadTokens;
      if (response.stop_reason === "refusal") {
        return { kind: "refused", reason: response.stop_details?.category ?? "refused", model, usage, latencyMs: Date.now() - started };
      }
      const text = response.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (response.stop_reason === "max_tokens") {
        // A cut-off reply is not a formatting slip: asking again would be cut off the same way.
        return { kind: "invalid", error: "no parsed output (unconstrained): the reply hit max_tokens", model, usage, latencyMs: Date.now() - started, rawText: text.slice(0, 4000) };
      }
      let problem: string;
      try {
        const value = extractJson(text);
        const asWritten = req.schema.safeParse(value);
        if (asWritten.success) return { kind: "ok", output: asWritten.data, model, usage, latencyMs: Date.now() - started, raw: undefined };
        const tidied = req.schema.safeParse(withoutNulls(value));
        if (tidied.success) return { kind: "ok", output: tidied.data, model, usage, latencyMs: Date.now() - started, raw: undefined };
        problem = asWritten.error.message;
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      last = { error: `no valid output (unconstrained): ${problem}`, rawText: text.slice(0, 4000) };
      messages = [
        ...base.messages,
        { role: "assistant", content: text || "(empty reply)" },
        { role: "user", content: `That reply does not validate against the JSON Schema. What is wrong:\n${problem.slice(0, 2000)}\nReply again with only the corrected JSON object.` },
      ];
    }
    return { kind: "invalid", error: last.error, model, usage, latencyMs: Date.now() - started, rawText: last.rawText };
  }
}

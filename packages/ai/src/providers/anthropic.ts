import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AiProvider, StructuredRequest, StructuredResult, Usage } from "../types";

/**
 * The only file that imports the Anthropic SDK. Uses structured outputs (JSON-schema constrained),
 * prompt caching on the stable system blocks, and adaptive thinking (the model default).
 */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
  }

  async structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>> {
    const started = Date.now();
    const system = req.system.map((b) =>
      b.cache ? { type: "text" as const, text: b.text, cache_control: { type: "ephemeral" as const } } : { type: "text" as const, text: b.text },
    );
    const effort = req.effort ?? (model.includes("opus") ? "high" : "medium");
    try {
      const response = await this.client.messages.parse({
        model,
        max_tokens: req.maxTokens ?? 16000,
        system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { format: zodOutputFormat(req.schema as never), effort },
      } as never);
      const usage: Usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cacheReadTokens: (response.usage as { cache_read_input_tokens?: number } | undefined)?.cache_read_input_tokens ?? 0,
      };
      const latencyMs = Date.now() - started;
      if (response.stop_reason === "refusal") {
        const details = (response as { stop_details?: { category?: string; explanation?: string } }).stop_details;
        return { kind: "refused", reason: details?.explanation ?? details?.category ?? "refused", model, usage, latencyMs };
      }
      const parsed = (response as { parsed_output?: unknown }).parsed_output;
      if (parsed === null || parsed === undefined) {
        const text = response.content.map((c) => (c.type === "text" ? c.text : "")).join("");
        return { kind: "invalid", error: "no parsed output", model, usage, latencyMs, rawText: text };
      }
      const check = req.schema.safeParse(parsed);
      if (!check.success) {
        return { kind: "invalid", error: check.error.message, model, usage, latencyMs, rawText: JSON.stringify(parsed).slice(0, 4000) };
      }
      return { kind: "ok", output: check.data, model, usage, latencyMs, raw: undefined };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "invalid", error: `provider error: ${message}`, model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, latencyMs };
    }
  }
}

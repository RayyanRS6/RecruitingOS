import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageStreamParams, TextBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { z } from "zod";
import type { AiProvider, StructuredRequest, StructuredResult, Usage } from "../types";

/**
 * Schemas the API would not compile into a decoding grammar, remembered for the life of the process so later calls with
 * the same prompt go straight to the unconstrained path instead of paying for a refused request first. Keyed by the
 * prompt's schema object, which each prompt defines once.
 */
const tooLargeForGrammar = new WeakSet<object>();

/**
 * The time budget of one `structured` call, every request in it together: a refused grammar request on a cold process,
 * the reply, and its correction turn. The /api route on Vercel is stopped at 300 s (maxDuration), and a stopped route
 * answers 504 and writes no ai_runs row. Ending the call at 270 s leaves the route time to record the run and answer
 * with its own message, when this call is the route's only slow step. A route that runs two calls, or slow work before
 * one, passes its own deadline (`deadlineAt`), and the call then ends `ROUTE_RESERVE_MS` before it if that is sooner.
 * Every request is sent with the time that is left as its timeout and with a deadline signal, because the SDK's timeout
 * only covers the wait for the reply to start, not the streamed reply itself.
 */
export const CALL_BUDGET_MS = 270_000;

/** What a call leaves of its request's deadline for the route to record the run and answer: the same 30 s as above. */
export const ROUTE_RESERVE_MS = 30_000;

/**
 * A correction turn starts only while this much of the budget is left. intake.compile, the slowest prompt, took about
 * 110 s per request on staging (13 Oct 2026); a correction started with less time than that would be cut off anyway.
 */
export const CORRECTION_FLOOR_MS = 120_000;

/**
 * The 400s the API returns when a schema is too complex to constrain decoding with. Seen on staging, 12 Oct 2026:
 * intake.turn "The compiled grammar is too large, which would cause performance issues" and intake.compile "Schemas
 * contains too many optional parameters (40), which would make grammar compilation inefficient ... (limit: 24)". The
 * documentation names two more limits on every model, Haiku 5.5 and Sonnet 5.5 included: parameters with union types
 * (16) and "Schema is too complex for compilation."
 */
export function isGrammarTooLarge(err: unknown): boolean {
  return err instanceof Anthropic.BadRequestError && /grammar|too many (optional )?parameters|union types|too complex for compilation/i.test(err.message);
}

/** The lowest version, as major * 100 + minor, from which each model family takes an effort setting. */
const EFFORT_FROM: Record<string, number> = { opus: 405, sonnet: 406, haiku: 505 };

/**
 * Whether a model takes output_config.effort: Opus 4.5 and later, Sonnet 4.6 and later, Haiku 5.5 and later, and every
 * Fable or Mythos model. Haiku 4.5, Sonnet 4.5 and older models answer a request that carries it with a 400. A model id this does not recognise gets no effort setting: the model then works at its own default,
 * where sending one could fail every call. Reads ids with a date or a platform prefix too, such as
 * claude-haiku-4-5-20251001 or anthropic.claude-opus-5-5.
 */
export function acceptsEffort(model: string): boolean {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/.exec(model);
  if (!match) return false;
  const [, family, major, minor] = match;
  if (family === "fable" || family === "mythos") return true;
  if (!major) return false;
  return Number(major) * 100 + Number(minor ?? 0) >= EFFORT_FROM[family];
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
 * The JSON Schema written into the instructions of an unconstrained request. It is zod's own rendering, not the SDK's
 * grammar version: that one turns a record (a rule's expectation, a scale's labels) into an object that may hold no
 * keys at all, and moves limits such as a maximum count into a description. A model that followed that version would
 * write {} where the prompt asks for {"days": [...]} or {"withinDays": 30}, and a revision could wipe a live role's days.
 */
export function instructionSchema(schema: StructuredRequest<unknown>["schema"]): string {
  return JSON.stringify(z.toJSONSchema(schema, { reused: "ref" }));
}

/** What every request in one `structured` call shares: when it started and must end, the deadline signal, and the tokens used so far. */
type CallState = { started: number; endsAt: number; signal: AbortSignal; usage: Usage };

/**
 * The only file that imports the Anthropic SDK. Uses structured outputs (JSON-schema constrained), prompt caching on
 * the stable system blocks, and adaptive thinking (the model default). The request is typed against the SDK, so a
 * change in the SDK's request shape fails the typecheck instead of the first live call.
 *
 * Every request streams: the SDK refuses a non-streaming request whose max_tokens could take longer than ten minutes
 * (the draft asks for 32,000), and a stream keeps a long reply from tripping an idle timeout. The schema goes to the API
 * as a plain JSON-schema format, without the SDK's own parse step, so a reply that breaks a rule the grammar cannot
 * express (a maximum count, a date pattern) is validated here and gets a correction turn instead of surfacing as a
 * provider error. When the API cannot compile a prompt's schema into a grammar, the request is sent again without
 * constrained decoding, with the schema in the instructions, and the reply is validated the same way.
 */
export class AnthropicProvider implements AiProvider {
  readonly id = "anthropic";
  private client: Anthropic;

  /**
   * `client` is a test seam; production passes only the key (or nothing, and the SDK reads ANTHROPIC_API_KEY). The
   * client's own timeout is the call budget too, so no request can outlive it even where a per-request timeout were
   * left out (every request here passes the time left of its call, see `ask`).
   */
  constructor(apiKey?: string, client?: Anthropic) {
    this.client = client ?? (apiKey ? new Anthropic({ apiKey, timeout: CALL_BUDGET_MS }) : new Anthropic({ timeout: CALL_BUDGET_MS }));
  }

  async structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>> {
    const started = Date.now();
    const system: TextBlockParam[] = req.system.map((b) => (b.cache ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } } : { type: "text", text: b.text }));
    // The runner sends each task's effort (routing.ts, TIER_EFFORT); left out for models that reject it with a 400.
    const effort = acceptsEffort(model) ? (req.effort ?? (model.includes("opus") ? "high" : "medium")) : undefined;
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    // Haiku 5.5 and Sonnet 5.5 answer a conversation that ends with an assistant turn (a prefill) with a 400, so a
    // request always ends with a turn from the user.
    if (!messages.length || messages[messages.length - 1]!.role === "assistant") messages.push({ role: "user", content: "Continue." });
    const base = { model, max_tokens: req.maxTokens ?? 16000, system, messages };
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    // The call's own budget, or less when the HTTP request it serves must answer sooner (see CALL_BUDGET_MS).
    const endsAt = Math.min(started + CALL_BUDGET_MS, req.deadlineAt === undefined ? Number.POSITIVE_INFINITY : req.deadlineAt - ROUTE_RESERVE_MS);
    if (endsAt <= started) {
      return { kind: "invalid", error: "provider error: the request had no time left for the model, so it was not asked", model, usage, latencyMs: 0, final: true };
    }
    // One deadline for the whole call: it stops whichever request is still running when the budget is spent.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), endsAt - started);
    const call: CallState = { started, endsAt, signal: deadline.signal, usage };
    try {
      if (!tooLargeForGrammar.has(req.schema)) {
        try {
          const format = { type: "json_schema" as const, schema: zodOutputFormat(req.schema).schema };
          const params = { ...base, output_config: effort ? { format, effort } : { format } } satisfies MessageStreamParams;
          return await this.ask(req, params, "", call);
        } catch (err) {
          if (!isGrammarTooLarge(err)) throw err;
          tooLargeForGrammar.add(req.schema);
        }
      }
      const instruction: TextBlockParam = { type: "text", text: `Reply with exactly one JSON object and nothing else: no words before or after it and no code fence. Leave out an optional field you have nothing for rather than writing null. The object must validate against this JSON Schema:\n${instructionSchema(req.schema)}` };
      const params = { ...base, system: [...system, instruction], ...(effort ? { output_config: { effort } } : {}) } satisfies MessageStreamParams;
      return await this.ask(req, params, " (unconstrained)", call);
    } catch (err) {
      const message = deadline.signal.aborted ? `the model did not finish within ${Math.round((endsAt - started) / 1000)} seconds, so the call was stopped` : err instanceof Error ? err.message : String(err);
      return { kind: "invalid", error: `provider error: ${message}`, model, usage, latencyMs: Date.now() - started, final: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Sends the request and validates the reply against the prompt's schema. A reply that does not validate gets one
   * correction turn, which repeats the request (format included) with the reply and what was wrong with it added, as
   * long as the budget leaves time for one; the second reply is final either way. Every invalid result is marked
   * final, so the runner does not ask a third time. `label` names the path in the recorded error.
   */
  private async ask<T>(req: StructuredRequest<T>, params: MessageStreamParams, label: string, call: CallState): Promise<StructuredResult<T>> {
    const { model } = params;
    const { usage, started, endsAt } = call;
    let messages = params.messages;
    let last = { error: "no reply", rawText: "" };
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = Math.max(1, endsAt - Date.now());
      const response = await this.client.messages.stream({ ...params, messages }, { timeout: left, signal: call.signal }).finalMessage();
      usage.inputTokens += response.usage.input_tokens;
      usage.outputTokens += response.usage.output_tokens;
      usage.cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      if (response.stop_reason === "refusal") {
        return { kind: "refused", reason: response.stop_details?.category ?? "refused", model, usage, latencyMs: Date.now() - started };
      }
      const text = response.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      if (response.stop_reason === "max_tokens") {
        // A cut-off reply is not a formatting slip: asking again would be cut off the same way. Thinking counts toward
        // max_tokens, so a reply can stop before any text at all; the count says how much was spent.
        return { kind: "invalid", error: `no parsed output${label}: the reply hit max_tokens (${response.usage.output_tokens} output tokens, thinking included${text ? "" : ", no text written"})`, model, usage, latencyMs: Date.now() - started, rawText: text.slice(0, 4000), final: true };
      }
      const check = validate(req.schema, text);
      if (check.ok) return { kind: "ok", output: check.data, model, usage, latencyMs: Date.now() - started, raw: undefined };
      last = { error: `no valid output${label}: ${check.problem}`, rawText: text.slice(0, 4000) };
      if (attempt === 0 && endsAt - Date.now() < CORRECTION_FLOOR_MS) {
        return { kind: "invalid", error: `no valid output${label}, and too little time was left to ask for a correction: ${check.problem}`, model, usage, latencyMs: Date.now() - started, rawText: last.rawText, final: true };
      }
      messages = [
        ...params.messages,
        { role: "assistant", content: text || "(empty reply)" },
        { role: "user", content: `That reply does not validate against the JSON Schema. What is wrong:\n${check.problem.slice(0, 2000)}\nReply again with only the corrected JSON object.` },
      ];
    }
    return { kind: "invalid", error: last.error, model, usage, latencyMs: Date.now() - started, rawText: last.rawText, final: true };
  }
}

/** The reply checked against the schema as written, then with null-valued keys dropped (see `withoutNulls`). */
function validate<T>(schema: StructuredRequest<T>["schema"], text: string): { ok: true; data: T } | { ok: false; problem: string } {
  try {
    const value = extractJson(text);
    const asWritten = schema.safeParse(value);
    if (asWritten.success) return { ok: true, data: asWritten.data };
    const tidied = schema.safeParse(withoutNulls(value));
    if (tidied.success) return { ok: true, data: tidied.data };
    return { ok: false, problem: asWritten.error.message };
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) };
  }
}

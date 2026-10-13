import { aiRuns, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import { estimateCostUsd } from "./pricing";
import { promptHash, type PromptDef } from "./prompts/registry";
import { ALLOWED_MODELS, TASK_TIER, effortForTask, effortsFromEnv, isAllowedModel, modelForTask, modelTableFromEnv, type Effort, type ModelTable } from "./routing";
import type { AiProvider, StructuredResult, Tier } from "./types";

/** `efforts`: a tier's effort when the environment sets one (AI_EFFORT_*), in place of TIER_EFFORT. */
export type AiRuntime = {
  provider: AiProvider;
  models: ModelTable;
  efforts?: Partial<Record<Tier, Effort>>;
};

export type RunOutcome<T> =
  | { ok: true; output: T; runId: string; model: string }
  | { ok: false; runId: string; model: string; reason: "refused" | "invalid" | "error"; error: string };

/** `deadlineAt`: the deadline of the HTTP request the call serves (`routeDeadline`), shared by every call in it. */
export type RunMeta = { companyId: string | null; workflowRunId?: string | null; inputRef?: Record<string, unknown>; maxTokens?: number; deadlineAt?: number };

/** How long the /api route may run on Vercel: maxDuration in apps/shell/app/api/[[...route]]/route.ts. */
export const API_ROUTE_LIMIT_MS = 300_000;

/**
 * The deadline of an HTTP request that started at `startedAt`, for `RunMeta.deadlineAt`. An agent that makes two model
 * calls in one request (a pasted ad's read, then the turn), or slow work before one, sets it once at the start, so the
 * second call gets what is left rather than a full budget of its own that would run past the route's limit.
 */
export function routeDeadline(startedAt = Date.now()): number {
  return startedAt + API_ROUTE_LIMIT_MS;
}

/** What one prompt call produced, before anything is written: the model's answer (or failure) and what it cost. */
export type PromptCall<TOutput> = { result: StructuredResult<TOutput>; model: string; hash: string; attempts: number };

/**
 * Calls the model with structured output, validates, and retries once on invalid output with the error fed back,
 * unless the provider marked the failure final: it already asked for a correction itself, the reply was cut off at
 * max_tokens, or its time budget is spent. A retry on top of those would stack full model calls past the 300 s limit of
 * the /api route (intake.compile takes about 110 s a call), which ends in a 504 with no ai_runs row.
 * Touches no database: the caller records the outcome with `recordRun` inside whichever transaction suits it, or uses
 * `runPromptDetached`, which does both without holding a transaction open around the call.
 */
export async function callPrompt<TInput, TOutput>(rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, input: TInput, meta: RunMeta): Promise<PromptCall<TOutput>> {
  const model = modelForTask(prompt.task, rt.models);
  const system = prompt.system(input);
  const messages = prompt.messages(input);
  const hash = promptHash(system);
  const started = Date.now();
  // The real provider calls the allowed models only (routing.ts), whatever runtime a caller built by hand.
  if (rt.provider.id === "anthropic" && !isAllowedModel(model)) {
    const error = `provider refused: ${model} is not allowed; the app runs only on ${ALLOWED_MODELS.join(" and ")}`;
    return { result: { kind: "invalid", error, model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, latencyMs: 0, final: true }, model, hash, attempts: 0 };
  }

  let result: StructuredResult<TOutput> | null = null;
  let attempts = 0;
  let lastError = "";
  while (attempts < 2) {
    attempts += 1;
    const req = {
      task: prompt.task,
      agent: prompt.agent,
      companyId: meta.companyId,
      workflowRunId: meta.workflowRunId ?? null,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      system,
      messages: attempts === 1 ? messages : [...messages, { role: "assistant" as const, content: "(previous output was invalid)" }, { role: "user" as const, content: `Your previous output did not match the required schema: ${lastError.slice(0, 1500)}. Produce a valid object.` }],
      schema: prompt.schema,
      inputRef: meta.inputRef ?? {},
      maxTokens: meta.maxTokens,
      effort: rt.efforts?.[TASK_TIER[prompt.task]] ?? effortForTask(prompt.task),
      deadlineAt: meta.deadlineAt,
    };
    try {
      result = await rt.provider.structured(req, model);
    } catch (err) {
      result = { kind: "invalid", error: `provider threw: ${err instanceof Error ? err.message : String(err)}`, model, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, latencyMs: Date.now() - started };
    }
    if (result.kind === "ok" || result.kind === "refused") break;
    lastError = result.error;
    if (result.error.startsWith("provider")) break; // do not retry outages here; the workflow engine retries the step
    if (result.final) break; // the provider already did all the asking that fits (see above)
  }
  if (!result) throw new Error("unreachable");
  return { result, model, hash, attempts };
}

/** Records an `ai_runs` row for a call (docs/16: what did the AI see, conclude, why) and turns it into an outcome. */
export async function recordRun<TInput, TOutput>(q: Queryable, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, meta: RunMeta, call: PromptCall<TOutput>): Promise<RunOutcome<TOutput>> {
  const { result, model, hash, attempts } = call;
  const usage = result.usage;
  const [row] = await q
    .insert(aiRuns)
    .values({
      companyId: meta.companyId,
      agent: prompt.agent,
      task: prompt.task,
      provider: rt.provider.id,
      model,
      promptKey: prompt.key,
      promptVersion: prompt.version,
      promptHash: hash,
      inputRef: { ...(meta.inputRef ?? {}), attempts },
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      costUsd: String(estimateCostUsd(model, usage)),
      latencyMs: result.latencyMs,
      structuredOutput: result.kind === "ok" ? (result.output as unknown as Record<string, unknown>) : null,
      confidence: result.kind === "ok" ? extractConfidence(result.output) : null,
      status: result.kind === "ok" ? "ok" : result.kind === "refused" ? "refused" : result.error.startsWith("provider") ? "error" : "invalid_output",
      error: result.kind === "ok" ? null : result.kind === "refused" ? result.reason : result.error,
      workflowRunId: meta.workflowRunId ?? null,
    })
    .returning({ id: aiRuns.id });

  if (result.kind === "ok") return { ok: true, output: result.output, runId: row.id, model };
  if (result.kind === "refused") return { ok: false, runId: row.id, model, reason: "refused", error: result.reason };
  return { ok: false, runId: row.id, model, reason: result.error.startsWith("provider") ? "error" : "invalid", error: result.error };
}

/**
 * Call, then record, on a connection that holds nothing while the model thinks: the call happens first, and the
 * `ai_runs` row is written afterwards in its own short transaction (tenant-scoped when the run belongs to a company).
 * The row is written whether the call succeeded or not, so every call is accounted for even when the caller's later
 * work fails. This is the entry point for every production path.
 */
export async function runPromptDetached<TInput, TOutput>(db: Db, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, input: TInput, meta: RunMeta): Promise<RunOutcome<TOutput>> {
  const call = await callPrompt(rt, prompt, input, meta);
  return meta.companyId ? withTenant(db, meta.companyId, (q) => recordRun(q, rt, prompt, meta, call)) : withPlatform(db, (q) => recordRun(q, rt, prompt, meta, call));
}

/**
 * Call and record on the given handle. Only for callers that hold no transaction open around `q` (the evaluation
 * harness, unit tests); application code uses `runPromptDetached` so a transaction never waits on a model.
 */
export async function runPrompt<TInput, TOutput>(q: Queryable, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, input: TInput, meta: RunMeta): Promise<RunOutcome<TOutput>> {
  const call = await callPrompt(rt, prompt, input, meta);
  return recordRun(q, rt, prompt, meta, call);
}

function extractConfidence(output: unknown): string | null {
  if (output && typeof output === "object" && "confidence" in output) {
    const c = (output as { confidence?: unknown }).confidence;
    return typeof c === "string" ? c : null;
  }
  return null;
}

/**
 * Builds the runtime for the configured provider: the deterministic fake (never in production) or the Anthropic SDK,
 * which is loaded lazily so the test path never imports it.
 */
export async function createRuntime(env: Record<string, string | undefined> = process.env, fake?: AiProvider): Promise<AiRuntime> {
  const providerId = env.AI_PROVIDER ?? "fake";
  const models = modelTableFromEnv(env);
  const efforts = effortsFromEnv(env);
  if (providerId === "fake") {
    if (env.NODE_ENV === "production") throw new Error("AI_PROVIDER=fake is not allowed in production");
    if (!fake) throw new Error("fake provider requires an instance with registered handlers");
    return { provider: fake, models: { judgment: "fake", standard: "fake", fast: "fake" }, efforts };
  }
  if (providerId === "anthropic") {
    const { AnthropicProvider } = await import("./providers/anthropic");
    return { provider: new AnthropicProvider(env.ANTHROPIC_API_KEY), models, efforts };
  }
  throw new Error(`unknown AI_PROVIDER ${providerId}`);
}

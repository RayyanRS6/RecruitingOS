import { aiRuns, isLockTimeout, uuidv7, withPlatform, withTenant, type Db, type Queryable } from "@ros/db";
import { creditHoldUsd, estimateCostUsd } from "./pricing";
import { promptHash, type PromptDef } from "./prompts/registry";
import { ALLOWED_MODELS, TASK_TIER, effortForTask, effortsFromEnv, isAllowedModel, modelForTask, modelTableFromEnv, type Effort, type ModelTable } from "./routing";
import type { AiProvider, StructuredResult, Tier } from "./types";

/** An `ai_runs` row as it is written. */
export type AiRunValues = typeof aiRuns.$inferInsert;

/**
 * The AI credit, as the runner meets it: the rules are in @ros/core (ai-credit.ts) and the process wires them in
 * (apps/api/src/container.ts). `hold` is one short transaction: it locks the company's credit row, and either writes
 * `runs` (each `running`, with its hold as its cost, so money in flight is already in the sum the next call reads) and
 * answers "held", or writes nothing and answers "refused". "unmetered" (no credit row with a limit): nothing was written,
 * and the call takes the path it took before any of this. `settle` gives a held call's row its real numbers.
 */
export type AiCreditGate = {
  hold(db: Db, input: { companyId: string; holdUsd: number; runs: AiRunValues[] }): Promise<"unmetered" | "held" | "refused">;
  settle(db: Db, input: { companyId: string; runId: string; values: Partial<AiRunValues> }): Promise<void>;
};

/**
 * `efforts`: a tier's effort when the environment sets one (AI_EFFORT_*), in place of TIER_EFFORT. `credit`: the AI credit
 * (see `AiCreditGate`); left out, as in the evaluations and in tests that build a runtime by hand, nothing is metered.
 */
export type AiRuntime = {
  provider: AiProvider;
  models: ModelTable;
  efforts?: Partial<Record<Tier, Effort>>;
  credit?: AiCreditGate;
};

/**
 * `no_credit`: the company's AI credit has no room for this call, so the model was not asked and no run was written (its
 * `runId` names no row). Never an outage, never a failure, never retried: each caller has its own way on. The text must
 * never start with "provider", which is how the engine knows an outage (packages/workflows/src/engine.ts, `providerProblem`).
 * `refusedHoldUsd`: what was asked for and refused, side-by-side calls together: with what is actually spent, it says whether
 * the credit is really gone or only held for calls still running (`aiCreditRoomSoon` in packages/core/src/ai-credit.ts).
 */
export type RunOutcome<T> =
  | { ok: true; output: T; runId: string; model: string }
  | { ok: false; runId: string; model: string; reason: "refused" | "invalid" | "error" | "no_credit"; error: string; refusedHoldUsd?: number };

/** Why a call was not made when the company's AI credit has no room for it (`RunOutcome`). */
export const AI_CREDIT_USED_UP = "AI credit used up";
/** Why a call was not made when the credit's row could not be read in time. Never starts with "provider": this is no outage. */
export const AI_CREDIT_BUSY = "the AI credit could not be read in time, so the model was not asked";

/** Whether the model was not asked because the company's AI credit has no room: not a failure of any kind. */
export function outOfCredit<T>(out: RunOutcome<T>): out is Extract<RunOutcome<T>, { ok: false }> & { reason: "no_credit"; refusedHoldUsd: number } {
  return !out.ok && out.reason === "no_credit";
}

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

/** What a call's row says about what it is, known before the model is asked. */
function runIdentity<TInput, TOutput>(rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, meta: RunMeta, model: string, hash: string) {
  return { companyId: meta.companyId, agent: prompt.agent, task: prompt.task, provider: rt.provider.id, model, promptKey: prompt.key, promptVersion: prompt.version, promptHash: hash, workflowRunId: meta.workflowRunId ?? null };
}

/** What a call's row says about how it ended: tokens, cost, time, the answer, and how it went. */
function endedValues<TOutput>(meta: RunMeta, call: PromptCall<TOutput>) {
  const { result, model, attempts } = call;
  const usage = result.usage;
  return {
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
  };
}

function outcomeOf<TOutput>(runId: string, call: PromptCall<TOutput>): RunOutcome<TOutput> {
  const { result, model } = call;
  if (result.kind === "ok") return { ok: true, output: result.output, runId, model };
  if (result.kind === "refused") return { ok: false, runId, model, reason: "refused", error: result.reason };
  return { ok: false, runId, model, reason: result.error.startsWith("provider") ? "error" : "invalid", error: result.error };
}

/** Records an `ai_runs` row for a call (docs/16: what did the AI see, conclude, why) and turns it into an outcome. */
export async function recordRun<TInput, TOutput>(q: Queryable, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, meta: RunMeta, call: PromptCall<TOutput>): Promise<RunOutcome<TOutput>> {
  const [row] = await q
    .insert(aiRuns)
    .values({ ...runIdentity(rt, prompt, meta, call.model, call.hash), ...endedValues(meta, call) })
    .returning({ id: aiRuns.id });
  return outcomeOf(row.id, call);
}

/**
 * Whether a call that failed may have cost more than the usage it recorded, so its hold stays as its cost: the provider says so
 * (a reply that had begun was stopped at the deadline or dropped part-way, `usageUnknown`, providers/anthropic.ts), or a provider
 * threw. Everything else is exact: a connection that never opened and an answer with an HTTP status wrote nothing, a call never
 * sent cost nothing, and a local error never reached anyone, so an hour's outage costs the company nothing.
 */
function usageUnknown<TOutput>(result: StructuredResult<TOutput>): boolean {
  if (result.kind !== "invalid" || !result.error.startsWith("provider")) return false;
  return !!result.usageUnknown || /^provider threw: (?!\d{3}\b)/.test(result.error);
}

/** The call as it was before the AI credit: the model first, then its row, in its own short transaction. */
async function callThenRecord<TInput, TOutput>(db: Db, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, input: TInput, meta: RunMeta): Promise<RunOutcome<TOutput>> {
  const call = await callPrompt(rt, prompt, input, meta);
  return meta.companyId ? withTenant(db, meta.companyId, (q) => recordRun(q, rt, prompt, meta, call)) : withPlatform(db, (q) => recordRun(q, rt, prompt, meta, call));
}

/**
 * Several calls of one prompt on one input, side by side (the readings of a résumé or of a chat), with the AI credit asked
 * for all of them at once: they all go, or none does, so nobody is read once where the next applicant is read three
 * times because the credit ran out between two of them. Every call of the same prompt holds the same amount.
 */
export async function runPromptsDetached<TInput, TOutput>(db: Db, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, input: TInput, metas: readonly RunMeta[]): Promise<Array<RunOutcome<TOutput>>> {
  const companyId = metas[0]?.companyId ?? null;
  const gate = companyId ? rt.credit : undefined;
  if (!companyId || !gate) return Promise.all(metas.map((meta) => callThenRecord(db, rt, prompt, input, meta)));
  const model = modelForTask(prompt.task, rt.models);
  const system = prompt.system(input);
  const promptChars = [...system.map((b) => b.text), ...prompt.messages(input).map((m) => m.content)].reduce((n, text) => n + text.length, 0);
  const holds = metas.map((meta) => creditHoldUsd(model, { promptChars, maxTokens: meta.maxTokens }));
  const runIds = metas.map(() => uuidv7());
  const hash = promptHash(system);
  const holdUsd = holds.reduce((sum, hold) => sum + hold, 0);
  let verdict: Awaited<ReturnType<AiCreditGate["hold"]>>;
  try {
    verdict = await gate.hold(db, {
      companyId,
      holdUsd,
      runs: metas.map((meta, i) => ({ id: runIds[i], ...runIdentity(rt, prompt, meta, model, hash), inputRef: meta.inputRef ?? {}, costUsd: String(holds[i]), status: "running" })),
    });
  } catch (err) {
    // The credit's row stayed locked past the lock timeout: the model was not asked, and nothing was written. An ordinary failed
    // call, so each caller has its own way on (a chat's "send that again"), and not a word that any credit is gone.
    if (!isLockTimeout(err)) throw err;
    return metas.map((): RunOutcome<TOutput> => ({ ok: false, runId: uuidv7(), model, reason: "error", error: AI_CREDIT_BUSY }));
  }
  if (verdict === "unmetered") return Promise.all(metas.map((meta) => callThenRecord(db, rt, prompt, input, meta)));
  if (verdict === "refused") return metas.map((): RunOutcome<TOutput> => ({ ok: false, runId: uuidv7(), model, reason: "no_credit", error: AI_CREDIT_USED_UP, refusedHoldUsd: holdUsd }));
  return Promise.all(
    metas.map(async (meta, i) => {
      const call = await callPrompt(rt, prompt, input, meta);
      const values = endedValues(meta, call);
      await gate.settle(db, { companyId, runId: runIds[i], values: usageUnknown(call.result) ? { ...values, costUsd: String(Math.max(Number(values.costUsd), holds[i])) } : values });
      return outcomeOf(runIds[i], call);
    }),
  );
}

/**
 * The entry point for every production path. No transaction is held while the model thinks: a company with an AI credit
 * first takes a hold in one short transaction (`AiCreditGate`), which writes the `ai_runs` row as `running` with the hold
 * as its cost, or refuses (`no_credit`, with no model call and no row); the row then takes the real numbers, or keeps the
 * hold as its cost when the real usage cannot be known, or stays as it is when the process goes away during the call. So
 * money in flight is always in the sum, and no number of calls at once can pass the limit. Any other company's call
 * happens first and its row is written afterwards in its own short transaction (tenant-scoped when it belongs to a
 * company). Either way the row is written whether the call succeeded or not, so every call is accounted for even when
 * the caller's later work fails.
 */
export async function runPromptDetached<TInput, TOutput>(db: Db, rt: AiRuntime, prompt: PromptDef<TInput, TOutput>, input: TInput, meta: RunMeta): Promise<RunOutcome<TOutput>> {
  const [out] = await runPromptsDetached(db, rt, prompt, input, [meta]);
  return out;
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

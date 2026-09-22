import type { AiProvider, StructuredRequest, StructuredResult } from "../types";

export type FakeHandler = (req: StructuredRequest<unknown>) => unknown | Promise<unknown>;

/**
 * Deterministic test adapter. Handlers are registered per task by the agents package
 * (`registerFakeHandlers`) so unit tests, the scenario test, and evals run without a model.
 * It refuses to run in production: `createProvider` throws if NODE_ENV=production and AI_PROVIDER=fake.
 * Scripts may also inject failures to test recovery paths.
 */
export class FakeProvider implements AiProvider {
  readonly id = "fake";
  private handlers = new Map<string, FakeHandler>();
  private failures: Array<{ task: string; kind: "invalid" | "refused" | "throw" }> = [];
  public calls: Array<{ task: string; model: string; promptKey: string; promptVersion: number }> = [];

  register(task: string, handler: FakeHandler): void {
    this.handlers.set(task, handler);
  }

  /** Queue a one-time failure for the next call of `task` (used by failure-injection tests). */
  failNext(task: string, kind: "invalid" | "refused" | "throw" = "invalid"): void {
    this.failures.push({ task, kind });
  }

  async structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>> {
    const started = Date.now();
    this.calls.push({ task: req.task, model, promptKey: req.promptKey, promptVersion: req.promptVersion });
    const usage = { inputTokens: estimateTokens(req), outputTokens: 400, cacheReadTokens: 0 };
    const idx = this.failures.findIndex((f) => f.task === req.task);
    if (idx >= 0) {
      const [f] = this.failures.splice(idx, 1);
      if (f.kind === "throw") throw new Error("fake provider outage");
      if (f.kind === "refused") return { kind: "refused", reason: "fake refusal", model, usage, latencyMs: 1 };
      return { kind: "invalid", error: "fake invalid output", model, usage, latencyMs: 1, rawText: "{" };
    }
    const handler = this.handlers.get(req.task);
    if (!handler) return { kind: "invalid", error: `no fake handler for task ${req.task}`, model, usage, latencyMs: 1 };
    const raw = await handler(req as StructuredRequest<unknown>);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) return { kind: "invalid", error: parsed.error.message, model, usage, latencyMs: Date.now() - started, rawText: JSON.stringify(raw).slice(0, 2000) };
    return { kind: "ok", output: parsed.data, model, usage, latencyMs: Date.now() - started };
  }
}

function estimateTokens(req: StructuredRequest<unknown>): number {
  const chars = req.system.reduce((n, b) => n + b.text.length, 0) + req.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}

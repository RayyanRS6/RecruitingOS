import type { z } from "zod";

export type Tier = "judgment" | "standard" | "fast";

/** Tasks are what callers ask for. The routing table maps a task to a tier and a model. */
export type TaskKey =
  | "intake.turn"
  | "intake.compile"
  | "intake.extract"
  | "intake.suggest"
  | "packet.revise"
  | "company.about"
  | "resume.extract"
  | "triage.assess"
  | "screen.turn"
  | "screen.assess"
  | "screen.writeup"
  | "brief.compose"
  | "owner.reply"
  | "interview.brief"
  | "scorecard.draft"
  | "debrief.compose"
  | "offer.propose"
  | "message.freeform";

export type SystemBlock = { text: string; cache?: boolean };

export type Message = { role: "user" | "assistant"; content: string };

export type StructuredRequest<T> = {
  task: TaskKey;
  agent: string;
  companyId: string | null;
  workflowRunId?: string | null;
  promptKey: string;
  promptVersion: number;
  system: SystemBlock[];
  messages: Message[];
  schema: z.ZodType<T>;
  /** References to inputs (ids and hashes), never raw PII beyond what the prompt already contains. */
  inputRef: Record<string, unknown>;
  maxTokens?: number;
  /** How hard the model thinks; the runner sets each task's tier effort (routing.ts, TIER_EFFORT). */
  effort?: "low" | "medium" | "high";
  /**
   * When the HTTP request this call serves is stopped (milliseconds since 1970), set once per request so that every
   * call in it shares one deadline: the provider ends the call early enough for the route to record the run and answer.
   * Left out (the worker, the evaluations), each call has only its own time budget.
   */
  deadlineAt?: number;
};

/** `cacheWriteTokens`: input written to the prompt cache, billed above the base input price and not in `inputTokens`. */
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens?: number };

export type StructuredResult<T> =
  | { kind: "ok"; output: T; model: string; usage: Usage; latencyMs: number; raw?: unknown }
  | { kind: "refused"; reason: string; model: string; usage: Usage; latencyMs: number }
  | {
      kind: "invalid";
      error: string;
      model: string;
      usage: Usage;
      latencyMs: number;
      rawText?: string;
      /**
       * Set when asking again would not help or would take too long: the provider already ran its own correction turn,
       * the reply was cut off at max_tokens, or the call's time budget is spent. The runner then does not retry.
       */
      final?: boolean;
    };

export interface AiProvider {
  readonly id: string;
  /** Returns validated structured output or a typed failure. Never throws for model-side failures. */
  structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>>;
}

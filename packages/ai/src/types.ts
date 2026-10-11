import type { z } from "zod";

export type Tier = "judgment" | "standard" | "fast";

/** Tasks are what callers ask for. The routing table maps a task to a tier and a model. */
export type TaskKey =
  | "intake.turn"
  | "intake.compile"
  | "intake.extract"
  | "packet.revise"
  | "company.about"
  | "resume.extract"
  | "triage.assess"
  | "screen.turn"
  | "screen.assess"
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
  /** Provider-specific effort hint; judgment tasks default to high. */
  effort?: "low" | "medium" | "high";
};

export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

export type StructuredResult<T> =
  | { kind: "ok"; output: T; model: string; usage: Usage; latencyMs: number; raw?: unknown }
  | { kind: "refused"; reason: string; model: string; usage: Usage; latencyMs: number }
  | { kind: "invalid"; error: string; model: string; usage: Usage; latencyMs: number; rawText?: string };

export interface AiProvider {
  readonly id: string;
  /** Returns validated structured output or a typed failure. Never throws for model-side failures. */
  structured<T>(req: StructuredRequest<T>, model: string): Promise<StructuredResult<T>>;
}

import type { TaskKey, Tier } from "./types";

/**
 * The only models the app may call (the owner's decision, 13 Oct 2026): Claude Haiku 5.5 for every task, and Claude
 * Sonnet 5.5 only where a task is long and complex enough to need it. Any other model named in AI_MODEL_JUDGMENT,
 * AI_MODEL_STANDARD or AI_MODEL_FAST stops the app at start, and the runner refuses to call one (runner.ts).
 */
export const ALLOWED_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * Which tier each task needs. "judgment" runs on Sonnet 5.5 and holds only the whole job draft (intake.compile): one
 * long reply of about 180 fields across five levels that must agree with each other, written without a grammar because
 * the schema is too large for one. Everything else is short or checked in code afterwards, and runs on Haiku 5.5.
 * The tasks with no prompt yet (brief, owner reply, interview brief, scorecard, debrief, offer) start on Haiku too.
 */
export const TASK_TIER: Record<TaskKey, Tier> = {
  // The owner's job-building chat: a short reply and up to three cards; fairness is re-checked in code.
  "intake.turn": "standard",
  "intake.compile": "judgment",
  // The cheap first read of a pasted job ad (C5): title, place, basis and pay before the market check.
  "intake.extract": "fast",
  // Changing a packet by chat (C10): usually one or two sections; merged, guarded and confirmed by a person.
  "packet.revise": "standard",
  // A few sentences about the company for its job pages (D10); a person edits and approves them in Setup.
  "company.about": "standard",
  "resume.extract": "fast",
  "triage.assess": "standard",
  "screen.turn": "standard",
  "screen.assess": "standard",
  "brief.compose": "standard",
  "owner.reply": "standard",
  "interview.brief": "standard",
  "scorecard.draft": "standard",
  "debrief.compose": "standard",
  "offer.propose": "standard",
  "message.freeform": "standard",
};

/**
 * How hard each tier thinks (output_config.effort). Anthropic's guidance: start Haiku 5.5 at medium, its default, and
 * Sonnet 5.5 at high for knowledge work. Thinking counts toward max_tokens and is billed as output, so a tier moves off
 * these only when the evaluations show the gain.
 */
export const TIER_EFFORT: Record<Tier, "low" | "medium" | "high"> = { judgment: "high", standard: "medium", fast: "medium" };

/** A runtime's model per tier: allowed models in production, "fake" with the deterministic provider in tests. */
export type ModelTable = Record<Tier, string>;

const DEFAULT_MODELS: Record<Tier, AllowedModel> = { judgment: "claude-sonnet-5-5", standard: "claude-haiku-5-5", fast: "claude-haiku-5-5" };

/** The model for each tier: the default, or an allowed model named in the environment. Anything else is refused. */
export function modelTableFromEnv(env: Record<string, string | undefined> = process.env): Record<Tier, AllowedModel> {
  const pick = (tier: Tier, name: string): AllowedModel => {
    const value = env[name]?.trim();
    if (!value) return DEFAULT_MODELS[tier];
    if (!isAllowedModel(value)) throw new Error(`${name}=${value} is not allowed: the app runs only on ${ALLOWED_MODELS.join(" and ")}`);
    return value;
  };
  return { judgment: pick("judgment", "AI_MODEL_JUDGMENT"), standard: pick("standard", "AI_MODEL_STANDARD"), fast: pick("fast", "AI_MODEL_FAST") };
}

export function modelForTask(task: TaskKey, table: ModelTable): string {
  return table[TASK_TIER[task]];
}

export function effortForTask(task: TaskKey): "low" | "medium" | "high" {
  return TIER_EFFORT[TASK_TIER[task]];
}

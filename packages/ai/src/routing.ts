import type { TaskKey, Tier } from "./types";

/**
 * The only models the app may call (the owner's decision, 13 Oct 2026): Claude Haiku 5.5 for every task, and Claude
 * Sonnet 5.5 only where a task is long and complex enough to need it. Any other model named in AI_MODEL_JUDGMENT,
 * AI_MODEL_STANDARD or AI_MODEL_FAST stops the app at start, and the runner refuses to call one (runner.ts). In the app
 * a setting cannot move Sonnet 5.5 onto another task either, nor lower the effort of a scoring reading (`appRouting`).
 */
export const ALLOWED_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export function isAllowedModel(model: string): model is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(model);
}

/**
 * Which tier each task needs. "judgment" runs on Sonnet 5.5 and holds only the writing of the whole job
 * (intake.compile): one long reply, the job description and about a hundred values across four levels that must agree
 * with each other. Everything else is short or checked in code afterwards, and runs on Haiku 5.5.
 */
export const TASK_TIER: Record<TaskKey, Tier> = {
  // The owner's job-building chat: a short reply and up to three cards; fairness is re-checked in code.
  "intake.turn": "standard",
  "intake.compile": "judgment",
  // The cheap first read of a pasted job ad: the title, the place, the type, the schedule and the pay it states.
  "intake.extract": "fast",
  // A few sentences about the company for its job pages (D10); a person edits and approves them in Setup.
  "company.about": "standard",
  // The LinkedIn post and the Indeed listing of a published job: two short texts from the job's public facts.
  "job.posts": "standard",
  "resume.extract": "fast",
  "triage.assess": "standard",
  "screen.turn": "standard",
  "screen.assess": "standard",
};

/**
 * How hard each tier thinks (output_config.effort). Anthropic's guidance: start Haiku 5.5 at medium, its default, and
 * Sonnet 5.5 at high for knowledge work. Thinking counts toward max_tokens and is billed as output, so a tier moves off
 * these only when the evaluations show the gain.
 */
export type Effort = "low" | "medium" | "high";
export const TIER_EFFORT: Record<Tier, Effort> = { judgment: "high", standard: "medium", fast: "medium" };

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];

/** The setting that names each tier's model, and the one that names its effort. */
const MODEL_SETTING: Record<Tier, string> = { judgment: "AI_MODEL_JUDGMENT", standard: "AI_MODEL_STANDARD", fast: "AI_MODEL_FAST" };
const EFFORT_SETTING: Record<Tier, string> = { judgment: "AI_EFFORT_JUDGMENT", standard: "AI_EFFORT_STANDARD", fast: "AI_EFFORT_FAST" };
const TIERS: readonly Tier[] = ["judgment", "standard", "fast"];

/**
 * A tier's effort named in the environment (AI_EFFORT_JUDGMENT, AI_EFFORT_STANDARD, AI_EFFORT_FAST), for measuring one
 * against another: the fairness run sets it from its "screening effort" choice. Empty is unset; anything else is refused.
 * As the environment says it: the app itself reads its settings through `appRouting`, which holds them to the owner's rule.
 */
export function effortsFromEnv(env: Record<string, string | undefined> = process.env): Partial<Record<Tier, Effort>> {
  const out: Partial<Record<Tier, Effort>> = {};
  for (const tier of TIERS) {
    const name = EFFORT_SETTING[tier];
    const value = env[name]?.trim();
    if (!value) continue;
    if (!(EFFORTS as readonly string[]).includes(value)) throw new Error(`${name}=${value} is not an effort: use ${EFFORTS.join(", ")}`);
    out[tier] = value as Effort;
  }
  return out;
}

/** A runtime's model per tier: allowed models in production, "fake" with the deterministic provider in tests. */
export type ModelTable = Record<Tier, string>;

/** The larger of the two models. It writes the whole job and nothing else: of the tiers, only "judgment" starts on it. */
const LARGER_MODEL: AllowedModel = "claude-sonnet-5-5";
const DEFAULT_MODELS: Record<Tier, AllowedModel> = { judgment: LARGER_MODEL, standard: "claude-haiku-5-5", fast: "claude-haiku-5-5" };

/**
 * The model for each tier: the default, or an allowed model named in the environment. Anything else is refused. As the
 * environment says it, either allowed model for any tier: the fairness run names one for the standard tier, to compare.
 * The app itself reads its settings through `appRouting`.
 */
export function modelTableFromEnv(env: Record<string, string | undefined> = process.env): Record<Tier, AllowedModel> {
  const pick = (tier: Tier): AllowedModel => {
    const name = MODEL_SETTING[tier];
    const value = env[name]?.trim();
    if (!value) return DEFAULT_MODELS[tier];
    if (!isAllowedModel(value)) throw new Error(`${name}=${value} is not allowed: the app runs only on ${ALLOWED_MODELS.join(" and ")}`);
    return value;
  };
  return { judgment: pick("judgment"), standard: pick("standard"), fast: pick("fast") };
}

export function modelForTask(task: TaskKey, table: ModelTable): string {
  return table[TASK_TIER[task]];
}

/**
 * Tasks that think harder than their tier. Anthropic's guidance for Haiku 5.5 is high for strict instruction following,
 * and the fairness runs (14 Oct 2026) bore it out: at high, twin resumes read and scored the same, where medium and
 * Sonnet 5.5 at either level moved by 5 to 6 points. Both readings of a candidate run there; it costs a fraction of a cent.
 */
export const TASK_EFFORT: Partial<Record<TaskKey, Effort>> = { "triage.assess": "high", "screen.assess": "high" };

export function effortForTask(task: TaskKey): Effort {
  return TASK_EFFORT[task] ?? TIER_EFFORT[TASK_TIER[task]];
}

const EFFORT_RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2 };

/**
 * The app's own routing: the settings of the environment, held to the owner's rule whatever they say (the app and the
 * worker read them here; the evaluations read them as they are, to compare one setting with another).
 *
 * - A model outside the two stops the app at start, and so does a word that is no effort (`modelTableFromEnv`,
 *   `effortsFromEnv`).
 * - The larger model writes the job and nothing else: a setting that names it for a tier that does not start on it is
 *   ignored, and the tier keeps its own model.
 * - The two scoring readings think at their own effort (`TASK_EFFORT`): a tier's effort below it is ignored, for the
 *   whole tier.
 *
 * `ignored`: one plain line for each setting that was ignored, for the log at start. A line names the setting and its
 * value, which by then is one of the words above, so nothing typed into a setting by mistake is ever printed.
 */
export function appRouting(env: Record<string, string | undefined> = process.env): { models: Record<Tier, AllowedModel>; efforts: Partial<Record<Tier, Effort>>; ignored: string[] } {
  const models = modelTableFromEnv(env);
  const efforts = effortsFromEnv(env);
  const ignored: string[] = [];
  for (const tier of TIERS) {
    if (models[tier] === LARGER_MODEL && DEFAULT_MODELS[tier] !== LARGER_MODEL) {
      models[tier] = DEFAULT_MODELS[tier];
      ignored.push(`${MODEL_SETTING[tier]}=${LARGER_MODEL} is ignored: ${LARGER_MODEL} writes the job and runs nothing else. This tier stays on ${DEFAULT_MODELS[tier]}.`);
    }
    const effort = efforts[tier];
    if (!effort) continue;
    const lowered = (Object.keys(TASK_TIER) as TaskKey[]).filter((task) => TASK_TIER[task] === tier && EFFORT_RANK[effort] < EFFORT_RANK[TASK_EFFORT[task] ?? "low"]);
    if (!lowered.length) continue;
    delete efforts[tier];
    ignored.push(`${EFFORT_SETTING[tier]}=${effort} is ignored: it would lower a scoring reading (${lowered.map((task) => `${task} runs at ${TASK_EFFORT[task]}`).join(", ")}).`);
  }
  return { models, efforts, ignored };
}

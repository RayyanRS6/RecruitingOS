import type { TaskKey, Tier } from "./types";

/** Which tier each task needs. Judgment-heavy work goes to the strongest model; bulk work to the cheapest. */
export const TASK_TIER: Record<TaskKey, Tier> = {
  "intake.turn": "judgment",
  "intake.compile": "judgment",
  // The cheap first read of a pasted job ad (C5): title, place, basis and pay before the market check.
  "intake.extract": "fast",
  // Changing a packet by chat (C10): the whole job is in play, so it gets the judgment tier like the draft itself.
  "packet.revise": "judgment",
  "resume.extract": "fast",
  "triage.assess": "standard",
  "screen.turn": "standard",
  "screen.assess": "standard",
  "brief.compose": "judgment",
  "owner.reply": "judgment",
  "interview.brief": "standard",
  "scorecard.draft": "standard",
  "debrief.compose": "judgment",
  "offer.propose": "judgment",
  "message.freeform": "standard",
};

export type ModelTable = Record<Tier, string>;

export function modelTableFromEnv(env: Record<string, string | undefined> = process.env): ModelTable {
  return {
    judgment: env.AI_MODEL_JUDGMENT ?? "claude-opus-5",
    standard: env.AI_MODEL_STANDARD ?? "claude-sonnet-5",
    fast: env.AI_MODEL_FAST ?? "claude-haiku-4-5-20251001",
  };
}

export function modelForTask(task: TaskKey, table: ModelTable): string {
  return table[TASK_TIER[task]];
}

import { inArray } from "drizzle-orm";
import { workflowRuns, type Tx } from "@ros/db";

/**
 * Where a screen's scorecard stands, for the candidate page (plan 0.9): `ready` once written, `writing` between the
 * last answer and the scorecard, `unavailable` when the `screen` run gave up on it (the assistant's answer was unusable
 * twice; screen.ts `assess` fails for good), and `none` while the screen is not finished. A run that gives up raises a
 * request to ITS (the engine's escalation, `workflow_runs.escalation_id`), so `recruiterAsked` says a person has it.
 */
export type ScorecardState = "ready" | "writing" | "unavailable" | "none";

type ScreenLike = { id: string; status: string; assessmentId: string | null; workflowRunId: string | null };

export async function screenScorecards(tx: Tx, screens: ScreenLike[]): Promise<Map<string, { scorecard: ScorecardState; recruiterAsked: boolean }>> {
  const runIds = screens.filter((s) => s.status === "completed" && !s.assessmentId && s.workflowRunId).map((s) => s.workflowRunId!);
  const runs = runIds.length ? await tx.select({ id: workflowRuns.id, status: workflowRuns.status, escalationId: workflowRuns.escalationId }).from(workflowRuns).where(inArray(workflowRuns.id, runIds)) : [];
  const out = new Map<string, { scorecard: ScorecardState; recruiterAsked: boolean }>();
  for (const s of screens) {
    const run = s.workflowRunId ? runs.find((r) => r.id === s.workflowRunId) : undefined;
    const scorecard: ScorecardState = s.assessmentId ? "ready" : s.status !== "completed" ? "none" : run?.status === "failed" ? "unavailable" : "writing";
    out.set(s.id, { scorecard, recruiterAsked: scorecard === "unavailable" && !!run?.escalationId });
  }
  return out;
}

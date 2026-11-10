import { desc, inArray, sql } from "drizzle-orm";
import { screens as screensTable, workflowRuns, type Tx } from "@ros/db";

/**
 * Where a screen's scorecard stands, for the candidate page (plan 0.9): `ready` once written, `writing` between the
 * last answer and the scorecard, `unavailable` when the `screen` run gave up on it (the assistant's answer was unusable
 * twice; screen.ts `assess` fails for good), `waiting_for_credit` when it waits for the company's AI credit, so the page
 * says to read the answers instead of "writing" for ever, and `none` while the screen is not finished. A run that gives up
 * raises a request to ITS (the engine's escalation, `workflow_runs.escalation_id`), so `recruiterAsked` says a person has it.
 */
export type ScorecardState = "ready" | "writing" | "unavailable" | "waiting_for_credit" | "none";

type ScreenLike = { id: string; status: string; assessmentId: string | null; workflowRunId: string | null; progress?: { scoreWaitsForCredit?: string } | null };

export async function screenScorecards(tx: Tx, screens: ScreenLike[]): Promise<Map<string, { scorecard: ScorecardState; recruiterAsked: boolean }>> {
  const runIds = screens.filter((s) => s.status === "completed" && !s.assessmentId && s.workflowRunId).map((s) => s.workflowRunId!);
  const runs = runIds.length ? await tx.select({ id: workflowRuns.id, status: workflowRuns.status, escalationId: workflowRuns.escalationId }).from(workflowRuns).where(inArray(workflowRuns.id, runIds)) : [];
  const out = new Map<string, { scorecard: ScorecardState; recruiterAsked: boolean }>();
  for (const s of screens) {
    const run = s.workflowRunId ? runs.find((r) => r.id === s.workflowRunId) : undefined;
    const scorecard: ScorecardState = s.assessmentId ? "ready" : s.status !== "completed" ? "none" : run?.status === "failed" ? "unavailable" : s.progress?.scoreWaitsForCredit ? "waiting_for_credit" : "writing";
    out.set(s.id, { scorecard, recruiterAsked: scorecard === "unavailable" && !!run?.escalationId });
  }
  return out;
}

/** The ids of the finished screens among these whose scorecard could not be written, for good (`unavailable` above). */
export async function failedScorecards(tx: Tx, screens: ReadonlyArray<Pick<ScreenLike, "id" | "status" | "assessmentId" | "workflowRunId">>): Promise<Set<string>> {
  const waiting = screens.filter((s) => s.status === "completed" && !s.assessmentId && s.workflowRunId);
  if (!waiting.length) return new Set();
  const runs = await tx.select({ id: workflowRuns.id, status: workflowRuns.status }).from(workflowRuns).where(inArray(workflowRuns.id, waiting.map((s) => s.workflowRunId!)));
  const failed = new Set(runs.filter((r) => r.status === "failed").map((r) => r.id));
  return new Set(waiting.filter((s) => failed.has(s.workflowRunId!)).map((s) => s.id));
}

/**
 * The screens of these applications as the score's label reads them (`interviewInScore`), newest first: with
 * `scoreWaitsForCredit` (its scorecard waits for the company's AI credit) and `scoreFailed` (it could not be written, for
 * good: the lead's D2, 11 November 2026), so the list, the board, Compare and the panel all label it the same way.
 */
export async function screensForScore(tx: Tx, applicationIds: readonly string[]) {
  if (!applicationIds.length) return [];
  const rows = await tx.select({ id: screensTable.id, applicationId: screensTable.applicationId, status: screensTable.status, assessmentId: screensTable.assessmentId, workflowRunId: screensTable.workflowRunId, scoreWaitsForCredit: sql<string | null>`${screensTable.progress}->>'scoreWaitsForCredit'` }).from(screensTable).where(inArray(screensTable.applicationId, [...applicationIds])).orderBy(desc(screensTable.createdAt));
  const failed = await failedScorecards(tx, rows);
  return rows.map((s) => ({ ...s, scoreFailed: failed.has(s.id) }));
}

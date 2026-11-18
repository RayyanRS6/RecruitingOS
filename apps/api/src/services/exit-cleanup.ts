import { and, eq, inArray } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { emit } from "@ros/core";
import { screens, type Tx } from "@ros/db";
import type { Container } from "../container";

/**
 * Leaving the process cleans up: an application that is declined, hired, withdrawn or closed with its job has its open
 * screens cancelled and their runs ended, so no reminder or screening question reaches someone who is out. A screen is
 * closed without a note: its link says the conversation is closed.
 */
export type ExitCleanupInput = { companyId: string; applicationId: string; reason: string; actor: Actor };
export type ExitCleanupResult = { screensCancelled: number };

// A conversation paused while the assistant was down is still open.
const OPEN_SCREENS = ["invited", "reminded", "in_progress", "paused"];

export async function exitCleanup(tx: Tx, container: Container, input: ExitCleanupInput): Promise<ExitCleanupResult> {
  const { companyId, applicationId, actor } = input;
  const result: ExitCleanupResult = { screensCancelled: 0 };
  const scr = await tx.select().from(screens).where(and(eq(screens.applicationId, applicationId), inArray(screens.status, OPEN_SCREENS)));
  for (const s of scr) {
    await tx.update(screens).set({ status: "cancelled" }).where(eq(screens.id, s.id));
    await emit(tx, { type: "screen.cancelled", companyId, actor, subject: { type: "screen", id: s.id }, payload: { applicationId, reason: "left_process", started: s.status === "in_progress" || s.status === "paused" } });
    if (s.workflowRunId) await container.engine.cancel(tx, s.workflowRunId, actor, `the application left the process (${input.reason})`);
    result.screensCancelled += 1;
  }
  return result;
}
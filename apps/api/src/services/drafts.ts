import { and, desc, eq } from "drizzle-orm";
import { draftTitleOf, type IntakeDraftSummary } from "@ros/contracts";
import { draftOwnedBy } from "@ros/core";
import { sessionView, type IntakeSessionRow } from "@ros/agents";
import { intakeSessions, type Tx } from "@ros/db";

/**
 * The drafts of the job builder as the lists show them: Home, the Jobs page and the builder's first page. One line for
 * each draft, built here and nowhere else, so the three lists cannot say different things about the same draft.
 */

/**
 * One draft as a line of a list, for the person reading it. `missing` and `payConfirmed` are the readiness's own, the
 * two facts "still needed" is counted from (`draftStillNeeds`), so the line and the builder count the same things.
 */
export function draftSummary(row: IntakeSessionRow, viewerUserId: string): IntakeDraftSummary {
  const view = sessionView(row, viewerUserId);
  return {
    id: row.id,
    status: row.status,
    title: draftTitleOf(view),
    startedBy: { userId: view.startedBy.userId, name: view.startedBy.name },
    mine: view.startedBy.mine,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    ownerMessages: row.messages.filter((m) => m.role === "owner").length,
    hasDraft: !!row.draftPacket,
    missing: view.readiness.missing,
    payConfirmed: view.readiness.payConfirmed,
  };
}

/**
 * The drafts in progress, newest first: this person's own, or with `everyone` every draft of the company (for an owner
 * or an admin, who may pick one up). Whose a draft is, is core's one reading of it (`draftOwnedBy`, the query's form of
 * the `draftOwnerId` that opens a draft): a draft listed as a person's own is one they may open.
 */
export async function draftSummaries(tx: Tx, input: { companyId: string; userId: string; everyone?: boolean }): Promise<IntakeDraftSummary[]> {
  const rows = await tx.select().from(intakeSessions).where(and(eq(intakeSessions.companyId, input.companyId), eq(intakeSessions.status, "active"), ...(input.everyone ? [] : [draftOwnedBy(input.userId)]))).orderBy(desc(intakeSessions.updatedAt));
  return rows.map((row) => draftSummary(row, input.userId));
}

import { sql, type SQL } from "drizzle-orm";
import type { Actor } from "@ros/contracts";
import { intakeSessions } from "@ros/db";

/**
 * Whose a draft of the job builder is: the person who started it, or the owner or admin who took it over. A draft holds
 * it twice: `intake_sessions.created_by_user_id` (migration 0030, filled then from the actor), and the actor in
 * `created_by`. This file is the one reading of the pair: the id column when it is set, else the actor when the actor is
 * a person; null for a draft no person holds. The reading for one row and the same reading as a condition for a query
 * are kept side by side, so a list and the draft it lists can never disagree about whose it is.
 */
export function draftOwnerId(row: { createdByUserId: string | null; createdBy: Actor }): string | null {
  return row.createdByUserId ?? (row.createdBy.kind === "user" ? row.createdBy.id : null);
}

/** The drafts that are this person's, as a condition on `intake_sessions`: `draftOwnerId`, said in SQL. */
export function draftOwnedBy(userId: string): SQL {
  return sql`coalesce(${intakeSessions.createdByUserId}::text, case when ${intakeSessions.createdBy}->>'kind' = 'user' then ${intakeSessions.createdBy}->>'id' end) = ${userId}`;
}

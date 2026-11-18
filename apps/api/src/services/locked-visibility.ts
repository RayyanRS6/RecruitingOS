import { asc, eq, sql } from "drizzle-orm";
import type { LockedApplicants } from "@ros/contracts";
import { lockedAndWaiting } from "@ros/core";
import { applications, type Tx } from "@ros/db";

/**
 * What the team may read of the people past a plan's candidates per job (Rule 3 of the plans of 5 November 2026) on a
 * job's list. The path guard (middleware/candidate-lock.ts) stops the ids in a path; this is for the list that spans
 * many people.
 */

/**
 * The locked people of one job as the team may read them, in arrival order: where they came in, and when. Someone who
 * withdrew or was deleted while locked has no card (`lockedAndWaiting`), and still holds their place in the order.
 */
export async function lockedCardsOf(tx: Tx, roleId: string): Promise<LockedApplicants> {
  const rows = await tx.select({ createdAt: applications.createdAt, waiting: sql<boolean>`${lockedAndWaiting()}` }).from(applications).where(eq(applications.roleId, roleId)).orderBy(asc(applications.createdAt), asc(applications.id));
  const cards = rows.flatMap((r, i) => (r.waiting ? [{ position: i + 1, appliedAt: new Date(r.createdAt).toISOString() }] : []));
  return { count: cards.length, cards };
}

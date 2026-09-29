import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { ts, updatedAt } from "./columns";

/**
 * One row per queue worker process (migration 0021): when it last polled, how much work was waiting and how old the
 * oldest waiting job was. The worker upserts its row every poll; the app's health check and the daily maintenance
 * check read the newest row. A platform table: no company id, no row policy, no candidate data.
 */
export const workerHeartbeats = pgTable("worker_heartbeats", {
  workerId: text("worker_id").primaryKey(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  lastPollAt: ts("last_poll_at"),
  queueDepth: integer("queue_depth").notNull().default(0),
  oldestQueuedAt: ts("oldest_queued_at"),
  version: text("version"),
  updatedAt: updatedAt(),
});

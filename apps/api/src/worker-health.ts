import { createServer, type Server } from "node:http";
import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { jobs, withPlatform, workerHeartbeats, type Db } from "@ros/db";

/**
 * Worker health (audit remediation H1 and H15). The worker writes a heartbeat row on every poll (when it last looked,
 * how many jobs were waiting, how old the oldest one was) and answers GET /healthz from its own memory so the host can
 * restart it when it stops polling. The app's /healthz and the daily maintenance check read the newest heartbeat.
 */

/** A worker whose newest heartbeat is older than this is treated as stopped by the app and the maintenance check. */
export const HEARTBEAT_STALE_MS = 10 * 60_000;
/** Mirrors the engine's default job lease: a job locked longer than this belongs to a worker that died mid-run and counts as waiting again. */
export const JOB_LEASE_MS = 5 * 60_000;

/** The worker's own check goes unhealthy when the last poll is older than three poll intervals plus thirty seconds. */
export function staleAfterMs(pollMs: number): number {
  return 3 * pollMs + 30_000;
}

export type QueueSnapshot = { queueDepth: number; oldestQueuedAt: string | null };

/** Jobs that are due and waiting for a worker: queued, due now, and not held by a live lease. */
export async function queueSnapshot(db: Db, now: Date, leaseMs = JOB_LEASE_MS): Promise<QueueSnapshot> {
  const nowIso = now.toISOString();
  const leaseExpired = new Date(now.getTime() - leaseMs).toISOString();
  const [row] = await withPlatform(db, (tx) =>
    tx
      .select({ n: sql<number | string>`count(*)`, oldest: sql<string | Date | null>`min(run_at)` })
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, nowIso), or(isNull(jobs.lockedAt), lt(jobs.lockedAt, leaseExpired)))),
  );
  return { queueDepth: Number(row?.n ?? 0), oldestQueuedAt: row?.oldest ? new Date(row.oldest).toISOString() : null };
}

export type HeartbeatInput = { workerId: string; now: Date; queueDepth: number; oldestQueuedAt: string | null; version: string | null };

/** One row per worker id, replaced on every poll. */
export async function writeHeartbeat(db: Db, input: HeartbeatInput): Promise<void> {
  const at = input.now.toISOString();
  const values = { lastSeenAt: at, lastPollAt: at, queueDepth: input.queueDepth, oldestQueuedAt: input.oldestQueuedAt, version: input.version, updatedAt: at };
  await withPlatform(db, (tx) => tx.insert(workerHeartbeats).values({ workerId: input.workerId, ...values }).onConflictDoUpdate({ target: workerHeartbeats.workerId, set: values }));
}

export type WorkerReport = { workerId: string; lastSeenAt: string; lastPollAt: string | null; queueDepth: number; oldestQueuedAt: string | null; version: string | null; healthy: boolean; ageSeconds: number };

/** The newest heartbeat of any worker, with `healthy` meaning it was seen within `staleMs`. Null when no worker ever wrote one. */
export async function readWorkerHealth(db: Db, now: Date, staleMs = HEARTBEAT_STALE_MS): Promise<WorkerReport | null> {
  const [row] = await withPlatform(db, (tx) => tx.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastSeenAt)).limit(1));
  if (!row) return null;
  const age = Math.max(0, now.getTime() - Date.parse(row.lastSeenAt));
  return { workerId: row.workerId, lastSeenAt: row.lastSeenAt, lastPollAt: row.lastPollAt, queueDepth: row.queueDepth, oldestQueuedAt: row.oldestQueuedAt, version: row.version, healthy: age <= staleMs, ageSeconds: Math.round(age / 1000) };
}

export type WorkerStatus = { ok: boolean; workerId: string; lastPollAt: string | null; queueDepth: number; oldestQueuedAgeSeconds: number | null };

/**
 * What one worker process knows about itself: the last successful poll and the queue as it saw it then. The release
 * version goes on the heartbeat row (the maintenance alert and the console read it there), never into the health
 * body: /healthz answers without a session, and a deployed commit is nobody's business.
 */
export class WorkerHealth {
  private lastPollAt: Date | null = null;
  private snapshot: QueueSnapshot = { queueDepth: 0, oldestQueuedAt: null };

  constructor(private readonly opts: { workerId: string; pollMs: number; now: () => Date; version?: string | null }) {}

  /**
   * One poll: measure the queue and write the heartbeat. A throw means the database could not be reached; the caller
   * reports it, and because the last poll is not advanced the health check goes stale on its own.
   */
  async beat(db: Db): Promise<QueueSnapshot> {
    const now = this.opts.now();
    const snapshot = await queueSnapshot(db, now);
    await writeHeartbeat(db, { workerId: this.opts.workerId, now, queueDepth: snapshot.queueDepth, oldestQueuedAt: snapshot.oldestQueuedAt, version: this.opts.version ?? null });
    this.lastPollAt = now;
    this.snapshot = snapshot;
    return snapshot;
  }

  staleAfterMs(): number {
    return staleAfterMs(this.opts.pollMs);
  }

  status(): WorkerStatus {
    const now = this.opts.now();
    const ok = !!this.lastPollAt && now.getTime() - this.lastPollAt.getTime() <= this.staleAfterMs();
    const oldest = this.snapshot.oldestQueuedAt ? Math.max(0, Math.round((now.getTime() - Date.parse(this.snapshot.oldestQueuedAt)) / 1000)) : null;
    return { ok, workerId: this.opts.workerId, lastPollAt: this.lastPollAt?.toISOString() ?? null, queueDepth: this.snapshot.queueDepth, oldestQueuedAgeSeconds: oldest };
  }
}

/**
 * The worker's health endpoint: plain node:http, one route. 200 with the status while the worker polls, 503 once the
 * last poll is stale, so Railway's health check restarts it. Port 0 picks a free port (tests).
 */
export function startHealthServer(health: WorkerHealth, port: number, host?: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
        const body = health.status();
        res.writeHead(body.ok ? 200 : 503, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "This is the queue worker. It answers GET /healthz only." } }));
    });
    server.once("error", reject);
    const ready = () => {
      server.off("error", reject);
      resolve(server);
    };
    if (host) server.listen(port, host, ready);
    else server.listen(port, ready);
  });
}

/** The port a listening server ended up on (an ephemeral port in tests). */
export function listeningPort(server: Server): number {
  const address = server.address();
  return address && typeof address === "object" ? address.port : 0;
}

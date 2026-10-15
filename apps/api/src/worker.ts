import "./instrument";
import { createContainer } from "./container";
import { reportError } from "./observability";
import { WorkerHealth, listeningPort, startHealthServer } from "./worker-health";

/**
 * Production worker entry: polls the queue and runs workflows. Scale horizontally; leases prevent double execution.
 * Connects as the worker database role (WORKER_DATABASE_URL), which is separate from the API's role (founder decision F1).
 *
 * Health (H1): every poll writes a heartbeat row (when, queue depth, oldest waiting job), and a tiny HTTP server on
 * PORT answers GET /healthz with 200 while polls succeed and 503 once the last successful poll is older than three
 * poll intervals plus thirty seconds. Railway probes it and restarts the worker on 503 (the worker service's settings: docs/runbooks/railway-worker.md).
 */
const container = await createContainer({ env: { ...process.env, WORKER_INLINE: "false" }, role: "worker" });
const version = (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 12) || null;
const health = new WorkerHealth({ workerId: container.engine.identity(), pollMs: container.env.WORKER_POLL_MS, now: () => container.engine.clock(), version });
const port = Number(process.env.PORT ?? "8080") || 8080;
const server = await startHealthServer(health, port);
console.log(`[worker] started (db: ${container.handle.kind} as ${container.handle.role}, ai: ${container.ai.provider.id}, health: http://0.0.0.0:${listeningPort(server)}/healthz, id: ${container.engine.identity()})`);
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  try {
    // The heartbeat first: a database that cannot be reached is a failed poll, and the health check goes stale on its own.
    await health.beat(container.db);
    const n = await container.engine.runPending(25);
    if (n === 0) await new Promise((r) => setTimeout(r, container.env.WORKER_POLL_MS));
  } catch (err) {
    console.error("[worker] tick failed", err);
    reportError(err, { process: "worker", where: "tick" });
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await new Promise<void>((resolve) => server.close(() => resolve()));
await container.close();

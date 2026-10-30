import "./instrument";
import { createContainer } from "./container";
import { StallWatchdog, WorkerHealth, listeningPort, pollOnce, stallExitMs, startHealthServer } from "./worker-health";

/**
 * Production worker entry: polls the queue and runs workflows. Scale horizontally; leases prevent double execution.
 * Connects as the worker database role (WORKER_DATABASE_URL), which is separate from the API's role (founder decision F1).
 *
 * Health (H1): every poll writes a heartbeat row (when, queue depth, oldest waiting job), and a tiny HTTP server on
 * PORT answers GET /healthz with 200 while polls succeed and 503 once the last successful poll is older than three
 * poll intervals plus thirty seconds. Railway reads it only while a deployment goes live and restarts only a process
 * that exits (docs/runbooks/railway-worker.md), so the worker watches itself too (OPS-V1, HOST-12): when no poll, job
 * or workflow step has finished for WORKER_STALL_EXIT_MS (15 minutes by default, longer than any one step), it logs
 * one line and exits with code 1 for the restart policy to start it again. A database outage does not trip it: every
 * failed poll still ends, and the loop retries by itself. The watchdog starts before the boot, so a boot that hangs
 * is caught as well.
 */
const stallMs = stallExitMs(process.env.WORKER_STALL_EXIT_MS);
const watchdog = new StallWatchdog({
  stallMs,
  now: () => performance.now(),
  onStall: (stalledMs) => {
    console.error(`[worker] stalled: no poll, job or step has finished for ${Math.round(stalledMs / 1000)} s (WORKER_STALL_EXIT_MS=${stallMs}); exiting with code 1 so the service restarts it`);
    process.exit(1);
  },
});
const stopWatchdog = watchdog.start();
const container = await createContainer({ env: { ...process.env, WORKER_INLINE: "false" }, role: "worker" });
// A long batch is not a stall while its jobs and steps keep finishing.
container.engine.onProgress(() => watchdog.progress());
const version = (process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 12) || null;
const health = new WorkerHealth({ workerId: container.engine.identity(), pollMs: container.env.WORKER_POLL_MS, now: () => container.engine.clock(), version });
const port = Number(process.env.PORT ?? "8080") || 8080;
const server = await startHealthServer(health, port);
console.log(`[worker] started (db: ${container.handle.kind} as ${container.handle.role}, ai: ${container.ai.provider.id}, health: http://0.0.0.0:${listeningPort(server)}/healthz, id: ${container.engine.identity()}, exits when stalled ${Math.round(stallMs / 60_000)} min)`);
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  await pollOnce({ beat: () => health.beat(container.db), runPending: () => container.engine.runPending(25), pollMs: container.env.WORKER_POLL_MS, watchdog });
}
stopWatchdog();
await new Promise<void>((resolve) => server.close(() => resolve()));
await container.close();

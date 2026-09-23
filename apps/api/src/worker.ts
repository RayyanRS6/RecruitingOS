import "./instrument";
import { createContainer } from "./container";
import { reportError } from "./observability";

/**
 * Production worker entry: polls the queue and runs workflows. Scale horizontally; leases prevent double execution.
 * Connects as the worker database role (WORKER_DATABASE_URL), which is separate from the API's role (founder decision F1).
 */
const container = await createContainer({ env: { ...process.env, WORKER_INLINE: "false" }, role: "worker" });
console.log(`[worker] started (db: ${container.handle.kind} as ${container.handle.role}, ai: ${container.ai.provider.id})`);
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
while (!stopping) {
  try {
    const n = await container.engine.runPending(25);
    if (n === 0) await new Promise((r) => setTimeout(r, container.env.WORKER_POLL_MS));
  } catch (err) {
    console.error("[worker] tick failed", err);
    reportError(err, { process: "worker", where: "tick" });
    await new Promise((r) => setTimeout(r, 2000));
  }
}
await container.close();

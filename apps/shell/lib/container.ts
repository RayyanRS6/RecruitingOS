import { createApp } from "@ros/api/src/app";
import { createContainer, type Container } from "@ros/api/src/container";

/**
 * One container per process. Next.js re-evaluates modules on hot reload in development, so the instance is kept on
 * globalThis; in production each serverless instance builds its own once. The inline worker runs only where the
 * environment allows it (never in production: Trigger.dev or a worker process owns the queue, D22).
 */
type Shell = { container: Container; handler: (req: Request) => Promise<Response> };
const g = globalThis as unknown as { __rosShell?: Promise<Shell> };

async function build(): Promise<Shell> {
  const container = await createContainer();
  const app = createApp(container);
  if (container.env.WORKER_INLINE && container.env.NODE_ENV !== "production") {
    let busy = false;
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await container.engine.runPending(25);
      } catch (err) {
        console.error("[worker] tick failed", err);
      } finally {
        busy = false;
      }
    }, container.env.WORKER_POLL_MS).unref();
  }
  // Hono's fetch handler speaks the web standard Request/Response that route handlers receive.
  return { container, handler: (req: Request) => Promise.resolve(app.fetch(req)) };
}

export function getShell(): Promise<Shell> {
  if (!g.__rosShell) g.__rosShell = build();
  return g.__rosShell;
}

/** Test seam: install a prebuilt container (memory database, fake adapters). */
export function installShellForTests(container: Container): void {
  const app = createApp(container);
  g.__rosShell = Promise.resolve({ container, handler: (req: Request) => Promise.resolve(app.fetch(req)) });
}

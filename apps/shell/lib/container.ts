import { after } from "next/server";
import { createApp } from "@ros/api/src/app";
import { createContainer, type Container } from "@ros/api/src/container";

/**
 * One container per process. Next.js re-evaluates modules on hot reload in development, so the instance is kept on
 * globalThis; in production each serverless instance builds its own once. The inline worker runs only where the
 * environment allows it (never in production: the worker process on Railway owns the queue).
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
  if (!g.__rosShell) {
    g.__rosShell = build().catch((err) => {
      // A start that failed (a migration not applied yet, the database briefly unreachable) is tried again on the next
      // request instead of being remembered for the life of the instance.
      g.__rosShell = undefined;
      throw err;
    });
  }
  return g.__rosShell;
}

/**
 * The container for one request (route handlers and getMe). Vercel suspends an instance once its requests end, and a
 * suspended instance's timers do not run, so the pool's idle connections would stay open on the session pooler, each
 * holding one of ros_app's 15 slots, until Vercel discards the instance minutes later (12 Oct 2026: three redeploys
 * filled the pooler). `after` keeps the request alive until the pool's 5-second idle timer has closed them. This is
 * what Vercel's attachDatabasePool does, through the waitUntil Next.js already wires up.
 */
export async function getShellForRequest(): Promise<Shell> {
  const shell = await getShell();
  try {
    after(() => shell.container.handle.whenIdle());
  } catch {
    // Outside a Next.js request (tests, scripts) there is no instance to keep alive.
  }
  return shell;
}

/** Test seam: install a prebuilt container (memory database, fake adapters). */
export function installShellForTests(container: Container): void {
  const app = createApp(container);
  g.__rosShell = Promise.resolve({ container, handler: (req: Request) => Promise.resolve(app.fetch(req)) });
}

import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { createContainer } from "./container";

const container = await createContainer();
const app = createApp(container);

if (container.env.WORKER_INLINE) {
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

const server = serve({ fetch: app.fetch, port: container.env.PORT }, (info) => {
  console.log(`[api] listening on http://localhost:${info.port} (db: ${container.handle.kind}, ai: ${container.ai.provider.id}, worker: ${container.env.WORKER_INLINE ? "inline" : "external"})`);
});

/** Close the database cleanly on shutdown; an unclean exit can leave PGlite's data directory locked. */
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    try {
      await container.close();
    } finally {
      process.exit(0);
    }
  });
}

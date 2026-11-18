import { Hono, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { companies, withPlatform } from "@ros/db";
import { FakeEmailAdapter } from "@ros/integrations";
import type { Container } from "./container";
import { errorHandler } from "./middleware/errors";
import { applicationLockGuard } from "./middleware/candidate-lock";
import { sessionMiddleware, type Vars } from "./middleware/session";
import { authRoutes } from "./routes/auth";
import { companyRoutes } from "./routes/companies";
import { companySettingsRoutes } from "./routes/company-settings";
import { planRoutes } from "./routes/plans";
import { authSessionRoutes } from "./routes/auth-sessions";
import { privacyRequestPages } from "./pages/privacy-request";
import { intakeRoutes } from "./routes/intake";
import { roleRoutes } from "./routes/roles";
import { applicationRoutes, candidateRoleRoutes } from "./routes/candidates";
import { adminRoutes } from "./routes/admin";
import { notificationRoutes } from "./routes/notifications";
import { privacyRequestRoutes } from "./routes/privacy-requests";
import { readWorkerHealth } from "./worker-health";
import { appHealthWatch } from "./maintenance";
import { redactString } from "@ros/core";
import { candidatePages } from "./pages/candidate";
import { draftPreviewPages, rolePreviewPages } from "./pages/preview";
import { sitemapPages } from "./pages/sitemap";
import { fileRoutes } from "./routes/files";
import { screenRoleRoutes } from "./routes/screen-routes";
import { postmarkWebhook } from "./webhooks/postmark";
import { POLICIES, apiRateLimit, rateLimit, webhookRateLimit } from "./middleware/rate-limit";
import { API_FORM_PAGES, formPageReferrer, sameSiteChanges } from "./middleware/same-site";
import { contextStorage } from "hono/context-storage";
import { buildCandidateCsp, cspHeaderName, makeNonce, normalizeCspReports, recordCspReport } from "@ros/core";

/**
 * How long one process answers /healthz from its last database and worker check (HOST-V7). The endpoint needs no
 * session, so a burst of anonymous requests costs one check every five seconds per process, not one each.
 */
export const HEALTHZ_CACHE_MS = 5_000;

/** `healthCacheMs`: how long /healthz reuses its check; HEALTHZ_CACHE_MS, or 0 under NODE_ENV=test so a test sees a heartbeat it has just written. */
export function createApp(container: Container, opts: { healthCacheMs?: number } = {}) {
  const app = new Hono<Vars>();
  app.onError(errorHandler);
  app.use("*", contextStorage());
  // Request logs never carry a credential or an OAuth code (correction 10).
  if (container.env.NODE_ENV !== "test") app.use("*", logger((line) => console.log(redactString(line))));
  // The API's own form pages post with their real origin (Referrer-Policy: same-origin); before secureHeaders, so it has the last word.
  for (const p of API_FORM_PAGES) app.use(p, formPageReferrer);
  app.use("*", secureHeaders());
  // The API is served by the same Next.js deployment as the app (one origin, APP_BASE_URL), so no cross-origin access is granted.
  // Security review, 11 Oct: a change under /api that the browser says came from another site is refused before the session is read.
  app.use("/api/*", sameSiteChanges(container.env));
  app.use("*", sessionMiddleware(container));
  // 21 Sep, item 5: per-user and per-tenant limits on the API, per-address for anonymous calls, generous per-provider limits on webhooks.
  app.use("/api/*", apiRateLimit());
  app.use("/webhooks/*", webhookRateLimit());
  for (const p of ["/c/*", "/careers/*", "/privacy", "/files/*", "/sitemap.xml", "/robots.txt"]) app.use(p, rateLimit(POLICIES.candidatePages));
  // 21 Sep, item 6: candidate pages carry a strict policy with a per-request nonce; report-only until reviewed (CSP_MODE).
  const candidateCsp: MiddlewareHandler<Vars> = async (c, next) => {
    // One nonce per response: "/x/*" also matches "/x", so a page mounted under both runs this twice, and a second nonce
    // would replace the one the page was drawn with in the header (every style blocked once CSP_MODE=enforce).
    if (c.get("nonce")) return next();
    const nonce = makeNonce();
    c.set("nonce", nonce);
    await next();
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) c.res.headers.set(cspHeaderName(container.env.CSP_MODE), buildCandidateCsp({ nonce, production: container.env.NODE_ENV === "production", reportPath: "/api/csp-report", connectOrigins: container.integrations.storage.browserOrigins() }));
  };
  app.use("/c/*", candidateCsp);
  app.use("/careers/*", candidateCsp);
  app.use("/privacy", candidateCsp);
  // The staff second-factor pages and the sign-in link page are server-rendered HTML under the API: same policy, same nonce.
  app.use("/api/v1/auth/mfa", candidateCsp);
  app.use("/api/v1/auth/mfa/*", candidateCsp);
  app.use("/api/v1/auth/consume", candidateCsp);
  app.use("/api/v1/auth/invite", candidateCsp);
  app.use("/api/v1/auth/invite/*", candidateCsp);
  // The team's preview of a job page (pages/preview.tsx) is a candidate page drawn for the team: same policy, same nonce.
  for (const p of ["/api/v1/roles/:id/preview/page", "/api/v1/intake/sessions/:id/preview/page"]) app.use(p, candidateCsp);
  // Browsers post policy violations here (both report formats). Paths and origins only; never a token or a query string.
  app.post("/api/csp-report", rateLimit(POLICIES.cspReport), async (c) => {
    let body: unknown = null;
    try { body = await c.req.json(); } catch { return c.body(null, 204); }
    const reports = normalizeCspReports(body, c.req.header("user-agent")).slice(0, 20);
    await withPlatform(container.db, async (tx) => { for (const r of reports) await recordCspReport(tx, r, container.engine.clock()); });
    return c.body(null, 204);
  });

  // A stale worker's critical alert is emailed from here, after its commit: the queued email job waits for that worker.
  const workerWatch = appHealthWatch(container.db, { workerInline: container.env.WORKER_INLINE, emailCritical: (id) => container.emailCritical(id) });
  const checkHealth = async () => {
    try {
      await container.db.select({ id: companies.id }).from(companies).limit(1);
      // With a separate worker (H15) the newest heartbeat says whether it is polling; `healthy` is false once it is ten minutes old.
      const worker = container.env.WORKER_INLINE ? "inline" : await readWorkerHealth(container.db, container.engine.clock()).then((w) => ({ lastSeenAt: w?.lastSeenAt ?? null, queueDepth: w?.queueDepth ?? null, healthy: !!w?.healthy }));
      // H3: the app is the process still up when the worker is not, so it raises the stale-worker and stale-queue alerts (throttled).
      await workerWatch(container.engine.clock());
      return { ok: true as const, worker, workerHealthy: worker === "inline" || worker.healthy };
    } catch (err) {
      // An anonymous endpoint never shows a driver error (it can name hosts, roles or a connection string); the log has it, redacted.
      console.error(`[healthz] database check failed: ${redactString(err instanceof Error ? err.message : String(err))}`);
      return { ok: false as const };
    }
  };
  // HOST-V7: one check per process every `healthCacheMs`, shared by the requests in between (a failed one too) and by
  // requests that arrive while it runs; each request still reads `?strict=1` itself.
  const healthCacheMs = opts.healthCacheMs ?? (container.env.NODE_ENV === "test" ? 0 : HEALTHZ_CACHE_MS);
  let lastCheck: { at: number; result: ReturnType<typeof checkHealth> } | null = null;
  app.get("/healthz", async (c) => {
    const now = container.engine.clock().getTime();
    if (!lastCheck || now - lastCheck.at >= healthCacheMs || now < lastCheck.at) lastCheck = { at: now, result: checkHealth() };
    const health = await lastCheck.result;
    if (!health.ok) return c.json({ ok: false, error: "database unavailable" }, 503);
    const { worker, workerHealthy } = health;
    // `?strict=1` is for an uptime monitor that reads only the status code: a stopped worker answers 503 there.
    if (c.req.query("strict") === "1" && !workerHealthy) return c.json({ ok: false, db: container.handle.kind, ai: container.ai.provider.id, worker, workerHealthy }, 503);
    return c.json({ ok: true, db: container.handle.kind, ai: container.ai.provider.id, worker, workerHealthy });
  });

  // Rule 3 of the plans of 5 November 2026: before any handler under these paths, and at the prefix so a new router cannot forget it.
  for (const p of ["/api/v1/applications/:id", "/api/v1/applications/:id/*"]) app.use(p, applicationLockGuard);

  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/auth", authSessionRoutes);
  app.route("/api/v1/companies", companyRoutes);
  app.route("/api/v1/companies", companySettingsRoutes);
  app.route("/api/v1/plans", planRoutes);
  app.route("/api/v1/intake", intakeRoutes);
  app.route("/api/v1/intake", draftPreviewPages);
  // The job preview page first, before the job routes' scope guard: every refusal is the preview's own plain page.
  app.route("/api/v1/roles", rolePreviewPages);
  app.route("/api/v1/roles", roleRoutes);
  app.route("/api/v1/roles", candidateRoleRoutes);
  app.route("/api/v1/applications", applicationRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1/admin/data-requests", privacyRequestRoutes);
  app.route("/api/v1/notifications", notificationRoutes);
  app.route("/api/v1/roles", screenRoleRoutes);
  app.route("/files", fileRoutes);
  app.route("/webhooks/postmark", postmarkWebhook);
  app.route("/", candidatePages);
  // The public privacy-request form and its confirmation link (audit finding D13): pages/privacy-request.tsx.
  app.route("/", privacyRequestPages);
  // The sitemap and robots: pages/sitemap.ts.
  app.route("/", sitemapPages);

  /** Development only: what the fake email adapter would have sent (magic links, acknowledgments). */
  if (container.env.NODE_ENV !== "production" && container.integrations.email instanceof FakeEmailAdapter) {
    const fakeEmail = container.integrations.email;
    app.get("/dev/outbox", (c) => c.json(fakeEmail.sent.slice(-50).reverse()));
  }

  return app;
}

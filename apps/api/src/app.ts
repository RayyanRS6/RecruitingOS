import { Hono, type MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { companies, withPlatform } from "@ros/db";
import { FakeEmailAdapter, FakeSmsAdapter } from "@ros/integrations";
import type { Container } from "./container";
import { errorHandler } from "./middleware/errors";
import { sessionMiddleware, type Vars } from "./middleware/session";
import { authRoutes } from "./routes/auth";
import { companyRoutes } from "./routes/companies";
import { companySettingsRoutes } from "./routes/company-settings";
import { authSessionRoutes } from "./routes/auth-sessions";
import { privacyRequestPages } from "./pages/privacy-request";
import { intakeRoutes } from "./routes/intake";
import { applicationRoutes, roleRoutes } from "./routes/roles";
import { postingRoutes } from "./routes/postings";
import { draftPacketRoutes, rolePacketRoutes } from "./routes/role-packets";
import { reportRoutes } from "./routes/reports";
import { messageRoutes } from "./routes/messages";
import { compareRoutes } from "./routes/compare";
import { approvalRoutes, briefRoutes, escalationRoutes, eventRoutes } from "./routes/approvals-escalations-events";
import { adminRoutes } from "./routes/admin";
import { policyRoutes } from "./routes/policies";
import { notificationRoutes } from "./routes/notifications";
import { integrationRoutes } from "./routes/integrations";
import { applicationInterviewRoutes, interviewRoutes, meRoutes, roleInterviewRoutes } from "./routes/interviews";
import { schedulePages } from "./pages/schedule";
import { privacyRequestRoutes } from "./routes/privacy-requests";
import { observabilityRoutes } from "./routes/observability";
import { readWorkerHealth } from "./worker-health";
import { appHealthWatch } from "./maintenance";
import { redactString } from "@ros/core";
import { twilioWebhook } from "./webhooks/twilio";
import { candidatePages } from "./pages/candidate";
import { linkPages } from "./pages/links";
import { publicFeeds } from "./pages/public-feeds";
import { fileRoutes } from "./routes/files";
import { postmarkWebhook } from "./webhooks/postmark";
import { POLICIES, apiRateLimit, rateLimit, webhookRateLimit } from "./middleware/rate-limit";
import { contextStorage } from "hono/context-storage";
import { buildCandidateCsp, cspHeaderName, makeNonce, normalizeCspReports, recordCspReport } from "@ros/core";

export function createApp(container: Container) {
  const app = new Hono<Vars>();
  app.onError(errorHandler);
  app.use("*", contextStorage());
  // Request logs never carry a credential or an OAuth code (correction 10).
  if (container.env.NODE_ENV !== "test") app.use("*", logger((line) => console.log(redactString(line))));
  app.use("*", secureHeaders());
  // The API is served by the same Next.js deployment as the app (one origin, APP_BASE_URL), so no cross-origin access is granted.
  app.use("*", sessionMiddleware(container));
  // 21 Sep, item 5: per-user and per-tenant limits on the API, per-address for anonymous calls, generous per-provider limits on webhooks.
  app.use("/api/*", apiRateLimit());
  app.use("/webhooks/*", webhookRateLimit());
  for (const p of ["/c/*", "/careers/*", "/privacy", "/feeds/*", "/files/*", "/a/*", "/sitemap.xml", "/robots.txt"]) app.use(p, rateLimit(POLICIES.candidatePages));
  // 21 Sep, item 6: candidate pages carry a strict policy with a per-request nonce; report-only until reviewed (CSP_MODE).
  const candidateCsp: MiddlewareHandler<Vars> = async (c, next) => {
    const nonce = makeNonce();
    c.set("nonce", nonce);
    await next();
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) c.res.headers.set(cspHeaderName(container.env.CSP_MODE), buildCandidateCsp({ nonce, production: container.env.NODE_ENV === "production", reportPath: "/api/csp-report", connectOrigins: container.integrations.storage.browserOrigins() }));
  };
  app.use("/c/*", candidateCsp);
  app.use("/careers/*", candidateCsp);
  app.use("/privacy", candidateCsp);
  app.use("/a/*", candidateCsp);
  // The staff second-factor pages and the sign-in link page are server-rendered HTML under the API: same policy, same nonce.
  app.use("/api/v1/auth/mfa", candidateCsp);
  app.use("/api/v1/auth/mfa/*", candidateCsp);
  app.use("/api/v1/auth/consume", candidateCsp);
  app.use("/api/v1/auth/invite", candidateCsp);
  app.use("/api/v1/auth/invite/*", candidateCsp);
  // Browsers post policy violations here (both report formats). Paths and origins only; never a token or a query string.
  app.post("/api/csp-report", rateLimit(POLICIES.cspReport), async (c) => {
    let body: unknown = null;
    try { body = await c.req.json(); } catch { return c.body(null, 204); }
    const reports = normalizeCspReports(body, c.req.header("user-agent")).slice(0, 20);
    await withPlatform(container.db, async (tx) => { for (const r of reports) await recordCspReport(tx, r, container.engine.clock()); });
    return c.body(null, 204);
  });

  const workerWatch = appHealthWatch(container.db, { workerInline: container.env.WORKER_INLINE });
  app.get("/healthz", async (c) => {
    try {
      await container.db.select({ id: companies.id }).from(companies).limit(1);
      // With a separate worker (H15) the newest heartbeat says whether it is polling; `healthy` is false once it is ten minutes old.
      const worker = container.env.WORKER_INLINE ? "inline" : await readWorkerHealth(container.db, container.engine.clock()).then((w) => ({ lastSeenAt: w?.lastSeenAt ?? null, queueDepth: w?.queueDepth ?? null, healthy: !!w?.healthy }));
      // H3: the app is the process still up when the worker is not, so it raises the stale-worker and stale-queue alerts (throttled).
      await workerWatch(container.engine.clock());
      const workerHealthy = worker === "inline" || worker.healthy;
      // `?strict=1` is for an uptime monitor that reads only the status code: a stopped worker answers 503 there.
      if (c.req.query("strict") === "1" && !workerHealthy) return c.json({ ok: false, db: container.handle.kind, ai: container.ai.provider.id, worker, workerHealthy }, 503);
      return c.json({ ok: true, db: container.handle.kind, ai: container.ai.provider.id, worker, workerHealthy });
    } catch (err) {
      // An anonymous endpoint never shows a driver error (it can name hosts, roles or a connection string); the log has it, redacted.
      console.error(`[healthz] database check failed: ${redactString(err instanceof Error ? err.message : String(err))}`);
      return c.json({ ok: false, error: "database unavailable" }, 503);
    }
  });

  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/auth", authSessionRoutes);
  app.route("/api/v1/companies", companyRoutes);
  app.route("/api/v1/companies", companySettingsRoutes);
  app.route("/api/v1/intake", intakeRoutes);
  app.route("/api/v1/intake", draftPacketRoutes);
  app.route("/api/v1/roles", roleRoutes);
  app.route("/api/v1/roles", postingRoutes);
  app.route("/api/v1/roles", rolePacketRoutes);
  app.route("/api/v1/roles", reportRoutes);
  app.route("/api/v1/roles", compareRoutes);
  app.route("/api/v1/applications", messageRoutes);
  app.route("/api/v1/applications", applicationRoutes);
  app.route("/api/v1/approvals", approvalRoutes);
  app.route("/api/v1/escalations", escalationRoutes);
  app.route("/api/v1/events", eventRoutes);
  app.route("/api/v1/brief", briefRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1/admin/data-requests", privacyRequestRoutes);
  app.route("/api/v1/admin/observability", observabilityRoutes);
  app.route("/api/v1/policies", policyRoutes);
  app.route("/api/v1/notifications", notificationRoutes);
  app.route("/api/v1/integrations", integrationRoutes);
  app.route("/api/v1/interviews", interviewRoutes);
  app.route("/api/v1/applications", applicationInterviewRoutes);
  app.route("/api/v1/roles", roleInterviewRoutes);
  app.route("/api/v1/me", meRoutes);
  app.route("/", schedulePages);
  app.route("/files", fileRoutes);
  app.route("/webhooks/postmark", postmarkWebhook);
  app.route("/webhooks/twilio", twilioWebhook);
  app.route("/", candidatePages);
  // The public privacy-request form and its confirmation link (audit finding D13): pages/privacy-request.tsx.
  app.route("/", privacyRequestPages);
  // Tracked application links, the sitemap, robots and the public job feeds (docs/spec/20 items 5 to 7): pages/links.tsx and pages/public-feeds.ts.
  app.route("/", linkPages);
  app.route("/", publicFeeds);

  /** Development only: what the fake email adapter would have sent (magic links, acknowledgments, escalations). */
  if (container.env.NODE_ENV !== "production" && container.integrations.email instanceof FakeEmailAdapter) {
    const fakeEmail = container.integrations.email;
    app.get("/dev/outbox", (c) => c.json(fakeEmail.sent.slice(-50).reverse()));
  }
  if (container.env.NODE_ENV !== "production" && container.integrations.sms instanceof FakeSmsAdapter) {
    const fakeSms = container.integrations.sms;
    app.get("/dev/sms-outbox", (c) => c.json(fakeSms.sent.slice(-50).reverse()));
  }

  return app;
}

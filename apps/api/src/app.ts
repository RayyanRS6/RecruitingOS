import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { and, eq } from "drizzle-orm";
import { companies, rolePackets, roles, withPlatform } from "@ros/db";
import { FakeEmailAdapter, FakeSmsAdapter, linkedInFeedXml } from "@ros/integrations";
import type { Container } from "./container";
import { errorHandler } from "./middleware/errors";
import { sessionMiddleware, type Vars } from "./middleware/session";
import { authRoutes } from "./routes/auth";
import { companyRoutes } from "./routes/companies";
import { intakeRoutes } from "./routes/intake";
import { applicationRoutes, roleRoutes } from "./routes/roles";
import { approvalRoutes, briefRoutes, escalationRoutes, eventRoutes } from "./routes/approvals-escalations-events";
import { adminRoutes } from "./routes/admin";
import { policyRoutes } from "./routes/policies";
import { notificationRoutes } from "./routes/notifications";
import { integrationRoutes } from "./routes/integrations";
import { applicationInterviewRoutes, interviewRoutes, meRoutes, roleInterviewRoutes } from "./routes/interviews";
import { schedulePages } from "./pages/schedule";
import { privacyRequestRoutes } from "./routes/privacy-requests";
import { redactString } from "@ros/core";
import { twilioWebhook } from "./webhooks/twilio";
import { candidatePages } from "./pages/candidate";
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
  app.use("/api/*", cors({ origin: [container.env.WEB_BASE_URL], credentials: true, allowHeaders: ["Content-Type", "X-Admin-Reason"] }));
  app.use("*", sessionMiddleware(container));
  // 21 Sep, item 5: per-user and per-tenant limits on the API, per-address for anonymous calls, generous per-provider limits on webhooks.
  app.use("/api/*", apiRateLimit());
  app.use("/webhooks/*", webhookRateLimit());
  for (const p of ["/c/*", "/careers/*", "/privacy", "/feeds/*"]) app.use(p, rateLimit(POLICIES.candidatePages));
  // 21 Sep, item 6: candidate pages carry a strict policy with a per-request nonce; report-only until reviewed (CSP_MODE).
  const candidateCsp: MiddlewareHandler<Vars> = async (c, next) => {
    const nonce = makeNonce();
    c.set("nonce", nonce);
    await next();
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) c.res.headers.set(cspHeaderName(container.env.CSP_MODE), buildCandidateCsp({ nonce, production: container.env.NODE_ENV === "production", reportPath: "/api/csp-report" }));
  };
  app.use("/c/*", candidateCsp);
  app.use("/careers/*", candidateCsp);
  app.use("/privacy", candidateCsp);
  // The staff second-factor pages are server-rendered HTML under the API: same policy, same nonce.
  app.use("/api/v1/auth/mfa", candidateCsp);
  app.use("/api/v1/auth/mfa/*", candidateCsp);
  // Browsers post policy violations here (both report formats). Paths and origins only; never a token or a query string.
  app.post("/api/csp-report", rateLimit(POLICIES.cspReport), async (c) => {
    let body: unknown = null;
    try { body = await c.req.json(); } catch { return c.body(null, 204); }
    const reports = normalizeCspReports(body, c.req.header("user-agent")).slice(0, 20);
    await withPlatform(container.db, async (tx) => { for (const r of reports) await recordCspReport(tx, r, container.engine.clock()); });
    return c.body(null, 204);
  });

  app.get("/healthz", async (c) => {
    try {
      await container.db.select({ id: companies.id }).from(companies).limit(1);
      return c.json({ ok: true, db: container.handle.kind, ai: container.ai.provider.id, worker: container.env.WORKER_INLINE ? "inline" : "external" });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 503);
    }
  });

  app.route("/api/v1/auth", authRoutes);
  app.route("/api/v1/companies", companyRoutes);
  app.route("/api/v1/intake", intakeRoutes);
  app.route("/api/v1/roles", roleRoutes);
  app.route("/api/v1/applications", applicationRoutes);
  app.route("/api/v1/approvals", approvalRoutes);
  app.route("/api/v1/escalations", escalationRoutes);
  app.route("/api/v1/events", eventRoutes);
  app.route("/api/v1/brief", briefRoutes);
  app.route("/api/v1/admin", adminRoutes);
  app.route("/api/v1/admin/data-requests", privacyRequestRoutes);
  app.route("/api/v1/policies", policyRoutes);
  app.route("/api/v1/notifications", notificationRoutes);
  app.route("/api/v1/integrations", integrationRoutes);
  app.route("/api/v1/interviews", interviewRoutes);
  app.route("/api/v1/applications", applicationInterviewRoutes);
  app.route("/api/v1/roles", roleInterviewRoutes);
  app.route("/api/v1/me", meRoutes);
  app.route("/", schedulePages);
  app.route("/webhooks/postmark", postmarkWebhook);
  app.route("/webhooks/twilio", twilioWebhook);
  app.route("/", candidatePages);

  app.get("/api/v1/integrations", async (c) => {
    if (!c.get("session")) return c.json({ error: { code: "unauthorized", message: "Sign in." } }, 401);
    return c.json(container.integrations.statuses());
  });

  /** LinkedIn Basic Jobs feed: every open role across tenants (public job data only). */
  app.get("/feeds/linkedin.xml", async (c) => {
    const rows = await container.db
      .select({ roleId: roles.id, title: roles.title, companyName: companies.name, slug: companies.slug, packet: rolePackets.packet })
      .from(roles)
      .innerJoin(companies, eq(companies.id, roles.companyId))
      .innerJoin(rolePackets, and(eq(rolePackets.roleId, roles.id), eq(rolePackets.status, "approved")))
      .where(eq(roles.status, "open"));
    const xml = linkedInFeedXml(
      rows.map((r) => {
        const loc = r.packet.identity.locations[0];
        const comp = r.packet.compensation;
        return {
          partnerJobId: r.roleId,
          company: r.companyName,
          title: r.title,
          description: r.packet.description.publicJobDescription,
          location: [loc?.city, loc?.region, loc?.country ?? "US"].filter(Boolean).join(", "),
          applyUrl: `${container.env.APP_BASE_URL}/careers/${r.slug}/jobs/${r.roleId}/apply`,
          salaryText: comp.discloseRange ? `${comp.max} ${comp.currency} ${comp.basis}` : undefined,
        };
      }),
    );
    return c.body(xml, 200, { "Content-Type": "application/xml; charset=utf-8" });
  });

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

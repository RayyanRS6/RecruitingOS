import { Hono, type Context } from "hono";
import { eq, and } from "drizzle-orm";
import { recordWebhookReceipt, safeEqual } from "@ros/core";
import { handleEmailEvent } from "@ros/agents";
import { inboundEmails, postings, roles, withPlatform, withTenant } from "@ros/db";
import { extractApplicantFromInbound, extractIntakeToken, parsePostmarkEvent, parsePostmarkInbound, verifyPostmarkWebhookAuth } from "@ros/integrations";
import type { Vars } from "../middleware/session";
import { createApplication } from "../services/applications";

/**
 * Inbound email: Indeed-hosted applications (and any forwarded application) arrive at the role's
 * intake address and become applications. Verified by the shared secret Postmark is configured to send.
 */
export const postmarkWebhook = new Hono<Vars>();

postmarkWebhook.post("/inbound", async (c) => {
  const container = c.get("container");
  const secret = container.env.raw.POSTMARK_INBOUND_SECRET;
  if (secret) {
    // Postmark carries credentials as HTTP basic auth in the webhook URL (https://inbound:<secret>@host/...); a header
    // or a query string are still accepted for tools that cannot set basic auth.
    const provided = c.req.query("secret") ?? c.req.header("x-inbound-secret") ?? "";
    const ok = verifyPostmarkWebhookAuth({ authorization: c.req.header("authorization"), secretHeader: c.req.header("x-inbound-secret") }, secret) || (!!provided && safeEqual(provided, secret));
    if (!ok) return c.json({ error: { code: "unauthorized", message: "bad secret" } }, 401);
  } else if (container.env.NODE_ENV === "production") {
    return c.json({ error: { code: "misconfigured", message: "POSTMARK_INBOUND_SECRET is not set" } }, 503);
  }
  const payload = (await c.req.json()) as Record<string, unknown>;
  const mail = parsePostmarkInbound(payload);
  const token = extractIntakeToken(mail.to, container.integrations.env.intakeDomain);
  const [inbound] = await container.db.insert(inboundEmails).values({ toAddress: mail.to, fromAddress: mail.from, subject: mail.subject, parsed: { text: mail.text.slice(0, 20000), attachments: mail.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes })) }, status: "received" }).returning();
  if (!token) {
    await container.db.update(inboundEmails).set({ status: "unmatched", error: "no intake token in recipient address" }).where(eq(inboundEmails.id, inbound.id));
    return c.json({ ok: true, matched: false });
  }
  const [posting] = await container.db.select().from(postings).where(and(eq(postings.channel, "email_in"), eq(postings.intakeToken, token))).limit(1);
  if (!posting) {
    await container.db.update(inboundEmails).set({ status: "unmatched", error: "unknown intake token" }).where(eq(inboundEmails.id, inbound.id));
    return c.json({ ok: true, matched: false });
  }
  const [role] = await container.db.select().from(roles).where(eq(roles.id, posting.roleId)).limit(1);
  if (!role || role.status !== "open") {
    await container.db.update(inboundEmails).set({ status: "unmatched", companyId: posting.companyId, error: "role not open" }).where(eq(inboundEmails.id, inbound.id));
    return c.json({ ok: true, matched: false });
  }
  const applicant = extractApplicantFromInbound(mail);
  const attachment = mail.attachments.find((a) => /pdf|word|text/.test(a.contentType) || /\.(pdf|docx|txt)$/i.test(a.filename));
  const resume = attachment ? { filename: attachment.filename, mime: attachment.contentType, bytes: new Uint8Array(Buffer.from(attachment.contentBase64, "base64")) } : null;
  try {
    const result = await withTenant(container.db, posting.companyId, (tx) =>
      createApplication(tx, container, {
        companyId: posting.companyId,
        roleId: role.id,
        source: "email_in",
        firstName: applicant.firstName,
        lastName: applicant.lastName,
        email: applicant.email,
        phone: applicant.phone,
        smsConsent: false,
        consentSource: "email_in",
        noticeVersionsShown: [],
        eligibilityAnswers: {},
        noResumeAnswers: resume ? undefined : { summary: mail.text.slice(0, 4000) },
        resume,
        note: applicant.note,
      }, { kind: "system", id: "email_in" }),
    );
    await container.db.update(inboundEmails).set({ status: "matched", companyId: posting.companyId, applicationId: result.application.id }).where(eq(inboundEmails.id, inbound.id));
    await container.kick();
    return c.json({ ok: true, matched: true, applicationId: result.application.id, duplicate: result.duplicate });
  } catch (err) {
    await container.db.update(inboundEmails).set({ status: "error", companyId: posting.companyId, error: err instanceof Error ? err.message : String(err) }).where(eq(inboundEmails.id, inbound.id));
    return c.json({ ok: false, matched: true, error: "could not create application; queued for review" }, 202);
  }
});

/**
 * Delivery events (bounces, spam complaints, deliveries). Authenticated with the webhook secret Postmark is configured to
 * send (basic auth on the URL or a header); fails closed in production. Each event id is processed once.
 */
async function handleDeliveryEvent(c: Context<Vars>) {
  const container = c.get("container");
  const secret = container.env.raw.POSTMARK_WEBHOOK_SECRET;
  if (secret) {
    if (!verifyPostmarkWebhookAuth({ authorization: c.req.header("authorization"), secretHeader: c.req.header("x-webhook-secret") }, secret)) return c.json({ error: { code: "unauthorized", message: "bad webhook credentials" } }, 401);
  } else if (container.env.NODE_ENV === "production") {
    return c.json({ error: { code: "misconfigured", message: "POSTMARK_WEBHOOK_SECRET is not set" } }, 503);
  }
  const payload = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const event = payload ? parsePostmarkEvent(payload) : null;
  if (!event) return c.json({ error: { code: "invalid_request", message: "not a Postmark event" } }, 400);
  const first = await recordWebhookReceipt(container.db, { provider: "postmark", kind: event.recordType, externalId: event.externalId });
  if (!first) return c.json({ ok: true, duplicate: true });
  const outcome = await withPlatform(container.db, (tx) => handleEmailEvent(tx, container.integrations, { event, appBaseUrl: container.env.APP_BASE_URL, now: container.engine.clock() }));
  await container.kick();
  return c.json({ ok: true, duplicate: false, ...outcome });
}
postmarkWebhook.post("/bounces", handleDeliveryEvent);
postmarkWebhook.post("/spam", handleDeliveryEvent);
postmarkWebhook.post("/events", handleDeliveryEvent);

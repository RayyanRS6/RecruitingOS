import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { emit, normalizePhone } from "@ros/core";
import { applications, candidates, communications, screens, withTenant } from "@ros/db";
import { parseTwilioInbound, smsKeyword, verifyTwilioSignature } from "@ros/integrations";
import { runScreenTurn } from "@ros/agents";
import type { Vars } from "../middleware/session";
import { screenDeps } from "../services/screens";

/**
 * Inbound SMS: a candidate's reply reaches the screening conversation it belongs to. STOP/START/HELP are honored
 * before anything else (the carrier honors STOP too; we record it so no adapter ever texts them again).
 */
export const twilioWebhook = new Hono<Vars>();

const EMPTY_TWIML = `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;

twilioWebhook.post("/inbound", async (c) => {
  const container = c.get("container");
  const raw = await c.req.parseBody();
  const form: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) form[k] = typeof v === "string" ? v : undefined;
  const token = container.env.raw.TWILIO_AUTH_TOKEN;
  if (token) {
    const url = container.env.raw.TWILIO_WEBHOOK_URL ?? `${container.env.APP_BASE_URL}/webhooks/twilio/inbound`;
    if (!verifyTwilioSignature(token, url, form, c.req.header("x-twilio-signature"))) return c.text("bad signature", 403);
  } else if (container.env.NODE_ENV === "production") {
    return c.text("TWILIO_AUTH_TOKEN is not set", 503);
  }
  const sms = parseTwilioInbound(form);
  const phone = normalizePhone(sms.from);
  if (!phone || !sms.body) return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });

  // Every candidate record with this number (a person can apply to more than one customer); prefer the one with an open screen.
  const people = await container.db.select().from(candidates).where(eq(candidates.phone, phone));
  if (!people.length) return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });

  const keyword = smsKeyword(sms.body);
  if (keyword === "stop" || keyword === "start") {
    for (const p of people) {
      await withTenant(container.db, p.companyId, async (tx) => {
        const consent = { ...p.consent, sms: { ...(p.consent.sms ?? { granted: false, at: new Date().toISOString(), source: "sms" }), granted: keyword === "start", at: new Date().toISOString(), source: "sms_keyword" } };
        await tx.update(candidates).set({ preferences: { ...p.preferences, smsOptOut: keyword === "stop" }, consent }).where(eq(candidates.id, p.id));
        await emit(tx, { type: keyword === "stop" ? "candidate.opted_out" : "consent.granted", companyId: p.companyId, actor: { kind: "candidate", id: p.id }, subject: { type: "candidate", id: p.id }, payload: { channel: "sms", keyword: sms.body.trim().toUpperCase() } });
        if (keyword === "stop") await emit(tx, { type: "consent.revoked", companyId: p.companyId, actor: { kind: "candidate", id: p.id }, subject: { type: "candidate", id: p.id }, payload: { purpose: "sms", source: "sms_keyword" } });
        const apps = await tx.select({ id: applications.id }).from(applications).where(eq(applications.candidateId, p.id)).orderBy(desc(applications.createdAt)).limit(1);
        if (apps[0]) await tx.insert(communications).values({ companyId: p.companyId, candidateId: p.id, applicationId: apps[0].id, direction: "inbound", channel: "sms", fromAddress: phone, bodyText: sms.body, provider: "twilio", providerMessageId: sms.messageSid ?? null, status: "received", disclosureIncluded: false, sentBy: { kind: "candidate", id: p.id } });
      });
    }
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }

  // Find the most recent open screen among this person's applications.
  let target: { screenId: string; companyId: string } | null = null;
  for (const p of people) {
    const rows = await container.db
      .select({ screenId: screens.id, companyId: screens.companyId, updatedAt: screens.updatedAt })
      .from(screens)
      .innerJoin(applications, eq(applications.id, screens.applicationId))
      .where(and(eq(applications.candidateId, p.id), inArray(screens.status, ["invited", "reminded", "in_progress"])))
      .orderBy(desc(screens.updatedAt))
      .limit(1);
    if (rows[0] && (!target || rows[0].updatedAt > (target as { updatedAt?: string }).updatedAt!)) target = { screenId: rows[0].screenId, companyId: rows[0].companyId };
  }
  if (!target) {
    // No open conversation: keep the message on the record so a person can answer it.
    const p = people[0];
    await withTenant(container.db, p.companyId, async (tx) => {
      const apps = await tx.select({ id: applications.id }).from(applications).where(eq(applications.candidateId, p.id)).orderBy(desc(applications.createdAt)).limit(1);
      if (apps[0]) {
        const [row] = await tx.insert(communications).values({ companyId: p.companyId, candidateId: p.id, applicationId: apps[0].id, direction: "inbound", channel: "sms", fromAddress: phone, bodyText: sms.body, provider: "twilio", providerMessageId: sms.messageSid ?? null, status: "received", disclosureIncluded: false, sentBy: { kind: "candidate", id: p.id } }).returning({ id: communications.id });
        await emit(tx, { type: "message.received", companyId: p.companyId, actor: { kind: "candidate", id: p.id }, subject: { type: "communication", id: row.id }, payload: { channel: "sms", applicationId: apps[0].id, unmatched: true } });
      }
    });
    return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
  }
  const t = target;
  await runScreenTurn(container.db, t.companyId, screenDeps(container), { screenId: t.screenId, message: sms.body, channel: "sms", actor: { kind: "system", id: "sms_inbound" }, providerMessageId: sms.messageSid ?? null });
  await container.kick();
  return c.body(EMPTY_TWIML, 200, { "Content-Type": "text/xml" });
});

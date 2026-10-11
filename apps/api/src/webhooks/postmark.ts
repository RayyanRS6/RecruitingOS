import { Hono, type Context } from "hono";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { MAX_RESUME_BYTES, type Actor } from "@ros/contracts";
import { claimWebhookReceipt, notify } from "@ros/core";
import { handleEmailEvent } from "@ros/agents";
import { inboundEmails, notifications, postings, roles, withPlatform, withTenant, type Tx } from "@ros/db";
import { extractApplicantFromInbound, extractIntakeToken, extractReplyToken, parsePostmarkEvent, parsePostmarkInbound, verifyPostmarkWebhookAuth, type InboundEmail } from "@ros/integrations";
import type { Container } from "../container";
import type { Vars } from "../middleware/session";
import { createApplication, type NewApplication, type ResumeInput } from "../services/applications";
import { handleSubscriptionChange } from "../services/email-subscriptions";
import { receiveCandidateReply } from "../services/replies";

type RoleRow = typeof roles.$inferSelect;
type InboundRow = typeof inboundEmails.$inferSelect;
/** What a held row keeps in `parsed` beyond the text and the attachment list, so the replay can rebuild the email. */
type HeldParsed = { text?: string; fromName?: string | null; resume?: { filename: string; contentType: string } | null };

/** The team's notice that an email-in application is waiting for the role to open again (C19). */
export const HELD_EMAIL_NOTIFICATION_KIND = "application.email_held";
const EMAIL_IN_ACTOR: Actor = { kind: "system", id: "email_in" };

/**
 * Inbound email: Indeed-hosted applications (and any forwarded application) arrive at the role's
 * intake address and become applications. Verified by the shared secret Postmark is configured to send.
 */
export const postmarkWebhook = new Hono<Vars>();

postmarkWebhook.post("/inbound", async (c) => {
  const container = c.get("container");
  const secret = container.env.raw.POSTMARK_INBOUND_SECRET;
  if (secret) {
    // Postmark carries credentials as HTTP basic auth in the webhook URL (https://inbound:<secret>@host/...); the
    // x-inbound-secret header is accepted for tools that cannot set basic auth. Never the query string: platforms log
    // full request URLs, and a secret in one would end up in those logs.
    if (!verifyPostmarkWebhookAuth({ authorization: c.req.header("authorization"), secretHeader: c.req.header("x-inbound-secret") }, secret)) return c.json({ error: { code: "unauthorized", message: "bad secret" } }, 401);
  } else if (container.env.NODE_ENV === "production") {
    return c.json({ error: { code: "misconfigured", message: "POSTMARK_INBOUND_SECRET is not set" } }, 503);
  }
  const payload = (await c.req.json()) as Record<string, unknown>;
  const mail = parsePostmarkInbound(payload);
  const token = extractIntakeToken(mail.to, container.integrations.env.intakeDomain);
  const [inbound] = await container.db.insert(inboundEmails).values({ toAddress: mail.to, fromAddress: mail.from, subject: mail.subject, parsed: { text: mail.text.slice(0, 20000), attachments: mail.attachments.map((a) => ({ filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes })) }, status: "received" }).returning();
  // A candidate's reply to one of our emails (F12): the per-application address names the application; the reply is
  // recorded on it and the team told (services/replies.ts). Never an application, whatever the body says.
  const replyToken = extractReplyToken(mail.to, container.integrations.env.intakeDomain);
  if (replyToken) {
    const outcome = await receiveCandidateReply(container, { inbound, mail, replyToken });
    return c.json(outcome.body, outcome.status as 200 | 202 | 503);
  }
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
  if (!role || !["open", "paused"].includes(role.status)) {
    await container.db.update(inboundEmails).set({ status: "unmatched", companyId: posting.companyId, error: "role not open" }).where(eq(inboundEmails.id, inbound.id));
    return c.json({ ok: true, matched: false });
  }
  if (role.status === "paused" || !role.acceptingApplications) {
    await holdInboundEmail(container, { inbound, mail, companyId: posting.companyId, role });
    return c.json({ ok: true, matched: true, held: true });
  }
  const attachment = resumeAttachment(mail);
  const resume: ResumeInput | null = attachment ? { kind: "bytes", filename: attachment.filename, mime: attachment.contentType, bytes: new Uint8Array(Buffer.from(attachment.contentBase64, "base64")), via: "email" } : null;
  try {
    const result = await withTenant(container.db, posting.companyId, (tx) => createApplication(tx, container, applicationFromEmail({ companyId: posting.companyId, roleId: role.id, mail, resume }), EMAIL_IN_ACTOR));
    await container.db.update(inboundEmails).set({ status: "matched", companyId: posting.companyId, applicationId: result.application.id }).where(eq(inboundEmails.id, inbound.id));
    await container.kick();
    return c.json({ ok: true, matched: true, applicationId: result.application.id, duplicate: result.duplicate });
  } catch (err) {
    await container.db.update(inboundEmails).set({ status: "error", companyId: posting.companyId, error: err instanceof Error ? err.message : String(err) }).where(eq(inboundEmails.id, inbound.id));
    return c.json({ ok: false, matched: true, error: "could not create application; queued for review" }, 202);
  }
});

/** The attachment taken as the résumé: the first PDF, Word or text file. */
function resumeAttachment(mail: InboundEmail) {
  return mail.attachments.find((a) => /pdf|word|text/.test(a.contentType) || /\.(pdf|docx|txt)$/i.test(a.filename));
}

/** The application an inbound email becomes, the same whether it is processed on arrival or replayed after a hold. */
function applicationFromEmail(input: { companyId: string; roleId: string; mail: InboundEmail; resume: ResumeInput | null }): NewApplication {
  const applicant = extractApplicantFromInbound(input.mail);
  return {
    companyId: input.companyId,
    roleId: input.roleId,
    source: "email_in",
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    email: applicant.email,
    phone: applicant.phone,
    smsConsent: false,
    consentSource: "email_in",
    noticeVersionsShown: [],
    eligibilityAnswers: {},
    noResumeAnswers: input.resume ? undefined : { summary: input.mail.text.slice(0, 4000) },
    resume: input.resume,
    note: applicant.note,
  };
}

/** The held emails addressed to one role's intake address, oldest first. Runs inside the company's transaction. */
async function heldEmailsFor(tx: Tx, container: Container, companyId: string, roleId: string): Promise<InboundRow[]> {
  const tokens = new Set((await tx.select({ token: postings.intakeToken }).from(postings).where(and(eq(postings.roleId, roleId), eq(postings.channel, "email_in")))).map((p) => p.token).filter((t): t is string => !!t));
  if (!tokens.size) return [];
  const rows = await tx.select().from(inboundEmails).where(and(eq(inboundEmails.status, "held"), eq(inboundEmails.companyId, companyId))).orderBy(asc(inboundEmails.createdAt));
  return rows.filter((row) => {
    const token = extractIntakeToken(row.toAddress, container.integrations.env.intakeDomain);
    return !!token && tokens.has(token);
  });
}

/** The team's unread held notices for one role: one per person, updated in place while a new email arrives. */
async function unreadHeldNotices(tx: Tx, companyId: string, roleId: string): Promise<string[]> {
  const rows = await tx.select({ id: notifications.id, action: notifications.action }).from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.kind, HELD_EMAIL_NOTIFICATION_KIND), isNull(notifications.readAt)));
  return rows.filter((n) => n.action?.href === `/roles/${roleId}`).map((n) => n.id);
}

/** Plain words for the owner: how many are waiting, why, and that nothing is needed from anyone. Never the sender's address. */
function heldEmailNotice(role: RoleRow, count: number, why: string): { title: string; body: string } {
  const n = Math.max(count, 1);
  if (n === 1) {
    return {
      title: "An application arrived by email while applications are closed",
      body: `Someone emailed an application for ${role.title} while ${why}. It is held, not rejected. As soon as the role is open and taking applications again it will be added to the role's applications on its own; nobody needs to send anything again.`,
    };
  }
  return {
    title: `${n} applications arrived by email while applications are closed`,
    body: `${n} people emailed applications for ${role.title} while ${why}. They are held, not rejected. As soon as the role is open and taking applications again they will be added to the role's applications on their own; nobody needs to send anything again.`,
  };
}

/**
 * C19: while the role is paused or the "accepting applications" switch is off, an application that arrives by email is
 * held, never rejected and never dropped. The row keeps the email; the résumé is parked in storage under the row so the
 * replay has it; the team is told once per role while the notice is unread (a new email updates the count instead of
 * adding another row, since the intake address is public and a closed role can receive a burst); nothing else is
 * created. `replayHeldEmails` turns the held emails into applications when the role opens again.
 */
async function holdInboundEmail(container: Container, input: { inbound: InboundRow; mail: InboundEmail; companyId: string; role: RoleRow }): Promise<void> {
  const { inbound, mail, companyId, role } = input;
  const attachment = resumeAttachment(mail);
  const bytes = attachment?.contentBase64 ? new Uint8Array(Buffer.from(attachment.contentBase64, "base64")) : null;
  let rawStorageKey: string | null = null;
  if (attachment && bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_RESUME_BYTES) {
    const ext = (attachment.filename.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? "bin").toLowerCase();
    rawStorageKey = `inbound/${companyId}/${inbound.id}.${ext}`;
    await container.integrations.storage.put(rawStorageKey, bytes, attachment.contentType);
  }
  const parsed: HeldParsed & Record<string, unknown> = { ...inbound.parsed, fromName: mail.fromName ?? null, resume: rawStorageKey && attachment ? { filename: attachment.filename, contentType: attachment.contentType } : null };
  // The row has no company yet, so this write runs as the platform; everything after it is the company's.
  await withPlatform(container.db, (tx) => tx.update(inboundEmails).set({ status: "held", companyId, rawStorageKey, parsed }).where(eq(inboundEmails.id, inbound.id)));
  await withTenant(container.db, companyId, async (tx) => {
    const waiting = (await heldEmailsFor(tx, container, companyId, role.id)).length;
    const notice = heldEmailNotice(role, waiting, role.status === "paused" ? "the role is paused" : "applications are closed");
    const unread = await unreadHeldNotices(tx, companyId, role.id);
    if (unread.length) await tx.update(notifications).set(notice).where(inArray(notifications.id, unread));
    else await notify(tx, { companyId, kind: HELD_EMAIL_NOTIFICATION_KIND, ...notice, action: { label: "Open the role", href: `/roles/${role.id}` } });
  });
}

/**
 * Turns the emails held for a role (C19) into applications once the role is open and accepting again. Called after the
 * accepting switch reopens and after a resume; a no-op while either gate is still shut, so both callers are safe. Each
 * email runs on its own so one bad one does not stop the rest; the outcome lands on its inbound row exactly as a live
 * email's would (matched with the application id, or error with the reason), the parked résumé leaves storage, and the
 * team's held notice is updated to say what happened. Never rejects anyone.
 */
export async function replayHeldEmails(container: Container, input: { companyId: string; roleId: string }): Promise<{ replayed: number; failed: number }> {
  const { companyId, roleId } = input;
  const found = await withTenant(container.db, companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (role?.status !== "open" || !role.acceptingApplications) return null;
    return { role, held: await heldEmailsFor(tx, container, companyId, roleId) };
  });
  if (!found?.held.length) return { replayed: 0, failed: 0 };
  const { replayed, failed } = await admitHeldEmails(container, { companyId, roleId, held: found.held });
  await withTenant(container.db, companyId, async (tx) => {
    const unread = await unreadHeldNotices(tx, companyId, roleId);
    if (!unread.length) return;
    const one = replayed === 1;
    const added = replayed ? `Applications for ${found.role.title} are open again, so the ${one ? "application" : `${replayed} applications`} that arrived by email while they were closed ${one ? "has" : "have"} been added to the role's applications.` : `Applications for ${found.role.title} are open again.`;
    const trouble = failed ? ` ${failed === 1 ? "One email" : `${failed} emails`} could not be read as an application and ${failed === 1 ? "is" : "are"} kept for a person to look at.` : "";
    await tx.update(notifications).set({ title: replayed ? `${one ? "A held email application was" : `${replayed} held email applications were`} added to ${found.role.title}` : `Held email applications for ${found.role.title} need a look`, body: added + trouble }).where(inArray(notifications.id, unread));
  });
  await container.kick();
  return { replayed, failed };
}

/**
 * Each held email becomes an application on its own (one bad email does not stop the rest); the outcome lands on its
 * inbound row exactly as a live email's would (matched with the application id, or error with the reason) and the
 * parked résumé leaves storage once it travelled with its application.
 */
async function admitHeldEmails(container: Container, input: { companyId: string; roleId: string; held: InboundRow[]; intoTalentPool?: boolean }): Promise<{ replayed: number; failed: number }> {
  const { companyId, roleId } = input;
  let replayed = 0;
  let failed = 0;
  for (const row of input.held) {
    const parsed = row.parsed as HeldParsed;
    const mail: InboundEmail = { to: row.toAddress, from: row.fromAddress, fromName: parsed.fromName ?? undefined, subject: row.subject ?? "", text: parsed.text ?? "", attachments: [], receivedAt: row.createdAt };
    const bytes = row.rawStorageKey ? await container.integrations.storage.get(row.rawStorageKey) : null;
    const resume: ResumeInput | null = bytes && parsed.resume ? { kind: "bytes", filename: parsed.resume.filename, mime: parsed.resume.contentType, bytes, via: "email" } : null;
    try {
      await withTenant(container.db, companyId, async (tx) => {
        const result = await createApplication(tx, container, applicationFromEmail({ companyId, roleId, mail, resume }), EMAIL_IN_ACTOR, { intoTalentPool: input.intoTalentPool });
        await tx.update(inboundEmails).set({ status: "matched", applicationId: result.application.id, rawStorageKey: null }).where(eq(inboundEmails.id, row.id));
      });
      if (row.rawStorageKey) await container.integrations.storage.delete(row.rawStorageKey);
      replayed += 1;
    } catch (err) {
      await withTenant(container.db, companyId, (tx) => tx.update(inboundEmails).set({ status: "error", error: err instanceof Error ? err.message : String(err) }).where(eq(inboundEmails.id, row.id)));
      failed += 1;
    }
  }
  return { replayed, failed };
}

/**
 * A role closed while emailed applications were held for it (C19): paused, or its switch off, and then closed instead of
 * reopened. The notice had promised the team they would be added on their own, so they are: each becomes an
 * application and goes straight to the talent pool, where the role's other active candidates went when it closed, and
 * nobody is told the role is still hiring. The team's held notice says what happened. Called after the close commits;
 * a no-op for a role that is not closed or has nothing held.
 */
export async function settleHeldEmailsOnClose(container: Container, input: { companyId: string; roleId: string }): Promise<{ addedToTalentPool: number; failed: number }> {
  const { companyId, roleId } = input;
  const found = await withTenant(container.db, companyId, async (tx) => {
    const [role] = await tx.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (role?.status !== "closed") return null;
    return { role, held: await heldEmailsFor(tx, container, companyId, roleId) };
  });
  if (!found?.held.length) return { addedToTalentPool: 0, failed: 0 };
  const { replayed, failed } = await admitHeldEmails(container, { companyId, roleId, held: found.held, intoTalentPool: true });
  await withTenant(container.db, companyId, async (tx) => {
    const one = replayed === 1;
    const title = replayed ? `${one ? "A held email application" : `${replayed} held email applications`} for ${found.role.title} ${one ? "is" : "are"} in your talent pool` : `Held email applications for ${found.role.title} need a look`;
    const added = replayed ? `${found.role.title} was closed while ${one ? "an application that arrived by email was" : `${replayed} applications that arrived by email were`} waiting for applications to reopen. ${one ? "It was" : "They were"} added to the role and moved to your talent pool, with the role's other candidates who were still in process, so you can consider ${one ? "them" : "those people"} for a later opening. Nobody was sent a message saying the role is still hiring.` : `${found.role.title} was closed while applications that arrived by email were waiting.`;
    const trouble = failed ? ` ${failed === 1 ? "One email" : `${failed} emails`} could not be read as an application and ${failed === 1 ? "is" : "are"} kept for a person to look at.` : "";
    const notice = { title, body: added + trouble };
    const unread = await unreadHeldNotices(tx, companyId, roleId);
    if (unread.length) await tx.update(notifications).set(notice).where(inArray(notifications.id, unread));
    else await notify(tx, { companyId, kind: HELD_EMAIL_NOTIFICATION_KIND, ...notice, action: { label: "Open the talent pool", href: "/talent" } });
  });
  await container.kick();
  return { addedToTalentPool: replayed, failed };
}

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
  // The receipt is claimed in the same transaction as the handling: if the handling fails, the claim rolls back with it,
  // the answer is an error, and Postmark's redelivery is processed (an unsubscribe is never lost to a duplicate answer).
  const outcome = await withPlatform(container.db, async (tx) => {
    if (!(await claimWebhookReceipt(tx, { provider: "postmark", kind: event.recordType, externalId: event.externalId }))) return null;
    // A subscription change (H10) is a suppression to honour or a reactivation to acknowledge, never a bounce to retry.
    return event.recordType === "SubscriptionChange"
      ? handleSubscriptionChange(tx, { event, now: container.engine.clock() })
      : handleEmailEvent(tx, container.integrations, { event, appBaseUrl: container.env.JOBS_BASE_URL, now: container.engine.clock() });
  });
  if (!outcome) return c.json({ ok: true, duplicate: true });
  await container.kick();
  return c.json({ ok: true, duplicate: false, ...outcome });
}
postmarkWebhook.post("/bounces", handleDeliveryEvent);
postmarkWebhook.post("/spam", handleDeliveryEvent);
postmarkWebhook.post("/events", handleDeliveryEvent);

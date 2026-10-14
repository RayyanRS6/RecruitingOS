import type { Actor } from "@ros/contracts";
import { markConfirmationSent, type DataRequestRow } from "@ros/core";
import { withPlatform, type Db, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";
import { queueCommunication } from "./outbox";

/**
 * Plain-language acknowledgment and completion messages for privacy requests, sent from the dedicated privacy address
 * (correction 7). Recorded as communications and sent through the outbox; never carries another person's data.
 */
const KIND_TEXT: Record<string, string> = {
  access: "a copy of the information we hold about you",
  correct: "a correction to your information",
  delete: "deletion of your information",
  sms_opt_out: "no more text messages",
  human_review: "a person to review your application",
  withdrawal: "withdrawal of your application",
};

export async function sendPrivacyAcknowledgment(q: Queryable, integrations: Integrations, input: { row: DataRequestRow; companyName: string; privacyEmail: string; actor: Actor }): Promise<void> {
  const { row } = input;
  const due = new Date(row.slaDueAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const text = `Hello,

We received your request for ${KIND_TEXT[row.kind] ?? row.kind} regarding your application with ${input.companyName}.

${row.verificationStatus === "verified_by_link" ? (row.channel === "email_form" ? "Because you confirmed this request from your email address, no further verification is needed." : "Because it came through your own status link, no further verification is needed.") : `To protect your information we will confirm it came from you before acting; reply from the address you applied with if you have not already.`}
We will complete it by ${due} and confirm when it is done. Reference: ${row.id.slice(0, 8)}.

Questions? Write to ${input.privacyEmail}.

Identified Talent Solutions, on behalf of ${input.companyName}`;
  await queueCommunication(q, integrations, { channel: "email", companyId: row.companyId, candidateId: row.candidateId ?? null, applicationId: row.applicationId ?? null, to: row.requesterEmail, from: `${input.companyName} privacy requests <${integrations.env.fromAddress}>`, replyTo: input.privacyEmail, subject: `We received your request (${row.id.slice(0, 8)})`, text, templateKey: "privacy_ack", idempotencyKey: `privacy_ack:${row.id}`, tags: { template: "privacy_ack" }, actor: input.actor });
}

type CompletionInput = { row: DataRequestRow; companyName: string; privacyEmail: string; actor: Actor; attachment?: { filename: string; contentType: string; contentBase64: string } };

/** The completion message's words, the same whichever way it is sent. */
function completionMessage(integrations: Integrations, input: CompletionInput): { from: string; subject: string; text: string } {
  const { row } = input;
  const what = row.status === "declined" ? `We could not fulfil your request for ${KIND_TEXT[row.kind] ?? row.kind}. ${row.resolution ?? ""}` : `Your request for ${KIND_TEXT[row.kind] ?? row.kind} is complete. ${row.resolution ?? ""}`;
  const text = `Hello,

${what}

${row.kind === "access" && input.attachment ? "Your information is attached as a file you can open in any text editor." : ""}
${row.kind === "delete" && row.status === "fulfilled" ? "Where a legal retention duty applies, we kept the record of the application's stages without your identity; everything that identified you has been removed." : ""}

Reference: ${row.id.slice(0, 8)}. Questions? Write to ${input.privacyEmail}.

Identified Talent Solutions, on behalf of ${input.companyName}`.replace(/\n{3,}/g, "\n\n");
  const from = `${input.companyName} privacy requests <${integrations.env.fromAddress}>`;
  const subject = `${row.status === "declined" ? "About your request" : "Your request is complete"} (${row.id.slice(0, 8)})`;
  return { from, subject, text };
}

/**
 * The answer to a deletion request, sent directly (an administrator's action, outside any candidate workflow): the one
 * message that must leave no row behind, since after a deletion nothing may still name the person. A duplicate is at
 * worst a second courtesy note. The confirmation is recorded only when the provider took the message.
 */
async function sendDeletionAnswer(integrations: Integrations, input: CompletionInput): Promise<boolean> {
  const { row } = input;
  const { from, subject, text } = completionMessage(integrations, input);
  const sent = await integrations.email.send({ to: row.requesterEmail, from, replyTo: input.privacyEmail, subject, text, idempotencyKey: `privacy_done:${row.id}`, tags: { template: "privacy_done" } });
  return sent.status === "sent";
}

/**
 * The completion message for a request. For a deletion request it is sent straight away; a caller fulfilling a deletion
 * inside a transaction uses `sendDeletionConfirmation` after the commit instead, so nobody is told their data was deleted
 * by a deletion that then rolled back.
 */
export async function sendPrivacyCompletion(q: Queryable, integrations: Integrations, input: CompletionInput): Promise<void> {
  const { row } = input;
  if (row.kind === "delete") {
    if (await sendDeletionAnswer(integrations, input)) await markConfirmationSent(q, row);
    return;
  }
  const { from, subject, text } = completionMessage(integrations, input);
  await queueCommunication(q, integrations, { channel: "email", companyId: row.companyId, candidateId: row.candidateId ?? null, applicationId: row.applicationId ?? null, to: row.requesterEmail, from, replyTo: input.privacyEmail, subject, text, templateKey: "privacy_done", idempotencyKey: `privacy_done:${row.id}`, tags: { template: "privacy_done" }, attachments: input.attachment ? [input.attachment] : null, actor: input.actor });
  await markConfirmationSent(q, row);
}

/**
 * "Your data was deleted" (or "we could not delete it"), sent only once the transaction that fulfilled or declined the
 * deletion request has committed. No transaction is held while the provider is asked; the confirmation is then recorded
 * in its own short one when the provider took the message. Returns whether it was sent; a failure is left to the
 * administrator, who sees no confirmation on the request.
 */
export async function sendDeletionConfirmation(db: Db, integrations: Integrations, input: CompletionInput): Promise<boolean> {
  if (!(await sendDeletionAnswer(integrations, input))) return false;
  await withPlatform(db, (q) => markConfirmationSent(q, input.row));
  return true;
}

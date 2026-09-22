import type { Actor } from "@ros/contracts";
import { markConfirmationSent, type DataRequestRow } from "@ros/core";
import { communications, type Queryable } from "@ros/db";
import type { Integrations } from "@ros/integrations";

/**
 * Plain-language acknowledgment and completion messages for privacy requests, sent from the dedicated privacy address
 * (correction 7). Recorded as communications when a candidate record exists; never carries another person's data.
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

${row.verificationStatus === "verified_by_link" ? "Because it came through your own status link, no further verification is needed." : `To protect your information we will confirm it came from you before acting; reply from the address you applied with if you have not already.`}
We will complete it by ${due} and confirm when it is done. Reference: ${row.id.slice(0, 8)}.

Questions? Write to ${input.privacyEmail}.

Identified Talent Solutions, on behalf of ${input.companyName}`;
  const result = await integrations.email.send({ to: row.requesterEmail, from: `${input.companyName} privacy requests <${integrations.env.fromAddress}>`, replyTo: input.privacyEmail, subject: `We received your request (${row.id.slice(0, 8)})`, text, idempotencyKey: `privacy_ack:${row.id}`, tags: { template: "privacy_ack" } });
  if (row.candidateId) await q.insert(communications).values({ companyId: row.companyId, candidateId: row.candidateId, applicationId: row.applicationId, direction: "outbound", channel: "email", fromAddress: integrations.env.fromAddress, toAddress: row.requesterEmail, subject: `We received your request (${row.id.slice(0, 8)})`, bodyText: text, templateKey: "privacy_ack", provider: integrations.email.id, providerMessageId: result.status === "sent" ? result.providerMessageId : null, status: result.status === "sent" ? "sent" : result.status === "pending" ? "queued" : "failed", disclosureIncluded: false, sentBy: input.actor });
}

export async function sendPrivacyCompletion(q: Queryable, integrations: Integrations, input: { row: DataRequestRow; companyName: string; privacyEmail: string; actor: Actor; attachment?: { filename: string; contentType: string; contentBase64: string } }): Promise<void> {
  const { row } = input;
  const what = row.status === "declined" ? `We could not fulfil your request for ${KIND_TEXT[row.kind] ?? row.kind}. ${row.resolution ?? ""}` : `Your request for ${KIND_TEXT[row.kind] ?? row.kind} is complete. ${row.resolution ?? ""}`;
  const text = `Hello,

${what}

${row.kind === "access" && input.attachment ? "Your information is attached as a file you can open in any text editor." : ""}
${row.kind === "delete" && row.status === "fulfilled" ? "Where a legal retention duty applies, we kept the record of the application's stages without your identity; everything that identified you has been removed." : ""}

Reference: ${row.id.slice(0, 8)}. Questions? Write to ${input.privacyEmail}.

Identified Talent Solutions, on behalf of ${input.companyName}`.replace(/\n{3,}/g, "\n\n");
  const result = await integrations.email.send({ to: row.requesterEmail, from: `${input.companyName} privacy requests <${integrations.env.fromAddress}>`, replyTo: input.privacyEmail, subject: `${row.status === "declined" ? "About your request" : "Your request is complete"} (${row.id.slice(0, 8)})`, text, idempotencyKey: `privacy_done:${row.id}`, tags: { template: "privacy_done" }, attachments: input.attachment ? [input.attachment] : undefined });
  if (row.candidateId && row.kind !== "delete") await q.insert(communications).values({ companyId: row.companyId, candidateId: row.candidateId, applicationId: row.applicationId, direction: "outbound", channel: "email", fromAddress: integrations.env.fromAddress, toAddress: row.requesterEmail, subject: `Your request (${row.id.slice(0, 8)})`, bodyText: text, templateKey: "privacy_done", provider: integrations.email.id, providerMessageId: result.status === "sent" ? result.providerMessageId : null, status: result.status === "sent" ? "sent" : result.status === "pending" ? "queued" : "failed", disclosureIncluded: false, sentBy: input.actor });
  await markConfirmationSent(q, row);
}

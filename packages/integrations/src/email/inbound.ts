import type { InboundEmail } from "../types";

/**
 * Normalizes Postmark's inbound webhook JSON into InboundEmail. Other providers can be added
 * with their own normalizer; the application workflow only sees InboundEmail.
 */
export function parsePostmarkInbound(payload: Record<string, unknown>): InboundEmail {
  const str = (k: string) => (typeof payload[k] === "string" ? (payload[k] as string) : "");
  const attachments = Array.isArray(payload.Attachments)
    ? (payload.Attachments as Array<Record<string, unknown>>).map((a) => ({
        filename: String(a.Name ?? "attachment"),
        contentType: String(a.ContentType ?? "application/octet-stream"),
        contentBase64: String(a.Content ?? ""),
        sizeBytes: Number(a.ContentLength ?? 0),
      }))
    : [];
  return {
    to: (str("OriginalRecipient") || str("To")).toLowerCase(),
    from: str("From").toLowerCase(),
    fromName: str("FromName") || undefined,
    subject: str("Subject"),
    text: str("TextBody") || str("StrippedTextReply"),
    html: str("HtmlBody") || undefined,
    attachments,
    messageId: str("MessageID") || undefined,
    receivedAt: str("Date") ? new Date(str("Date")).toISOString() : new Date().toISOString(),
  };
}

/** Intake addresses look like `apply-<token>@<intake domain>`. Returns the token or null. */
export function extractIntakeToken(toAddress: string, intakeDomain: string): string | null {
  const addr = toAddress.toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1").trim();
  const m = addr.match(/^apply-([a-z0-9_-]+)@(.+)$/i);
  if (!m) return null;
  if (m[2] !== intakeDomain.toLowerCase()) return null;
  return m[1];
}

export function intakeAddress(token: string, intakeDomain: string): string {
  return `apply-${token}@${intakeDomain}`;
}

/**
 * Indeed-hosted applications arrive as emails with the candidate's name in the subject or body and the
 * resume attached. This extracts the best-effort name and email; the workflow asks the candidate for
 * anything missing rather than guessing.
 */
export function extractApplicantFromInbound(mail: InboundEmail): { firstName: string; lastName: string; email: string | null; phone: string | null; note: string } {
  const text = mail.text ?? "";
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const phoneMatch = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  let name = mail.fromName ?? "";
  const subj = mail.subject ?? "";
  const subjName = subj.match(/(?:application from|new applicant:?|applied:?)\s*([A-Za-z']+(?:\s[A-Za-z']+){0,3})/i);
  if (subjName) name = subjName[1].trim();
  const bodyName = text.match(/(?:name|applicant)\s*[:\-]\s*([A-Za-z' -]{3,60})/i);
  if (!name && bodyName) name = bodyName[1].trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? "Applicant";
  const lastName = parts.slice(1).join(" ") || "(from email)";
  const candidateEmail = emailMatch && !emailMatch[0].toLowerCase().includes("indeed.com") ? emailMatch[0].toLowerCase() : null;
  return { firstName, lastName, email: candidateEmail ?? (mail.from.includes("indeed") ? null : mail.from), phone: phoneMatch?.[0] ?? null, note: `Received by email from ${mail.from}: ${subj}` };
}

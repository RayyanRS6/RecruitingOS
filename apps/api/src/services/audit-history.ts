import type { auditRecords } from "@ros/db";

/**
 * The customer's own audit history (audit finding A9): what a company's team may see of the audit ledger, in plain
 * words. Only actions that concern the customer are listed; privacy-request handling, sign-in refusals and the
 * platform's own housekeeping stay with ITS. Details are passed through minus anything that names a credential.
 */
export const CUSTOMER_AUDIT_ACTIONS: readonly string[] = [
  // ITS staff access
  "staff.access_granted", "staff.access_ended", "staff.access_revoked", "staff.tenant_accessed", "admin.break_glass",
  // the team
  "membership.changed", "invitation.sent", "invitation.resent", "invitation.revoked", "invitation.accepted", "session.revoked", "session.reauthenticated",
  // the rules and the company
  "policy.changed", "notice.changed", "company.updated", "company.verified", "company.unverified",
  // candidates, outcomes and exports
  "candidate.viewed", "candidate.exported", "outcome.recorded", "outcome.corrected", "role.outcome_recorded",
  "export.created", "report.exported", "audit.exported",
];

export type AuditRow = typeof auditRecords.$inferSelect;
export type CustomerAuditRow = { id: string; action: string; description: string; actor: { kind: string; name: string | null }; reason: string | null; target: { type: string; id: string } | null; at: string; details: Record<string, unknown> };

const SECRET_KEY = /token|hash|secret|password|credential/i;

function scrub(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details ?? {})) if (!SECRET_KEY.test(k)) out[k] = v;
  return out;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const NOTICE_WORDS: Record<string, string> = { ai_use: "the AI-use notice", privacy: "the privacy notice", sms_consent: "the text-message consent", recording: "the recording notice", pay_transparency: "the pay-range notice", adverse_decision_explanation: "the decision-review notice" };
const OUTCOME_WORDS: Record<string, string> = { hired_externally: "hired", candidate_withdrew: "the candidate withdrew", employer_declined: "declined by you", offer_declined_externally: "the candidate declined the offer", no_hire: "no hire", filled: "filled", filled_outside_platform: "filled outside the platform", role_cancelled: "cancelled", voided: "voided" };

/** One sentence an owner understands without knowing the action names. */
export function describeAuditRecord(r: Pick<AuditRow, "action" | "actor" | "reason" | "details" | "target">): string {
  const d = (r.details ?? {}) as Record<string, unknown>;
  const who = r.actor.name ?? (r.actor.kind === "system" ? "the system" : r.actor.kind === "recruiter" ? "an ITS recruiter" : r.actor.kind === "agent" ? "the AI assistant" : "someone");
  switch (r.action) {
    case "staff.access_granted": return `An ITS recruiter was given access${str(d.kind) ? ` (${str(d.kind)})` : ""}${r.reason ? `: ${r.reason}` : ""}.`;
    case "staff.access_ended": return "A recruiter's access ended.";
    case "staff.access_revoked": return `${who} ended a recruiter's access${r.reason ? `: ${r.reason}` : ""}.`;
    case "staff.tenant_accessed": return `${who} opened ${str(d.method) ?? ""} ${str(d.path) ?? "a page"} under their access.`.replace(/\s+/g, " ");
    case "admin.break_glass": return `An ITS administrator used emergency access${r.reason ? `: ${r.reason}` : ""}.`;
    case "membership.changed": return `${who} ${r.reason ?? "changed a team member"}.`;
    case "invitation.sent": return `${who} invited ${str(d.email) ?? "someone"} as ${roleWords(str(d.role))}.`;
    case "invitation.resent": return `${who} sent the invitation to ${str(d.email) ?? "someone"} again.`;
    case "invitation.revoked": return `${who} withdrew the invitation to ${str(d.email) ?? "someone"}.`;
    case "invitation.accepted": return `${str(d.email) ?? who} joined the team as ${roleWords(str(d.role))}.`;
    case "session.revoked": return `${who} signed ${num(d.sessionsEnded) === 1 ? "a session" : `${num(d.sessionsEnded) ?? "some"} sessions`} out${r.reason ? ` (${r.reason})` : ""}.`;
    case "session.reauthenticated": return `${who} confirmed their identity before a sensitive change.`;
    case "policy.changed": return `${who} changed what the AI may do on its own${r.reason ? `: ${r.reason}` : ""}.`;
    case "notice.changed": return `${who} ${str(d.version) ? "reworded" : "restored the standard text of"} ${NOTICE_WORDS[str(d.key) ?? ""] ?? "a candidate notice"}${str(d.version) ? ` (version ${str(d.version)})` : ""}.`;
    case "company.updated": return `${who} changed the company details${Array.isArray(d.fields) && d.fields.length ? ` (${(d.fields as unknown[]).map(fieldWords).join(", ")})` : ""}.`;
    case "company.verified": return r.actor.kind === "system" ? "The company was confirmed automatically (no ITS check is needed in this environment)." : `ITS confirmed your company${num(d.released) ? `; ${num(d.released)} waiting ${num(d.released) === 1 ? "message" : "messages"} to candidates went out` : ""}.`;
    case "company.unverified": return "ITS took back its confirmation of your company: your careers page and job pages are offline and messages to candidates wait until ITS confirms it again.";
    case "candidate.viewed": return `${who} opened a candidate's record${r.reason ? ` (${r.reason})` : ""}.`;
    case "candidate.exported": return `${who} exported a candidate's information.`;
    case "outcome.recorded": return `${who} recorded an outcome: ${OUTCOME_WORDS[str(d.outcome) ?? ""] ?? str(d.outcome) ?? "recorded"}.`;
    case "outcome.corrected": return `${who} corrected a recorded outcome${r.reason ? `: ${r.reason}` : ""}.`;
    case "role.outcome_recorded": return `${who} closed a role: ${OUTCOME_WORDS[str(d.outcome) ?? ""] ?? str(d.outcome) ?? "closed"}.`;
    case "export.created": return `${who} exported data.`;
    case "report.exported": return `${who} downloaded the ${str(d.kind) === "summary" ? "role report summary" : "applicant list"} for a role${num(d.rows) !== null ? ` (${num(d.rows)} rows)` : ""}.`;
    case "audit.exported": return `${who} downloaded this history${num(d.rows) !== null ? ` (${num(d.rows)} rows)` : ""}.`;
    default: return `${who}: ${r.action.replace(/[._]/g, " ")}${r.reason ? ` (${r.reason})` : ""}.`;
  }
}

function roleWords(role: string | null): string {
  return ({ owner: "an owner", admin: "an admin", hiring_manager: "a hiring manager", interviewer: "an interviewer", hr: "HR" } as Record<string, string>)[role ?? ""] ?? "a team member";
}

function fieldWords(f: unknown): string {
  return ({ name: "name", website: "website", timezone: "time zone", sizeBand: "size", locations: "locations", logoUrl: "logo", benefitsSummary: "benefits summary", careersPage: "careers page intro", businessHours: "contact hours", notices: "candidate notices", about: "the text about the company on job pages", aboutDraft: "a draft of the text about the company", logo: "logo", hiringContact: "the contact candidates can reach before applying", boardPosting: "who posts the jobs on the job boards", zipRecruiterPlan: "the company's own ZipRecruiter plan", aiRulesReviewed: "the AI rules marked as reviewed", jobBoardAccess: "job-board access, confirmed by ITS", jobBoardAccessRemoved: "job-board access, no longer confirmed by ITS" } as Record<string, string>)[String(f)] ?? String(f);
}

/** A timestamp as ISO 8601 whatever the driver returned (Postgres writes "2026-09-30 16:05:10.123+00"). */
export function isoTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  const fixed = Date.parse(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(fixed) ? new Date(fixed).toISOString() : value;
}

export function customerAuditRow(r: AuditRow): CustomerAuditRow {
  return { id: r.id, action: r.action, description: describeAuditRecord(r), actor: { kind: r.actor.kind, name: r.actor.name ?? null }, reason: r.reason, target: r.target ? { type: r.target.type, id: r.target.id } : null, at: isoTime(r.createdAt), details: scrub(r.details) };
}

/** The history as a spreadsheet: one row per record, quoted so a description with a comma stays in its cell. */
export function auditCsv(rows: CustomerAuditRow[]): string {
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    // a cell that starts with a formula character is prefixed so spreadsheets do not evaluate it
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, "\"\"")}"`;
  };
  const lines = [["when", "what", "who", "reason", "action", "target type", "target id"].map(cell).join(",")];
  for (const r of rows) lines.push([r.at, r.description, r.actor.name ?? r.actor.kind, r.reason ?? "", r.action, r.target?.type ?? "", r.target?.id ?? ""].map(cell).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

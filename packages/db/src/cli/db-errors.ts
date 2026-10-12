/**
 * Turns a driver error into a plain diagnosis for the person at the keyboard. Never includes the connection string,
 * the password, or the raw error object; the code and a short message are enough to act on.
 */
export type ConnectionDiagnosis = { kind: "tls" | "auth" | "pooler" | "network" | "permission" | "database" | "unknown"; code: string | null; summary: string; advice: string };

const TLS_CODES = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "CERT_UNTRUSTED", "ERR_SSL_WRONG_VERSION_NUMBER"]);
const NETWORK_CODES = new Set(["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "EAI_AGAIN", "EPIPE"]);

/** A driver message can quote the connection string it was given; nothing that looks like one, or like a password, survives. */
function scrub(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, "[connection string]").replace(/(password|pwd)(\s*[=:]\s*)\S+/gi, "$1$2[redacted]");
}

export function diagnoseConnectionError(err: unknown): ConnectionDiagnosis {
  const e = (err ?? {}) as { code?: string; message?: string; routine?: string };
  const code = typeof e.code === "string" ? e.code : null;
  const message = scrub(typeof e.message === "string" ? e.message : String(err ?? ""));
  if (code && TLS_CODES.has(code)) {
    return { kind: "tls", code, summary: "this computer does not trust the database server's certificate", advice: "Download the CA certificate from Supabase (Project Settings, Database, SSL certificate), then run again with DATABASE_SSL_CA_FILE=/path/to/the.crt in front of the command, or add sslrootcert=/path/to/the.crt to the connection string. Do not switch verification off." };
  }
  if (code === "28P01" || code === "28000" || /password authentication failed/i.test(message)) {
    return { kind: "auth", code, summary: "the database refused the user name or password", advice: "Check the database password in the vault and paste the pooler connection string again exactly as Supabase shows it (user postgres.<project-ref>)." };
  }
  if (/tenant or user not found/i.test(message)) {
    return { kind: "pooler", code, summary: "the connection pooler does not recognise this user", advice: "The user must be <role>.<project-ref> on a pooler host, and the role must exist with LOGIN. For the application roles, run the setup (full mode) so their passwords are set; for the owner, check the project reference in the string." };
  }
  if (/server does not support ssl|ssl is required|no pg_hba.conf entry/i.test(message)) {
    return { kind: "tls", code, summary: "the server and this connection disagree about TLS", advice: "Keep sslmode=verify-full (the default the tools add). If Supabase's SSL enforcement is on, every connection must use TLS." };
  }
  if (code && NETWORK_CODES.has(code)) {
    return { kind: "network", code, summary: "the database host could not be reached", advice: "Check the host and port in the pooler string, your network, and whether the Supabase project is paused (Dashboard, Project). Try again in a minute." };
  }
  if (code === "42501" || /permission denied|must be owner|must have admin option/i.test(message)) {
    return { kind: "permission", code, summary: "the connected user lacks a privilege the step needs", advice: "Run the setup with the project owner's pooler string (user postgres.<project-ref>), not an application role." };
  }
  if (code === "3D000") {
    return { kind: "database", code, summary: "the database named in the string does not exist", advice: "Use the string exactly as Supabase shows it (database postgres)." };
  }
  // EMAXCONNSESSION is Supavisor's refusal once a role's 15 Session pooler connections are all open (12 Oct 2026).
  if (code === "53300" || /too many (clients|connections)|max client connections|EMAXCONN|max clients reached/i.test(message)) {
    return { kind: "pooler", code, summary: "the pooler has no free connection right now", advice: "Wait a minute and run again; close other database clients first." };
  }
  // node-postgres's own messages when createDb's 10-second connect timeout runs out (migrate, seed, status, and the app
  // itself). The pooler can hold a client it has no room for for up to a minute before refusing it, so a full pooler can
  // show up as one of these instead.
  if (/connection terminated due to connection timeout|timeout exceeded when trying to connect/i.test(message)) {
    return { kind: "pooler", code, summary: "no database connection was handed out within 10 seconds", advice: "The pooler is most likely full: wait a minute and run again, and close other database clients first. If it keeps happening, check the host and port in the string and whether the Supabase project is paused." };
  }
  return { kind: "unknown", code, summary: message.split("\n")[0]!.slice(0, 200), advice: "Paste the code and this line back; nothing sensitive is in it." };
}

/** One line for the terminal. */
export function describeConnectionError(err: unknown): string {
  const d = diagnoseConnectionError(err);
  return `${d.summary}${d.code ? ` (${d.code})` : ""}. ${d.advice}`;
}

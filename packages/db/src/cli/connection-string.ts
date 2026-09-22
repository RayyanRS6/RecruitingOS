/**
 * Completes a Supabase connection string whose password is still the dashboard placeholder.
 *
 * The founder pastes the Session pooler string exactly as Supabase shows it, with `[YOUR-PASSWORD]` in it, and types
 * the password separately. This module puts the two together: the password is percent-encoded the way Postgres
 * clients expect (every byte outside the RFC 3986 unreserved set becomes `%XX`, so `@`, `:`, `/`, `?`, `#`, `%`, `&`,
 * `+`, spaces and non-ASCII characters can all be in a password), and only the one exact placeholder is replaced.
 * A string with no placeholder, or with more than one, is refused rather than guessed at. Nothing here logs.
 */

export const PASSWORD_PLACEHOLDER = "[YOUR-PASSWORD]";

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Percent-encodes every byte of the password except RFC 3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`). */
export function percentEncodePassword(password: string): string {
  let out = "";
  for (const byte of Buffer.from(password, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** How many times the exact placeholder appears; case-sensitive, no pattern matching. */
export function countPlaceholders(uri: string): number {
  let count = 0;
  for (let at = uri.indexOf(PASSWORD_PLACEHOLDER); at !== -1; at = uri.indexOf(PASSWORD_PLACEHOLDER, at + PASSWORD_PLACEHOLDER.length)) count++;
  return count;
}

export class ConnectionStringError extends Error {}

/**
 * Returns the connection string with the single `[YOUR-PASSWORD]` replaced by the percent-encoded password.
 * Throws when the string is not a Postgres URL, when the placeholder is missing or repeated, or when the password is
 * empty. Error messages never carry the string or the password.
 */
export function fillPassword(uri: string, password: string): string {
  const trimmed = uri.trim();
  if (!/^postgres(ql)?:\/\//.test(trimmed)) throw new ConnectionStringError("The connection string must start with postgresql:// or postgres://.");
  const count = countPlaceholders(trimmed);
  if (count !== 1) throw new ConnectionStringError(`The connection string must contain ${PASSWORD_PLACEHOLDER} exactly once (found ${count}). Copy it again from Supabase without filling in the password.`);
  if (password.length === 0) throw new ConnectionStringError("The password was empty.");
  const at = trimmed.indexOf(PASSWORD_PLACEHOLDER);
  const filled = trimmed.slice(0, at) + percentEncodePassword(password) + trimmed.slice(at + PASSWORD_PLACEHOLDER.length);
  let parsed: URL;
  try {
    parsed = new URL(filled);
  } catch {
    throw new ConnectionStringError("The completed connection string is not a valid URL. Copy it again from Supabase.");
  }
  if (!parsed.hostname || !parsed.username) throw new ConnectionStringError("The connection string is missing its user or host. Copy it again from Supabase.");
  return filled;
}

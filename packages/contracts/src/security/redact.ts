/**
 * What counts as a secret, and how to remove it from anything that leaves the process (founder decision I-series and
 * correction 10 of 18 September 2026: tokens must never appear in logs, errors, analytics, audit records, support
 * messages, screenshots, or documentation). Pure functions; the runtime registry of values actually read from the
 * secret store lives in @ros/core and is passed in as `values`.
 */

export const REDACTED = "[redacted]";

/** Keys whose string values are redacted wherever they appear (broad, used when scrubbing). */
export const SECRET_KEY_PATTERN = /^(access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|authorization|password|passwd|secret|private[_-]?key|signing[_-]?key|session[_-]?token|bearer|credentials?|service[_-]?role[_-]?key|webhook[_-]?secret)$/i;
/** Keys that prove a leak on their own (strict, used when deciding whether something is a leak). */
export const STRONG_SECRET_KEY_PATTERN = /^(access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|apikey|password|passwd|private[_-]?key|service[_-]?role[_-]?key|webhook[_-]?secret)$/i;

/** Value shapes that are secrets regardless of the key they sit under. */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  /ya29\.[A-Za-z0-9\-_.]{20,}/g, // Google access tokens
  /1\/\/[A-Za-z0-9\-_]{20,}/g, // Google refresh tokens
  /\b[Ee]y[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g,
  /\bsk-(?:ant-)?[A-Za-z0-9\-_]{16,}/g, // Anthropic and similar API keys
  /\bphx_[A-Za-z0-9]{16,}/g, // PostHog personal keys
  /\bAC[a-f0-9]{32}\b(?=.*(?:auth|token))/gi, // Twilio SIDs only when paired with a token in the same text
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /(?<=\/c\/(?:status|screen|schedule|confirm-answers)\/)[A-Za-z0-9_-]{20,}/g, // candidate link tokens in paths (21 Sep, item 3; the repeat-confirmation link, known-bugs row 80): the path stays, the token goes
  /(?<=\/c\/privacy-request\/verify\/)[A-Za-z0-9._-]{20,}/g, // the privacy-request confirmation link (a sealed token with dots), same rule
  /(?:^|[?&;\s])(access_token|refresh_token|client_secret|id_token|api_key|apikey|password|client_id_secret|token|secret|code|email|phone)=([^&\s"']+)/gi, // query strings (a person's address or number is not for logs either)
  /("(?:access_token|refresh_token|client_secret|id_token|api_key|apikey|password|authorization|private_key)"\s*:\s*")([^"]*)(")/gi, // JSON text
];

/** Removes known secret shapes and every supplied value from a string. */
export function redactText(text: string, values: Iterable<string> = []): string {
  let out = text;
  for (const v of values) if (v && v.length >= 8) out = out.split(v).join(REDACTED);
  for (const re of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, (match: string, ...groups: unknown[]) => {
      if (re.source.startsWith("(?:^|[?&;")) return String(match).replace(String(groups[1]), REDACTED);
      if (re.source.startsWith('("(?:')) return `${groups[0]}${REDACTED}${groups[2]}`;
      return REDACTED;
    });
  }
  return out;
}

/** Deep-copies a value with secret keys and secret-shaped strings replaced. Never throws. */
export function redactObject<T>(value: T, values: Iterable<string> = [], depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return redactText(value, values) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, values, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    if (value instanceof Error) return { name: value.name, message: redactText(value.message, values), stack: value.stack ? redactText(value.stack, values) : undefined } as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) && typeof v === "string" && v.length > 0 ? REDACTED : redactObject(v, values, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** True when the value carries any supplied secret value or a secret-shaped string or key. */
export function containsSecret(value: unknown, values: Iterable<string> = []): boolean {
  let text: string;
  try { text = typeof value === "string" ? value : JSON.stringify(value) ?? ""; } catch { return false; }
  for (const v of values) if (v && v.length >= 8 && text.includes(v)) return true;
  for (const re of SECRET_VALUE_PATTERNS) { re.lastIndex = 0; if (re.test(text)) { re.lastIndex = 0; return true; } }
  const keyHit = (x: unknown, depth = 0): boolean => {
    if (depth > 12 || !x || typeof x !== "object") return false;
    if (Array.isArray(x)) return x.some((v) => keyHit(v, depth + 1));
    return Object.entries(x as Record<string, unknown>).some(([k, v]) => (STRONG_SECRET_KEY_PATTERN.test(k) && typeof v === "string" && v.length > 0) || keyHit(v, depth + 1));
  };
  return keyHit(value);
}

/** A short, stable, non-reversible handle for a secret reference, safe to put in an audit record. */
export function fingerprint(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) { h ^= input.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `fp_${h.toString(16).padStart(8, "0")}`;
}

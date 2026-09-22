/** Normalization used for candidate deduplication. Email first; phone if there is no email. */

export function normalizeEmailForDedupe(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return null;
  const [local, domain] = e.split("@");
  // Gmail ignores dots and plus-suffixes; other providers vary, so only strip the plus part generally.
  const plusStripped = local.split("+")[0];
  const normalizedLocal = domain === "gmail.com" || domain === "googlemail.com" ? plusStripped.replace(/\./g, "") : plusStripped;
  return `${normalizedLocal}@${domain === "googlemail.com" ? "gmail.com" : domain}`;
}

export function normalizePhone(phone: string | null | undefined, defaultCountry = "1"): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (digits.length === 10) return `+${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

export function dedupeKey(email: string | null | undefined, phone: string | null | undefined): string | null {
  const e = normalizeEmailForDedupe(email);
  if (e) return `email:${e}`;
  const p = normalizePhone(phone);
  if (p) return `phone:${p}`;
  return null;
}

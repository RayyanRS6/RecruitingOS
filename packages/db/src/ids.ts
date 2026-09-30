import { randomBytes } from "node:crypto";

/**
 * UUID v7: time-ordered, so primary keys index well and sort by creation.
 * Layout: 48-bit unix ms | 4-bit version (7) | 12-bit random | 2-bit variant | 62-bit random.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** URL-safe random token for magic links, candidate links, intake addresses. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

const LOWERCASE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A random token of lowercase letters and digits only, for tokens that travel in the local part of an email address
 * (a mail server may lowercase an address, so a case-sensitive token would stop matching). 16 characters give about
 * 82 bits; the draw is unbiased because 256 is reduced to the alphabet's size before use.
 */
export function lowercaseToken(length = 16): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 252) continue; // 252 is the largest multiple of 36 below 256; anything above it would skew the draw
      out.push(LOWERCASE_ALPHABET[byte % LOWERCASE_ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

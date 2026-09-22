import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226), dependency-free. The managed identity service checks codes in
 * production; this module lets the fake issuer behave exactly like it, and lets tests and rehearsals compute the code an
 * authenticator app would show for a secret. Defaults match every common authenticator: SHA-1, six digits, 30 seconds.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret as an authenticator app expects it (base32, 160 bits by default). */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function hotp(secretBase32: string, counter: number, digits = 6): string {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const offset = h[h.length - 1]! & 0x0f;
  const bin = ((h[offset]! & 0x7f) << 24) | ((h[offset + 1]! & 0xff) << 16) | ((h[offset + 2]! & 0xff) << 8) | (h[offset + 3]! & 0xff);
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secretBase32: string, now: Date = new Date(), period = 30, digits = 6): string {
  return hotp(secretBase32, Math.floor(now.getTime() / 1000 / period), digits);
}

/** Accepts the current step and one step either side (clock drift), comparing in constant time. */
export function verifyTotp(secretBase32: string, code: string, opts: { now?: Date; window?: number; period?: number; digits?: number } = {}): boolean {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const window = opts.window ?? 1;
  const c = code.replace(/\s+/g, "");
  if (!/^\d+$/.test(c) || c.length !== digits) return false;
  const counter = Math.floor((opts.now ?? new Date()).getTime() / 1000 / period);
  let ok = false;
  for (let i = -window; i <= window; i++) {
    if (timingSafeEqual(Buffer.from(hotp(secretBase32, counter + i, digits)), Buffer.from(c))) ok = true;
  }
  return ok;
}

/** The provisioning URI an authenticator app reads from a QR code or by hand. */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  return `otpauth://totp/${issuer}:${encodeURIComponent(input.account)}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

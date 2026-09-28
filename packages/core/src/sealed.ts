import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * A small value that must survive a round trip through the person's browser (an OAuth verifier and state, for
 * example) without the browser being able to read or change it. Encrypted and authenticated with AES-256-GCM under a
 * key derived from SESSION_SECRET and the stated purpose, so a value sealed for one purpose never opens for another.
 * Tampering, a rotated secret, or expiry all read as "nothing there".
 */
export type SealedPayload = { exp: number };

function deriveKey(secret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "recruiting-os", `sealed:${purpose}:v1`, 32));
}

export function sealPayload<T extends SealedPayload>(purpose: string, payload: T, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, purpose), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function openPayload<T extends SealedPayload>(purpose: string, sealed: string | undefined | null, secret: string, now: number = Date.now()): T | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, purpose), Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[3]!, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")), decipher.final()]).toString("utf8");
    const payload = JSON.parse(plain) as T;
    if (!payload || typeof payload !== "object" || typeof payload.exp !== "number" || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

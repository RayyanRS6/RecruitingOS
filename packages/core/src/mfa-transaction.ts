import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The second-factor step of a staff sign-in (D19; founder approval of 22 September 2026). Between the identity
 * service's Microsoft step and the code entry, the person's provider token has to survive one or two more requests.
 * It never touches the database or a log: it rides in the person's own browser inside this sealed transaction, encrypted
 * and authenticated under a key derived from SESSION_SECRET, for ten minutes at most. Tampering, an old key or expiry
 * all read as "no transaction", which sends the person back to sign in.
 */
export type MfaStage = "start" | "enrol" | "verify" | "backup_offer" | "backup_enrol";

export type MfaTransaction = {
  v: 1;
  /** The identity service's access token for this person, at assurance level 1. */
  accessToken: string;
  email: string;
  provider: string;
  subject: string;
  stage: MfaStage;
  /** The factors a code may answer: every verified authenticator at sign-in, or the one being enrolled. */
  factorIds: string[];
  /** Present during enrolment so a refreshed page shows the same secret the person may already have scanned. */
  secret: string | null;
  uri: string | null;
  attempts: number;
  expiresAt: number;
};

export const MFA_TRANSACTION_TTL_MS = 10 * 60_000;
export const MFA_MAX_ATTEMPTS = 5;

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "recruiting-os", "mfa-transaction-v1", 32));
}

export function sealMfaTransaction(tx: MfaTransaction, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(tx), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${ct.toString("base64url")}.${tag.toString("base64url")}`;
}

export function openMfaTransaction(sealed: string | undefined | null, secret: string, now: number = Date.now()): MfaTransaction | null {
  if (!sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(parts[1]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[3]!, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[2]!, "base64url")), decipher.final()]).toString("utf8");
    const tx = JSON.parse(plain) as MfaTransaction;
    if (tx.v !== 1 || typeof tx.accessToken !== "string" || typeof tx.expiresAt !== "number" || tx.expiresAt <= now) return null;
    return tx;
  } catch {
    return null;
  }
}

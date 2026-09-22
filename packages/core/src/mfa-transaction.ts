import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * The second-factor step of a staff sign-in (D19; founder approval of 22 September 2026). Between the identity
 * service's Microsoft step and the code entry, the person's provider token has to survive one or two more requests.
 * It never touches the database or a log: it rides in the person's own browser inside this sealed transaction, encrypted
 * and authenticated under a key derived from SESSION_SECRET, for ten minutes at most. Tampering, an old key or expiry
 * all read as "no transaction", which sends the person back to sign in.
 *
 * The transaction carries no counter a browser could replay: attempts are counted server-side against the random
 * transaction id and against the person (apps/api/src/routes/auth-mfa.tsx).
 */
export type MfaStage = "start" | "enrol" | "verify" | "backup_offer" | "backup_enrol";

export type MfaTransaction = {
  v: 1;
  /** Random id; the server counts code attempts against it, so presenting an older copy of the cookie changes nothing. */
  id: string;
  /** The identity service's access token for this person: level 1 until the code is verified, level 2 during the backup offer. */
  accessToken: string;
  email: string;
  provider: string;
  subject: string;
  stage: MfaStage;
  /** The factors a code may answer: every verified authenticator at sign-in, or the one being enrolled. */
  factorIds: string[];
  /** Present during enrolment so a refreshed page shows the same setup key the person may already have scanned. */
  secret: string | null;
  uri: string | null;
  /** A message for the next page load (post-redirect-get after a wrong code). */
  notice: "wrong" | "last" | null;
  expiresAt: number;
};

export const MFA_TRANSACTION_TTL_MS = 10 * 60_000;
/** Code attempts per transaction (one Microsoft sign-in). */
export const MFA_MAX_ATTEMPTS = 5;
/** Code attempts per person across transactions in the window below: a fresh sign-in does not reset the count. */
export const MFA_PERSON_ATTEMPTS = 12;
export const MFA_PERSON_WINDOW_MS = 15 * 60_000;

export function newMfaTransactionId(): string {
  return randomBytes(16).toString("base64url");
}

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
    if (tx.v !== 1 || typeof tx.id !== "string" || !tx.id || typeof tx.accessToken !== "string" || typeof tx.expiresAt !== "number" || tx.expiresAt <= now) return null;
    return tx;
  } catch {
    return null;
  }
}

import type { AdapterStatus } from "../types";

/** What an identity provider vouches for after verifying a token. Never carries the token itself. */
export type VerifiedIdentity = {
  /** Stable subject at the provider (Supabase user id). */
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  /** The sign-in method the provider recorded: azure (Microsoft), google, email (OTP or magic link), or fake. */
  provider: string;
  /** Authenticator assurance level: aal2 means a second factor was used in this session. */
  aal: "aal1" | "aal2";
  /** Authentication methods with timestamps, e.g. oauth then totp. */
  amr: Array<{ method: string; at: string }>;
  /** When the second factor was verified, if it was. */
  mfaVerifiedAt: string | null;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
};

/** A second factor the identity service holds for a person. The secret never leaves the service after enrolment. */
export type MfaFactor = { id: string; type: string; friendlyName: string | null; status: "verified" | "unverified"; createdAt: string | null };

/** What a fresh authenticator enrolment shows the person once: the secret to scan or type. */
export type TotpEnrolment = { factorId: string; secret: string; uri: string; /** SVG markup of the QR code when the service provides one. */ qrCodeSvg: string | null };

/**
 * Authentication is delegated to a managed identity service (founder decisions F11, D19, correction 4). The API never
 * sees a password; it receives a signed token, verifies it against the issuer's key, applies the sign-in policy, and opens
 * its own session. The PKCE authorization-code flow keeps tokens out of URLs and browser storage.
 *
 * The second factor for ITS staff is an authenticator app enrolled with the same service (22 September 2026). Every
 * factor call carries the person's own access token; the application holds no service key.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly status: AdapterStatus;
  /** Which sign-in methods this deployment offers, in display order. */
  providers(): Array<{ key: string; label: string }>;
  authorizeUrl(input: { provider: string; redirectTo: string; codeChallenge: string; state: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ accessToken: string }>;
  verify(accessToken: string): Promise<VerifiedIdentity>;
  listFactors(accessToken: string): Promise<MfaFactor[]>;
  enrolTotp(accessToken: string, input: { friendlyName: string; issuer: string }): Promise<TotpEnrolment>;
  challengeFactor(accessToken: string, factorId: string): Promise<{ challengeId: string; expiresAt: string }>;
  /** A correct code answers the challenge and returns a new token at assurance level 2. */
  verifyFactor(accessToken: string, input: { factorId: string; challengeId: string; code: string }): Promise<{ accessToken: string }>;
  unenrolFactor(accessToken: string, factorId: string): Promise<void>;
}

export class IdentityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

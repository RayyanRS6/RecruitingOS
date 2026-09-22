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

/**
 * Authentication is delegated to a managed identity service (founder decisions F11, D19, correction 4). The API never
 * sees a password; it receives a signed token, verifies it against the issuer's key, applies the sign-in policy, and opens
 * its own session. The PKCE authorization-code flow keeps tokens out of URLs and browser storage.
 */
export interface IdentityProvider {
  readonly id: string;
  readonly status: AdapterStatus;
  /** Which sign-in methods this deployment offers, in display order. */
  providers(): Array<{ key: string; label: string }>;
  authorizeUrl(input: { provider: string; redirectTo: string; codeChallenge: string; state: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ accessToken: string }>;
  verify(accessToken: string): Promise<VerifiedIdentity>;
}

export class IdentityError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

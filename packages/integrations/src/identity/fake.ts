import { createHash, randomBytes } from "node:crypto";
import { identityFromClaims, PROVIDER_LABELS } from "./claims";
import { base64url, signHs256, verifyJwt } from "./jwt";
import { IdentityError, type IdentityProvider, type VerifiedIdentity } from "./types";

/**
 * Development and tests: an in-process issuer that speaks the same token format and PKCE flow as the managed service,
 * so every sign-in policy (Microsoft for staff, a second factor for staff, verified email) is exercised without an
 * account. Production refuses this provider.
 */
export type FakeMintInput = { email: string; name?: string | null; provider?: "azure" | "google" | "email"; aal?: "aal1" | "aal2"; emailVerified?: boolean; subject?: string; expiresInSeconds?: number; now?: Date };

export class FakeIdentityProvider implements IdentityProvider {
  readonly id = "fake_identity";
  readonly status = "fake" as const;
  readonly issuer = "https://fake-issuer.local/auth/v1";
  private codes = new Map<string, { input: FakeMintInput; codeChallenge: string; expiresAt: number }>();
  constructor(private cfg: { apiBaseUrl: string; secret?: string }) {}
  private get secret() {
    return this.cfg.secret ?? "fake-issuer-development-secret-not-for-production";
  }
  providers() {
    return ["azure", "google"].map((key) => ({ key, label: PROVIDER_LABELS[key] ?? key }));
  }
  authorizeUrl(input: { provider: string; redirectTo: string; codeChallenge: string; state: string }): string {
    const u = new URL(`${this.cfg.apiBaseUrl}/api/v1/auth/fake/authorize`);
    u.searchParams.set("provider", input.provider);
    u.searchParams.set("redirect_to", input.redirectTo);
    u.searchParams.set("code_challenge", input.codeChallenge);
    u.searchParams.set("state", input.state);
    return u.toString();
  }
  /** The fake consent page calls this after the person "signs in"; the code is single-use and bound to the PKCE challenge. */
  issueCode(input: FakeMintInput & { codeChallenge: string }): string {
    const code = base64url.encode(randomBytes(24));
    this.codes.set(code, { input, codeChallenge: input.codeChallenge, expiresAt: Date.now() + 5 * 60_000 });
    return code;
  }
  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ accessToken: string }> {
    const entry = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!entry || entry.expiresAt < Date.now()) throw new IdentityError("exchange_failed", "The sign-in could not be completed. Try again.");
    const challenge = base64url.encode(createHash("sha256").update(input.codeVerifier).digest());
    if (challenge !== entry.codeChallenge) throw new IdentityError("exchange_failed", "The sign-in could not be completed. Try again.");
    return { accessToken: this.mint(entry.input) };
  }
  /** Mints a token exactly as the managed service would. Tests call this directly. */
  mint(input: FakeMintInput): string {
    const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
    const provider = input.provider ?? "google";
    const aal = input.aal ?? "aal1";
    const amr = [{ method: provider === "email" ? "otp" : "oauth", timestamp: now }, ...(aal === "aal2" ? [{ method: "totp", timestamp: now }] : [])];
    return signHs256({
      iss: this.issuer, sub: input.subject ?? `fake-${createHash("sha256").update(input.email.toLowerCase()).digest("hex").slice(0, 24)}`, aud: "authenticated", role: "authenticated",
      iat: now, exp: now + (input.expiresInSeconds ?? 3600), email: input.email.toLowerCase(), aal, amr, session_id: base64url.encode(randomBytes(12)),
      app_metadata: { provider, providers: [provider] },
      user_metadata: { full_name: input.name ?? null, email_verified: input.emailVerified ?? true },
    }, this.secret);
  }
  async verify(accessToken: string): Promise<VerifiedIdentity> {
    const claims = await verifyJwt(accessToken, { issuer: this.issuer, audience: "authenticated", hs256Secret: this.secret });
    return identityFromClaims(claims);
  }
}

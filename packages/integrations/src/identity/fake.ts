import { createHash, randomBytes } from "node:crypto";
import { identityFromClaims, PROVIDER_LABELS } from "./claims";
import { base64url, signHs256, verifyJwt } from "./jwt";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";
import { IdentityError, type IdentityProvider, type MfaFactor, type TotpEnrolment, type VerifiedIdentity } from "./types";

/**
 * Development and tests: an in-process issuer that speaks the same token format and PKCE flow as the managed service,
 * so every sign-in policy (Microsoft for staff, a second factor for staff, verified email) is exercised without an
 * account. It also keeps authenticator factors the way the service does: enrol, challenge, verify a real time-based
 * code, and only then mint a token at assurance level 2. Production refuses this provider.
 */
export type FakeMintInput = { email: string; name?: string | null; provider?: "azure" | "google" | "email"; aal?: "aal1" | "aal2"; emailVerified?: boolean; subject?: string; expiresInSeconds?: number; now?: Date };

type FakeFactor = { id: string; friendlyName: string; secret: string; status: "verified" | "unverified"; createdAt: string };

export class FakeIdentityProvider implements IdentityProvider {
  readonly id = "fake_identity";
  readonly status = "fake" as const;
  readonly issuer = "https://fake-issuer.local/auth/v1";
  private codes = new Map<string, { input: FakeMintInput; codeChallenge: string; expiresAt: number }>();
  private factors = new Map<string, FakeFactor[]>();
  private challenges = new Map<string, { factorId: string; subject: string; expiresAt: number; ip: string | null }>();
  /** Tests may pin the clock the code check uses. */
  clock: () => Date = () => new Date();
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

  /* Second factor, kept the way the managed service keeps it. */

  private async holder(accessToken: string): Promise<VerifiedIdentity> {
    try {
      return await this.verify(accessToken);
    } catch {
      throw new IdentityError("mfa_session_invalid", "The sign-in has expired. Sign in again.");
    }
  }
  async listFactors(accessToken: string): Promise<MfaFactor[]> {
    const who = await this.holder(accessToken);
    return (this.factors.get(who.subject) ?? []).map((f) => ({ id: f.id, type: "totp", friendlyName: f.friendlyName, status: f.status, createdAt: f.createdAt }));
  }
  async enrolTotp(accessToken: string, input: { friendlyName: string; issuer: string }): Promise<TotpEnrolment> {
    const who = await this.holder(accessToken);
    const list = this.factors.get(who.subject) ?? [];
    // The service refuses a name any existing factor holds, and a new factor beside a verified one without a level-2 token.
    if (list.some((f) => f.friendlyName === input.friendlyName)) throw new IdentityError("mfa_factor_conflict", "An authenticator with that name already exists.");
    if (list.some((f) => f.status === "verified") && who.aal !== "aal2") throw new IdentityError("mfa_aal2_required", "A second-factor session is needed to add another authenticator.");
    const factor: FakeFactor = { id: `fac_${base64url.encode(randomBytes(9))}`, friendlyName: input.friendlyName, secret: generateTotpSecret(), status: "unverified", createdAt: this.clock().toISOString() };
    this.factors.set(who.subject, [...list, factor]);
    const uri = otpauthUri({ issuer: input.issuer, account: who.email, secret: factor.secret });
    // Not a scannable code: the fake stands in for the service's image so pages and tests exercise the same markup.
    const qrCodeSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="fake QR code"><rect width="120" height="120" fill="#fff"/><text x="8" y="64" font-size="10" font-family="monospace">fake QR ${factor.id.slice(4, 10)}</text></svg>`;
    return { factorId: factor.id, secret: factor.secret, uri, qrCodeSvg };
  }
  async challengeFactor(accessToken: string, factorId: string, ctx: { ip?: string } = {}): Promise<{ challengeId: string; expiresAt: string }> {
    const who = await this.holder(accessToken);
    const factor = (this.factors.get(who.subject) ?? []).find((f) => f.id === factorId);
    if (!factor) throw new IdentityError("mfa_factor_not_found", "That authenticator is not enrolled.");
    const id = `chl_${base64url.encode(randomBytes(9))}`;
    const expiresAt = this.clock().getTime() + 5 * 60_000;
    this.challenges.set(id, { factorId, subject: who.subject, expiresAt, ip: ctx.ip ?? null });
    return { challengeId: id, expiresAt: new Date(expiresAt).toISOString() };
  }
  async verifyFactor(accessToken: string, input: { factorId: string; challengeId: string; code: string }, ctx: { ip?: string } = {}): Promise<{ accessToken: string }> {
    const who = await this.holder(accessToken);
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.subject !== who.subject || challenge.factorId !== input.factorId) throw new IdentityError("mfa_challenge_invalid", "Start the code step again.");
    // The service ties a challenge to the address that created it.
    if ((challenge.ip ?? null) !== (ctx.ip ?? null)) throw new IdentityError("mfa_ip_mismatch", "Challenge and verification came from different addresses.");
    if (challenge.expiresAt < this.clock().getTime()) {
      this.challenges.delete(input.challengeId);
      throw new IdentityError("mfa_challenge_expired", "That code request expired. Try again.");
    }
    const factor = (this.factors.get(who.subject) ?? []).find((f) => f.id === input.factorId);
    if (!factor) throw new IdentityError("mfa_factor_not_found", "That authenticator is not enrolled.");
    if (!verifyTotp(factor.secret, input.code, { now: this.clock() })) throw new IdentityError("mfa_code_invalid", "That code is not right. Check the app and try again.");
    factor.status = "verified";
    this.challenges.delete(input.challengeId);
    return { accessToken: this.mint({ email: who.email, name: who.name, provider: who.provider as FakeMintInput["provider"], aal: "aal2", emailVerified: who.emailVerified, subject: who.subject, now: this.clock() }) };
  }
  async unenrolFactor(accessToken: string, factorId: string): Promise<void> {
    const who = await this.holder(accessToken);
    const list = this.factors.get(who.subject) ?? [];
    const factor = list.find((f) => f.id === factorId);
    if (!factor) return;
    if (factor.status === "verified" && who.aal !== "aal2") throw new IdentityError("mfa_aal2_required", "Removing a verified authenticator needs a second-factor session.");
    this.factors.set(who.subject, list.filter((f) => f.id !== factorId));
  }
  /** Test and rehearsal hook: the secret behind a factor, so a valid code can be computed the way an authenticator app would. */
  secretOfFactor(factorId: string): string | null {
    for (const list of this.factors.values()) {
      const f = list.find((x) => x.id === factorId);
      if (f) return f.secret;
    }
    return null;
  }
  /** Test hook: forgets every factor a person holds, as the dashboard reset would. */
  resetFactors(subject: string): void {
    this.factors.delete(subject);
  }
}

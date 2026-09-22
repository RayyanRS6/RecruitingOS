import { identityFromClaims, PROVIDER_LABELS } from "./claims";
import { verifyJwt, type Jwks } from "./jwt";
import { IdentityError, type IdentityProvider, type VerifiedIdentity } from "./types";

/**
 * Supabase Auth (decision D19; correction 4): Google and Microsoft (Entra) sign-in configured in the Supabase dashboard,
 * PKCE flow, tokens verified here with the project JWT secret (HS256) or the project's published keys (RS256/ES256).
 * The application never stores the Supabase session; it opens its own after verification.
 */
export class SupabaseIdentityProvider implements IdentityProvider {
  readonly id = "supabase_auth";
  private jwksCache: { at: number; keys: Jwks } | null = null;
  constructor(private cfg: { url?: string; anonKey?: string; jwtSecret?: string; providers?: string[]; fetch?: typeof fetch }) {}

  get status() {
    return this.cfg.url && this.cfg.anonKey ? ("live" as const) : ("not_connected" as const);
  }
  private get issuer(): string {
    return `${(this.cfg.url ?? "").replace(/\/$/, "")}/auth/v1`;
  }
  providers() {
    return (this.cfg.providers ?? ["azure", "google"]).map((key) => ({ key, label: PROVIDER_LABELS[key] ?? key }));
  }
  authorizeUrl(input: { provider: string; redirectTo: string; codeChallenge: string; state: string }): string {
    if (!this.cfg.url) throw new IdentityError("not_configured", "Sign-in is not configured.");
    const u = new URL(`${this.issuer}/authorize`);
    u.searchParams.set("provider", input.provider);
    u.searchParams.set("redirect_to", input.redirectTo);
    u.searchParams.set("code_challenge", input.codeChallenge);
    u.searchParams.set("code_challenge_method", "s256");
    // Identity scopes only (correction 4): no calendar permission rides on the sign-in registration.
    if (input.provider === "azure") u.searchParams.set("scopes", "openid profile email");
    return u.toString();
  }
  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<{ accessToken: string }> {
    if (!this.cfg.url || !this.cfg.anonKey) throw new IdentityError("not_configured", "Sign-in is not configured.");
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.issuer}/token?grant_type=pkce`, { method: "POST", headers: { "content-type": "application/json", apikey: this.cfg.anonKey }, body: JSON.stringify({ auth_code: input.code, code_verifier: input.codeVerifier }) });
    if (!res.ok) throw new IdentityError("exchange_failed", "The sign-in could not be completed. Try again.");
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new IdentityError("exchange_failed", "The sign-in could not be completed. Try again.");
    return { accessToken: body.access_token };
  }
  private async jwks(): Promise<Jwks> {
    if (this.jwksCache && Date.now() - this.jwksCache.at < 10 * 60_000) return this.jwksCache.keys;
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.issuer}/.well-known/jwks.json`);
    if (!res.ok) throw new IdentityError("jwks_unavailable", "The identity service's keys could not be fetched.");
    const keys = (await res.json()) as Jwks;
    this.jwksCache = { at: Date.now(), keys };
    return keys;
  }
  async verify(accessToken: string): Promise<VerifiedIdentity> {
    const claims = await verifyJwt(accessToken, { issuer: this.issuer, audience: "authenticated", hs256Secret: this.cfg.jwtSecret, jwks: () => this.jwks() });
    return identityFromClaims(claims);
  }
}

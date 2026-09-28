import { identityFromClaims, PROVIDER_LABELS } from "./claims";
import { verifyJwt, type Jwks } from "./jwt";
import { IdentityError, type IdentityProvider, type MfaFactor, type TotpEnrolment, type VerifiedIdentity } from "./types";

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

  /*
   * Second factor through the service's own MFA endpoints (Supabase Auth: /factors, /factors/:id/challenge,
   * /factors/:id/verify, /user). Every call carries the person's access token; the publishable key only identifies the
   * project. Errors come back with the service's error code, mapped to the application's small vocabulary.
   */
  private async mfaRequest<T>(accessToken: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown, verifying = false): Promise<T> {
    if (!this.cfg.url || !this.cfg.anonKey) throw new IdentityError("not_configured", "Sign-in is not configured.");
    const f = this.cfg.fetch ?? fetch;
    const res = await f(`${this.issuer}${path}`, {
      method,
      headers: { apikey: this.cfg.anonKey, authorization: `Bearer ${accessToken}`, "x-supabase-api-version": "2024-01-01", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = text ? (JSON.parse(text) as Record<string, unknown>) : null; } catch { json = null; }
    if (!res.ok) {
      // With the 2024-01-01 API version the body is { code, message }; older shapes carry error_code and msg. The service also names the code in a header.
      const headerCode = res.headers.get("x-sb-error-code") ?? "";
      const bodyCode = typeof json?.error_code === "string" ? json.error_code : typeof json?.code === "string" ? json.code : "";
      const code = headerCode || bodyCode;
      const message = String(json?.message ?? json?.msg ?? json?.error_description ?? "The second-factor service refused the request.");
      throw new IdentityError(mapMfaError(code, res.status, verifying), message);
    }
    return (json ?? {}) as T;
  }
  async listFactors(accessToken: string): Promise<MfaFactor[]> {
    const user = await this.mfaRequest<{ factors?: Array<{ id: string; factor_type?: string; friendly_name?: string | null; status?: string; created_at?: string }> }>(accessToken, "GET", "/user");
    return (user.factors ?? []).map((f) => ({ id: f.id, type: f.factor_type ?? "totp", friendlyName: f.friendly_name ?? null, status: f.status === "verified" ? "verified" : "unverified", createdAt: f.created_at ?? null }));
  }
  async enrolTotp(accessToken: string, input: { friendlyName: string; issuer: string }): Promise<TotpEnrolment> {
    const r = await this.mfaRequest<{ id: string; totp?: { qr_code?: string; secret?: string; uri?: string } }>(accessToken, "POST", "/factors", { factor_type: "totp", friendly_name: input.friendlyName, issuer: input.issuer });
    if (!r.id || !r.totp?.secret || !r.totp.uri) throw new IdentityError("mfa_unavailable", "The second-factor service returned an incomplete enrolment.");
    // The service returns the QR code as SVG markup; a data-URL prefix, if it ever sends one, is stripped so the page adds its own.
    const qr = r.totp.qr_code ?? null;
    const raw = qr ? (qr.startsWith("data:") ? decodeURIComponent(qr.replace(/^data:image\/svg\+xml[^,]*,/, "")) : qr) : null;
    return { factorId: r.id, secret: r.totp.secret, uri: r.totp.uri, qrCodeSvg: raw?.includes("<svg") ? scalableSvg(raw) : null };
  }
  async challengeFactor(accessToken: string, factorId: string, _ctx?: { ip?: string }): Promise<{ challengeId: string; expiresAt: string }> {
    const r = await this.mfaRequest<{ id: string; expires_at?: number | string }>(accessToken, "POST", `/factors/${encodeURIComponent(factorId)}/challenge`, {});
    const exp = typeof r.expires_at === "number" ? new Date(r.expires_at * 1000).toISOString() : typeof r.expires_at === "string" ? r.expires_at : new Date(Date.now() + 5 * 60_000).toISOString();
    return { challengeId: r.id, expiresAt: exp };
  }
  async verifyFactor(accessToken: string, input: { factorId: string; challengeId: string; code: string }, _ctx?: { ip?: string }): Promise<{ accessToken: string }> {
    const r = await this.mfaRequest<{ access_token?: string }>(accessToken, "POST", `/factors/${encodeURIComponent(input.factorId)}/verify`, { challenge_id: input.challengeId, code: input.code }, true);
    if (!r.access_token) throw new IdentityError("mfa_unavailable", "The second-factor service returned no session.");
    return { accessToken: r.access_token };
  }
  async unenrolFactor(accessToken: string, factorId: string): Promise<void> {
    await this.mfaRequest(accessToken, "DELETE", `/factors/${encodeURIComponent(factorId)}`);
  }
}

/** The service's error codes first; the HTTP status only decides what a code-less answer means. */
function mapMfaError(code: string, status: number, verifying: boolean): string {
  switch (code) {
    case "mfa_verification_failed": case "mfa_totp_verify_failed": return "mfa_code_invalid";
    case "mfa_challenge_expired": return "mfa_challenge_expired";
    case "mfa_factor_name_conflict": return "mfa_factor_conflict";
    case "mfa_factor_not_found": return verifying ? "mfa_challenge_invalid" : "mfa_factor_not_found";
    case "mfa_ip_address_mismatch": return "mfa_ip_mismatch";
    case "insufficient_aal": return "mfa_aal2_required";
    case "over_request_rate_limit": return "mfa_rate_limited";
    case "mfa_totp_verify_not_enabled": case "mfa_totp_enroll_not_enabled": case "mfa_verification_rejected": return "mfa_unavailable";
    case "session_not_found": case "bad_jwt": case "no_authorization": return "mfa_session_invalid";
  }
  if (status === 429) return "mfa_rate_limited";
  if (status === 401) return "mfa_session_invalid";
  return "mfa_unavailable";
}

/** The service's SVG names a pixel size and no viewBox, which an <img> cannot scale; a viewBox from that size makes it fit any box. */
export function scalableSvg(svg: string): string {
  const open = svg.match(/<svg\b[^>]*>/);
  if (!open || /viewBox=/.test(open[0])) return svg;
  const w = open[0].match(/\bwidth="(\d+(?:\.\d+)?)(?:px)?"/)?.[1];
  const h = open[0].match(/\bheight="(\d+(?:\.\d+)?)(?:px)?"/)?.[1];
  if (!w || !h) return svg;
  return svg.replace(open[0], open[0].replace(/<svg\b/, `<svg viewBox="0 0 ${w} ${h}"`));
}

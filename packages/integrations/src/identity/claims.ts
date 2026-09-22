import type { VerifiedIdentity } from "./types";

/** Maps the claims a Supabase-style access token carries to what the application relies on. */
export function identityFromClaims(claims: Record<string, unknown>): VerifiedIdentity {
  const appMeta = (claims.app_metadata ?? {}) as { provider?: string; providers?: string[] };
  const userMeta = (claims.user_metadata ?? {}) as { full_name?: string; name?: string; email_verified?: boolean };
  const amrRaw = Array.isArray(claims.amr) ? (claims.amr as Array<{ method?: string; timestamp?: number }>) : [];
  const amr = amrRaw.map((a) => ({ method: String(a.method ?? "unknown"), at: new Date(Number(a.timestamp ?? 0) * 1000).toISOString() }));
  const provider = String(appMeta.provider ?? "email");
  const aal = claims.aal === "aal2" ? "aal2" : "aal1";
  const totp = amr.find((a) => a.method === "totp" || a.method === "mfa/totp" || a.method === "webauthn");
  const email = String(claims.email ?? "").trim().toLowerCase();
  return {
    subject: String(claims.sub),
    email,
    // The provider's own flag wins; when it says nothing, an OAuth provider vouches for the address it returned and email sign-in is verified by the OTP itself.
    emailVerified: userMeta.email_verified === true || claims.email_verified === true || (userMeta.email_verified === undefined && claims.email_verified === undefined && provider !== "email"),
    name: userMeta.full_name ?? userMeta.name ?? null,
    provider,
    aal,
    amr,
    mfaVerifiedAt: aal === "aal2" ? (totp?.at ?? new Date(Number(claims.iat ?? 0) * 1000).toISOString()) : null,
    issuer: String(claims.iss),
    issuedAt: new Date(Number(claims.iat ?? 0) * 1000).toISOString(),
    expiresAt: new Date(Number(claims.exp ?? 0) * 1000).toISOString(),
  };
}

export const PROVIDER_LABELS: Record<string, string> = { azure: "Microsoft", google: "Google", email: "Email" };

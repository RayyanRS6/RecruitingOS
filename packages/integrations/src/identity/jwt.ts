import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "node:crypto";
import { IdentityError } from "./types";

/**
 * Minimal, dependency-free JWT verification for the tokens a managed identity service issues: HS256 with the project
 * secret, or RS256/ES256 against the issuer's published keys. Every claim that matters is checked; nothing is trusted
 * from the header beyond the algorithm and key id.
 */
export type Jwks = { keys: Array<Record<string, unknown> & { kid?: string; kty: string; alg?: string }> };
export type VerifyOptions = { issuer: string; audience: string; hs256Secret?: string; jwks?: () => Promise<Jwks>; now?: Date; skewSeconds?: number };

const b64url = {
  decode: (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
  encode: (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
};
export const base64url = b64url;

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdentityError("malformed_token", "The sign-in token is malformed.");
  const [h, p, s] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64url.decode(h).toString("utf8")) as Record<string, unknown>;
    payload = JSON.parse(b64url.decode(p).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new IdentityError("malformed_token", "The sign-in token is malformed.");
  }
  return { header, payload, signingInput: `${h}.${p}`, signature: b64url.decode(s) };
}

export async function verifyJwt(token: string, opts: VerifyOptions): Promise<Record<string, unknown>> {
  const { header, payload, signingInput, signature } = decodeJwt(token);
  const alg = String(header.alg ?? "");
  let valid = false;
  if (alg === "HS256") {
    if (!opts.hs256Secret) throw new IdentityError("unsupported_algorithm", "This deployment does not accept HS256 tokens.");
    const expected = createHmac("sha256", opts.hs256Secret).update(signingInput).digest();
    valid = expected.length === signature.length && timingSafeEqual(expected, signature);
  } else if (alg === "RS256" || alg === "ES256") {
    if (!opts.jwks) throw new IdentityError("unsupported_algorithm", `This deployment cannot verify ${alg} tokens.`);
    const { keys } = await opts.jwks();
    const kid = header.kid ? String(header.kid) : null;
    const jwk = keys.find((k) => (kid ? k.kid === kid : true) && (alg === "RS256" ? k.kty === "RSA" : k.kty === "EC"));
    if (!jwk) throw new IdentityError("unknown_key", "The sign-in token was signed with a key this deployment does not know.");
    const key = createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
    valid = cryptoVerify("sha256", Buffer.from(signingInput), alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key, signature);
  } else {
    throw new IdentityError("unsupported_algorithm", `Unsupported token algorithm ${alg || "(none)"}.`);
  }
  if (!valid) throw new IdentityError("bad_signature", "The sign-in token's signature is not valid.");
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const skew = opts.skewSeconds ?? 60;
  if (payload.iss !== opts.issuer) throw new IdentityError("bad_issuer", "The sign-in token was not issued by this deployment's identity service.");
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(opts.audience) : aud === opts.audience;
  if (!audOk) throw new IdentityError("bad_audience", "The sign-in token is not meant for this application.");
  if (typeof payload.exp !== "number" || payload.exp + skew < now) throw new IdentityError("expired", "The sign-in token has expired. Sign in again.");
  if (typeof payload.nbf === "number" && payload.nbf - skew > now) throw new IdentityError("not_yet_valid", "The sign-in token is not valid yet.");
  if (typeof payload.sub !== "string" || !payload.sub) throw new IdentityError("bad_subject", "The sign-in token has no subject.");
  return payload;
}

/** Signs a token the way the identity service does with a project secret (used by the fake issuer only). */
export function signHs256(payload: Record<string, unknown>, secret: string, header: Record<string, unknown> = {}): string {
  const h = b64url.encode(JSON.stringify({ alg: "HS256", typ: "JWT", ...header }));
  const p = b64url.encode(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url.encode(sig)}`;
}

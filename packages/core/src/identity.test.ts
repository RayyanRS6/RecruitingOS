import { describe, expect, it } from "vitest";
import { isEmailAddress, normalizeEmail } from "./auth";
import { DEFAULT_SIGN_IN_POLICY, evaluateSignIn, holdsOtherThanStaffProvider, identityForSignIn, linkedToAnotherSubject, type IdentityLike, type SignInPolicy } from "./identity";

/**
 * What a verified identity may sign in as, before any account is looked at (audit SEC-8, known bug row 41): a provider
 * the deployment offers, the one the browser started with when the account holds it, and a usable address. The routes'
 * own tests (apps/api/src/signin-hardening.test.ts) cover the same rules end to end, audited.
 */
const person = (over: Partial<IdentityLike> = {}): IdentityLike => ({ subject: "sub-1", email: "dana@brightline.test", emailVerified: true, name: "Dana", provider: "google", providers: ["google"], aal: "aal1", mfaVerifiedAt: null, ...over });

describe("a usable sign-in address", () => {
  it("takes ordinary addresses and refuses empty, partial or malformed ones", () => {
    for (const ok of ["dana@brightline.test", "dana.whitfield+jobs@mail.brightline.co.uk", "o'neil@example.com", "ana@xn--bcher-kva.example"]) expect(isEmailAddress(ok), ok).toBe(true);
    for (const bad of ["", "dana", "dana@", "@brightline.test", "dana@brightline", "dana@@brightline.test", "da na@brightline.test", "dana@bright line.test", "dana@.test", "dana@brightline.", "dana@brightline..test", "dana\u0000@brightline.test", "+15551234567"]) expect(isEmailAddress(bad), JSON.stringify(bad)).toBe(false);
    expect(isEmailAddress(`${"a".repeat(64)}@${"b".repeat(184)}.test`)).toBe(true); // 254 characters
    expect(isEmailAddress(`${"a".repeat(64)}@${"b".repeat(185)}.test`)).toBe(false);
    // normalizeEmail only trims and lowercases: a blank address stays blank, and blank is refused
    expect(isEmailAddress(normalizeEmail("   "))).toBe(false);
    expect(isEmailAddress(normalizeEmail("  Dana@Brightline.TEST "))).toBe(true);
  });
});

describe("the identity a sign-in stands for", () => {
  it("refuses a provider the deployment does not offer, whatever the token or the browser says", () => {
    for (const provider of ["email", "phone", "anonymous", "github", ""]) {
      const r = identityForSignIn(person({ provider, providers: [provider] }), null);
      expect(r).toEqual({ ok: false, code: "provider_not_allowed", message: "Sign in with Microsoft or Google." });
    }
    // a browser that names a method the account holds but the deployment does not offer (the PKCE cookie is not sealed)
    expect(identityForSignIn(person({ providers: ["google", "email"] }), "email")).toMatchObject({ ok: false, code: "provider_not_allowed" });
    // the list is the deployment's: one offering Microsoft only refuses Google
    expect(identityForSignIn(person(), null, { ...DEFAULT_SIGN_IN_POLICY, allowedProviders: ["azure"] })).toMatchObject({ ok: false, code: "provider_not_allowed" });
    // a policy that names no list falls back to Microsoft and Google
    const withoutList: SignInPolicy = { staffDomains: ["identifiedtalent.com"], staffProvider: "azure", requireStaffMfa: true };
    expect(identityForSignIn(person({ provider: "azure", providers: ["azure"] }), null, withoutList)).toMatchObject({ ok: true });
    expect(identityForSignIn(person({ provider: "email", providers: ["email"] }), null, withoutList)).toMatchObject({ ok: false, code: "provider_not_allowed" });
  });

  it("takes the provider the browser started with when the account holds it, and refuses one it does not hold", () => {
    // first created with Google, linked to Microsoft by email: the token names Google, the person used Microsoft
    const linked = person({ provider: "google", providers: ["google", "azure"] });
    const viaMicrosoft = identityForSignIn(linked, "azure");
    expect(viaMicrosoft).toEqual({ ok: true, identity: { ...linked, provider: "azure" } });
    expect(identityForSignIn(linked, "google")).toEqual({ ok: true, identity: linked });
    // a start the account does not hold: the authorize address was changed on the way
    expect(identityForSignIn(person(), "azure")).toEqual({ ok: false, code: "provider_mismatch", message: "That sign-in did not match the provider you chose. Start again." });
    // an identity that lists no providers holds its own one only
    const bare: IdentityLike = { subject: "sub-2", email: "lee@brightline.test", emailVerified: true, name: null, provider: "azure", aal: "aal1", mfaVerifiedAt: null };
    expect(identityForSignIn(bare, "azure")).toMatchObject({ ok: true });
    expect(identityForSignIn(bare, "google")).toMatchObject({ ok: false, code: "provider_mismatch" });
    // without a start (the JSON route) the token's provider stands
    expect(identityForSignIn(linked, null)).toEqual({ ok: true, identity: linked });
    expect(identityForSignIn(linked, undefined)).toEqual({ ok: true, identity: linked });
  });

  it("refuses an identity without a usable address, through any allowed provider", () => {
    for (const email of ["", "   ", "not-an-address", "+15551234567"]) {
      expect(identityForSignIn(person({ email }), null)).toEqual({ ok: false, code: "email_invalid", message: "Your sign-in account has no usable email address. Sign in with Microsoft or Google." });
      expect(identityForSignIn(person({ email, providers: ["google", "azure"] }), "azure")).toMatchObject({ ok: false, code: "email_invalid" });
    }
    expect(identityForSignIn(person({ email: " Dana@Brightline.test " }), null)).toMatchObject({ ok: true });
  });

  it("holds an account to its subject under every provider the identity holds, not only the one used", () => {
    const viaMicrosoft = person({ subject: "sub-2", provider: "azure", providers: ["google", "azure"] });
    // recorded under Google with another subject: a re-created account at the service, even when Microsoft was used
    expect(linkedToAnotherSubject({ authProvider: "google", authSubject: "sub-1" }, viaMicrosoft)).toBe(true);
    expect(linkedToAnotherSubject({ authProvider: "azure", authSubject: "sub-1" }, viaMicrosoft)).toBe(true);
    // the same subject, or nothing recorded yet, or a provider the identity does not hold: no mismatch
    expect(linkedToAnotherSubject({ authProvider: "google", authSubject: "sub-2" }, viaMicrosoft)).toBe(false);
    expect(linkedToAnotherSubject({ authProvider: null, authSubject: null }, viaMicrosoft)).toBe(false);
    expect(linkedToAnotherSubject({ authProvider: "email", authSubject: "sub-1" }, viaMicrosoft)).toBe(false);
    // an identity that lists no providers holds its own one only
    const bare: IdentityLike = { subject: "sub-2", email: "lee@brightline.test", emailVerified: true, name: null, provider: "azure", aal: "aal1", mfaVerifiedAt: null };
    expect(linkedToAnotherSubject({ authProvider: "azure", authSubject: "sub-1" }, bare)).toBe(true);
    expect(linkedToAnotherSubject({ authProvider: "google", authSubject: "sub-1" }, bare)).toBe(false);
  });
});

describe("a staff account holds Microsoft only", () => {
  const staff = (over: Partial<IdentityLike> = {}) => person({ email: "ivy@identifiedtalent.com", provider: "azure", providers: ["azure"], aal: "aal2", ...over });

  it("refuses a staff account that also holds another provider, even when the sign-in used Microsoft; customers may hold several", () => {
    expect(evaluateSignIn(staff(), null)).toEqual({ ok: true, staff: true });
    // the started provider (Microsoft here) comes from an unsealed cookie; the providers the account holds come from the signed token
    for (const providers of [["azure", "google"], ["google", "azure"], ["azure", "email"]]) {
      expect(evaluateSignIn(staff({ providers }), null), providers.join(",")).toEqual({ ok: false, staff: true, code: "staff_provider_linked", message: "This ITS account is also linked to another sign-in method. Ask an ITS administrator to remove that link, then sign in with Microsoft 365." });
    }
    // a platform role makes an account staff whatever its address, and the first administrator on the bootstrap list too
    expect(evaluateSignIn(staff({ email: "ivy@brightline.test", providers: ["azure", "google"] }), { platformRole: "its_recruiter" })).toMatchObject({ ok: false, code: "staff_provider_linked" });
    expect(evaluateSignIn(staff({ email: "first@brightline.test", providers: ["azure", "google"] }), null, { ...DEFAULT_SIGN_IN_POLICY, bootstrapAdmins: ["first@brightline.test"] })).toMatchObject({ ok: false, code: "staff_provider_linked" });
    // through Google the older refusal still answers first
    expect(evaluateSignIn(staff({ provider: "google", providers: ["azure", "google"] }), null)).toMatchObject({ ok: false, code: "staff_provider_required" });
    // a customer's account linked to both signs in with either
    expect(evaluateSignIn(person({ provider: "azure", providers: ["google", "azure"] }), null)).toEqual({ ok: true, staff: false });
    // an identity that lists no providers holds its own one only
    const bare: IdentityLike = { subject: "sub-3", email: "lee@identifiedtalent.com", emailVerified: true, name: null, provider: "azure", aal: "aal2", mfaVerifiedAt: null };
    expect(holdsOtherThanStaffProvider(bare, DEFAULT_SIGN_IN_POLICY)).toBe(false);
    expect(evaluateSignIn(bare, null)).toEqual({ ok: true, staff: true });
  });
});

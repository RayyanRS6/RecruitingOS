import { describe, expect, it } from "vitest";
import { identityFromClaims } from "./claims";
import { FakeIdentityProvider } from "./fake";
import { totp } from "./totp";

/**
 * The managed service names an account's FIRST provider in app_metadata.provider and links accounts across providers by
 * email (known bug row 41), so a verified identity carries every linked provider, and the fake issuer mints the same
 * shape: a test can sign a linked account in with its second provider.
 */
describe("the providers a verified identity carries", () => {
  const base = { sub: "u1", iss: "https://project.supabase.test/auth/v1", iat: 1_790_000_000, exp: 1_790_003_600, email: " Dana@Brightline.TEST ", user_metadata: { email_verified: true } };

  it("keeps the first provider and lists every linked one, the first first", () => {
    const linked = identityFromClaims({ ...base, app_metadata: { provider: "google", providers: ["google", "azure"] } });
    expect(linked.provider).toBe("google");
    expect(linked.providers).toEqual(["google", "azure"]);
    expect(linked.email).toBe("dana@brightline.test");
    // the service's own order, a repeat and anything that is not a provider name: the first still leads, once
    expect(identityFromClaims({ ...base, app_metadata: { provider: "azure", providers: ["google", "azure", "google", "", 7, null] } }).providers).toEqual(["azure", "google"]);
    // no list at all: the account holds its first provider only
    expect(identityFromClaims({ ...base, app_metadata: { provider: "google" } }).providers).toEqual(["google"]);
    expect(identityFromClaims({ ...base, app_metadata: { provider: "google", providers: "google" } }).providers).toEqual(["google"]);
    // nothing named: the email method, which no deployment offers by default
    const bare = identityFromClaims({ ...base });
    expect(bare.provider).toBe("email");
    expect(bare.providers).toEqual(["email"]);
  });

  it("the fake issuer names the account's first provider like the service, and keeps the list through the second factor", async () => {
    const idp = new FakeIdentityProvider({ apiBaseUrl: "http://localhost:3000" });
    const alone = await idp.verify(idp.mint({ email: "lin@identifiedtalent.com", provider: "azure" }));
    expect(alone.provider).toBe("azure");
    expect(alone.providers).toEqual(["azure"]);
    // first created with Google, signing in with Microsoft now
    const token = idp.mint({ email: "lin@identifiedtalent.com", provider: "azure", providers: ["google"] });
    const linked = await idp.verify(token);
    expect(linked.provider).toBe("google");
    expect(linked.providers).toEqual(["google", "azure"]);
    expect(linked.amr.map((a) => a.method)).toEqual(["oauth"]);
    // already linked both ways: nothing is added twice
    expect((await idp.verify(idp.mint({ email: "lin@identifiedtalent.com", provider: "google", providers: ["google", "azure"] }))).providers).toEqual(["google", "azure"]);
    // the level-2 token the second factor re-issues carries the same providers
    const enrol = await idp.enrolTotp(token, { friendlyName: "Authenticator 1", issuer: "Recruiting OS" });
    const { challengeId } = await idp.challengeFactor(token, enrol.factorId);
    const raised = await idp.verify((await idp.verifyFactor(token, { factorId: enrol.factorId, challengeId, code: totp(enrol.secret) })).accessToken);
    expect(raised.aal).toBe("aal2");
    expect(raised.provider).toBe("google");
    expect(raised.providers).toEqual(["google", "azure"]);
  });
});

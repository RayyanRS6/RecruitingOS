import { afterEach, describe, expect, it } from "vitest";
import { containsSecret, redactObject, redactText, fingerprint } from "@ros/contracts";
import { SecretLeakError, clearRegisteredSecretValues, guardOutbound, redact, redactString, registerSecretValue } from "./secrets";

/** Correction 10 (18 September 2026): tokens never appear in logs, errors, analytics, audit records or support messages. */
describe("secret redaction and the outbound guard", () => {
  afterEach(() => clearRegisteredSecretValues());

  it("recognises token shapes without being told the value", () => {
    const google = "1//0gZx9K-Fake_Refresh_Token_ABCDEFGHIJKLMNOP";
    const access = "ya29.a0AfH6SMBfakeAccessTokenValue1234567890abcdefghijklmnop";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpcy1pcy1hLWZha2Utc2lnbmF0dXJl";
    const text = `refresh=${google} bearer: Bearer ${access} jwt ${jwt} key sk-ant-api03-FakeFakeFakeFakeFake`;
    const out = redactText(text);
    expect(out).not.toContain(google);
    expect(out).not.toContain(access);
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("sk-ant-api03-FakeFakeFakeFakeFake");
    expect(out).toContain("[redacted]");
    expect(redactText("https://x.test/cb?code=4/0AfakeCode&client_secret=GOCSPX-fake&state=abc")).toBe("https://x.test/cb?code=[redacted]&client_secret=[redacted]&state=abc"); // an authorization code is single-use but still a credential (21 Sep review)
    expect(redactText('{"refresh_token":"abc","name":"ok"}')).toBe('{"refresh_token":"[redacted]","name":"ok"}');
  });

  it("redacts by key inside objects and leaves ordinary fields alone", () => {
    const out = redactObject({ refresh_token: "plain-value-that-looks-normal", apiKey: "k", nested: { password: "p", note: "keep me", token: "short" }, list: [{ client_secret: "s" }] });
    expect(out).toEqual({ refresh_token: "[redacted]", apiKey: "[redacted]", nested: { password: "[redacted]", note: "keep me", token: "[redacted]" }, list: [{ client_secret: "[redacted]" }] });
  });

  it("scrubs values that were read from the store even when they have no recognisable shape", () => {
    registerSecretValue("plain-looking-secret-value-42");
    expect(redactString("error: plain-looking-secret-value-42 rejected")).toBe("error: [redacted] rejected");
    expect(redact({ msg: "x plain-looking-secret-value-42 y", n: 1 })).toEqual({ msg: "x [redacted] y", n: 1 });
    expect(redact(new Error("boom plain-looking-secret-value-42"))).toMatchObject({ message: "boom [redacted]" });
  });

  it("refuses to let a secret into an event or audit record outside production", () => {
    registerSecretValue("registered-secret-value-9876");
    expect(() => guardOutbound({ detail: "registered-secret-value-9876" }, "event test")).toThrow(SecretLeakError);
    expect(() => guardOutbound({ refresh_token: "anything" }, "audit test")).toThrow(SecretLeakError);
    expect(() => guardOutbound({ url: "https://a.test?client_secret=GOCSPX-x" }, "audit test")).toThrow(SecretLeakError);
    expect(guardOutbound({ token: "wake-timer-token", note: "ordinary payload" }, "event test")).toEqual({ token: "wake-timer-token", note: "ordinary payload" });
    expect(containsSecret({ escalationIds: ["a"], fields: "preview" })).toBe(false);
  });

  it("fingerprints are stable, short and not reversible", () => {
    expect(fingerprint("abc")).toBe(fingerprint("abc"));
    expect(fingerprint("abc")).not.toBe(fingerprint("abd"));
    expect(fingerprint("some-vault-uuid")).toMatch(/^fp_[0-9a-f]{8}$/);
  });
});

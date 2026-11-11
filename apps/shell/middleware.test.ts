import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { middleware } from "./middleware";

/**
 * The bare address of Home sends someone without a session to the welcome page (components/welcome-page.test.ts). Over
 * https the session cookie is "__Host-ros_session" (audit SEC-25), so that is the name the middleware looks for, by the
 * API's own rule (apps/api/src/cookie-names.ts), and a cookie under the old name is no session.
 */
describe("the session cookie the middleware looks for", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const home = (cookie?: string) => middleware(new NextRequest("https://app.test/", cookie ? { headers: { cookie } } : undefined)).headers.get("location");

  it("in production, __Host-ros_session and only that name", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_DOMAIN", "");
    expect(home("ros_theme=dark; __Host-ros_session=abc")).toBeNull();
    expect(home("ros_theme=dark; ros_session=abc")).toBe("https://app.test/welcome");
    expect(home()).toBe("https://app.test/welcome");
  });

  it("with COOKIE_DOMAIN the shared session cookie keeps its plain name, and in development and tests every name is plain", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_DOMAIN", "app.test");
    expect(home("ros_session=abc")).toBeNull();
    expect(home("__Host-ros_session=abc")).toBe("https://app.test/welcome");
    vi.stubEnv("COOKIE_DOMAIN", "");
    for (const mode of ["development", "test"]) {
      vi.stubEnv("NODE_ENV", mode);
      expect(home("ros_session=abc"), mode).toBeNull();
      expect(home("__Host-ros_session=abc"), mode).toBe("https://app.test/welcome");
    }
  });
});

/**
 * A refusal the identity service could not tie to a sign-in (its record of the flow expired or missing, as after more than
 * five minutes on Microsoft's approval screen) comes to the address's root with error, error_code and error_description in
 * the query (10 November 2026). It goes to the sign-in page as a code the page has words for, by the callback's own mapping,
 * and the service's words never stay in the address.
 */
describe("a refusal the identity service sends to the address's root", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const at = (path: string, cookie?: string) => middleware(new NextRequest(`https://app.test${path}`, cookie ? { headers: { cookie } } : undefined)).headers.get("location");
  const microsoftSays = encodeURIComponent("AADSTS90094: Admin consent is required for the permissions requested by this application.");

  it("goes to the sign-in page with its code and a trailing #, never with the service's words, signed in or not", () => {
    const description = encodeURIComponent("OAuth state parameter is invalid: pat@another-company.example");
    for (const cookie of [undefined, "ros_session=abc"]) {
      const location = at(`/?error=invalid_request&error_code=bad_oauth_state&error_description=${description}`, cookie);
      expect(location, cookie).toBe("https://app.test/login?error=signin_incomplete#");
      expect(decodeURIComponent(location ?? "")).not.toMatch(/another-company|OAuth state/);
    }
    // the description alone is enough to know it is a refusal
    expect(at(`/?error_description=${description}`)).toBe("https://app.test/login?error=signin_incomplete#");
    // the callback's own mapping: an unverified address, and Microsoft's codes only for this browser's Microsoft sign-in
    expect(at("/?error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified")).toBe("https://app.test/login?error=email_unverified#");
    expect(at(`/?error=access_denied&error_description=${microsoftSays}`, "ros_pkce=verifier.state.azure")).toBe("https://app.test/login?error=microsoft_needs_approval#");
    expect(at(`/?error=access_denied&error_description=${microsoftSays}`, "ros_pkce=verifier.state.google")).toBe("https://app.test/login?error=signin_incomplete#");
    expect(at(`/?error=access_denied&error_description=${microsoftSays}`)).toBe("https://app.test/login?error=signin_incomplete#");
    // over https the PKCE cookie is read by its prefixed name, as the API sets it
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_DOMAIN", "");
    expect(at(`/?error=access_denied&error_description=${microsoftSays}`, "__Host-ros_pkce=verifier.state.azure")).toBe("https://app.test/login?error=microsoft_needs_approval#");
  });

  it("leaves every other address alone: one with a code, Home's own links, and other pages", () => {
    expect(at("/?code=abc&error=access_denied", "ros_session=abc")).toBeNull();
    expect(at("/?request=r1", "ros_session=abc")).toBeNull();
    expect(at("/roles?error=access_denied", "ros_session=abc")).toBeNull();
    expect(at("/", "ros_session=abc")).toBeNull();
    expect(at("/")).toBe("https://app.test/welcome");
  });
});

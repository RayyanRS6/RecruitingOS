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

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Container } from "./container";
import { cookieName, sessionCookieName } from "./cookie-names";
import { clearAppCookie, readAppCookie, setAppCookie, type CookiePlace } from "./cookies";
import type { Vars } from "./middleware/session";

/**
 * Audit SEC-25: over https every cookie the application sets is Secure and carries the browser's prefix, "__Host-" on
 * Path=/ (no Domain, so a sibling subdomain can neither plant nor overwrite it) and "__Secure-" on a narrower path; over
 * http the plain names stay. Setting, reading and clearing go by the same rule, and nothing reads the old name.
 */
const PLACES: Record<string, CookiePlace> = {
  ros_root: { path: "/" },
  ros_shared: { path: "/", shared: true },
  ros_scoped: { path: "/c/screen/abc" },
  ros_step: { path: "/api/v1/auth", shared: true },
};

/** A bare app whose only work is the helper, with the environment a deployment would give it. */
function appIn(env: { NODE_ENV: string; COOKIE_DOMAIN?: string }) {
  const app = new Hono<Vars>();
  app.use("*", async (c, next) => {
    c.set("container", { env: { NODE_ENV: env.NODE_ENV, raw: { COOKIE_DOMAIN: env.COOKIE_DOMAIN } } } as unknown as Container);
    await next();
  });
  app.get("/set", (c) => {
    for (const [name, place] of Object.entries(PLACES)) setAppCookie(c, name, "v1.sealed", { ...place, maxAge: 600 });
    return c.text("ok");
  });
  app.get("/read", (c) => c.json(Object.fromEntries(Object.entries(PLACES).map(([name, place]) => [name, readAppCookie(c, name, place) ?? null]))));
  app.get("/clear", (c) => {
    for (const [name, place] of Object.entries(PLACES)) clearAppCookie(c, name, place);
    return c.text("ok");
  });
  return app;
}
const setCookies = async (env: { NODE_ENV: string; COOKIE_DOMAIN?: string }, path: string) => (await appIn(env).request(path)).headers.getSetCookie();

describe("cookie names, flags and scope (audit SEC-25)", () => {
  it("over https: __Host- on Path=/, __Secure- on a narrower path, Secure everywhere, no Domain unless a shared cookie has COOKIE_DOMAIN", async () => {
    expect(await setCookies({ NODE_ENV: "production" }, "/set")).toEqual([
      "__Host-ros_root=v1.sealed; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Host-ros_shared=v1.sealed; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Secure-ros_scoped=v1.sealed; Max-Age=600; Path=/c/screen/abc; HttpOnly; Secure; SameSite=Lax",
      "__Secure-ros_step=v1.sealed; Max-Age=600; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax",
    ]);
    // COOKIE_DOMAIN shares the sign-in cookies across hosts: a Domain rules out __Host-, so a Path=/ one keeps its plain
    // name; a host-only cookie ignores COOKIE_DOMAIN and keeps its prefix
    expect(await setCookies({ NODE_ENV: "production", COOKIE_DOMAIN: "app.example.test" }, "/set")).toEqual([
      "__Host-ros_root=v1.sealed; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax",
      "ros_shared=v1.sealed; Max-Age=600; Domain=app.example.test; Path=/; HttpOnly; Secure; SameSite=Lax",
      "__Secure-ros_scoped=v1.sealed; Max-Age=600; Path=/c/screen/abc; HttpOnly; Secure; SameSite=Lax",
      "__Secure-ros_step=v1.sealed; Max-Age=600; Domain=app.example.test; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax",
    ]);
  });

  it("over http (development and tests): the plain names, without Secure", async () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(await setCookies({ NODE_ENV }, "/set")).toEqual([
        "ros_root=v1.sealed; Max-Age=600; Path=/; HttpOnly; SameSite=Lax",
        "ros_shared=v1.sealed; Max-Age=600; Path=/; HttpOnly; SameSite=Lax",
        "ros_scoped=v1.sealed; Max-Age=600; Path=/c/screen/abc; HttpOnly; SameSite=Lax",
        "ros_step=v1.sealed; Max-Age=600; Path=/api/v1/auth; HttpOnly; SameSite=Lax",
      ]);
    }
  });

  it("reads only the name of the current mode: over https a cookie under the old name is ignored", async () => {
    const read = async (env: { NODE_ENV: string; COOKIE_DOMAIN?: string }, cookie: string) => (await (await appIn(env).request("/read", { headers: { cookie } })).json()) as Record<string, string | null>;
    const both = "ros_root=old; __Host-ros_root=new; ros_scoped=old; __Secure-ros_scoped=new; ros_shared=old; __Host-ros_shared=new";
    expect(await read({ NODE_ENV: "production" }, both)).toEqual({ ros_root: "new", ros_shared: "new", ros_scoped: "new", ros_step: null });
    expect(await read({ NODE_ENV: "production" }, "ros_root=old; ros_scoped=old; ros_shared=old; ros_step=old")).toEqual({ ros_root: null, ros_shared: null, ros_scoped: null, ros_step: null });
    // a planted __Host- cookie means nothing over http, where the plain name is the cookie
    expect(await read({ NODE_ENV: "test" }, both)).toEqual({ ros_root: "old", ros_shared: "old", ros_scoped: "old", ros_step: null });
    expect(await read({ NODE_ENV: "production", COOKIE_DOMAIN: "app.example.test" }, both)).toEqual({ ros_root: "new", ros_shared: "old", ros_scoped: "new", ros_step: null });
  });

  it("clears with the same name, path, domain and Secure flag it set with", async () => {
    expect(await setCookies({ NODE_ENV: "production", COOKIE_DOMAIN: "app.example.test" }, "/clear")).toEqual([
      "__Host-ros_root=; Max-Age=0; Path=/; Secure",
      "ros_shared=; Max-Age=0; Domain=app.example.test; Path=/; Secure",
      "__Secure-ros_scoped=; Max-Age=0; Path=/c/screen/abc; Secure",
      "__Secure-ros_step=; Max-Age=0; Domain=app.example.test; Path=/api/v1/auth; Secure",
    ]);
    expect(await setCookies({ NODE_ENV: "test" }, "/clear")).toEqual([
      "ros_root=; Max-Age=0; Path=/",
      "ros_shared=; Max-Age=0; Path=/",
      "ros_scoped=; Max-Age=0; Path=/c/screen/abc",
      "ros_step=; Max-Age=0; Path=/api/v1/auth",
    ]);
  });

  it("names the session cookie the same way for the API and the shell's middleware", () => {
    expect(cookieName("ros_session", { secure: true, path: "/" })).toBe("__Host-ros_session");
    expect(cookieName("ros_session", { secure: true, path: "/", domain: "app.example.test" })).toBe("ros_session");
    expect(cookieName("ros_mfa", { secure: true, path: "/api/v1/auth", domain: "app.example.test" })).toBe("__Secure-ros_mfa");
    expect(cookieName("ros_session", { secure: false, path: "/" })).toBe("ros_session");
    expect(sessionCookieName({ NODE_ENV: "production" })).toBe("__Host-ros_session");
    expect(sessionCookieName({ NODE_ENV: "production", COOKIE_DOMAIN: "" })).toBe("__Host-ros_session");
    expect(sessionCookieName({ NODE_ENV: "production", COOKIE_DOMAIN: "app.example.test" })).toBe("ros_session");
    expect(sessionCookieName({ NODE_ENV: "development" })).toBe("ros_session");
    expect(sessionCookieName({ NODE_ENV: "test" })).toBe("ros_session");
    expect(sessionCookieName({})).toBe("ros_session");
  });
});

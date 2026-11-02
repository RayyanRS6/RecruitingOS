import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cookieName } from "./cookie-names";
import type { Vars } from "./middleware/session";

/**
 * Setting, reading and clearing every cookie the application sets, by one rule (cookie-names.ts): httpOnly,
 * SameSite=Lax, Secure under NODE_ENV=production with the prefixed name that goes with it, and the same path and domain
 * each time, so a clear always reaches the cookie that was set. A `shared` cookie (the sign-in ones) goes to every host
 * COOKIE_DOMAIN names when that is set; every other cookie is host-only.
 */
export type CookiePlace = { path: string; shared?: boolean };

function placed(c: Context<Vars>, name: string, place: CookiePlace) {
  const env = c.get("container").env;
  const secure = env.NODE_ENV === "production";
  const domain = place.shared ? env.raw.COOKIE_DOMAIN || undefined : undefined;
  return { name: cookieName(name, { secure, path: place.path, domain }), options: { path: place.path, secure, ...(domain ? { domain } : {}) } };
}

export function setAppCookie(c: Context<Vars>, name: string, value: string, place: CookiePlace & { maxAge: number }): void {
  const at = placed(c, name, place);
  setCookie(c, at.name, value, { ...at.options, httpOnly: true, sameSite: "Lax", maxAge: place.maxAge });
}

export function readAppCookie(c: Context<Vars>, name: string, place: CookiePlace): string | undefined {
  return getCookie(c, placed(c, name, place).name);
}

export function clearAppCookie(c: Context<Vars>, name: string, place: CookiePlace): void {
  const at = placed(c, name, place);
  deleteCookie(c, at.name, at.options);
}

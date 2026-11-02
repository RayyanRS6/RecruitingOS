/**
 * What the application's cookies are called (audit SEC-25). Over https (NODE_ENV=production) every cookie the
 * application sets is Secure, and its name carries the prefix the browser enforces: "__Host-" for a host-only cookie on
 * Path=/, which only this host can set, only over https and never with a Domain, so a sibling subdomain (another
 * vendor's service under the same parent domain, for instance) can neither plant nor overwrite it; "__Secure-" for one
 * scoped to a narrower path, which only an https page can set. A Path=/ cookie that COOKIE_DOMAIN shares across hosts
 * cannot be "__Host-" and keeps its plain name. Over http (development and tests) no prefix is allowed and the plain
 * names stay. Only the current name is ever read: a cookie from before the prefix is ignored, so people sign in again.
 *
 * No imports: the shell's middleware (apps/shell/middleware.ts) names the session cookie by the same rule.
 */
export type CookieAt = { secure: boolean; path: string; domain?: string | null };

export function cookieName(name: string, at: CookieAt): string {
  if (!at.secure) return name;
  if (at.path !== "/") return `__Secure-${name}`;
  return at.domain ? name : `__Host-${name}`;
}

/** The session cookie: Path=/, and shared across the hosts COOKIE_DOMAIN names when that is set. */
export const SESSION_COOKIE = "ros_session";

/** The session cookie's name in a process's environment (Secure under NODE_ENV=production, like every cookie here). */
export function sessionCookieName(env: { NODE_ENV?: string; COOKIE_DOMAIN?: string }): string {
  return cookieName(SESSION_COOKIE, { secure: env.NODE_ENV === "production", path: "/", domain: env.COOKIE_DOMAIN });
}

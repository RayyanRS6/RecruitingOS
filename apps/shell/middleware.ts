import { NextResponse, type NextRequest } from "next/server";
import { buildAppCsp, cspHeaderName, cspMode, makeNonce } from "./lib/csp";

/** The session cookie's name (apps/api/src/middleware/session.ts), repeated here so the middleware bundle stays dependency-free. */
const SESSION_COOKIE = "ros_session";

/**
 * Every page of the authenticated application gets a per-request nonce and the content-security policy (21 Sep, item 6).
 * The mounted Hono surfaces (API, candidate pages, tracked links, webhooks, feeds, the sitemap and robots, the local
 * file stand-in) set their own headers and are excluded here, as are the self-hosted font files (`/fonts/`, from
 * public/fonts), which are static files that need no policy or nonce.
 * Next.js reads the nonce from the policy header on the request and stamps it on the scripts it emits.
 * Someone with no session who opens the bare address of Home sees the public welcome page (/welcome, October 2026
 * redesign) instead of the sign-in form; with a session cookie Home is unchanged, and an expired one still ends on
 * sign-in. A Home address with a query is a link from the app's own emails (`/?request=<id>`, `/?start=1`), so it goes on
 * to the sign-in form as before.
 */
export function middleware(req: NextRequest) {
  const nonce = makeNonce();
  const mode = cspMode(process.env.CSP_MODE);
  const csp = buildAppCsp({ nonce, dev: process.env.NODE_ENV !== "production", reportPath: "/api/csp-report" });
  const header = cspHeaderName(mode);
  if (req.nextUrl.pathname === "/" && req.nextUrl.search === "" && !req.cookies.has(SESSION_COOKIE)) {
    const away = NextResponse.redirect(new URL("/welcome", req.url));
    away.headers.set(header, csp);
    return away;
  }
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(header, csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(header, csp);
  return res;
}

export const config = {
  matcher: ["/((?!api/|c/|careers/|a/|files/|webhooks/|feeds/|dev/|privacy|healthz|sitemap.xml|robots.txt|fonts/|_next/static|_next/image|favicon.ico).*)"],
};

import { NextResponse, type NextRequest } from "next/server";
import { pkceCookieName, sessionCookieName } from "@ros/api/src/cookie-names";
import { isRefusalQuery, refusalCode } from "@ros/api/src/signin-refusal";
import { buildAppCsp, cspHeaderName, cspMode, makeNonce } from "./lib/csp";

/**
 * Every page of the authenticated application gets a per-request nonce and the content-security policy (21 Sep, item 6).
 * The mounted Hono surfaces (API, candidate pages, tracked links, webhooks, feeds, the sitemap and robots, the local
 * file stand-in) set their own headers and are excluded here, as are the self-hosted font files (`/fonts/`, from
 * public/fonts), which are static files that need no policy or nonce.
 * Next.js reads the nonce from the policy header on the request and stamps it on the scripts it emits.
 * Someone with no session who opens the bare address of Home sees the public welcome page (/welcome, October 2026
 * redesign) instead of the sign-in form; with a session cookie Home is unchanged, and an expired one still ends on
 * sign-in. A Home address with a query is a link from the app's own emails (`/?request=<id>`, `/?start=1`), so it goes on
 * to the sign-in form as before. The session cookie goes by the API's own rule ("__Host-ros_session" over https), from
 * apps/api/src/cookie-names.ts, which imports nothing, so the middleware bundle stays dependency-free.
 * A refusal the identity service could not tie to a sign-in (its record of the flow expired or missing, as after more than
 * five minutes on Microsoft's approval screen) lands on the root with error, error_code and error_description in the query
 * and no code (10 November 2026): it goes to the sign-in page as the code the callback would give it (signin-refusal.ts,
 * which imports nothing either), with a trailing "#" so the service's copy in the fragment goes too. Its words never stay
 * in the address, and nothing here logs them.
 */
export function middleware(req: NextRequest) {
  const nonce = makeNonce();
  const mode = cspMode(process.env.CSP_MODE);
  const csp = buildAppCsp({ nonce, dev: process.env.NODE_ENV !== "production", reportPath: "/api/csp-report" });
  const header = cspHeaderName(mode);
  const cookieEnv = { NODE_ENV: process.env.NODE_ENV, COOKIE_DOMAIN: process.env.COOKIE_DOMAIN };
  if (req.nextUrl.pathname === "/" && isRefusalQuery(req.nextUrl.searchParams)) {
    const q = req.nextUrl.searchParams;
    // the provider this browser's sign-in started with, as the callback reads it: `verifier.state.provider`
    const provider = req.cookies.get(pkceCookieName(cookieEnv))?.value.split(".")[2] ?? null;
    const { code } = refusalCode({ error: q.get("error"), errorCode: q.get("error_code"), errorSubcode: q.get("error_subcode"), description: q.get("error_description"), provider });
    const toSignIn = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(code)}#`, req.url));
    toSignIn.headers.set(header, csp);
    return toSignIn;
  }
  const sessionCookie = sessionCookieName(cookieEnv);
  if (req.nextUrl.pathname === "/" && req.nextUrl.search === "" && !req.cookies.has(sessionCookie)) {
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

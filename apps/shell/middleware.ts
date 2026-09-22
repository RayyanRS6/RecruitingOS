import { NextResponse, type NextRequest } from "next/server";
import { buildAppCsp, cspHeaderName, cspMode, makeNonce } from "./lib/csp";

/**
 * Every page of the authenticated application gets a per-request nonce and the content-security policy (21 Sep, item 6).
 * The mounted Hono surfaces (API, candidate pages, webhooks, feeds) set their own headers and are excluded here.
 * Next.js reads the nonce from the policy header on the request and stamps it on the scripts it emits.
 */
export function middleware(req: NextRequest) {
  const nonce = makeNonce();
  const mode = cspMode(process.env.CSP_MODE);
  const csp = buildAppCsp({ nonce, dev: process.env.NODE_ENV !== "production", reportPath: "/api/csp-report" });
  const header = cspHeaderName(mode);
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(header, csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set(header, csp);
  return res;
}

export const config = {
  matcher: ["/((?!api/|c/|careers/|webhooks/|feeds/|dev/|privacy|healthz|_next/static|_next/image|favicon.ico).*)"],
};

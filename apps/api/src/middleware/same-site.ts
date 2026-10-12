import type { Context, MiddlewareHandler } from "hono";
import { maskTokenPath } from "@ros/core";
import type { Env } from "../env";
import { HttpError } from "./errors";
import type { Vars } from "./session";

/**
 * Cross-site requests to the API (security review, 11 October 2026). The session cookie is SameSite=Lax, which keeps it
 * off another site's form posts; this adds what the browser itself says about where a request came from, so a page on
 * another site, or on a sibling host of the same site (which does receive a Lax cookie), cannot change anything under
 * /api. A change (POST, PUT, PATCH, DELETE) is refused with 403 `cross_site` when Sec-Fetch-Site says "cross-site", or
 * when an Origin header names an address other than this deployment's own (APP_BASE_URL, and JOBS_BASE_URL once the
 * job pages have their own host). A request with neither header passes: older browsers send no fetch metadata, and a
 * caller that is not a browser still needs the session cookie, which the browser withholds from another site.
 *
 * Nothing under /api is exempt; nothing there is posted to from elsewhere by design. The sign-in and calendar callbacks
 * are GET, webhooks live under /webhooks, and every form the API serves (the sign-in link, the invitation, the second
 * factor, the development consent pages) and the policy reports post from this deployment's own pages.
 */
export type SiteEnv = Pick<Env, "APP_BASE_URL" | "JOBS_BASE_URL">;

const CHANGES = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const FETCH_SITES = new Set(["same-origin", "same-site", "none"]);

export const CROSS_SITE_MESSAGE = "This request came from another website, so nothing was changed. Open the app at its usual address and try again.";

/** The origins this deployment serves pages from: the app's address and the job-page host (the same one until a second domain is attached). */
export function ownOrigins(env: SiteEnv): Set<string> {
  const origins = new Set<string>();
  for (const url of [env.APP_BASE_URL, env.JOBS_BASE_URL]) {
    try {
      origins.add(new URL(url).origin);
    } catch {
      // an address that does not parse names no origin (production refuses one at boot)
    }
  }
  return origins;
}

/**
 * Whether the browser says a request came from this deployment's own pages; also checked by the second-factor step's
 * own posts (routes/auth-mfa.tsx). An opaque origin ("null") names no site, so it passes only when Sec-Fetch-Site says
 * same-origin: a sandboxed frame or a no-referrer page on a sibling host sends `Origin: null` too, and from a browser
 * without fetch metadata it would otherwise pass with the Lax cookie. The API's own form pages keep their real origin on
 * their posts (formPageReferrer below).
 */
export function fromThisSite(c: Context, env: SiteEnv): boolean {
  const site = c.req.header("sec-fetch-site");
  if (site && !FETCH_SITES.has(site)) return false;
  const origin = c.req.header("origin");
  if (!origin) return true;
  if (origin === "null") return site === "same-origin";
  return ownOrigins(env).has(origin);
}

/** The pages under /api whose forms post back to /api: the second factor, the sign-in link, the invitation, and the development consent pages. */
export const API_FORM_PAGES = ["/api/v1/auth/mfa", "/api/v1/auth/mfa/*", "/api/v1/auth/consume", "/api/v1/auth/invite", "/api/v1/auth/invite/*", "/api/v1/auth/fake/authorize", "/api/v1/integrations/calendar/fake/authorize"];

/**
 * Hono's `Referrer-Policy: no-referrer` makes a browser post a page's own forms with `Origin: null`, which a browser
 * without fetch metadata cannot vouch for; `same-origin` keeps the real origin on the page's own posts and still sends
 * nothing to another site. Mounted before secureHeaders (app.ts), so its value is the one that stays.
 */
export const formPageReferrer: MiddlewareHandler<Vars> = async (c, next) => {
  await next();
  c.res.headers.set("Referrer-Policy", "same-origin");
};

/** Refuses a change under /api that a browser says came from another site. Runs before the session is read, so a refused request costs no database work. */
export function sameSiteChanges(env: SiteEnv): MiddlewareHandler<Vars> {
  return async (c, next) => {
    if (CHANGES.has(c.req.method) && !fromThisSite(c, env)) {
      console.warn(`[same-site] refused ${c.req.method} ${maskTokenPath(c.req.path)}: sec-fetch-site ${c.req.header("sec-fetch-site") ?? "absent"}, origin ${c.req.header("origin") ?? "absent"}`);
      throw new HttpError(403, "cross_site", CROSS_SITE_MESSAGE);
    }
    await next();
  };
}

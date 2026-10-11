/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { isCompanyVerified } from "@ros/contracts";
import { findLinkByToken, isLinkPreviewBot, isSource, openPayload, recordLinkVisit, sealPayload, type ApplicationSource } from "@ros/core";
import { companies, roles, withPlatform } from "@ros/db";
import type { Vars } from "../middleware/session";
import { jobUrls } from "../services/job-urls";
import { Layout } from "./layout";

/**
 * Tracked application links (docs/spec/20 items 7, 8 and 19). A board, a referrer or a campaign gets a short random
 * token; `/a/:token` counts the visit, seals the link's source into a cookie the browser cannot read, and sends the
 * person to the job page (a shared link) or the apply page (a board's link). The token never reaches a candidate-facing record: the apply page resolves the
 * cookie into a source, a detail and the link's id, and clears it once the application is in.
 */
export const linkPages = new Hono<Vars>();

export const SOURCE_COOKIE = "ros_src";
export const SOURCE_COOKIE_TTL_MS = 30 * 86_400_000;
const SOURCE_PURPOSE = "application-source";

export type ApplicationSourcePayload = { v: 1; linkId: string; source: ApplicationSource; sourceDetail: string | null; roleId: string; exp: number };

function sourceCookieOptions(c: Context<Vars>) {
  // Host-only on purpose: the link and the apply page live on the same job-page host, and a host-only cookie works whatever COOKIE_DOMAIN says.
  return { httpOnly: true, sameSite: "Lax" as const, secure: c.get("container").env.NODE_ENV === "production", path: "/", maxAge: SOURCE_COOKIE_TTL_MS / 1000 };
}

/** The source the apply page records: the sealed cookie when it names this role, otherwise the careers page with no detail. */
export function resolveApplicationSource(c: Context<Vars>, roleId: string): { source: ApplicationSource; sourceDetail: string | null; linkId: string | null } {
  const container = c.get("container");
  const payload = openPayload<ApplicationSourcePayload>(SOURCE_PURPOSE, getCookie(c, SOURCE_COOKIE), container.env.SESSION_SECRET, container.engine.clock().getTime());
  if (payload?.v === 1 && payload.roleId === roleId && typeof payload.linkId === "string" && isSource(payload.source)) {
    return { source: payload.source, sourceDetail: payload.sourceDetail ?? null, linkId: payload.linkId };
  }
  return { source: "careers_page", sourceDetail: null, linkId: null };
}

/** After a successful submission the cookie has done its work; a later application from the same browser starts clean. */
export function clearApplicationSource(c: Context<Vars>): void {
  deleteCookie(c, SOURCE_COOKIE, { path: "/" });
}

function NotActive() {
  return (
    <Layout title="This link is not active">
      <h1>This link is not active</h1>
      <p>The application link you followed is no longer in use, or was copied incompletely. Search for the employer's careers page to find the position, or go back to where you found this link.</p>
    </Layout>
  );
}

linkPages.get("/a/:token", async (c) => {
  const container = c.get("container");
  const token = c.req.param("token") ?? "";
  const now = container.engine.clock();
  // A link pasted into a chat or a post is fetched by that app for its preview card before anyone clicks it (plan D8):
  // such fetches are sent to the job page, never counted and never given the cookie.
  const bot = isLinkPreviewBot(c.req.header("user-agent"));
  // The redirect knows no tenant yet: the token is looked up through the platform role and the visit counted there.
  const found = await withPlatform(container.db, async (tx) => {
    const link = await findLinkByToken(tx, token);
    if (!link || link.disabledAt) return null;
    const [company] = await tx.select({ slug: companies.slug, settings: companies.settings }).from(companies).where(eq(companies.id, link.companyId)).limit(1);
    const [role] = await tx.select({ status: roles.status, acceptingApplications: roles.acceptingApplications }).from(roles).where(eq(roles.id, link.roleId)).limit(1);
    // A company ITS has not confirmed has no public pages (founder decision B7): its links lead nowhere and count nothing.
    if (!company || !role || !isCompanyVerified(company.settings)) return null;
    if (!bot && c.req.method === "GET") await recordLinkVisit(tx, link.id, now);
    return { link, slug: company.slug, accepting: role.status === "open" && role.acceptingApplications };
  });
  if (!found) return c.html(<NotActive />, 404);
  const { link } = found;
  const urls = jobUrls(container.env, { slug: found.slug, roleId: link.roleId });
  if (bot) return c.redirect(urls.job, 302);
  const payload: ApplicationSourcePayload = { v: 1, linkId: link.id, source: link.source as ApplicationSource, sourceDetail: link.sourceDetail, roleId: link.roleId, exp: now.getTime() + SOURCE_COOKIE_TTL_MS };
  setCookie(c, SOURCE_COOKIE, sealPayload(SOURCE_PURPOSE, payload, container.env.SESSION_SECRET), sourceCookieOptions(c));
  // A shared link opens the job page first; a board's link goes straight to the form, since the board already showed the
  // job. A role that is not taking applications sends everyone to the job page, which says so, instead of a 404 on the form.
  return c.redirect(found.accepting && link.landing === "apply" ? urls.apply : urls.job, 302);
});

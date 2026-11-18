import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { trialPaused } from "@ros/contracts";
import { companies, roles, withPlatform } from "@ros/db";
import type { Container } from "../container";
import type { Vars } from "../middleware/session";
import { jobUrls } from "../services/job-urls";

/**
 * What search engines read: the sitemap and the robots file. Every URL is built from JOBS_BASE_URL; only open jobs
 * that take applications are listed; public addresses only, never a candidate. The sitemap is rebuilt at most once
 * every five minutes per process.
 */
export const sitemapPages = new Hono<Vars>();

export const SITEMAP_CACHE_MS = 5 * 60_000;

type Listing = { roleId: string; updatedAt: string; slug: string };

type Cached = { at: number; body: string };
const caches = new WeakMap<Container, Cached>();

/** Forgets this container's cached sitemap (tests, and a change that takes a company's pages off the web at once). */
export function resetSitemapCache(container: Container): void {
  caches.delete(container);
}

/**
 * Open jobs that take applications, of companies ITS has confirmed (an unconfirmed company is in no sitemap). A
 * company whose trial has ended takes no new applications, so its jobs leave the sitemap too. Platform read: the
 * sitemap spans every company.
 */
async function listings(container: Container): Promise<Listing[]> {
  const rows = await withPlatform(container.db, (tx) =>
    tx
      .select({ roleId: roles.id, updatedAt: roles.updatedAt, slug: companies.slug, companySettings: companies.settings, planKey: companies.planKey })
      .from(roles)
      .innerJoin(companies, eq(companies.id, roles.companyId))
      .where(and(eq(roles.status, "open"), eq(roles.acceptingApplications, true), sql`coalesce(${companies.settings}->>'verifiedAt', '') <> ''`))
      .orderBy(roles.openedAt),
  );
  const now = container.engine.clock();
  return rows.filter((r) => !trialPaused({ planKey: r.planKey, settings: r.companySettings }, now)).map((r) => ({ roleId: r.roleId, updatedAt: r.updatedAt, slug: r.slug }));
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Careers pages of companies with at least one listed job, then every listed job page, each with its last change. */
export function sitemapXml(env: Container["env"], rows: Listing[]): string {
  const careers = new Map<string, { loc: string; lastmod: string }>();
  const jobs: Array<{ loc: string; lastmod: string }> = [];
  for (const r of rows) {
    const urls = jobUrls(env, { slug: r.slug, roleId: r.roleId });
    const lastmod = new Date(r.updatedAt).toISOString();
    const page = careers.get(r.slug);
    if (!page || page.lastmod < lastmod) careers.set(r.slug, { loc: urls.careers, lastmod });
    jobs.push({ loc: urls.job, lastmod });
  }
  const entries = [...careers.values(), ...jobs].map((u) => `  <url>\n    <loc>${xmlText(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}

/**
 * Only the production deployment lets crawlers in, to the careers and job pages, and names the sitemap. Staging, a
 * person's machine and the tests keep every crawler out with no sitemap; hosted staging also sends X-Robots-Tag on
 * every response (apps/shell/next.config.ts).
 */
export function robotsTxt(env: Container["env"]): string {
  if (env.DEPLOY_ENV !== "production") return ["User-agent: *", "Disallow: /", ""].join("\n");
  return ["User-agent: *", "Allow: /careers/", "Disallow: /c/", "Disallow: /api/", "Disallow: /files/", "Disallow: /dev/", "Disallow: /webhooks/", "", `Sitemap: ${env.JOBS_BASE_URL}/sitemap.xml`, ""].join("\n");
}

sitemapPages.get("/sitemap.xml", async (c) => {
  const container = c.get("container");
  const now = container.engine.clock().getTime();
  const hit = caches.get(container);
  let body = hit && now - hit.at < SITEMAP_CACHE_MS && now >= hit.at ? hit.body : null;
  if (body === null) {
    body = sitemapXml(container.env, await listings(container));
    caches.set(container, { at: now, body });
  }
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
});

sitemapPages.get("/robots.txt", (c) => c.body(robotsTxt(c.get("container").env), 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }));
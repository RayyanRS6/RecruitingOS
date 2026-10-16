import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { trialPaused } from "@ros/contracts";
import { jobNoticesFor } from "@ros/core";
import { companies, rolePackets, roles, withPlatform } from "@ros/db";
import { jobFeedJson, jobFeedXml, jobValidThrough, linkedInFeedXml, schemaEmploymentType, type FeedJob } from "@ros/integrations";
import type { Container } from "../container";
import type { Vars } from "../middleware/session";
import { jobUrls } from "../services/job-urls";
import { payShown } from "./job-facts";

/**
 * The public job surfaces search engines and approved boards read (docs/spec/20 items 5 and 6): the sitemap, the
 * robots file, the common job-board XML feed, the same listings as JSON, and the LinkedIn Basic Jobs feed. Every URL
 * is built from JOBS_BASE_URL; only open roles that accept applications are listed, with the client company named as
 * the employer; public job data only, never a candidate or a tracking token. Each document is rebuilt at most once
 * every five minutes per process. The fields and the cadence are documented in docs/15-integrations.md.
 */
export const publicFeeds = new Hono<Vars>();

export const PUBLIC_FEED_CACHE_MS = 5 * 60_000;

type Listing = { roleId: string; title: string; updatedAt: string; datePosted: string; companyName: string; slug: string; vertical: string; packet: typeof rolePackets.$inferSelect.packet; /** The pay range is listed, by the same rule as the job page (pages/job-facts.tsx). */ showPay: boolean; /** The role's closing date (plan D7), when it has one. */ closesOn: string | null };

type Cached = { at: number; body: string };
const caches = new WeakMap<Container, Map<string, Cached>>();

/** Forgets every cached document of this container (tests, and a deployment that wants a fresh build on demand). */
export function resetPublicFeedCache(container: Container): void {
  caches.delete(container);
}

async function cached(container: Container, key: string, build: () => Promise<string>): Promise<string> {
  const now = container.engine.clock().getTime();
  let store = caches.get(container);
  if (!store) {
    store = new Map();
    caches.set(container, store);
  }
  const hit = store.get(key);
  if (hit && now - hit.at < PUBLIC_FEED_CACHE_MS && now >= hit.at) return hit.body;
  const body = await build();
  store.set(key, { at: now, body });
  return body;
}

/**
 * Open roles that accept applications, with the approved packet the role currently runs on, of companies ITS has
 * confirmed (founder decision B7: an unconfirmed company is in no feed and no sitemap). A company whose trial has ended
 * (founder decision L-02 B) takes no new applications, so its jobs leave the feeds and the sitemap too. Platform read:
 * the feeds span every company.
 */
async function listings(container: Container): Promise<Listing[]> {
  const rows = await withPlatform(container.db, (tx) =>
    tx
      .select({ roleId: roles.id, title: roles.title, updatedAt: roles.updatedAt, openedAt: roles.openedAt, createdAt: roles.createdAt, closesOn: roles.applicationsCloseOn, companyName: companies.name, slug: companies.slug, vertical: companies.vertical, companyLocations: companies.locations, companySettings: companies.settings, planKey: companies.planKey, packet: rolePackets.packet })
      .from(roles)
      .innerJoin(companies, eq(companies.id, roles.companyId))
      .innerJoin(rolePackets, and(eq(rolePackets.roleId, roles.id), eq(rolePackets.version, roles.currentPacketVersion)))
      .where(and(eq(roles.status, "open"), eq(roles.acceptingApplications, true), sql`coalesce(${companies.settings}->>'verifiedAt', '') <> ''`))
      .orderBy(roles.openedAt),
  );
  const now = container.engine.clock();
  return rows.filter((r) => !trialPaused({ planKey: r.planKey, settings: r.companySettings }, now)).map((r) => {
    const notices = jobNoticesFor({ jobLocations: r.packet.identity.locations, companyLocations: r.companyLocations, overrides: r.companySettings.notices });
    return { roleId: r.roleId, title: r.title, updatedAt: r.updatedAt, datePosted: (r.openedAt ?? r.createdAt).slice(0, 10), companyName: r.companyName, slug: r.slug, vertical: r.vertical, packet: r.packet, showPay: payShown(r.packet, notices), closesOn: r.closesOn ?? null };
  });
}

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Careers pages of companies with at least one listed role, then every listed job page, each with its last change. */
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

export function robotsTxt(env: Container["env"]): string {
  return ["User-agent: *", "Allow: /careers/", "Disallow: /c/", "Disallow: /api/", "Disallow: /a/", "Disallow: /files/", "Disallow: /dev/", "Disallow: /webhooks/", "", `Sitemap: ${env.JOBS_BASE_URL}/sitemap.xml`, ""].join("\n");
}

function feedJob(env: Container["env"], r: Listing): FeedJob {
  const urls = jobUrls(env, { slug: r.slug, roleId: r.roleId });
  const p = r.packet;
  const loc = p.identity.locations[0];
  const comp = p.compensation;
  return {
    referenceNumber: r.roleId,
    title: p.identity.title,
    url: urls.job,
    applyUrl: urls.apply,
    company: r.companyName,
    city: loc?.city,
    state: loc?.region,
    country: loc?.country ?? "US",
    postalCode: loc?.postalCode,
    description: p.description.publicJobDescription,
    datePosted: r.datePosted,
    // A listed role is open and taking applications, so it has no stop date: the feed carries its closing date when it
    // has one (plan D7), and otherwise no expiration date rather than an invented one (Wave 0 item 0.8).
    validThrough: jobValidThrough({ closesOn: r.closesOn }),
    employmentType: schemaEmploymentType(p.identity.employmentType),
    salary: r.showPay ? { min: comp.min, max: comp.max, currency: comp.currency, basis: comp.basis } : null,
    category: r.vertical,
    remote: p.identity.remotePolicy === "remote",
  };
}

function feedMeta(container: Container) {
  return { publisher: container.env.PRODUCT_NAME, publisherUrl: container.env.JOBS_BASE_URL, lastBuildDate: container.engine.clock() };
}

publicFeeds.get("/sitemap.xml", async (c) => {
  const container = c.get("container");
  const body = await cached(container, "sitemap", async () => sitemapXml(container.env, await listings(container)));
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
});

publicFeeds.get("/robots.txt", (c) => c.body(robotsTxt(c.get("container").env), 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }));

publicFeeds.get("/feeds/jobs.xml", async (c) => {
  const container = c.get("container");
  const body = await cached(container, "jobs.xml", async () => jobFeedXml((await listings(container)).map((r) => feedJob(container.env, r)), feedMeta(container)));
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
});

publicFeeds.get("/feeds/jobs.json", async (c) => {
  const container = c.get("container");
  const body = await cached(container, "jobs.json", async () => JSON.stringify(jobFeedJson((await listings(container)).map((r) => feedJob(container.env, r)), feedMeta(container))));
  return c.body(body, 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" });
});

/** LinkedIn Basic Jobs: the same listings in LinkedIn's XML, the publisher URL set and each job pointing at its canonical page on the job host. */
publicFeeds.get("/feeds/linkedin.xml", async (c) => {
  const container = c.get("container");
  const body = await cached(container, "linkedin.xml", async () =>
    linkedInFeedXml(
      (await listings(container)).map((r) => {
        const loc = r.packet.identity.locations[0];
        const comp = r.packet.compensation;
        return {
          partnerJobId: r.roleId,
          company: r.companyName,
          title: r.packet.identity.title,
          description: r.packet.description.publicJobDescription,
          location: [loc?.city, loc?.region, loc?.country ?? "US"].filter(Boolean).join(", "),
          applyUrl: jobUrls(container.env, { slug: r.slug, roleId: r.roleId }).job,
          salaryText: r.showPay ? `${comp.max} ${comp.currency} ${comp.basis}` : undefined,
        };
      }),
      { publisherUrl: container.env.JOBS_BASE_URL, lastBuildDate: container.engine.clock() },
    ),
  );
  return c.body(body, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300" });
});

import { readdirSync } from "node:fs";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { describe, expect, it } from "vitest";
import config from "../next.config";
import { config as middleware } from "../middleware";
import { buildAppCsp } from "./csp";

/**
 * No other site may frame the application's pages (X-Frame-Options DENY beside the policy's frame-ancestors 'none'), and
 * the paths mounted on Hono keep the one value Hono sets: Next.js keeps a configured header over a route's own, so DENY
 * there would also break the résumé the candidate panel frames from /api, and a referrer policy there would replace the
 * one the API's form pages rely on (Origin on their posts, apps/api/src/middleware/same-site.ts). A rule is matched by the
 * regular expression a build writes for it to the routes manifest; the mounts (app/<mount>/route.ts) and the pages
 * (page.tsx) are read from app/.
 */
const files = readdirSync(new URL("../app/", import.meta.url), { recursive: true, encoding: "utf8" }).map((f) => f.replace(/\\/g, "/"));
const mounts = files.filter((f) => f.endsWith("/route.ts")).map((f) => {
  const dir = f.slice(0, -"/route.ts".length);
  const catchAll = dir.endsWith("/[[...route]]");
  return { path: `/${catchAll ? dir.slice(0, -"/[[...route]]".length) : dir}`, catchAll };
});
// a page's address: route groups such as (app) drop out, and a dynamic segment such as [id] gets a sample value
const pages = files.filter((f) => f === "page.tsx" || f.endsWith("/page.tsx")).map((f) => `/${f.split("/").slice(0, -1).filter((s) => !/^\(.*\)$/.test(s)).map((s) => (s.startsWith("[") ? "123" : s)).join("/")}`);

describe("framing of the application's pages", () => {
  it("sends X-Frame-Options DENY from one rule only, on every page and on no path mounted on Hono", async () => {
    const rules = (await config.headers?.()) ?? [];
    const framing = rules.filter((r) => r.headers.some((h) => h.key.toLowerCase() === "x-frame-options"));
    expect(framing).toHaveLength(1);
    expect(framing[0].headers).toContainEqual({ key: "X-Frame-Options", value: "DENY" });
    const framed = new RegExp(buildCustomRoute("header", framing[0]).regex);

    // the walk found both kinds of mount and the pages
    expect(mounts).toContainEqual({ path: "/api", catchAll: true });
    expect(mounts).toContainEqual({ path: "/healthz", catchAll: false });
    expect(pages).toEqual(expect.arrayContaining(["/", "/login", "/roles/123", "/admin", "/recruiter/queue/123", "/setup/company"]));
    // the console's sections, each its own page (Wave S6); /admin/privacy is the console's, not the mounted /privacy
    expect(pages).toEqual(expect.arrayContaining(["/admin/customers", "/admin/privacy", "/admin/problems", "/admin/system"]));

    for (const m of mounts) {
      for (const path of m.catchAll ? [m.path, `${m.path}/`, `${m.path}/v1/x`] : [m.path]) expect(framed.test(path), path).toBe(false);
    }
    // the résumé inside the candidate panel (plan H5): Hono answers it with SAMEORIGIN, and nothing here may replace that
    expect(framed.test("/api/v1/applications/a1/documents/d1/inline")).toBe(false);
    for (const path of pages) expect(framed.test(path), path).toBe(true);
    // the not-found page, and paths that only begin like a mount, are the application's
    for (const path of ["/no-such-page", "/apiary", "/companies", "/careersite", "/privacy-old", "/healthz-check", "/sitemap.xml.bak"]) expect(framed.test(path), path).toBe(true);
  });

  it("on a path mounted on Hono no rule sends a header Hono sets itself with another value; the referrer policy stays Hono's", async () => {
    const rules = (await config.headers?.()) ?? [];
    // what every Hono response carries (apps/api/src/app.ts mounts secureHeaders on every path)
    const hono = (await new Hono().use(secureHeaders()).get("/", (c) => c.text("")).request("/")).headers;
    expect(hono.get("referrer-policy")).toBe("no-referrer");
    const samples = mounts.flatMap((m) => (m.catchAll ? [m.path, `${m.path}/v1/x`] : [m.path]));
    for (const rule of rules) {
      const matches = new RegExp(buildCustomRoute("header", rule).regex);
      for (const path of samples.filter((p) => matches.test(p))) {
        for (const { key, value } of rule.headers) {
          const own = hono.get(key);
          if (own !== null) expect(value, `${key} on ${path}`).toBe(own);
        }
      }
    }
    // the application's pages keep the shell's own referrer policy, from one rule
    const referrer = rules.filter((r) => r.headers.some((h) => h.key.toLowerCase() === "referrer-policy"));
    expect(referrer).toHaveLength(1);
    const covered = new RegExp(buildCustomRoute("header", referrer[0]).regex);
    for (const path of pages) expect(covered.test(path), path).toBe(true);
    expect(covered.test("/api/v1/auth/mfa")).toBe(false);
  });

  it("every page also carries the policy's frame-ancestors 'none'", () => {
    const covered = new RegExp(`^${middleware.matcher[0]}$`);
    for (const path of pages) expect(covered.test(path), path).toBe(true);
    expect(buildAppCsp({ nonce: "n", dev: false })).toContain("frame-ancestors 'none'");
  });
});

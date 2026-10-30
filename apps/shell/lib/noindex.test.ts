import { buildCustomRoute } from "next/dist/lib/build-custom-route";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../next.config";

/**
 * GAP3-3: a hosted deployment that is not production (a Vercel Preview deployment, which is staging, or
 * DEPLOY_ENV=staging) asks search engines to index nothing it serves: X-Robots-Tag on every path, the application's
 * pages, the paths mounted on Hono and the static files alike. Production, a person's machine and the tests send none.
 * A rule is matched by the regular expression a build writes for it to the routes manifest.
 */
describe("staging stays out of search engines", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const noindexRules = async (env: { VERCEL_ENV: string; DEPLOY_ENV: string }) => {
    vi.stubEnv("VERCEL_ENV", env.VERCEL_ENV);
    vi.stubEnv("DEPLOY_ENV", env.DEPLOY_ENV);
    return ((await config.headers?.()) ?? []).filter((r) => r.headers.some((h) => h.key.toLowerCase() === "x-robots-tag"));
  };
  // pages, paths mounted on Hono (pages/preview.tsx sends the same value itself, so Next.js keeping its own changes nothing), files
  const paths = ["/", "/welcome", "/login", "/roles/123", "/admin/system", "/careers/brightline/jobs/1", "/c/status/x", "/a/abcdefghijkl", "/api/v1/auth/me", "/api/v1/roles/1/preview", "/healthz", "/privacy", "/robots.txt", "/sitemap.xml", "/feeds/jobs.xml", "/webhooks/postmark/inbound", "/fonts/ibm-plex-sans-latin-400-normal.woff2", "/_next/static/chunks/main.js", "/no-such-page"];

  for (const env of [{ VERCEL_ENV: "preview", DEPLOY_ENV: "" }, { VERCEL_ENV: "", DEPLOY_ENV: "staging" }, { VERCEL_ENV: "preview", DEPLOY_ENV: "staging" }]) {
    it(`sends X-Robots-Tag: noindex, nofollow on every path (VERCEL_ENV=${env.VERCEL_ENV || "unset"}, DEPLOY_ENV=${env.DEPLOY_ENV || "unset"})`, async () => {
      const rules = await noindexRules(env);
      expect(rules).toHaveLength(1);
      expect(rules[0].headers).toEqual([{ key: "X-Robots-Tag", value: "noindex, nofollow" }]);
      const covered = new RegExp(buildCustomRoute("header", rules[0]).regex);
      for (const path of paths) expect(covered.test(path), path).toBe(true);
    });
  }

  it("sends none on the production deployment, on a person's machine or in the tests", async () => {
    for (const env of [{ VERCEL_ENV: "production", DEPLOY_ENV: "" }, { VERCEL_ENV: "", DEPLOY_ENV: "production" }, { VERCEL_ENV: "production", DEPLOY_ENV: "production" }, { VERCEL_ENV: "development", DEPLOY_ENV: "" }, { VERCEL_ENV: "", DEPLOY_ENV: "" }]) {
      expect(await noindexRules(env), JSON.stringify(env)).toEqual([]);
    }
  });
});

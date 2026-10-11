import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NextConfig } from "next";

// The API and the database package resolve data paths from the workspace root; a bundler rewrites import.meta.url, so say it explicitly.
const repoRoot = (() => { let d = process.cwd(); for (let i = 0; i < 6; i++) { if (existsSync(join(d, "pnpm-workspace.yaml"))) return d; d = dirname(d); } return resolve(process.cwd(), "../.."); })();
process.env.ROS_REPO_ROOT ??= repoRoot;
process.env.ROS_MIGRATIONS_DIR ??= join(repoRoot, "packages", "db", "migrations");

/**
 * Every path except the ones mounted on Hono (app/<mount>/route.ts): the catch-all mounts with anything below them, the
 * single routes exactly. Hono sets those responses' headers itself, and Next.js keeps a configured header over the one a
 * route sets, so a header meant for the application's pages must not reach them.
 */
const appPages = "/((?!(?:api|c|careers|a|files|webhooks|feeds|dev)(?:/|$)|(?:privacy|healthz|sitemap\\.xml|robots\\.txt)$).*)";

/**
 * The application shell on Vercel (decision D20, slice 5 step 5). One Next.js app serves the owner, recruiter and admin
 * interface and mounts the existing Hono API and candidate pages under catch-all route handlers, so the API code is
 * retained unchanged. Workspace packages are TypeScript sources and are transpiled here; native database drivers stay
 * external so they load at runtime.
 */
const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ros/api", "@ros/web", "@ros/ui", "@ros/core", "@ros/db", "@ros/contracts", "@ros/integrations", "@ros/workflows", "@ros/agents", "@ros/ai", "@ros/playbooks"],
  serverExternalPackages: ["@electric-sql/pglite", "pg", "@anthropic-ai/sdk"],
  // Production boot compares the database with the migration files (a release migrates first, docs/14), so the SQL
  // files ship with every server function. Traced from the workspace root, they land at
  // /var/task/packages/db/migrations on Vercel, where the database package finds them walking up from the app.
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: { "/**": ["../../packages/db/migrations/*.sql"] },
  poweredByHeader: false,
  // Candidate pages set their own headers inside Hono; the shell adds nothing that could leak. The self-hosted font
  // files (public/fonts, scripts/fetch-fonts.ts) are kept by browsers for a year: a changed font needs a new file name.
  // No other site may frame the application's pages: X-Frame-Options says what the policy's frame-ancestors 'none' says,
  // and holds while CSP_MODE is report-only. DENY, because nothing frames these pages; the résumé framed in the candidate
  // panel is an /api response, which Hono sends with SAMEORIGIN. The referrer policy is the application's pages' too:
  // Hono's own (no-referrer on candidate pages, same-origin on the API's form pages) must reach the browser unchanged.
  headers: async () => [
    { source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }] },
    { source: appPages, headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] },
    { source: "/fonts/:file*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
  ],
};

export default config;

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { NextConfig } from "next";

// The API and the database package resolve data paths from the workspace root; a bundler rewrites import.meta.url, so say it explicitly.
const repoRoot = (() => { let d = process.cwd(); for (let i = 0; i < 6; i++) { if (existsSync(join(d, "pnpm-workspace.yaml"))) return d; d = dirname(d); } return resolve(process.cwd(), "../.."); })();
process.env.ROS_REPO_ROOT ??= repoRoot;
process.env.ROS_MIGRATIONS_DIR ??= join(repoRoot, "packages", "db", "migrations");

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
  // Candidate pages set their own headers inside Hono; the shell adds nothing that could leak.
  headers: async () => [{ source: "/(.*)", headers: [{ key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }] }],
};

export default config;

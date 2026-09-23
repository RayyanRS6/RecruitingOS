import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Browser journeys and accessibility checks (slice 5 step 10) against the Next.js shell on an in-memory database with
 * every provider faked: sign-in, calendar, email, AI. Nothing leaves the machine.
 */
const repoRoot = (() => { let d = process.cwd(); for (let i = 0; i < 6; i++) { if (existsSync(join(d, "pnpm-workspace.yaml"))) return d; d = dirname(d); } return resolve(process.cwd(), "../.."); })();
const port = Number(process.env.E2E_PORT ?? 3010);
const base = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // One retry on CI only: the journeys run against `next dev`, which occasionally resets a connection while it compiles a
  // route (seen 22 Sep 2026 as ECONNRESET on a documentation-only commit). Locally a failure must fail.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: { baseURL: base, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium" }, testMatch: /routes\.spec\.ts/ },
  ],
  webServer: {
    command: `pnpm --filter @ros/shell exec next dev -p ${port}`,
    cwd: repoRoot,
    url: `${base}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // The dev server restarts itself when the V8 heap passes 80% of its limit (next/dist/server/lib/start-server.js),
      // which would wipe the in-memory database mid-run; give it a limit the runner can afford.
      NODE_OPTIONS: "--max-old-space-size=6144",
      NODE_ENV: "development", PGLITE_DIR: "memory://", APP_BASE_URL: base, WEB_BASE_URL: base,
      AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", AUTH_PROVIDER: "fake", CALENDAR_PROVIDER: "fake", ANALYTICS_PROVIDER: "fake",
      SECRET_STORE: "memory", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", WORKER_POLL_MS: "250", COMP_BLS_ENABLED: "false", MAGIC_LINK_ENABLED: "true",
      BOOTSTRAP_ADMIN_EMAILS: "admin-e2e@identifiedtalent.com",
    },
  },
});

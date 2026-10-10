import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Browser journeys and accessibility checks (slice 5 step 10) against the Next.js shell on an in-memory database with
 * every provider faked: sign-in, calendar, email, AI. Nothing leaves the machine.
 *
 * With E2E_BASE_URL set (docs/readiness/03 section 8) the same specs run against a deployed address, staging for
 * instance: no server is started here, nothing is assumed about the providers behind it, and every spec that needs
 * the fake sign-in page skips itself (tests/e2e/specs/helpers.ts, `skipWithoutFakeSignIn`). The public pages, the
 * browser-protection headers and the signed-out redirects are what a deployment proves.
 */
const repoRoot = (() => { let d = process.cwd(); for (let i = 0; i < 6; i++) { if (existsSync(join(d, "pnpm-workspace.yaml"))) return d; d = dirname(d); } return resolve(process.cwd(), "../.."); })();
const port = Number(process.env.E2E_PORT ?? 3010);
const remote = process.env.E2E_BASE_URL?.trim().replace(/\/+$/, "");
if (remote && !/^https?:\/\//.test(remote)) throw new Error(`E2E_BASE_URL must be a full address such as https://staging.example.com, not "${remote}"`);
const base = remote ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // One retry on CI only: the journeys run against `next dev`, which occasionally resets a connection while it compiles a
  // route (seen 22 Sep 2026 as ECONNRESET on a documentation-only commit). Locally a failure must fail.
  retries: process.env.CI ? 1 : 0,
  // On CI each failure is printed as it happens ("line"), so a run cut short by the job's time limit still shows why.
  reporter: [[process.env.CI ? "line" : "list"], ["html", { open: "never", outputFolder: process.env.E2E_REPORT_DIR ?? "report" }]],
  use: { baseURL: base, trace: "retain-on-failure", screenshot: "only-on-failure", video: "off" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /candidate-phone\.spec\.ts/ },
    // The candidate journey (apply with the acknowledgment, the screen, the schedule page) runs on the phone only: that is where candidates are (docs/spec/20 item 3).
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium" }, testMatch: /routes\.spec\.ts|candidate-phone\.spec\.ts/ },
  ],
  // A deployed address is already running; a local run starts the shell itself.
  webServer: remote ? undefined : {
    command: `pnpm --filter @ros/shell exec next dev -p ${port} --disable-source-maps`,
    cwd: repoRoot,
    url: `${base}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // The dev server restarts itself when the V8 heap passes 80% of its limit (next/dist/server/lib/start-server.js;
      // the default limit is half the machine's memory), which wipes the in-memory database mid-run. Give it a limit
      // well above what half the journeys need (CI runs them in two halves, each with its own server) but below the
      // runner's memory, so the runner itself is never starved, and skip development source maps, the largest part of
      // that heap.
      NODE_OPTIONS: "--max-old-space-size=6144",
      NODE_ENV: "development", PGLITE_DIR: "memory://", APP_BASE_URL: base,
      AI_PROVIDER: "fake", EMAIL_PROVIDER: "fake", SMS_PROVIDER: "fake", AUTH_PROVIDER: "fake", CALENDAR_PROVIDER: "fake", ANALYTICS_PROVIDER: "fake",
      SECRET_STORE: "memory", STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", WORKER_POLL_MS: "250", COMP_BLS_ENABLED: "false", MAGIC_LINK_ENABLED: "true",
      BOOTSTRAP_ADMIN_EMAILS: "admin-e2e@identifiedtalent.com",
      // New companies are confirmed at sign-up so the journeys have public pages; company-check.spec.ts takes a
      // confirmation back and gives it again through the admin console (founder decision B7).
      COMPANY_CHECK: "auto",
    },
  },
});

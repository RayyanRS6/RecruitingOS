import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Browser journeys and accessibility checks against the Next.js shell on an in-memory database with every provider a
 * stand-in: sign-in, email, AI. Nothing leaves the machine.
 *
 * With E2E_BASE_URL set (docs/readiness/03 section 8) the same specs run against a deployed address: no server is
 * started here, nothing is assumed about the providers behind it, and every spec that needs the fake sign-in page
 * skips itself (tests/e2e/specs/helpers.ts, `skipWithoutFakeSignIn`). The public pages, the browser-protection headers
 * and the signed-out redirects are what a deployment proves.
 */
const repoRoot = (() => { let d = process.cwd(); for (let i = 0; i < 6; i++) { if (existsSync(join(d, "pnpm-workspace.yaml"))) return d; d = dirname(d); } return resolve(process.cwd(), "../.."); })();
const port = Number(process.env.E2E_PORT ?? 3010);
const remote = process.env.E2E_BASE_URL?.trim().replace(/\/+$/, "");
if (remote && !/^https?:\/\//.test(remote)) throw new Error(`E2E_BASE_URL must be a full address such as https://staging.example.com, not "${remote}"`);
const base = remote ?? `http://localhost:${port}`;
/** The whole-flow specs (specs/flow-*.spec.ts): their own projects, so the shorter journeys' runs leave them to the flows job. */
const FLOWS = /flow-[a-z-]+\.spec\.ts/;

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
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: [/candidate-phone\.spec\.ts/, FLOWS] },
    // The candidate's journey (the job page, the form, the receipt, the status page, the AI interview) runs on the phone
    // only: that is where candidates are. The route inventory runs on both.
    { name: "phone", use: { ...devices["iPhone 13"], browserName: "chromium" }, testMatch: /routes\.spec\.ts|candidate-phone\.spec\.ts/ },
    // The whole flows: making a job, applying, and the hire from the ranked list to the decision. They are long, so on
    // CI they run in a job of their own, in parts with a server each (.github/workflows/ci.yml, "flows"), which `verify`
    // waits for. A press that finds nothing to press fails within a minute, not at the end of a ten-minute journey.
    { name: "flows", use: { ...devices["Desktop Chrome"], actionTimeout: 60_000 }, testMatch: FLOWS },
    // The candidate's whole application again on a phone, where candidates are.
    { name: "flows-phone", use: { ...devices["iPhone 13"], browserName: "chromium", actionTimeout: 60_000 }, testMatch: /flow-candidate-apply-whole\.spec\.ts/ },
  ],
  // A deployed address is already running; a local run starts the shell itself.
  webServer: remote ? undefined : {
    // Turbopack compiles outside the JavaScript heap: with webpack, the route inventory alone (every page in one test)
    // pushed the dev server past its memory threshold on CI's 7 GB runner, and the restart wiped the in-memory database
    // mid-test. With Turbopack the whole suite ran in 18 minutes on a 3 GB heap, without a restart (11 October 2026).
    command: `pnpm --filter @ros/shell exec next dev -p ${port} --turbopack --disable-source-maps`,
    cwd: repoRoot,
    url: `${base}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // The dev server restarts itself when the V8 heap passes 80% of its limit (next/dist/server/lib/start-server.js;
      // the default limit is half the machine's memory), which wipes the in-memory database mid-run. Give it a limit
      // well above what one CI run needs (CI splits the journeys into three runs, each with its own server) but below the
      // runner's memory, so the runner itself is never starved.
      NODE_OPTIONS: "--max-old-space-size=6144",
      NODE_ENV: "development", PGLITE_DIR: "memory://", APP_BASE_URL: base,
      // E2E_EMAIL_PROVIDER=postmark (with no token) is email that never arrives: every send fails at once, and
      // specs/flow-email-down.spec.ts walks what the team sees then. Every other run uses the fake adapter.
      AI_PROVIDER: "fake", EMAIL_PROVIDER: process.env.E2E_EMAIL_PROVIDER || "fake", AUTH_PROVIDER: "fake", ANALYTICS_PROVIDER: "fake",
      STORAGE_PROVIDER: "memory", WORKER_INLINE: "true", WORKER_POLL_MS: "250", MAGIC_LINK_ENABLED: "true",
      BOOTSTRAP_ADMIN_EMAILS: "admin-e2e@identifiedtalent.com",
      // Sign-up is open for the journeys, so a new company is live at once. access-approval.spec.ts runs on a server of
      // its own, with SIGNUP_MODE=approval in the environment (the last end-to-end step of .github/workflows/ci.yml), and
      // is skipped in any other run; a spec that opens its company straight from the form is skipped on that server.
      ...(process.env.SIGNUP_MODE ? { SIGNUP_MODE: process.env.SIGNUP_MODE } : {}),
      // Every person in these journeys asks for access from this one machine, a retry and a reused server included: the
      // request door's five an hour per address is for the public, and apps/api/src/access-approval.test.ts proves it.
      RATE_LIMIT_OVERRIDES: JSON.stringify({ "access.request": 1000 }),
    },
  },
});

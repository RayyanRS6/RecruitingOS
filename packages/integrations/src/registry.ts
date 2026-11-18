import { FakeEmailAdapter } from "./email/fake";
import { PostmarkEmailAdapter } from "./email/postmark";
import { LocalStorageAdapter, MemoryStorageAdapter } from "./storage/local";
import { GrantSigner } from "./storage/grants";
import { SupabaseStorageAdapter } from "./storage/supabase";
import { FakeMalwareScanner } from "./scanning/fake";
import { CLAMAV_DEFAULT_PORT, CLAMAV_DEFAULT_TIMEOUT_MS, ClamAvScanner } from "./scanning/clamav";
import type { MalwareScanner } from "./scanning/types";
import { FakeAnalyticsAdapter, PostHogServerAdapter } from "./analytics/adapters";
import { FakeIdentityProvider } from "./identity/fake";
import { SupabaseIdentityProvider } from "./identity/supabase";
import type { IdentityProvider } from "./identity/types";
import type { AnalyticsAdapter } from "./analytics/types";
import type { EmailAdapter, StorageAdapter, AdapterStatus } from "./types";

export type Integrations = {
  email: EmailAdapter;
  storage: StorageAdapter;
  /** Malware scanning of quarantined uploads; a fake until a real engine is authorized (real-data blocker). */
  scanner: MalwareScanner;
  /** Managed sign-in (D19): Supabase Auth in production, an in-process fake issuer elsewhere. */
  identity: IdentityProvider;
  analytics: AnalyticsAdapter;
  /** Salt for the keyed analytics identifiers; never the same across environments. */
  analyticsSalt: string;
  env: { fromDomain: string; fromAddress: string; replyTo: string; appBaseUrl: string; productName: string };
  /** The clock the outbox stamps its jobs with. The app points it at the workflow engine's clock, so a message queued now is due now on the clock that runs the queue (tests move that clock). */
  clock: () => Date;
  statuses(): Array<{ kind: string; provider: string; status: AdapterStatus }>;
};

/** Every adapter reports its real state (founder decision F4): nothing is labeled live without a verified connection. */
export function createIntegrations(env: Record<string, string | undefined> = process.env, opts: { memoryStorage?: boolean } = {}): Integrations {
  const appBaseUrl = env.APP_BASE_URL ?? "http://localhost:3000";
  const fromDomain = env.EMAIL_FROM_DOMAIN ?? "mail.localhost";
  const email: EmailAdapter = env.EMAIL_PROVIDER === "postmark" ? new PostmarkEmailAdapter(env.POSTMARK_SERVER_TOKEN) : new FakeEmailAdapter();
  const storage = createStorage(env, opts, appBaseUrl);
  const scanner: MalwareScanner = createScanner(env);
  const identity: IdentityProvider = env.AUTH_PROVIDER === "supabase"
    ? new SupabaseIdentityProvider({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, jwtSecret: env.SUPABASE_JWT_SECRET, providers: (env.AUTH_SIGNIN_PROVIDERS ?? "azure,google").split(",").map((s) => s.trim()).filter(Boolean) })
    : new FakeIdentityProvider({ apiBaseUrl: appBaseUrl });
  const analytics: AnalyticsAdapter = env.ANALYTICS_PROVIDER === "posthog" ? new PostHogServerAdapter(env.POSTHOG_PROJECT_API_KEY, env.POSTHOG_HOST) : new FakeAnalyticsAdapter();
  return {
    email,
    storage,
    scanner,
    identity,
    analytics,
    analyticsSalt: env.ANALYTICS_SALT ?? "dev-only-analytics-salt",
    env: { fromDomain, fromAddress: env.EMAIL_FROM_ADDRESS ?? `updates@${fromDomain}`, replyTo: env.EMAIL_REPLY_TO ?? env.ITS_QUEUE_EMAIL ?? `updates@${fromDomain}`, appBaseUrl, productName: env.PRODUCT_NAME ?? "Recruiting OS" },
    clock: () => new Date(),
    statuses: () => [
      { kind: "email", provider: email.id, status: email.status },
      { kind: "storage", provider: storage.id, status: storage.status },
      { kind: "scanner", provider: scanner.id, status: scanner.status },
      { kind: "identity", provider: identity.id, status: identity.status },
      { kind: "analytics", provider: analytics.id, status: analytics.status },
    ],
  };
}

/**
 * Storage by STORAGE_PROVIDER: `memory` (tests), `local` (development, files under STORAGE_DIR), `supabase` (staging and
 * production, decision 2). Anything else is refused rather than silently falling back to the disk. Configuration
 * errors name the variable, never a value.
 */
function createStorage(env: Record<string, string | undefined>, opts: { memoryStorage?: boolean }, appBaseUrl: string): StorageAdapter {
  const provider = opts.memoryStorage ? "memory" : (env.STORAGE_PROVIDER ?? "local");
  const signer = new GrantSigner(env.SESSION_SECRET ?? "dev-only-session-secret", appBaseUrl);
  if (provider === "memory") return new MemoryStorageAdapter(signer);
  if (provider === "local") return new LocalStorageAdapter(env.STORAGE_DIR ?? "./.data/files", signer);
  if (provider === "supabase") {
    const missing = ["STORAGE_S3_ENDPOINT", "STORAGE_S3_REGION", "STORAGE_BUCKET", "STORAGE_S3_ACCESS_KEY_ID", "STORAGE_S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
    if (missing.length) throw new Error(`STORAGE_PROVIDER=supabase needs ${missing.join(", ")}`);
    return new SupabaseStorageAdapter({ endpoint: env.STORAGE_S3_ENDPOINT!, region: env.STORAGE_S3_REGION!, bucket: env.STORAGE_BUCKET!, accessKeyId: env.STORAGE_S3_ACCESS_KEY_ID!, secretAccessKey: env.STORAGE_S3_SECRET_ACCESS_KEY! });
  }
  throw new Error(`STORAGE_PROVIDER=${provider} is not a known storage provider (memory, local, supabase)`);
}

/**
 * Malware scanning by SCAN_PROVIDER: `fake` (development, tests, and staging until the engine exists) or `clamav`
 * (a clamd service reached over private networking; docs/runbooks/resume-storage.md). The fake is never reported as
 * anything but `fake`, and production raises an alert while it is the one in use (the real-data gate).
 */
function createScanner(env: Record<string, string | undefined>): MalwareScanner {
  const provider = env.SCAN_PROVIDER ?? "fake";
  if (provider === "fake") return new FakeMalwareScanner();
  if (provider === "clamav") {
    if (!env.CLAMAV_HOST) throw new Error("SCAN_PROVIDER=clamav needs CLAMAV_HOST (the clamd service's private hostname)");
    const port = Number(env.CLAMAV_PORT ?? String(CLAMAV_DEFAULT_PORT));
    const timeoutMs = Number(env.CLAMAV_TIMEOUT_MS ?? String(CLAMAV_DEFAULT_TIMEOUT_MS));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("CLAMAV_PORT must be a port number (the official image listens on 3310)");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("CLAMAV_TIMEOUT_MS must be a positive number of milliseconds");
    return new ClamAvScanner({ host: env.CLAMAV_HOST, port, timeoutMs });
  }
  throw new Error(`SCAN_PROVIDER=${provider} is not a known scanner (fake, clamav)`);
}
